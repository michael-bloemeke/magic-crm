// Website inquiry importer (CRM-owned). The contact form on Michael's website POSTs each
// submission to a small serverless relay (portal/api/inquiry.js on the Vercel "portal" project),
// which appends it to a single public Blob file (inquiries.json). This module polls that file,
// creates a project (Inquiry stage) for any submission it hasn't imported yet, and raises an
// in-CRM notification that stays until dismissed.
//
// Dedup is by the relay-assigned inquiry id, so a submission is never imported twice. Reads are
// the public Blob URL (no token needed); only the relay writes, using its own server-side token.
// The Blob base URL lives in portal-credentials.json (shared with the questionnaire sync).

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RECORDS_DIR, createProject, updateProjectField, appendActivityLog } from './crm-data-core.mjs'
import { insertInboxMessage, isConnected as gmailConnected } from './crm-gmail.mjs'
import { addNotification } from './crm-notifications.mjs'
// addNotification() itself fires the lock-screen push (with the {name} extra we pass), so we do NOT
// call pushNotification directly here — that would send two alerts for one inquiry.
import {
  CRM_STORE,
  getCachedInquiries,
  upsertInquiry as sbUpsertInquiry,
  cacheUpsertInquiry,
} from './crm-store.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CRED_FILE = path.join(HERE, 'portal-credentials.json')
const STORE_FILE = path.join(RECORDS_DIR, 'crm-inquiries.json')
const NOTIFY_TO = 'michael@michaelbloemeke.com' // new-inquiry alerts go to Michael's business inbox

function blobBaseUrl() {
  try {
    return String(JSON.parse(fs.readFileSync(CRED_FILE, 'utf8')).blobBaseUrl || '').replace(/\/+$/, '')
  } catch {
    return ''
  }
}
export function isConfigured() {
  return !!blobBaseUrl()
}

// --- store -----------------------------------------------------------------
// Read the whole { inquiries: { [id]: {...} } } object. Under supabase it is rebuilt from the
// row-per-inquiry jsonb cache (keyed by the relay inquiry id); under files it is the JSON file.
function readStore() {
  if (CRM_STORE === 'supabase') {
    const inquiries = {}
    for (const r of getCachedInquiries()) inquiries[r.id] = r.data
    return { inquiries }
  }
  let d
  try {
    d = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'))
  } catch {
    d = null
  }
  if (!d || typeof d.inquiries !== 'object' || d.inquiries === null) d = { inquiries: {} }
  return d
}
// Persist ONE inquiry record. Supabase: upsert its jsonb row (+ cache). Used by the write paths
// instead of writeStore under supabase (which rewrites the whole file).
async function persistInquiry(id, data) {
  const row = { id, data }
  cacheUpsertInquiry(row)
  await sbUpsertInquiry(row)
}
function writeStore(d) {
  d._meta = {
    file: 'crm-inquiries.json',
    owner: 'Magic CRM app (~/Desktop/Claude/magic-crm)',
    purpose:
      "Website contact-form inquiries imported from the Blob relay, keyed by the relay's inquiry id, each with an in-CRM notification state.",
    cowork_guidance: 'Safe to read. CRM-owned, do NOT overwrite.',
    shape: 'inquiries[id] = { name, email, eventDate, projectId, importedAt, dismissed, note? }',
  }
  fs.writeFileSync(STORE_FILE, JSON.stringify(d, null, 2) + '\n')
}

// "05/06/2026" or "2026-05-06" -> ISO "2026-05-06"; anything else -> '' (kept in the description).
function toISO(raw) {
  const s = String(raw || '').trim()
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
  return ''
}

// "18:00" / "18:00:00" -> "6:00 PM"; "09:30" -> "9:30 AM". The website's <input type="time"> posts a
// 24-hour "HH:MM", which we turn into a friendly 12-hour clock. Anything that isn't a bare HH:MM
// (already formatted, "6pm", empty) passes through untouched.
function to12h(raw) {
  const s = String(raw || '').trim()
  const m = s.match(/^(\d{1,2}):([0-5]\d)(?::[0-5]\d)?$/)
  if (!m) return s
  let h = Number(m[1])
  if (h > 23) return s
  const ampm = h < 12 ? 'AM' : 'PM'
  h = h % 12
  if (h === 0) h = 12
  return `${h}:${m[2]} ${ampm}`
}

// RFC 5322 display-name as a quoted-string (the sender label carries a colon, and client names carry
// commas/periods), with any embedded quote or backslash escaped.
function quotedName(s) {
  return `"${String(s || '').replace(/[\\"]/g, '\\$&')}"`
}
// A Date-header value for an inserted message so it sorts by submission time (falls back to now).
function mailDate(iso) {
  const d = new Date(iso)
  return (isNaN(d.getTime()) ? new Date() : d).toUTCString()
}

// Fetch the relay's inquiry list (public, always-fresh). Returns [] if not set up or empty.
async function fetchInquiries() {
  const base = blobBaseUrl()
  if (!base) return []
  const res = await fetch(`${base}/inquiries.json`, { cache: 'no-store' })
  if (res.status === 404) return []
  if (!res.ok) throw new Error(`Inquiry store returned ${res.status}.`)
  const d = await res.json()
  return Array.isArray(d) ? d : Array.isArray(d?.inquiries) ? d.inquiries : []
}

// Build a human-readable description from everything the form captured, so nothing is lost even
// for fields the project doesn't have a dedicated slot for.
function describe(inq) {
  const lines = []
  if (inq.message) lines.push(String(inq.message).trim())
  const extras = []
  if (inq.eventDate && !toISO(inq.eventDate)) extras.push(`Date: ${inq.eventDate}`)
  if (inq.eventTime) extras.push(`Time: ${to12h(inq.eventTime)}`)
  if (inq.source) extras.push(`Heard about Michael via: ${inq.source}`)
  if (extras.length) lines.push(extras.join(' · '))
  return lines.join('\n\n')
}

// Keep a clean copy of the raw form fields so the project page can show the original inquiry.
const FORM_FIELDS = ['name', 'email', 'phone', 'eventDate', 'eventTime', 'venue', 'guests', 'ages', 'showTypes', 'source', 'message', 'formLocation', 'submittedAt']
function cleanForm(inq) {
  const f = {}
  for (const k of FORM_FIELDS) {
    const v = inq && inq[k]
    if (v != null && String(v).trim() !== '') f[k] = String(v).trim()
  }
  return f
}
// The saved inquiry form for a project (newest matching record), as labeled fields for display.
const FORM_LABELS = [
  ['name', 'Name'], ['email', 'Email'], ['phone', 'Phone'], ['eventDate', 'Event date'],
  ['eventTime', 'Event time'], ['venue', 'Venue / location'], ['guests', 'Guest count'],
  ['ages', 'Guest ages'], ['showTypes', 'Performance interest'], ['source', 'How they heard'], ['message', 'Message'],
]
export function inquiryFormForProject(projectId) {
  if (!projectId) return null
  const store = readStore()
  let rec = null
  for (const v of Object.values(store.inquiries || {})) {
    if (v && v.projectId === projectId && v.form) { if (!rec || (v.importedAt || '') > (rec.importedAt || '')) rec = v }
  }
  if (!rec || !rec.form) return null
  const fields = FORM_LABELS.map(([k, label]) => ({ key: k, label, value: k === 'eventTime' ? to12h(rec.form[k]) : rec.form[k] })).filter((x) => x.value)
  return { submittedAt: rec.form.submittedAt || rec.importedAt || '', formLocation: rec.form.formLocation || '', fields }
}

// "2026-07-16" / "07/16/2026" -> "Thursday, July 16, 2026" (local, no timezone shift). Free-text or
// unparseable dates (e.g. "July 12th", a typo'd year) pass through unchanged.
function fmtEventDate(raw) {
  const s = String(raw || '').trim()
  if (!s) return ''
  let y, mo, d, m
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) { y = +m[1]; mo = +m[2]; d = +m[3] }
  else if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) { y = +m[3]; mo = +m[1]; d = +m[2] }
  else return s
  if (y < 1000) return s // guard against a mistyped year like "0026-08-15"
  const dt = new Date(y, mo - 1, d)
  if (isNaN(dt.getTime())) return s
  return dt.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
}

// Escape a value for safe interpolation into the notification HTML.
function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}

// The styled inbox alert Michael approved: a white card with a bold-label / value table. Built from
// the same `rows` as the plain-text fallback so the two never drift apart.
const INQ_TD_LABEL = 'padding:8px 20px 8px 0;font-weight:700;color:#111;vertical-align:top;white-space:nowrap;'
const INQ_TD_VALUE = 'padding:8px 0;color:#333;vertical-align:top;'
function inquiryHtml({ rows, message, crmLine, formLocation }) {
  const trs = rows
    .map(([label, value]) => `<tr><td style="${INQ_TD_LABEL}">${esc(label)}</td><td style="${INQ_TD_VALUE}">${esc(value)}</td></tr>`)
    .join('')
  const messageBlock = message
    ? `<p style="margin:26px 0 6px;font-weight:700;color:#111;">Message</p><p style="margin:0;color:#333;white-space:pre-wrap;">${esc(message)}</p>`
    : ''
  const footer = formLocation
    ? `<p style="margin:22px 0 0;color:#8a8a8a;font-size:13px;">Submitted from the <strong>${esc(formLocation)}</strong> form.</p>`
    : ''
  return (
    `<!doctype html><html><body style="margin:0;padding:0;background:#f4f4f5;">` +
    `<div style="max-width:600px;margin:0 auto;padding:32px 28px;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.7;color:#333;">` +
    `<p style="margin:0 0 24px;font-size:16px;color:#111;">A new inquiry just came in through the website contact form.</p>` +
    `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:15px;line-height:1.6;">${trs}</table>` +
    messageBlock +
    `<p style="margin:26px 0 0;color:#555;">${esc(crmLine)}</p>` +
    footer +
    `</div></body></html>`
  )
}

// Email Michael a copy of a fresh inquiry. Best-effort: returns false (never throws) if Gmail
// isn't connected or the send fails, so a notification problem never blocks the CRM import.
async function notifyByEmail(inq, projectId) {
  try {
    if (!gmailConnected()) return false
    const name = String(inq.name || '').trim()
    const email = String(inq.email || '').trim()
    const rows = [
      ['Name', name],
      ['Email', email],
      ['Phone', String(inq.phone || '').trim()],
      ['Event date', fmtEventDate(inq.eventDate)],
      ['Event time', to12h(inq.eventTime)],
      ['Venue', String(inq.venue || '').trim()],
      ['Guests', String(inq.guests || '').trim()],
      ['Guest ages', String(inq.ages || '').trim()],
      ['Show type', String(inq.showTypes || '').trim()],
      ['Heard about Michael via', String(inq.source || '').trim()],
    ].filter(([, v]) => v)
    const formLocation = String(inq.formLocation || '').trim()
    const message = String(inq.message || '').trim()
    const crmLine = projectId
      ? 'It has been added to your CRM as a new project in the Inquiry stage.'
      : 'Note: the CRM could not auto-create a project for this one (most likely a duplicate name). It is in your inquiries list.'

    // Plain-text fallback (rides along as the multipart/alternative text part), from the same rows.
    const lines = ['A new inquiry just came in through the website contact form.', '']
    for (const [label, value] of rows) lines.push(`${label}: ${value}`)
    if (message) lines.push('', 'Message:', message)
    lines.push('', crmLine)
    if (formLocation) lines.push('', `Submitted from the ${formLocation} form.`)

    const html = inquiryHtml({ rows, message, crmLine, formLocation })
    const subject = `New website inquiry${formLocation ? ` (${formLocation})` : ''}: ${name || email || 'someone'}`
    // Make the inbox show "Form Fill: <client>" as the sender instead of Gmail's "me". A normal send
    // from Michael's address to his own address always renders as "me" (Gmail ignores the display name
    // on your own send-as address), so we INSERT the message with a non-account From. Reply-To points
    // at the client so hitting reply reaches them. See insertInboxMessage in crm-gmail.mjs.
    const from = `${quotedName(`Form Fill: ${name || email || 'Website inquiry'}`)} <inquiries@michaelbloemeke.com>`
    const replyTo = email ? `${quotedName(name || email)} <${email}>` : undefined
    await insertInboxMessage({ from, to: NOTIFY_TO, replyTo, subject, body: lines.join('\n'), html, date: mailDate(inq.submittedAt) })
    return true
  } catch (e) {
    console.warn('[crm-inquiries] email notify failed:', e?.message || e)
    return false
  }
}

// Coalescing guard: importing runs in the single dev-server process, but several frontends (the
// app window plus any open browser tab) each poll on their own timer. Without this, two near-
// simultaneous polls would both see the same inquiry as "new" and each create a project + send an
// email (the duplicate-email bug). While one import is in flight, concurrent callers share its
// promise, so the work (and the email) happens exactly once per inquiry.
let inFlight = null
export async function importNewInquiries() {
  if (inFlight) return inFlight
  inFlight = runImport()
  try {
    return await inFlight
  } finally {
    inFlight = null
  }
}

// Poll the relay and import any inquiries not seen before: create a project (Inquiry stage),
// fill the mapped fields, and raise a notification. Returns { ok, created, importedCount }.
async function runImport() {
  if (!isConfigured()) return { ok: false, error: "Inquiry sync isn't set up yet (missing blobBaseUrl)." }
  let list
  try {
    list = await fetchInquiries()
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
  const store = readStore()
  const now = new Date().toISOString()
  const created = []

  for (const inq of list) {
    if (!inq || !inq.id || store.inquiries[inq.id]) continue
    const name = String(inq.name || '').trim()
    const email = String(inq.email || '').trim()
    let projectId = null
    let note = ''
    try {
      const proj = await createProject({
        clientName: name || email || 'Website inquiry',
        contactNames: name,
        contactEmails: email,
        contactPhones: String(inq.phone || ''),
        eventDate: toISO(inq.eventDate),
        eventLocation: String(inq.venue || ''),
      })
      projectId = proj.id
      // Fields createProject doesn't take directly; set them after (best-effort).
      const extra = {
        eventStartTime: to12h(inq.eventTime),
        numberOfGuests: String(inq.guests || ''),
        ageOfGuests: String(inq.ages || ''),
        bookingSource: String(inq.source || ''),
        performanceStyle: String(inq.showTypes || ''),
        eventDescription: describe(inq),
      }
      for (const [field, value] of Object.entries(extra)) {
        if (!value) continue
        try {
          await updateProjectField({ id: proj.id, field, value })
        } catch {
          // skip a field that won't take; the inquiry is still imported
        }
      }
      const formLabel = String(inq.formLocation || '').trim()
      await appendActivityLog(proj.id, `New inquiry from the website contact form${formLabel ? ` (${formLabel})` : ''}.`)
    } catch (e) {
      // Most likely a duplicate project name; keep the notification so Michael sees it.
      note = String(e?.message || e)
    }
    const emailed = await notifyByEmail(inq, projectId)
    store.inquiries[inq.id] = { name, email, eventDate: toISO(inq.eventDate), projectId, importedAt: now, dismissed: false, note, emailed, form: cleanForm(inq) }
    created.push({ id: inq.id, ...store.inquiries[inq.id] })
    // Raise the SPECIAL new-inquiry bell event (deduped by the relay inquiry id) and fire the
    // high-priority lock-screen push with the lead's name. Only when a project was actually created,
    // so a duplicate-name failure doesn't leave a bell event pointing at no project. Best-effort:
    // a notification/push problem never blocks the import.
    if (projectId) {
      try {
        await addNotification(projectId, 'new-inquiry', inq.id, { name: name || email })
      } catch (e) {
        console.warn('[crm-inquiries] new-inquiry notification failed:', e?.message || e)
      }
    }
    // Supabase: persist each new inquiry as its own row as it's created (files: one write below).
    if (CRM_STORE === 'supabase') await persistInquiry(inq.id, store.inquiries[inq.id])
  }

  if (CRM_STORE !== 'supabase') writeStore(store)
  return { ok: true, created, importedCount: created.filter((c) => c.projectId).length }
}

// The whole { [id]: inquiryRecord } map (includes dismissed). Symmetric with loadPortals/
// loadRecipients/loadInvoices/loadContracts/loadQuestionnaires; used by the backup exporter and the
// parity gate to see every stored inquiry, not just the undismissed subset.
export function loadInquiries() {
  return readStore().inquiries
}

// Undismissed inquiry notifications, newest first.
export function listNotifications() {
  const store = readStore()
  return Object.entries(store.inquiries)
    .filter(([, v]) => v && !v.dismissed)
    .map(([id, v]) => ({ blockId: id, ...v }))
    .sort((a, b) => (b.importedAt || '').localeCompare(a.importedAt || ''))
}

export async function dismissNotification(id) {
  const store = readStore()
  if (store.inquiries[id]) {
    store.inquiries[id].dismissed = true
    if (CRM_STORE === 'supabase') await persistInquiry(id, store.inquiries[id])
    else writeStore(store)
  }
  return { ok: true }
}

export function status() {
  return { configured: isConfigured(), unread: listNotifications().length }
}
