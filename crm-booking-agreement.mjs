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

import { bookingAgreementPdf, bookingAgreementTemplate } from './crm-contracts.mjs'
import {
  loadForm,
  loadForms,
  markAgreementSent,
  markAgreementError,
  pullSubmission,
} from './crm-booking-form.mjs'
import { sendMessage } from './crm-gmail.mjs'
import { loadAll, appendActivityLog } from './crm-data-core.mjs'
import { CRM_STORE, sb } from './crm-store.mjs'

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
export async function publishAgreement(projectId) {
  if (CRM_STORE !== 'supabase') throw new Error('Booking agreements need the Supabase store.')
  const html = bookingAgreementTemplate(projectId)
  const { error } = await sb().from('projects').update({ agreement_html: html }).eq('id', projectId)
  if (error) throw new Error(`Could not publish the agreement: ${error.message}`)
  return { ok: true, bytes: html.length }
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
    'Looking forward to it!',
    'Michael',
  ].join('\n')
  const html = [
    `<p>Hi ${escapeHtml(firstName)},</p>`,
    "<p>You're on the books. Thanks for getting all that over to me.</p>",
    '<p>Attached is a copy of the agreement you just signed, for your records. The first page is the event details you gave me, so hang on to it and let me know if anything changes between now and the day.</p>',
    "<p>I'll send the invoice separately.</p>",
    '<p>Looking forward to it!<br>Michael</p>',
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
// The sweep
// ---------------------------------------------------------------------------

// Which projects are worth asking the database about: the link went out, and we have not yet mailed
// a signed copy. Computed from the LOCAL form file so the common case (nothing outstanding) costs no
// database traffic at all. Supabase egress is a live constraint here; see the data_version work.
function awaitingAgreement() {
  return Object.entries(loadForms())
    .filter(([, rec]) => rec && rec.sentAt && !rec.agreementSentAt)
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
  for (const row of rows) {
    const projectId = row.project_id
    try {
      // Applies the answers, and picks up the signature, if either is new.
      const pulled = await pullSubmission(projectId)
      if (!pulled.ok) throw new Error(pulled.error || 'Could not read the submission.')
      // Nothing to send until they have actually signed. Not an error: most rows sit here for a
      // while between filling the form and signing.
      if (!row.signed_at) continue
      const res = await sendAgreement(projectId)
      if (res && !res.alreadySent) {
        sent += 1
        console.log(`[booking-agreement] signed agreement auto-sent for ${projectId}.`)
      }
    } catch (e) {
      const msg = String(e?.message || e)
      markAgreementError(projectId, msg)
      console.error(`[booking-agreement] auto-send failed for ${projectId}:`, msg)
    }
  }
  return { checked: rows.length, sent }
}
