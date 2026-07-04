// Contacts: first-class people/orgs (clients, vendors, associates), separate
// from projects. A contact can exist with zero projects (e.g. a vendor you've
// only emailed). Projects are LINKED to a contact by matching email/name; that
// link is derived on the client, not stored, so renaming a project can't break it.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { RECORDS_DIR, loadAll } from './crm-data-core.mjs'
import { formatPhone } from './crm-phone.mjs'
import {
  CRM_STORE,
  getCachedContacts,
  upsertContact as sbUpsertContact,
  deleteContact as sbDeleteContact,
  cacheUpsertContact,
  cacheRemoveContact,
} from './crm-store.mjs'

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

// Postgres returns timestamptz as e.g. "2026-06-18T08:54:42.59+00:00" (offset form, trailing
// zeros trimmed); the files store the JS toISOString() form "...590Z". Same instant, different
// text. Re-serialize through Date so the supabase read yields the identical string the files
// path produces. Empty/unparseable -> '' (matches normalizeContact's `c.createdAt || ''`).
function isoZ(v) {
  const s = String(v ?? '').trim()
  if (!s) return ''
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? s : d.toISOString()
}

// Raw contact rows for whichever backend is active. Files: crm-contacts.json (camelCase
// createdAt/updatedAt). Supabase: cached rows (snake_case created_at/updated_at) mapped to the
// camelCase keys normalizeContact() reads, so the identical normalization runs either way.
function rawContacts() {
  if (CRM_STORE === 'supabase') {
    return getCachedContacts().map((c) => ({ ...c, createdAt: isoZ(c.created_at), updatedAt: isoZ(c.updated_at) }))
  }
  return readFile().contacts
}

export function loadContacts() {
  return rawContacts().map(normalizeContact)
}

// A normalized contact (camelCase createdAt/updatedAt) -> the RAW Supabase row shape (snake_case
// created_at/updated_at, jsonb arrays), so the cache row matches what getCachedContacts() returns
// and rawContacts() re-maps identically. isoZ round-trips the timestamp exactly as the read path.
function toRawRow(c) {
  return {
    id: c.id,
    name: c.name,
    emails: c.emails,
    phones: c.phones,
    type: c.type,
    relationship: c.relationship,
    engagement: c.engagement,
    tags: c.tags,
    notes: c.notes,
    created_at: c.createdAt || null,
    updated_at: c.updatedAt || null,
  }
}

export async function addContact(input = {}) {
  const name = String(input.name || '').trim()
  if (!name && list(input.emails).length === 0) throw new Error('a name or email is required')
  const c = normalizeContact({
    ...input,
    id: crypto.randomUUID(),
    name: name || list(input.emails)[0],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })
  if (CRM_STORE === 'supabase') {
    const row = toRawRow(c)
    cacheUpsertContact(row)
    await sbUpsertContact(row)
    // Re-normalize through the read path so the returned object matches a subsequent loadContacts()
    // (isoZ timestamp form). Same object either backend.
    return normalizeContact({ ...row, createdAt: isoZ(row.created_at), updatedAt: isoZ(row.updated_at) })
  }
  const d = readFile()
  d.contacts.push(c)
  writeFile(d)
  return c
}

export async function updateContact({ id, ...fields }) {
  if (CRM_STORE === 'supabase') {
    const existing = getCachedContacts().find((x) => x.id === id)
    if (!existing) throw new Error('contact not found')
    // Start from the normalized current contact, apply the incoming fields, bump updatedAt.
    const merged = normalizeContact({ ...existing, createdAt: isoZ(existing.created_at), updatedAt: isoZ(existing.updated_at) })
    for (const k of ['name', 'emails', 'phones', 'type', 'relationship', 'engagement', 'tags', 'notes']) {
      if (k in fields) merged[k] = fields[k]
    }
    merged.updatedAt = new Date().toISOString()
    const normalized = normalizeContact(merged)
    const row = toRawRow(normalized)
    cacheUpsertContact(row)
    await sbUpsertContact(row)
    return normalized
  }
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

export async function deleteContact(id) {
  if (CRM_STORE === 'supabase') {
    // contact_links cascade via FK; also clear the contact from the cached links map. purgeContact
    // (crm-links) is still called by the plugin handler to keep the files link map in step under files.
    cacheRemoveContact(id)
    await sbDeleteContact(id)
    return { ok: true }
  }
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
