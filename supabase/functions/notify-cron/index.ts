// notify-cron: always-on Magic CRM notifications in the cloud.
//
// This Supabase Edge Function fires task alarms even when Michael's Mac is OFF. A pg_cron job (see
// supabase/notify-cron-setup.sql) POSTs here every minute with a shared secret. On each run it:
//   1. TASK ALARMS: finds active-bucket, not-done, not-yet-notified tasks whose alarm instant
//      (America/New_York) has passed, inserts a `task-due` notification, web-pushes the phone, and
//      stamps notified_at so it never re-fires.
//
// It used to have a second job that polled a public Vercel Blob file for website inquiries and
// raised new-inquiry alerts. Removed 2026-08-03: the `inquiry` edge function now creates the
// project, emails Michael and fires its own push itself, server-side, the instant the form is
// submitted. Task alarms are the only thing this function does now.
//
// Delivery to the phone (APNs for the native app, Web Push for the PWA, pruning dead devices) and the
// app-icon count live in _shared/push.ts, shared with every other function that pushes. Config
// (VAPID keys, app URL, cron secret) lives in the service-role-only `push_config` table; the APNs key
// is a function secret (see _shared/apns.ts).
//
// Deno / TypeScript. Deployed via the Supabase connector; do NOT expect Node APIs here.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { makePusher, badgeCount } from "../_shared/push.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface PushConfig {
  vapid_public: string;
  vapid_private: string;
  vapid_subject: string;
  app_url: string;
  cron_secret: string;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// A task's display name for the push: prefer the editable project_name, fall back to client_name.
function projectDisplayName(p: { project_name?: string | null; client_name?: string | null }): string {
  const pn = (p?.project_name ?? "").toString().trim();
  const cn = (p?.client_name ?? "").toString().trim();
  return pn || cn || "a client";
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
    .select("vapid_public,vapid_private,vapid_subject,app_url,cron_secret")
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

  // One pusher for the run. It reads push_subscriptions on the first alert, so a minute with nothing
  // due never touches it, and a VAPID problem costs only the Web Push half, never the iPhone.
  const pusher = makePusher(sb, cfg);

  let tasksFired = 0;
  let pushed = 0;
  let pruned = 0;

  // -------------------------------------------------------------------------
  // 3. TASK ALARMS
  // -------------------------------------------------------------------------
  try {
    const nowMs = Date.now();
    // Candidate tasks: not done, not yet notified. We filter to the ACTIVE bucket in code below
    // rather than via a PostgREST embed, because tasks.project_id has no declared FK to projects.id
    // (verified against the live schema), so `projects!inner(...)` embedding is not available here.
    const { data: taskRows, error: taskErr } = await sb
      .from("tasks")
      .select("id,project_id,title,due_date,due_time,done,notified_at")
      .eq("done", false)
      .is("notified_at", null);

    // Active-bucket projects, keyed by id (the slug). Gives us the bucket filter + display name.
    const { data: projRows, error: projErr } = await sb
      .from("projects")
      .select("id,client_name,project_name")
      .eq("bucket", "active");
    const activeProjects = new Map<string, { id: string; client_name?: string; project_name?: string }>();
    for (const p of (projRows ?? []) as Array<{ id: string; client_name?: string; project_name?: string }>) {
      activeProjects.set(String(p.id), p);
    }

    if (taskErr || projErr) {
      console.error("[notify-cron] task/project query error:", taskErr?.message ?? projErr?.message);
    } else {
      for (const t of (taskRows ?? []) as Array<Record<string, unknown>>) {
        const pid = String(t.project_id ?? "").trim();
        const proj = pid ? activeProjects.get(pid) : undefined;
        // Fire for STANDALONE tasks (no project) AND active-project tasks. Skip only tasks whose
        // project is non-active (completed/archived) or an unknown id, so resolved gigs don't nag.
        if (pid && !proj) continue;

        const alarmMs = taskAlarmUtcMs(String(t.due_date ?? ""), String(t.due_time ?? ""));
        if (alarmMs === null) continue; // malformed / no date -> not an alarm
        if (alarmMs > nowMs) continue; // not due yet

        const taskId = String(t.id);
        const title = String(t.title ?? "").trim() || "Task";
        const who = proj ? projectDisplayName(proj) : "";

        // NO notification row is written for a due task any more.
        //
        // A task-due row put the same task in two places at once: the Tasks badge counted it, and
        // the bell counted it again, so one overdue task read as two. Worse, the row outlived the
        // task. Completing or deleting the task never cleared it, which is why Michael was looking
        // at three undismissable "Jessica - task due" alerts for a task he had finished days
        // earlier. The task list is the task's only home now.
        //
        // The lock-screen push below still fires: being told a task is due is the point. It just
        // does not leave a permanent artefact behind in the bell.

        // Push (best-effort). Body matches crm-push.mjs task-due: "<task title> — <who>", but using a
        // hyphen (no em-dash, per Michael's rule) as "<title> - <who>".
        const r = await pusher.send({
          title: "Task due",
          body: who ? `${title} - ${who}` : title,
          tag: "task-due",
          count: await badgeCount(sb),
        });
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

  // (The NEW-INQUIRY section was removed 2026-08-03. The website used to POST to a Vercel relay
  // that appended to a public Blob file, which this polled. The site now posts straight to the
  // `inquiry` edge function, which creates the project, emails Michael and fires its own push
  // server-side. This block had been reading a blob that no longer received anything, and its
  // Vercel project has since been deleted.)

  // Summary.
  return json({ tasksFired, pushed, pruned });
});
