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
import { CRM_STORE, sb } from './crm-store.mjs'

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
  { id: 'event_date', key: 'eventDate', label: 'Event date', type: 'date', required: true },
  { id: 'event_location', key: 'eventLocation', label: 'Event address', hint: 'Full street address, including city and ZIP', type: 'textarea', required: true },
  { id: 'venue_type', key: 'venueType', label: 'What kind of venue is it?', hint: 'Private home, hotel ballroom, country club, restaurant, etc.', type: 'text', required: true },
  { id: 'indoors_or_outdoors', key: 'indoorsOrOutdoors', label: 'Indoors or outdoors?', type: 'select', options: ['Indoors', 'Outdoors', 'Both'], required: true },
  { id: 'event_start_time', key: 'eventStartTime', label: 'What time does the event start?', type: 'time', required: true },
  { id: 'show_start_time', key: 'showStartTime', label: 'What time would you like the magic to start?', type: 'time', required: true },
  { id: 'number_of_guests', key: 'numberOfGuests', label: 'Roughly how many guests?', type: 'text', required: true },
  { id: 'age_of_guests', key: 'ageOfGuests', label: 'Rough ages of the guests', hint: 'All adults, mixed, mostly kids, etc.', type: 'text', required: false },
  { id: 'vips', key: 'vips', label: 'Anyone special I should know about?', hint: 'Guest of honor, birthday, anniversary, someone who hates being picked on', type: 'textarea', required: false },
  { id: 'av', key: 'av', label: 'Is there a sound system or microphone available?', type: 'text', required: false },
  // Not a project field: this drives who the QuickBooks invoice is addressed to.
  { id: 'invoice_to', key: '', label: 'Who should the invoice be addressed to?', hint: 'A person or a company name, whichever your accounting needs', type: 'text', required: true },
  { id: 'invoice_email', key: '', label: 'Which email should the invoice go to?', type: 'email', required: true },
  { id: 'notes', key: 'projectNotesAppend', label: 'Anything else I should know?', type: 'textarea', required: false },
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
    if (f.key === 'projectNotesAppend') continue // handled below, appended not overwritten
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
  // Their free-text note is appended to project notes rather than overwriting Michael's.
  const note = String(byId.notes || '').trim()
  if (note) {
    const project = loadAll().projects.find((p) => p.id === projectId)
    const existing = String(project?.projectNotes || '').trim()
    const line = `From their booking form: ${note}`
    await updateProjectField({
      id: projectId,
      field: 'projectNotes',
      value: existing ? `${existing}\n\n${line}` : line,
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

// What the client typed on the signing step, or null if they haven't signed yet.
export function loadSignature(projectId) {
  return loadForm(projectId)?.signature || null
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
  // Both of these are Michael's own numbers, never asked of the client, so they can only come from
  // the project.
  const missing = []
  if (!String(project.performanceStyle || '').trim()) missing.push('performance style')
  if (project.totalFee == null || String(project.totalFee).trim() === '' || Number(project.totalFee) <= 0) {
    missing.push('quote')
  }
  if (missing.length) {
    throw new Error(
      `Set the ${missing.join(' and ')} in Event details first. The client signs the agreement on the website straight after the booking form, so this has to be right before the link goes out.`,
    )
  }
  await registerToken(projectId)
  const link = bookingFormLink(projectId)
  const to = String(project.contactEmails || '').split(/[,;]/)[0].trim()
  if (!to) throw new Error('This project has no client email to send to.')
  const first = String(project.client || '').trim().split(/\s+/)[0] || 'there'
  const subject = 'Booking details'
  const text = [
    `Hi ${first},`,
    '',
    'Great news, let\'s get you on the books. I just need a few details about the event.',
    '',
    'Here is the form:',
    link.url,
    '',
    'It takes about two minutes. Once you send it back I\'ll put together the agreement and the invoice.',
    '',
    'Thanks!',
    'Michael',
  ].join('\n')
  const html = [
    `<p>Hi ${escapeHtml(first)},</p>`,
    "<p>Great news, let's get you on the books. I just need a few details about the event.</p>",
    `<p><a href="${escapeHtml(link.url)}">Fill in your event details</a></p>`,
    "<p>It takes about two minutes. Once you send it back I'll put together the agreement and the invoice.</p>",
    '<p>Thanks!<br>Michael</p>',
  ].join('')
  await createDraft({ to, subject, body: text, html })
  markSent(projectId)
  return { ok: true, to, url: link.url }
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}
