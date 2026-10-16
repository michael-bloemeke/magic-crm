// Website contact-form endpoint (always-on). Replaces the old Vercel Blob relay.
//
// On every submission it does ALL of these, server-side, immediately, with no dependency on the CRM
// app or Michael's Mac being awake:
//   1. Creates a project in Supabase in the Inquiry stage (stage_id='inquiry'), shaped exactly like
//      the CRM's own createProject() so the CRM reads it natively.
//   2. Emails Michael a copy of the submission through Gmail (reusing the CRM's existing Gmail OAuth
//      refresh token, stored here as secrets).
//   3. Fires a high-urgency lock-screen push to the phone (through _shared/push.ts, like every CRM
//      alert) and records a `new-inquiry` bell notification.
// It also stores the raw submission in the `inquiries` table for the project page's record.
//
// Steps 2 and 3 are best-effort: a mail/push failure never blocks the project from being created.
// Public endpoint (verify_jwt=false): it's a contact form. A honeypot field drops bots and the
// service-role client (auto-injected) bypasses RLS to write the rows.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
// Phone pushes: APNs for the native iOS app plus Web Push, shared by every CRM function.
import { makePusher, badgeCount } from "../_shared/push.ts";

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
// Today in MICHAEL'S timezone, as YYYY-MM-DD. An edge function runs in UTC, so a naive
// toISOString() stamps tomorrow's date on anything that arrives after about 8pm Eastern. en-CA is
// used because it formats as YYYY-MM-DD.
const EASTERN = "America/New_York";
function todayEastern(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: EASTERN,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function logDate(): string {
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  // Same UTC-vs-Eastern trap as above: an evening enquiry was being logged under tomorrow's date.
  const [y, m, d] = todayEastern().split("-").map(Number);
  return `${months[m - 1]} ${d}, ${y}`;
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

// One-line "Description" (event_summary) built ONLY from fields the client actually filled in.
// Empty parts are skipped; if nothing substantive was provided it returns '' (no forced filler).
function briefSummary(inq: Record<string, string>, showTypes: string): string {
  const parts: string[] = [];
  if (showTypes) parts.push(showTypes);
  if (inq.venue) parts.push(`at ${inq.venue}`);
  if (inq.guests) parts.push(`for ${inq.guests} guests`);
  if (inq.eventDate) parts.push(`on ${writtenDate(inq.eventDate) || inq.eventDate}`);
  if (!parts.length) return "";
  return `Website inquiry: ${parts.join(" ")}.`;
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

// ---- Push the phone + record the bell notification (best-effort). ----
// A new inquiry is the single most time-critical alert Michael gets. _shared/push.ts sends it to every
// device he owns (APNs for the iPhone app, Web Push for the PWA), and the iPhone never waits on Web
// Push being configured.
// deno-lint-ignore no-explicit-any
async function pushAndNotify(sb: any, lead: string, projectId: string | null, inquiryId: string): Promise<number> {
  let pushed = 0;
  try {
    const { data: cfg } = await sb
      .from("push_config")
      .select("vapid_public,vapid_private,vapid_subject,app_url")
      .eq("id", 1)
      .single();

    // The app-icon number the phone itself shows (bell + tasks due), plus the bell row written below.
    const r = await makePusher(sb, cfg).send({
      title: "New inquiry!",
      body: lead ? `New website inquiry from ${lead}.` : "A new inquiry just came in through the website.",
      tag: "new-inquiry",
      count: (await badgeCount(sb)) + 1,
    });
    pushed = r.pushed;

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

// ---------------------------------------------------------------------------
// The contact card
// ---------------------------------------------------------------------------
//
// A website inquiry gives a name, an email and a phone number, and that is a CONTACT, linked to the
// new project, the moment it lands (Michael, 2026-10-14). This used to be left to the Mac app's
// seeder (crm-links.mjs), which only runs while the desktop CRM is open, so an inquiry that arrived
// while he was away and working from his phone had no contact card at all until he got home.
//
// THE REUSE RULE IS MICHAEL'S, and deliberately strict: an existing contact is reused only when the
// NAME, the EMAIL and the PHONE all match it. Anything less creates a new contact. A same-name
// stranger merged into a past client's card is worse than a duplicate he can tidy by hand. A detail
// the form left blank is not compared, but a name alone is never enough to reuse.
//
// A project is THREE rows (projects, contacts, contact_links). The project is inserted already marked
// links_seeded, and the caller puts that back to false if this throws, so the Mac seeder still picks
// it up as before.

// Mirrors formatPhone() in crm-phone.mjs: 10 digits -> (XXX) XXX-XXXX, 11 -> +X (XXX) XXX-XXXX,
// anything else left exactly as typed.
function formatPhone(raw: string): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  return s.replace(/\+?\(?\d[\d\s().\-]{7,}\d/g, (run) => {
    const d = run.replace(/\D/g, "");
    if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
    if (d.length === 11) return `+${d[0]} (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
    return run;
  });
}

const normName = (s: unknown) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const normEmail = (s: unknown) => String(s ?? "").trim().toLowerCase();
// Compare phones on digits only, ignoring a leading US country code, so "919-239-9898" and
// "+1 (919) 239-9898" are the same number.
const normPhone = (s: unknown) => {
  const d = String(s ?? "").replace(/\D/g, "");
  return d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
};
const asList = (v: unknown): string[] =>
  (Array.isArray(v) ? v : String(v ?? "").split(/[,;]/)).map((x) => String(x ?? "").trim()).filter(Boolean);

// deno-lint-ignore no-explicit-any
async function linkContact(supabase: any, projectId: string, inq: { name: string; email: string; phone: string }) {
  const name = inq.name.trim();
  const email = normEmail(inq.email);
  const phone = normPhone(inq.phone);
  if (!name && !email) return;

  let contactId = "";
  if (name && (email || phone)) {
    const { data: existing, error } = await supabase.from("contacts").select("id, name, emails, phones");
    if (error) throw new Error(`contact lookup: ${error.message}`);
    // deno-lint-ignore no-explicit-any
    const match = (existing || []).find((c: any) =>
      normName(c.name) === normName(name) &&
      (!email || asList(c.emails).some((e) => normEmail(e) === email)) &&
      (!phone || asList(c.phones).some((p) => normPhone(p) === phone))
    );
    if (match) contactId = match.id;
  }

  if (!contactId) {
    const now = new Date().toISOString();
    const row = {
      id: crypto.randomUUID(),
      name: name || inq.email.trim(),
      emails: inq.email.trim() ? [inq.email.trim()] : [],
      phones: inq.phone.trim() ? [formatPhone(inq.phone)] : [],
      type: "client",
      relationship: "active",
      engagement: "",
      tags: [],
      notes: "",
      created_at: now,
      updated_at: now,
    };
    const { error } = await supabase.from("contacts").insert(row);
    if (error) throw new Error(`contact insert: ${error.message}`);
    contactId = row.id;
  }

  const { error: linkErr } = await supabase
    .from("contact_links")
    .insert({ project_id: projectId, contact_id: contactId, position: 0 });
  if (linkErr) throw new Error(`contact link: ${linkErr.message}`);
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
      // The day the enquiry landed. We know it exactly (it is happening right now), so there is no
      // reason to make Michael type it in later from memory.
      lead_date: todayEastern(),
      event_location: inq.venue,
      event_start_time: to12h(inq.eventTime),
      number_of_guests: inq.guests,
      age_of_guests: inq.ages,
      performance_style: showTypes,
      booking_source: inq.source,
      event_summary: briefSummary(inq, showTypes),
      event_description: describe(inq),
      initial_inquiry: formSummary(inq, showTypes),
      contact_names: inq.name,
      contact_emails: inq.email,
      contact_phones: formatPhone(inq.phone),
      project_notes: "",
      status: "open",
      flags: [],
      activity_log: [activity],
      // TRUE from the start so the Mac seeder cannot race this function and make a second contact
      // in the moment between the insert and the link. Put back to false below if linking fails, so
      // the seeder still covers it.
      links_seeded: true,
    };

    // Insert with a unique id: slug of the name, suffixed if that slug is already taken.
    //
    // ⚠️ `client_name` MUST BE SUFFIXED WITH THE ID. It is not just a label: the CRM treats it as
    // the project's identity and derives the join key for stages, tasks, payments and links from
    // `slugify(client_name)`. Suffixing only the id column produces two rows that slug to the same
    // key, and the CRM's own createProject refuses to make such a pair on purpose.
    //
    // That is the bug Michael hit on 2026-09-20: a second inquiry from the same name landed as
    // `peter-indiana-pan-2` while `client_name` stayed "Peter Indiana Pan", so it collided with the
    // row he had already deleted. The active row shadowed the deleted one, the Deleted page came up
    // empty, and the project appeared to un-delete itself in the pipeline.
    //
    // `project_name` keeps the clean name, so the suffix never shows up in the CRM's UI: the display
    // reads "Peter Indiana Pan" while the identity underneath is unique.
    const baseId = slugify(displayName);
    let projectId: string | null = null;
    for (let i = 0; i < 8; i++) {
      const suffix = i === 0 ? "" : ` ${i + 1}`;
      const id = slugify(displayName + suffix);
      const { error } = await supabase
        .from("projects")
        .insert({ id, ...baseRow, client_name: displayName + suffix });
      if (!error) { projectId = id; break; }
      if (error.code !== "23505") {
        console.warn("[inquiry] project insert failed:", error.message);
        break;
      }
    }
    if (!projectId) {
      const suffix = ` ${Math.random().toString(36).slice(2, 7)}`;
      const id = slugify(displayName + suffix);
      const { error } = await supabase
        .from("projects")
        .insert({ id, ...baseRow, client_name: displayName + suffix });
      if (!error) projectId = id;
      else console.warn("[inquiry] project insert final failure:", error.message);
    }

    // The contact card, linked to the project. Best-effort: a failure here must never cost the
    // inquiry itself, and the Mac seeder covers anything left unlinked.
    if (projectId) {
      try {
        await linkContact(supabase, projectId, inq);
      } catch (e) {
        console.warn("[inquiry] contact step failed:", e instanceof Error ? e.message : String(e));
        await supabase.from("projects").update({ links_seeded: false }).eq("id", projectId);
      }
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
