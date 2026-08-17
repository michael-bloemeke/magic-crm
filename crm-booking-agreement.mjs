// The booking agreement: publishing it to the website, and emailing the signed copy back.
//
// The sequence, end to end:
//
//   1. Michael clicks "Ready to book". The CRM checks the performance style and the quote are set
//      (the client is about to READ both), renders the agreement, and stores it on the project as
//      `agreement_html`. Then it drafts the booking-form email, which he still sends himself.
//   2. The client fills in the event details on michaelbloemeke.com.
//   3. The SAME page moves straight on to the agreement, with their answers merged into it. They
//      tick the box, type their name, and submit. The website writes that to `booking_submissions`.
//      THAT ROW IS THE AGREEMENT: a timestamped, server-side record they cannot edit afterwards.
//   4. This module notices the signature and emails them a PDF copy for their records.
//
// Step 4 is a receipt, not the instrument. Which is the whole reason this design beats mailing a
// fillable PDF: a PDF on someone's laptop can never tell us it was signed, so the moment of
// agreement was invisible. Now it is a row in a table with a timestamp on it.
//
// Michael still sends the invoice by hand (his call). There is deliberately no invoice trigger here.
//
// This module lives apart from crm-booking-form.mjs because crm-contracts.mjs already imports that
// one, so the orchestration cannot go there without an import cycle.

import { bookingAgreementPdf, bookingAgreementTemplate, buildContractBody } from './crm-contracts.mjs'
import { CONTRACT_VARIANTS, bookingTemplateHtml } from './crm-contract-template.mjs'
import {
  loadForm,
  loadForms,
  invoiceTarget,
  clearLocalBooking,
  markAgreementSent,
  markAgreementError,
  pullSubmission,
} from './crm-booking-form.mjs'
import { sendMessage } from './crm-gmail.mjs'
import { loadAll, appendActivityLog } from './crm-data-core.mjs'
import {
  isConnected as qbConnected,
  loadInvoices as qbLoadInvoices,
  createInvoiceForProject,
  sendInvoiceForProject,
  refreshInvoiceStatus,
  status as qbStatus,
} from './crm-quickbooks.mjs'
import { readFileSync } from 'node:fs'
import { CRM_STORE, sb } from './crm-store.mjs'
import { signOffText, signOffHtml } from './crm-booking-emails.mjs'

function findProject(projectId) {
  const project = loadAll().projects.find((p) => p.id === projectId)
  if (!project) throw new Error('Project not found.')
  return project
}

// The agreement goes to the CLIENT, which is the project's first contact email, the same address the
// booking form went to. Deliberately NOT the invoice_email they gave on the form: that is often an
// accounts-payable address, and the contract is not accounts payable's to sign.
function clientEmail(project) {
  return String(project.contactEmails || '').split(/[,;]/)[0].trim()
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

// ---------------------------------------------------------------------------
// 1. Publishing the agreement to the website
// ---------------------------------------------------------------------------

// Render this project's agreement and store it on the project row, where the `booking` edge function
// reads it. Called when the booking-form link is issued, which is the moment Michael's Mac is
// guaranteed to be awake and his numbers are final.
//
// What gets stored still contains unfilled `data-f` marker spans for the facts the client supplies
// (date, address, times). The edge function fills those from their answers. Everything internal is
// already baked in here.
export async function publishAgreement(projectId, { variant = 'standard' } = {}) {
  if (CRM_STORE !== 'supabase') throw new Error('Booking agreements need the Supabase store.')
  const html = bookingAgreementTemplate(projectId, { variant })
  const { error } = await sb()
    .from('projects')
    .update({ agreement_html: html, agreement_variant: variant, booking_sent_at: new Date().toISOString() })
    .eq('id', projectId)
  if (error) throw new Error(`Could not publish the agreement: ${error.message}`)
  return { ok: true, variant, bytes: html.length }
}

// Wipe everything a PREVIOUS booking attempt left behind, so a resend starts clean.
//
// Michael's case for this is the media clause: he sends the agreement, the client says they don't
// want to be filmed, and he resends the other version. Without a reset the timeline would still show
// them having signed (the old one), the signed-copy claim would block the new PDF from going out,
// and the invoice claim would stop a fresh invoice being raised.
//
// What is deliberately KEPT: the token, so a link already sitting in their inbox still works and now
// serves the corrected agreement. Their ANSWERS are dropped along with the submission row, but they
// were already written onto the project, so the form comes back pre-filled and they are re-confirming
// rather than retyping.
//
// The QuickBooks invoice itself is NOT cancelled here, only the CRM's record of it. Michael's call:
// a resend implies nobody has paid yet, and he would rather delete the stray invoice in QuickBooks
// himself than have the CRM void things on his behalf.
export async function resetBooking(projectId) {
  if (CRM_STORE !== 'supabase') throw new Error('Booking agreements need the Supabase store.')
  const errs = []
  const del = async (table, col) => {
    const { error } = await sb().from(table).delete().eq(col, projectId)
    if (error) errs.push(`${table}: ${error.message}`)
  }
  await del('booking_submissions', 'project_id')
  await del('invoices', 'project_id')
  const { error } = await sb()
    .from('projects')
    .update({ booking_viewed_at: null })
    .eq('id', projectId)
  if (error) errs.push(`projects: ${error.message}`)
  clearLocalBooking(projectId)
  if (errs.length) throw new Error(`Could not reset the booking: ${errs.join('; ')}`)
  return { ok: true }
}

// Push the contract WORDING itself (every variant, fields still unfilled) up to Supabase.
//
// This is what lets the phone issue a booking form. The template lives in Node because it needs
// JSDOM to build; publishing the rendered-but-unfilled HTML means an edge function can do the
// per-project filling with plain string work, and the actual legal text still exists in exactly one
// place. Runs on Mac startup, so editing the template and relaunching is all it takes to update.
export async function publishContractTemplates() {
  if (CRM_STORE !== 'supabase') return { ok: false, skipped: 'not on the Supabase store' }
  const rows = CONTRACT_VARIANTS.map((v, i) => ({
    variant: v.id,
    label: v.label,
    hint: v.hint,
    // Run it through the SAME builder the desktop uses, with every field left blank. That gives the
    // stored template the numbered clause headings and the "[Label]" placeholders (with cf-missing,
    // which is what turns them red on the website). Publishing the raw template instead produced an
    // agreement with unnumbered clauses and bare labels where the placeholders should be.
    html: buildContractBody({}, { templateHtml: bookingTemplateHtml({ variant: v.id }), todayISO: '' }).html,
    sort: i,
    updated_at: new Date().toISOString(),
  }))
  const { error } = await sb().from('contract_templates').upsert(rows, { onConflict: 'variant' })
  if (error) throw new Error(`Could not publish the contract templates: ${error.message}`)
  return { ok: true, variants: rows.map((r) => r.variant) }
}

// Fetch the agreement PDF from the CLOUD renderer, which is the one that produced the copy the
// client received. Authenticated with the cron secret, the same key the scheduled run uses.
export async function agreementPdfFromCloud(projectId, download = false) {
  if (!projectId) throw new Error('Project not found.')
  if (CRM_STORE !== 'supabase') throw new Error('The agreement PDF needs the Supabase store.')
  const { data: cfg } = await sb().from('push_config').select('cron_secret').eq('id', 1).single()
  const secret = cfg?.cron_secret
  if (!secret) throw new Error('No cron secret is configured, so the renderer cannot be reached.')
  const base = (process.env.SUPABASE_URL || '').replace(/\/$/, '') ||
    JSON.parse(readFileSync(new URL('./supabase-credentials.json', import.meta.url), 'utf8')).url
  const url = `${base}/functions/v1/booking-complete?projectId=${encodeURIComponent(projectId)}${download ? '&download=1' : ''}`
  const res = await fetch(url, { headers: { 'x-cron-secret': secret } })
  if (!res.ok) {
    let msg = `The renderer returned ${res.status}.`
    try { msg = (await res.json())?.error || msg } catch { /* not json */ }
    throw new Error(msg)
  }
  return {
    buffer: Buffer.from(await res.arrayBuffer()),
    contentDisposition: res.headers.get('content-disposition') || 'inline; filename="Agreement.pdf"',
  }
}

// The variants Michael can pick between, for the UI.
export function contractVariants() {
  return CONTRACT_VARIANTS.map((v) => ({ id: v.id, label: v.label, hint: v.hint }))
}

// ---------------------------------------------------------------------------
// 2. Emailing the signed copy back
// ---------------------------------------------------------------------------

function emailBody(firstName) {
  const text = [
    `Hi ${firstName},`,
    '',
    "You're on the books. Thanks for getting all that over to me.",
    '',
    'Attached is a copy of the agreement you just signed, for your records. The first page is the event details you gave me, so hang on to it and let me know if anything changes between now and the day.',
    '',
    "I'll send the invoice separately.",
    '',
    signOffText('Looking forward to it!'),
  ].join('\n')
  const html = [
    `<p>Hi ${escapeHtml(firstName)},</p>`,
    "<p>You're on the books. Thanks for getting all that over to me.</p>",
    '<p>Attached is a copy of the agreement you just signed, for your records. The first page is the event details you gave me, so hang on to it and let me know if anything changes between now and the day.</p>',
    "<p>I'll send the invoice separately.</p>",
    signOffHtml('Looking forward to it!'),
  ].join('')
  return { text, html }
}

// Email the client their signed copy. Throws on any failure so the caller can record it.
//
// `force` re-sends even if it already went once. Nothing calls that automatically; it backs the
// "Resend copy" button for when a client says it never arrived.
export async function sendAgreement(projectId, { force = false } = {}) {
  const rec = loadForm(projectId)
  if (!rec) throw new Error('No booking form has been created for this project.')
  if (!rec.submission) throw new Error("The client hasn't filled in the booking form yet.")
  if (!rec.signature) throw new Error("The client hasn't signed the agreement yet.")
  if (rec.agreementSentAt && !force) return { ok: true, alreadySent: true, sentAt: rec.agreementSentAt }

  // The SHARED claim, not just the local one. `booking-complete` in the cloud is what normally does
  // this now, and it stamps pdf_sent_at when it takes the job. Checking only the local file would
  // let this send a second copy of something the cloud already delivered, because the local record
  // knows nothing about what happened while the Mac was asleep.
  if (!force && CRM_STORE === 'supabase') {
    try {
      const { data } = await sb().from('booking_submissions').select('pdf_sent_at').eq('project_id', projectId).maybeSingle()
      if (data?.pdf_sent_at) {
        markAgreementSent(projectId)
        return { ok: true, alreadySent: true, sentAt: new Date(data.pdf_sent_at).toISOString() }
      }
    } catch {
      // Cannot reach the database to check: refuse rather than risk a duplicate.
      throw new Error('Could not confirm whether the agreement has already been sent.')
    }
  }

  const project = findProject(projectId)
  const to = clientEmail(project)
  if (!to) throw new Error('This project has no client email to send the agreement to.')

  const { buffer, fileName, missingFields } = await bookingAgreementPdf(projectId)

  // A missing field renders as a literal "[Booking fee]" in the contract text. The gates on "Ready
  // to book" catch this long before here; this is the backstop for anything cleared afterwards.
  if (missingFields && missingFields.length) {
    throw new Error(`The agreement is missing ${missingFields.join(', ')}. Fill those in on the project, then resend.`)
  }

  const first = String(project.client || '').trim().split(/\s+/)[0] || 'there'
  const { text, html } = emailBody(first)

  await sendMessage({
    to,
    subject: 'Your signed agreement',
    body: text,
    html,
    attachments: [{ filename: fileName, contentType: 'application/pdf', contentBase64: buffer.toString('base64') }],
  })

  markAgreementSent(projectId)
  try {
    await sb().from('booking_submissions').update({ pdf_sent_at: new Date().toISOString() }).eq('project_id', projectId)
  } catch {
    /* bookkeeping only; the local record is what the sender reads */
  }
  try {
    await appendActivityLog(projectId, `Signed agreement emailed to ${to}.`)
  } catch {
    /* the log line is a nicety, never fail a sent email over it */
  }
  return { ok: true, to, fileName, sentAt: new Date().toISOString() }
}

// ---------------------------------------------------------------------------
// 3. Raising and sending the invoice
// ---------------------------------------------------------------------------

// Create the invoice in QuickBooks and send it, once the signed copy has gone out.
//
// Addressed to whoever the CLIENT named on the booking form ("who should the invoice be addressed
// to" / "which email should the invoice go to"), because on a corporate booking the person who signs
// is usually not the person who pays. Falls back to the project's own contact if they left it blank.
//
// IDEMPOTENT via the QuickBooks invoice record: once a project has an invoice with a sentAt, this is
// a no-op forever. That record is the guard, so a retry after a partial failure (invoice created but
// the send failed) resumes at the send rather than raising a second invoice.
export async function autoInvoice(projectId) {
  if (!(await qbConnected())) return { ok: false, skipped: 'QuickBooks is not connected.' }

  const existing = qbLoadInvoices()[projectId]
  if (existing?.sentAt) return { ok: true, alreadySent: true, sentAt: existing.sentAt }

  const project = findProject(projectId)
  const fee = Number(project.totalFee)
  if (!fee || Number.isNaN(fee) || fee <= 0) throw new Error('No quote on the project to invoice.')

  const target = invoiceTarget(projectId)
  const to = target.email || clientEmail(project)
  if (!to) throw new Error('No email to send the invoice to.')
  const customerName = target.name || project.client

  // Resume rather than duplicate: an invoice raised on a previous attempt is reused.
  const ref = existing?.invoiceId
    ? existing
    : await createInvoiceForProject(projectId, { customerName, email: to, amount: fee })

  await sendInvoiceForProject(projectId, to)

  const env = (await qbStatus()).environment
  try {
    await appendActivityLog(
      projectId,
      `Invoice ${ref.docNumber ? `#${ref.docNumber} ` : ''}for $${fee.toLocaleString('en-US')} sent to ${to}${env === 'sandbox' ? ' (QuickBooks sandbox).' : '.'}`,
    )
  } catch {
    /* the log line is a nicety, never fail a sent invoice over it */
  }
  return { ok: true, to, customerName, amount: fee, docNumber: ref.docNumber || '', environment: env }
}

// ---------------------------------------------------------------------------
// 4. Noticing that an invoice got paid
// ---------------------------------------------------------------------------

// Ask QuickBooks whether any outstanding invoice has been settled.
//
// This used to happen ONLY while the CRM was open in a browser, because the status sweep hung off a
// request from the front end. That is no good for the thing Michael actually wants, which is to wake
// up and find the job on his calendar as a booking rather than an inquiry: nobody is looking at the
// screen overnight. So it runs on the server timer instead.
//
// Cheap by construction: only projects that have an invoice sent and not yet marked paid are asked
// about, which is a handful at most and usually none.
export async function refreshPaidInvoices() {
  if (!(await qbConnected())) return { checked: 0, paid: 0 }
  let invoices = {}
  try {
    invoices = qbLoadInvoices()
  } catch {
    return { checked: 0, paid: 0 }
  }
  const outstanding = Object.entries(invoices)
    .filter(([, ref]) => ref?.invoiceId && ref.sentAt && !ref.paidAt)
    .map(([projectId]) => projectId)
  if (!outstanding.length) return { checked: 0, paid: 0 }

  let paid = 0
  for (const projectId of outstanding) {
    try {
      const updated = await refreshInvoiceStatus(projectId)
      if (updated?.paidAt) {
        paid += 1
        console.log(`[booking-agreement] invoice for ${projectId} is now PAID.`)
        try {
          await appendActivityLog(projectId, 'Invoice paid in full.')
        } catch {
          /* log line is a nicety */
        }
      }
    } catch (e) {
      // One unreachable invoice must not stop the rest.
      console.error(`[booking-agreement] could not refresh the invoice for ${projectId}:`, e?.message || e)
    }
  }
  return { checked: outstanding.length, paid }
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

// Which projects are worth asking the database about: the link went out, and either the signed copy
// or the invoice is still outstanding. Computed from the LOCAL form file (plus the local QuickBooks
// records) so the common case, nothing outstanding, costs no database traffic at all. Supabase
// egress is a live constraint here; see the data_version work.
function awaitingAgreement() {
  let invoices = {}
  try {
    invoices = qbLoadInvoices()
  } catch {
    invoices = {}
  }
  return Object.entries(loadForms())
    .filter(([projectId, rec]) => rec && rec.sentAt && (!rec.agreementSentAt || !invoices[projectId]?.sentAt))
    .map(([projectId]) => projectId)
}

// Pull in anything new on the waiting projects (answers, then signatures) and mail the signed copy
// to whoever has signed.
//
// Safe to run on a timer: pullSubmission is a no-op once applied, and agreementSentAt makes the send
// strictly once-per-project. A project whose send FAILS keeps its blank agreementSentAt and is
// retried next tick, with the reason stored for the card to show.
export async function autoSendPending() {
  if (CRM_STORE !== 'supabase') return { checked: 0, sent: 0 }
  const waiting = awaitingAgreement()
  if (!waiting.length) return { checked: 0, sent: 0 }

  // One narrow query for the whole batch rather than one per project.
  let rows = []
  try {
    const { data, error } = await sb()
      .from('booking_submissions')
      .select('project_id, signed_at')
      .in('project_id', waiting)
    if (error) throw new Error(error.message)
    rows = data || []
  } catch (e) {
    console.error('[booking-agreement] could not check for submissions:', e?.message || e)
    return { checked: 0, sent: 0 }
  }

  let sent = 0
  let invoiced = 0
  for (const row of rows) {
    const projectId = row.project_id
    try {
      // Applies the answers, and picks up the signature, if either is new.
      const pulled = await pullSubmission(projectId)
      if (!pulled.ok) throw new Error(pulled.error || 'Could not read the submission.')
      // Nothing to send until they have actually signed. Not an error: most rows sit here for a
      // while between filling the form and signing.
      if (!row.signed_at) continue

      // Order matters, and a failure here deliberately BLOCKS the invoice for this tick. Invoicing
      // someone who never received their agreement would be the wrong way round, so a broken send
      // stalls the chain (visibly, on the card) rather than running ahead without it.
      const res = await sendAgreement(projectId)
      if (res && !res.alreadySent) {
        sent += 1
        console.log(`[booking-agreement] signed agreement auto-sent for ${projectId}.`)
      }

      const inv = await autoInvoice(projectId)
      if (inv.ok && !inv.alreadySent) {
        invoiced += 1
        console.log(`[booking-agreement] invoice sent for ${projectId} to ${inv.to} (${inv.environment}).`)
      } else if (inv.skipped) {
        console.log(`[booking-agreement] invoice skipped for ${projectId}: ${inv.skipped}`)
      }
    } catch (e) {
      const msg = String(e?.message || e)
      markAgreementError(projectId, msg)
      console.error(`[booking-agreement] auto-send failed for ${projectId}:`, msg)
    }
  }
  return { checked: rows.length, sent, invoiced }
}
