// Client proposal page endpoint (always-on).
//
// After a sales call Michael sends one link instead of a wall of text and a 10 MB PDF. The client
// opens michaelbloemeke.com/proposal/?t=<token>, this function hands the page its content, and the
// page renders it. No file size, forwards perfectly, and Michael finds out it was opened.
//
// This is the same shape as the booking endpoint next door:
//   - The token in the URL is the ONLY credential. Unguessable, one per project, checked against
//     proposals.token. An unknown token renders the friendly expired page and writes nothing.
//   - GET only. The client never writes anything here. There is no form on the proposal page.
//   - The response is a WHITELIST, built field by field below. Nothing internal ever leaves this
//     function: no pricing tiers, no project notes, no activity log, no mileage, no other clients.
//     If a field is not named here, the page cannot render it even by accident.
//   - CORS is open because the page is on a different origin (the website) than Supabase.
//
// LIFECYCLE. A proposal is reachable only while status = 'live', the project is still in the active
// or completed bucket, and expires_at (if set) has not passed. Anything else returns
// { ok: false, expired: true } and the page says "this proposal has expired, get in touch" rather
// than 404ing at someone who may well still want to book.
//
// ANALYTICS. Every GET that resolves to a live proposal bumps view_count and stamps last_viewed_at.
// The FIRST view also drops a bell notification + phone push, because that is the moment Michael
// actually wants to know about. Counting every view (not every viewer) is deliberate: the forwarded
// view, from the spouse or the boss who was not on the call, is the one that decides the booking.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import * as webpush from "jsr:@negrel/webpush@0.5.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, apikey, authorization",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const validToken = (t: string) => !!t && t.length <= 100 && !/[^A-Za-z0-9_-]/.test(t);

const db = () =>
  createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
//
// House rules for anything a person reads: dates written out in full, times in 12-hour with AM/PM,
// never bare ISO and never 24-hour. Mirrors prettyDate/prettyTime in the booking function.

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function ordinal(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] || "th"}`;
}

function prettyDate(v: unknown): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v ?? "").trim());
  if (!m) return String(v ?? "").trim();
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return String(v ?? "").trim();
  return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${ordinal(d.getDate())}, ${d.getFullYear()}`;
}

// Times are 12-hour with AM/PM, never 24-hour. But this reads project fields Michael fills in by
// hand, not a <time> input, so a bare "6:00" genuinely could be either. The booking form can assume
// 24-hour because a time input always posts it that way; this cannot.
//
// So: convert only when the value proves itself. "18:00" is unambiguous. "6:00 pm" already says so.
// A bare "6:00" is passed through untouched, because printing "6:00 AM" on a client's proposal for a
// 6 PM wedding would be this page stating a fact that is not true. Anything ambiguous is caught
// before publishing instead (see ambiguousTime in crm-proposals.mjs).
function prettyTime(v: unknown): string {
  const raw = String(v ?? "").trim();

  const withSuffix = /^(\d{1,2}):(\d{2})\s*([ap])\.?m\.?$/i.exec(raw);
  if (withSuffix) return `${Number(withSuffix[1])}:${withSuffix[2]} ${withSuffix[3].toUpperCase()}M`;

  const bare = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (bare) {
    const h = Number(bare[1]);
    if (h === 0) return `12:${bare[2]} AM`;
    if (h >= 13) return `${h - 12}:${bare[2]} PM`;
    if (h === 12) return `12:${bare[2]} PM`;
    return raw; // 1:00 through 11:59 could be either. Say what is on file, nothing more.
  }

  return raw;
}

const clean = (v: unknown): string => String(v ?? "").trim();

// The first name only. contact_names holds whoever Michael is dealing with, sometimes more than one
// ("Sarah and Jake"), so this takes the first word of the first name and nothing else. Greeting a
// client by their surname would read like a form letter, which is the exact opposite of the point.
function firstName(contactNames: unknown): string {
  const first = clean(contactNames).split(/\s*(?:,|;|\band\b|&)\s*/i)[0] || "";
  return first.split(/\s+/)[0] || "";
}

// Event type as a client would say it. Anything Michael has typed by hand passes through as-is.
const TYPE_LABELS: Record<string, string> = {
  wedding: "Wedding",
  corporate: "Corporate event",
  "holiday-party": "Holiday party",
  bachelorette: "Bachelorette party",
  birthday: "Birthday party",
  private: "Private party",
  gala: "Gala",
  fundraiser: "Fundraiser",
};

function typeLabel(v: unknown): string {
  const raw = clean(v);
  if (!raw) return "";
  return TYPE_LABELS[raw.toLowerCase().replace(/\s+/g, "-")] || raw;
}

// ---------------------------------------------------------------------------
// The whitelist
// ---------------------------------------------------------------------------
//
// Section 2 of the page mirrors back what Michael has on file, so the client can silently correct
// anything wrong before it becomes a problem on the day. Only these fields, only when they have a
// real value. A blank field is dropped entirely rather than rendered empty, so the section never
// advertises what Michael failed to write down.
type Row = { label: string; value: string };

function eventRows(p: Record<string, unknown>): Row[] {
  const rows: Row[] = [
    { label: "Event", value: typeLabel(p.event_type) },
    { label: "Date", value: prettyDate(p.event_date) },
    { label: "Venue", value: clean(p.event_location) },
    { label: "Event starts", value: prettyTime(p.event_start_time) },
    { label: "Magic starts", value: prettyTime(p.show_start_time) },
    { label: "Guests", value: clean(p.number_of_guests) },
    { label: "Guest ages", value: clean(p.age_of_guests) },
  ];
  return rows.filter((r) => r.value);
}

// Package shape, normalised so a half-filled row in the CRM can never render as a broken card.
// `price` stays a string: Michael writes the number the way he wants it read, and it is always a
// flat figure. Travel is never itemized and distance is never mentioned.
function normalisePackages(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 3).map((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    return {
      name: clean(o.name),
      tagline: clean(o.tagline),
      price: clean(o.price),
      duration: clean(o.duration),
      includes: Array.isArray(o.includes) ? o.includes.map(clean).filter(Boolean) : [],
      recommended: o.recommended === true,
    };
  }).filter((p) => p.name);
}

// Real reviews only, verbatim, with the reviewer's name. Nothing is generated here.
function normaliseReviews(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 5).map((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    return { name: clean(o.name), text: clean(o.text) };
  }).filter((r) => r.text);
}

// Site-relative image paths only. An absolute URL here would let a bad row in the CRM point the
// page at some other host, so anything that is not a plain /assets/... path is dropped.
function safePhoto(v: unknown): string {
  const s = clean(v);
  return /^\/assets\/[A-Za-z0-9/._-]+$/.test(s) ? s : "";
}

function normalisePhotos(raw: unknown): Record<string, unknown> {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    hero: safePhoto(o.hero),
    format: safePhoto(o.format),
    portrait: safePhoto(o.portrait),
    gallery: (Array.isArray(o.gallery) ? o.gallery : []).map(safePhoto).filter(Boolean).slice(0, 4),
  };
}

// A YouTube id, or nothing. Anything else would end up in an iframe src.
function safeVideoId(v: unknown): string {
  const s = clean(v);
  return /^[A-Za-z0-9_-]{6,20}$/.test(s) ? s : "";
}

// ---------------------------------------------------------------------------
// "It was opened"
// ---------------------------------------------------------------------------

// notifications.id shape, matching crm-notifications.newId and the inquiry function.
function newNotificationId(): string {
  return "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function vapidKeysToJwk(pub: string, priv: string) {
  const b64 = (s: string) => s.replace(/-/g, "+").replace(/_/g, "/");
  const raw = Uint8Array.from(atob(b64(pub)), (c) => c.charCodeAt(0));
  const x = btoa(String.fromCharCode(...raw.slice(1, 33))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const y = btoa(String.fromCharCode(...raw.slice(33, 65))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return {
    publicKey: { kty: "EC", crv: "P-256", x, y, ext: true },
    privateKey: { kty: "EC", crv: "P-256", x, y, d: priv, ext: true },
  };
}

// Best-effort, and deliberately so: a push that fails must never stop a client seeing their proposal.
async function announceFirstView(sb: ReturnType<typeof db>, projectId: string, client: string) {
  try {
    await sb.from("notifications").insert({
      id: newNotificationId(),
      project_id: projectId,
      kind: "proposal-viewed",
      source_id: projectId,
      seen: false,
      created_at: new Date().toISOString(),
    });
  } catch (e) {
    console.warn("[proposal] notification insert failed:", e instanceof Error ? e.message : String(e));
  }

  try {
    const { data: cfg } = await sb.from("push_config").select("*").eq("id", 1).maybeSingle();
    const { data: subs } = await sb.from("push_subscriptions").select("*");
    if (!cfg?.vapid_public || !cfg?.vapid_private || !subs?.length) return;

    const { count } = await sb.from("notifications").select("id", { count: "exact", head: true }).eq("seen", false);
    const vapidKeys = await webpush.importVapidKeys(
      vapidKeysToJwk(cfg.vapid_public, cfg.vapid_private),
      { extractable: false },
    );
    const appServer = await webpush.ApplicationServer.new({
      contactInformation: cfg.vapid_subject || "mailto:mchlbloemeke@gmail.com",
      vapidKeys,
    });
    const payload = JSON.stringify({
      title: "Proposal opened",
      body: client ? `${client} just opened their proposal.` : "A client just opened their proposal.",
      url: cfg.app_url,
      tag: "proposal-viewed",
      count: count ?? 0,
    });
    const dead: string[] = [];
    await Promise.all((subs as Record<string, string>[]).map(async (s) => {
      try {
        const sub = appServer.subscribe({ endpoint: s.endpoint, keys: { auth: s.auth, p256dh: s.p256dh } });
        await sub.pushTextMessage(payload, {});
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/40[48]/.test(msg)) dead.push(s.endpoint);
      }
    }));
    if (dead.length) await sb.from("push_subscriptions").delete().in("endpoint", dead);
  } catch (e) {
    console.warn("[proposal] push failed:", e instanceof Error ? e.message : String(e));
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

const EXPIRED = { ok: false, expired: true };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const token = clean(new URL(req.url).searchParams.get("token"));
  // An invalid token is answered exactly like an expired one. Nothing here should ever help someone
  // work out whether a token they guessed was close.
  if (!validToken(token)) return json(EXPIRED);

  const sb = db();

  const { data: prop, error } = await sb.from("proposals").select("*").eq("token", token).maybeSingle();
  if (error) {
    console.error("[proposal] lookup failed:", error.message);
    return json({ error: "Something went wrong" }, 500);
  }
  if (!prop || prop.status !== "live") return json(EXPIRED);
  if (prop.expires_at && Date.parse(prop.expires_at) < Date.now()) return json(EXPIRED);

  const { data: project } = await sb
    .from("projects")
    .select(
      "id, client_name, contact_names, event_type, event_date, event_location, " +
        "event_start_time, show_start_time, number_of_guests, age_of_guests, event_summary, bucket",
    )
    .eq("id", prop.project_id)
    .maybeSingle();

  // The page comes down when the deal leaves the pipeline. Completed stays up: a completed client is
  // a happy client who may want to look back at what they booked, and there are few of them.
  if (!project || (project.bucket !== "active" && project.bucket !== "completed")) return json(EXPIRED);

  const name = firstName(project.contact_names) || firstName(project.client_name);

  const body = {
    ok: true,
    client: { firstName: name },
    // Michael's own wording for the event, when the computed "Your <type> at <venue>" would get it
    // wrong. Blank means the page builds its own.
    headline: clean(prop.headline),
    event: {
      typeLabel: typeLabel(project.event_type),
      dateLong: prettyDate(project.event_date),
      venue: clean(project.event_location),
      // The prose write-up of the event, as Michael took it down on the call. Never the internal
      // project notes, which are a different column and are not client-facing.
      summary: clean(project.event_summary),
      rows: eventRows(project as Record<string, unknown>),
    },
    heroLine: clean(prop.hero_line),
    // Blank lines separate paragraphs, so Michael can write it the way he would write an email.
    recommendation: clean(prop.recommendation).split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean),
    packages: normalisePackages(prop.packages),
    reviews: normaliseReviews(prop.reviews),
    photos: normalisePhotos(prop.photos),
    videoId: safeVideoId(prop.video_id),
  };

  // Stamp the view after the response is assembled, so a bookkeeping failure can never cost the
  // client their page. The first view is the one worth interrupting Michael for.
  const isFirst = !prop.first_viewed_at;
  const now = new Date().toISOString();
  sb.from("proposals")
    .update({
      view_count: (prop.view_count ?? 0) + 1,
      first_viewed_at: prop.first_viewed_at ?? now,
      last_viewed_at: now,
    })
    .eq("project_id", prop.project_id)
    .then(() => {
      if (isFirst) return announceFirstView(sb, prop.project_id, name);
    })
    .catch((e: unknown) => {
      console.warn("[proposal] view stamp failed:", e instanceof Error ? e.message : String(e));
    });

  return json(body);
});
