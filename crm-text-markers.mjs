// Manual "this was sent" markers, one per project communication slot (kind) per channel
// ('email' or 'text'). Michael drafts in Gmail and sends from there, so the CRM records only that a
// given step happened and on what date. We deliberately do NOT store the message itself, just a flag
// plus a date. The two channels are independent: a slot can carry a text and no email, or both.
//
// Historical note: the table is still named text_markers (it began as an SMS-only flag) and the
// channel column was added 2026-07-31, defaulting existing rows to 'text'. The email markers for
// everything sent through the old in-CRM composer were backfilled from the emails table at the same
// time, which is why old projects show send dates that predate this feature.

import fs from 'node:fs'
import path from 'node:path'
import { RECORDS_DIR } from './crm-data-core.mjs'
import {
  CRM_STORE,
  getCachedTextMarkers,
  upsertTextMarker as sbUpsertTextMarker,
  deleteTextMarker as sbDeleteTextMarker,
  cacheUpsertTextMarker,
  cacheRemoveTextMarker,
} from './crm-store.mjs'

const FILE = path.join(RECORDS_DIR, 'crm-text-markers.json')

// Postgres returns timestamptz in offset form; the files store the JS "...Z" form. Collapse both to
// the identical instant so a supabase read matches the files byte-for-byte.
function isoZ(v) {
  const s = String(v ?? '').trim()
  if (!s) return ''
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? s : d.toISOString()
}
// Only these two channels exist; anything else falls back to 'text' (the pre-channel default).
function chan(v) {
  return v === 'email' ? 'email' : 'text'
}
// Raw DB marker row -> file-shape record (same object clean() produces from a file row).
function markerFromRow(r) {
  return {
    projectId: String(r.project_id || ''),
    kind: String(r.kind || ''),
    channel: chan(r.channel),
    sent: !!r.sent,
    date: typeof r.date === 'string' ? r.date : '',
    updatedAt: isoZ(r.updated_at),
  }
}
// File-shape record -> raw DB row.
function markerToRow(m) {
  return {
    project_id: String(m.projectId || ''),
    kind: String(m.kind || ''),
    channel: chan(m.channel),
    sent: !!m.sent,
    date: typeof m.date === 'string' ? m.date : '',
    updated_at: m.updatedAt || null,
  }
}

function meta() {
  return {
    file: 'crm-text-markers.json',
    owner: 'Magic CRM app (~/Desktop/Claude/magic-crm)',
    purpose:
      'Manual "this was sent" markers per project communication slot (kind) per channel (email | text). No message content is stored, only a sent flag + date (YYYY-MM-DD). Michael drafts and sends in Gmail; these are the CRM record that a step happened.',
    cowork_guidance: 'Safe to read. The CRM manages this file. Do NOT delete or overwrite.',
    shape: 'projectId (client_name slug), kind (comms-slot kind, e.g. followup-1 / checkin-2), channel ("email" | "text"), sent (bool), date (YYYY-MM-DD or ""), updatedAt (ISO)',
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
    channel: chan(m.channel),
    sent: !!m.sent,
    date: typeof m.date === 'string' ? m.date : '',
    updatedAt: m.updatedAt || '',
  }
}

export function loadTextMarkers(projectId) {
  const all =
    CRM_STORE === 'supabase' ? getCachedTextMarkers().map(markerFromRow) : readFileJson().markers.map(clean)
  return projectId ? all.filter((m) => m.projectId === projectId) : all
}

// Upsert a marker for (projectId, kind, channel). An "empty" marker (not sent, no date) is removed
// so the store doesn't accumulate dead rows when a flag is cleared.
export async function saveTextMarker({ projectId, kind, channel, sent, date } = {}) {
  if (!projectId || !kind) throw new Error('projectId and kind are required')
  const now = new Date().toISOString()
  const ch = chan(channel)
  const d = typeof date === 'string' ? date.trim() : ''
  const wantSent = !!sent

  if (CRM_STORE === 'supabase') {
    // Empty marker -> remove any existing row (matches the files path, which drops dead rows).
    if (!wantSent && !d) {
      cacheRemoveTextMarker(projectId, kind, ch)
      await sbDeleteTextMarker(projectId, kind, ch)
      return clean({ projectId, kind, channel: ch, sent: false, date: '', updatedAt: now })
    }
    const rec = { projectId, kind, channel: ch, sent: wantSent, date: d, updatedAt: now }
    const row = markerToRow(rec)
    cacheUpsertTextMarker(row)
    await sbUpsertTextMarker(row)
    return clean(rec)
  }

  const data = readFileJson()
  const existing = data.markers.find((m) => m.projectId === projectId && m.kind === kind && chan(m.channel) === ch)
  if (!wantSent && !d) {
    if (existing) data.markers = data.markers.filter((m) => m !== existing)
    writeFileJson(data)
    return clean({ projectId, kind, channel: ch, sent: false, date: '', updatedAt: now })
  }
  if (existing) {
    existing.channel = ch
    existing.sent = wantSent
    existing.date = d
    existing.updatedAt = now
    writeFileJson(data)
    return clean(existing)
  }
  const rec = { projectId, kind, channel: ch, sent: wantSent, date: d, updatedAt: now }
  data.markers.push(rec)
  writeFileJson(data)
  return clean(rec)
}
