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

function buildAgreement(agreementHtml: string, answers: { id: string; value: string }[]) {
  const byId = new Map(answers.map((a) => [a.id, a.value]));
  let html = String(agreementHtml || "");
  const summary: { label: string; value: string }[] = [];
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

async function sendWithAttachment(sb: SupabaseClient, opts: {
  to: string;
  subject: string;
  html: string;
  filename: string;
  pdf: Uint8Array;
}) {
  const { token, sender } = await gmailAccessToken(sb);
  const boundary = `b${crypto.randomUUID().replace(/-/g, "")}`;
  const safeName = opts.filename.replace(/["\r\n]/g, "_");
  const raw = [
    `From: ${sender}`,
    `To: ${opts.to}`,
    `Subject: =?UTF-8?B?${b64Text(opts.subject)}?=`,
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
    body: JSON.stringify({ raw: b64url(raw) }),
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
    if (!res.ok) throw new Error(`QuickBooks ${res.status}: ${body?.Fault?.Error?.[0]?.Message || text.slice(0, 200)}`);
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

async function finishOne(sb: SupabaseClient, row: any): Promise<{ emailed: boolean; invoiced: boolean }> {
  const projectId = row.project_id as string;
  const out = { emailed: false, invoiced: false };

  const { data: project, error: projErr } = await sb
    .from("projects")
    .select("id, client_name, project_name, agreement_html, total_fee, contact_emails, activity_log")
    .eq("id", projectId)
    .maybeSingle();
  if (projErr || !project) throw new Error("Project not found.");
  if (!project.agreement_html) throw new Error("No agreement was published for this project.");

  const answers = Array.isArray(row.answers) ? row.answers : [];
  const built = buildAgreement(project.agreement_html, answers);
  const clientName = String(project.project_name || project.client_name || "Client");
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
          subject: "Your signed agreement",
          filename: `Agreement - ${clientName.replace(/[^\w.-]+/g, "-")} (signed).pdf`,
          pdf,
          html: [
            `<p>Hi ${escapeHtml(first)},</p>`,
            "<p>You're on the books. Thanks for getting all that over to me.</p>",
            "<p>Attached is a copy of the agreement you just signed, for your records. The first page is the event details you gave me, so hang on to it and let me know if anything changes between now and the day.</p>",
            "<p>I'll send the invoice separately.</p>",
            "<p>Looking forward to it!<br>Michael</p>",
          ].join(""),
        });
        out.emailed = true;
        await logActivity(sb, project, `Signed agreement emailed to ${clientEmail}.`);
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
      const created = await call("/invoice", {
        method: "POST",
        body: JSON.stringify({
          CustomerRef: { value: customer.Id },
          BillEmail: { Address: invoiceEmail },
          Line: [{
            DetailType: "SalesItemLineDetail",
            Amount: fee,
            Description: "Magic performance",
            SalesItemLineDetail: { ItemRef: { value: item.Id }, Qty: 1, UnitPrice: fee },
          }],
        }),
      });
      const inv = created.Invoice;
      ref = {
        invoiceId: inv.Id,
        docNumber: inv.DocNumber || "",
        total: inv.TotalAmt,
        amount: fee,
        processingFee: 0,
        dueDate: inv.DueDate || "",
        customer: customer.DisplayName,
        email: invoiceEmail,
        createdAt: new Date().toISOString(),
        sentAt: "",
      };
    }

    // The send endpoint insists on octet-stream with an empty body; JSON here makes it 500.
    await call(`/invoice/${ref.invoiceId}/send?sendTo=${encodeURIComponent(invoiceEmail)}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
    });
    ref.sentAt = new Date().toISOString();
    ref.email = invoiceEmail;
    await sb.from("invoices").upsert({ project_id: projectId, data: ref }, { onConflict: "project_id" });
    out.invoiced = true;
    await logActivity(
      sb,
      project,
      `Invoice ${ref.docNumber ? `#${ref.docNumber} ` : ""}for $${fee.toLocaleString("en-US")} sent to ${invoiceEmail}${environment === "sandbox" ? " (QuickBooks sandbox)." : "."}`,
    );
  } catch (e) {
    await sb.from("booking_submissions").update({ invoice_sent_at: null }).eq("project_id", projectId);
    throw e;
  }
  return out;
}

// Prepend a dated line to the project's activity log, matching the CRM's own format.
async function logActivity(sb: SupabaseClient, project: any, line: string) {
  try {
    const now = new Date();
    const stamp = `${MONTHS[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;
    const log = Array.isArray(project.activity_log) ? project.activity_log : [];
    await sb.from("projects").update({ activity_log: [`${stamp}: ${line}`, ...log] }).eq("id", project.id);
    project.activity_log = [`${stamp}: ${line}`, ...log];
  } catch { /* a log line must never fail a sent email */ }
}

Deno.serve(async (req) => {
  const sb = db();

  // Same gate as notify-cron: a shared secret in a header, checked against push_config.
  const { data: cfg } = await sb.from("push_config").select("cron_secret").eq("id", 1).single();
  const expected = cfg?.cron_secret || "";
  if (!expected || req.headers.get("x-cron-secret") !== expected) {
    return json({ error: "Forbidden." }, 403);
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
  if (!rows || !rows.length) return json({ ok: true, checked: 0, emailed: 0, invoiced: 0 });

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
      await sb.from("booking_submissions")
        .update({ complete_error: msg, complete_attempts: (row.complete_attempts ?? 0) + 1 })
        .eq("project_id", row.project_id);
      console.error(`[booking-complete] ${row.project_id}: ${msg}`);
    }
  }
  return json({ ok: true, checked: rows.length, emailed, invoiced, errors });
});
