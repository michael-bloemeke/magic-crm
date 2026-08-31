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

// Backend selector, checked in priority order so the desktop app can flip without env vars:
//   1) CRM_STORE env var ('supabase' | 'files') — used by tests/scripts
//   2) store-config.json {"store":"supabase"} next to this file (gitignored, per-machine toggle)
//   3) default 'files'
// Flipping is just changing #2 and relaunching the app; reverting is deleting it. Default stays files.
function resolveStore() {
  if (process.env.CRM_STORE === 'supabase') return 'supabase'
  if (process.env.CRM_STORE === 'files') return 'files'
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'store-config.json'), 'utf8'))
    if (cfg.store === 'supabase') return 'supabase'
  } catch {
    /* no config file -> default */
  }
  return 'files'
}

export const CRM_STORE = resolveStore()

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

// Read ONE project straight from the database, bypassing the in-process cache. The cache is only
// refreshed on its own schedule, so anything written out of band (a raw SQL fix, another process,
// a second CRM window) is invisible to it. Callers that must not fail on a stale cache use this as
// a fallback before deciding a project does not exist.
export async function fetchProjectById(id) {
  const { data, error } = await sb().from('projects').select('*').eq('id', id).maybeSingle()
  must(error, 'fetchProjectById')
  return data || null
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

// Full cascade: remove EVERY per-project record tied to a project id, across every
// table that keys by it. Called only on a PERMANENT delete (the 30-day purge or an
// explicit "delete permanently"), so nothing is ever orphaned. Only contact_links
// cascades in the database; everything else is cleaned here. Each delete is awaited
// but a single failure is logged and does not abort the rest (best-effort sweep).
export async function purgeProjectData(projectId) {
  if (!projectId) return
  // Tables with a plain `project_id` column.
  const byProjectId = [
    'payments',
    'mileage_trips',
    'tasks',
    'emails',
    'notifications',
    'text_markers',
    'invoices',
    'contracts',
    'recipients',
  ]
  for (const table of byProjectId) {
    const { error } = await sb().from(table).delete().eq('project_id', projectId)
    if (error) console.error(`[crm-store] purgeProjectData ${table} for ${projectId}:`, error.message)
  }
  // inquiries store the project link inside the `data` jsonb (data->>'projectId').
  const { error: inqErr } = await sb().from('inquiries').delete().eq('data->>projectId', projectId)
  if (inqErr) console.error(`[crm-store] purgeProjectData inquiries for ${projectId}:`, inqErr.message)
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

// ORDER MATTERS: position 0 is the primary contact, the one the contract and invoice are addressed
// to. The table had no ordering column until 2026-08-06, so "the first contact" was whatever order
// Postgres returned. contact_id is the tiebreak so the result is fully deterministic.
export async function getContactLinks() {
  const { data, error } = await sb()
    .from('contact_links')
    .select('project_id, contact_id, position')
    .order('position', { ascending: true })
    .order('contact_id', { ascending: true })
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
    // The caller's array order IS the priority order: ids[0] becomes the primary.
    const { error } = await sb()
      .from('contact_links')
      .insert(ids.map((contact_id, position) => ({ project_id: projectId, contact_id, position })))
    must(error, 'setProjectLinks.insert')
  }
}

// Append, so adding a contact never reassigns who the paperwork is addressed to. ignoreDuplicates
// keeps re-linking an existing contact a no-op rather than rewriting their position.
export async function addLink(projectId, contactId) {
  const { data: rows, error: posErr } = await sb()
    .from('contact_links')
    .select('position')
    .eq('project_id', projectId)
    .order('position', { ascending: false })
    .limit(1)
  must(posErr, 'addLink.position')
  const position = rows && rows.length ? Number(rows[0].position ?? 0) + 1 : 0
  const { error } = await sb()
    .from('contact_links')
    .upsert({ project_id: projectId, contact_id: contactId, position },
            { onConflict: 'project_id,contact_id', ignoreDuplicates: true })
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

// ---- change sentinel (egress guard) ----
// data_version is a one-row table bumped by a trigger on every write to any CRM table.
// Pollers fetch just that row (~30 bytes) and only trigger a full 21-table reload when v
// actually moved. Before this, the 15s timer reloaded everything (~1.35 MB) unconditionally,
// which burned ~7.6 GB/day of Supabase egress. _lastSeenV updates only inside initStore, so
// a failed reload leaves it stale and the next poll retries.
let _lastSeenV = null

export async function checkDataVersion() {
  const { data, error } = await sb().from('data_version').select('v').eq('id', 1).single()
  must(error, 'checkDataVersion')
  const v = Number(data?.v ?? 0)
  return { changed: _lastSeenV === null || v !== _lastSeenV, v }
}

// Load all read data from Supabase into the cache. Call once at startup (or at the top of a
// test harness). Idempotent per process unless forced: a second call refreshes the snapshot.
export async function initStore({ force = false } = {}) {
  if (_cache && !force) return _cache
  // Record the sentinel BEFORE loading: a write that lands mid-load leaves v ahead of what we
  // saw, so the next poll reloads again rather than missing it. Best-effort (first boot on an
  // older DB without the table must not fail the app).
  try {
    const { data } = await sb().from('data_version').select('v').eq('id', 1).single()
    if (data) _lastSeenV = Number(data.v)
  } catch { /* sentinel unavailable -> every poll reports changed, which is safe */ }
  const [
    projects,
    contacts,
    linksMap,
    pipelineMeta,
    // Phase-2 entities (loaded here as groundwork; finance + tasks are WIRED now, the rest
    // are laid for a later batch that will wire their modules).
    payments,
    expenses,
    mileageTrips,
    crmSettings,
    tasks,
    emails,
    notifications,
    textMarkers,
    invoices,
    contracts,
    recipients,
    inquiries,
    calendarMap,
    crmConfig,
  ] = await Promise.all([
    getAllProjects(),
    getContacts(),
    getLinksMap(),
    getPipelineMeta(),
    getAllPayments(),
    getAllExpenses(),
    getAllMileageTrips(),
    getCrmSettings(),
    getAllTasks(),
    getAllEmails(),
    getAllNotifications(),
    getAllTextMarkers(),
    getAllInvoices(),
    getAllContracts(),
    getAllRecipients(),
    getAllInquiries(),
    getCalendarMap(),
    getCrmConfig(),
  ])
  _cache = {
    projects,
    contacts,
    linksMap,
    pipelineMeta,
    payments,
    expenses,
    mileageTrips,
    crmSettings,
    tasks,
    emails,
    notifications,
    textMarkers,
    invoices,
    contracts,
    recipients,
    inquiries,
    calendarMap,
    crmConfig,
  }
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

// ---- Phase-2 cached getters (raw snake_case rows / jsonb payloads) ----
// WIRED now (finance + tasks):
export function getCachedPayments() {
  return requireCache('getCachedPayments').payments
}
export function getCachedExpenses() {
  return requireCache('getCachedExpenses').expenses
}
export function getCachedMileageTrips() {
  return requireCache('getCachedMileageTrips').mileageTrips
}
// The single crm_settings row: { mileage_rate_per_mile }. (questionnaire_template was dropped
// 2026-08-03 with the questionnaire feature.)
export function getCachedCrmSettings() {
  return requireCache('getCachedCrmSettings').crmSettings
}
export function getCachedTasks() {
  return requireCache('getCachedTasks').tasks
}
// Groundwork getters (not wired yet; a later batch wires their modules):
export function getCachedEmails() {
  return requireCache('getCachedEmails').emails
}
export function getCachedNotifications() {
  return requireCache('getCachedNotifications').notifications
}
export function getCachedTextMarkers() {
  return requireCache('getCachedTextMarkers').textMarkers
}
export function getCachedInvoices() {
  return requireCache('getCachedInvoices').invoices
}
export function getCachedContracts() {
  return requireCache('getCachedContracts').contracts
}
export function getCachedRecipients() {
  return requireCache('getCachedRecipients').recipients
}
export function getCachedInquiries() {
  return requireCache('getCachedInquiries').inquiries
}
// The single calendar_map row: { calendars, projects, tasks }.
export function getCachedCalendarMap() {
  return requireCache('getCachedCalendarMap').calendarMap
}
// The single crm_config row's { data } payload.
export function getCachedCrmConfig() {
  return requireCache('getCachedCrmConfig').crmConfig
}

// ---------------- in-memory cache MUTATORS (for the write funnels) ----------------
//
// Under CRM_STORE==='supabase' the write funnels persist to Supabase (async) AND must update this
// cache synchronously, so a synchronous read later in the same process reflects the change without
// waiting for a refresh. Every mutator here operates on the RAW row shape (snake_case) so the cache
// stays byte-identical to what getAllProjects()/getContacts()/getLinksMap() would return. No-ops if
// the cache isn't initialized (defensive; the funnels only call these under supabase after initStore).

// Insert or replace a whole project row in the cache (keyed by id).
export function cacheUpsertProject(row) {
  if (!_cache) return
  const i = _cache.projects.findIndex((p) => p.id === row.id)
  if (i === -1) _cache.projects.push(row)
  else _cache.projects[i] = row
}
// Merge a partial patch into one cached project row.
export function cachePatchProject(id, patch) {
  if (!_cache) return
  const p = _cache.projects.find((p) => p.id === id)
  if (p) Object.assign(p, patch)
}
// Remove a project row (and any of its contact_links) from the cache.
export function cacheRemoveProject(id) {
  if (!_cache) return
  _cache.projects = _cache.projects.filter((p) => p.id !== id)
  delete _cache.linksMap[id]
}
export function cacheSetProjectStage(id, stageId) {
  cachePatchProject(id, { stage_id: stageId })
}
// Move every cached project at any of `fromIds` to `toId`.
export function cacheReassignStage(fromIds, toId) {
  if (!_cache) return
  const from = new Set(fromIds || [])
  for (const p of _cache.projects) if (from.has(p.stage_id)) p.stage_id = toId
}

// Insert or replace a whole contact row in the cache (keyed by id).
export function cacheUpsertContact(row) {
  if (!_cache) return
  const i = _cache.contacts.findIndex((c) => c.id === row.id)
  if (i === -1) _cache.contacts.push(row)
  else _cache.contacts[i] = row
}
export function cacheRemoveContact(id) {
  if (!_cache) return
  _cache.contacts = _cache.contacts.filter((c) => c.id !== id)
  // Strip the contact from every project's link array (mirrors purgeContactLinks).
  for (const pid of Object.keys(_cache.linksMap)) {
    _cache.linksMap[pid] = _cache.linksMap[pid].filter((cid) => cid !== id)
    if (_cache.linksMap[pid].length === 0) delete _cache.linksMap[pid]
  }
}

// Replace a project's entire contact set in the cache. An empty set is tracked by links_seeded
// on the project row, not by a map entry, so we DELETE the key when the set is empty (matching
// getLinksMap, which only lists projects with >=1 contact).
export function cacheSetProjectLinks(projectId, contactIds) {
  if (!_cache) return
  const ids = [...new Set((contactIds || []).map(String))]
  if (ids.length) _cache.linksMap[projectId] = ids
  else delete _cache.linksMap[projectId]
}
export function cacheAddLink(projectId, contactId) {
  if (!_cache) return
  const arr = _cache.linksMap[projectId] || (_cache.linksMap[projectId] = [])
  if (!arr.includes(contactId)) arr.push(contactId)
}
export function cacheRemoveLink(projectId, contactId) {
  if (!_cache) return
  if (!_cache.linksMap[projectId]) return
  _cache.linksMap[projectId] = _cache.linksMap[projectId].filter((cid) => cid !== contactId)
  if (_cache.linksMap[projectId].length === 0) delete _cache.linksMap[projectId]
}
export function cachePurgeContactLinks(contactId) {
  if (!_cache) return
  for (const pid of Object.keys(_cache.linksMap)) {
    _cache.linksMap[pid] = _cache.linksMap[pid].filter((cid) => cid !== contactId)
    if (_cache.linksMap[pid].length === 0) delete _cache.linksMap[pid]
  }
}
export function cacheDeleteProjectLinks(projectId) {
  if (!_cache) return
  delete _cache.linksMap[projectId]
}
// Merge a patch ({ structure } and/or { flow_layout }) into the cached pipeline_meta.
export function cacheSetPipelineMeta(patch) {
  if (!_cache) return
  _cache.pipelineMeta = { ...(_cache.pipelineMeta || {}), ...patch }
}

// ---- Phase-2 cache mutators (RAW row shape, keyed by each table's PK) ----
// Every mutator no-ops when the cache isn't initialized (defensive; the funnels only call
// these under supabase after initStore). Each keeps the cached array/object byte-identical
// to what the corresponding getAll*/get* helper would return on a fresh load.

// Generic keyed-by-id upsert/remove over a named cache array.
function cacheUpsertBy(arrKey, row, idField = 'id') {
  if (!_cache) return
  const arr = _cache[arrKey]
  const i = arr.findIndex((x) => x[idField] === row[idField])
  if (i === -1) arr.push(row)
  else arr[i] = row
}
function cacheRemoveBy(arrKey, id, idField = 'id') {
  if (!_cache) return
  _cache[arrKey] = _cache[arrKey].filter((x) => x[idField] !== id)
}

// payments
export function cacheUpsertPayment(row) {
  cacheUpsertBy('payments', row)
}
export function cacheRemovePayment(id) {
  cacheRemoveBy('payments', id)
}
export function cacheRemovePaymentsForProject(projectId) {
  if (!_cache) return
  _cache.payments = _cache.payments.filter((p) => p.project_id !== projectId)
}
// expenses
export function cacheUpsertExpense(row) {
  cacheUpsertBy('expenses', row)
}
export function cacheRemoveExpense(id) {
  cacheRemoveBy('expenses', id)
}
// mileage_trips
export function cacheUpsertMileageTrip(row) {
  cacheUpsertBy('mileageTrips', row)
}
export function cacheRemoveMileageTrip(id) {
  cacheRemoveBy('mileageTrips', id)
}
export function cacheRemoveMileageTripsForProject(projectId) {
  if (!_cache) return
  _cache.mileageTrips = _cache.mileageTrips.filter((t) => t.project_id !== projectId)
}
// crm_settings (single row): merge a patch into the cached settings object.
export function cacheSetCrmSettings(patch) {
  if (!_cache) return
  _cache.crmSettings = { ...(_cache.crmSettings || {}), ...patch }
}
// tasks
export function cacheUpsertTask(row) {
  cacheUpsertBy('tasks', row)
}
export function cacheRemoveTask(id) {
  cacheRemoveBy('tasks', id)
}
export function cacheRemoveTasksForProject(projectId) {
  if (!_cache) return
  _cache.tasks = _cache.tasks.filter((t) => t.project_id !== projectId)
}
// ---- groundwork mutators (not wired yet) ----
export function cacheUpsertEmail(row) {
  cacheUpsertBy('emails', row)
}
export function cacheRemoveEmail(id) {
  cacheRemoveBy('emails', id)
}
export function cacheUpsertNotification(row) {
  cacheUpsertBy('notifications', row)
}
export function cacheRemoveNotification(id) {
  cacheRemoveBy('notifications', id)
}
// text_markers: composite PK (project_id, kind, channel).
export function cacheUpsertTextMarker(row) {
  if (!_cache) return
  const i = _cache.textMarkers.findIndex(
    (m) => m.project_id === row.project_id && m.kind === row.kind && (m.channel || 'text') === (row.channel || 'text'),
  )
  if (i === -1) _cache.textMarkers.push(row)
  else _cache.textMarkers[i] = row
}
export function cacheRemoveTextMarker(projectId, kind, channel = 'text') {
  if (!_cache) return
  _cache.textMarkers = _cache.textMarkers.filter(
    (m) => !(m.project_id === projectId && m.kind === kind && (m.channel || 'text') === channel),
  )
}
// keyed-by-project_id jsonb tables
export function cacheUpsertInvoice(row) {
  cacheUpsertBy('invoices', row, 'project_id')
}
export function cacheRemoveInvoice(projectId) {
  cacheRemoveBy('invoices', projectId, 'project_id')
}
export function cacheUpsertContract(row) {
  cacheUpsertBy('contracts', row, 'project_id')
}
export function cacheRemoveContract(projectId) {
  cacheRemoveBy('contracts', projectId, 'project_id')
}
export function cacheUpsertRecipient(row) {
  cacheUpsertBy('recipients', row, 'project_id')
}
export function cacheRemoveRecipient(projectId) {
  cacheRemoveBy('recipients', projectId, 'project_id')
}
// inquiries: keyed by id (relay inquiry id).
export function cacheUpsertInquiry(row) {
  cacheUpsertBy('inquiries', row, 'id')
}
export function cacheRemoveInquiry(id) {
  cacheRemoveBy('inquiries', id, 'id')
}
// calendar_map (single row): merge a patch ({ calendars } / { projects } / { tasks }).
export function cacheSetCalendarMap(patch) {
  if (!_cache) return
  _cache.calendarMap = { ...(_cache.calendarMap || {}), ...patch }
}
// crm_config (single row): replace the { data } payload.
export function cacheSetCrmConfig(data) {
  if (!_cache) return
  _cache.crmConfig = data
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

// ================= Phase-2 async DB helpers =================
// Raw rows (snake_case columns / jsonb payloads), matching what the import wrote and what the
// per-entity read paths re-map. WIRED now: payments, expenses, mileage_trips, crm_settings, tasks.
// The rest are groundwork for a later batch (same conventions, no caller yet).

// ---------------- payments ----------------
export async function getAllPayments() {
  const { data, error } = await sb().from('payments').select('*')
  must(error, 'getAllPayments')
  return data || []
}
export async function upsertPayment(row) {
  const { error } = await sb().from('payments').upsert(row, { onConflict: 'id' })
  must(error, 'upsertPayment')
}
export async function deletePayment(id) {
  const { error } = await sb().from('payments').delete().eq('id', id)
  must(error, 'deletePayment')
}
export async function deletePaymentsForProject(projectId) {
  const { error } = await sb().from('payments').delete().eq('project_id', projectId)
  must(error, 'deletePaymentsForProject')
}

// ---------------- expenses ----------------
export async function getAllExpenses() {
  const { data, error } = await sb().from('expenses').select('*')
  must(error, 'getAllExpenses')
  return data || []
}
export async function upsertExpense(row) {
  const { error } = await sb().from('expenses').upsert(row, { onConflict: 'id' })
  must(error, 'upsertExpense')
}
export async function deleteExpense(id) {
  const { error } = await sb().from('expenses').delete().eq('id', id)
  must(error, 'deleteExpense')
}

// ---------------- mileage_trips ----------------
export async function getAllMileageTrips() {
  const { data, error } = await sb().from('mileage_trips').select('*')
  must(error, 'getAllMileageTrips')
  return data || []
}
export async function upsertMileageTrip(row) {
  const { error } = await sb().from('mileage_trips').upsert(row, { onConflict: 'id' })
  must(error, 'upsertMileageTrip')
}
export async function deleteMileageTrip(id) {
  const { error } = await sb().from('mileage_trips').delete().eq('id', id)
  must(error, 'deleteMileageTrip')
}
export async function deleteMileageTripsForProject(projectId) {
  const { error } = await sb().from('mileage_trips').delete().eq('project_id', projectId)
  must(error, 'deleteMileageTripsForProject')
}

// ---------------- crm_settings (single row id=1) ----------------
export async function getCrmSettings() {
  const { data, error } = await sb()
    .from('crm_settings')
    .select('mileage_rate_per_mile')
    .eq('id', 1)
    .maybeSingle()
  must(error, 'getCrmSettings')
  return data || { mileage_rate_per_mile: null }
}
export async function setCrmSettings(patch) {
  const { error } = await sb().from('crm_settings').upsert({ id: 1, ...patch }, { onConflict: 'id' })
  must(error, 'setCrmSettings')
}

// ---------------- tasks ----------------
export async function getAllTasks() {
  const { data, error } = await sb().from('tasks').select('*')
  must(error, 'getAllTasks')
  return data || []
}
export async function upsertTask(row) {
  const { error } = await sb().from('tasks').upsert(row, { onConflict: 'id' })
  must(error, 'upsertTask')
}
export async function deleteTask(id) {
  const { error } = await sb().from('tasks').delete().eq('id', id)
  must(error, 'deleteTask')
}
export async function deleteTasksForProject(projectId) {
  const { error } = await sb().from('tasks').delete().eq('project_id', projectId)
  must(error, 'deleteTasksForProject')
}

// ---------------- emails (groundwork) ----------------
export async function getAllEmails() {
  const { data, error } = await sb().from('emails').select('*')
  must(error, 'getAllEmails')
  return data || []
}
export async function upsertEmail(row) {
  const { error } = await sb().from('emails').upsert(row, { onConflict: 'id' })
  must(error, 'upsertEmail')
}
export async function deleteEmail(id) {
  const { error } = await sb().from('emails').delete().eq('id', id)
  must(error, 'deleteEmail')
}

// The email-template library and its `templates` table were removed 2026-07-31.

// ---------------- notifications (groundwork) ----------------
export async function getAllNotifications() {
  const { data, error } = await sb().from('notifications').select('*')
  must(error, 'getAllNotifications')
  return data || []
}
export async function upsertNotification(row) {
  const { error } = await sb().from('notifications').upsert(row, { onConflict: 'id' })
  must(error, 'upsertNotification')
}
export async function deleteNotification(id) {
  const { error } = await sb().from('notifications').delete().eq('id', id)
  must(error, 'deleteNotification')
}

// ---------------- text_markers (groundwork; composite PK) ----------------
export async function getAllTextMarkers() {
  const { data, error } = await sb().from('text_markers').select('*')
  must(error, 'getAllTextMarkers')
  return data || []
}
export async function upsertTextMarker(row) {
  const { error } = await sb().from('text_markers').upsert(row, { onConflict: 'project_id,kind,channel' })
  must(error, 'upsertTextMarker')
}
export async function deleteTextMarker(projectId, kind, channel = 'text') {
  const { error } = await sb()
    .from('text_markers')
    .delete()
    .eq('project_id', projectId)
    .eq('kind', kind)
    .eq('channel', channel)
  must(error, 'deleteTextMarker')
}

// ---------------- per-project jsonb tables (groundwork) ----------------
export async function getAllInvoices() {
  const { data, error } = await sb().from('invoices').select('*')
  must(error, 'getAllInvoices')
  return data || []
}
export async function upsertInvoice(row) {
  const { error } = await sb().from('invoices').upsert(row, { onConflict: 'project_id' })
  must(error, 'upsertInvoice')
}
export async function deleteInvoice(projectId) {
  const { error } = await sb().from('invoices').delete().eq('project_id', projectId)
  must(error, 'deleteInvoice')
}
export async function getAllContracts() {
  const { data, error } = await sb().from('contracts').select('*')
  must(error, 'getAllContracts')
  return data || []
}
export async function upsertContract(row) {
  const { error } = await sb().from('contracts').upsert(row, { onConflict: 'project_id' })
  must(error, 'upsertContract')
}
export async function deleteContract(projectId) {
  const { error } = await sb().from('contracts').delete().eq('project_id', projectId)
  must(error, 'deleteContract')
}
export async function getAllRecipients() {
  const { data, error } = await sb().from('recipients').select('*')
  must(error, 'getAllRecipients')
  return data || []
}
export async function upsertRecipient(row) {
  const { error } = await sb().from('recipients').upsert(row, { onConflict: 'project_id' })
  must(error, 'upsertRecipient')
}
export async function deleteRecipient(projectId) {
  const { error } = await sb().from('recipients').delete().eq('project_id', projectId)
  must(error, 'deleteRecipient')
}

// ---------------- inquiries (groundwork; keyed by id) ----------------
export async function getAllInquiries() {
  const { data, error } = await sb().from('inquiries').select('*')
  must(error, 'getAllInquiries')
  return data || []
}
export async function upsertInquiry(row) {
  const { error } = await sb().from('inquiries').upsert(row, { onConflict: 'id' })
  must(error, 'upsertInquiry')
}
export async function deleteInquiry(id) {
  const { error } = await sb().from('inquiries').delete().eq('id', id)
  must(error, 'deleteInquiry')
}

// ---------------- calendar_map (single row id=1) ----------------
export async function getCalendarMap() {
  const { data, error } = await sb()
    .from('calendar_map')
    .select('calendars, projects, tasks')
    .eq('id', 1)
    .maybeSingle()
  must(error, 'getCalendarMap')
  return data || { calendars: {}, projects: {}, tasks: {} }
}
export async function setCalendarMap(patch) {
  const { error } = await sb().from('calendar_map').upsert({ id: 1, ...patch }, { onConflict: 'id' })
  must(error, 'setCalendarMap')
}

// ---------------- crm_config (single row id=1) ----------------
// Returns the { data } payload only (the app's config object), or {} if unset.
export async function getCrmConfig() {
  const { data, error } = await sb().from('crm_config').select('data').eq('id', 1).maybeSingle()
  must(error, 'getCrmConfig')
  return data?.data || {}
}
export async function setCrmConfig(configData) {
  const { error } = await sb().from('crm_config').upsert({ id: 1, data: configData }, { onConflict: 'id' })
  must(error, 'setCrmConfig')
}
