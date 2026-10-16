// Phone pushes for every CRM edge function: notify-cron, inquiry, proposal, gig-leads and
// calendar-alerts all send through makePusher() below (2026-10-16).
//
// WHY ONE FILE. Each of those functions used to carry its own copy of this code, and the copies had
// drifted: the proposal copy read push_subscriptions columns that do not exist and never reached the
// iPhone, and inquiry and gig-leads put a different number on the app icon from everything else. A
// fix to push delivery now happens here, once.
//
// ⚠️ TWO ROUTES, ONE CALL. Every send reaches every device Michael owns, whether it registered through
// the PWA (Web Push) or the native iOS app (APNs, see apns.ts). Both live in the same
// push_subscriptions table, so a notification type added later cannot support only one of them.
// APNs never waits on Web Push: missing or broken VAPID keys cost the Web Push half only.

import * as webpush from "jsr:@negrel/webpush@0.5.0";
import { sendApns, apnsConfigured, splitSubscriptions } from "./apns.ts";

// The push_config columns this needs. Callers pass the row they already read.
export type PushCfg = {
  vapid_public?: string | null;
  vapid_private?: string | null;
  vapid_subject?: string | null;
  app_url?: string | null;
};

export interface PushMessage {
  title: string;
  body: string;
  tag?: string;
  // The number on the app icon (see badgeCount). Leave it out for an alert that must not move the
  // icon: a calendar alert is neither a task nor a bell item.
  count?: number;
  // Where a tap opens. Defaults to push_config.app_url.
  url?: string;
}

export type PushResult = { pushed: number; pruned: number };
export type Pusher = { send: (m: PushMessage) => Promise<PushResult> };

interface WebPushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
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
// So the JWK is { kty:'EC', crv:'P-256', x, y (, d) }, all base64url, with the same x/y in both.
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

// One pusher per run. The subscriptions are read once, on the first send, so a run with nothing to
// say (most notify-cron and calendar-alerts runs) never touches push_subscriptions. `sb` must be a
// service-role client: RLS hides push_subscriptions from everyone else.
// deno-lint-ignore no-explicit-any
export function makePusher(sb: any, cfg: PushCfg | null | undefined): Pusher {
  type Devices = { web: WebPushSub[]; apnsTokens: string[]; appServer: webpush.ApplicationServer | null };
  let loaded: Promise<Devices> | null = null;

  // Every push_subscriptions row, split into the two routes. Web Push rows need their keys, which
  // live inside `subscription`; APNs rows are apns://<token> endpoints.
  function load(): Promise<Devices> {
    if (!loaded) {
      loaded = (async () => {
        const { data, error } = await sb.from("push_subscriptions").select("endpoint,subscription");
        if (error) console.warn("[push] could not read push_subscriptions:", error.message);
        const rows = (data ?? []) as Array<{ endpoint: string; subscription?: unknown }>;
        const { apnsTokens, web } = splitSubscriptions(rows);
        const subs = web
          .map((r) => (r.subscription ? (r.subscription as WebPushSub) : null))
          .filter((s): s is WebPushSub => !!s && !!s.endpoint && !!s.keys?.p256dh && !!s.keys?.auth);
        let appServer: webpush.ApplicationServer | null = null;
        if (subs.length && cfg?.vapid_public && cfg?.vapid_private) {
          try {
            const vapidKeys = await webpush.importVapidKeys(vapidKeysToJwk(cfg.vapid_public, cfg.vapid_private), { extractable: false });
            appServer = await webpush.ApplicationServer.new({
              contactInformation: cfg.vapid_subject || "mailto:mchlbloemeke@gmail.com",
              vapidKeys,
            });
          } catch (e) {
            console.warn("[push] vapid setup failed:", e instanceof Error ? e.message : String(e));
          }
        }
        return { web: subs, apnsTokens, appServer };
      })();
    }
    return loaded;
  }

  // Delete devices that will never work again, and drop them from this run's list so a later send
  // in the same run does not try them twice.
  async function prune(d: Devices, endpoints: string[]): Promise<void> {
    if (!endpoints.length) return;
    const gone = new Set(endpoints);
    d.web = d.web.filter((s) => !gone.has(s.endpoint));
    d.apnsTokens = d.apnsTokens.filter((t) => !gone.has(`apns://${t}`));
    try {
      await sb.from("push_subscriptions").delete().in("endpoint", endpoints);
    } catch { /* best-effort prune */ }
  }

  // One message to every device. Never throws: one bad device must never fail a run.
  async function send(m: PushMessage): Promise<PushResult> {
    let d: Devices;
    try {
      d = await load();
    } catch (e) {
      console.warn("[push] could not load devices:", e instanceof Error ? e.message : String(e));
      return { pushed: 0, pruned: 0 };
    }
    const url = m.url ?? cfg?.app_url ?? "";
    let pushed = 0;
    let pruned = 0;

    if (d.apnsTokens.length && apnsConfigured()) {
      const r = await sendApns(d.apnsTokens, { title: m.title, body: m.body, badge: m.count, url });
      pushed += r.pushed;
      pruned += r.dead.length;
      await prune(d, r.dead);
    }

    if (d.appServer && d.web.length) {
      const appServer = d.appServer;
      const payload = JSON.stringify({ title: m.title, body: m.body, url, tag: m.tag, count: m.count });
      const dead: string[] = [];
      await Promise.all(
        d.web.map(async (s) => {
          try {
            // High urgency so alerts break through on the lock screen (matches the phone's intent).
            await appServer.subscribe(s).pushTextMessage(payload, { urgency: webpush.Urgency.High });
            pushed++;
          } catch (e) {
            // 404/410 means the subscription is gone for good. Anything else (timeout, 5xx) is
            // swallowed and tried again on the next alert.
            const status = (e as { response?: Response })?.response?.status;
            if (status === 404 || status === 410) dead.push(s.endpoint);
          }
        }),
      );
      pruned += dead.length;
      await prune(d, dead);
    }

    return { pushed, pruned };
  }

  return { send };
}

// The number on the app icon = TASKS DUE + BELL NOTIFICATIONS, exactly what the phone app shows
// (updateCounts in mobile/app.js) and what crm-notification-counters defines. The bell excludes
// task-due: a due task is counted once, on the Tasks badge. Unread mail is part of the bell on the
// phone but lives only in Gmail, so it cannot be counted here.
// deno-lint-ignore no-explicit-any
export async function badgeCount(sb: any): Promise<number> {
  const { count: notifs } = await sb
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("seen", false)
    .neq("kind", "task-due");

  // Tasks due today or earlier, still open. Date-only compare, in Michael's timezone.
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const { count: dueTasks } = await sb
    .from("tasks")
    .select("id", { count: "exact", head: true })
    .eq("done", false)
    .neq("due_date", "")
    .lte("due_date", today);

  return (notifs ?? 0) + (dueTasks ?? 0);
}
