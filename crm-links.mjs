// Project <-> contact links (CRM-owned, in crm-links.json).
//
// This REPLACES the old "derive the link by matching names/emails" model, which
// broke whenever a contact was renamed and silently re-created (resurrected)
// contacts on every load. Now a project stores an explicit list of contact IDs.
// Zero, one, or many. Renaming a contact can't break the link (it's by id), and
// nothing is ever auto-recreated once a project has been initialized.
//
// Seeding: a project with NO entry yet is initialized ONCE from its existing
// contact fields (reusing a matching contact if one exists, else creating one).
// After that the entry is the user's to manage. An empty array is a valid,
// respected state (a project with no contacts) and is never re-seeded.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { RECORDS_DIR, loadAll } from './crm-data-core.mjs'
import { loadContacts, addContact } from './crm-contacts.mjs'
import { formatPhone } from './crm-phone.mjs'
import {
  CRM_STORE,
  getCachedLinksMap,
  getCachedProjects,
  // async Supabase writers
  setProjectLinks as sbSetProjectLinks,
  addLink as sbAddLink,
  removeLink as sbRemoveLink,
  purgeContactLinks as sbPurgeContactLinks,
  deleteProjectLinks as sbDeleteProjectLinks,
  updateProject as sbUpdateProject,
  upsertContact as sbUpsertContact,
  // synchronous cache mutators
  cacheSetProjectLinks,
  cacheAddLink,
  cacheRemoveLink,
  cachePurgeContactLinks,
  cacheDeleteProjectLinks,
  cachePatchProject,
  cacheUpsertContact,
} from './crm-store.mjs'

const LINKS_FILE = path.join(RECORDS_DIR, 'crm-links.json')

function norm(s) {
  return String(s || '').trim().toLowerCase()
}
function list(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean)
  return String(v ?? '')
    .split(/[,;]/)
    .map((x) => x.trim())
    .filter(Boolean)
}

function meta() {
  return {
    file: 'crm-links.json',
    owner: 'Magic CRM app (~/Desktop/Claude/magic-crm)',
    purpose:
      'Explicit project->contact links. links[projectId] = array of contact ids (from crm-contacts.json). A project can have 0, 1, or many contacts. This is the single source of truth for which contacts are on a project (and therefore which email threads show in the Communications + Inbox views).',
    cowork_guidance:
      'Safe to read. The CRM manages this file. keyed_by project id = slug of client_name. An entry that exists (even an empty array) means the project has been initialized and should NOT be auto-populated. A project with no entry gets ONE contact seeded from its contact_names/contact_emails on next load.',
    shape: 'links: { [projectId]: [contactId, ...] }',
  }
}

function readLinks() {
  // Under supabase the links map comes from the cache (contact_links → projects with >=1 contact).
  // A project that was SEEDED but has zero contacts leaves no contact_links row, so it's absent
  // from that map; but under files such a project has an explicit empty-array entry (seeding wrote
  // one). To match, add [] for every links_seeded project not already present. The links_seeded
  // flag on project rows is the exact record of "initialized" (an empty array is a respected state).
  // Return a shallow copy so read helpers can't mutate the shared cache. Under files, read the JSON.
  if (CRM_STORE === 'supabase') {
    const links = { ...getCachedLinksMap() }
    for (const p of getCachedProjects()) {
      if (p.links_seeded && !(p.id in links)) links[p.id] = []
    }
    return { links }
  }
  let d
  try {
    d = JSON.parse(fs.readFileSync(LINKS_FILE, 'utf8'))
  } catch {
    d = { links: {} }
  }
  if (!d.links || typeof d.links !== 'object') d.links = {}
  return d
}

function writeLinks(d) {
  d._meta = meta()
  try {
    fs.writeFileSync(LINKS_FILE, JSON.stringify(d, null, 2) + '\n')
  } catch (e) {
    console.error('[crm-links] write failed', e?.message || e)
  }
}

// Initialize any project that has no link entry yet (one-time per project), then
// return the full links map. Idempotent and non-destructive: it only ADDS entries
// for projects it has never seen, and reuses an existing contact when one matches.
export function seedLinksIfNeeded() {
  return CRM_STORE === 'supabase' ? seedLinksSupabase() : seedLinksFiles()
}

function seedLinksFiles() {
  const d = readLinks()
  const projects = loadAll().projects
  const contacts = loadContacts()

  const byEmail = new Map() // normalized email -> contactId
  const byName = new Map() // normalized name -> contactId
  const reindex = () => {
    byEmail.clear()
    byName.clear()
    for (const c of contacts) {
      for (const e of c.emails) {
        const k = norm(e)
        if (k && !byEmail.has(k)) byEmail.set(k, c.id)
      }
      const n = norm(c.name)
      if (n && !byName.has(n)) byName.set(n, c.id)
    }
  }
  reindex()

  let dirty = false
  for (const p of projects) {
    if (d.links[p.id]) continue // already initialized -> the user owns it now

    const emails = list(p.contactEmails).filter((e) => e.includes('@'))
    const names = list(p.contactNames)
    const name = names[0] || p.client || ''

    let contactId = null
    for (const e of emails) {
      const id = byEmail.get(norm(e))
      if (id) {
        contactId = id
        break
      }
    }
    if (!contactId && name) {
      const id = byName.get(norm(name))
      if (id) contactId = id
    }
    if (!contactId) {
      try {
        const c = addContact({
          name: name || emails[0] || '',
          emails,
          phones: list(p.contactPhones),
          type: 'client',
          relationship: p.bucket === 'active' ? 'active' : p.bucket === 'completed' ? 'yes' : 'no',
        })
        contacts.push(c)
        reindex()
        contactId = c.id
      } catch {
        contactId = null // no name or email to make a contact from
      }
    }

    d.links[p.id] = contactId ? [contactId] : []
    dirty = true
  }

  if (dirty) writeLinks(d)
  return d.links
}

// Build the RAW contact row (snake_case) a seed would create, WITHOUT calling the async addContact.
// Mirrors normalizeContact + addContact's defaults so the seeded contact reads back identically.
function buildSeedContactRow({ name, emails, phones, relationship }) {
  const cleanEmails = (Array.isArray(emails) ? emails : []).map((x) => String(x).trim()).filter(Boolean)
  const cleanPhones = (Array.isArray(phones) ? phones : []).map((x) => String(x).trim()).filter(Boolean).map(formatPhone)
  const nm = String(name || '').trim() || cleanEmails[0] || ''
  const now = new Date().toISOString()
  return {
    id: crypto.randomUUID(),
    name: nm,
    emails: cleanEmails,
    phones: cleanPhones,
    type: 'client',
    relationship: ['yes', 'no', 'maybe', 'active', ''].includes(relationship) ? relationship : '',
    engagement: '',
    tags: [],
    notes: '',
    created_at: now,
    updated_at: now,
  }
}

// SUPABASE seeding. Runs inside the READ path (called by loadLinks -> loadContacts handler and the
// /api/contacts GET), so it MUST stay synchronous: it updates the in-memory cache immediately and
// fires the Supabase persists WITHOUT awaiting (fire-and-forget, errors logged). Idempotent: seeding
// is decided by the project's links_seeded flag (not map-key presence), and we flip that flag in the
// cache the instant we seed so a project is never re-seeded within the process. A dropped async write
// self-heals because links_seeded/contact_links are recomputed from Supabase on the next load.
function seedLinksSupabase() {
  const projects = loadAll().projects
  const contacts = loadContacts() // normalized, from cache

  const byEmail = new Map()
  const byName = new Map()
  const reindexContact = (c) => {
    for (const e of c.emails || []) {
      const k = norm(e)
      if (k && !byEmail.has(k)) byEmail.set(k, c.id)
    }
    const n = norm(c.name)
    if (n && !byName.has(n)) byName.set(n, c.id)
  }
  for (const c of contacts) reindexContact(c)

  // seeded set = projects whose links_seeded flag is true (the definitive "initialized" record).
  const seeded = new Set(getCachedProjects().filter((p) => p.links_seeded).map((p) => p.id))

  for (const p of projects) {
    if (seeded.has(p.id)) continue // already initialized -> the user owns it now

    const emails = list(p.contactEmails).filter((e) => e.includes('@'))
    const names = list(p.contactNames)
    const name = names[0] || p.client || ''

    let contactId = null
    for (const e of emails) {
      const id = byEmail.get(norm(e))
      if (id) {
        contactId = id
        break
      }
    }
    if (!contactId && name) {
      const id = byName.get(norm(name))
      if (id) contactId = id
    }
    if (!contactId && (name || emails.length)) {
      // Create the contact synchronously in the cache; fire-and-forget the Supabase write.
      const row = buildSeedContactRow({
        name,
        emails,
        phones: list(p.contactPhones),
        relationship: p.bucket === 'active' ? 'active' : p.bucket === 'completed' ? 'yes' : 'no',
      })
      cacheUpsertContact(row)
      sbUpsertContact(row).catch((err) => console.error('[crm-links] seed upsertContact failed:', err?.message || err))
      // Index the new contact (mirror normalizeContact's phone form so lookups match a later read).
      reindexContact({ id: row.id, name: row.name, emails: row.emails })
      contactId = row.id
    }

    // Update the cache now: link (if any) + mark the project seeded so it never re-seeds.
    if (contactId) {
      cacheSetProjectLinks(p.id, [contactId])
      sbSetProjectLinks(p.id, [contactId]).catch((err) =>
        console.error('[crm-links] seed setProjectLinks failed:', err?.message || err),
      )
    } else {
      cacheSetProjectLinks(p.id, []) // explicit empty set: seeded, no contacts
    }
    cachePatchProject(p.id, { links_seeded: true })
    seeded.add(p.id)
    sbUpdateProject(p.id, { links_seeded: true }).catch((err) =>
      console.error('[crm-links] seed set links_seeded failed:', err?.message || err),
    )
  }

  return readLinks().links
}

// The full links map. Under files it seeds any uninitialized projects first (a write concern);
// under supabase seeding is deferred to the later write pass, so this just returns the cached map.
export function loadLinks() {
  if (CRM_STORE === 'supabase') return readLinks().links
  return seedLinksIfNeeded()
}

export function contactIdsForProject(projectId) {
  return readLinks().links[projectId] || []
}

export async function setProjectContacts(projectId, contactIds) {
  const ids = Array.from(new Set((contactIds || []).map(String)))
  if (CRM_STORE === 'supabase') {
    // Replacing the contact set also means the project is now initialized (links_seeded=true), so an
    // explicit empty set is a respected "seeded, no contacts" state and won't be re-seeded.
    cacheSetProjectLinks(projectId, ids)
    cachePatchProject(projectId, { links_seeded: true })
    await sbSetProjectLinks(projectId, ids)
    await sbUpdateProject(projectId, { links_seeded: true })
    return readLinks().links
  }
  const d = readLinks()
  d.links[projectId] = ids
  writeLinks(d)
  return d.links
}

export async function linkContact(projectId, contactId) {
  if (CRM_STORE === 'supabase') {
    cacheAddLink(projectId, contactId)
    cachePatchProject(projectId, { links_seeded: true })
    await sbAddLink(projectId, contactId)
    await sbUpdateProject(projectId, { links_seeded: true })
    return readLinks().links
  }
  const d = readLinks()
  const arr = d.links[projectId] || []
  if (!arr.includes(contactId)) arr.push(contactId)
  d.links[projectId] = arr
  writeLinks(d)
  return d.links
}

export async function unlinkContact(projectId, contactId) {
  if (CRM_STORE === 'supabase') {
    cacheRemoveLink(projectId, contactId)
    await sbRemoveLink(projectId, contactId)
    return readLinks().links
  }
  const d = readLinks()
  d.links[projectId] = (d.links[projectId] || []).filter((x) => x !== contactId)
  writeLinks(d)
  return d.links
}

// Remove a (deleted) contact from every project it was on. Keeps deletions from
// leaving dangling ids, and means a deleted contact stays gone.
export async function purgeContact(contactId) {
  if (CRM_STORE === 'supabase') {
    cachePurgeContactLinks(contactId)
    await sbPurgeContactLinks(contactId)
    return readLinks().links
  }
  const d = readLinks()
  let dirty = false
  for (const k of Object.keys(d.links)) {
    const before = d.links[k].length
    d.links[k] = d.links[k].filter((x) => x !== contactId)
    if (d.links[k].length !== before) dirty = true
  }
  if (dirty) writeLinks(d)
  return d.links
}

export async function deleteProjectLinks(projectId) {
  if (CRM_STORE === 'supabase') {
    cacheDeleteProjectLinks(projectId)
    await sbDeleteProjectLinks(projectId)
    return { ok: true }
  }
  const d = readLinks()
  if (projectId in d.links) {
    delete d.links[projectId]
    writeLinks(d)
  }
  return { ok: true }
}

// --- Email resolution (for Communications / Inbox / unread badges) -----------
// A project's mail is whatever the people attached to it use. These resolve the
// linked contacts' email addresses without seeding (read-only, side-effect free).

function index() {
  const links = readLinks().links
  const contacts = loadContacts()
  const byId = new Map(contacts.map((c) => [c.id, c]))
  return { links, byId }
}

// { [projectId]: [lowercased real email, ...] } for all linked projects.
export function resolveProjectEmails() {
  const { links, byId } = index()
  const out = {}
  for (const [pid, ids] of Object.entries(links)) {
    const s = new Set()
    for (const id of ids) {
      const c = byId.get(id)
      if (!c) continue
      for (const e of c.emails) {
        const v = norm(e)
        if (v.includes('@')) s.add(v)
      }
    }
    out[pid] = [...s]
  }
  return out
}

export function emailsForProject(projectId) {
  return resolveProjectEmails()[projectId] || []
}

// The resolved contact objects attached to a project (for display, e.g. demo
// thread names). Linked contacts that no longer exist are skipped.
export function contactsForProject(projectId) {
  const { links, byId } = index()
  return (links[projectId] || []).map((id) => byId.get(id)).filter(Boolean)
}
