// Status-change notifications (CRM-owned): invoice paid, contract viewed, contract signed. A
// background sweep (in crm-data-plugin) records an event the first time it detects each transition;
// the bell shows unseen events until Michael dismisses them. Deduped by kind + sourceId so each
// transition fires exactly once.

import fs from 'node:fs'
import path from 'node:path'
import { RECORDS_DIR, loadTasks } from './crm-data-core.mjs'
import { pushNotification } from './crm-push.mjs'
import {
  CRM_STORE,
  getCachedNotifications,
  upsertNotification as sbUpsertNotification,
  cacheUpsertNotification,
} from './crm-store.mjs'

// Count of tasks due now (today or overdue, not done): part of the phone app's icon badge.
function dueTaskCount() {
  try {
    const now = new Date()
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    return loadTasks().filter((t) => !t.done && t.dueDate && t.dueDate <= today).length
  } catch {
    return 0
  }
}

const FILE = path.join(RECORDS_DIR, 'crm-notifications.json')

function meta() {
  return {
    file: 'crm-notifications.json',
    owner: 'Magic CRM app (~/Desktop/Claude/magic-crm)',
    purpose:
      'Status-change notifications surfaced in the bell: invoice paid, contract viewed, contract signed. One event per transition (deduped by kind + sourceId), each with a seen flag.',
    cowork_guidance: 'Safe to read. CRM-owned, do NOT delete or overwrite.',
    shape: 'events[] = { id, projectId, kind (invoice-paid|contract-viewed|contract-signed), sourceId, createdAt, seen }',
  }
}

function read() {
  let d
  try {
    d = JSON.parse(fs.readFileSync(FILE, 'utf8'))
  } catch {
    d = null
  }
  if (!d || !Array.isArray(d.events)) d = { events: [] }
  return d
}
function write(d) {
  d._meta = meta()
  fs.writeFileSync(FILE, JSON.stringify(d, null, 2) + '\n')
}
const newId = () => 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

// Postgres returns timestamptz in offset form; the files store the JS "...Z" form. Collapse both to
// the identical instant so a supabase read matches the files byte-for-byte.
function isoZ(v) {
  const s = String(v ?? '').trim()
  if (!s) return ''
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? s : d.toISOString()
}
// Raw DB notification row -> file-shape event record.
function eventFromRow(r) {
  return {
    id: r.id,
    projectId: r.project_id == null ? '' : String(r.project_id),
    kind: r.kind == null ? '' : String(r.kind),
    sourceId: r.source_id == null ? '' : String(r.source_id),
    createdAt: isoZ(r.created_at),
    seen: !!r.seen,
  }
}
// File-shape event record -> raw DB row.
function eventToRow(ev) {
  return {
    id: ev.id,
    project_id: ev.projectId || '',
    kind: ev.kind || '',
    source_id: ev.sourceId == null ? '' : String(ev.sourceId),
    seen: !!ev.seen,
    created_at: ev.createdAt || null,
  }
}
// All events for the current backend, in file-shape.
function allEvents() {
  return CRM_STORE === 'supabase' ? getCachedNotifications().map(eventFromRow) : read().events
}

export function loadNotifications() {
  return allEvents()
}
export function loadUnseenNotifications() {
  return allEvents().filter((e) => e.seen === false)
}
// Add an event unless one for this kind+sourceId already exists. Returns the new event or null.
export async function addNotification(projectId, kind, sourceId) {
  if (CRM_STORE === 'supabase') {
    if (getCachedNotifications().some((e) => e.kind === kind && String(e.source_id) === String(sourceId))) return null
    const ev = { id: newId(), projectId, kind, sourceId: String(sourceId), createdAt: new Date().toISOString(), seen: false }
    const row = eventToRow(ev)
    cacheUpsertNotification(row)
    await sbUpsertNotification(row)
    pushNotification(ev, loadUnseenNotifications().length + dueTaskCount()).catch(() => {})
    return ev
  }
  const d = read()
  if (d.events.some((e) => e.kind === kind && e.sourceId === String(sourceId))) return null
  const ev = { id: newId(), projectId, kind, sourceId: String(sourceId), createdAt: new Date().toISOString(), seen: false }
  d.events.push(ev)
  write(d)
  // Mirror every new bell event to the phone's lock screen (best-effort). The count is the current
  // unseen total, used to set the number on the phone app's icon.
  pushNotification(ev, loadUnseenNotifications().length + dueTaskCount()).catch(() => {})
  return ev
}
export async function markNotificationSeen(id) {
  if (CRM_STORE === 'supabase') {
    const row = getCachedNotifications().find((e) => e.id === id)
    if (row && row.seen === false) {
      const updated = { ...row, seen: true }
      cacheUpsertNotification(updated)
      await sbUpsertNotification(updated)
    }
    return loadUnseenNotifications()
  }
  const d = read()
  const ev = d.events.find((e) => e.id === id)
  if (ev && ev.seen === false) {
    ev.seen = true
    write(d)
  }
  return loadUnseenNotifications()
}
