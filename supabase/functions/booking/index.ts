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
//   - GET returns progress state (submitted / signed) so someone who closes the tab can pick up
//     where they left off. It never returns their answers.
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
  { id: "event_date", label: "Event date", type: "date", contractKey: "event_date" },
  { id: "event_location", label: "Event address", type: "textarea", contractKey: "event_location" },
  { id: "venue_type", label: "What kind of venue is it?", type: "text", contractKey: "venue_type" },
  { id: "indoors_or_outdoors", label: "Indoors or outdoors?", type: "select", contractKey: "indoors_or_outdoors" },
  { id: "event_start_time", label: "What time does the event start?", type: "time", contractKey: "event_start_time" },
  { id: "show_start_time", label: "What time would you like the magic to start?", type: "time", contractKey: "show_start_time" },
  { id: "number_of_guests", label: "Roughly how many guests?", type: "text" },
  { id: "age_of_guests", label: "Rough ages of the guests", type: "text" },
  { id: "vips", label: "Anyone special I should know about?", type: "textarea" },
  { id: "av", label: "Is there a sound system or microphone available?", type: "text" },
  { id: "invoice_to", label: "Who should the invoice be addressed to?", type: "text" },
  { id: "invoice_email", label: "Which email should the invoice go to?", type: "email" },
  { id: "notes", label: "Anything else I should know?", type: "textarea" },
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
function buildAgreement(agreementHtml: string, answers: { id: string; value: string }[]) {
  const byId = new Map(answers.map((a) => [a.id, a.value]));
  let html = String(agreementHtml || "");
  const summary: { label: string; value: string }[] = [];

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
  if (req.method === "GET") {
    const token = (url.searchParams.get("token") || "").trim();
    if (!validToken(token)) return json({ error: "Invalid link." }, 400);

    const { data: row, error } = await sb
      .from("booking_submissions")
      .select("project_id, answers, signed_at")
      .eq("token", token)
      .maybeSingle();
    if (error) return json({ error: "Lookup failed." }, 500);
    if (!row) return json({ submitted: false, signed: false });
    if (row.signed_at) return json({ submitted: true, signed: true });

    // Submitted but not signed: hand back the agreement so they land straight on the signing step.
    const { data: project } = await sb
      .from("projects")
      .select("agreement_html")
      .eq("id", row.project_id)
      .maybeSingle();
    if (!project?.agreement_html) return json({ submitted: true, signed: false });

    const answers = Array.isArray(row.answers) ? row.answers : [];
    return json({ submitted: true, signed: false, agreement: buildAgreement(project.agreement_html, answers) });
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
    .select("id, agreement_html")
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

  // Hand back the agreement so the page can move straight on to signing. If Michael's CRM never
  // stored one, the answers are still safely saved; the page just thanks them and he follows up.
  if (!project.agreement_html) return json({ ok: true, agreement: null });
  return json({ ok: true, agreement: buildAgreement(project.agreement_html, answers) });
});
