// Booking-form + agreement-signing endpoint (always-on).
//
// The client does the whole booking in one sitting on michaelbloemeke.com:
//
//   step 1  they fill in the event details            -> POST { token, answers }
//   step 2  they read the agreement, tick the box,
//           type their name, and submit                -> POST { token, action: "sign", ... }
//   step 3  thank you; the CRM emails them the PDF
//
// WHERE THE AGREEMENT COMES FROM. This function does not know how to write a contract, and should
// not. When Michael clicks "Ready to book", the CRM renders the agreement and stores it on
// `projects.agreement_html`. Everything internal (the fee, the performance scope, his name) is
// already filled in at that point. The facts only the CLIENT can supply are left behind as marker
// spans, exactly as the CRM's own renderer emits them:
//
//   <span class="cf cf-missing" data-f="event_date">[Event date]</span>
//
// So all this function does is swap the contents of those spans for the client's own answers. Every
// bit of contract logic stays in one place (the CRM, in Node), and this stays dumb string work.
//
// SECURITY SHAPE, deliberately narrow:
//   - The token in the URL is the ONLY credential. Unguessable, issued per project, and checked
//     against projects.booking_token. An unknown token writes nothing.
//   - The client can never write agreement_html. They supply answers and a typed name; that is all.
//   - Every client-supplied value is HTML-escaped before it goes anywhere near the agreement markup,
//     because the page renders that markup with innerHTML.
//   - GET returns progress state, the event date, and THEIR OWN answers, so someone who closes the
//     tab can pick up where they left off and can go back to correct a detail. The token is the
//     credential either way, so handing a client their own submission back is not a widening.
//   - CORS is open because the form is on a different origin (the website) than Supabase.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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
// House rules for anything a person READS: dates written out, times in 12-hour. A date input posts
// "2026-11-14" and a time input posts "18:00", so both are converted here.
//
// ⚠️ This mirrors displayValue()/prettyDate()/prettyTime() in the CRM's crm-booking-form.mjs. The two
// must agree, or the agreement on screen would read differently from the project record and the PDF.
// crm-booking-form.test.mjs asserts they match.

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function ordinal(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] || "th"}`;
}

function prettyDate(v: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v).trim());
  if (!m) return String(v).trim();
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return String(v).trim();
  return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${ordinal(d.getDate())}, ${d.getFullYear()}`;
}

function prettyTime(v: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v).trim());
  if (!m) return String(v).trim();
  let h = Number(m[1]);
  const suffix = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m[2]} ${suffix}`;
}

// The questions, mirroring BOOKING_FIELDS in crm-booking-form.mjs (a test enforces the match).
// `type` drives display formatting; `contractKey` is the agreement marker this answer fills, when
// the agreement mentions that fact at all.
const FIELDS: { id: string; label: string; type: string; contractKey?: string }[] = [
  { id: "event_summary", label: "Basic description of the event", type: "textarea" },
  { id: "event_start_time", label: "Event start time", type: "time", contractKey: "event_start_time" },
  { id: "show_start_time", label: "Show start time", type: "time", contractKey: "show_start_time" },
  { id: "av", label: "For a stage show, what AV is available at the venue (sound system, projector/screen, etc)?", type: "textarea" },
  { id: "number_of_guests", label: "Number of guests", type: "text" },
  { id: "venue_address", label: "Venue address", type: "textarea", contractKey: "event_location" },
  { id: "venue_type", label: "Venue type", type: "text", contractKey: "venue_type" },
  { id: "indoors_or_outdoors", label: "Indoor or outdoor", type: "select", contractKey: "indoors_or_outdoors" },
  { id: "age_of_guests", label: "Ages of the guests", type: "text" },
  { id: "vips", label: "Any VIPs that Michael should give special attention to?", type: "textarea" },
  { id: "invoice_to", label: "What name should be on the invoice?", type: "text" },
  { id: "unforgettable", label: "How can Michael make your event unforgettable?", type: "textarea" },
  { id: "notes", label: "Any other details Michael should know about the event?", type: "textarea" },
];

function displayValue(type: string, raw: unknown): string {
  const v = String(raw ?? "").trim();
  if (!v) return "";
  if (type === "date") return prettyDate(v);
  if (type === "time") return prettyTime(v);
  return v;
}

function escapeHtml(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)
  );
}

// ---------------------------------------------------------------------------
// The form <-> project MIRROR (Michael, 2026-10-14)
// ---------------------------------------------------------------------------
//
// "I want the booking form and the project details to basically mirror each other." Both ways:
//
//   PROJECT -> FORM. The form always opens on what is in the project RIGHT NOW. Before they submit,
//   that is the prefill (it always was). After they submit and before they sign, it used to be their
//   OWN saved answers, so an edit Michael made in the meantime never reached the form. Now the
//   project wins for every mirrored question, because the project already holds their answers (see
//   below) and anything different there is an edit he made since.
//
//   FORM -> PROJECT. The moment they submit, every answer is written onto the project. This used to
//   be the Mac's job (pullSubmission in crm-booking-form.mjs), run by a sweep that was retired when
//   the booking chain moved to the cloud on 2026-08-03, so from then on nothing ever did it. Monica
//   Andrade's and Anna Leonard's answers had to be copied in by hand on 2026-10-13. Doing it HERE,
//   in the function that receives the answers, needs no laptop and cannot be missed.
//
// Once they SIGN, the agreement is frozen and none of this applies: the booking_submissions row is
// the record of what they agreed to, and a later edit to the project does not rewrite it.
//
// The live AGREEMENT follows the project too: the booking fee and the performance scope are re-read
// from the project on every load (they were baked in when the link was issued), so the agreement can
// never quote a different number from the one stated at the top of the same page.

// Form question -> projects column. Mirrors the `key`s on BOOKING_FIELDS in crm-booking-form.mjs.
// invoice_to has no project column, and the two free-text questions append to project_notes.
const MIRROR: Record<string, string> = {
  event_summary: "event_summary",
  event_start_time: "event_start_time",
  show_start_time: "show_start_time",
  number_of_guests: "number_of_guests",
  age_of_guests: "age_of_guests",
  venue_address: "event_location",
  venue_type: "venue_type",
  indoors_or_outdoors: "indoors_or_outdoors",
  av: "av",
  vips: "vips",
};
const NOTE_IDS = ["unforgettable", "notes"];
const MIRROR_COLUMNS = Object.values(MIRROR).join(", ");

// <input type="time"> only accepts 24-hour "HH:MM", and the project stores "7:00 PM". Mirrors to24h()
// in Website/book/index.html.
function to24h(v: string): string {
  const s = String(v ?? "").trim();
  let m = /^(\d{1,2})(?::(\d{2}))?\s*([AaPp])\.?[Mm]\.?$/.exec(s);
  if (m) {
    let h = Number(m[1]) % 12;
    if (m[3].toLowerCase() === "p") h += 12;
    return String(h).padStart(2, "0") + ":" + (m[2] || "00");
  }
  m = /^(\d{1,2}):(\d{2})/.exec(s);
  return m ? String(Number(m[1])).padStart(2, "0") + ":" + m[2] : "";
}

// Their saved answers, with every mirrored question replaced by what the project says now.
function mirrorAnswers(answers: { id: string; value: string }[], project: Record<string, unknown>) {
  const out = new Map(answers.map((a) => [a.id, a.value]));
  for (const f of FIELDS) {
    const col = MIRROR[f.id];
    if (!col) continue;
    const v = String(project[col] ?? "").trim();
    if (!v) continue;
    if (f.type === "time") {
      // A time box can only hold a clock time. When the project field holds a note instead ("Space
      // booked 5:00 PM to 11:00 PM..."), keep their own answer rather than blanking the box.
      const t = to24h(v);
      if (t) out.set(f.id, t);
      continue;
    }
    out.set(f.id, v);
  }
  return [...out.entries()].map(([id, value]) => ({ id, value }));
}

// The note block their free-text answers become in project_notes. Same shape the Mac used
// ("<question>\n<answer>", blocks separated by a blank line), so old and new read alike.
function noteBlock(answers: { id: string; value: string }[]): string {
  const byId = new Map(answers.map((a) => [a.id, String(a.value ?? "").trim()]));
  return FIELDS.filter((f) => NOTE_IDS.includes(f.id) && byId.get(f.id))
    .map((f) => `${f.label}\n${byId.get(f.id)}`)
    .join("\n\n");
}

function easternStamp(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value || 0);
  return `${MONTHS[get("month") - 1]} ${get("day")}, ${get("year")}`;
}

// Write their answers onto the project. Best-effort by design: the answers are already safe in
// booking_submissions, so a failure here is logged and never costs the client their form.
// deno-lint-ignore no-explicit-any
async function writeAnswersToProject(sb: any, projectId: string, answers: { id: string; value: string }[], previous: { id: string; value: string }[] | null) {
  const { data: proj, error } = await sb
    .from("projects")
    .select("project_notes, activity_log")
    .eq("id", projectId)
    .maybeSingle();
  if (error || !proj) throw new Error(error?.message || "project not found");

  const byId = new Map(answers.map((a) => [a.id, String(a.value ?? "").trim()]));
  const update: Record<string, unknown> = {};
  const filled: string[] = [];
  for (const f of FIELDS) {
    const col = MIRROR[f.id];
    const v = byId.get(f.id);
    if (!col || !v) continue;
    // Times are stored the way the CRM shows them ("7:00 PM"); everything else as typed.
    update[col] = f.type === "time" ? prettyTime(v) : v;
    filled.push(f.label);
  }

  // Their free-text answers go INTO the notes, never over Michael's own. On a resubmission the block
  // they wrote last time is swapped for the new one rather than stacked under it.
  const before = String(proj.project_notes ?? "");
  let notes = before;
  const oldBlock = previous ? noteBlock(previous) : "";
  const newBlock = noteBlock(answers);
  if (oldBlock && notes.includes(oldBlock)) notes = notes.replace(oldBlock, newBlock);
  else if (newBlock && !notes.includes(newBlock)) notes = notes.trim() ? `${notes.trimEnd()}\n\n${newBlock}` : newBlock;
  notes = notes.replace(/\n{3,}/g, "\n\n").trim();
  if (notes !== before.trim()) {
    update.project_notes = notes;
    filled.push("Notes");
  }

  // One short line. The full list of questions read like a machine log (see crm-notes-writing-rules).
  const line = `${easternStamp(new Date())}: ${previous ? "Client updated the booking form" : "Client submitted the booking form"}${filled.length ? ", and Event details were updated from it" : ""}.`;
  const log = Array.isArray(proj.activity_log) ? proj.activity_log : [];
  update.activity_log = [line, ...log];

  const { error: upErr } = await sb.from("projects").update(update).eq("id", projectId);
  if (upErr) throw new Error(upErr.message);
}

// ---------------------------------------------------------------------------
// Filling the agreement
// ---------------------------------------------------------------------------

// Swap the contents of <span ... data-f="KEY" ...>…</span> for `value`.
//
// The span never contains nested markup (the CRM sets it via textContent), so matching up to the
// next "<" is safe and avoids needing a DOM parser in Deno. The replacement is escaped, and is
// passed as a FUNCTION so a "$" or "$&" in a client's answer can't act as a replacement pattern.
function fillMarker(html: string, key: string, value: string): string {
  const re = new RegExp(`<span[^>]*data-f="${key}"[^>]*>[^<]*</span>`, "g");
  const out = `<span class="cf" data-f="${key}">${escapeHtml(value)}</span>`;
  return html.replace(re, () => out);
}

// Render the stored agreement against a set of answers, and build the summary rows shown above it.
function buildAgreement(
  agreementHtml: string,
  answers: { id: string; value: string }[],
  eventDateISO = "",
  live: { fee?: string; scope?: string } = {},
) {
  const byId = new Map(answers.map((a) => [a.id, a.value]));
  let html = String(agreementHtml || "");
  const summary: { label: string; value: string }[] = [];

  // Michael's own facts, re-read from the project on every load so a quote or performance change made
  // after the link went out reaches the agreement too. Left as issued when the project field is blank.
  if (live.fee) html = fillMarker(html, "booking_fee", live.fee);
  if (live.scope) html = fillMarker(html, "services_description", live.scope);

  // The event date is NOT one of the questions: Michael does not want a client to think the date is
  // theirs to change on this form. It comes off the project, is shown to them read-only, and is
  // filled into the agreement from here.
  const prettyEventDate = prettyDate(eventDateISO);
  if (prettyEventDate) {
    summary.push({ label: "Event date", value: prettyEventDate });
    html = fillMarker(html, "event_date", prettyEventDate);
  }

  for (const f of FIELDS) {
    const raw = byId.get(f.id);
    const shown = displayValue(f.type, raw);
    if (!shown) continue;
    summary.push({ label: f.label, value: shown });
    if (f.contractKey) html = fillMarker(html, f.contractKey, shown);
  }
  return { html, summary };
}

// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const url = new URL(req.url);
  const sb = db();

  // --- Where is this client up to? (lets them resume if they closed the tab) ---
  //
  // Also the VIEW ping. This fires on every page load, so the first one with a valid token is the
  // moment the link reached a human. Recording it is what lets the CRM show a live status instead of
  // asking Michael to press a button and find out.
  if (req.method === "GET") {
    // THE SAMPLE FORM, for the CRM's Proposals page. No token, no project, nothing written.
    //
    // It exists so Michael can see what a client actually receives without opening somebody's real
    // form and inflating their view count. The agreement it shows is the UNFILLED contract template
    // straight out of contract_templates, which is the same wording every real agreement is built
    // from, so the sample can never drift away from the thing being sampled.
    if (url.searchParams.get("demo") === "1") {
      const { data: tpl } = await sb
        .from("contract_templates")
        .select("html")
        .eq("variant", "standard")
        .maybeSingle();
      return json({
        demo: true,
        eventDate: "Saturday, June 13, 2026",
        performanceStyle: "The formal show",
        quote: "$1,500",
        answers: [],
        prefill: {},
        signed: false,
        submitted: false,
        // Same SHAPE the real flow returns ({ summary, html }), so the page's own renderAgreement
        // handles it with no demo-specific branch. The summary is filled in client side from
        // whatever Michael typed into the sample form.
        agreement: { summary: [], html: String(tpl?.html || "") },
      });
    }

    const token = (url.searchParams.get("token") || "").trim();
    // Michael opening a client's own form to check it. Renders identically, stamps nothing, so
    // "opened 3 times" always means the CLIENT. Same flag and same reasoning as the proposal page.
    const preview = url.searchParams.get("preview") === "1";
    if (!validToken(token)) return json({ error: "Invalid link." }, 400);

    const { data: project, error: projErr } = await sb
      .from("projects")
      .select(
        "id, agreement_html, booking_viewed_at, booking_view_count, event_date, performance_style, " +
          "total_fee, total_fee_text, " +
          "event_summary, event_start_time, show_start_time, av, number_of_guests, " +
          "event_location, venue_type, indoors_or_outdoors, age_of_guests, vips, contact_names",
      )
      .eq("booking_token", token)
      .maybeSingle();
    if (projErr) return json({ error: "Lookup failed." }, 500);
    if (!project) return json({ error: "This link is no longer valid." }, 404);

    // TWO different facts, kept in two columns on purpose.
    //
    // booking_viewed_at answers "did this ever reach a human" and is stamped ONCE, guarded by the
    // .is() so a second load cannot overwrite it. Overwriting it would quietly destroy the signal.
    //
    // booking_view_count and booking_last_viewed_at answer "how often are they going back to it",
    // which is what the Proposals page reads. Every load counts, including a forward to the spouse
    // or the boss, exactly like the proposal page's own counter.
    //
    // Bookkeeping never blocks the client: a failure here must not cost them their form, so the
    // update is fired and its error only logged.
    if (!preview) {
      const now = new Date().toISOString();
      if (!project.booking_viewed_at) {
        await sb
          .from("projects")
          .update({ booking_viewed_at: now })
          .eq("id", project.id)
          .is("booking_viewed_at", null);
      }
      sb.from("projects")
        .update({
          booking_view_count: (project.booking_view_count ?? 0) + 1,
          booking_last_viewed_at: now,
        })
        .eq("id", project.id)
        .then(({ error }) => {
          if (error) console.warn("[booking] view stamp failed:", error.message);
        });
    }

    const { data: row, error } = await sb
      .from("booking_submissions")
      .select("answers, signed_at")
      .eq("token", token)
      .maybeSingle();
    if (error) return json({ error: "Lookup failed." }, 500);
    // The date and the performance style are STATED back to them, never asked: they are what Michael
    // quoted and what the agreement says, so the client seeing a different number is the whole
    // problem. Both go out on every step, even before they have submitted.
    const eventDate = prettyDate(String(project.event_date || ""));
    const performanceStyle = String(project.performance_style || "").trim();
    // The QUOTE, stated back to them alongside the date and the style (Michael, 2026-10-07):
    // "I want the quote included there as well. I don't want the client to have the option to edit
    // the quote, but I want it listed at the top so they can see it."
    //
    // This is the BOOKING FEE, the same figure the agreement's fee clause carries, NOT the invoice
    // total. The 3% card fee rides on top as its own line on the QuickBooks invoice and is waived
    // when they pay another way, so adding it here would state a number they may never be charged.
    //
    // Number first, text companion second, matching every other reader of this pair: they are meant
    // to be mutually exclusive, and when both are filled the number is the real one. Formatted the
    // same way `contractMoney` formats it for the agreement, so the two cannot disagree.
    const feeNum = Number(project.total_fee);
    const quote = Number.isFinite(feeNum) && feeNum > 0
      ? "$" + Math.round(feeNum).toLocaleString("en-US")
      : String(project.total_fee_text ?? "").trim();

    // What Michael already has on file, so the client reads it back and corrects it rather than
    // typing everything from scratch. Every one of these stays editable on the form; only the date
    // and the performance style above are read-only.
    const prefill: Record<string, string> = {};
    const put = (id: string, v: unknown) => {
      const s = String(v ?? "").trim();
      if (s) prefill[id] = s;
    };
    put("event_summary", project.event_summary);
    put("event_start_time", project.event_start_time);
    put("show_start_time", project.show_start_time);
    put("av", project.av);
    put("number_of_guests", project.number_of_guests);
    put("venue_address", project.event_location);
    put("venue_type", project.venue_type);
    put("indoors_or_outdoors", project.indoors_or_outdoors);
    put("age_of_guests", project.age_of_guests);
    put("vips", project.vips);
    // ⚠️ "invoice_to" IS DELIBERATELY NOT PREFILLED (Michael, 2026-09-28). It used to be seeded from
    // project.contact_names as a typing saver, and the result was that clients skimmed past it and
    // signed whatever was already there. The name on this field prints on the invoice and on the
    // contract, so it has to be a deliberate answer, not an accepted default. Leave it blank.
    // "unforgettable" and "notes" are deliberately NOT prefilled. They append to Michael's project
    // notes, so seeding them with his own notes would show the client his internal remarks and then
    // append them back onto themselves.

    const base = { eventDate, performanceStyle, quote, prefill };
    if (!row) return json({ submitted: false, signed: false, ...base });
    if (row.signed_at) return json({ submitted: true, signed: true, ...base });

    // Their own answers, behind their own token, so they can go back and correct something rather
    // than being cornered into signing a detail they spotted was wrong. Every mirrored question reads
    // what the PROJECT says now (see "The form <-> project MIRROR" above), which is their answer
    // unless Michael has edited it since.
    const answers = mirrorAnswers(Array.isArray(row.answers) ? row.answers : [], project);
    if (!project.agreement_html) return json({ submitted: true, signed: false, ...base, answers });
    return json({
      submitted: true,
      signed: false,
      ...base,
      answers,
      agreement: buildAgreement(project.agreement_html, answers, String(project.event_date || ""), {
        fee: quote.startsWith("$") ? quote : "",
        scope: performanceStyle,
      }),
    });
  }

  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Bad request." }, 400);
  }

  // Honeypot: bots fill hidden fields. Pretend success so they don't retry.
  if (body?._hp) return json({ ok: true });

  const token = String(body?.token || "").trim();
  if (!validToken(token)) return json({ error: "Invalid link." }, 400);

  // The token must belong to a real project. The CRM stamps it on when it issues the link, which is
  // what makes this safe to expose: an unknown token writes nothing.
  const { data: project, error: lookupErr } = await sb
    .from("projects")
    .select("id, agreement_html, event_date, total_fee, performance_style")
    .eq("booking_token", token)
    .maybeSingle();
  if (lookupErr) return json({ error: "Lookup failed." }, 500);
  if (!project) return json({ error: "This link is no longer valid." }, 404);

  // =========================================================================
  // Step 2: they signed the agreement
  // =========================================================================
  if (String(body?.action || "") === "sign") {
    const name = String(body?.name || "").trim().slice(0, 200);
    const agreed = body?.agreed === true;
    if (!agreed) return json({ error: "Please tick the box to confirm you approve the agreement." }, 400);
    if (name.length < 2) return json({ error: "Please type your full name." }, 400);

    const { data: existing, error: exErr } = await sb
      .from("booking_submissions")
      .select("project_id, signed_at")
      .eq("token", token)
      .maybeSingle();
    if (exErr) return json({ error: "Lookup failed." }, 500);
    if (!existing) return json({ error: "Fill in your event details first." }, 400);
    // Already signed: succeed quietly rather than overwrite the original record. The first signature
    // is the one that counts, and a double-tap on a slow connection must not rewrite it.
    if (existing.signed_at) return json({ ok: true, alreadySigned: true });

    const now = new Date();
    const { error: signErr } = await sb
      .from("booking_submissions")
      .update({
        signed_name: name,
        // What they saw on screen as the date. Their own typed date wins if they changed it.
        signed_date: String(body?.date || "").trim().slice(0, 60) || now.toISOString().slice(0, 10),
        signed_at: now.toISOString(),
        // For the audit trail on the PDF. Best-effort: behind Cloudflare these headers are normal.
        signer_ip: (req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "")
          .split(",")[0].trim().slice(0, 60),
        signer_agent: (req.headers.get("user-agent") || "").slice(0, 300),
        seen: false,
      })
      .eq("token", token);
    if (signErr) return json({ error: "Could not record your signature." }, 500);

    return json({ ok: true });
  }

  // =========================================================================
  // Step 1: they filled in the event details
  // =========================================================================
  const answers = Array.isArray(body?.answers)
    ? (body.answers as unknown[]).slice(0, 50).map((a) => {
      const o = a as Record<string, unknown>;
      return {
        id: String(o?.id ?? "").slice(0, 100),
        value: String(o?.value ?? "").slice(0, 5000),
      };
    }).filter((a) => a.id)
    : [];
  if (!answers.length) return json({ error: "Nothing was filled in." }, 400);

  // What they sent LAST time, if anything: needed to swap their old note block for the new one, and
  // to refuse a resubmission once the agreement is signed (the signed record must never change).
  const { data: prior } = await sb
    .from("booking_submissions")
    .select("answers, signed_at")
    .eq("token", token)
    .maybeSingle();
  if (prior?.signed_at) return json({ error: "This agreement has already been signed." }, 409);

  const { error: writeErr } = await sb.from("booking_submissions").upsert(
    {
      project_id: project.id,
      token,
      answers,
      submitted_at: new Date().toISOString(),
      seen: false,
    },
    { onConflict: "project_id" },
  );
  if (writeErr) return json({ error: "Could not save your answers." }, 500);

  // FORM -> PROJECT. Their answers become the project's details right now.
  try {
    await writeAnswersToProject(sb, project.id, answers, Array.isArray(prior?.answers) ? prior.answers : null);
  } catch (e) {
    console.warn("[booking] could not copy answers onto the project:", e instanceof Error ? e.message : String(e));
  }

  // Hand back the agreement so the page can move straight on to signing. If Michael's CRM never
  // stored one, the answers are still safely saved; the page just thanks them and he follows up.
  if (!project.agreement_html) return json({ ok: true, agreement: null });
  const feeNum = Number(project.total_fee);
  return json({
    ok: true,
    agreement: buildAgreement(project.agreement_html, answers, String(project.event_date || ""), {
      fee: Number.isFinite(feeNum) && feeNum > 0 ? "$" + Math.round(feeNum).toLocaleString("en-US") : "",
      scope: String(project.performance_style || "").trim(),
    }),
  });
});
