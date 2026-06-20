// Contacts: first-class people/orgs (clients, vendors, associates), separate
// from projects. A contact can exist with zero projects (e.g. a vendor you've
// only emailed). Projects are LINKED to a contact by matching email/name; that
// link is derived on the client, not stored, so renaming a project can't break it.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { RECORDS_DIR, loadAll } from './crm-data-core.mjs'
import { formatPhone } from './crm-phone.mjs'

const CONTACTS_FILE = path.join(RECORDS_DIR, 'crm-contacts.json')

const TYPES = ['client', 'vendor', 'associate', 'other']
// 'active' = still in the pipeline (an open project). yes/no/maybe are the
// durable dispositions Michael assigns once a client LEAVES the pipeline
// (archived/completed). So a contact is 'active' while working, then he tags
// them yes/no/maybe at archive/complete time.
const RELATIONSHIPS = ['yes', 'no', 'maybe', 'active', '']
const ENGAGEMENTS = ['emailed', 'collaborated', '']

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}
function list(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean)
  return String(v ?? '')
    .split(/[,;]/)
    .map((x) => x.trim())
    .filter(Boolean)
}
function norm(s) {
  return String(s || '').trim().toLowerCase()
}
function meta() {
  return {
    file: 'crm-contacts.json',
    owner: 'Magic CRM app (~/Desktop/Claude/magic-crm)',
    purpose:
      'First-class contacts (clients, vendors, associates). relationship = durable yes/no/maybe client disposition; type = client/vendor/associate/other; engagement = emailed/collaborated (for vendors/associates); tags = free-form; notes = free text. Projects are linked by email/name match (not stored here).',
    cowork_guidance: 'Safe to read. The CRM manages this file.',
    shape: 'id, name, emails[], phones[], type, relationship, engagement, tags[], notes, createdAt, updatedAt',
  }
}

function readFile() {
  const d = readJson(CONTACTS_FILE, { contacts: [] })
  if (!Array.isArray(d.contacts)) d.contacts = []
  return d
}
function writeFile(d) {
  d._meta = meta()
  try {
    fs.writeFileSync(CONTACTS_FILE, JSON.stringify(d, null, 2) + '\n')
  } catch (e) {
    console.error('[crm-contacts] write failed', e?.message || e)
  }
}

function normalizeContact(c) {
  return {
    id: c.id,
    name: String(c.name || ''),
    emails: list(c.emails),
    phones: list(c.phones).map(formatPhone),
    type: TYPES.includes(c.type) ? c.type : 'client',
    relationship: RELATIONSHIPS.includes(c.relationship) ? c.relationship : '',
    engagement: ENGAGEMENTS.includes(c.engagement) ? c.engagement : '',
    tags: list(c.tags),
    notes: String(c.notes || ''),
    createdAt: c.createdAt || '',
    updatedAt: c.updatedAt || '',
  }
}

export function loadContacts() {
  return readFile().contacts.map(normalizeContact)
}

export function addContact(input = {}) {
  const name = String(input.name || '').trim()
  if (!name && list(input.emails).length === 0) throw new Error('a name or email is required')
  const d = readFile()
  const c = normalizeContact({
    ...input,
    id: crypto.randomUUID(),
    name: name || list(input.emails)[0],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })
  d.contacts.push(c)
  writeFile(d)
  return c
}

export function updateContact({ id, ...fields }) {
  const d = readFile()
  const c = d.contacts.find((x) => x.id === id)
  if (!c) throw new Error('contact not found')
  for (const k of ['name', 'emails', 'phones', 'type', 'relationship', 'engagement', 'tags', 'notes']) {
    if (k in fields) c[k] = fields[k]
  }
  c.updatedAt = new Date().toISOString()
  const normalized = normalizeContact(c)
  Object.assign(c, normalized)
  writeFile(d)
  return normalized
}

export function deleteContact(id) {
  const d = readFile()
  d.contacts = d.contacts.filter((x) => x.id !== id)
  writeFile(d)
  return { ok: true }
}

// Seed contacts from existing project contacts. Idempotent: only adds people not
// already present (matched by any shared email, or by name). Infers a starting
// relationship from their projects: any OPEN project -> 'active'; else a
// completed one -> 'yes'; else (archived only) -> 'no'. All editable after.
export function importFromProjects() {
  const d = readFile()
  const existingEmails = new Set()
  const existingNames = new Set()
  for (const c of d.contacts) {
    for (const e of c.emails) existingEmails.add(norm(e))
    if (c.name) existingNames.add(norm(c.name))
  }

  const projects = loadAll().projects
  // group projects by a contact key (first email, else first contact name, else client)
  const groups = new Map()
  for (const p of projects) {
    const email = list(p.contactEmails).map(norm).find((e) => e.includes('@')) || ''
    const cname = list(p.contactNames)[0] || p.client
    const key = email || norm(cname)
    if (!key) continue
    if (!groups.has(key)) groups.set(key, { email, name: cname, phones: new Set(), projs: [] })
    const g = groups.get(key)
    if (!g.name && cname) g.name = cname
    for (const ph of list(p.contactPhones)) g.phones.add(ph)
    g.projs.push(p)
  }

  let added = 0
  for (const [key, g] of groups) {
    const emailKey = g.email
    const nameKey = norm(g.name)
    if ((emailKey && existingEmails.has(emailKey)) || (!emailKey && nameKey && existingNames.has(nameKey))) continue
    const active = g.projs.some((p) => p.bucket === 'active')
    const completed = g.projs.some((p) => p.bucket === 'completed')
    const relationship = active ? 'active' : completed ? 'yes' : 'no'
    const c = normalizeContact({
      id: crypto.randomUUID(),
      name: g.name || key,
      emails: emailKey ? [g.email] : [],
      phones: [...g.phones],
      type: 'client',
      relationship,
      tags: [],
      notes: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    d.contacts.push(c)
    if (emailKey) existingEmails.add(emailKey)
    if (nameKey) existingNames.add(nameKey)
    added++
  }
  writeFile(d)
  return { ok: true, added, contacts: d.contacts.map(normalizeContact) }
}
