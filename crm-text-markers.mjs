// Manual "a text/SMS was sent" markers, one per project communication slot (kind), e.g. a follow-up
// or check-in that Michael handled by text instead of (or in addition to) email. We deliberately do
// NOT store the message itself — just a small flag plus an optional date. A marker is independent of
// the email record: a slot can have a sent text and no email, or both.

import fs from 'node:fs'
import path from 'node:path'
import { RECORDS_DIR } from './crm-data-core.mjs'

const FILE = path.join(RECORDS_DIR, 'crm-text-markers.json')

function meta() {
  return {
    file: 'crm-text-markers.json',
    owner: 'Magic CRM app (~/Desktop/Claude/magic-crm)',
    purpose:
      'Manual "a text/SMS was sent" markers per project communication slot (kind). No message content is stored, only a sent flag + optional date (YYYY-MM-DD). Independent of crm-emails.json.',
    cowork_guidance: 'Safe to read. The CRM manages this file. Do NOT delete or overwrite.',
    shape: 'projectId (client_name slug), kind (email-slot kind, e.g. followup-1 / checkin-2), sent (bool), date (YYYY-MM-DD or ""), updatedAt (ISO)',
  }
}

function readFileJson() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    if (d && Array.isArray(d.markers)) return d
  } catch {
    // missing/corrupt -> start fresh
  }
  return { markers: [] }
}

function writeFileJson(data) {
  try {
    data._meta = meta()
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n')
  } catch (e) {
    console.error('[crm-text-markers] could not write crm-text-markers.json:', e?.message || e)
  }
}

function clean(m) {
  return {
    projectId: String(m.projectId || ''),
    kind: String(m.kind || ''),
    sent: !!m.sent,
    date: typeof m.date === 'string' ? m.date : '',
    updatedAt: m.updatedAt || '',
  }
}

export function loadTextMarkers(projectId) {
  const all = readFileJson().markers.map(clean)
  return projectId ? all.filter((m) => m.projectId === projectId) : all
}

// Upsert a marker for (projectId, kind). An "empty" marker (not sent, no date) is removed so the
// store doesn't accumulate dead rows when a text flag is toggled back off.
export function saveTextMarker({ projectId, kind, sent, date } = {}) {
  if (!projectId || !kind) throw new Error('projectId and kind are required')
  const data = readFileJson()
  const now = new Date().toISOString()
  const d = typeof date === 'string' ? date.trim() : ''
  const wantSent = !!sent

  const existing = data.markers.find((m) => m.projectId === projectId && m.kind === kind)
  if (!wantSent && !d) {
    if (existing) data.markers = data.markers.filter((m) => m !== existing)
    writeFileJson(data)
    return clean({ projectId, kind, sent: false, date: '', updatedAt: now })
  }
  if (existing) {
    existing.sent = wantSent
    existing.date = d
    existing.updatedAt = now
    writeFileJson(data)
    return clean(existing)
  }
  const rec = { projectId, kind, sent: wantSent, date: d, updatedAt: now }
  data.markers.push(rec)
  writeFileJson(data)
  return clean(rec)
}
