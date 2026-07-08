// notify-cron: always-on Magic CRM notifications in the cloud.
//
// This Supabase Edge Function fires task alarms and new-inquiry alerts even when Michael's Mac is
// OFF. A pg_cron job (see supabase/notify-cron-setup.sql) POSTs here every minute with a shared
// secret. On each run it:
//   1. TASK ALARMS: finds active-bucket, not-done, not-yet-notified tasks whose alarm instant
//      (America/New_York) has passed, inserts a `task-due` notification, web-pushes the phone, and
//      stamps notified_at so it never re-fires.
//   2. NEW-INQUIRY: reads the public inquiry blob and, for any inquiry with no `new-inquiry`
//      notification yet, sends a distinct high-urgency push and records the notification. The Mac's
//      importer dedups on the same (kind, source_id), so this never double-alerts, and the Mac still
//      creates the real project when it next runs.
//
// It mirrors crm-webpush.mjs (Node `web-push`) using @negrel/webpush (Deno-native, RFC 8291
// aes128gcm), reads every row of push_subscriptions with the service key, and prunes dead endpoints
// on a 404/410. All config (VAPID keys, blob URL, app URL, cron secret) lives in the service-role-only
// `push_config` table so no edge-function secrets are needed.
//
// Deno / TypeScript. Deployed via the Supabase connector; do NOT expect Node APIs here.

import { createClient } from "jsr:@supabase/supabase-js@2";
import * as webpush from "jsr:@negrel/webpush@0.5.0";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface PushConfig {
  vapid_public: string;
  vapid_private: string;
  vapid_subject: string;
  inquiry_blob_url: string;
  app_url: string;
  cron_secret: string;
}

interface WebPushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag?: string;
  count?: number;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// slug(client_name): lowercase, runs of non-alphanumerics -> single hyphen, trimmed. Matches
// crm-data-core.mjs slugify() so a new-inquiry notification's project_id lines up with the project
// the Mac will create. NFKD-normalize first (same as the app) so accented names collapse identically.
function slugify(name: unknown): string {
  return (
    String(name ?? "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project"
  );
}

// notifications.id is a text column with no default, so we mint an id in the same shape the Mac uses
// (crm-notifications.mjs newId): 'n' + base36 time + 4 random base36 chars.
function newNotificationId(): string {
  return "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// A task's display name for the push: prefer the editable project_name, fall back to client_name.
function projectDisplayName(p: { project_name?: string | null; client_name?: string | null }): string {
  const pn = (p?.project_name ?? "").toString().trim();
  const cn = (p?.client_name ?? "").toString().trim();
  return pn || cn || "a client";
}

// base64url of a Uint8Array (JWK field encoding, no padding).
function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// base64url string -> Uint8Array (accepts standard or url-safe alphabet, with/without padding).
function fromB64url(s: string): Uint8Array {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = norm + "=".repeat((4 - (norm.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Convert the raw base64url VAPID keys (the standard web-push format, also what push-vapid.json holds)
// into the JWK pair @negrel/webpush's importVapidKeys() expects.
//   publicKey base64url  = uncompressed EC point  0x04 || X(32) || Y(32)
//   privateKey base64url = the 32-byte private scalar d
// So the JWK is { kty:'EC', crv:'P-256', x, y (, d) }, all base64url. This is the well-known
// raw<->JWK P-256 conversion; the same x/y must appear in both the public and private JWK.
function vapidKeysToJwk(
  publicKeyB64url: string,
  privateKeyB64url: string,
): { publicKey: JsonWebKey; privateKey: JsonWebKey } {
  const pub = fromB64url(publicKeyB64url);
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error(`unexpected VAPID public key length ${pub.length} (want 65-byte uncompressed point)`);
  }
  const x = b64url(pub.slice(1, 33));
  const y = b64url(pub.slice(33, 65));
  const d = b64url(fromB64url(privateKeyB64url));
  const publicKey: JsonWebKey = { kty: "EC", crv: "P-256", x, y, ext: true };
  const privateKey: JsonWebKey = { kty: "EC", crv: "P-256", x, y, d, ext: true };
  return { publicKey, privateKey };
}

// ---------------------------------------------------------------------------
// America/New_York time handling (DST-correct, no external tz library)
//
// due_date/due_time are wall-clock values in Michael's local zone. We need the UTC instant they
// represent. Intl with timeZone:'America/New_York' knows the real DST rules for any date, so we ask
// it what UTC offset New_York has at (roughly) the target instant, then apply that offset. One
// refinement pass handles the case where the guessed instant lands on the other side of a DST switch.
// ---------------------------------------------------------------------------

// Offset (minutes) that America/New_York is BEHIND UTC at the given UTC instant. EDT = 240, EST = 300.
function nyOffsetMinutes(atUtcMs: number): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(new Date(atUtcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  let hour = get("hour");
  if (hour === 24) hour = 0; // Intl can emit 24 for midnight
  // The instant, as Y/M/D H:M:S, would be in UTC:
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  // NY local wall time minus real UTC = -offset; offset-behind = (UTC - localAsUtc).
  return Math.round((atUtcMs - asUtc) / 60000);
}

// Convert a New_York wall-clock (Y,M,D,h,m) to the UTC epoch ms it denotes, DST-correct.
function nyWallClockToUtcMs(y: number, mo: number, d: number, h: number, mi: number): number {
  // First guess: treat the wall clock as if it were UTC, then subtract the NY offset at that guess.
  const naive = Date.UTC(y, mo - 1, d, h, mi, 0);
  const off1 = nyOffsetMinutes(naive);
  const guess = naive + off1 * 60000;
  // Refine once using the offset at the guessed instant (fixes near-DST-transition guesses).
  const off2 = nyOffsetMinutes(guess);
  return naive + off2 * 60000;
}

// Given a task's due_date ("YYYY-MM-DD") and due_time ("HH:MM" or empty), the UTC ms of its alarm.
// Empty time -> 06:00 local (a morning reminder for all-day tasks). Returns null on a malformed date.
function taskAlarmUtcMs(dueDate: string, dueTime: string): number | null {
  const md = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dueDate || "").trim());
  if (!md) return null;
  const [y, mo, d] = [Number(md[1]), Number(md[2]), Number(md[3])];
  let h = 6, mi = 0;
  const mt = /^(\d{1,2}):(\d{2})$/.exec(String(dueTime || "").trim());
  if (mt) {
    h = Number(mt[1]);
    mi = Number(mt[2]);
    if (h > 23 || mi > 59) { h = 6; mi = 0; }
  }
  return nyWallClockToUtcMs(y, mo, d, h, mi);
}

// ---------------------------------------------------------------------------
// Web push (aes128gcm, VAPID) via @negrel/webpush
// ---------------------------------------------------------------------------

// Send one payload to every push_subscriptions row; prune endpoints the push service says are gone
// (404/410). Never throws on a single bad send. Returns how many were pushed / pruned.
async function pushAll(
  appServer: webpush.ApplicationServer,
  subs: WebPushSub[],
  payload: PushPayload,
  prune: (endpoints: string[]) => Promise<void>,
): Promise<{ pushed: number; pruned: number }> {
  if (!subs.length) return { pushed: 0, pruned: 0 };
  const body = JSON.stringify(payload);
  const dead: string[] = [];
  let pushed = 0;
  await Promise.all(
    subs.map(async (s) => {
      try {
        // High urgency so alerts break through on the lock screen (matches the phone's intent).
        await appServer.subscribe(s).pushTextMessage(body, { urgency: webpush.Urgency.High });
        pushed++;
      } catch (e) {
        const status = (e as { response?: Response })?.response?.status;
        if (status === 404 || status === 410) dead.push(s.endpoint);
        // Any other failure (timeout, 5xx, etc.) is swallowed: one bad send never fails the run.
      }
    }),
  );
  if (dead.length) {
    try { await prune(dead); } catch { /* best-effort prune */ }
  }
  return { pushed, pruned: dead.length };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
Deno.serve(async (req: Request): Promise<Response> => {
  const json = (obj: unknown, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

  // Service-role client (bypasses RLS): reads config, tasks, projects, subscriptions; writes
  // notifications + tasks.notified_at. Uses the env vars Supabase injects into every edge function.
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceKey) {
    return json({ error: "missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY" }, 500);
  }
  const sb = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 2. Load config from the service-role-only push_config table (single row id=1).
  const { data: cfgRow, error: cfgErr } = await sb
    .from("push_config")
    .select("vapid_public,vapid_private,vapid_subject,inquiry_blob_url,app_url,cron_secret")
    .eq("id", 1)
    .single();
  if (cfgErr || !cfgRow) {
    return json({ error: "could not load push_config", detail: cfgErr?.message ?? "no row" }, 500);
  }
  const cfg = cfgRow as PushConfig;

  // 1. Authorize: accept EITHER the shared cron secret header OR the service-role bearer. Header name
  //    is case-insensitive; the cron job sends `x-cron-secret`. Reject everything else.
  const givenSecret = req.headers.get("x-cron-secret") ?? "";
  const authz = req.headers.get("authorization") ?? "";
  const bearer = authz.toLowerCase().startsWith("bearer ") ? authz.slice(7).trim() : "";
  const secretOk = !!cfg.cron_secret && givenSecret === cfg.cron_secret;
  const bearerOk = !!serviceKey && bearer === serviceKey;
  if (!secretOk && !bearerOk) {
    return json({ error: "unauthorized" }, 401);
  }

  // Build the VAPID application server once for this run.
  let appServer: webpush.ApplicationServer;
  try {
    const jwk = vapidKeysToJwk(cfg.vapid_public, cfg.vapid_private);
    const vapidKeys = await webpush.importVapidKeys(jwk, { extractable: false });
    appServer = await webpush.ApplicationServer.new({
      contactInformation: cfg.vapid_subject || "mailto:mchlbloemeke@gmail.com",
      vapidKeys,
    });
  } catch (e) {
    return json({ error: "vapid setup failed", detail: String((e as Error)?.message ?? e) }, 500);
  }

  // Read every subscription row (service key bypasses RLS), same as crm-webpush.mjs readSubs().
  async function readSubs(): Promise<WebPushSub[]> {
    const { data, error } = await sb.from("push_subscriptions").select("endpoint,subscription");
    if (error || !Array.isArray(data)) return [];
    return data
      .map((r: { subscription?: unknown }) => (r && r.subscription ? (r.subscription as WebPushSub) : null))
      .filter((s): s is WebPushSub => !!s && !!s.endpoint && !!s.keys?.p256dh && !!s.keys?.auth);
  }
  async function pruneSubs(endpoints: string[]): Promise<void> {
    if (!endpoints.length) return;
    await sb.from("push_subscriptions").delete().in("endpoint", endpoints);
  }

  const subs = await readSubs();

  // Current unseen count is part of the phone's app-icon badge; compute once and reuse. (task-due +
  // new-inquiry live in the same notifications table the bell reads.)
  async function unseenCount(): Promise<number> {
    const { count } = await sb
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("seen", false);
    return count ?? 0;
  }

  let tasksFired = 0;
  let inquiriesFired = 0;
  let pushed = 0;
  let pruned = 0;

  // -------------------------------------------------------------------------
  // 3. TASK ALARMS
  // -------------------------------------------------------------------------
  try {
    const nowMs = Date.now();
    // Active-bucket, not-done, not-yet-notified tasks joined to their project (for the display name
    // and the bucket filter). PostgREST embeds the project via the FK on tasks.project_id.
    const { data: taskRows, error: taskErr } = await sb
      .from("tasks")
      .select("id,project_id,title,due_date,due_time,done,notified_at,projects!inner(id,client_name,project_name,bucket)")
      .eq("done", false)
      .is("notified_at", null)
      .eq("projects.bucket", "active");

    if (taskErr) {
      console.error("[notify-cron] task query error:", taskErr.message);
    } else {
      for (const t of (taskRows ?? []) as Array<Record<string, unknown>>) {
        const proj = (Array.isArray(t.projects) ? t.projects[0] : t.projects) as
          | { id?: string; client_name?: string; project_name?: string }
          | undefined;
        if (!proj) continue;

        const alarmMs = taskAlarmUtcMs(String(t.due_date ?? ""), String(t.due_time ?? ""));
        if (alarmMs === null) continue; // malformed / no date -> not an alarm
        if (alarmMs > nowMs) continue; // not due yet

        const taskId = String(t.id);
        const title = String(t.title ?? "").trim() || "Task";
        const who = projectDisplayName(proj);

        // Insert the task-due notification unless one already exists for (kind, source_id=task.id).
        const { data: existing } = await sb
          .from("notifications")
          .select("id")
          .eq("kind", "task-due")
          .eq("source_id", taskId)
          .limit(1);
        if (!existing || existing.length === 0) {
          await sb.from("notifications").insert({
            id: newNotificationId(),
            project_id: String(t.project_id ?? proj.id ?? ""),
            kind: "task-due",
            source_id: taskId,
            seen: false,
            created_at: new Date().toISOString(),
          });
        }

        // Push (best-effort). Body matches crm-push.mjs task-due: "<task title> — <who>", but using a
        // hyphen (no em-dash, per Michael's rule) as "<title> - <who>".
        const count = (await unseenCount());
        const r = await pushAll(
          appServer,
          subs,
          {
            title: "Task due",
            body: `${title} - ${who}`,
            url: cfg.app_url,
            tag: "task-due",
            count,
          },
          pruneSubs,
        );
        pushed += r.pushed;
        pruned += r.pruned;

        // Stamp notified_at so it never re-fires (even if the push failed: the bell notification is
        // recorded, and re-pushing forever would be worse than a single missed lock-screen alert).
        await sb.from("tasks").update({ notified_at: new Date().toISOString() }).eq("id", taskId);
        tasksFired++;
      }
    }
  } catch (e) {
    console.error("[notify-cron] task alarms failed:", String((e as Error)?.message ?? e));
  }

  // -------------------------------------------------------------------------
  // 4. NEW-INQUIRY
  // -------------------------------------------------------------------------
  try {
    let list: Array<Record<string, unknown>> = [];
    if (cfg.inquiry_blob_url) {
      const res = await fetch(cfg.inquiry_blob_url, { cache: "no-store" });
      if (res.ok) {
        const d = await res.json();
        list = Array.isArray(d) ? d : Array.isArray(d?.inquiries) ? d.inquiries : [];
      }
    }
    for (const inq of list) {
      const id = inq && inq.id != null ? String(inq.id) : "";
      if (!id) continue;
      const name = String(inq.name ?? "").trim();
      const email = String(inq.email ?? "").trim();
      const lead = name || email;

      // Skip if a new-inquiry notification already exists for this inquiry id (source_id). This is
      // what makes it fire once per inquiry, and it dedups against the Mac's importer too.
      const { data: existing } = await sb
        .from("notifications")
        .select("id")
        .eq("kind", "new-inquiry")
        .eq("source_id", id)
        .limit(1);
      if (existing && existing.length > 0) continue;

      // Distinct, high-urgency alert (mirrors crm-push.mjs new-inquiry copy).
      const count = (await unseenCount()) + 1; // include the one we're about to add
      const r = await pushAll(
        appServer,
        subs,
        {
          title: "New inquiry!",
          body: lead ? `New website inquiry from ${lead}.` : "A new inquiry just came in through the website.",
          url: cfg.app_url,
          tag: "new-inquiry",
          count,
        },
        pruneSubs,
      );
      pushed += r.pushed;
      pruned += r.pruned;

      // Record the notification: project_id = slug(lead name) so it lines up with the project the Mac
      // will create; source_id = inquiry id.
      await sb.from("notifications").insert({
        id: newNotificationId(),
        project_id: slugify(lead),
        kind: "new-inquiry",
        source_id: id,
        seen: false,
        created_at: new Date().toISOString(),
      });
      inquiriesFired++;
    }
  } catch (e) {
    console.error("[notify-cron] new-inquiry failed:", String((e as Error)?.message ?? e));
  }

  // 6. Summary.
  return json({ tasksFired, inquiriesFired, pushed, pruned });
});
