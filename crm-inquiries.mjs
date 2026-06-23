// HoneyBook inquiry importer (CRM-owned). TEMPORARY bridge until the website's own contact form
// replaces HoneyBook. Zapier appends each new HoneyBook inquiry as a text block to the Notion
// "HoneyBook Activity Log" page; this module reads that page via the Notion API, parses the
// "New Inquiry" blocks, and auto-creates a project (in the Inquiry stage) for any not yet seen.
//
// Two safeguards:
//  - Dedup by Notion BLOCK ID, so an inquiry is never imported twice.
//  - BASELINE on first run: the existing backlog is recorded as "already seen" WITHOUT creating
//    projects, so only inquiries that arrive AFTER setup import. (Otherwise the first poll would
//    resurrect every historical inquiry as a new project.)
//
// Each genuine import also raises an in-CRM notification that stays until dismissed.
// Credentials live in notion-credentials.json (gitignored): { token, activityLogPageId }.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RECORDS_DIR, createProject, updateProjectField, appendActivityLog } from './crm-data-core.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CRED_FILE = path.join(HERE, 'notion-credentials.json')
const STORE_FILE = path.join(RECORDS_DIR, 'crm-inquiries.json')
const NOTION_VERSION = '2022-06-28'

function creds() {
  try {
    return JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'))
  } catch {
    return null
  }
}
export function isConfigured() {
  const c = creds()
  return !!(c && c.token && c.activityLogPageId && !String(c.token).startsWith('PASTE'))
}

// --- store -----------------------------------------------------------------
function readStore() {
  let d
  try {
    d = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'))
  } catch {
    d = null
  }
  if (!d || typeof d.inquiries !== 'object' || d.inquiries === null) d = { inquiries: {}, baselinedAt: '' }
  if (typeof d.baselinedAt !== 'string') d.baselinedAt = ''
  return d
}
function writeStore(d) {
  d._meta = {
    file: 'crm-inquiries.json',
    owner: 'Magic CRM app (~/Desktop/Claude/magic-crm)',
    purpose:
      'HoneyBook inquiries imported from the Notion Activity Log (Zapier-fed), keyed by Notion block id, each with an in-CRM notification state. Baseline marks the pre-setup backlog as seen so only new inquiries import.',
    cowork_guidance: 'Safe to read. CRM-owned, do NOT overwrite.',
    shape: 'inquiries[blockId] = { name, email, eventDate, projectId, importedAt, dismissed, baseline?, note? }; baselinedAt (ISO)',
  }
  fs.writeFileSync(STORE_FILE, JSON.stringify(d, null, 2) + '\n')
}

// --- parsing ---------------------------------------------------------------
// Drop markdown link wrappers ([text](url) -> text) and collapse whitespace.
function tidy(s) {
  return String(s || '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}
// "05/06/2026" -> "2026-05-06"; blank/unrecognized -> ''.
function toISO(mdy) {
  const m = String(mdy || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (!m) return ''
  return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
}

const LABELS = ['Name', 'Email', 'Phone', 'Date', 'Location', 'Description']
function getField(text, label) {
  if (label === 'Description') {
    const m = text.match(/Description\s*:\s*([\s\S]*)$/i)
    return m ? tidy(m[1]) : ''
  }
  const others = LABELS.filter((l) => l !== label).join('|')
  const re = new RegExp(`${label}\\s*:\\s*([\\s\\S]*?)(?=(?:${others})\\s*:|$)`, 'i')
  const m = text.match(re)
  return m ? tidy(m[1]) : ''
}

// Parse a "New Inquiry" block into fields, or null if the block isn't a New Inquiry.
export function parseInquiry(text) {
  if (!/New Inquiry\s*:/i.test(String(text || ''))) return null
  const name = getField(text, 'Name')
  const email = getField(text, 'Email')
  if (!name && !email) return null
  return {
    name,
    email,
    phone: getField(text, 'Phone'),
    eventDate: toISO(getField(text, 'Date')),
    location: getField(text, 'Location'),
    description: getField(text, 'Description'),
  }
}

// --- Notion fetch ----------------------------------------------------------
function blockText(b) {
  const body = b && b.type ? b[b.type] : null
  const rt = body && Array.isArray(body.rich_text) ? body.rich_text : null
  return rt ? rt.map((x) => x.plain_text || '').join('') : ''
}

async function fetchBlocks() {
  const c = creds()
  const pageId = String(c.activityLogPageId).replace(/-/g, '')
  const out = []
  let cursor
  do {
    const url = new URL(`https://api.notion.com/v1/blocks/${pageId}/children`)
    url.searchParams.set('page_size', '100')
    if (cursor) url.searchParams.set('start_cursor', cursor)
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${c.token}`, 'Notion-Version': NOTION_VERSION },
    })
    if (!res.ok) {
      const t = await res.text()
      throw new Error(`Notion API ${res.status}: ${t.slice(0, 200)}`)
    }
    const d = await res.json()
    for (const b of d.results || []) out.push(b)
    cursor = d.has_more ? d.next_cursor : null
  } while (cursor)
  return out
}

// --- import + notifications ------------------------------------------------
// Find every New Inquiry block; on first run, record them all as a baseline (no projects). After
// that, create a project for each new one and raise a notification. Dedup by block id.
export async function importNewInquiries() {
  if (!isConfigured()) return { ok: false, error: "Inquiry sync isn't set up yet (add notion-credentials.json)." }
  let blocks
  try {
    blocks = await fetchBlocks()
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
  const store = readStore()
  const firstRun = !store.baselinedAt
  const now = new Date().toISOString()
  const created = []
  let baselined = 0

  for (const b of blocks) {
    const inq = parseInquiry(blockText(b))
    if (!inq) continue
    if (store.inquiries[b.id]) continue

    if (firstRun) {
      // Pre-setup backlog: mark as seen, don't create a project or notify.
      store.inquiries[b.id] = { name: inq.name, email: inq.email, eventDate: inq.eventDate, projectId: null, importedAt: now, dismissed: true, baseline: true }
      baselined++
      continue
    }

    let projectId = null
    let note = ''
    try {
      const proj = createProject({
        clientName: inq.name || inq.email || 'New inquiry',
        contactNames: inq.name,
        contactEmails: inq.email,
        contactPhones: inq.phone,
        eventDate: inq.eventDate,
        eventLocation: inq.location,
      })
      projectId = proj.id
      if (inq.description) {
        try {
          updateProjectField({ id: proj.id, field: 'eventDescription', value: inq.description })
        } catch {
          // description is best-effort
        }
      }
      appendActivityLog(proj.id, `New inquiry imported from HoneyBook${inq.eventDate ? ` (event ${inq.eventDate})` : ''}.`)
    } catch (e) {
      // Most likely a name collision with an existing project; keep the notification so Michael
      // sees it and can handle the duplicate, but don't retry it.
      note = String(e?.message || e)
    }
    store.inquiries[b.id] = { name: inq.name, email: inq.email, eventDate: inq.eventDate, projectId, importedAt: now, dismissed: false, note }
    created.push({ blockId: b.id, ...store.inquiries[b.id] })
  }

  if (firstRun) store.baselinedAt = now
  writeStore(store)
  return { ok: true, firstRun, baselined, created, importedCount: created.filter((c) => c.projectId).length }
}

// Undismissed inquiry notifications, newest first.
export function listNotifications() {
  const store = readStore()
  return Object.entries(store.inquiries)
    .filter(([, v]) => v && !v.dismissed)
    .map(([blockId, v]) => ({ blockId, ...v }))
    .sort((a, b) => (b.importedAt || '').localeCompare(a.importedAt || ''))
}

export function dismissNotification(blockId) {
  const store = readStore()
  if (store.inquiries[blockId]) {
    store.inquiries[blockId].dismissed = true
    writeStore(store)
  }
  return { ok: true }
}

export function status() {
  const store = readStore()
  return { configured: isConfigured(), baselined: !!store.baselinedAt, unread: listNotifications().length }
}
