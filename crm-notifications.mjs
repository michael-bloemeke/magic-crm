// Status-change notifications (CRM-owned): invoice paid, contract viewed, contract signed. A
// background sweep (in crm-data-plugin) records an event the first time it detects each transition;
// the bell shows unseen events until Michael dismisses them. Deduped by kind + sourceId so each
// transition fires exactly once.

import fs from 'node:fs'
import path from 'node:path'
import { RECORDS_DIR } from './crm-data-core.mjs'

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

export function loadNotifications() {
  return read().events
}
export function loadUnseenNotifications() {
  return read().events.filter((e) => e.seen === false)
}
// Add an event unless one for this kind+sourceId already exists. Returns the new event or null.
export function addNotification(projectId, kind, sourceId) {
  const d = read()
  if (d.events.some((e) => e.kind === kind && e.sourceId === String(sourceId))) return null
  const ev = { id: newId(), projectId, kind, sourceId: String(sourceId), createdAt: new Date().toISOString(), seen: false }
  d.events.push(ev)
  write(d)
  return ev
}
export function markNotificationSeen(id) {
  const d = read()
  const ev = d.events.find((e) => e.id === id)
  if (ev && ev.seen === false) {
    ev.seen = true
    write(d)
  }
  return loadUnseenNotifications()
}
