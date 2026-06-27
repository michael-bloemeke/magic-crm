// Per-project values for USER-DEFINED custom event-detail fields (CRM-owned). The field
// DEFINITIONS (id + label) live in crm-config.json (customFields[], edited on the Settings page);
// this file holds each project's VALUE for those fields. Kept separate from the canonical project
// records so the shared Project Records JSON (which Cowork also reads) stays clean and no schema
// coordination is needed: custom fields are CRM-only data no other system has.
//
// A deleted custom field just disappears from the config definitions; any leftover value here is
// harmless (never shown, never matched, ids are random so they can't collide with a future field).

import fs from 'node:fs'
import path from 'node:path'
import { RECORDS_DIR } from './crm-data-core.mjs'

const FILE = path.join(RECORDS_DIR, 'crm-custom-fields.json')

function meta() {
  return {
    file: 'crm-custom-fields.json',
    owner: 'Magic CRM app (~/Desktop/Claude/magic-crm)',
    purpose:
      "Per-project values for user-defined custom event-detail fields. Field definitions (id + label) live in crm-config.json (customFields[]); this holds the values keyed by project then field id.",
    cowork_guidance: 'Safe to read. CRM-owned, do NOT delete or overwrite.',
    shape: 'values[projectId] = { [customFieldId]: stringValue }',
  }
}

function read() {
  let d
  try {
    d = JSON.parse(fs.readFileSync(FILE, 'utf8'))
  } catch {
    d = null
  }
  if (!d || typeof d.values !== 'object' || d.values === null) d = { values: {} }
  return d
}
function write(d) {
  d._meta = meta()
  fs.writeFileSync(FILE, JSON.stringify(d, null, 2) + '\n')
}

// All custom values for one project: { fieldId: value }.
export function loadCustomValues(projectId) {
  if (!projectId) return {}
  return read().values[projectId] || {}
}

// Set (or clear) one project's value for one custom field. Empty value drops the key.
export function setCustomValue({ projectId, fieldId, value } = {}) {
  if (!projectId) throw new Error('projectId is required')
  if (!fieldId) throw new Error('fieldId is required')
  const d = read()
  const cur = d.values[projectId] || {}
  const v = value == null ? '' : String(value)
  if (v.trim() === '') delete cur[fieldId]
  else cur[fieldId] = v
  d.values[projectId] = cur
  write(d)
  return { ok: true, projectId, fieldId, value: v }
}
