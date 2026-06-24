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
import { sendMessage, isConnected as gmailConnected } from './crm-gmail.mjs'

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
function readStore() {
  let d
  try {
    d = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'))
  } catch {
    d = null
  }
  if (!d || typeof d.inquiries !== 'object' || d.inquiries === null) d = { inquiries: {} }
  return d
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
  if (inq.eventTime) extras.push(`Time: ${inq.eventTime}`)
  if (inq.source) extras.push(`Heard about Michael via: ${inq.source}`)
  if (extras.length) lines.push(extras.join(' · '))
  return lines.join('\n\n')
}

// Poll the relay and import any inquiries not seen before: create a project (Inquiry stage),
// fill the mapped fields, and raise a notification. Returns { ok, created, importedCount }.
export async function importNewInquiries() {
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
      const proj = createProject({
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
        eventStartTime: String(inq.eventTime || ''),
        numberOfGuests: String(inq.guests || ''),
        ageOfGuests: String(inq.ages || ''),
        bookingSource: String(inq.source || ''),
        performanceStyle: String(inq.showTypes || ''),
        eventDescription: describe(inq),
      }
      for (const [field, value] of Object.entries(extra)) {
        if (!value) continue
        try {
          updateProjectField({ id: proj.id, field, value })
        } catch {
          // skip a field that won't take; the inquiry is still imported
        }
      }
      appendActivityLog(proj.id, 'New inquiry from the website contact form.')
    } catch (e) {
      // Most likely a duplicate project name; keep the notification so Michael sees it.
      note = String(e?.message || e)
    }
    store.inquiries[inq.id] = { name, email, eventDate: toISO(inq.eventDate), projectId, importedAt: now, dismissed: false, note }
    created.push({ id: inq.id, ...store.inquiries[inq.id] })
  }

  writeStore(store)
  return { ok: true, created, importedCount: created.filter((c) => c.projectId).length }
}

// Undismissed inquiry notifications, newest first.
export function listNotifications() {
  const store = readStore()
  return Object.entries(store.inquiries)
    .filter(([, v]) => v && !v.dismissed)
    .map(([id, v]) => ({ blockId: id, ...v }))
    .sort((a, b) => (b.importedAt || '').localeCompare(a.importedAt || ''))
}

export function dismissNotification(id) {
  const store = readStore()
  if (store.inquiries[id]) {
    store.inquiries[id].dismissed = true
    writeStore(store)
  }
  return { ok: true }
}

export function status() {
  return { configured: isConfigured(), unread: listNotifications().length }
}
