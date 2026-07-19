// Website contact-form endpoint (always-on). Replaces the old Vercel Blob relay.
//
// On every submission it does ALL of these, server-side, immediately, with no dependency on the CRM
// app or Michael's Mac being awake:
//   1. Creates a project in Supabase in the Inquiry stage (stage_id='inquiry'), shaped exactly like
//      the CRM's own createProject() so the CRM reads it natively.
//   2. Emails Michael a copy of the submission through Gmail (reusing the CRM's existing Gmail OAuth
//      refresh token, stored here as secrets).
//   3. Fires a high-urgency lock-screen push to the phone app and records a `new-inquiry` bell
//      notification, mirroring notify-cron (VAPID web push via @negrel/webpush, config from the
//      service-role-only push_config table, subscriptions from push_subscriptions).
// It also stores the raw submission in the `inquiries` table for the project page's record.
//
// Steps 2 and 3 are best-effort: a mail/push failure never blocks the project from being created.
// Public endpoint (verify_jwt=false): it's a contact form. A honeypot field drops bots and the
// service-role client (auto-injected) bypasses RLS to write the rows.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import * as webpush from "jsr:@negrel/webpush@0.5.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const NOTIFY_TO = "michael@michaelbloemeke.com"; // where the alert email goes
const FROM = "My CRM <michael@michaelbloemeke.com>";

// --- Email formatting helpers ------------------------------------------------
function escHtml(s: string): string {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
// "YYYY-MM-DD" -> "Weekday, Month D, YYYY". Parsed by parts so it never shifts a day
// across timezones. Anything that isn't a plain ISO date is returned untouched.
function prettyDate(v: string): string {
  const s = (v || "").trim();
  const m = /^(\d{1,4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (!m) return s;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return s;
  const dt = new Date(Date.UTC(2000, mo - 1, d));
  dt.setUTCFullYear(y);
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${days[dt.getUTCDay()]}, ${months[mo - 1]} ${d}, ${y}`;
}
// 10-digit US phone -> "(XXX)-XXX-XXXX". Strips a leading 1. Leaves anything else untouched.
function prettyPhone(v: string): string {
  const digits = (v || "").replace(/\D/g, "");
  const d = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (d.length !== 10) return v;
  return `(${d.slice(0, 3)})-${d.slice(3, 6)}-${d.slice(6)}`;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

const str = (v: unknown, max = 4000) =>
  String(v == null ? "" : v).slice(0, max).trim();

// Mirror of crm-data-core.slugify — the project id must match the CRM's convention.
function slugify(name: string): string {
  return (
    String(name || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project"
  );
}

// Mirror of crm-data-core.logDate — "Month Day, Year".
function logDate(): string {
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const d = new Date();
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

// 12-hour time ("16:00" -> "4:00 PM"). Non-HH:MM values pass through unchanged.
function to12h(t: string): string {
  const m = String(t || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return String(t || "").trim();
  let h = parseInt(m[1], 10);
  const period = h >= 12 ? "PM" : "AM";
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${m[2]} ${period}`;
}
// Written-out date ("2026-10-17" -> "Saturday, October 17th, 2026"). Non-ISO values pass through.
function writtenDate(iso: string): string {
  const m = String(iso || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(iso || "").trim();
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const wd = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getUTCDay()];
  const mo = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][d.getUTCMonth()];
  const day = d.getUTCDate();
  const ord = day % 10 === 1 && day !== 11 ? "st" : day % 10 === 2 && day !== 12 ? "nd" : day % 10 === 3 && day !== 13 ? "rd" : "th";
  return `${wd}, ${mo} ${day}${ord}, ${m[1]}`;
}

// notifications.id shape, matching crm-notifications.newId / notify-cron: 'n' + base36 time + 4 rand.
function newNotificationId(): string {
  return "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Mirror of crm-inquiries.describe — event_description from message + a couple of extras.
function describe(inq: Record<string, string>): string {
  const lines: string[] = [];
  if (inq.message) lines.push(inq.message.trim());
  const extras: string[] = [];
  if (inq.eventTime) extras.push(`Time: ${to12h(inq.eventTime)}`);
  if (inq.source) extras.push(`Heard about Michael via: ${inq.source}`);
  if (extras.length) lines.push(extras.join(" · "));
  return lines.join("\n\n");
}

// The raw website-form submission, formatted for the project's "Initial inquiry" field. Mirrors the
// alert email body so the CRM shows exactly what the client typed/selected in the form.
function formSummary(inq: Record<string, string>, showTypes: string): string {
  const rows: [string, string][] = [
    ["Name", inq.name],
    ["Email", inq.email],
    ["Phone", inq.phone],
    ["Event date", writtenDate(inq.eventDate)],
    ["Event time", to12h(inq.eventTime)],
    ["Venue", inq.venue],
    ["Guests", inq.guests],
    ["Guest ages", inq.ages],
    ["Show type", showTypes],
    ["Heard about Michael via", inq.source],
  ];
  const lines: string[] = [];
  lines.push(`Submitted via the website contact form${inq.formLocation ? ` (${inq.formLocation})` : ""} on ${logDate()}.`, "");
  for (const [label, value] of rows) if (value) lines.push(`${label}: ${value}`);
  if (inq.message) lines.push("", "Message:", inq.message);
  return lines.join("\n");
}

// ---- VAPID key conversion helpers (copied from notify-cron; raw base64url <-> P-256 JWK) ----
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
function vapidKeysToJwk(publicKeyB64url: string, privateKeyB64url: string): { publicKey: JsonWebKey; privateKey: JsonWebKey } {
  const pub = fromB64url(publicKeyB64url);
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error(`unexpected VAPID public key length ${pub.length}`);
  }
  const x = b64url(pub.slice(1, 33));
  const y = b64url(pub.slice(33, 65));
  const d = b64url(fromB64url(privateKeyB64url));
  return {
    publicKey: { kty: "EC", crv: "P-256", x, y, ext: true },
    privateKey: { kty: "EC", crv: "P-256", x, y, d, ext: true },
  };
}

interface WebPushSub { endpoint: string; keys: { p256dh: string; auth: string } }

// ---- Push the phone + record the bell notification (best-effort). Mirrors notify-cron. ----
// deno-lint-ignore no-explicit-any
async function pushAndNotify(sb: any, lead: string, projectId: string | null, inquiryId: string): Promise<number> {
  let pushed = 0;
  try {
    const { data: cfg } = await sb
      .from("push_config")
      .select("vapid_public,vapid_private,vapid_subject,app_url")
      .eq("id", 1)
      .single();

    const { data: subRows } = await sb.from("push_subscriptions").select("endpoint,subscription");
    const subs: WebPushSub[] = (subRows ?? [])
      .map((r: { subscription?: unknown }) => (r && r.subscription ? (r.subscription as WebPushSub) : null))
      .filter((s: WebPushSub | null): s is WebPushSub => !!s && !!s.endpoint && !!s.keys?.p256dh && !!s.keys?.auth);

    const { count } = await sb.from("notifications").select("id", { count: "exact", head: true }).eq("seen", false);
    const badge = (count ?? 0) + 1;

    if (cfg?.vapid_public && cfg?.vapid_private && subs.length) {
      const vapidKeys = await webpush.importVapidKeys(vapidKeysToJwk(cfg.vapid_public, cfg.vapid_private), { extractable: false });
      const appServer = await webpush.ApplicationServer.new({
        contactInformation: cfg.vapid_subject || "mailto:mchlbloemeke@gmail.com",
        vapidKeys,
      });
      const payload = JSON.stringify({
        title: "New inquiry!",
        body: lead ? `New website inquiry from ${lead}.` : "A new inquiry just came in through the website.",
        url: cfg.app_url,
        tag: "new-inquiry",
        count: badge,
      });
      const dead: string[] = [];
      await Promise.all(subs.map(async (s) => {
        try {
          await appServer.subscribe(s).pushTextMessage(payload, { urgency: webpush.Urgency.High });
          pushed++;
        } catch (e) {
          const status = (e as { response?: Response })?.response?.status;
          if (status === 404 || status === 410) dead.push(s.endpoint);
        }
      }));
      if (dead.length) {
        try { await sb.from("push_subscriptions").delete().in("endpoint", dead); } catch { /* best-effort */ }
      }
    }

    // Record the bell notification (also powers the unseen badge + dedups against notify-cron).
    try {
      await sb.from("notifications").insert({
        id: newNotificationId(),
        project_id: projectId || slugify(lead),
        kind: "new-inquiry",
        source_id: inquiryId,
        seen: false,
        created_at: new Date().toISOString(),
      });
    } catch (e) {
      console.warn("[inquiry] notification insert failed:", e instanceof Error ? e.message : String(e));
    }
  } catch (e) {
    console.warn("[inquiry] push error:", e instanceof Error ? e.message : String(e));
  }
  return pushed;
}

// ---- Gmail send (best-effort). Reuses the CRM's OAuth app + refresh token via secrets. ----
async function sendAlertEmail(inq: Record<string, string>, showTypes: string, projectId: string | null): Promise<boolean> {
  const clientId = Deno.env.get("GMAIL_CLIENT_ID");
  const clientSecret = Deno.env.get("GMAIL_CLIENT_SECRET");
  const refreshToken = Deno.env.get("GMAIL_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) {
    console.warn("[inquiry] Gmail secrets not set; skipping email");
    return false;
  }
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!tokenRes.ok) {
      console.warn("[inquiry] token refresh failed:", tokenRes.status, await tokenRes.text());
      return false;
    }
    const { access_token } = await tokenRes.json();
    if (!access_token) return false;

    const rows: [string, string][] = [
      ["Name", inq.name],
      ["Email", inq.email],
      ["Phone", inq.phone],
      ["Event date", writtenDate(inq.eventDate)],
      ["Event time", to12h(inq.eventTime)],
      ["Venue", inq.venue],
      ["Guests", inq.guests],
      ["Guest ages", inq.ages],
      ["Show type", showTypes],
      ["Heard about Michael via", inq.source],
    ];
    const fieldRows = rows
      .filter(([, value]) => value)
      .map(([label, value]) => {
        let v = value;
        if (label === "Phone") v = prettyPhone(value);
        else if (label === "Event date") v = prettyDate(value);
        return `<tr>`
          + `<td style="padding:8px 20px 8px 0;font-weight:700;color:#111;vertical-align:top;white-space:nowrap;">${escHtml(label)}</td>`
          + `<td style="padding:8px 0;color:#333;vertical-align:top;">${escHtml(v)}</td>`
          + `</tr>`;
      })
      .join("");
    const messageBlock = inq.message
      ? `<p style="margin:26px 0 6px;font-weight:700;color:#111;">Message</p>`
        + `<p style="margin:0;color:#333;white-space:pre-wrap;">${escHtml(inq.message)}</p>`
      : "";
    const crmNote = projectId
      ? "It has been added to your CRM as a new project in the Inquiry stage."
      : "Heads up: the CRM project could not be auto-created for this one, so add it manually.";
    const sentFrom = inq.formLocation
      ? `<p style="margin:22px 0 0;color:#8a8a8a;font-size:13px;">Submitted from the <strong>${escHtml(inq.formLocation)}</strong> form.</p>`
      : "";
    const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f4f5;">`
      + `<div style="max-width:600px;margin:0 auto;padding:32px 28px;background:#ffffff;`
      + `font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;`
      + `font-size:15px;line-height:1.7;color:#333;">`
      + `<p style="margin:0 0 24px;font-size:16px;color:#111;">A new inquiry just came in through the website contact form.</p>`
      + `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:15px;line-height:1.6;">${fieldRows}</table>`
      + messageBlock
      + `<p style="margin:26px 0 0;color:#555;">${crmNote}</p>`
      + sentFrom
      + `</div></body></html>`;

    const subject = `New website inquiry${inq.formLocation ? ` (${inq.formLocation})` : ""}: ${inq.name || inq.email || "someone"}`;

    const headers = [
      `From: ${FROM}`,
      `To: ${NOTIFY_TO}`,
      inq.email ? `Reply-To: ${inq.email}` : "",
      `Subject: ${subject}`,
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=UTF-8",
    ].filter(Boolean).join("\r\n");
    const raw = `${headers}\r\n\r\n${html}`;
    const b64 = btoa(unescape(encodeURIComponent(raw)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    const sendRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw: b64 }),
    });
    if (!sendRes.ok) {
      console.warn("[inquiry] gmail send failed:", sendRes.status, await sendRes.text());
      return false;
    }
    return true;
  } catch (e) {
    console.warn("[inquiry] email error:", e instanceof Error ? e.message : String(e));
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const b = await req.json().catch(() => ({}));
    if (b && b._hp) return json({ ok: true }); // honeypot: pretend success, discard

    const inq = {
      name: str(b?.name, 200),
      email: str(b?.email, 200),
      phone: str(b?.phone, 60),
      eventDate: str(b?.eventDate, 60),
      eventTime: str(b?.eventTime, 120),
      guests: str(b?.guests, 120),
      ages: str(b?.ages, 120),
      source: str(b?.source, 120),
      venue: str(b?.venue, 400),
      message: str(b?.message, 5000),
      formLocation: str(b?.formLocation, 40),
    };
    const showTypes = Array.isArray(b?.showTypes)
      ? b.showTypes.map((x: unknown) => str(x, 80)).filter(Boolean).join(", ")
      : str(b?.showTypes, 300);

    if (!inq.email && !inq.name) {
      return json({ error: "Please include at least a name or email." }, 400);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    const displayName = inq.name || inq.email || "Website inquiry";
    const activity = `${logDate()}: New inquiry from the website contact form${inq.formLocation ? ` (${inq.formLocation})` : ""}.`;

    const baseRow: Record<string, unknown> = {
      client_name: displayName,
      project_name: displayName,
      bucket: "active",
      stage_id: "inquiry",
      event_type: "",
      event_date: inq.eventDate,
      event_location: inq.venue,
      event_start_time: to12h(inq.eventTime),
      number_of_guests: inq.guests,
      age_of_guests: inq.ages,
      performance_style: showTypes,
      booking_source: inq.source,
      event_description: describe(inq),
      initial_inquiry: formSummary(inq, showTypes),
      contact_names: inq.name,
      contact_emails: inq.email,
      contact_phones: inq.phone,
      project_notes: "",
      status: "open",
      flags: [],
      activity_log: [activity],
      links_seeded: false,
    };

    // Insert with a unique id: slug of the name, suffixed if that slug is already taken.
    const baseId = slugify(displayName);
    let projectId: string | null = null;
    for (let i = 0; i < 8; i++) {
      const id = i === 0 ? baseId : `${baseId}-${i + 1}`;
      const { error } = await supabase.from("projects").insert({ id, ...baseRow });
      if (!error) { projectId = id; break; }
      if (error.code !== "23505") {
        console.warn("[inquiry] project insert failed:", error.message);
        break;
      }
    }
    if (!projectId) {
      const id = `${baseId}-${Math.random().toString(36).slice(2, 7)}`;
      const { error } = await supabase.from("projects").insert({ id, ...baseRow });
      if (!error) projectId = id;
      else console.warn("[inquiry] project insert final failure:", error.message);
    }

    // Store the raw submission in the inquiries table (record for the project page).
    const inquiryId = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 7)}`;
    const inquiryData = { id: inquiryId, submittedAt: new Date().toISOString(), ...inq, showTypes, projectId };
    const { error: inqErr } = await supabase.from("inquiries").insert({ id: inquiryId, data: inquiryData });
    if (inqErr) console.warn("[inquiry] inquiries insert failed:", inqErr.message);

    // Email + phone push (both best-effort; neither blocks the response).
    const emailed = await sendAlertEmail(inq, showTypes, projectId);
    const pushed = await pushAndNotify(supabase, inq.name || inq.email, projectId, inquiryId);

    return json({ ok: true, projectId, emailed, pushed });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
