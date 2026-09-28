// The BOOKING FORM: the one-click "they're ready to book" flow.
//
// Michael clicks a single button on a project. The client gets an email with a link to a form
// (hosted on Vercel, the same deployment the old client portal used). They fill in the event
// details, say who the invoice should go to, and submit. That submission comes back into the CRM
// and does three things in one go:
//
//   1. Writes every answer onto the project (so Event details stops being red).
//   2. Generates the CONTRACT PDF: page 1 is a read-only summary of what they just told us, page 2
//      is the agreement, which no longer re-lists the event facts and instead says "the event
//      details on the previous page are accurate". The booking fee IS filled in (Michael's number,
//      never asked on the form). At the foot: a confirm checkbox and a type-your-name box.
//   3. Creates a DRAFT invoice in QuickBooks, addressed to whoever they named, for the booking fee.
//      It is NOT sent. Michael sends it himself, from the CRM, once the signed contract comes back.
//
// Terminology: this is the "booking form". The old "client portal" idea is retired; only its Vercel
// deployment and Blob submission pipeline are reused.
//
// Where it all lives (reworked 2026-08-03): the form is a page on michaelbloemeke.com and posts to
// the `booking` Supabase edge function, which writes into the booking_submissions table. That is the
// same database the CRM already reads, so a submission is simply THERE the moment it arrives. No
// Vercel, no Blob, no relay, and nothing that needs Michael's Mac to be awake.
//
// The token is the only credential, so it is stamped onto the project row (projects.booking_token).
// The edge function refuses any token that doesn't match a project, which is what stops a stranger
// from posting junk.

import fs from 'node:fs'
import path from 'node:path'
import { RECORDS_DIR, updateProjectField, loadAll, appendActivityLog } from './crm-data-core.mjs'
import { CRM_STORE, sb, getCachedContacts, getCachedLinksMap } from './crm-store.mjs'
import { bookingFormEmail } from './crm-booking-emails.mjs'

// The public site that serves the form. The link is `${FORM_BASE}/book/?t=<token>`: /book/ is a real
// directory with an index.html, so it resolves without any host rewrite rule. The prettier
// /book/<token> form also works if the host rewrite is in place; the page reads either.
const FORM_BASE = 'https://michaelbloemeke.com'

// ---------------------------------------------------------------------------
// The questions
// ---------------------------------------------------------------------------
//
// `key` is the project field the answer writes into (blank = not stored on the project, handled
// specially). Order here is the order on the form. Michael can retune this list later; it is
// deliberately the facts a CLIENT can actually answer.
//
// Never ask for: the booking fee (Michael's number), the lead date, or the booking source. Those are
// internal and must never appear in front of a client.

export const BOOKING_FIELDS = [
  // ⚠️ THE ORDER IS A LAYOUT DECISION AS WELL AS A CONTENT ONE (Michael, 2026-09-10). The booking
  // page renders two columns on a screen wider than 880px, so these are sequenced to pair up:
  // every full-width question sits on its own, and the short ones fall into topical pairs
  // (the two times, the two guest questions, the two venue questions, and so on). Reordering this
  // list reflows that page, and `crm-booking-form.test.mjs` asserts the two match IN ORDER.
  { id: 'event_summary', key: 'eventSummary', label: 'Basic description of the event', hint: 'A sentence or two about what the event is', type: 'textarea', required: true },
  { id: 'event_start_time', key: 'eventStartTime', label: 'Event start time', type: 'time', required: true },
  { id: 'show_start_time', key: 'showStartTime', label: 'Show start time', hint: 'What time would you like the magic to start?', type: 'time', required: true },
  { id: 'number_of_guests', key: 'numberOfGuests', label: 'Number of guests', type: 'text', required: true },
  { id: 'age_of_guests', key: 'ageOfGuests', label: 'Ages of the guests', type: 'text', required: true },
  // ⚠️ REQUIRED, but deliberately NOT format-checked (Michael, 2026-09-28). Clients were sending a
  // street name with no town. A validation rule was built and then reverted, because rejecting a
  // good address on a form a paying client is filling in is worse than an imperfect one. The hint
  // does the work and explains WHY, which is what changes behaviour. Revisit only if bad addresses
  // keep arriving after this wording has had a run.
  { id: 'venue_address', key: 'eventLocation', label: 'Venue address', hint: 'Michael types this straight into Google Maps to get to you, so please give the whole thing: street number, street, city, state, and ZIP.', type: 'textarea', required: true },
  { id: 'venue_type', key: 'venueType', label: 'Venue type', hint: 'Private home, hotel ballroom, country club, restaurant, etc.', type: 'text', required: true },
  { id: 'indoors_or_outdoors', key: 'indoorsOrOutdoors', label: 'Indoor or outdoor', type: 'select', options: ['Indoors', 'Outdoors', 'Both'], required: true },
  { id: 'av', key: 'av', label: 'For a stage show, what AV is available at the venue (sound system, projector/screen, etc)?', hint: 'You can put NA if not applicable', type: 'textarea', required: true },
  { id: 'vips', key: 'vips', label: 'Any VIPs that Michael should give special attention to?', type: 'textarea', required: true },
  // Not a project field: drives who the QuickBooks invoice is addressed to. REQUIRED (Michael,
  // 2026-08-03): on a corporate booking the signer is often not the payer, and an invoice made out to
  // the wrong name gets bounced back through accounts payable. The fallback to the project's client
  // name stays in place downstream as a safety net, but they have to answer it.
  { id: 'invoice_to', key: '', label: 'What name should be on the invoice?', type: 'text', required: true },
  // Both of these are free text that belongs in the project's notes rather than a field of its own.
  { id: 'unforgettable', key: 'projectNotesAppend', label: 'How can Michael make your event unforgettable?', type: 'textarea', required: false },
  { id: 'notes', key: 'projectNotesAppend', label: 'Any other details Michael should know about the event?', type: 'textarea', required: false },
]

const FILE = path.join(RECORDS_DIR, 'crm-booking-forms.json')

function readFile() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    if (d && typeof d.forms === 'object') return d
  } catch {
    /* missing/corrupt -> fresh */
  }
  return { forms: {} }
}

function writeFile(d) {
  try {
    d._meta = {
      file: 'crm-booking-forms.json',
      owner: 'Magic CRM app',
      purpose:
        'Per-project booking-form state: the link token, when it was sent, and the raw client submission. The answers are also written onto the project itself; this keeps the original as received.',
      cowork_guidance: 'Safe to read. The CRM manages this file. Do NOT delete or overwrite.',
    }
    fs.writeFileSync(FILE, JSON.stringify(d, null, 2) + '\n')
  } catch (e) {
    console.error('[crm-booking-form] could not write:', e?.message || e)
  }
}

export function formBaseUrl() {
  return FORM_BASE
}

// Unguessable per-project token. Stable once issued, so re-sending the link doesn't break an
// already-open form.
function newToken() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString('base64url')
}

export function loadForms() {
  return readFile().forms
}

export function loadForm(projectId) {
  return readFile().forms[projectId] || null
}

// Issue (or reuse) this project's booking-form link.
export function bookingFormLink(projectId) {
  const d = readFile()
  let rec = d.forms[projectId]
  if (!rec) {
    rec = { token: newToken(), createdAt: new Date().toISOString(), sentAt: '', submission: null, agreementSentAt: '' }
    d.forms[projectId] = rec
    writeFile(d)
  }
  return {
    token: rec.token,
    url: `${FORM_BASE}/book/?t=${rec.token}`,
    sentAt: rec.sentAt,
    submission: rec.submission,
    // What the client typed on the website's signing step: { name, date, signedAt, ip, agent }.
    // Null until they sign. THIS is the record of the agreement, not the PDF.
    signature: rec.signature || null,
    // Stamped once the countersigned PDF has been emailed to them for their records. Also the
    // double-send guard: the sender skips any project that already has this.
    agreementSentAt: rec.agreementSentAt || '',
    agreementError: rec.agreementError || '',
  }
}

// Record that the agreement PDF was emailed. Clears any previous failure note.
export function markAgreementSent(projectId) {
  const d = readFile()
  const rec = d.forms[projectId]
  if (!rec) return
  rec.agreementSentAt = new Date().toISOString()
  rec.agreementError = ''
  writeFile(d)
}

// Record that the auto-send FAILED, so the card can say so instead of looking like nothing happened.
// Deliberately does NOT set agreementSentAt, so the next sweep retries.
export function markAgreementError(projectId, message) {
  const d = readFile()
  const rec = d.forms[projectId]
  if (!rec) return
  rec.agreementError = String(message || '').slice(0, 300)
  writeFile(d)
}

// Stamp the token onto the project row. The edge function checks incoming tokens against this, so
// without it a submission is refused. Awaited by the caller before the link is handed out.
export async function registerToken(projectId) {
  if (CRM_STORE !== 'supabase') return
  const { token } = bookingFormLink(projectId)
  await sb().from('projects').update({ booking_token: token }).eq('id', projectId)
}

export function markSent(projectId) {
  const d = readFile()
  const rec = d.forms[projectId]
  if (!rec) return
  rec.sentAt = new Date().toISOString()
  writeFile(d)
}

// The payload the public form page needs: which questions to show, and anything we can prefill.
export function formBundle(token) {
  const d = readFile()
  const entry = Object.entries(d.forms).find(([, r]) => r.token === token)
  if (!entry) return null
  const [projectId, rec] = entry
  const project = loadAll().projects.find((p) => p.id === projectId)
  if (!project) return null
  const prefill = {}
  for (const f of BOOKING_FIELDS) {
    if (!f.key || f.key === 'projectNotesAppend') continue
    const v = project[f.key]
    if (v != null && String(v).trim()) prefill[f.id] = String(v)
  }
  return {
    token,
    client: project.client,
    performer: 'Michael Bloemeke',
    alreadySubmitted: !!rec.submission,
    fields: BOOKING_FIELDS.map(({ id, label, hint, type, options, required }) => ({ id, label, hint, type, options, required })),
    prefill,
  }
}

// ---------------------------------------------------------------------------
// Pulling a submission back in
// ---------------------------------------------------------------------------

// Write the answers onto the project. Returns the labels that were filled.
async function applyAnswers(projectId, answers) {
  const byId = Object.fromEntries((answers || []).map((a) => [a.id, a.value]))
  const filled = []
  for (const f of BOOKING_FIELDS) {
    const v = byId[f.id]
    if (v == null || String(v).trim() === '') continue
    if (!f.key) continue
    if (f.key === 'projectNotesAppend') continue // handled below, appended not overwritten (there are two)
    try {
      // Store times in 12-hour form; the CRM shows times that way everywhere. Dates stay ISO,
      // because eventDate is a sortable column and the UI formats it for display.
      const stored = f.type === 'time' ? displayValue(f, v) : String(v)
      await updateProjectField({ id: projectId, field: f.key, value: stored })
      filled.push(f.label)
    } catch (e) {
      // A field that no longer exists just gets skipped; the raw answer is still stored either way.
      // But LOG it: this catch once silently swallowed a genuine bug (a missing helper) and two
      // answers vanished with no trace. A skipped field should always leave a breadcrumb.
      console.error(`[crm-booking-form] could not write "${f.key}" for ${projectId}:`, e?.message || e)
    }
  }
  // Their free-text answers are APPENDED to project notes rather than overwriting Michael's own.
  // There are two of them now, so each is labelled with the question it answered; a bare paragraph
  // with no context is worse than no note at all when he reads this before the event.
  const noteBlocks = BOOKING_FIELDS.filter((f) => f.key === 'projectNotesAppend')
    .map((f) => ({ label: f.label, value: String(byId[f.id] || '').trim() }))
    .filter((n) => n.value)
  if (noteBlocks.length) {
    const project = loadAll().projects.find((p) => p.id === projectId)
    const existing = String(project?.projectNotes || '').trim()
    const added = noteBlocks.map((n) => `${n.label}\n${n.value}`).join('\n\n')
    await updateProjectField({
      id: projectId,
      field: 'projectNotes',
      value: existing ? `${existing}\n\n${added}` : added,
    })
    filled.push('Notes')
  }
  return filled
}

// Fetch this project's submission from Supabase and apply it. A submission that has already been
// applied is a no-op, so re-checking never clobbers Michael's later manual edits.
//
// This used to poll a public blob URL. It now reads the same database everything else lives in, so
// there is no third party in the path and nothing to be suspended.
export async function pullSubmission(projectId) {
  const d = readFile()
  const rec = d.forms[projectId]
  if (!rec) return { ok: false, error: 'No booking form has been created for this project.' }
  if (CRM_STORE !== 'supabase') return { ok: false, error: 'Booking forms need the Supabase store.' }

  let row = null
  try {
    const { data, error } = await sb()
      .from('booking_submissions')
      .select('project_id, answers, submitted_at, signed_name, signed_date, signed_at, signer_ip, signer_agent')
      .eq('project_id', projectId)
      .maybeSingle()
    if (error) return { ok: false, error: error.message }
    row = data
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
  if (!row) return { ok: true, fresh: false, submission: rec.submission }

  // The signature is pulled in on every check, independently of the answers. They arrive as two
  // separate events (they fill the form, then they sign), so a submission we have already applied
  // can still be carrying a signature we have not seen yet.
  let freshSignature = false
  if (row.signed_at && !rec.signature) {
    rec.signature = {
      name: String(row.signed_name || ''),
      date: String(row.signed_date || ''),
      signedAt: new Date(row.signed_at).toISOString(),
      ip: String(row.signer_ip || ''),
      agent: String(row.signer_agent || ''),
    }
    freshSignature = true
    writeFile(d)
    try {
      await appendActivityLog(projectId, `Agreement signed online by ${rec.signature.name}.`)
    } catch {
      /* the log line is a nicety, never fail the pull over it */
    }
  }

  const submittedAt = new Date(row.submitted_at).toISOString()
  if (rec.submission && rec.submission.submittedAt === submittedAt) {
    return { ok: true, fresh: false, freshSignature, submission: rec.submission, signature: rec.signature || null }
  }

  const answers = Array.isArray(row.answers) ? row.answers : []
  const filled = await applyAnswers(projectId, answers)
  rec.submission = { submittedAt, answers }
  writeFile(d)
  try {
    await appendActivityLog(projectId, `Booking form submitted by the client. Filled: ${filled.join(', ') || 'nothing new'}.`)
  } catch {
    /* the log line is a nicety, never fail the pull over it */
  }
  try {
    await sb().from('booking_submissions').update({ seen: true }).eq('project_id', projectId)
  } catch {
    /* cosmetic flag only */
  }
  return { ok: true, fresh: true, freshSignature, submission: rec.submission, signature: rec.signature || null, filledFields: filled }
}

// Drop everything a previous booking attempt left in the local mirror, keeping the TOKEN so a link
// already in the client's inbox still resolves (and now serves the corrected agreement).
export function clearLocalBooking(projectId) {
  const d = readFile()
  const rec = d.forms[projectId]
  if (!rec) return
  rec.submission = null
  rec.signature = null
  rec.agreementSentAt = ''
  rec.agreementError = ''
  rec.sentAt = new Date().toISOString()
  writeFile(d)
}

// What the client typed on the signing step, or null if they haven't signed yet.
export function loadSignature(projectId) {
  return loadForm(projectId)?.signature || null
}

// Where the client has got to, read LIVE from Supabase rather than from the local mirror.
//
// This is what replaced the "Check for answers" button. The card polls it while a project is open,
// so the status moves on its own. Two tiny reads (one column from each of two tables), which is
// nothing next to the 21-table reload the egress work was about.
//
// Returns 'none' | 'viewed' | 'submitted' | 'signed'. Never throws: a status bar that goes blank on
// a flaky connection is better than one that breaks the page.
export async function liveProgress(projectId) {
  if (CRM_STORE !== 'supabase') return { stage: 'none', viewedAt: '', submittedAt: '', signedAt: '' }
  try {
    const [{ data: proj }, { data: row }] = await Promise.all([
      sb().from('projects').select('booking_viewed_at, booking_sent_at, agreement_variant').eq('id', projectId).maybeSingle(),
      sb().from('booking_submissions').select('submitted_at, signed_at, signed_name').eq('project_id', projectId).maybeSingle(),
    ])
    const iso = (v) => (v ? new Date(v).toISOString() : '')
    const sentAt = iso(proj?.booking_sent_at)
    const viewedAt = iso(proj?.booking_viewed_at)
    const submittedAt = iso(row?.submitted_at)
    const signedAt = iso(row?.signed_at)
    const stage = signedAt ? 'signed' : submittedAt ? 'submitted' : viewedAt ? 'viewed' : 'none'
    return { stage, sentAt, viewedAt, submittedAt, signedAt, signedName: String(row?.signed_name || ''), variant: String(proj?.agreement_variant || '') }
  } catch {
    return { stage: 'none', sentAt: '', viewedAt: '', submittedAt: '', signedAt: '', unavailable: true }
  }
}

// House rules for anything Michael or a client READS: dates written out, times in 12-hour.
// A date input posts '2026-11-14' and a time input posts '18:00', so both get converted here rather
// than landing raw on the document or the project.
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
function ordinal(n) {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`
  return `${n}${['th','st','nd','rd'][n % 10] || 'th'}`
}
function prettyDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v).trim())
  if (!m) return String(v).trim()
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (Number.isNaN(d.getTime())) return String(v).trim()
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']
  return `${days[d.getDay()]}, ${MONTHS[d.getMonth()]} ${ordinal(d.getDate())}, ${d.getFullYear()}`
}
function prettyTime(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v).trim())
  if (!m) return String(v).trim()
  let h = Number(m[1])
  const suffix = h >= 12 ? 'PM' : 'AM'
  h = h % 12 || 12
  return `${h}:${m[2]} ${suffix}`
}
export function displayValue(field, raw) {
  const v = String(raw ?? '').trim()
  if (!v) return ''
  if (field.type === 'date') return prettyDate(v)
  if (field.type === 'time') return prettyTime(v)
  return v
}

// What the client told us, as label/value pairs, for the agreement's summary page.
export function submissionSummary(projectId) {
  const rec = loadForm(projectId)
  if (!rec?.submission) return []
  const byId = Object.fromEntries((rec.submission.answers || []).map((a) => [a.id, a.value]))
  return BOOKING_FIELDS.filter((f) => String(byId[f.id] ?? '').trim()).map((f) => ({
    label: f.label,
    value: displayValue(f, byId[f.id]),
  }))
}

// Who the invoice should be addressed to, per their own answer.
export function invoiceTarget(projectId) {
  const rec = loadForm(projectId)
  const byId = Object.fromEntries((rec?.submission?.answers || []).map((a) => [a.id, a.value]))
  return {
    name: String(byId.invoice_to || '').trim(),
    email: String(byId.invoice_email || '').trim(),
  }
}

// Where do we send the booking form?
//
// A project stores contact details TWICE, and only one was ever consulted here:
//
//   1. projects.contact_emails, plain text on the project. The website inquiry function fills this
//      in, so leads that arrive through the site have always worked.
//   2. The linked CONTACT record, via contact_links. This is what the project page's Contact section
//      and the contact side-panel actually display.
//
// So a project created BY HAND, with an existing contact linked to it, showed an email on screen
// while contact_emails sat empty, and "Ready to book" refused with "no client email to send to".
// Michael hit exactly that on 2026-08-04 and reasonably replied "i do have his email as you can see".
// He was right; the code was looking in one drawer while the UI showed him the other.
//
// Now: the project's own field wins if set, otherwise the first linked contact with an email.
export function clientEmailFor(project) {
  const direct = String(project?.contactEmails || '').split(/[,;]/)[0].trim()
  if (direct) return direct
  try {
    if (CRM_STORE !== 'supabase') return ''
    const ids = getCachedLinksMap()[project.id] || []
    if (!ids.length) return ''
    const byId = new Map(getCachedContacts().map((c) => [c.id, c]))
    for (const id of ids) {
      // contacts.emails is a Postgres ARRAY, unlike projects.contact_emails which is comma-separated
      // text. Handle both rather than relying on Array.toString() joining with commas by luck.
      const raw = byId.get(id)?.emails
      const list = Array.isArray(raw) ? raw : String(raw || '').split(/[,;]/)
      const email = list.map((e) => String(e || '').trim()).find(Boolean)
      if (email) return email
    }
  } catch {
    // A cache that is not warm yet must not turn into a confusing failure; fall through to "none"
    // and let the caller say so plainly.
  }
  return ''
}

// ---------------------------------------------------------------------------
// "Ready to book": issue the link and put a ready-to-send draft in Gmail
// ---------------------------------------------------------------------------

// Draft (never send) the email that carries the booking-form link. Michael reviews and sends it
// himself from Gmail, which is both his own standing rule and where he now writes everything.
export async function draftBookingEmail(projectId, { createDraft, project }) {
  // GATES: everything the client will SEE on the agreement has to be right before the link goes out.
  //
  // This is the last moment Michael is in the loop. The instant they finish the booking form the
  // website shows them the agreement and asks them to sign it, so there is no later step at which a
  // blank field could be caught. A missing value renders as a literal "[Performance scope]" or
  // "[Booking fee]" in the contract text, in front of the client, on the document they are signing.
  //
  // All three are Michael's own facts, never asked of the client, so they can only come from the
  // project. The event date is deliberately NOT a question on the form (he does not want a client
  // to think the date is theirs to change), which is exactly why it has to be gated here: with it
  // blank the agreement's Event clause reads a literal "Date: [Event date]".
  const missing = []
  if (!String(project.performanceStyle || '').trim()) missing.push('performance style')
  if (project.totalFee == null || String(project.totalFee).trim() === '' || Number(project.totalFee) <= 0) {
    missing.push('quote')
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(project.eventDate || '').trim())) missing.push('event date')
  if (missing.length) {
    throw new Error(
      `Set the ${missing.join(' and ')} in Event details first. The client signs the agreement on the website straight after the booking form, so this has to be right before the link goes out.`,
    )
  }
  await registerToken(projectId)
  const link = bookingFormLink(projectId)
  const to = clientEmailFor(project)
  if (!to) {
    throw new Error(
      'No client email on this project. Add one in the Contact section, or on the linked contact record.',
    )
  }
  const { subject, text, html } = bookingFormEmail({ project, url: link.url })
  const draft = await createDraft({ to, subject, body: text, html })
  markSent(projectId)
  // Remember the thread. Sending a draft keeps it, so this is what the CONTRACT email replies into
  // later, which is the whole point of "not a thousand separate threads in their inbox".
  if (CRM_STORE === 'supabase' && draft?.threadId) {
    try {
      await sb().from('projects').update({ booking_thread_id: draft.threadId }).eq('id', projectId)
    } catch {
      /* the reply falls back to a fresh thread rather than failing the send */
    }
  }
  return { ok: true, to, url: link.url, threadId: draft?.threadId || '' }
}

