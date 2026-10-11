// GIG-SITE LEADS INTO THE CRM, ON THEIR OWN. Built 2026-10-11 at Michael's request (projects.md,
// project 20). GigSalad went live first; The Bash was added the same day. Bark is next.
//
// WHY. People who post on the gig sites rarely answer the first call, so a lead needs following up
// every day for a few days, and the leads were sitting in his inbox and the apps without ever
// reaching the CRM or reminding him of anything.
//
// WHAT IT DOES, every couple of minutes off pg_cron (job `gig-leads`):
//   1. Searches Gmail for NEW-LEAD emails only, one query per site (see SOURCES below):
//      GigSalad leads@gigsalad.com "New lead"; The Bash info@thebash.com "Gig Alert".
//      Quote-viewed notices, reminders, stats and promos never match.
//   2. Skips any message already in `lead_imports`, so one email can never make two projects.
//   3. Parses everything the email carries (GigSalad: first name, type, date, times, city. The Bash:
//      gig ID, type, date only) and turns the email's tracking link into the clean listing link
//      (gigsalad.com/g/.../a/<id>, thebash.com/leads/<id>). The Bash link is an AUTO-LOGIN link;
//      only the /leads/<id> path is kept, never the login token, so it needs his normal login.
//   4. Creates the project in `inquiry`, shaped like the website inquiry function's, with the
//      site as booking_source and links_seeded=false so the CRM seeds the contact itself. The
//      listing link sits at the bottom of initial_inquiry as "Open the lead on <Site>: <url>", which
//      the CRM's Initial inquiry popup turns into an "Open this lead on <Site>" button.
//   5. Adds four follow-up tasks (Michael's choice, 2026-10-11): day 0 respond on GigSalad, days
//      1 and 2 follow up, day 4 last follow-up. All-day tasks, dated in Eastern time.
//      Day 0 is worded for the site ("Respond on The Bash").
//   6. Flags a date clash in the notes: the China trip window, or a booked gig the same night.
//   7. Pings his phone and drops a bell notification, the same way a website inquiry does.
//
// If an email matches but cannot be parsed, it is recorded as `unparsed` and he gets a push saying
// so, rather than the lead vanishing silently. GigSalad redesigning its email is the likely cause.
//
// MODES (POST body): {} = normal run. {"dry": true} = parse and report, write nothing.
// {"test": "<gmail message id>"} = import that one message with no alert (verification only).
// {"seed": true} = record every matching email as already seen WITHOUT creating projects. The seed
// was run once at go-live so only leads arriving after it are imported (Michael: new leads only).
//
// AUTH: the `x-cron-secret` header must match push_config.cron_secret, like notify-cron.
// GMAIL: the same `email_config` OAuth client + refresh token the `gmail` function uses.
import { createClient } from "jsr:@supabase/supabase-js@2";
import * as webpush from "jsr:@negrel/webpush@0.5.0";
import { sendApns, apnsConfigured } from "../_shared/apns.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const EASTERN = "America/New_York";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// Dates Michael cannot work, flagged on any lead that lands in them. Keep in step with the
// business CLAUDE.md. The China trip is the only one as of 2026-10-11.
const BLACKOUTS = [{ from: "2026-10-26", to: "2026-11-09", label: "the China trip (October 26 to November 9)" }];

// Follow-up tasks added to every imported project, as [days after today, title]. "{site}" is
// replaced with the site's name.
const FOLLOW_UPS: Array<[number, string]> = [
  [0, "Respond on {site}"],
  [1, "Follow up: call, text, and email"],
  [2, "Follow up: call, text, and email"],
  [4, "Last follow-up: call, text, and email"],
];

function todayEastern(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: EASTERN, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}
function logDate(): string {
  const [y, m, d] = todayEastern().split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}
function writtenDate(iso: string): string {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const wd = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getUTCDay()];
  const day = d.getUTCDate();
  const ord = day % 10 === 1 && day !== 11 ? "st" : day % 10 === 2 && day !== 12 ? "nd" : day % 10 === 3 && day !== 13 ? "rd" : "th";
  return `${wd}, ${MONTHS[d.getUTCMonth()]} ${day}${ord}, ${m[1]}`;
}
// Mirror of crm-data-core.slugify: the project id must match the CRM's convention.
function slugify(name: string): string {
  return String(name || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}
// "6:30 pm to 8:00 pm" -> "6:30 PM to 8:00 PM" (12-hour rule).
function tidyTimes(t: string): string {
  return String(t || "").replace(/\b(am|pm)\b/gi, (x) => x.toUpperCase()).trim();
}
// GigSalad's event-type words mapped onto the CRM's fixed list. Anything unclear stays blank for
// Michael to set (a "Christmas Party" can be a company or a family), and the GigSalad wording is
// kept in the summary either way.
function crmEventType(t: string): string {
  const k = t.toLowerCase();
  if (/bachelor/.test(k)) return "Bachelor(ette) Party";
  if (/wedding|reception|engagement|rehearsal/.test(k)) return "Wedding";
  if (/corporate|company|office|business|nonprofit|fundrais|gala|conference|trade show|employee/.test(k)) return "Corporate";
  if (/birthday|house party|personal|anniversary|graduation|family|reunion|baby|kids|teen/.test(k)) return "Private Event";
  return "";
}

function decodeB64Url(data: string): string {
  const b64 = String(data || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  try {
    const bin = atob(b64 + pad);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  } catch { return ""; }
}
// deno-lint-ignore no-explicit-any
function plainBody(payload: any): string {
  let plain = "";
  // deno-lint-ignore no-explicit-any
  const walk = (p: any) => {
    if (!p || plain) return;
    if (p.mimeType === "text/plain" && p.body?.data && !p.filename) plain = decodeB64Url(p.body.data);
    (p.parts || []).forEach(walk);
  };
  walk(payload);
  return plain.replace(/\r\n/g, "\n").replace(/&amp;/g, "&");
}
// deno-lint-ignore no-explicit-any
function header(headers: any[], name: string): string {
  const h = (headers || []).find((x) => String(x.name || "").toLowerCase() === name.toLowerCase());
  return h ? String(h.value || "") : "";
}

interface Lead {
  source: string; // lead_imports.source key
  site: string; // display name, also the booking_source
  firstName: string;
  eventType: string;
  eventDate: string;
  times: string;
  city: string;
  gigId: string;
  link: string; // raw tracking link from the email; resolved to the clean listing link later
}

// Subject: "🔔 New lead (12/10/2026 in Apex, NC)"
// Body:    "Eddie would like a quote for a Christmas Party on December 10, 2026 from 6:30 pm to 8:00 pm."
//          "View the details & reply: https://tracking.gigsalad.com/..."
// Verified against all 11 GigSalad lead emails from 2026-09-20 to 2026-10-11 before go-live.
function parseGigSalad(subject: string, body: string): Lead | null {
  const sm = subject.match(/New lead \((\d{2})\/(\d{2})\/(\d{4}) in (.+?)\)/);
  const bm = body.match(/^\s*(.+?) would like a quote for an? (.+?) on [A-Z][a-z]+ \d{1,2}, \d{4}(?: from (.+?))?\.\s*$/m);
  if (!sm || !bm) return null;
  const link = (body.match(/View the details & reply: (\S+)/) || [])[1] || "";
  return {
    source: "gigsalad",
    site: "GigSalad",
    gigId: "",
    firstName: bm[1].trim().slice(0, 80),
    eventType: bm[2].trim().slice(0, 80),
    eventDate: `${sm[3]}-${sm[1]}-${sm[2]}`,
    times: tidyTimes(bm[3] || ""),
    city: sm[4].trim().slice(0, 120),
    link,
  };
}

// The Bash sends only HTML that matters. Subject: "Gig Alert: Corporate Function Lead! (Gig ID #5072836)".
// Body text: "GIG ID: 5072836  EVENT DATE: Friday, December 11, 2026  EVENT TYPE: Corporate Function
// VIEW NOW". No name, no city: those are only on the lead page. Verified against the three Bash lead
// emails from 2026-10-01 before go-live.
// deno-lint-ignore no-explicit-any
function htmlBody(payload: any): string {
  let html = "";
  // deno-lint-ignore no-explicit-any
  const walk = (p: any) => {
    if (!p || html) return;
    if (p.mimeType === "text/html" && p.body?.data && !p.filename) html = decodeB64Url(p.body.data);
    (p.parts || []).forEach(walk);
  };
  walk(payload);
  return html;
}
function parseBash(subject: string, html: string): Lead | null {
  const text = html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
  const gig = (text.match(/GIG ID:\s*(\d+)/) || subject.match(/Gig ID #(\d+)/) || [])[1];
  const dm = text.match(/EVENT DATE:\s*[A-Za-z]+,\s*([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
  const type = ((text.match(/EVENT TYPE:\s*(.+?)\s+VIEW NOW/) || [])[1] || (subject.match(/Gig Alert:\s*(.+?) Lead!/) || [])[1] || "").trim();
  if (!gig || !dm) return null;
  const mo = MONTHS.indexOf(dm[1]) + 1;
  if (mo < 1) return null;
  const link = (html.match(/href="(https:\/\/[^"]*thebash\.com\/ls\/click[^"]*)"/) || [])[1] || "";
  return {
    source: "thebash",
    site: "The Bash",
    gigId: gig,
    firstName: "",
    eventType: type.slice(0, 80),
    eventDate: `${dm[3]}-${String(mo).padStart(2, "0")}-${String(+dm[2]).padStart(2, "0")}`,
    times: "",
    city: "",
    link: link.replace(/&amp;/g, "&"),
  };
}

// The email's button is a click-tracking redirect. Follow ONE hop (never into a login) and keep a
// clean listing URL: GigSalad -> https://www.gigsalad.com/g/<token>/a/<id>; The Bash -> its
// auto-login URL carries ReturnURL=.../leads/<id>, which becomes https://www.thebash.com/leads/<id>.
// If it cannot be resolved, GigSalad keeps its tracking link (no login in it) and The Bash falls
// back to the leads list, so a login token is never stored.
async function resolveLink(lead: Lead): Promise<string> {
  if (!lead.link) return lead.source === "thebash" ? "https://www.thebash.com/leads" : "";
  try {
    const r = await fetch(lead.link, { redirect: "manual" });
    const loc = r.headers.get("location") || "";
    if (lead.source === "gigsalad") {
      const u = new URL(loc);
      if (/(^|\.)gigsalad\.com$/.test(u.hostname)) return u.origin + u.pathname;
      return lead.link;
    }
    const m = decodeURIComponent(decodeURIComponent(loc)).match(/\/leads\/(\d+)/);
    return m ? `https://www.thebash.com/leads/${m[1]}` : "https://www.thebash.com/leads";
  } catch {
    return lead.source === "thebash" ? "https://www.thebash.com/leads" : lead.link;
  }
}

// One entry per site. Bark will be added here.
const SOURCES = [
  { key: "gigsalad", query: 'from:leads@gigsalad.com subject:"New lead"', parse: (subj: string, payload: unknown) => parseGigSalad(subj, plainBody(payload)) },
  { key: "thebash", query: 'from:info@thebash.com subject:"Gig Alert"', parse: (subj: string, payload: unknown) => parseBash(subj, htmlBody(payload)) },
];

// ---- Phone push + bell notification, mirroring the inquiry function. Best-effort. ----
function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s: string): Uint8Array {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(norm + "=".repeat((4 - (norm.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function vapidKeysToJwk(pubB64: string, privB64: string) {
  const pub = fromB64url(pubB64);
  const x = b64url(pub.slice(1, 33)), y = b64url(pub.slice(33, 65)), d = b64url(fromB64url(privB64));
  return { publicKey: { kty: "EC", crv: "P-256", x, y, ext: true }, privateKey: { kty: "EC", crv: "P-256", x, y, d, ext: true } };
}
interface WebPushSub { endpoint: string; keys: { p256dh: string; auth: string } }

// deno-lint-ignore no-explicit-any
async function pushAndNotify(sb: any, title: string, body: string, projectId: string, sourceId: string): Promise<number> {
  let pushed = 0;
  try {
    const { data: cfg } = await sb.from("push_config").select("vapid_public,vapid_private,vapid_subject,app_url").eq("id", 1).single();
    const { data: subRows } = await sb.from("push_subscriptions").select("endpoint,subscription");
    const subs: WebPushSub[] = (subRows ?? [])
      .map((r: { subscription?: unknown }) => (r?.subscription ? (r.subscription as WebPushSub) : null))
      .filter((s: WebPushSub | null): s is WebPushSub => !!s && !!s.endpoint && !!s.keys?.p256dh && !!s.keys?.auth);
    const apnsTokens: string[] = (subRows ?? [])
      .map((r: { endpoint?: string }) => String(r?.endpoint ?? ""))
      .filter((e: string) => e.startsWith("apns://"))
      .map((e: string) => e.slice("apns://".length));
    const { count } = await sb.from("notifications").select("id", { count: "exact", head: true }).eq("seen", false);
    const badge = (count ?? 0) + 1;

    if (cfg?.vapid_public && cfg?.vapid_private && subs.length) {
      const vapidKeys = await webpush.importVapidKeys(vapidKeysToJwk(cfg.vapid_public, cfg.vapid_private), { extractable: false });
      const appServer = await webpush.ApplicationServer.new({ contactInformation: cfg.vapid_subject || "mailto:mchlbloemeke@gmail.com", vapidKeys });
      const payload = JSON.stringify({ title, body, url: cfg.app_url, tag: "new-inquiry", count: badge });
      const dead: string[] = [];
      await Promise.all(subs.map(async (s) => {
        try { await appServer.subscribe(s).pushTextMessage(payload, { urgency: webpush.Urgency.High }); pushed++; }
        catch (e) {
          const status = (e as { response?: Response })?.response?.status;
          if (status === 404 || status === 410) dead.push(s.endpoint);
        }
      }));
      if (dead.length) { try { await sb.from("push_subscriptions").delete().in("endpoint", dead); } catch { /* best-effort */ } }
    }
    if (apnsTokens.length && apnsConfigured()) {
      const r = await sendApns(apnsTokens, { title, body, badge, url: cfg?.app_url });
      pushed += r.pushed;
      if (r.dead.length) { try { await sb.from("push_subscriptions").delete().in("endpoint", r.dead); } catch { /* best-effort */ } }
    }
    await sb.from("notifications").insert({
      id: "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      project_id: projectId,
      kind: "new-inquiry",
      source_id: sourceId,
      seen: false,
      created_at: new Date().toISOString(),
    });
  } catch (e) {
    console.warn("[gig-leads] push error:", e instanceof Error ? e.message : String(e));
  }
  return pushed;
}

// deno-lint-ignore no-explicit-any
async function clashNotes(sb: any, eventDate: string): Promise<string[]> {
  const notes: string[] = [];
  for (const b of BLACKOUTS) {
    if (eventDate >= b.from && eventDate <= b.to) notes.push(`⚠️ DATE CLASH: this falls during ${b.label}.`);
  }
  const { data: booked } = await sb
    .from("projects")
    .select("project_name, client_name")
    .eq("event_date", eventDate)
    .eq("stage_id", "deposit-paid")
    .is("deleted_at", null);
  for (const p of booked ?? []) {
    notes.push(`⚠️ DATE CLASH: already booked that day (${p.project_name || p.client_name}). Check the times.`);
  }
  return notes;
}

// deno-lint-ignore no-explicit-any
async function createProject(sb: any, lead: Lead, messageId: string): Promise<string | null> {
  const listing = await resolveLink(lead);
  const displayName = lead.firstName ? `${lead.firstName} (${lead.site})` : `${lead.site} lead #${lead.gigId}`;
  const typeLine = lead.eventType ? `${lead.eventType} ` : "";
  const where = lead.city ? `in ${lead.city} ` : "";
  const when = [writtenDate(lead.eventDate), lead.times].filter(Boolean).join(", ");
  const clashes = await clashNotes(sb, lead.eventDate);
  const initial = [
    `Received from ${lead.site} on ${logDate()}.`,
    "",
    lead.firstName ? `First name: ${lead.firstName}` : null,
    lead.gigId ? `Gig ID: ${lead.gigId}` : null,
    lead.eventType ? `Event type: ${lead.eventType}` : null,
    `Event date: ${writtenDate(lead.eventDate)}`,
    lead.times ? `Time: ${lead.times}` : null,
    lead.city ? `Location: ${lead.city}` : null,
    "",
    lead.source === "thebash"
      ? "The client's name, location, guest count and message are on the lead page. The Bash's email only carries the gig ID, date and type."
      : `Contact details stay hidden until you respond on ${lead.site}.`,
    listing ? `\nOpen the lead on ${lead.site}: ${listing}` : null,
  ].filter((l) => l !== null).join("\n");

  const baseRow: Record<string, unknown> = {
    project_name: displayName,
    bucket: "active",
    stage_id: "inquiry",
    event_type: crmEventType(lead.eventType),
    event_date: lead.eventDate,
    lead_date: todayEastern(),
    event_location: lead.city,
    event_start_time: lead.times,
    number_of_guests: "",
    age_of_guests: "",
    performance_style: "",
    booking_source: lead.site,
    event_summary: `${lead.site} lead: ${typeLine}${where}on ${when}.`,
    event_description: `${lead.firstName || "A client"} asked for a quote on ${lead.site} for a ${lead.eventType || "event"} ${where}on ${when}.`,
    initial_inquiry: initial,
    contact_names: lead.firstName,
    contact_emails: "",
    contact_phones: "",
    project_notes: clashes.join("\n"),
    status: "open",
    flags: [],
    activity_log: [`${logDate()}: New ${lead.site} lead, added to the CRM automatically.`],
    links_seeded: false,
  };

  // Same unique-id rule as the inquiry function: client_name is the CRM's identity key, so it is
  // suffixed together with the id, never the id alone.
  for (let i = 0; i < 8; i++) {
    const suffix = i === 0 ? "" : ` ${i + 1}`;
    const id = slugify(displayName + suffix);
    const { error } = await sb.from("projects").insert({ id, ...baseRow, client_name: displayName + suffix });
    if (!error) {
      const today = todayEastern();
      const tasks = FOLLOW_UPS.map(([days, title]) => ({
        id: crypto.randomUUID(), project_id: id, title: title.replace("{site}", lead.site), due_date: addDays(today, days), due_time: null, done: false, created_at: new Date().toISOString(),
      }));
      const { error: tErr } = await sb.from("tasks").insert(tasks);
      if (tErr) console.warn("[gig-leads] task insert failed:", tErr.message);
      return id;
    }
    if (error.code !== "23505") { console.warn("[gig-leads] project insert failed:", error.message, messageId); return null; }
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  const { data: pc } = await sb.from("push_config").select("cron_secret").eq("id", 1).single();
  const given = req.headers.get("x-cron-secret") ?? "";
  if (!pc?.cron_secret || given !== pc.cron_secret) return json({ ok: false, error: "Forbidden" }, 403);

  let opts: { dry?: boolean; seed?: boolean; test?: string } = {};
  try { opts = await req.json(); } catch { /* empty body = normal run */ }

  const { data: cfg } = await sb.from("email_config").select("*").eq("id", 1).single();
  if (!cfg) return json({ ok: false, error: "Email is not configured." }, 500);
  const tokRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: cfg.client_id, client_secret: cfg.client_secret, refresh_token: cfg.refresh_token, grant_type: "refresh_token" }),
  });
  const tok = await tokRes.json();
  if (!tokRes.ok || !tok.access_token) return json({ ok: false, error: "Gmail auth failed." }, 502);
  const auth = { Authorization: `Bearer ${tok.access_token}` };
  const api = (p: string) => `https://gmail.googleapis.com/gmail/v1/users/me/${p}`;

  const window = opts.seed || opts.dry ? "30d" : "7d";
  // deno-lint-ignore no-explicit-any
  const fetchMsg = async (id: string): Promise<any | null> => {
    const r = await fetch(api(`messages/${id}?format=full`), { headers: auth });
    return r.ok ? await r.json() : null;
  };

  // TEST MODE: import ONE named message, even if already seen, with NO phone alert and no
  // lead_imports row. Used to verify a full import end to end; the test project is then removed.
  if (opts.test) {
    const msg = await fetchMsg(opts.test);
    if (!msg) return json({ ok: false, error: "fetch failed" }, 502);
    const subject = header(msg.payload?.headers, "Subject");
    const lead = SOURCES.map((src) => src.parse(subject, msg.payload)).find(Boolean) ?? null;
    if (!lead) return json({ ok: false, error: "unparsed" });
    const projectId = await createProject(sb, lead, opts.test);
    return json({ ok: true, test: true, projectId, lead });
  }

  const report: Record<string, unknown> = {};
  for (const src of SOURCES) {
    const q = `${src.query} newer_than:${window}`;
    const listRes = await fetch(api(`messages?q=${encodeURIComponent(q)}&maxResults=50`), { headers: auth });
    if (!listRes.ok) { report[src.key] = { error: `Gmail search failed (${listRes.status})` }; continue; }
    const ids: string[] = ((await listRes.json()).messages ?? []).map((m: { id: string }) => m.id);
    if (!ids.length) { report[src.key] = { found: 0 }; continue; }

    const { data: seenRows } = await sb.from("lead_imports").select("message_id").in("message_id", ids);
    const seen = new Set((seenRows ?? []).map((r: { message_id: string }) => r.message_id));
    const fresh = ids.filter((id) => !seen.has(id));

    if (opts.seed) {
      if (fresh.length) await sb.from("lead_imports").insert(fresh.map((id) => ({ message_id: id, source: src.key, status: "pre-existing" })));
      report[src.key] = { seeded: fresh.length };
      continue;
    }

    const results: unknown[] = [];
    // Oldest first, so tasks and notifications come out in the order the leads arrived.
    for (const id of fresh.reverse()) {
      const msg = await fetchMsg(id);
      if (!msg) { results.push({ id, error: "fetch failed" }); continue; }
      const subject = header(msg.payload?.headers, "Subject");
      const lead = src.parse(subject, msg.payload);
      const siteName = src.key === "thebash" ? "The Bash" : "GigSalad";

      if (opts.dry) { results.push({ id, subject, lead, listing: lead ? await resolveLink(lead) : null }); continue; }

      if (!lead) {
        await sb.from("lead_imports").insert({ message_id: id, source: src.key, status: "unparsed", parsed: { subject } });
        await pushAndNotify(sb, `${siteName} lead needs a look`, `A new ${siteName} lead came in but could not be read automatically. Check your email.`, `${src.key}-unparsed`, id);
        results.push({ id, status: "unparsed" });
        continue;
      }
      // Claim the email BEFORE creating anything, so two overlapping runs cannot both import it.
      const { error: claimErr } = await sb.from("lead_imports").insert({ message_id: id, source: src.key, status: "claimed", parsed: lead });
      if (claimErr) { results.push({ id, status: "already-claimed" }); continue; }

      const projectId = await createProject(sb, lead, id);
      await sb.from("lead_imports").update({ status: projectId ? "imported" : "failed", project_id: projectId }).eq("message_id", id);
      if (projectId) {
        const who = lead.firstName ? `${lead.firstName}: ` : "";
        const where = lead.city ? ` in ${lead.city}` : "";
        const pushed = await pushAndNotify(sb, `New ${lead.site} lead!`, `${who}${lead.eventType || "Event"}${where}, ${writtenDate(lead.eventDate)}.`, projectId, id);
        results.push({ id, status: "imported", projectId, pushed });
      } else {
        results.push({ id, status: "failed" });
      }
    }
    report[src.key] = { found: ids.length, fresh: fresh.length, results };
  }
  return json({ ok: true, ...report });
});
