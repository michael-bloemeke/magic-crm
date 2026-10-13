// Finish the booking, in the cloud, with Michael's Mac off.
//
// Signing already survived a closed laptop: the form and the agreement live on Cloudflare and write
// to Supabase. Everything AFTER the signature did not. The signed PDF and the invoice were produced
// by a sweep inside the Vite dev server, so a client who signed at 2am got nothing until he opened
// his laptop. This function is that sweep, moved somewhere that is always on.
//
// Runs from pg_cron every minute (same shared-secret pattern as notify-cron). On each pass:
//   1. Find signings that haven't been finished.
//   2. Render the agreement PDF (see pdf.ts, which needs no font files) and email it to the client.
//   3. Raise the invoice in QuickBooks and send it to whoever they named on the form.
//   4. Stamp each step so it can never happen twice.
//
// ORDERING is deliberate: no invoice goes out to someone who has not received their agreement. A
// failed email stalls that booking, visibly, rather than letting the money step run ahead of it.
//
// CLAIMING is deliberate too. The Mac may still be running its own copy of this logic, so every step
// is taken with a conditional update ("...where pdf_sent_at is null") and only proceeds if it
// actually changed a row. Two workers, no double sends.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { buildAgreementPdf, type Signature } from "./pdf.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const db = () =>
  createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false },
  });

// How many times to retry a booking that keeps failing before leaving it alone. Without this a
// permanently broken one (a dead mailbox, say) would be retried every minute forever.
const MAX_ATTEMPTS = 8;

// ---------------------------------------------------------------------------
// Shared formatting (mirrors the `booking` function and crm-booking-form.mjs)
// ---------------------------------------------------------------------------

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ordinal = (n: number) => (n % 100 >= 11 && n % 100 <= 13 ? `${n}th` : `${n}${["th", "st", "nd", "rd"][n % 10] || "th"}`);

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

const displayValue = (type: string, raw: unknown) => {
  const v = String(raw ?? "").trim();
  if (!v) return "";
  if (type === "date") return prettyDate(v);
  if (type === "time") return prettyTime(v);
  return v;
};
const escapeHtml = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

function fillMarker(html: string, key: string, value: string): string {
  const re = new RegExp(`<span[^>]*data-f="${key}"[^>]*>[^<]*</span>`, "g");
  const out = `<span class="cf" data-f="${key}">${escapeHtml(value)}</span>`;
  return html.replace(re, () => out);
}

function buildAgreement(agreementHtml: string, answers: { id: string; value: string }[], eventDateISO = "") {
  const byId = new Map(answers.map((a) => [a.id, a.value]));
  let html = String(agreementHtml || "");
  const summary: { label: string; value: string }[] = [];
  // The event date is not one of the questions; it comes off the project.
  const prettyEventDate = prettyDate(eventDateISO);
  if (prettyEventDate) {
    summary.push({ label: "Event date", value: prettyEventDate });
    html = fillMarker(html, "event_date", prettyEventDate);
  }
  for (const f of FIELDS) {
    const shown = displayValue(f.type, byId.get(f.id));
    if (!shown) continue;
    summary.push({ label: f.label, value: shown });
    if (f.contractKey) html = fillMarker(html, f.contractKey, shown);
  }
  return { html, summary };
}

// ---------------------------------------------------------------------------
// Gmail, with an attachment
// ---------------------------------------------------------------------------
//
// The existing `send-email` function can't do this: it sends plain text-to-HTML and requires a
// logged-in user's JWT, and this runs unattended with a PDF to carry. Same credentials though, out
// of the same service-role-only email_config row.

function b64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
const b64Text = (s: string) => b64(new TextEncoder().encode(s));
const b64url = (s: string) => b64Text(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const wrap76 = (s: string) => s.replace(/(.{76})/g, "$1\r\n");

async function gmailAccessToken(sb: SupabaseClient): Promise<{ token: string; sender: string }> {
  const { data: cfg, error } = await sb.from("email_config").select("*").eq("id", 1).single();
  if (error || !cfg) throw new Error("Email is not configured.");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.client_id,
      client_secret: cfg.client_secret,
      refresh_token: cfg.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const tok = await res.json();
  if (!res.ok || !tok.access_token) throw new Error("Gmail auth failed.");
  return { token: tok.access_token, sender: cfg.sender || "me" };
}

// Find the last message in a Gmail thread and read the headers a reply needs.
//
// Passing threadId alone is NOT enough to thread a reply: Gmail groups on In-Reply-To / References,
// and without them the message lands in the thread server-side but shows as a stray in most clients.
// So the original Message-ID is fetched and quoted back.
async function replyHeaders(token: string, threadId: string): Promise<{ inReplyTo: string; references: string; subject: string } | null> {
  if (!threadId) return null;
  try {
    const res = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=Subject`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return null;
    const thread = await res.json();
    const msgs = thread?.messages || [];
    if (!msgs.length) return null;
    const last = msgs[msgs.length - 1];
    const head = (n: string) =>
      (last.payload?.headers || []).find((h: any) => String(h.name).toLowerCase() === n.toLowerCase())?.value || "";
    const id = head("Message-ID");
    if (!id) return null;
    const prior = head("References");
    return { inReplyTo: id, references: (prior ? prior + " " : "") + id, subject: head("Subject") };
  } catch {
    return null; // a fresh thread is a far better outcome than a failed send
  }
}

async function sendWithAttachment(sb: SupabaseClient, opts: {
  to: string;
  subject: string;
  html: string;
  filename: string;
  pdf: Uint8Array;
  threadId?: string;
}) {
  const { token, sender } = await gmailAccessToken(sb);
  const boundary = `b${crypto.randomUUID().replace(/-/g, "")}`;
  const safeName = opts.filename.replace(/["\r\n]/g, "_");
  const reply = opts.threadId ? await replyHeaders(token, opts.threadId) : null;
  // Keep the original subject so the client's mail app groups it, prefixing Re: once.
  const subject = reply?.subject
    ? (/^re:/i.test(reply.subject) ? reply.subject : `Re: ${reply.subject}`)
    : opts.subject;
  const raw = [
    `From: ${sender}`,
    `To: ${opts.to}`,
    `Subject: =?UTF-8?B?${b64Text(subject)}?=`,
    ...(reply ? [`In-Reply-To: ${reply.inReplyTo}`, `References: ${reply.references}`] : []),
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(b64Text(opts.html)),
    `--${boundary}`,
    "Content-Type: application/pdf",
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${safeName}"`,
    "",
    wrap76(b64(opts.pdf)),
    `--${boundary}--`,
    "",
  ].join("\r\n");

  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(reply && opts.threadId ? { raw: b64url(raw), threadId: opts.threadId } : { raw: b64url(raw) }),
  });
  const out = await res.json();
  if (!res.ok) throw new Error(`Gmail rejected the send: ${out?.error?.message || res.status}`);
  return out;
}

// Same as sendWithAttachment, without the attachment. Used for the booking confirmation.
async function sendPlain(sb: SupabaseClient, opts: { to: string; subject: string; html: string; threadId?: string }) {
  const { token, sender } = await gmailAccessToken(sb);
  const reply = opts.threadId ? await replyHeaders(token, opts.threadId) : null;
  const subject = reply?.subject
    ? (/^re:/i.test(reply.subject) ? reply.subject : `Re: ${reply.subject}`)
    : opts.subject;
  const raw = [
    `From: ${sender}`,
    `To: ${opts.to}`,
    `Subject: =?UTF-8?B?${b64Text(subject)}?=`,
    ...(reply ? [`In-Reply-To: ${reply.inReplyTo}`, `References: ${reply.references}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(b64Text(opts.html)),
    "",
  ].join("\r\n");
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(reply && opts.threadId ? { raw: b64url(raw), threadId: opts.threadId } : { raw: b64url(raw) }),
  });
  const out = await res.json();
  if (!res.ok) throw new Error(`Gmail rejected the send: ${out?.error?.message || res.status}`);
  return out;
}

// ---------------------------------------------------------------------------
// QuickBooks
// ---------------------------------------------------------------------------
//
// The token lives in quickbooks_config, one row, because Intuit ROTATES the refresh token on every
// refresh. Two independent copies (a file on the Mac and a row here) would eventually invalidate
// each other, so there is exactly one and both sides read it from here.

const QB_MINOR = "70";
const qbBase = (env: string) =>
  env === "production" ? "https://quickbooks.api.intuit.com" : "https://sandbox-quickbooks.api.intuit.com";

// NO CustomerMemo is set here, deliberately.
//
// It briefly carried invoiceMemo() from crm-booking-emails.mjs, but that text ("The Invoice is
// attached, please remit payment...") was written by Michael as the EMAIL that accompanies an
// invoice, not as the note printed on the invoice document. They are different pieces of writing
// doing different jobs, and he did not want one silently reused as the other (2026-08-04).
//
// So the invoice carries whatever QuickBooks' own company settings put on it, which is where an
// invoice-facing message belongs. If a per-invoice memo is ever wanted, set CustomerMemo below with
// wording written for that purpose rather than borrowed from the email.

async function qbClient(sb: SupabaseClient) {
  const { data: cfg, error } = await sb.from("quickbooks_config").select("*").eq("id", 1).single();
  if (error || !cfg) throw new Error("QuickBooks is not configured.");

  let access = cfg.access_token as string | null;
  const expires = cfg.access_expires_at ? new Date(cfg.access_expires_at).getTime() : 0;
  // Refresh a minute early rather than racing the expiry.
  if (!access || expires - 60_000 < Date.now()) {
    const res = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${cfg.client_id}:${cfg.client_secret}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: cfg.refresh_token }),
    });
    const tok = await res.json();
    if (!res.ok || !tok.access_token) throw new Error(`QuickBooks auth failed: ${tok?.error_description || res.status}`);
    access = tok.access_token;
    // Write the ROTATED refresh token straight back. Losing this write means losing the connection.
    await sb.from("quickbooks_config").update({
      access_token: tok.access_token,
      refresh_token: tok.refresh_token || cfg.refresh_token,
      access_expires_at: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", 1);
  }

  const call = async (pathPart: string, init: RequestInit = {}) => {
    const sep = pathPart.includes("?") ? "&" : "?";
    const url = `${qbBase(cfg.environment)}/v3/company/${cfg.realm_id}${pathPart}${sep}minorversion=${QB_MINOR}`;
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${access}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    });
    const text = await res.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* the send endpoint answers with nothing */ }
    if (!res.ok) {
      // intuit_tid is Intuit's own id for this exact request. It is the first thing their support
      // asks for, and without it a ticket is "an invoice failed at some point" with nothing they can
      // trace. Carried into the error message so it lands in complete_error and the function logs.
      const tid = res.headers.get("intuit_tid") || res.headers.get("Intuit_Tid") || "";
      const detail = body?.Fault?.Error?.[0]?.Message || text.slice(0, 200);
      throw new Error(`QuickBooks ${res.status}: ${detail}${tid ? ` [intuit_tid ${tid}]` : ""}`);
    }
    return body;
  };
  return { call, environment: cfg.environment as string };
}

async function ensureCustomer(call: any, name: string, email: string) {
  const safe = String(name || "").replace(/['\\]/g, " ").trim() || "Client";
  const found = await call(`/query?query=${encodeURIComponent(`select * from Customer where DisplayName = '${safe}'`)}`);
  const existing = found?.QueryResponse?.Customer?.[0];
  if (existing) return existing;
  const body: Record<string, unknown> = { DisplayName: safe };
  if (email) body.PrimaryEmailAddr = { Address: email };
  const created = await call("/customer", { method: "POST", body: JSON.stringify(body) });
  return created.Customer;
}

async function ensureServiceItem(call: any, name: string) {
  const safe = String(name || "Service").replace(/['\\]/g, " ").trim();
  const found = await call(`/query?query=${encodeURIComponent(`select * from Item where Name = '${safe}'`)}`);
  const existing = found?.QueryResponse?.Item?.[0];
  if (existing) return existing;
  const acc = (await call(`/query?query=${encodeURIComponent("select * from Account where AccountType = 'Income' maxresults 1")}`))
    ?.QueryResponse?.Account?.[0];
  if (!acc) throw new Error("No income account in QuickBooks to attach a service item to.");
  const created = await call("/item", {
    method: "POST",
    body: JSON.stringify({ Name: safe, Type: "Service", IncomeAccountRef: { value: acc.Id } }),
  });
  return created.Item;
}

// ---------------------------------------------------------------------------
// The work
// ---------------------------------------------------------------------------

// ⚠️ A PROJECT STORES THE CLIENT'S EMAIL IN TWO PLACES AND THIS FUNCTION ONLY EVER READ ONE.
//
// 1. `projects.contact_emails`, plain text on the project. The website inquiry function fills this,
//    so every lead that arrives through the site has always worked.
// 2. The linked CONTACT record, via `contact_links`. This is what the CRM's project page and contact
//    panel actually SHOW, and it is what a project built by hand ends up with.
//
// The desktop app learned this on 2026-08-04 and grew a fallback (`clientEmailFor` in
// crm-booking-form.mjs). **That fix was never carried into this edge function.** The result, on
// 2026-09-10 with Jack and Grace's wedding two days out: the booking form sent perfectly, because
// the app resolved the contact record, then the client filled it in and signed, and then this job
// failed eight times with "No client email to send the agreement to" and gave up at MAX_ATTEMPTS.
// Michael saw an email on the contact card and a stuck booking, with nothing connecting the two.
//
// So: fill the project's own field from the linked contact whenever it is blank, immediately after
// the project is read. Every downstream reader then works unchanged, including the invoice branch,
// the payment confirmation and the stuck-booking alert. Silent on failure by design; a missing
// email must still surface as the caller's own clear error, not as a crash in here.
// ⚠️ WHO A CLIENT-FACING MESSAGE IS ADDRESSED TO (Michael, 2026-09-28).
//
// ALWAYS the contact name. NEVER project_name.
//
// project_name is the CRM's display label for the job and is routinely not a person: a company, an
// occasion, "40th anniversary". It printed on a real signed contract once, and the confirmation
// email opened "Hi Charlie's," because the project was called "Charlie's 11th birthday, Harry
// Potter themed". client_name is the immutable slug key and is usually the person, so it is the
// fallback. project_name is not in the chain at all.
//
// Internal alerts TO Michael still use project_name on purpose: those are subject lines that
// identify a job on his own board, not a greeting to a human.
function clientFacingName(project: any): string {
  const contact = String(project?.contact_names || "").split(/[,;]/)[0].trim();
  if (contact) return contact;
  return String(project?.client_name || "Client").trim() || "Client";
}

async function hydrateClientEmail(sb: SupabaseClient, project: any): Promise<void> {
  if (!project) return;
  if (String(project.contact_emails || "").trim()) return;
  try {
    const { data: links } = await sb.from("contact_links").select("contact_id").eq("project_id", project.id);
    const ids = (links || []).map((l: any) => l.contact_id).filter(Boolean);
    if (!ids.length) return;
    const { data: contacts } = await sb.from("contacts").select("id, emails").in("id", ids);
    for (const id of ids) {
      // contacts.emails is a jsonb ARRAY, unlike projects.contact_emails which is comma-separated
      // text. Handle both rather than relying on Array.toString() joining with commas by luck.
      const raw = (contacts || []).find((c: any) => c.id === id)?.emails;
      const list = Array.isArray(raw) ? raw : String(raw || "").split(/[,;]/);
      const email = list.map((e: any) => String(e || "").trim()).find(Boolean);
      if (email) {
        project.contact_emails = email;
        return;
      }
    }
  } catch (e) {
    console.error("[booking-complete] contact-record email lookup failed:", String((e as Error)?.message ?? e));
  }
}

async function finishOne(sb: SupabaseClient, row: any): Promise<{ emailed: boolean; invoiced: boolean }> {
  const projectId = row.project_id as string;
  const out = { emailed: false, invoiced: false };

  const { data: project, error: projErr } = await sb
    .from("projects")
    .select("id, client_name, project_name, contact_names, agreement_html, total_fee, contact_emails, activity_log, event_date, booking_thread_id")
    .eq("id", projectId)
    .maybeSingle();
  if (projErr || !project) throw new Error("Project not found.");
  await hydrateClientEmail(sb, project);
  if (!project.agreement_html) throw new Error("No agreement was published for this project.");

  const answers = Array.isArray(row.answers) ? row.answers : [];
  const built = buildAgreement(project.agreement_html, answers, String(project.event_date || ""));
  const clientName = clientFacingName(project);
  const byId = new Map(answers.map((a: any) => [a.id, a.value]));

  // --- 1. The signed copy --------------------------------------------------
  if (!row.pdf_sent_at) {
    const clientEmail = String(project.contact_emails || "").split(/[,;]/)[0].trim();
    if (!clientEmail) throw new Error("No client email to send the agreement to.");

    // CLAIM IT FIRST. If the Mac's sweep is also running, exactly one of us changes a row here.
    const { data: claimed } = await sb
      .from("booking_submissions")
      .update({ pdf_sent_at: new Date().toISOString() })
      .eq("project_id", projectId)
      .is("pdf_sent_at", null)
      .select("project_id");
    if (claimed && claimed.length) {
      try {
        const sig: Signature | null = row.signed_at
          ? { name: row.signed_name || "", date: row.signed_date || "", signedAt: row.signed_at, ip: row.signer_ip || "" }
          : null;
        const pdf = await buildAgreementPdf({
          clientName,
          agreementHtml: built.html,
          summary: built.summary,
          signature: sig,
        });
        const first = clientName.trim().split(/\s+/)[0] || "there";
        await sendWithAttachment(sb, {
          to: clientEmail,
          subject: "Your Signed Agreement",
          filename: `Agreement - ${clientName.replace(/[^\w.-]+/g, "-")} (signed).pdf`,
          pdf,
          // REPLY into the thread the booking-form email opened, rather than starting a new one.
          // Michael's rule: "i want to make things easier for them and not send a thousand separate
          // email threads to their inbox".
          threadId: String(project.booking_thread_id || ""),
          html: [
            `<p>Hi ${escapeHtml(first)},</p>`,
            "<p>I just received the booking form and signature.</p>",
            "<p>Attached is a copy of the agreement you just signed, for your records. The first page is a copy of the event details you gave me, so hang on to it and let me know if anything changes between now and the day.</p>",
            "<p>The invoice should be arriving in a separate email shortly. Let me know if it doesn't come through. <u>Once that invoice goes through, you'll be finalized in my calendar!</u></p>",
            "<p>Thanks again!<br>Michael</p>",
          ].join(""),
        });
        out.emailed = true;
        await logActivity(sb, project, `Signed agreement emailed to ${clientEmail}.`);
        // Tell Michael, immediately. This fires in the same pass that delivers the client's copy, so
        // he knows a contract is signed within a minute of it happening rather than whenever he next
        // opens the CRM. Best-effort by design: his alert must never be the reason a client's
        // agreement is treated as unsent.
        try {
          await notifyMichael(sb, {
            project,
            clientEmail,
            signedName: String(row.signed_name || ""),
            fee: Number(project.total_fee),
            invoicingPaused: !(await autoInvoiceEnabled(sb)),
          });
        } catch (e) {
          console.error(`[booking-complete] could not alert Michael for ${projectId}:`, String((e as Error)?.message ?? e));
        }
      } catch (e) {
        // Release the claim so the next pass retries rather than the booking being stuck "sent".
        await sb.from("booking_submissions").update({ pdf_sent_at: null }).eq("project_id", projectId);
        throw e;
      }
    }
  }

  // --- 2. The invoice ------------------------------------------------------
  // Only after the agreement is genuinely in their hands.
  const { data: fresh } = await sb
    .from("booking_submissions")
    .select("pdf_sent_at, invoice_sent_at")
    .eq("project_id", projectId)
    .maybeSingle();
  if (!fresh?.pdf_sent_at || fresh.invoice_sent_at) return out;

  // Two independent switches, because raising an invoice and sending it to a client are different
  // decisions (Michael, 2026-08-05):
  //
  //   auto_invoice_enabled  - build the invoice in QuickBooks at all. Off = stop here cleanly, so the
  //                           step does not fail on every pass and fill complete_error with noise.
  //   auto_send_invoice     - ALSO email it to the client. Off = the invoice is left as a draft in
  //                           QuickBooks for him to review and send by hand. He is supervising the
  //                           first few until he trusts the wording and the totals.
  //
  // Either way the invoice is recorded against the project, so the CRM tracks its status whether it
  // sent it or he did.
  const { data: qbCfg } = await sb
    .from("quickbooks_config")
    .select("auto_invoice_enabled, auto_send_invoice, processing_fee_percent")
    .eq("id", 1)
    .maybeSingle();
  if (qbCfg && qbCfg.auto_invoice_enabled === false) return out;
  const sendIt = !!qbCfg?.auto_send_invoice;
  const feePct = Number(qbCfg?.processing_fee_percent ?? 0);

  const fee = Number(project.total_fee);
  if (!fee || Number.isNaN(fee) || fee <= 0) throw new Error("No quote on the project to invoice.");
  const invoiceTo = String(byId.get("invoice_to") || "").trim() || clientName;
  const invoiceEmail = String(byId.get("invoice_email") || "").trim() ||
    String(project.contact_emails || "").split(/[,;]/)[0].trim();
  if (!invoiceEmail) throw new Error("No email to send the invoice to.");

  const { data: claimedInv } = await sb
    .from("booking_submissions")
    .update({ invoice_sent_at: new Date().toISOString() })
    .eq("project_id", projectId)
    .is("invoice_sent_at", null)
    .select("project_id");
  if (!claimedInv || !claimedInv.length) return out;

  try {
    // Reuse an invoice the Mac (or a half-finished earlier pass) already raised.
    const { data: existingRow } = await sb.from("invoices").select("data").eq("project_id", projectId).maybeSingle();
    let ref = existingRow?.data as any;

    // ALREADY SENT: stop here. Reusing the invoice record is right, but re-running the send would
    // mail the client a second copy of the same invoice. Caught before this ever ran, on a project
    // the Mac had already invoiced back when invoice_sent_at did not yet exist.
    if (ref?.invoiceId && ref.sentAt) {
      return out;
    }

    const { call, environment } = await qbClient(sb);
    if (!ref?.invoiceId) {
      const customer = await ensureCustomer(call, invoiceTo, invoiceEmail);
      const item = await ensureServiceItem(call, "Magic Performance");
      const lines: unknown[] = [{
        DetailType: "SalesItemLineDetail",
        Amount: fee,
        Description: "Magic performance",
        SalesItemLineDetail: { ItemRef: { value: item.Id }, Qty: 1, UnitPrice: fee },
      }];

      // Processing fee as its own visible line, so the client covers it rather than Michael
      // absorbing it out of the quote. A separate line rather than an inflated total, because the
      // client should be able to see what they are paying for. Mirrors createInvoiceForProject on
      // the Mac. Percentage lives in quickbooks_config, so changing it needs no redeploy.
      let processingFee = 0;
      if (feePct > 0) {
        processingFee = Math.round(fee * feePct) / 100; // fee * (pct/100), to 2dp
        // "Processing Fee", not "Card Processing Fee" (renamed 2026-10-13: a client paid by bank
        // transfer and skipped the fee, reading it as card-only). See crm-quickbooks.mjs.
        const feeItem = await ensureServiceItem(call, "Processing Fee");
        lines.push({
          DetailType: "SalesItemLineDetail",
          Amount: processingFee,
          Description: `Processing fee (${feePct}%)`,
          SalesItemLineDetail: { ItemRef: { value: feeItem.Id }, Qty: 1, UnitPrice: processingFee },
        });
      }

      const created = await call("/invoice", {
        method: "POST",
        body: JSON.stringify({
          CustomerRef: { value: customer.Id },
          BillEmail: { Address: invoiceEmail },
          Line: lines,
          // Card only; bank transfer (ACH) off so it needs Michael's OK (2026-10-13). Mirrors
          // createInvoiceForProject on the Mac.
          AllowOnlineCreditCardPayment: true,
          AllowOnlineACHPayment: false,
        }),
      });
      const inv = created.Invoice;
      ref = {
        invoiceId: inv.Id,
        docNumber: inv.DocNumber || "",
        total: inv.TotalAmt,
        amount: fee,
        processingFee,
        dueDate: inv.DueDate || "",
        customer: customer.DisplayName,
        email: invoiceEmail,
        createdAt: new Date().toISOString(),
        sentAt: "",
      };
    }

    if (sendIt) {
      // The send endpoint insists on octet-stream with an empty body; JSON here makes it 500.
      await call(`/invoice/${ref.invoiceId}/send?sendTo=${encodeURIComponent(invoiceEmail)}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
      });
      ref.sentAt = new Date().toISOString();
    }
    ref.email = invoiceEmail;
    await sb.from("invoices").upsert({ project_id: projectId, data: ref }, { onConflict: "project_id" });
    out.invoiced = true;

    const totalStr = `$${Number(ref.total ?? fee).toLocaleString("en-US")}`;
    const feeNote = ref.processingFee ? ` (incl. $${Number(ref.processingFee).toLocaleString("en-US")} card fee)` : "";
    const sandboxNote = environment === "sandbox" ? " (QuickBooks sandbox)." : ".";
    await logActivity(
      sb,
      project,
      sendIt
        ? `Invoice ${ref.docNumber ? `#${ref.docNumber} ` : ""}for ${totalStr}${feeNote} sent to ${invoiceEmail}${sandboxNote}`
        : `Invoice ${ref.docNumber ? `#${ref.docNumber} ` : ""}for ${totalStr}${feeNote} DRAFTED in QuickBooks for ${invoiceEmail}. Review and send it yourself${sandboxNote}`,
    );

    // He asked to supervise the first few sends, so tell him there is one waiting rather than
    // leaving it sitting in QuickBooks for him to happen across.
    if (!sendIt) {
      try {
        await notifyMichaelInvoiceDrafted(sb, project, ref, invoiceEmail);
      } catch (e) {
        console.error(`[booking-complete] could not send the drafted-invoice alert for ${projectId}:`, String((e as Error)?.message ?? e));
      }
    }
  } catch (e) {
    await sb.from("booking_submissions").update({ invoice_sent_at: null }).eq("project_id", projectId);
    throw e;
  }
  return out;
}

// Ask QuickBooks whether any outstanding invoice has been settled, and if so tell the client they
// are booked in.
//
// This ran only on Michael's Mac before, which is no good for the thing he actually wants: to be
// asleep while it happens. The confirmation replies into the BOOKING thread rather than the invoice
// one, because QuickBooks sends the invoice and we have no thread of our own to reply into. He still
// ends up with four emails across two conversations: his, and QuickBooks'.
// THROTTLED to once every 15 minutes, not once a minute like the rest of the sweep.
//
// This used to ask QuickBooks about every outstanding invoice on every pass: roughly 1,440 calls a
// day per unpaid invoice, to learn something that is just as useful known a quarter of an hour later.
// Nobody is refreshing their inbox waiting on a "you're booked in" email to the second. The parts
// that DO need to be immediate (the signed agreement to the client, the alert to Michael) are not
// affected; they still run every minute.
const PAID_CHECK_EVERY_MS = 15 * 60 * 1000;

async function checkPaidAndConfirm(sb: SupabaseClient): Promise<{ paid: number; confirmed: number }> {
  const out = { paid: 0, confirmed: 0 };
  const { data: rows } = await sb.from("invoices").select("project_id, data");
  // Watch every invoice we RAISED, whether or not we sent it. While auto_send_invoice is off Michael
  // sends them by hand from QuickBooks, and those still need tracking: he asked for the status in the
  // CRM regardless of who pressed send. Requiring sentAt here (as it did until 2026-08-05) would have
  // meant a drafted-then-hand-sent invoice was never noticed as paid, so no booking confirmation.
  const outstanding = (rows || []).filter((r: any) => r.data?.invoiceId && !r.data?.confirmSentAt);
  if (!outstanding.length) return out;

  // Only worth throttling once we know there is something to check, so a quiet period costs nothing
  // and does not keep pushing the timestamp forward.
  const { data: cfg } = await sb.from("quickbooks_config").select("paid_check_at").eq("id", 1).maybeSingle();
  const last = cfg?.paid_check_at ? new Date(cfg.paid_check_at).getTime() : 0;
  if (Date.now() - last < PAID_CHECK_EVERY_MS) return out;
  await sb.from("quickbooks_config").update({ paid_check_at: new Date().toISOString() }).eq("id", 1);

  let call: any = null;
  try {
    ({ call } = await qbClient(sb));
  } catch {
    return out; // QuickBooks unreachable; try again next minute
  }

  for (const row of outstanding) {
    try {
      const ref = { ...(row.data as any) };
      if (!ref.paidAt) {
        const inv = (await call(`/invoice/${ref.invoiceId}`))?.Invoice;
        const balance = Number(inv?.Balance);
        if (!Number.isFinite(balance) || balance > 0) continue;
        ref.balance = 0;
        ref.paidAt = new Date().toISOString();
        out.paid += 1;
      }
      const { data: project } = await sb
        .from("projects")
        .select("id, client_name, project_name, contact_emails, contact_names, activity_log, booking_thread_id")
        .eq("id", row.project_id)
        .maybeSingle();
      await hydrateClientEmail(sb, project);
      const to = String(project?.contact_emails || "").split(/[,;]/)[0].trim();
      if (project && to) {
        const who = clientFacingName(project);
        const first = who.trim().split(/\s+/)[0] || "there";
        await sendPlain(sb, {
          to,
          subject: "Booking Confirmation",
          threadId: String(project.booking_thread_id || ""),
          html: [
            '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#222">',
            `<p style="margin:0 0 14px">Hi ${escapeHtml(first)},</p>`,
            "<p style=\"margin:0 0 14px\">I'm just letting you know that the signature and deposit went through which means that you are booked in my calendar and everything is good to go!</p>",
            "<p style=\"margin:0 0 14px\">I'll keep in touch as the date gets closer, but please don't hesitate to reach out if you have any questions.</p>",
            "<p style=\"margin:0 0 14px\">Thanks again, I'm looking forward to it!<br>Michael</p>",
            "</div>",
          ].join(""),
        });
        ref.confirmSentAt = new Date().toISOString();
        out.confirmed += 1;
        await logActivity(sb, project, "Invoice paid in full. Booking confirmation sent.");
      }
      await sb.from("invoices").update({ data: ref }).eq("project_id", row.project_id);
    } catch (e) {
      console.error(`[booking-complete] paid check failed for ${row.project_id}:`, String((e as Error)?.message ?? e));
    }
  }
  return out;
}

// Is automatic invoicing switched on? Read fresh each time rather than cached, so flipping the
// switch takes effect on the next cron pass without a redeploy.
async function autoInvoiceEnabled(sb: SupabaseClient): Promise<boolean> {
  const { data } = await sb.from("quickbooks_config").select("auto_invoice_enabled").eq("id", 1).maybeSingle();
  return !data || data.auto_invoice_enabled !== false;
}

// "They signed" alert, to Michael, not the client.
//
// He asked for this specifically because invoicing is paused: the moment a contract is signed he
// wants to raise the invoice by hand, and finding out hours later is the difference between looking
// organised and looking slow. Deliberately a NEW thread rather than a reply into the client's
// booking thread, so a message written for him can never land in their inbox.
const MICHAEL_EMAIL = "michael@michaelbloemeke.com";

async function notifyMichael(sb: SupabaseClient, opts: {
  project: any;
  clientEmail: string;
  signedName: string;
  fee: number;
  invoicingPaused: boolean;
}) {
  const who = String(opts.project.project_name || opts.project.client_name || "A client");
  const when = prettyDate(String(opts.project.event_date || ""));
  const amount = Number.isFinite(opts.fee) && opts.fee > 0 ? `$${opts.fee.toLocaleString("en-US")}` : "(no quote set)";
  await sendPlain(sb, {
    to: MICHAEL_EMAIL,
    subject: `SIGNED: ${who}${when ? ` (${when})` : ""}`,
    html: [
      '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#222">',
      `<p style="margin:0 0 14px"><strong>${escapeHtml(who)}</strong> just signed the agreement.</p>`,
      '<table cellpadding="0" cellspacing="0" style="margin:0 0 14px;font-size:15px">',
      `<tr><td style="padding:2px 16px 2px 0;color:#666">Signed by</td><td>${escapeHtml(opts.signedName || "(no name)")}</td></tr>`,
      when ? `<tr><td style="padding:2px 16px 2px 0;color:#666">Event date</td><td>${escapeHtml(when)}</td></tr>` : "",
      `<tr><td style="padding:2px 16px 2px 0;color:#666">Amount</td><td>${escapeHtml(amount)}</td></tr>`,
      `<tr><td style="padding:2px 16px 2px 0;color:#666">Their email</td><td>${escapeHtml(opts.clientEmail)}</td></tr>`,
      "</table>",
      opts.invoicingPaused
        ? '<p style="margin:0 0 14px;padding:10px 12px;background:#fff4e5;border-left:3px solid #d98324"><strong>Automatic invoicing is paused.</strong> Raise and send this invoice in QuickBooks yourself, then send them the booking confirmation.</p>'
        : '<p style="margin:0 0 14px">The invoice is going out automatically.</p>',
      '<p style="margin:0;color:#666;font-size:13px">They already have their signed copy.</p>',
      "</div>",
    ].filter(Boolean).join(""),
  });
}

// "There is an invoice waiting for you to send" alert. Only fires while auto_send_invoice is off.
async function notifyMichaelInvoiceDrafted(sb: SupabaseClient, project: any, ref: any, invoiceEmail: string) {
  const who = String(project?.project_name || project?.client_name || project?.id || "A client");
  const total = `$${Number(ref.total ?? 0).toLocaleString("en-US")}`;
  const feeLine = ref.processingFee
    ? `<tr><td style="padding:2px 16px 2px 0;color:#666">Card fee</td><td>$${Number(ref.processingFee).toLocaleString("en-US")}</td></tr>`
    : "";
  await sendPlain(sb, {
    to: MICHAEL_EMAIL,
    subject: `INVOICE READY TO SEND: ${who} ${total}`,
    html: [
      '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#222">',
      `<p style="margin:0 0 14px">An invoice for <strong>${escapeHtml(who)}</strong> has been drafted in QuickBooks. <strong>It has not been sent.</strong></p>`,
      '<table cellpadding="0" cellspacing="0" style="margin:0 0 14px;font-size:15px">',
      `<tr><td style="padding:2px 16px 2px 0;color:#666">Invoice</td><td>${escapeHtml(ref.docNumber ? "#" + ref.docNumber : "(no number)")}</td></tr>`,
      `<tr><td style="padding:2px 16px 2px 0;color:#666">Total</td><td><strong>${total}</strong></td></tr>`,
      feeLine,
      `<tr><td style="padding:2px 16px 2px 0;color:#666">To</td><td>${escapeHtml(invoiceEmail)}</td></tr>`,
      "</table>",
      '<p style="margin:0 0 14px;padding:10px 12px;background:#eef3fb;border-left:3px solid #3a6ea5">Open it in QuickBooks, check it reads the way you want, and hit send. The CRM will track it for payment either way.</p>',
      '<p style="margin:0;color:#666;font-size:13px">They already have their signed agreement.</p>',
      "</div>",
    ].filter(Boolean).join(""),
  });
}

// "This booking is stuck" alert. The counterpart to notifyMichael(): that one says a contract was
// signed, this one says the chain afterwards could not finish. Deliberately blunt about what the
// client has and has not received, because that is the thing he has to act on.
async function notifyMichaelFailed(sb: SupabaseClient, projectId: string, error: string) {
  const { data: project } = await sb
    .from("projects")
    .select("id, client_name, project_name, contact_emails, event_date")
    .eq("id", projectId)
    .maybeSingle();
  await hydrateClientEmail(sb, project);
  const { data: row } = await sb
    .from("booking_submissions")
    .select("pdf_sent_at, invoice_sent_at")
    .eq("project_id", projectId)
    .maybeSingle();

  const who = String(project?.project_name || project?.client_name || projectId);
  const when = prettyDate(String(project?.event_date || ""));
  const gotAgreement = !!row?.pdf_sent_at;

  await sendPlain(sb, {
    to: MICHAEL_EMAIL,
    subject: `BOOKING STUCK: ${who}`,
    html: [
      '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#222">',
      `<p style="margin:0 0 14px">The booking for <strong>${escapeHtml(who)}</strong>${when ? ` (${escapeHtml(when)})` : ""} could not be completed automatically, and it has stopped retrying.</p>`,
      '<p style="margin:0 0 6px;color:#666">What the client has:</p>',
      '<ul style="margin:0 0 14px;padding-left:20px">',
      `<li>Signed agreement: <strong>${gotAgreement ? "sent" : "NOT sent"}</strong></li>`,
      `<li>Invoice: <strong>${row?.invoice_sent_at ? "sent" : "not sent"}</strong></li>`,
      "</ul>",
      `<p style="margin:0 0 14px;padding:10px 12px;background:#fdecea;border-left:3px solid #c0392b"><strong>Error:</strong><br>${escapeHtml(error)}</p>`,
      gotAgreement
        ? '<p style="margin:0 0 14px">They do have their signed copy, so this is not urgent from their side.</p>'
        : '<p style="margin:0 0 14px"><strong>They have not received their signed agreement.</strong> Send it manually, or fix the cause and clear complete_attempts to let it retry.</p>',
      `<p style="margin:0;color:#666;font-size:13px">Project: ${escapeHtml(projectId)}</p>`,
      "</div>",
    ].join(""),
  });
}

// Prepend a dated line to the project's activity log, matching the CRM's own format.
// Activity-log lines are dated in EASTERN, not in the runtime's zone.
//
// This function runs in Supabase's cloud, where `new Date().getDate()` is UTC. Anything logged
// between 8 PM and midnight Eastern was therefore stamped with TOMORROW'S date, silently, and the
// log is the record Michael reads back later to reconstruct what happened when. The rest of the
// cloud already pins America/New_York (the signed-PDF footer, notify-cron, the inquiry email), so
// this was the one straggler. Fixed 2026-09-01.
//
// Intl knows the real DST rules for any date, so this is right in both EST and EDT.
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

async function logActivity(sb: SupabaseClient, project: any, line: string) {
  try {
    const stamp = easternStamp(new Date());
    const log = Array.isArray(project.activity_log) ? project.activity_log : [];
    await sb.from("projects").update({ activity_log: [`${stamp}: ${line}`, ...log] }).eq("id", project.id);
    project.activity_log = [`${stamp}: ${line}`, ...log];
  } catch { /* a log line must never fail a sent email */ }
}

// Is this caller allowed? Either the cron secret (the scheduled run, and the Mac) or a logged-in
// Supabase session (the phone). Same two-key shape the rest of the CRM uses.
async function authorized(sb: SupabaseClient, req: Request): Promise<boolean> {
  const { data: cfg } = await sb.from("push_config").select("cron_secret").eq("id", 1).single();
  const expected = cfg?.cron_secret || "";
  if (expected && req.headers.get("x-cron-secret") === expected) return true;
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return false;
  const { data, error } = await sb.auth.getUser(jwt);
  return !error && !!data?.user;
}

Deno.serve(async (req) => {
  const sb = db();

  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
      },
    });
  }

  if (!(await authorized(sb, req))) return json({ error: "Forbidden." }, 403);

  // --- Render one project's agreement, on demand -----------------------------
  //
  // This is what lets BOTH the phone and the Mac show the document. It matters that it comes from
  // here rather than each of them building their own: this renderer is what produced the copy the
  // client received, so previewing anything else would be showing a different document than the one
  // that was signed.
  if (req.method === "GET") {
    const url = new URL(req.url);
    const projectId = (url.searchParams.get("projectId") || "").trim();
    if (!projectId) return json({ error: "projectId is required." }, 400);

    const { data: project } = await sb
      .from("projects")
      .select("id, client_name, project_name, contact_names, agreement_html, event_date")
      .eq("id", projectId)
      .maybeSingle();
    if (!project?.agreement_html) return json({ error: "No agreement has been published for this project." }, 404);

    const { data: row } = await sb
      .from("booking_submissions")
      .select("answers, signed_at, signed_name, signed_date, signer_ip")
      .eq("project_id", projectId)
      .maybeSingle();

    const answers = Array.isArray(row?.answers) ? row!.answers : [];
    const built = buildAgreement(project.agreement_html, answers, String(project.event_date || ""));
    const clientName = clientFacingName(project);
    const sig: Signature | null = row?.signed_at
      ? { name: row.signed_name || "", date: row.signed_date || "", signedAt: row.signed_at, ip: row.signer_ip || "" }
      : null;
    const pdf = await buildAgreementPdf({ clientName, agreementHtml: built.html, summary: built.summary, signature: sig });
    const name = `Agreement - ${clientName.replace(/[^\w.-]+/g, "-")}${sig ? " (signed)" : ""}.pdf`;
    return new Response(pdf, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/pdf",
        // inline, so it PREVIEWS rather than downloading. Michael's point: he should be able to look
        // at it without a file landing in Downloads first.
        "Content-Disposition": `${url.searchParams.get("download") === "1" ? "attachment" : "inline"}; filename="${name}"`,
        "Cache-Control": "no-store",
      },
    });
  }

  // Signed, and not yet finished. `complete_attempts` stops a permanently broken one from being
  // retried every minute until the end of time.
  const { data: rows, error } = await sb
    .from("booking_submissions")
    .select("project_id, answers, signed_at, signed_name, signed_date, signer_ip, pdf_sent_at, invoice_sent_at, complete_attempts")
    .not("signed_at", "is", null)
    .or("pdf_sent_at.is.null,invoice_sent_at.is.null")
    .lt("complete_attempts", MAX_ATTEMPTS)
    .limit(10);
  if (error) return json({ error: error.message }, 500);
  if (!rows || !rows.length) {
    const only = await checkPaidAndConfirm(sb);
    return json({ ok: true, checked: 0, emailed: 0, invoiced: 0, ...only });
  }

  let emailed = 0;
  let invoiced = 0;
  const errors: Record<string, string> = {};
  for (const row of rows) {
    try {
      const r = await finishOne(sb, row);
      if (r.emailed) emailed += 1;
      if (r.invoiced) invoiced += 1;
      if (r.emailed || r.invoiced) {
        await sb.from("booking_submissions").update({ complete_error: null, complete_attempts: 0 }).eq("project_id", row.project_id);
      }
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).slice(0, 400);
      errors[row.project_id] = msg;
      const attempts = (row.complete_attempts ?? 0) + 1;
      await sb.from("booking_submissions")
        .update({ complete_error: msg, complete_attempts: attempts })
        .eq("project_id", row.project_id);
      console.error(`[booking-complete] ${row.project_id}: ${msg}`);

      // TELL MICHAEL, once, when we have given up.
      //
      // Until 2026-08-05 a failure was completely silent: the error went into complete_error and sat
      // there, shown in no screen and no alert. A client could sign, the agreement email could fail,
      // the retries could quietly exhaust, and the first he would know is them asking where their
      // copy was.
      //
      // Fired on the attempt that REACHES the cap, not on every failure, because the row is excluded
      // from the query once attempts hit MAX_ATTEMPTS. So this sends exactly one email per stuck
      // booking, after a transient problem has had eight chances to resolve itself.
      if (attempts >= MAX_ATTEMPTS) {
        try {
          await notifyMichaelFailed(sb, row.project_id, msg);
        } catch (mailErr) {
          console.error(`[booking-complete] could not send the failure alert for ${row.project_id}:`, String((mailErr as Error)?.message ?? mailErr));
        }
      }
    }
  }
  const paidResult = await checkPaidAndConfirm(sb);
  return json({ ok: true, checked: rows.length, emailed, invoiced, ...paidResult, errors });
});
