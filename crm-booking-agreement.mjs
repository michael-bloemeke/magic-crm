// Auto-send the performance agreement the moment the client's booking form comes back.
//
// The sequence Michael wants, end to end:
//
//   1. He clicks "Ready to book" on a project. That drafts the booking-form email (he still sends
//      that one himself) and blocks entirely if the performance style is blank, because the
//      agreement is built from it and nobody is going to be looking at it later.
//   2. The client fills in the form on michaelbloemeke.com. It lands in `booking_submissions`.
//   3. This module notices, applies the answers to the project, builds the agreement PDF, and
//      EMAILS IT TO THE CLIENT without asking. That is the one thing in this CRM that sends on its
//      own; everything else drafts and waits for him.
//   4. The client opens the PDF, ticks the box, types their name, and emails it back. Michael
//      watches for that himself and sends the invoice by hand.
//
// Step 4 is manual ON PURPOSE (his call, 2026-08-03). A fillable PDF sitting on someone's laptop
// cannot report back: there is no callback, no beacon, nothing. The only way to automate it would be
// to watch his inbox for the returned attachment and read the form fields out of it, and he'd rather
// eyeball it for now. So there is deliberately NO email watcher and NO invoice trigger in here.
//
// This module exists separately from crm-booking-form.mjs because crm-contracts.mjs already imports
// that one (for the summary rows), so the orchestration cannot live there without a cycle.

import { bookingAgreementPdf } from './crm-contracts.mjs'
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

function emailBody(firstName) {
  const text = [
    `Hi ${firstName},`,
    '',
    "Thanks for sending those details over. Here's the agreement.",
    '',
    'The first page is a summary of everything you told me, so give that a read and make sure I have it all right. The agreement itself follows.',
    '',
    'To sign it: open the PDF, tick the box at the bottom, type your name in the box next to it, save, and send it back to me. You can do all of that right in Preview or Acrobat, no printing or scanning.',
    '',
    "Once it's back I'll send the invoice over and we're all set.",
    '',
    'Thanks!',
    'Michael',
  ].join('\n')
  const html = [
    `<p>Hi ${escapeHtml(firstName)},</p>`,
    "<p>Thanks for sending those details over. Here's the agreement.</p>",
    '<p>The first page is a summary of everything you told me, so give that a read and make sure I have it all right. The agreement itself follows.</p>',
    '<p>To sign it: open the PDF, tick the box at the bottom, type your name in the box next to it, save, and send it back to me. You can do all of that right in Preview or Acrobat, no printing or scanning.</p>',
    "<p>Once it's back I'll send the invoice over and we're all set.</p>",
    '<p>Thanks!<br>Michael</p>',
  ].join('')
  return { text, html }
}

// Build the agreement and email it. Throws on any failure so the caller can record it.
//
// `force` re-sends even if it already went once. Nothing calls that automatically; it exists for the
// "Resend agreement" button, for when a detail was wrong and the client needs a corrected copy.
export async function sendAgreement(projectId, { force = false } = {}) {
  const rec = loadForm(projectId)
  if (!rec) throw new Error('No booking form has been created for this project.')
  if (!rec.submission) throw new Error("The client hasn't submitted the booking form yet.")
  if (rec.agreementSentAt && !force) return { ok: true, alreadySent: true, sentAt: rec.agreementSentAt }

  const project = findProject(projectId)
  const to = clientEmail(project)
  if (!to) throw new Error('This project has no client email to send the agreement to.')

  const { buffer, fileName, missingFields } = await bookingAgreementPdf(projectId)

  // A missing field renders as a literal "[Booking fee]" placeholder in the contract text. Sending
  // that to a client is worse than sending nothing, so refuse and surface what's missing. The
  // performance-style gate on "Ready to book" catches the common case long before here; this is the
  // backstop for anything else (a fee cleared after the form went out, say).
  if (missingFields && missingFields.length) {
    throw new Error(`The agreement is missing ${missingFields.join(', ')}. Fill those in on the project, then resend.`)
  }

  const first = String(project.client || '').trim().split(/\s+/)[0] || 'there'
  const { text, html } = emailBody(first)

  await sendMessage({
    to,
    subject: 'Your performance agreement',
    body: text,
    html,
    attachments: [{ filename: fileName, contentType: 'application/pdf', contentBase64: buffer.toString('base64') }],
  })

  markAgreementSent(projectId)
  try {
    await appendActivityLog(projectId, `Performance agreement emailed to ${to}.`)
  } catch {
    /* the log line is a nicety, never fail a sent email over it */
  }
  return { ok: true, to, fileName, sentAt: new Date().toISOString() }
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

// Which projects are waiting on an agreement: the form went out, and it hasn't been mailed yet.
// Computed from the LOCAL form file so the common case (nothing outstanding) costs no database
// traffic at all. Supabase egress is a live constraint here; see the data_version work.
function awaitingAgreement() {
  return Object.entries(loadForms())
    .filter(([, rec]) => rec && rec.sentAt && !rec.agreementSentAt)
    .map(([projectId]) => projectId)
}

// Poll for submissions on the projects that are waiting, apply them, and mail the agreement.
//
// Safe to run on a timer: pullSubmission is a no-op once a submission has been applied, and
// agreementSentAt makes the send strictly once-per-project. A project whose send FAILS keeps its
// blank agreementSentAt and is retried next tick, with the reason stored for the card to show.
export async function autoSendPending() {
  if (CRM_STORE !== 'supabase') return { checked: 0, sent: 0 }
  const waiting = awaitingAgreement()
  if (!waiting.length) return { checked: 0, sent: 0 }

  // One narrow query for the whole batch rather than one per project.
  let rows = []
  try {
    const { data, error } = await sb()
      .from('booking_submissions')
      .select('project_id')
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
      // Applies the answers to the project if they haven't been applied already.
      const pulled = await pullSubmission(projectId)
      if (!pulled.ok) throw new Error(pulled.error || 'Could not read the submission.')
      const res = await sendAgreement(projectId)
      if (res && !res.alreadySent) {
        sent += 1
        console.log(`[booking-agreement] agreement auto-sent for ${projectId}.`)
      }
    } catch (e) {
      const msg = String(e?.message || e)
      markAgreementError(projectId, msg)
      console.error(`[booking-agreement] auto-send failed for ${projectId}:`, msg)
    }
  }
  return { checked: rows.length, sent }
}
