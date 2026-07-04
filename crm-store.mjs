// The single place the CRM talks to Supabase. Everything here is server-side and uses the SECRET
// key (bypasses row-level security), so it must never be imported into browser/phone code.
//
// CRM_STORE selects the backend: 'files' (default, the current JSON files) or 'supabase'. This module
// only holds the Supabase helpers; the per-entity modules (crm-data-core / crm-contacts / crm-links)
// call these when CRM_STORE==='supabase' and otherwise keep using the files as before. Nothing in the
// app imports this yet, so adding it changes no behavior.
//
// Shapes are RAW (snake_case columns, jsonb arrays), matching what the existing normalize()/
// normalizeContact()/normalizeStructure() functions already expect to receive, so the callers'
// mapping logic stays identical regardless of backend.

import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const creds = JSON.parse(fs.readFileSync(path.join(DIR, 'supabase-credentials.json'), 'utf8'))

export const CRM_STORE = process.env.CRM_STORE === 'supabase' ? 'supabase' : 'files'

let _sb = null
export function sb() {
  if (!_sb) {
    _sb = createClient(creds.url, creds.secretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  }
  return _sb
}

function must(error, where) {
  if (error) throw new Error(`crm-store.${where}: ${error.message}`)
}

// ---------------- projects ----------------

export async function getAllProjects() {
  const { data, error } = await sb().from('projects').select('*')
  must(error, 'getAllProjects')
  return data || []
}

export async function insertProject(row) {
  const { error } = await sb().from('projects').insert(row)
  must(error, 'insertProject')
}

// Insert-or-replace by id. Use for whole-record writes.
export async function upsertProject(row) {
  const { error } = await sb().from('projects').upsert(row, { onConflict: 'id' })
  must(error, 'upsertProject')
}

// Partial update of one project (a field edit, a new activity_log array, a bucket move, etc.).
export async function updateProject(id, patch) {
  const { error } = await sb().from('projects').update(patch).eq('id', id)
  must(error, 'updateProject')
}

export async function deleteProject(id) {
  // contact_links rows cascade automatically (FK on delete cascade).
  const { error } = await sb().from('projects').delete().eq('id', id)
  must(error, 'deleteProject')
}

export async function setProjectStage(id, stageId) {
  return updateProject(id, { stage_id: stageId })
}

// Move every project currently at any of `fromIds` to `toId` (pipeline reassign).
export async function reassignStage(fromIds, toId) {
  if (!fromIds || !fromIds.length) return
  const { error } = await sb().from('projects').update({ stage_id: toId }).in('stage_id', fromIds)
  must(error, 'reassignStage')
}

// ---------------- contacts ----------------

export async function getContacts() {
  const { data, error } = await sb().from('contacts').select('*')
  must(error, 'getContacts')
  return data || []
}

export async function upsertContact(row) {
  const { error } = await sb().from('contacts').upsert(row, { onConflict: 'id' })
  must(error, 'upsertContact')
}

export async function deleteContact(id) {
  // contact_links rows cascade automatically.
  const { error } = await sb().from('contacts').delete().eq('id', id)
  must(error, 'deleteContact')
}

// ---------------- contact_links ----------------

export async function getContactLinks() {
  const { data, error } = await sb().from('contact_links').select('project_id, contact_id')
  must(error, 'getContactLinks')
  return data || []
}

// Rebuild the { [projectId]: [contactId, ...] } map the app uses. Only projects with >=1 contact
// appear here; "seeded but empty" projects are tracked by projects.links_seeded instead.
export async function getLinksMap() {
  const rows = await getContactLinks()
  const map = {}
  for (const r of rows) (map[r.project_id] ||= []).push(r.contact_id)
  return map
}

// Replace a project's entire contact set.
export async function setProjectLinks(projectId, contactIds) {
  const del = await sb().from('contact_links').delete().eq('project_id', projectId)
  must(del.error, 'setProjectLinks.delete')
  const ids = [...new Set(contactIds || [])]
  if (ids.length) {
    const { error } = await sb()
      .from('contact_links')
      .insert(ids.map((contact_id) => ({ project_id: projectId, contact_id })))
    must(error, 'setProjectLinks.insert')
  }
}

export async function addLink(projectId, contactId) {
  const { error } = await sb()
    .from('contact_links')
    .upsert({ project_id: projectId, contact_id: contactId }, { onConflict: 'project_id,contact_id' })
  must(error, 'addLink')
}

export async function removeLink(projectId, contactId) {
  const { error } = await sb().from('contact_links').delete().eq('project_id', projectId).eq('contact_id', contactId)
  must(error, 'removeLink')
}

export async function purgeContactLinks(contactId) {
  const { error } = await sb().from('contact_links').delete().eq('contact_id', contactId)
  must(error, 'purgeContactLinks')
}

export async function deleteProjectLinks(projectId) {
  const { error } = await sb().from('contact_links').delete().eq('project_id', projectId)
  must(error, 'deleteProjectLinks')
}

// ---------------- in-memory read cache (for synchronous getters) ----------------
//
// The app's per-entity read funnels (loadAll / loadContacts / loadLinks / loadStructure)
// are SYNCHRONOUS and called by ~18 modules, so they can't await Supabase. Instead we
// load everything once at startup with `await initStore()` and then serve every read from
// this module-level cache via the sync getters below. Under CRM_STORE==='files' this cache
// is never populated or consulted (the funnels keep reading the JSON files directly).

let _cache = null

// Load all read data from Supabase into the cache. Call once at startup (or at the top of a
// test harness). Idempotent per process unless forced: a second call refreshes the snapshot.
export async function initStore({ force = false } = {}) {
  if (_cache && !force) return _cache
  const [projects, contacts, linksMap, pipelineMeta] = await Promise.all([
    getAllProjects(),
    getContacts(),
    getLinksMap(),
    getPipelineMeta(),
  ])
  _cache = { projects, contacts, linksMap, pipelineMeta }
  return _cache
}

function requireCache(where) {
  if (!_cache) {
    throw new Error(
      `crm-store.${where}: cache not initialized. Call "await initStore()" once at startup before any synchronous read under CRM_STORE=supabase.`,
    )
  }
  return _cache
}

// Raw project rows (snake_case), matching what normalize() expects.
export function getCachedProjects() {
  return requireCache('getCachedProjects').projects
}
// Raw contact rows (snake_case, jsonb arrays), matching what normalizeContact() expects.
export function getCachedContacts() {
  return requireCache('getCachedContacts').contacts
}
// { [projectId]: [contactId, ...] } for projects with >=1 linked contact.
export function getCachedLinksMap() {
  return requireCache('getCachedLinksMap').linksMap
}
// { structure, flow_layout } from pipeline_meta.
export function getCachedPipelineMeta() {
  return requireCache('getCachedPipelineMeta').pipelineMeta
}

// ---------------- pipeline_meta (structure + flow layout) ----------------

export async function getPipelineMeta() {
  const { data, error } = await sb().from('pipeline_meta').select('structure, flow_layout').eq('id', 1).maybeSingle()
  must(error, 'getPipelineMeta')
  return data || { structure: null, flow_layout: null }
}

export async function setPipelineMeta(patch) {
  const { error } = await sb()
    .from('pipeline_meta')
    .upsert({ id: 1, ...patch, updated_at: new Date().toISOString() }, { onConflict: 'id' })
  must(error, 'setPipelineMeta')
}
