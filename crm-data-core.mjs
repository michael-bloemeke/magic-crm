// Magic CRM data layer (Node side).
//
// Reads Michael's canonical project records (Cowork-owned, READ ONLY here) and
// merges them with a CRM-owned stage overlay so the app can group projects into
// the pipeline. The detail JSONs intentionally have no stage field (stage is a
// HoneyBook concept per the June 15 operating model), so the CRM keeps stage in
// its own file: Project Records/crm-pipeline.json.
//
// Used by crm-data-plugin.mjs (the Vite dev endpoint). When this becomes an
// Electron app, the same functions move to the main process unchanged.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { formatPhoneField } from './crm-phone.mjs'
import {
  CRM_STORE,
  getCachedProjects,
  getCachedPipelineMeta,
  getCachedPayments,
  getCachedTasks,
  getCachedTemplates,
  // async Supabase writers
  insertProject as sbInsertProject,
  updateProject as sbUpdateProject,
  deleteProject as sbDeleteProject,
  purgeProjectData as sbPurgeProjectData,
  setProjectStage as sbSetProjectStage,
  reassignStage as sbReassignStage,
  setPipelineMeta as sbSetPipelineMeta,
  upsertTask as sbUpsertTask,
  deleteTask as sbDeleteTask,
  deleteTasksForProject as sbDeleteTasksForProject,
  upsertTemplate as sbUpsertTemplate,
  deleteTemplate as sbDeleteTemplate,
  // synchronous cache mutators
  cacheUpsertProject,
  cachePatchProject,
  cacheRemoveProject,
  cacheSetProjectStage,
  cacheReassignStage,
  cacheSetPipelineMeta,
  cacheUpsertTask,
  cacheRemoveTask,
  cacheRemoveTasksForProject,
  cacheUpsertTemplate,
  cacheRemoveTemplate,
} from './crm-store.mjs'

export const RECORDS_DIR = path.join(
  os.homedir(),
  'Desktop',
  'Claude',
  'The Award-Winning Magic of Michael Bloemeke',
  'Project Records',
)

const STAGE_FILE = path.join(RECORDS_DIR, 'crm-pipeline.json')
const TASKS_FILE = path.join(RECORDS_DIR, 'crm-tasks.json')
const TEMPLATES_FILE = path.join(RECORDS_DIR, 'crm-templates.json')
const PAYMENTS_FILE = path.join(RECORDS_DIR, 'crm-payments.json')

// Payment rows for the current backend, normalized to the { projectId, amount, dateReceived,
// pending } fields the gates below read. Files: crm-payments.json (camelCase, read directly to
// avoid a circular import with crm-finance.mjs). Supabase: the payments cache (snake_case columns
// mapped to those same fields) so the Booked-stage gate and paid-in-full completion keep working
// after payments moved to Supabase. The gate logic itself is identical in both backends.
function paymentRowsForGate() {
  if (CRM_STORE === 'supabase') {
    return getCachedPayments().map((p) => ({
      projectId: p.project_id == null ? '' : String(p.project_id),
      amount: Number(p.amount) || 0,
      dateReceived: p.date_received == null ? '' : String(p.date_received),
      pending: !!p.pending,
    }))
  }
  const d = readJson(PAYMENTS_FILE)
  const arr = d && Array.isArray(d.payments) ? d.payments : []
  return arr.map((p) => ({
    projectId: p.projectId,
    amount: Number(p.amount),
    dateReceived: p.dateReceived,
    pending: p.pending,
  }))
}

// True if the project has at least one RECEIVED payment (amount + a real date,
// not a date-pending one). Matches isReceivedPayment() in the app.
function hasReceivedPaymentFor(id) {
  return paymentRowsForGate().some(
    (p) => p.projectId === id && !p.pending && Number(p.amount) > 0 && String(p.dateReceived || '').trim() !== '',
  )
}

// Total of RECEIVED payments for a project (used to check a gig is paid in full).
function receivedTotalFor(id) {
  return paymentRowsForGate().reduce(
    (s, p) =>
      p.projectId === id && !p.pending && String(p.dateReceived || '').trim() !== '' ? s + (Number(p.amount) || 0) : s,
    0,
  )
}

// Canonical file that holds each bucket (for moving projects between them).
const BUCKET_FILE = {
  active: 'active-projects.json',
  completed: 'completed-2026.json',
  archived: 'archived-projects.json',
}

// "June 17, 2026" — matches the activity_log date style in the records.
function logDate() {
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  const d = new Date()
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`
}

// The bucket files. `active` is one file; `completed` and `archived` are split by
// YEAR (completed-2026.json, archived-2025.json, ...). A record files under its
// EVENT year, or (no event date) the year it was created, derived from its log.
// Files are discovered from disk so a new year's file is picked up automatically.
function allBuckets() {
  let files = []
  try {
    files = fs.readdirSync(RECORDS_DIR)
  } catch {
    files = []
  }
  const out = [{ file: 'active-projects.json', bucket: 'active' }]
  for (const f of files.filter((f) => /^completed-\d{4}\.json$/.test(f)).sort()) out.push({ file: f, bucket: 'completed' })
  for (const f of files.filter((f) => /^archived-\d{4}\.json$/.test(f)).sort()) out.push({ file: f, bucket: 'archived' })
  // Legacy single archived file (pre the 2026-06-19 per-year split); read if present.
  if (files.includes('archived-projects.json')) out.push({ file: 'archived-projects.json', bucket: 'archived' })
  // Soft-deleted projects (30-day trash). Per-year like completed/archived.
  for (const f of files.filter((f) => /^deleted-\d{4}\.json$/.test(f)).sort()) out.push({ file: f, bucket: 'deleted' })
  return out
}

// The year a completed/archived record files under: its event year, else the
// earliest year in its activity_log (≈ when it was created), else the current year.
// Exported so the Supabase backup exporter (supabase/backup-export.mjs) files each
// completed/archived row into the SAME per-year bucket the app would, without reinventing this.
export function recordYear(rec) {
  const m = String(rec?.event_date || '').trim().match(/^(\d{4})/)
  if (m) return m[1]
  let earliest = null
  for (const e of Array.isArray(rec?.activity_log) ? rec.activity_log : []) {
    const ym = String(e).match(/\b(20\d{2})\b/)
    if (ym) {
      const y = Number(ym[1])
      if (earliest == null || y < earliest) earliest = y
    }
  }
  return String(earliest ?? new Date().getFullYear())
}

function projData(file) {
  const data = readJson(path.join(RECORDS_DIR, file)) || { projects: [] }
  if (!Array.isArray(data.projects)) data.projects = []
  return data
}
function writeProjData(file, data) {
  fs.writeFileSync(path.join(RECORDS_DIR, file), JSON.stringify(data, null, 2) + '\n')
}
// Move one record from a source file into a target file, target-first so a later
// failure duplicates (caught by loadAll's dedup) rather than losing the record.
function commitMove(fromFile, fromData, toFile, rec, id) {
  fromData.projects = fromData.projects.filter((p) => slugify(p.client_name) !== id)
  const toData = projData(toFile)
  toData.projects = toData.projects.filter((p) => slugify(p.client_name) !== id)
  toData.projects.push(rec)
  writeProjData(toFile, toData)
  try {
    writeProjData(fromFile, fromData)
  } catch (e) {
    try {
      const revert = projData(toFile)
      revert.projects = revert.projects.filter((p) => slugify(p.client_name) !== id)
      writeProjData(toFile, revert)
    } catch {
      // best-effort; loadAll() dedups by slug as a safety net
    }
    throw e
  }
}

// The pipeline STRUCTURE (categories + stages) is editable in the app and stored
// in crm-pipeline.json under `structure`. This default seeds it the first time and
// is the repair fallback. Stage ids match the original hardcoded pipeline so any
// existing project->stage mappings stay valid. Invariants (enforced by
// normalizeStructure): the FIRST category (role 'first') is the permanent "Inquiry"
// home and always holds the permanent 'inquiry' stage (the orphanage: a project
// whose stage goes missing lands here); the "Booked" category (role 'booked', sits
// just above Post Show) is payment-gated (a project can't move into any of its
// stages without a received payment) and always keeps >=1 stage; the LAST category
// (role 'postshow') is "Post Show" (projects are only ADDED to it automatically the
// day after the event, never manually) with two fixed stages.
const ORPHAN_STAGE = 'inquiry'
const DEFAULT_STRUCTURE = {
  umbrellas: [
    {
      id: 'inquiry',
      label: 'Inquiry',
      color: 'var(--color-umb-inquiry)',
      role: 'first',
      stages: [
        { id: 'inquiry', name: 'Inquiry' },
        { id: 'answered-inquiry', name: 'Answered Inquiry' },
        { id: 'inquiry-followup-1', name: 'Inquiry Follow Up #1 Sent' },
        { id: 'inquiry-followup-2', name: 'Inquiry Follow Up #2 Sent' },
        { id: 'inquiry-shark', name: 'Inquiry Shark Sent' },
        { id: 'inquiry-breakup', name: 'Inquiry Breakup Sent' },
      ],
    },
    {
      id: 'postcall',
      label: 'Not Yet Booked',
      color: 'var(--color-umb-postcall)',
      role: null,
      stages: [
        { id: 'post-call-info', name: 'Post-Call Info Sent' },
        { id: 'in-communication', name: 'In Communication' },
        { id: 'followup-1', name: 'Follow Up #1 Sent' },
        { id: 'followup-2', name: 'Follow Up #2 Sent' },
        { id: 'shark', name: 'Shark Email Sent' },
        { id: 'breakup', name: 'Breakup Sent' },
      ],
    },
    {
      id: 'booked',
      label: 'Booked',
      color: 'var(--color-umb-booked)',
      role: 'booked',
      stages: [
        { id: 'deposit-sent', name: 'Deposit Sent' },
        { id: 'deposit-paid', name: 'Deposit Paid' },
      ],
    },
    {
      id: 'post-show',
      label: 'Post Show',
      color: 'var(--color-umb-archive)',
      role: 'postshow',
      stages: [
        { id: 'thank-you-payment', name: 'Thank You + Payment' },
        { id: 'thank-you', name: 'Thank You' },
      ],
    },
  ],
}

// The two auto-only stages in the Post Show category (role 'postshow').
const THANK_YOU = 'thank-you'
const THANK_YOU_PAYMENT = 'thank-you-payment'

const EVENT_TYPES = new Set(['Wedding', 'Corporate', 'Private Event', 'Bachelor(ette) Party', 'Other'])

function cleanStr(v, fallback = '') {
  const s = String(v ?? '').trim()
  return s || fallback
}
function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`
}

// Coerce arbitrary input into a structure that ALWAYS satisfies the invariants, so
// neither a client bug nor a hand-edit can break it. Final order is always:
//   [Inquiry (first)] [...middles...] [Booked] [Post Show (last)]
// - Inquiry: holds the permanent 'inquiry' stage (the orphanage).
// - Booked: payment-gated; always >=1 stage; locked just above Post Show.
// - Post Show: auto-only (projects can't be added manually); always last; its two
//   stages are exactly "Thank You + Payment" and "Thank You" (auto-targets).
function normalizeStructure(raw) {
  const src = raw && Array.isArray(raw.umbrellas) && raw.umbrellas.length ? raw.umbrellas : DEFAULT_STRUCTURE.umbrellas
  const seenU = new Set()
  const seenS = new Set()
  let umbrellas = src.map((u) => {
    let id = cleanStr(u && u.id) || newId('c')
    while (seenU.has(id)) id = newId('c')
    seenU.add(id)
    const stages = (Array.isArray(u && u.stages) ? u.stages : []).map((s) => {
      let sid = cleanStr(s && s.id) || newId('s')
      while (seenS.has(sid)) sid = newId('s')
      seenS.add(sid)
      return { id: sid, name: cleanStr(s && s.name, 'Stage') }
    })
    return { id, label: cleanStr(u && u.label, 'Category'), color: cleanStr(u && u.color, 'var(--color-brass)'), role: null, stages }
  })

  // Pull out the three special categories (matching old role markers too, for
  // migration); whatever remains are the middle categories (role null).
  const pull = (pred) => {
    const i = umbrellas.findIndex(pred)
    return i === -1 ? null : umbrellas.splice(i, 1)[0]
  }
  let first = pull((u) => u.role === 'first' || u.id === 'inquiry')
  let booked = pull((u) => u.role === 'booked' || u.role === 'last' || u.id === 'booked')
  let postshow = pull((u) => u.role === 'postshow' || u.id === 'post-show' || /post[\s-]*show/i.test(u.label))
  const middles = umbrellas

  if (!first) first = { id: 'inquiry', label: 'Inquiry', color: 'var(--color-umb-inquiry)', role: 'first', stages: [] }
  first.role = 'first'
  if (!first.stages.some((s) => s.id === ORPHAN_STAGE)) first.stages.unshift({ id: ORPHAN_STAGE, name: 'Inquiry' })

  if (!booked) booked = { id: 'booked', label: 'Booked', color: 'var(--color-umb-booked)', role: 'booked', stages: [] }
  booked.role = 'booked'
  if (booked.stages.length === 0) booked.stages.push({ id: newId('s'), name: 'Booked' })

  if (!postshow) postshow = { id: 'post-show', label: 'Post Show', color: 'var(--color-umb-archive)', role: 'postshow', stages: [] }
  postshow.role = 'postshow'
  // Post Show always HAS the two auto-target stages (renames preserved by id). Any
  // other stages are kept (so projects Michael had already placed in his manual
  // "Post Show" category aren't orphaned) and can be cleared/deleted afterward.
  const psName = (id, dflt) => postshow.stages.find((s) => s.id === id)?.name || dflt
  const psOthers = postshow.stages.filter((s) => s.id !== THANK_YOU && s.id !== THANK_YOU_PAYMENT)
  postshow.stages = [
    { id: THANK_YOU_PAYMENT, name: psName(THANK_YOU_PAYMENT, 'Thank You + Payment') },
    { id: THANK_YOU, name: psName(THANK_YOU, 'Thank You') },
    ...psOthers,
  ]

  return { umbrellas: [first, ...middles, booked, postshow] }
}

function loadStructureFrom(map) {
  return normalizeStructure(map && map.structure ? map.structure : DEFAULT_STRUCTURE)
}
// The editable pipeline structure (categories + stages), normalized. Under supabase the
// raw structure lives in pipeline_meta (cached); under files it's crm-pipeline.json. Either
// way it feeds through the identical loadStructureFrom/normalizeStructure path.
export function loadStructure() {
  if (CRM_STORE === 'supabase') return loadStructureFrom({ structure: getCachedPipelineMeta().structure })
  return loadStructureFrom(readJson(STAGE_FILE) || {})
}
function validStageIdSet(structure) {
  const s = new Set()
  for (const u of structure.umbrellas) for (const st of u.stages) s.add(st.id)
  return s
}
function bookedStageIdSet(structure) {
  const booked = structure.umbrellas.find((u) => u.role === 'booked')
  return new Set(booked ? booked.stages.map((s) => s.id) : [])
}
function postshowStageIdSet(structure) {
  const ps = structure.umbrellas.find((u) => u.role === 'postshow')
  return new Set(ps ? ps.stages.map((s) => s.id) : [])
}

// True if a project is booked-or-beyond: sitting in the Booked or Post Show category, or already
// completed. Used by the calendar sync to decide whether a gig needs an "Inquiry: " prefix.
export function isProjectBooked(project) {
  if (!project) return false
  if (project.bucket === 'completed') return true
  const structure = loadStructure()
  return bookedStageIdSet(structure).has(project.stageId) || postshowStageIdSet(structure).has(project.stageId)
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function str(v) {
  return v == null ? '' : String(v)
}

// Postgres returns timestamptz in offset form (e.g. "2026-06-29T18:47:46.036771+00:00"); the files
// store the JS toISOString() "...Z" form. Re-serialize through Date so a supabase read yields the
// identical createdAt string the files path produces (mirrors isoZ in crm-contacts.mjs).
function isoZ(v) {
  const s = String(v ?? '').trim()
  if (!s) return ''
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? s : d.toISOString()
}

// Project id = slug of client_name (the stable join key). Exported so the Supabase backup
// exporter can key rows the same way the app does. NOTE: the ORIGINAL import (import-phase1.mjs)
// used a slightly different slug (no NFKD, and empty -> '') to build the DB ids. This function is
// the app's canonical slugify; the exporter reads the id straight off each row (projects.id) rather
// than re-slugging, so its output is independent of any slug drift between the two.
export function slugify(name) {
  return (
    String(name || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project'
  )
}

function coerceType(t) {
  const v = str(t).trim()
  return EVENT_TYPES.has(v) ? v : 'Other'
}

function normalize(p, bucket) {
  return {
    // id is the slug of client_name and is STABLE: client_name never changes
    // once set, so every overlay (stage/tasks/payments/mileage/links) keeps its
    // join key even when Michael renames the project. The editable display name
    // lives in project_name; client_name is the original/identity name.
    id: slugify(p.client_name),
    client: str(p.project_name) || str(p.client_name),
    bucket,
    eventType: coerceType(p.event_type),
    eventDate: str(p.event_date),
    leadDate: str(p.lead_date),
    signedOff: !!p.stat_signed_off,
    eventLocation: str(p.event_location),
    venueType: str(p.venue_type),
    indoorsOrOutdoors: str(p.indoors_or_outdoors),
    arrivalTime: str(p.arrival_time),
    eventStartTime: str(p.event_start_time),
    showStartTime: str(p.show_start_time),
    numberOfGuests: str(p.number_of_guests),
    ageOfGuests: str(p.age_of_guests),
    performanceStyle: str(p.performance_style),
    totalFee:
      typeof p.total_fee === 'number'
        ? p.total_fee
        : p.total_fee == null || p.total_fee === ''
          ? null
          : Number(p.total_fee) || null,
    tips:
      typeof p.tips === 'number'
        ? p.tips
        : p.tips == null || p.tips === ''
          ? null
          : Number(p.tips) || null,
    tipsMethod: str(p.tips_method) || 'Cash',
    mileage:
      typeof p.mileage === 'number'
        ? p.mileage
        : p.mileage == null || p.mileage === ''
          ? null
          : Number(p.mileage) || null,
    vips: str(p.vips),
    av: str(p.av),
    contactNames: str(p.contact_names),
    contactEmails: str(p.contact_emails),
    contactPhones: str(p.contact_phones),
    bookingSource: str(p.booking_source),
    eventSummary: str(p.event_summary),
    eventDescription: str(p.event_description),
    projectNotes: str(p.project_notes),
    initialInquiry: str(p.initial_inquiry),
    howItWent: str(p.how_it_went),
    assets: str(p.assets),
    status: str(p.status),
    flags: Array.isArray(p.flags) ? p.flags.map(String) : [],
    activityLog: Array.isArray(p.activity_log) ? p.activity_log.map(String) : [],
    archiveReason: str(p.archive_reason),
    whyArchived: str(p.why_archived),
    completedDate: str(p.completed_date),
    deletedAt: str(p.deleted_at),
  }
}

// First-pass stage guess from an ACTIVE project's text. Editable afterward; the
// chosen stage is persisted to crm-pipeline.json so this only runs for new
// projects. Completed/archived projects are not staged (they have their own pages).
function inferStage(p) {
  const t = `${p.projectNotes} ${p.activityLog.join(' ')} ${p.eventDescription}`.toLowerCase()
  const has = (re) => re.test(t)

  // Booked + paid
  if (
    has(/\bbooked\b/) ||
    has(/deposit paid/) ||
    has(/retainer paid/) ||
    has(/fully paid/) ||
    has(/paid in full/) ||
    has(/check arrived/) ||
    has(/signed the contract and paid/) ||
    has(/paid the .{0,12}retainer/) ||
    has(/moved to deposit paid/)
  ) {
    return 'deposit-paid'
  }

  // Agreement / invoice / deposit sent but not yet paid
  if (
    has(/deposit sent/) ||
    has(/invoice sent/) ||
    has(/agreement (&|and) invoice sent/) ||
    has(/performance agreement.{0,20}sent/)
  ) {
    return 'deposit-sent'
  }

  if (has(/breakup/)) return 'breakup'
  if (has(/shark/)) return 'shark'

  // Had a sales/discovery call → actively in communication
  if (
    has(/sales call completed/) ||
    has(/discovery call/) ||
    has(/follow-up call/) ||
    has(/post-call/) ||
    has(/\bquoted\b/)
  ) {
    return 'in-communication'
  }

  // Replied to the inquiry but no call yet
  if (has(/replied/) || has(/sent follow-up/) || has(/penciled in/)) return 'answered-inquiry'

  // Brand-new inquiry
  return 'inquiry'
}

function stageMeta() {
  return {
    file: 'crm-pipeline.json',
    owner: 'Magic CRM app (~/Desktop/Claude/magic-crm)',
    purpose:
      'CRM-owned overlay assigning a pipeline STAGE to each project. The canonical detail JSONs (active/completed/archived) intentionally have no stage field (stage is a HoneyBook concept), so the CRM stores stage here to group projects into its kanban/flow pipeline.',
    cowork_guidance:
      'Safe to read. Do NOT delete or overwrite. The CRM auto-creates entries for new projects by inference, but any stage Michael sets in the CRM is saved here. Detail fields are NOT duplicated here; they stay in the canonical JSONs. RULE: a project may only be at stage "deposit-paid" if it has a RECEIVED payment (amount + a real date, not pending) in crm-payments.json. The CRM refuses to set deposit-paid without one; if you set it here by hand, first add the matching received payment to crm-payments.json.',
    keyed_by: 'project id = slug of client_name (lowercase, non-alphanumerics -> hyphens)',
    also_stores_structure:
      'structure = the editable pipeline: umbrellas[] (categories) each with id, label, color, role ("first"=Inquiry/permanent home; "booked"=payment-gated; "postshow"=auto-only Post Show, always last; null=middle) and stages[] of {id,name}. Order is always [first, ...middles, booked, postshow]. The first category keeps the permanent "inquiry" stage (the orphanage); booked keeps >=1 stage; postshow has exactly "thank-you-payment" + "thank-you". A project may sit at any stage id present here; the day after its event_date a Booked-category project auto-moves to Post Show ("thank-you" if paid in full, else "thank-you-payment").',
    also_stores: 'flowLayout = node positions + links for the CRM flow-chart view (CRM-managed)',
  }
}

function writeStageFile(map) {
  try {
    fs.writeFileSync(STAGE_FILE, JSON.stringify(map, null, 2) + '\n')
  } catch (e) {
    // Non-fatal: the app still works read-only if the overlay can't be written.
    console.error('[crm-data] could not write crm-pipeline.json:', e?.message || e)
  }
}

export function loadAll() {
  return CRM_STORE === 'supabase' ? loadAllSupabase() : loadAllFiles()
}

// SUPABASE read path. Same DTOs, same cross-bucket dedup, same orphan-rehoming and Post Show
// auto-progression as the files path. The ONE difference: the stored per-project stage is the
// `stage_id` COLUMN on each cached project row (not a `stages` map). We compute the derived
// stage in memory and return it; we do NOT persist derived changes in this reads-only pass
// (that is the write pass). Rows are raw snake_case, so normalize() runs on them unchanged.
function loadAllSupabase() {
  // Ride-along maintenance: permanently purge any soft-deleted projects past 30 days.
  // Throttled + fire-and-forget; removes them from the cache before the loop below.
  autoPurgeExpiredDeleted()
  const projects = []
  // Dedup by id (slug), keeping the first row per id. The cache is a flat list of rows across
  // all buckets; project ids are unique in Supabase (id is the PK), so this is a belt-and-braces
  // pass matching the files path's dedup semantics.
  const seenIds = new Set()
  for (const p of getCachedProjects()) {
    const norm = normalize(p, str(p.bucket) || 'active')
    if (seenIds.has(norm.id)) continue
    seenIds.add(norm.id)
    // Stash the stored stage from the row so we can apply the derived-stage logic below.
    norm._storedStage = str(p.stage_id)
    projects.push(norm)
  }

  const structure = loadStructure()
  const valid = validStageIdSet(structure)

  // Derived-stage changes computed below are persisted back to Supabase, mirroring how the files
  // path persists to crm-pipeline.json. This is fire-and-forget: we update the cache synchronously
  // (so the value we return and any later sync read agree) and kick off the async column write
  // without awaiting it. These derivations are idempotent (recomputed on every load), so a dropped
  // write self-heals next load. `persist` records the id->stage changes to flush after the loop.
  const persist = new Map()

  for (const p of projects) {
    if (p.bucket !== 'active') {
      p.stageId = ''
      delete p._storedStage
      continue
    }
    const existing = p._storedStage
    delete p._storedStage
    if (existing && valid.has(existing)) {
      p.stageId = existing
    } else {
      // Orphaned (stage missing/no longer exists) OR never staged: land in Inquiry. Under
      // files a never-seen project is inferred; under supabase every active project already
      // has a stage_id column, so a blank/invalid one means orphaned -> Inquiry.
      p.stageId = ORPHAN_STAGE
      if (existing !== ORPHAN_STAGE) persist.set(p.id, ORPHAN_STAGE) // rehome the orphan
    }
  }

  // Post Show auto-progression (in memory only). Identical rule to the files path.
  const now = new Date()
  const todayLocal = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const bookedSet = bookedStageIdSet(structure)
  for (const p of projects) {
    if (p.bucket !== 'active') continue
    const fee = p.totalFee
    const paidInFull = fee != null && receivedTotalFor(p.id) + 0.005 >= fee
    if (bookedSet.has(p.stageId) && p.eventDate && p.eventDate < todayLocal) {
      const target = paidInFull ? THANK_YOU : THANK_YOU_PAYMENT
      if (p.stageId !== target) {
        p.stageId = target
        persist.set(p.id, target)
      }
    } else if (p.stageId === THANK_YOU_PAYMENT && paidInFull) {
      p.stageId = THANK_YOU
      persist.set(p.id, THANK_YOU)
    }
  }

  // Flush the derived-stage changes: update the cache now, fire the Supabase write without awaiting.
  for (const [id, stageId] of persist) {
    cacheSetProjectStage(id, stageId)
    sbSetProjectStage(id, stageId).catch((err) =>
      console.error(`[crm-data] loadAllSupabase: failed to persist derived stage ${id}=${stageId}:`, err?.message || err),
    )
  }

  return { projects, recordsDir: RECORDS_DIR }
}

// FILES read path. Unchanged from the original loadAll(): reads the canonical bucket JSONs +
// crm-pipeline.json, infers/repairs stages, and may PERSIST derived stage changes back to
// crm-pipeline.json (writeStageFile). This is the byte-for-byte original behavior.
function loadAllFiles() {
  const projects = []
  // Dedup by id (slug) across buckets, keeping the first (BUCKETS order =
  // active > completed > archived). This means a record that ended up in two
  // files (e.g. a half-completed move) surfaces once, in the higher-precedence
  // bucket, instead of double-rendering with a colliding id.
  const seenIds = new Set()
  for (const b of allBuckets()) {
    const data = readJson(path.join(RECORDS_DIR, b.file))
    const arr = data && Array.isArray(data.projects) ? data.projects : []
    for (const p of arr) {
      const norm = normalize(p, b.bucket)
      if (seenIds.has(norm.id)) {
        console.warn(`[crm-data] duplicate project id "${norm.id}" in ${b.file}; keeping the earlier bucket`)
        continue
      }
      seenIds.add(norm.id)
      projects.push(norm)
    }
  }

  const map = readJson(STAGE_FILE) || {}
  if (!map.stages || typeof map.stages !== 'object') map.stages = {}
  const structure = loadStructureFrom(map)
  const valid = validStageIdSet(structure)

  let dirty = !fs.existsSync(STAGE_FILE) || !map.structure
  map.structure = structure // persist the (possibly seeded/normalized) structure
  for (const p of projects) {
    // Only active projects carry a pipeline stage; the rest live on their own pages.
    if (p.bucket !== 'active') {
      p.stageId = ''
      continue
    }
    const existing = map.stages[p.id]
    if (existing && valid.has(existing)) {
      p.stageId = existing
    } else if (existing) {
      // Orphaned: the stage this project was on no longer exists. Land it in Inquiry.
      p.stageId = ORPHAN_STAGE
      map.stages[p.id] = ORPHAN_STAGE
      dirty = true
    } else {
      // Never seen before: infer a starting stage (clamped to a stage that exists).
      const guess = inferStage(p)
      p.stageId = valid.has(guess) ? guess : ORPHAN_STAGE
      map.stages[p.id] = p.stageId
      dirty = true
    }
  }

  // --- Post Show auto-progression --------------------------------------------
  // The day AFTER the event, a project sitting in the Booked category moves to
  // Post Show automatically: "Thank You" if it's paid in full, else "Thank You +
  // Payment". And a project already in "Thank You + Payment" is promoted to
  // "Thank You" once it becomes fully paid. (No scheduler needed; this runs every
  // time the projects load.) Projects are NEVER added to Post Show any other way.
  const now = new Date()
  const todayLocal = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const bookedSet = bookedStageIdSet(structure)
  for (const p of projects) {
    if (p.bucket !== 'active') continue
    const fee = p.totalFee
    const paidInFull = fee != null && receivedTotalFor(p.id) + 0.005 >= fee
    if (bookedSet.has(p.stageId) && p.eventDate && p.eventDate < todayLocal) {
      const target = paidInFull ? THANK_YOU : THANK_YOU_PAYMENT
      if (p.stageId !== target) {
        p.stageId = target
        map.stages[p.id] = target
        dirty = true
      }
    } else if (p.stageId === THANK_YOU_PAYMENT && paidInFull) {
      p.stageId = THANK_YOU
      map.stages[p.id] = THANK_YOU
      dirty = true
    }
  }

  map._meta = stageMeta()
  if (dirty) writeStageFile(map)

  return { projects, recordsDir: RECORDS_DIR }
}

export async function setStage(id, stageId) {
  const structure = loadStructure()
  if (!id || !validStageIdSet(structure).has(stageId)) throw new Error('invalid id or stageId')
  // Post Show is auto-only: projects land there the day after the event, never by a
  // manual move. (Moving a project OUT of Post Show is fine.)
  if (postshowStageIdSet(structure).has(stageId)) {
    throw new Error('Projects move into Post Show automatically the day after the event; they can be moved out but not in.')
  }
  // A project can't enter ANY stage in the Booked category without a received
  // payment on file. Enforced here (the data layer) so EVERY path is gated. hasReceivedPaymentFor
  // reads crm-payments.json in BOTH backends (payments are not migrated), so the gate is identical.
  if (bookedStageIdSet(structure).has(stageId) && !hasReceivedPaymentFor(id)) {
    throw new Error(
      'Cannot move to a Booked stage without a received payment (amount + date). Log a payment for this project in crm-payments.json first.',
    )
  }
  if (CRM_STORE === 'supabase') {
    cacheSetProjectStage(id, stageId)
    await sbSetProjectStage(id, stageId)
    return { ok: true, id, stageId }
  }
  const map = readJson(STAGE_FILE) || { stages: {} }
  if (!map.stages) map.stages = {}
  map.stages[id] = stageId
  map.structure = loadStructureFrom(map)
  map._meta = stageMeta()
  writeStageFile(map)
  return { ok: true, id, stageId }
}

// Persist an edited pipeline structure (add/rename/delete/reorder of categories +
// stages). Normalized so the invariants always hold regardless of what's sent.
export async function saveStructure(raw) {
  const structure = normalizeStructure(raw)
  if (CRM_STORE === 'supabase') {
    // Structure lives in pipeline_meta.structure (cached). Store the normalized structure so the
    // cache and DB match what loadStructure() will re-normalize on read.
    cacheSetPipelineMeta({ structure })
    await sbSetPipelineMeta({ structure })
    return structure
  }
  const map = readJson(STAGE_FILE) || { stages: {} }
  if (!map.stages) map.stages = {}
  map.structure = structure
  map._meta = stageMeta()
  writeStageFile(map)
  return structure
}

// Move every project currently sitting on one of `fromStageIds` to `toStageId`
// (used by the "Dump all projects into Inquiry" action before deleting a stage or
// category). toStageId is clamped to a stage that exists (falling back to Inquiry).
export async function reassignStage(fromStageIds, toStageId) {
  const valid = validStageIdSet(loadStructure())
  const to = valid.has(toStageId) ? toStageId : ORPHAN_STAGE
  const from = new Set(Array.isArray(fromStageIds) ? fromStageIds : [fromStageIds])
  if (CRM_STORE === 'supabase') {
    const fromIds = [...from]
    // Count from the cache (matches the files path counting stage entries) before mutating.
    let changed = 0
    for (const p of getCachedProjects()) if (from.has(p.stage_id)) changed++
    cacheReassignStage(fromIds, to)
    await sbReassignStage(fromIds, to)
    return { ok: true, changed, to }
  }
  const map = readJson(STAGE_FILE) || { stages: {} }
  if (!map.stages) map.stages = {}
  let changed = 0
  for (const pid of Object.keys(map.stages)) {
    if (from.has(map.stages[pid])) {
      map.stages[pid] = to
      changed++
    }
  }
  map.structure = loadStructureFrom(map)
  map._meta = stageMeta()
  writeStageFile(map)
  return { ok: true, changed, to }
}

// Flow-view node layout (positions + links) lives in crm-pipeline.json too, so
// the CRM's visual arrangement is durable across app changes and browsers.
export function loadLayout() {
  if (CRM_STORE === 'supabase') return getCachedPipelineMeta().flow_layout || null
  const map = readJson(STAGE_FILE) || {}
  return map.flowLayout || null
}

export async function saveLayout(layout) {
  if (CRM_STORE === 'supabase') {
    cacheSetPipelineMeta({ flow_layout: layout })
    await sbSetPipelineMeta({ flow_layout: layout })
    return { ok: true }
  }
  const map = readJson(STAGE_FILE) || { stages: {} }
  if (!map.stages) map.stages = {}
  map.flowLayout = layout
  map._meta = stageMeta()
  writeStageFile(map)
  return { ok: true }
}

// --- Tasks (CRM-owned, in crm-tasks.json) ------------------------------------

function tasksMeta() {
  return {
    file: 'crm-tasks.json',
    owner: 'Magic CRM app (~/Desktop/Claude/magic-crm)',
    purpose:
      'CRM-owned task list. Each task links to a project by projectId (slug of client_name) and carries a due date + done flag. The CRM creates, checks off, and deletes these.',
    cowork_guidance:
      'Safe to read. The CRM manages this file. If Cowork wants to auto-create standard tasks for a project (midway / 1-week / day-before / thank-you), append objects to tasks[] with the same shape and a matching projectId.',
    task_shape: 'id, projectId, title, dueDate (YYYY-MM-DD), dueTime (HH:MM 24h, optional/"" for none), done (bool), createdAt (ISO)',
  }
}

// A time string kept as "HH:MM" (24h) or "" when the task has no specific time (an all-day task).
function normalizeTime(t) {
  const s = String(t || '').trim()
  const m = s.match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return ''
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return ''
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

function writeTasksFile(data) {
  try {
    fs.writeFileSync(TASKS_FILE, JSON.stringify(data, null, 2) + '\n')
  } catch (e) {
    console.error('[crm-data] could not write crm-tasks.json:', e?.message || e)
  }
}

function readTasksFile() {
  const data = readJson(TASKS_FILE) || { tasks: [] }
  if (!Array.isArray(data.tasks)) data.tasks = []
  return data
}

// Raw DB task row -> the app's task record. dueTime is normalized identically to the files path
// (normalizeTime defaults a missing/invalid time to ""), so loadTasks() is byte-identical either
// backend. createdAt is re-serialized to the "...Z" form via isoZ.
function taskFromRow(r) {
  return {
    id: r.id,
    projectId: r.project_id == null ? '' : String(r.project_id),
    title: r.title == null ? '' : String(r.title),
    dueDate: r.due_date == null ? '' : String(r.due_date),
    dueTime: normalizeTime(r.due_time),
    done: !!r.done,
    createdAt: isoZ(r.created_at),
  }
}
// App task record -> raw DB row (snake_case columns).
function taskToRow(t) {
  return {
    id: t.id,
    project_id: t.projectId || '',
    title: t.title || '',
    due_date: t.dueDate || '',
    due_time: t.dueTime || '',
    done: !!t.done,
    created_at: t.createdAt || null,
  }
}

export function loadTasks() {
  if (CRM_STORE === 'supabase') return getCachedTasks().map(taskFromRow)
  // Default dueTime for tasks created before the field existed.
  return readTasksFile().tasks.map((t) => ({ ...t, dueTime: normalizeTime(t.dueTime) }))
}

export async function addTask({ projectId, title, dueDate, dueTime }) {
  const t = String(title || '').trim()
  if (!t) throw new Error('task title is required')
  const task = {
    id: crypto.randomUUID(),
    projectId: String(projectId || ''),
    title: t,
    dueDate: String(dueDate || ''),
    // Optional time-of-day. "" = an all-day task (still gets date-based CRM reminders).
    dueTime: normalizeTime(dueTime),
    done: false,
    createdAt: new Date().toISOString(),
  }
  if (CRM_STORE === 'supabase') {
    const row = taskToRow(task)
    cacheUpsertTask(row)
    await sbUpsertTask(row)
    return task
  }
  const data = readTasksFile()
  data.tasks.push(task)
  data._meta = tasksMeta()
  writeTasksFile(data)
  return task
}

export async function updateTask({ id, done, title, dueDate, dueTime }) {
  if (CRM_STORE === 'supabase') {
    const existing = getCachedTasks().find((x) => x.id === id)
    if (!existing) throw new Error('task not found')
    const task = taskFromRow(existing)
    // Remember the pre-edit alarm time so we can tell if the reschedule actually moved it.
    const prevDate = task.dueDate
    const prevTime = task.dueTime
    if (typeof done === 'boolean') task.done = done
    if (title != null) task.title = String(title)
    if (dueDate != null) task.dueDate = String(dueDate)
    if (dueTime != null) task.dueTime = normalizeTime(dueTime)
    const row = taskToRow(task)
    // Rescheduled? Clear the cloud alarm stamp so notify-cron will alarm this task again at its new
    // time. taskToRow omits notified_at (so a plain edit like toggling done leaves it untouched); we
    // add an explicit null only when the date or time really changed. Not a normalized column here,
    // just passed straight through to the upsert.
    if (task.dueDate !== prevDate || task.dueTime !== prevTime) row.notified_at = null
    cacheUpsertTask(row)
    await sbUpsertTask(row)
    return task
  }
  const data = readTasksFile()
  const task = data.tasks.find((x) => x.id === id)
  if (!task) throw new Error('task not found')
  if (typeof done === 'boolean') task.done = done
  if (title != null) task.title = String(title)
  if (dueDate != null) task.dueDate = String(dueDate)
  if (dueTime != null) task.dueTime = normalizeTime(dueTime)
  data._meta = tasksMeta()
  writeTasksFile(data)
  return task
}

export async function deleteTask(id) {
  if (CRM_STORE === 'supabase') {
    cacheRemoveTask(id)
    await sbDeleteTask(id)
    return { ok: true }
  }
  const data = readTasksFile()
  data.tasks = data.tasks.filter((x) => x.id !== id)
  data._meta = tasksMeta()
  writeTasksFile(data)
  return { ok: true }
}

// --- Editing project DETAILS (writes the canonical bucket files) -------------
// The CRM can now edit detail fields inline. Edits write straight back to
// whichever canonical file holds the project (active/completed/archived), the
// same files Cowork maintains. The project's DISPLAY name is editable via the
// 'client' field, which writes project_name (NOT client_name): client_name stays
// fixed as the id/join key, so renaming a project never breaks its stage, tasks,
// payments, mileage, or contact links. activity_log is not editable here (it is
// structured and machine-appended).

const EDITABLE_FIELDS = {
  // The project's display name (editable). Stored separately from client_name so
  // the project id (slug of client_name) stays put and overlay joins don't break.
  client: 'project_name',
  eventType: 'event_type',
  eventDate: 'event_date',
  leadDate: 'lead_date',
  signedOff: 'stat_signed_off',
  eventLocation: 'event_location',
  venueType: 'venue_type',
  indoorsOrOutdoors: 'indoors_or_outdoors',
  arrivalTime: 'arrival_time',
  eventStartTime: 'event_start_time',
  showStartTime: 'show_start_time',
  numberOfGuests: 'number_of_guests',
  ageOfGuests: 'age_of_guests',
  performanceStyle: 'performance_style',
  totalFee: 'total_fee',
  tips: 'tips',
  tipsMethod: 'tips_method',
  mileage: 'mileage',
  vips: 'vips',
  av: 'av',
  contactNames: 'contact_names',
  contactEmails: 'contact_emails',
  contactPhones: 'contact_phones',
  bookingSource: 'booking_source',
  eventSummary: 'event_summary',
  eventDescription: 'event_description',
  projectNotes: 'project_notes',
  initialInquiry: 'initial_inquiry',
}

// Coerce an inbound field value to the stored form, exactly as the files path does inline.
function coerceFieldValue(jsonField, value) {
  if (jsonField === 'stat_signed_off') {
    return value === true || value === 'true' || value === 1 || value === '1'
  }
  if (jsonField === 'total_fee' || jsonField === 'mileage' || jsonField === 'tips') {
    const n = Number(String(value ?? '').replace(/[^0-9.]/g, ''))
    return value === '' || value == null || Number.isNaN(n) ? null : n
  }
  if (jsonField === 'contact_phones') {
    return formatPhoneField(value == null ? '' : String(value))
  }
  return value == null ? '' : String(value)
}

export async function updateProjectField({ id, field, value }) {
  const jsonField = EDITABLE_FIELDS[field]
  if (!jsonField) throw new Error(`field not editable: ${field}`)

  if (CRM_STORE === 'supabase') {
    if (!getCachedProjects().some((p) => p.id === id)) throw new Error(`project not found: ${id}`)
    const stored = coerceFieldValue(jsonField, value)
    cachePatchProject(id, { [jsonField]: stored })
    await sbUpdateProject(id, { [jsonField]: stored })
    return { ok: true, id, field, value: stored }
  }

  for (const b of allBuckets()) {
    const file = path.join(RECORDS_DIR, b.file)
    const data = readJson(file)
    if (!data || !Array.isArray(data.projects)) continue
    const proj = data.projects.find((p) => slugify(p.client_name) === id)
    if (!proj) continue

    if (jsonField === 'total_fee' || jsonField === 'mileage' || jsonField === 'tips') {
      const n = Number(String(value ?? '').replace(/[^0-9.]/g, ''))
      proj[jsonField] = value === '' || value == null || Number.isNaN(n) ? null : n
    } else if (jsonField === 'contact_phones') {
      proj[jsonField] = formatPhoneField(value == null ? '' : String(value))
    } else {
      proj[jsonField] = value == null ? '' : String(value)
    }
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n')
    return { ok: true, id, field, value: proj[jsonField] }
  }
  throw new Error(`project not found: ${id}`)
}

// --- Logging a call (the "Made a call" button) -------------------------------
// Appends a dated call entry to the project's activity_log. answered=true logs
// "They answered." plus an optional note; answered=false logs whether a voicemail
// was left. Mirrors the activity_log style (newest first). Returns the updated log.
export async function logCall({ id, answered, voicemail, note } = {}) {
  if (!id) throw new Error('project id is required')
  let detail
  if (answered) {
    detail = 'They answered.'
    const n = String(note || '').trim()
    if (n) detail += ` Talked about: ${n}`
  } else {
    detail = voicemail ? 'No answer, left a voicemail.' : 'No answer, no voicemail left.'
  }
  const entry = `${logDate()}: Made a call. ${detail}`
  if (CRM_STORE === 'supabase') {
    const row = getCachedProjects().find((p) => p.id === id)
    if (!row) throw new Error(`project not found: ${id}`)
    const activity_log = [entry, ...(Array.isArray(row.activity_log) ? row.activity_log.map(String) : [])]
    cachePatchProject(id, { activity_log })
    await sbUpdateProject(id, { activity_log })
    return { ok: true, id, entry, activityLog: activity_log }
  }
  for (const b of allBuckets()) {
    const file = path.join(RECORDS_DIR, b.file)
    const data = readJson(file)
    if (!data || !Array.isArray(data.projects)) continue
    const proj = data.projects.find((p) => slugify(p.client_name) === id)
    if (!proj) continue
    if (!Array.isArray(proj.activity_log)) proj.activity_log = []
    proj.activity_log.unshift(entry)
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n')
    return { ok: true, id, entry, activityLog: proj.activity_log.map(String) }
  }
  throw new Error(`project not found: ${id}`)
}

// Append a dated one-liner to a project's activity_log (newest first), matching the
// "Month Day, Year: ..." convention. Shared helper for actions outside this file
// (e.g. the email sender). Best-effort: returns {ok:false} if the project isn't found
// rather than throwing, so a logging miss never fails the action that triggered it.
export async function appendActivityLog(id, text) {
  const entry = `${logDate()}: ${String(text || '').trim()}`
  if (CRM_STORE === 'supabase') {
    const row = getCachedProjects().find((p) => p.id === id)
    if (!row) return { ok: false }
    const activity_log = [entry, ...(Array.isArray(row.activity_log) ? row.activity_log.map(String) : [])]
    cachePatchProject(id, { activity_log })
    await sbUpdateProject(id, { activity_log })
    return { ok: true, entry }
  }
  for (const b of allBuckets()) {
    const file = path.join(RECORDS_DIR, b.file)
    const data = readJson(file)
    if (!data || !Array.isArray(data.projects)) continue
    const proj = data.projects.find((p) => slugify(p.client_name) === id)
    if (!proj) continue
    if (!Array.isArray(proj.activity_log)) proj.activity_log = []
    proj.activity_log.unshift(entry)
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n')
    return { ok: true, entry }
  }
  return { ok: false }
}

// --- Creating a project (from the CRM's New Project button) ------------------
// Michael-initiated: writes a new record into active-projects.json with only a
// name required, then sets its pipeline stage (default inquiry). Everything else
// is optional and editable afterward.

export async function createProject(input = {}) {
  const name = String(input.clientName ?? input.client_name ?? '').trim()
  if (!name) throw new Error('project name is required')
  const id = slugify(name)

  // The slug is the join key for stage/tasks/payments, so it must be unique.
  if (loadAll().projects.some((p) => p.id === id)) {
    throw new Error(`a project named "${name}" already exists`)
  }

  const feeRaw = input.totalFee
  const n = Number(String(feeRaw ?? '').replace(/[^0-9.]/g, ''))
  const total_fee = feeRaw === '' || feeRaw == null || Number.isNaN(n) ? null : n
  const mileageRaw = input.mileage
  const mn = Number(String(mileageRaw ?? '').replace(/[^0-9.]/g, ''))
  const mileage = mileageRaw === '' || mileageRaw == null || Number.isNaN(mn) ? null : mn

  const rec = {
    client_name: name,
    project_name: name, // editable display name; client_name stays as the id key
    event_type: EVENT_TYPES.has(String(input.eventType)) ? String(input.eventType) : '',
    event_date: String(input.eventDate ?? ''),
    event_location: String(input.eventLocation ?? ''),
    total_fee,
    mileage,
    contact_names: String(input.contactNames ?? ''),
    contact_emails: String(input.contactEmails ?? ''),
    contact_phones: formatPhoneField(String(input.contactPhones ?? '')),
    project_notes: String(input.projectNotes ?? ''),
    status: 'open',
    flags: [],
    activity_log: [`${logDate()}: Project created in the CRM.`],
  }

  // Clamp the requested stage to a valid, allowed starting stage BEFORE writing (so the persisted
  // stage_id is correct in one write under supabase). A brand-new project has no payment yet, so it
  // can't start in the Booked category, and Post Show is auto-only; either way land it in Inquiry.
  const structure = loadStructure()
  let stageId = validStageIdSet(structure).has(input.stageId) ? input.stageId : ORPHAN_STAGE
  if (bookedStageIdSet(structure).has(stageId) || postshowStageIdSet(structure).has(stageId)) stageId = ORPHAN_STAGE

  if (CRM_STORE === 'supabase') {
    // One row in the projects table carries both the record and its stage (stage_id column). Fill the
    // remaining columns to null so the raw row matches what normalize() reads (import-phase1 shape).
    const row = {
      id,
      client_name: name,
      project_name: rec.project_name,
      bucket: 'active',
      stage_id: stageId,
      event_type: rec.event_type,
      event_date: rec.event_date,
      event_location: rec.event_location,
      venue_type: null,
      indoors_or_outdoors: null,
      arrival_time: null,
      event_start_time: null,
      show_start_time: null,
      number_of_guests: null,
      age_of_guests: null,
      performance_style: null,
      total_fee,
      tips: null,
      tips_method: null,
      mileage,
      vips: null,
      av: null,
      contact_names: rec.contact_names,
      contact_emails: rec.contact_emails,
      contact_phones: rec.contact_phones,
      booking_source: null,
      event_summary: null,
      event_description: null,
      project_notes: rec.project_notes,
      how_it_went: null,
      assets: null,
      status: 'open',
      flags: [],
      activity_log: rec.activity_log,
      archive_reason: null,
      why_archived: null,
      completed_date: null,
      links_seeded: false,
    }
    cacheUpsertProject(row)
    await sbInsertProject(row)
    return loadAll().projects.find((p) => p.id === id)
  }

  const file = path.join(RECORDS_DIR, BUCKET_FILE.active)
  const data = readJson(file) || { projects: [] }
  if (!Array.isArray(data.projects)) data.projects = []
  data.projects.push(rec)
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n')

  await setStage(id, stageId)

  return loadAll().projects.find((p) => p.id === id)
}

// --- Moving projects between buckets (Archive / Complete / Restore) ----------
// Archiving and completing are ACTIONS in the CRM: the project's record is moved
// out of active-projects.json into the matching canonical file, so it leaves the
// pipeline entirely. The reverse (restore) brings it back to active.

function bucketPath(bucket) {
  return path.join(RECORDS_DIR, BUCKET_FILE[bucket])
}

function readBucket(bucket) {
  const data = readJson(bucketPath(bucket)) || { projects: [] }
  if (!Array.isArray(data.projects)) data.projects = []
  return data
}

function writeBucket(bucket, data) {
  fs.writeFileSync(bucketPath(bucket), JSON.stringify(data, null, 2) + '\n')
}

// Pure move of one project record from one bucket's array to another, applying
// `mutate(record)` before it lands. Returns the new from/to arrays so callers
// (and tests) can verify without touching disk.
export function moveProjectRecord(fromProjects, toProjects, id, mutate) {
  const idx = fromProjects.findIndex((p) => slugify(p.client_name) === id)
  if (idx === -1) throw new Error(`project not found in source: ${id}`)
  const [rec] = fromProjects.splice(idx, 1)
  if (typeof mutate === 'function') mutate(rec)
  // Keep the most recent landing if it somehow already exists in the target.
  const existing = toProjects.findIndex((p) => slugify(p.client_name) === id)
  if (existing !== -1) toProjects.splice(existing, 1)
  toProjects.push(rec)
  return { fromProjects, toProjects, record: rec }
}

function appendLog(rec, line) {
  if (!Array.isArray(rec.activity_log)) rec.activity_log = []
  rec.activity_log.unshift(line)
}

// Under files, drop the project's entry from crm-pipeline.json's stages map. Under supabase the
// stage lives in the projects.stage_id column and is cleared as part of the bucket-move UPDATE
// (below), so this is a files-only helper. Kept sync (files path only ever calls it).
function clearStageEntry(id) {
  const map = readJson(STAGE_FILE)
  if (map && map.stages && map.stages[id]) {
    delete map.stages[id]
    map._meta = stageMeta()
    writeStageFile(map)
  }
}

function moveBetween(from, to, id, mutate) {
  if (from === to) throw new Error('source and target buckets are the same')
  const fromData = readBucket(from)
  const toData = readBucket(to)
  moveProjectRecord(fromData.projects, toData.projects, id, mutate)
  // Write the target first; if THAT fails we have not yet dropped the source, so
  // no harm. If the target lands but the source write then fails, roll the target
  // back so the record can't end up duplicated across two bucket files.
  writeBucket(to, toData)
  try {
    writeBucket(from, fromData)
  } catch (e) {
    try {
      const revert = readBucket(to)
      revert.projects = revert.projects.filter((p) => slugify(p.client_name) !== id)
      writeBucket(to, revert)
    } catch {
      // best-effort rollback; loadAll() also dedups by slug as a safety net
    }
    throw e
  }
  return { ok: true, id, from, to }
}

export async function archiveProject({ id, reason }) {
  const r = String(reason || '').trim()
  if (CRM_STORE === 'supabase') {
    const row = getCachedProjects().find((p) => p.id === id && (str(p.bucket) || 'active') === 'active')
    if (!row) throw new Error(`project not found in active: ${id}`)
    const activity_log = [
      `${logDate()}: Project archived in CRM.${r ? ` Reason: ${r}.` : ''}`,
      ...(Array.isArray(row.activity_log) ? row.activity_log.map(String) : []),
    ]
    // One UPDATE on the single row: flip the bucket, record the reason, clear the stage.
    const patch = { bucket: 'archived', stage_id: null, activity_log, ...(r ? { archive_reason: r } : {}) }
    cachePatchProject(id, patch)
    await sbUpdateProject(id, patch)
    return { ok: true, id, from: 'active', to: 'archived' }
  }
  const activeData = projData('active-projects.json')
  const rec = activeData.projects.find((p) => slugify(p.client_name) === id)
  if (!rec) throw new Error(`project not found in active: ${id}`)
  if (r) rec.archive_reason = r
  appendLog(rec, `${logDate()}: Project archived in CRM.${r ? ` Reason: ${r}.` : ''}`)
  const toFile = `archived-${recordYear(rec)}.json`
  commitMove('active-projects.json', activeData, toFile, rec, id)
  clearStageEntry(id)
  return { ok: true, id, from: 'active', to: toFile }
}

export async function completeProject({ id }) {
  // No discrepancies: a gig can only be completed once it's paid in full (the received payments
  // cover the total fee). Enforced here so every path is gated. receivedTotalFor reads
  // crm-payments.json in BOTH backends (payments are not migrated), so the gate is identical.
  if (CRM_STORE === 'supabase') {
    const row = getCachedProjects().find((p) => p.id === id && (str(p.bucket) || 'active') === 'active')
    if (!row) throw new Error(`project not found in active: ${id}`)
    const raw = row.total_fee
    const fee = raw == null || raw === '' ? null : Number(typeof raw === 'number' ? raw : String(raw).replace(/[^0-9.]/g, ''))
    if (fee == null || Number.isNaN(fee)) {
      throw new Error('Set a total fee before completing this project, so its payments can be reconciled to it.')
    }
    const received = receivedTotalFor(id)
    if (received + 0.005 < fee) {
      throw new Error(
        `Cannot complete: $${Math.round(fee - received)} still outstanding (received $${Math.round(received)} of the $${Math.round(fee)} fee). Log the remaining payment first.`,
      )
    }
    const activity_log = [
      `${logDate()}: Project marked complete in CRM.`,
      ...(Array.isArray(row.activity_log) ? row.activity_log.map(String) : []),
    ]
    const patch = { bucket: 'completed', stage_id: null, completed_date: new Date().toISOString().slice(0, 10), activity_log }
    cachePatchProject(id, patch)
    await sbUpdateProject(id, patch)
    return { ok: true, id, from: 'active', to: 'completed' }
  }
  const activeData = projData('active-projects.json')
  const rec = activeData.projects.find((p) => slugify(p.client_name) === id)
  if (!rec) throw new Error(`project not found in active: ${id}`)
  const raw = rec.total_fee
  const fee = raw == null || raw === '' ? null : Number(typeof raw === 'number' ? raw : String(raw).replace(/[^0-9.]/g, ''))
  if (fee == null || Number.isNaN(fee)) {
    throw new Error('Set a total fee before completing this project, so its payments can be reconciled to it.')
  }
  const received = receivedTotalFor(id)
  if (received + 0.005 < fee) {
    throw new Error(
      `Cannot complete: $${Math.round(fee - received)} still outstanding (received $${Math.round(received)} of the $${Math.round(fee)} fee). Log the remaining payment first.`,
    )
  }
  rec.completed_date = new Date().toISOString().slice(0, 10)
  appendLog(rec, `${logDate()}: Project marked complete in CRM.`)
  // A completed gig files under its EVENT year (not when it was marked complete).
  const toFile = `completed-${recordYear(rec)}.json`
  commitMove('active-projects.json', activeData, toFile, rec, id)
  clearStageEntry(id)
  return { ok: true, id, from: 'active', to: toFile }
}

// Bring an archived/completed project back into the active pipeline. Pulls the
// record out of EVERY non-active bucket file (so a stray duplicate can't be left
// behind) and lands a single copy in active.
export async function restoreProject({ id }) {
  if (CRM_STORE === 'supabase') {
    const row = getCachedProjects().find((p) => p.id === id && (str(p.bucket) || 'active') !== 'active')
    if (!row) throw new Error(`project not found in archived/completed: ${id}`)
    const activity_log = [
      `${logDate()}: Project returned to the active pipeline.`,
      ...(Array.isArray(row.activity_log) ? row.activity_log.map(String) : []),
    ]
    // Back to active with archive/complete markers cleared and stage cleared, so the next load
    // re-derives its stage into Inquiry (matching the files path's clearStageEntry -> re-infer).
    const patch = { bucket: 'active', stage_id: null, archive_reason: null, completed_date: null, deleted_at: null, activity_log }
    cachePatchProject(id, patch)
    await sbUpdateProject(id, patch)
    return { ok: true, id, to: 'active' }
  }
  let rec = null
  const touched = []
  for (const b of allBuckets()) {
    if (b.bucket === 'active') continue
    const data = projData(b.file)
    const idx = data.projects.findIndex((p) => slugify(p.client_name) === id)
    if (idx !== -1) {
      const [pulled] = data.projects.splice(idx, 1)
      if (!rec) rec = pulled
      touched.push([b.file, data])
    }
  }
  if (!rec) throw new Error(`project not found in archived/completed: ${id}`)
  delete rec.archive_reason
  delete rec.completed_date
  delete rec.deleted_at
  appendLog(rec, `${logDate()}: Project returned to the active pipeline.`)

  const active = projData('active-projects.json')
  active.projects = active.projects.filter((p) => slugify(p.client_name) !== id)
  active.projects.push(rec)
  // Write active (target) first so a later failure duplicates rather than loses.
  writeProjData('active-projects.json', active)
  for (const [file, data] of touched) writeProjData(file, data)
  clearStageEntry(id) // let it re-infer a stage on next load
  return { ok: true, id, to: 'active' }
}

// --- Deleting a project (SOFT: 30-day trash) ---------------------------------
// Delete is now a soft move to the 'deleted' bucket, stamped with deleted_at. The
// project leaves the pipeline immediately but nothing is destroyed: it shows on the
// Deleted page for 30 days, can be restored, and is permanently purged (see
// purgeProject) either by the "Delete permanently" action or the auto-sweep once the
// 30 days elapse. Restoring is restoreProject (which already handles any non-active
// bucket). No data is touched here beyond the bucket flip, so a restore is lossless.
export async function deleteProject({ id } = {}) {
  if (!id) throw new Error('project id is required')

  if (CRM_STORE === 'supabase') {
    const row = getCachedProjects().find((p) => p.id === id)
    if (!row) throw new Error(`project not found: ${id}`)
    const name = str(row.client_name)
    const fromBucket = str(row.bucket) || 'active'
    if (fromBucket === 'deleted') return { ok: true, id, from: fromBucket, to: 'deleted', name } // already trashed
    const activity_log = [
      `${logDate()}: Project moved to Deleted.`,
      ...(Array.isArray(row.activity_log) ? row.activity_log.map(String) : []),
    ]
    const patch = { bucket: 'deleted', stage_id: null, deleted_at: new Date().toISOString(), activity_log }
    cachePatchProject(id, patch)
    await sbUpdateProject(id, patch)
    return { ok: true, id, from: fromBucket, to: 'deleted', name }
  }

  // FILES path: move the record out of whatever bucket holds it into deleted-<year>.json.
  let rec = null
  let fromBucket = null
  const touched = []
  for (const b of allBuckets()) {
    if (b.bucket === 'deleted') continue
    const data = projData(b.file)
    const idx = data.projects.findIndex((p) => slugify(p.client_name) === id)
    if (idx !== -1) {
      const [pulled] = data.projects.splice(idx, 1)
      if (!rec) {
        rec = pulled
        fromBucket = b.bucket
      }
      touched.push([b.file, data])
    }
  }
  if (!rec) throw new Error(`project not found: ${id}`)
  rec.deleted_at = new Date().toISOString()
  appendLog(rec, `${logDate()}: Project moved to Deleted.`)
  const toFile = `deleted-${recordYear(rec)}.json`
  const target = projData(toFile)
  target.projects = target.projects.filter((p) => slugify(p.client_name) !== id)
  target.projects.push(rec)
  writeProjData(toFile, target) // write target first so a mid-way failure duplicates rather than loses
  for (const [file, data] of touched) writeProjData(file, data)
  clearStageEntry(id)
  return { ok: true, id, from: fromBucket, to: toFile, name: str(rec.client_name) }
}

// --- Permanently deleting a project (full cascade, NO undo) -------------------
// Removes the project row AND every per-project record across all tables (payments,
// mileage, emails, notifications, invoices, contracts, questionnaires, portals,
// recipients, text-markers, inquiries), plus the CRM overlay (stage + tasks). Nothing
// is left orphaned. Called by the explicit "Delete permanently" action and by the
// 30-day auto-purge sweep.
export async function purgeProject({ id } = {}) {
  if (!id) throw new Error('project id is required')

  if (CRM_STORE === 'supabase') {
    const row = getCachedProjects().find((p) => p.id === id)
    const name = row ? str(row.client_name) : id
    if (row) cacheRemoveProject(id) // drop from cache + its link entry
    await sbPurgeProjectData(id) // every per-project table (contact_links cascades with the row below)
    await sbDeleteProject(id) // the project row itself
    purgeTasksForProject(id)
    return { ok: true, id, name }
  }

  let removed = null
  for (const b of allBuckets()) {
    const file = path.join(RECORDS_DIR, b.file)
    const data = readJson(file)
    if (!data || !Array.isArray(data.projects)) continue
    const match = data.projects.find((p) => slugify(p.client_name) === id)
    if (!match) continue
    if (!removed) removed = match
    data.projects = data.projects.filter((p) => slugify(p.client_name) !== id)
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n')
  }
  clearStageEntry(id)
  purgeTasksForProject(id)
  return { ok: true, id, name: removed ? str(removed.client_name) : id }
}

// --- 30-day auto-purge sweep -------------------------------------------------
// Permanently purge soft-deleted projects whose 30-day window has elapsed. Throttled
// to once/hour and fire-and-forget so it rides along a normal load without blocking or
// re-running on every read. Supabase only (the live store); the files path is legacy.
const DELETED_TTL_MS = 30 * 86400000
let _lastDeletedSweep = 0
export function autoPurgeExpiredDeleted() {
  if (CRM_STORE !== 'supabase') return
  const now = Date.now()
  if (now - _lastDeletedSweep < 3600_000) return
  _lastDeletedSweep = now
  const expired = getCachedProjects().filter((p) => {
    if ((str(p.bucket) || 'active') !== 'deleted') return false
    const t = Date.parse(str(p.deleted_at))
    return Number.isFinite(t) && now - t >= DELETED_TTL_MS
  })
  for (const p of expired) {
    purgeProject({ id: p.id }).catch((e) => console.error(`[crm-data] auto-purge failed for ${p.id}:`, e?.message || e))
  }
}

// Purge a deleted project's CRM tasks. Best-effort: a failure here never fails the delete.
// Extracted so both paths share it. Under supabase, tasks now live in Supabase, so purge the cache
// synchronously + fire the DB delete (fire-and-forget, since deleteProject already awaited the
// project delete and this runs in that sync tail); under files, rewrite crm-tasks.json.
function purgeTasksForProject(id) {
  try {
    if (CRM_STORE === 'supabase') {
      cacheRemoveTasksForProject(id)
      sbDeleteTasksForProject(id).catch((e) =>
        console.error('[crm-data] could not purge Supabase tasks for deleted project:', e?.message || e),
      )
      return
    }
    const t = readTasksFile()
    const before = t.tasks.length
    t.tasks = t.tasks.filter((x) => x.projectId !== id)
    if (t.tasks.length !== before) {
      t._meta = tasksMeta()
      writeTasksFile(t)
    }
  } catch (e) {
    console.error('[crm-data] could not purge tasks for deleted project:', e?.message || e)
  }
}

// --- Email templates (CRM-owned, in crm-templates.json) ----------------------

function templatesMeta() {
  return {
    file: 'crm-templates.json',
    owner: 'Magic CRM app (~/Desktop/Claude/magic-crm)',
    purpose:
      'CRM-owned reusable email templates. Michael defines these in the Templates page and can drop them into the reply composer in Communications.',
    cowork_guidance: 'Safe to read. The CRM manages this file.',
    template_shape: "id, name, subject, body, format ('html' rich body that may contain smart-field placeholder chips, or 'text'; absent = treat as text), updatedAt (ISO)",
  }
}

function readTemplatesFile() {
  const data = readJson(TEMPLATES_FILE) || { templates: [] }
  if (!Array.isArray(data.templates)) data.templates = []
  return data
}

function writeTemplatesFile(data) {
  try {
    data._meta = templatesMeta()
    fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(data, null, 2) + '\n')
  } catch (e) {
    console.error('[crm-data] could not write crm-templates.json:', e?.message || e)
  }
}

// Raw DB template row -> file-shape record. The files omit `format` on legacy rows (treated as text);
// the DB stores it explicitly, so we emit format only when it's a real value, matching the files.
function templateFromRow(r) {
  const t = {
    id: r.id,
    name: String(r.name || ''),
    subject: String(r.subject || ''),
    body: String(r.body || ''),
    updatedAt: isoZ(r.updated_at),
  }
  if (r.format != null) t.format = r.format === 'html' ? 'html' : 'text'
  return t
}
// File-shape template record -> raw DB row.
function templateToRow(t) {
  return {
    id: t.id,
    name: String(t.name || ''),
    subject: String(t.subject || ''),
    body: String(t.body || ''),
    format: t.format == null ? null : t.format === 'html' ? 'html' : 'text',
    updated_at: t.updatedAt || null,
  }
}

export function loadTemplates() {
  if (CRM_STORE === 'supabase') return getCachedTemplates().map(templateFromRow)
  return readTemplatesFile().templates
}

export async function saveTemplate({ id, name, subject, body, format }) {
  const now = new Date().toISOString()
  if (CRM_STORE === 'supabase') {
    if (id) {
      const existing = getCachedTemplates().find((x) => x.id === id)
      if (!existing) throw new Error('template not found')
      const t = templateFromRow(existing)
      t.name = String(name ?? t.name)
      t.subject = String(subject ?? t.subject)
      t.body = String(body ?? t.body)
      if (format != null) t.format = format === 'html' ? 'html' : 'text'
      t.updatedAt = now
      const row = templateToRow(t)
      cacheUpsertTemplate(row)
      await sbUpsertTemplate(row)
      return t
    }
    const t = {
      id: crypto.randomUUID(),
      name: String(name || 'Untitled template'),
      subject: String(subject || ''),
      body: String(body || ''),
      format: format === 'html' ? 'html' : 'text',
      updatedAt: now,
    }
    const row = templateToRow(t)
    cacheUpsertTemplate(row)
    await sbUpsertTemplate(row)
    return t
  }
  const data = readTemplatesFile()
  if (id) {
    const t = data.templates.find((x) => x.id === id)
    if (!t) throw new Error('template not found')
    t.name = String(name ?? t.name)
    t.subject = String(subject ?? t.subject)
    t.body = String(body ?? t.body)
    if (format != null) t.format = format === 'html' ? 'html' : 'text'
    t.updatedAt = now
    writeTemplatesFile(data)
    return t
  }
  const t = {
    id: crypto.randomUUID(),
    name: String(name || 'Untitled template'),
    subject: String(subject || ''),
    body: String(body || ''),
    format: format === 'html' ? 'html' : 'text',
    updatedAt: now,
  }
  data.templates.push(t)
  writeTemplatesFile(data)
  return t
}

export async function deleteTemplate(id) {
  if (CRM_STORE === 'supabase') {
    cacheRemoveTemplate(id)
    await sbDeleteTemplate(id)
    return { ok: true }
  }
  const data = readTemplatesFile()
  data.templates = data.templates.filter((x) => x.id !== id)
  writeTemplatesFile(data)
  return { ok: true }
}
