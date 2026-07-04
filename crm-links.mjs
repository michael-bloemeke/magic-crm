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
import { RECORDS_DIR, loadAll } from './crm-data-core.mjs'
import { loadContacts, addContact } from './crm-contacts.mjs'
import { CRM_STORE, getCachedLinksMap } from './crm-store.mjs'

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
  // Under supabase the links map comes from the cache (contact_links, projects with >=1 contact).
  // Return a shallow copy so read helpers can't mutate the shared cache. Under files, read the JSON.
  if (CRM_STORE === 'supabase') return { links: { ...getCachedLinksMap() } }
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

// The full links map. Under files it seeds any uninitialized projects first (a write concern);
// under supabase seeding is deferred to the later write pass, so this just returns the cached map.
export function loadLinks() {
  if (CRM_STORE === 'supabase') return readLinks().links
  return seedLinksIfNeeded()
}

export function contactIdsForProject(projectId) {
  return readLinks().links[projectId] || []
}

export function setProjectContacts(projectId, contactIds) {
  const d = readLinks()
  d.links[projectId] = Array.from(new Set((contactIds || []).map(String)))
  writeLinks(d)
  return d.links
}

export function linkContact(projectId, contactId) {
  const d = readLinks()
  const arr = d.links[projectId] || []
  if (!arr.includes(contactId)) arr.push(contactId)
  d.links[projectId] = arr
  writeLinks(d)
  return d.links
}

export function unlinkContact(projectId, contactId) {
  const d = readLinks()
  d.links[projectId] = (d.links[projectId] || []).filter((x) => x !== contactId)
  writeLinks(d)
  return d.links
}

// Remove a (deleted) contact from every project it was on. Keeps deletions from
// leaving dangling ids, and means a deleted contact stays gone.
export function purgeContact(contactId) {
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

export function deleteProjectLinks(projectId) {
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
