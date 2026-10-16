// Phone delivery for calendar-alerts: Web Push (the PWA) and APNs (the native iOS app), the same two
// routes every CRM alert uses.
//
// ⚠️ A LOCAL COPY ON PURPOSE (2026-10-16). This is notify-cron's pushAll() plus its subscription
// read and prune, lifted as-is so this function does not change notify-cron or depend on a shared
// push module that another session may be creating at the same time. If a `_shared/push.ts` lands
// later, switch this function to it and delete this file. Until then, a fix to pushAll in
// notify-cron belongs here too.
//
// Differences from notify-cron, both deliberate:
//   - NO BADGE. A calendar alert is not a task and not a bell item, so it must not move the app icon
//     number (crm-notification-counters: Tasks badge + bell, nothing else). The Web Push payload has
//     no `count` and the APNs payload no `badge`.
//   - Subscriptions are read once per run, lazily, on the first push. A run with nothing to say
//     (almost every run) never touches push_subscriptions.

import * as webpush from "jsr:@negrel/webpush@0.5.0";
import { sendApns, apnsConfigured, splitSubscriptions } from "../_shared/apns.ts";

export type PushCfg = { vapid_public?: string; vapid_private?: string; vapid_subject?: string; app_url?: string };

interface WebPushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = norm + "=".repeat((4 - (norm.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Raw base64url VAPID keys -> the JWK pair @negrel/webpush wants (same as notify-cron).
function vapidKeysToJwk(publicKeyB64url: string, privateKeyB64url: string) {
  const pub = fromB64url(publicKeyB64url);
  if (pub.length !== 65 || pub[0] !== 0x04) throw new Error(`unexpected VAPID public key length ${pub.length}`);
  const x = b64url(pub.slice(1, 33));
  const y = b64url(pub.slice(33, 65));
  const d = b64url(fromB64url(privateKeyB64url));
  return {
    publicKey: { kty: "EC", crv: "P-256", x, y, ext: true } as JsonWebKey,
    privateKey: { kty: "EC", crv: "P-256", x, y, d, ext: true } as JsonWebKey,
  };
}

export type Pusher = { send: (title: string, body: string, tag: string) => Promise<{ pushed: number; pruned: number }> };

// deno-lint-ignore no-explicit-any
export function makePusher(sb: any, cfg: PushCfg): Pusher {
  let loaded: Promise<{ web: WebPushSub[]; apnsTokens: string[]; appServer: webpush.ApplicationServer | null }> | null = null;

  // Read every push_subscriptions row once (service key bypasses RLS) and split it into the two
  // routes. Web Push rows need their keys; APNs rows are `apns://<token>` endpoints.
  function load() {
    if (!loaded) {
      loaded = (async () => {
        const { data } = await sb.from("push_subscriptions").select("endpoint,subscription");
        const rows = (data ?? []) as Array<{ endpoint: string; subscription?: unknown }>;
        const { apnsTokens, web } = splitSubscriptions(rows);
        const subs = web
          .map((r) => (r.subscription ? (r.subscription as WebPushSub) : null))
          .filter((s): s is WebPushSub => !!s && !!s.endpoint && !!s.keys?.p256dh && !!s.keys?.auth);
        let appServer: webpush.ApplicationServer | null = null;
        if (subs.length && cfg.vapid_public && cfg.vapid_private) {
          try {
            const vapidKeys = await webpush.importVapidKeys(vapidKeysToJwk(cfg.vapid_public, cfg.vapid_private), { extractable: false });
            appServer = await webpush.ApplicationServer.new({
              contactInformation: cfg.vapid_subject || "mailto:mchlbloemeke@gmail.com",
              vapidKeys,
            });
          } catch (e) {
            console.warn("[calendar-alerts] vapid setup failed:", e instanceof Error ? e.message : String(e));
          }
        }
        return { web: subs, apnsTokens, appServer };
      })();
    }
    return loaded;
  }

  async function prune(endpoints: string[]) {
    if (!endpoints.length) return;
    try {
      await sb.from("push_subscriptions").delete().in("endpoint", endpoints);
    } catch { /* best-effort prune */ }
  }

  // One payload to every device Michael owns, both routes. Never throws: one bad device must never
  // fail a run.
  async function send(title: string, body: string, tag: string) {
    let subs: Awaited<ReturnType<typeof load>>;
    try {
      subs = await load();
    } catch (e) {
      console.warn("[calendar-alerts] could not read push subscriptions:", e instanceof Error ? e.message : String(e));
      return { pushed: 0, pruned: 0 };
    }
    const { web, apnsTokens, appServer } = subs;
    let pushed = 0;
    let pruned = 0;

    if (apnsTokens.length && apnsConfigured()) {
      const r = await sendApns(apnsTokens, { title, body, url: cfg.app_url });
      pushed += r.pushed;
      if (r.dead.length) {
        await prune(r.dead);
        pruned += r.dead.length;
      }
    }

    if (appServer && web.length) {
      const payload = JSON.stringify({ title, body, url: cfg.app_url, tag });
      const dead: string[] = [];
      await Promise.all(
        web.map(async (s) => {
          try {
            await appServer.subscribe(s).pushTextMessage(payload, { urgency: webpush.Urgency.High });
            pushed++;
          } catch (e) {
            const status = (e as { response?: Response })?.response?.status;
            if (status === 404 || status === 410) dead.push(s.endpoint);
          }
        }),
      );
      await prune(dead);
      pruned += dead.length;
    }
    return { pushed, pruned };
  }

  return { send };
}
