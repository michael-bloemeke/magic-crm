// One-way backup EXPORTER: Supabase (source of truth) -> the Project Records JSON files.
//
// This is the INVERSE of supabase/import-phase1.mjs. Import read the JSON files and wrote the
// Supabase columns; this reads the Supabase columns and rebuilds the exact JSON files, so those
// files stay a current, readable, git-backed MIRROR of the cloud. It is strictly one-way: it only
// READS Supabase and WRITES the target JSON files. It never writes to Supabase.
//
// SAFETY: takes a TARGET directory argument and DEFAULTS TO A TEMP DIR, so running it during
// development/testing never touches the real Project Records. Point it at the real directory only
// when you actually want to refresh the mirror:
//   node supabase/backup-export.mjs /path/to/Project\ Records
//
// It reconstructs these files (and nothing else):
//   active-projects.json, completed-<year>.json, archived-<year>.json,
//   crm-contacts.json, crm-links.json, crm-pipeline.json,
//   crm-payments.json, crm-expenses.json, crm-mileage.json, crm-tasks.json,
//   crm-emails.json, crm-notifications.json, crm-text-markers.json,
//   crm-invoices.json, crm-contracts.json, crm-recipients.json, crm-inquiries.json,
//   crm-config.json, crm-calendar-map.json
// After this, the backup covers ALL crm data (every crm-*.json now lives in Supabase).
//
// Run with Node 22:  /Users/michaelbloemeke/.local/node22/bin/node supabase/backup-export.mjs [targetDir]

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

// Reuse the app's OWN read helpers (raw snake_case rows) so the data is exactly what the app sees.
import {
  getAllProjects,
  getContacts,
  getLinksMap,
  getPipelineMeta,
  getAllPayments,
  getAllExpenses,
  getAllMileageTrips,
  getCrmSettings,
  getAllTasks,
  getAllEmails,
  getAllNotifications,
  getAllTextMarkers,
  getAllInvoices,
  getAllContracts,
  getAllRecipients,
  getAllInquiries,
  getCalendarMap,
  getCrmConfig,
} from '../crm-store.mjs'
// Reuse the app's OWN record-year logic so completed/archived rows file into the SAME per-year
// bucket the app would. Do NOT reinvent it.
import { recordYear } from '../crm-data-core.mjs'

const DIR = path.dirname(fileURLToPath(import.meta.url))

// The real mirror lives here. We only write into it when the caller passes it explicitly.
export const REAL_RECORDS_DIR = path.join(
  os.homedir(),
  'Desktop',
  'Claude',
  'The Award-Winning Magic of Michael Bloemeke',
  'Project Records',
)

// ---------------------------------------------------------------------------
// Project record reconstruction
// ---------------------------------------------------------------------------
//
// A project record in the files is the snake_case columns MINUS the CRM/DB-internal ones that live
// elsewhere or are not part of the canonical record: bucket (which file it lands in), stage_id
// (crm-pipeline.json), links_seeded (crm-links.json), created_at / updated_at (DB bookkeeping).
//
// The canonical FIELD ORDER matches the on-disk files. archive_reason / why_archived / completed_date
// only appear on the buckets that use them (archived / completed), matching the files. We emit a field
// when its column value is present (non-null, and for arrays non-empty for the optional flags/tips),
// which reproduces the files' content. Whether a given empty field was historically stored as "" or
// omitted is NOT recoverable from the columns (both collapse to the same DB value), so the per-file
// deep-compare in verify-backup.mjs treats an absent key and an empty value as equal content.

// String columns, in the canonical order the detail block uses in the files.
const STR_DETAIL_ORDER = [
  'event_type',
  'event_date',
  'event_location',
  'venue_type',
  'indoors_or_outdoors',
  'event_start_time',
  'show_start_time',
  'number_of_guests',
  'age_of_guests',
  'performance_style',
]
// After performance_style comes total_fee, then the rest of the string block.
const STR_TAIL_ORDER = [
  'vips',
  'av',
  'contact_names',
  'contact_emails',
  'contact_phones',
  'booking_source',
  'event_description',
  'project_notes',
]

// Emit a numeric field if the column holds a real number (import stored non-numeric fees/tips/mileage
// as null, so a null here means "no value" -> omit, matching the files).
function putNum(out, key, v) {
  if (typeof v === 'number' && Number.isFinite(v)) out[key] = v
}
// Emit a string field if the column holds a non-empty string.
function putStr(out, key, v) {
  if (v != null && String(v) !== '') out[key] = String(v)
}

// Postgres returns timestamptz as "2026-06-18T04:40:13.206+00:00" (offset form); the files store the
// JS toISOString() form "...Z". Same instant, different text. Re-serialize through Date so the export
// yields the identical string the files hold. This mirrors isoZ() in crm-contacts.mjs (the app's
// supabase read path applies the same normalization when mapping created_at/updated_at -> createdAt/updatedAt).
function isoZ(v) {
  const s = String(v ?? '').trim()
  if (!s) return ''
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? s : d.toISOString()
}

// Build one file record from a raw DB project row, in canonical key order for its bucket.
function projectRecord(row) {
  const out = {}
  // client_name is always first and always present.
  out.client_name = String(row.client_name)
  // project_name is the editable display name; only some records carry it (import omitted it when null).
  putStr(out, 'project_name', row.project_name)

  for (const k of STR_DETAIL_ORDER) putStr(out, k, row[k])
  // total_fee is a real number when quoted; otherwise the original non-numeric note (e.g.
  // "TBD (ballpark $750-$1500...)") preserved in total_fee_text, so the files round-trip exactly.
  if (row.total_fee_text != null && String(row.total_fee_text) !== '') out.total_fee = String(row.total_fee_text)
  else putNum(out, 'total_fee', row.total_fee)
  for (const k of STR_TAIL_ORDER) putStr(out, k, row[k])

  // status: rarely present; comes after the string block in the files.
  putStr(out, 'status', row.status)
  // flags: an array; present in the file only when it was set (import defaulted absent -> []).
  if (Array.isArray(row.flags) && row.flags.length) out.flags = row.flags.map(String)

  // tips is a completed-only extra; comes before activity_log in the files that have it. It is kept
  // adjacent to the money fields conceptually but appears late in the on-disk order, so emit here.
  putNum(out, 'tips', row.tips)

  // activity_log is always present (an array, possibly empty).
  out.activity_log = Array.isArray(row.activity_log) ? row.activity_log.map(String) : []

  // Bucket-specific trailers.
  const bucket = String(row.bucket || 'active')
  if (bucket === 'completed') {
    putNum(out, 'mileage', row.mileage)
    putStr(out, 'completed_date', row.completed_date)
    putStr(out, 'how_it_went', row.how_it_went)
  } else if (bucket === 'archived') {
    putStr(out, 'why_archived', row.why_archived)
    putStr(out, 'archive_reason', row.archive_reason)
    putNum(out, 'mileage', row.mileage)
  } else {
    // active: mileage is the only late numeric that appears on a few active records.
    putNum(out, 'mileage', row.mileage)
  }
  return out
}

// ---------------------------------------------------------------------------
// Finance ledgers + tasks reconstruction
// ---------------------------------------------------------------------------
//
// These mirror the app's OWN read mappers (paymentFromRow / expenseFromRow / tripFromRow in
// crm-finance.mjs, taskFromRow in crm-data-core.mjs): the numeric-companion text column wins when
// present (a non-numeric value the app preserved), otherwise the numeric column; timestamps collapse
// to the JS "...Z" form via isoZ. The emitted key ORDER matches the app's writer, so the files stay
// byte-faithful mirrors of what the CRM would have written under the files backend.

function numOr(numCol, textCol) {
  if (textCol != null && String(textCol) !== '') return String(textCol)
  return typeof numCol === 'number' && Number.isFinite(numCol) ? numCol : 0
}

function paymentRecord(r) {
  return {
    id: r.id,
    projectId: r.project_id == null ? '' : String(r.project_id),
    amount: numOr(r.amount, r.amount_text),
    dateReceived: r.date_received == null ? '' : String(r.date_received),
    pending: !!r.pending,
    type: r.type == null ? 'deposit' : String(r.type),
    method: r.method == null ? '' : String(r.method),
    note: r.note == null ? '' : String(r.note),
    createdAt: isoZ(r.created_at),
  }
}
function expenseRecord(r) {
  return {
    id: r.id,
    name: r.name == null ? '' : String(r.name),
    amount: numOr(r.amount, r.amount_text),
    cadence: r.cadence == null ? 'monthly' : String(r.cadence),
    category: r.category == null ? '' : String(r.category),
    note: r.note == null ? '' : String(r.note),
    createdAt: isoZ(r.created_at),
  }
}
function tripRecord(r) {
  return {
    id: r.id,
    date: r.date == null ? '' : String(r.date),
    miles: numOr(r.miles, r.miles_text),
    purpose: r.purpose == null ? '' : String(r.purpose),
    projectId: r.project_id == null ? '' : String(r.project_id),
    createdAt: isoZ(r.created_at),
  }
}
function taskRecord(r) {
  return {
    id: r.id,
    projectId: r.project_id == null ? '' : String(r.project_id),
    title: r.title == null ? '' : String(r.title),
    dueDate: r.due_date == null ? '' : String(r.due_date),
    // dueTime is optional in the files; the app defaults absent/invalid to "" (normalizeTime).
    dueTime: r.due_time == null ? '' : String(r.due_time),
    done: !!r.done,
    createdAt: isoZ(r.created_at),
  }
}

// ---------------------------------------------------------------------------
// Phase-2 record mappers (mirror each module's own supabase read mapper, so the rebuilt files are
// byte-faithful mirrors of what the CRM would have written under the files backend).
// ---------------------------------------------------------------------------

// crm-emails.json events[]. Mirrors emailFromRow in crm-emails.mjs (timestamps -> "...Z").
function emailRecord(r) {
  return {
    id: r.id,
    projectId: r.project_id == null ? '' : String(r.project_id),
    kind: r.kind || 'thankyou',
    to: Array.isArray(r.to) ? r.to.filter(Boolean) : [],
    subject: String(r.subject || ''),
    body: String(r.body || ''),
    format: r.format === 'html' ? 'html' : 'text',
    attachments: Array.isArray(r.attachments) ? r.attachments : [],
    threadId: String(r.thread_id || ''),
    threadSubject: String(r.thread_subject || ''),
    status: r.status === 'sent' ? 'sent' : 'draft',
    createdAt: isoZ(r.created_at),
    updatedAt: isoZ(r.updated_at),
    sentAt: r.sent_at == null ? '' : String(r.sent_at),
  }
}
// crm-notifications.json events[]. Mirrors eventFromRow in crm-notifications.mjs.
function notificationRecord(r) {
  return {
    id: r.id,
    projectId: r.project_id == null ? '' : String(r.project_id),
    kind: r.kind == null ? '' : String(r.kind),
    sourceId: r.source_id == null ? '' : String(r.source_id),
    createdAt: isoZ(r.created_at),
    seen: !!r.seen,
  }
}
// crm-text-markers.json markers[]. Mirrors markerFromRow in crm-text-markers.mjs.
function textMarkerRecord(r) {
  return {
    projectId: String(r.project_id || ''),
    kind: String(r.kind || ''),
    sent: !!r.sent,
    date: typeof r.date === 'string' ? r.date : '',
    updatedAt: isoZ(r.updated_at),
  }
}
// Rebuild a { [key]: value } map from row-per-key jsonb rows.
function keyedMap(rows, keyCol, valCol) {
  const out = {}
  for (const r of rows || []) out[r[keyCol]] = r[valCol]
  return out
}

// ---------------------------------------------------------------------------
// _meta handling
// ---------------------------------------------------------------------------
//
// Each file is self-documenting via a _meta block. We READ the CURRENT file's _meta and carry it
// forward unchanged, EXCEPT we refresh any `count` (-> the real record/contact count) and
// `last_updated` (-> today) fields it already has. We never invent a _meta or drop one. If the
// current file is missing (e.g. a brand-new completed-<year> the data now requires), we synthesize
// a minimal _meta so the new file is still self-describing.

function today() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function readExistingMeta(srcDir, fileName) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(srcDir, fileName), 'utf8'))
    return parsed && typeof parsed._meta === 'object' && parsed._meta ? parsed._meta : null
  } catch {
    return null
  }
}

// Carry an existing _meta forward, refreshing count/last_updated if the block already has them.
function carryMeta(existing, { fileName, count, fallbackPurpose }) {
  if (existing) {
    const meta = { ...existing }
    if ('count' in meta) meta.count = count
    if ('last_updated' in meta) meta.last_updated = today()
    return meta
  }
  // No existing file to mirror: a minimal, honest _meta for a newly-required file.
  return {
    file: fileName,
    purpose: fallbackPurpose,
    count,
    last_updated: today(),
    _generated_by: 'supabase/backup-export.mjs (Supabase -> files mirror)',
  }
}

// ---------------------------------------------------------------------------
// Write helper: exact on-disk format (2-space indent + trailing newline).
// ---------------------------------------------------------------------------
function writeJson(dir, fileName, obj) {
  fs.writeFileSync(path.join(dir, fileName), JSON.stringify(obj, null, 2) + '\n')
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------
//
// srcMetaDir = where to read the CURRENT files' _meta from (always the real Project Records, so the
// self-documenting _meta is preserved even when writing to a temp dir). targetDir = where to WRITE.
export async function exportBackup({ targetDir, srcMetaDir = REAL_RECORDS_DIR } = {}) {
  if (!targetDir) throw new Error('exportBackup: targetDir is required')
  fs.mkdirSync(targetDir, { recursive: true })

  const [
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

  const written = []

  // ---- 1. Bucket files: active-projects.json, completed-<year>.json, archived-<year>.json ----
  // Group rows into their destination file. Active is one file; completed/archived split by year
  // via the app's recordYear(). Produce exactly the year files the data requires.
  const buckets = new Map() // fileName -> array of records
  for (const row of projects) {
    const bucket = String(row.bucket || 'active')
    let fileName
    if (bucket === 'active') fileName = 'active-projects.json'
    else if (bucket === 'completed') fileName = `completed-${recordYear(row)}.json`
    else if (bucket === 'archived') fileName = `archived-${recordYear(row)}.json`
    else fileName = 'active-projects.json' // unknown bucket -> treat as active (defensive)
    if (!buckets.has(fileName)) buckets.set(fileName, [])
    buckets.get(fileName).push(projectRecord(row))
  }

  for (const [fileName, records] of buckets) {
    const meta = carryMeta(readExistingMeta(srcMetaDir, fileName), {
      fileName,
      count: records.length,
      fallbackPurpose: `Canonical detail archive mirrored from Supabase (${fileName}).`,
    })
    // Bucket files put _meta FIRST, then projects (matching active-projects.json's on-disk order).
    writeJson(targetDir, fileName, { _meta: meta, projects: records })
    written.push(`${fileName} (${records.length})`)
  }

  // ---- 2. crm-contacts.json ----
  // { contacts: [...], _meta }. DB created_at/updated_at -> camelCase createdAt/updatedAt.
  const contactRecords = contacts
    .map((c) => ({
      id: c.id,
      name: c.name == null ? '' : String(c.name),
      emails: Array.isArray(c.emails) ? c.emails : [],
      phones: Array.isArray(c.phones) ? c.phones : [],
      type: c.type == null ? '' : String(c.type),
      relationship: c.relationship == null ? '' : String(c.relationship),
      engagement: c.engagement == null ? '' : String(c.engagement),
      tags: Array.isArray(c.tags) ? c.tags : [],
      notes: c.notes == null ? '' : String(c.notes),
      createdAt: isoZ(c.created_at),
      updatedAt: isoZ(c.updated_at),
    }))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
  {
    const meta = carryMeta(readExistingMeta(srcMetaDir, 'crm-contacts.json'), {
      fileName: 'crm-contacts.json',
      count: contactRecords.length,
      fallbackPurpose: 'First-class contacts, mirrored from Supabase.',
    })
    // crm-contacts.json puts contacts FIRST, then _meta (matching its on-disk order).
    writeJson(targetDir, 'crm-contacts.json', { contacts: contactRecords, _meta: meta })
    written.push(`crm-contacts.json (${contactRecords.length})`)
  }

  // ---- 3. crm-links.json ----
  // { links: { [projectId]: [contactId, ...] }, _meta }. Rebuild from the link rows, AND include an
  // empty [] for every project with links_seeded=true that has no link rows, so the seeded-but-empty
  // state (the "do not re-seed" signal) is preserved exactly.
  const links = {}
  for (const [projectId, ids] of Object.entries(linksMap)) links[projectId] = [...ids]
  for (const row of projects) {
    if (row.links_seeded && !(row.id in links)) links[row.id] = []
  }
  {
    const entryCount = Object.keys(links).length
    const meta = carryMeta(readExistingMeta(srcMetaDir, 'crm-links.json'), {
      fileName: 'crm-links.json',
      count: entryCount,
      fallbackPurpose: 'Explicit project->contact links, mirrored from Supabase.',
    })
    // crm-links.json puts links FIRST, then _meta.
    writeJson(targetDir, 'crm-links.json', { links, _meta: meta })
    written.push(`crm-links.json (${entryCount} entries)`)
  }

  // ---- 4. crm-pipeline.json ----
  // { stages: { [projectId]: stage_id } for projects with a non-null stage_id, _meta, flowLayout,
  // structure }. stages from projects.stage_id; structure + flowLayout from pipeline_meta.
  const stages = {}
  for (const row of projects) {
    if (row.stage_id != null && String(row.stage_id) !== '') stages[row.id] = String(row.stage_id)
  }
  {
    const meta = carryMeta(readExistingMeta(srcMetaDir, 'crm-pipeline.json'), {
      fileName: 'crm-pipeline.json',
      count: Object.keys(stages).length,
      fallbackPurpose: 'CRM pipeline stage overlay + structure + flow layout, mirrored from Supabase.',
    })
    // crm-pipeline.json on-disk key order is: stages, _meta, flowLayout, structure.
    const out = { stages, _meta: meta }
    out.flowLayout = pipelineMeta.flow_layout ?? null
    out.structure = pipelineMeta.structure ?? null
    writeJson(targetDir, 'crm-pipeline.json', out)
    written.push(`crm-pipeline.json (${Object.keys(stages).length} stages)`)
  }

  // ---- 5. crm-payments.json ----
  // { payments: [...], _meta }. Sorted by createdAt so the file order is stable across runs.
  {
    const records = payments
      .map(paymentRecord)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    const meta = carryMeta(readExistingMeta(srcMetaDir, 'crm-payments.json'), {
      fileName: 'crm-payments.json',
      count: records.length,
      fallbackPurpose: 'Cash received from projects, mirrored from Supabase.',
    })
    // On-disk key order: payments FIRST, then _meta.
    writeJson(targetDir, 'crm-payments.json', { payments: records, _meta: meta })
    written.push(`crm-payments.json (${records.length})`)
  }

  // ---- 6. crm-expenses.json ----
  // { expenses: [...], _meta }.
  {
    const records = expenses
      .map(expenseRecord)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    const meta = carryMeta(readExistingMeta(srcMetaDir, 'crm-expenses.json'), {
      fileName: 'crm-expenses.json',
      count: records.length,
      fallbackPurpose: 'Recurring business expenses, mirrored from Supabase.',
    })
    // On-disk key order: expenses FIRST, then _meta.
    writeJson(targetDir, 'crm-expenses.json', { expenses: records, _meta: meta })
    written.push(`crm-expenses.json (${records.length})`)
  }

  // ---- 7. crm-mileage.json ----
  // { trips: [...], ratePerMile, _meta }. ratePerMile lives in crm_settings.mileage_rate_per_mile.
  {
    const records = mileageTrips
      .map(tripRecord)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    const rate =
      typeof crmSettings?.mileage_rate_per_mile === 'number' ? crmSettings.mileage_rate_per_mile : 0.7
    const meta = carryMeta(readExistingMeta(srcMetaDir, 'crm-mileage.json'), {
      fileName: 'crm-mileage.json',
      count: records.length,
      fallbackPurpose: 'Business mileage log + per-mile rate, mirrored from Supabase.',
    })
    // On-disk key order: trips, ratePerMile, then _meta.
    writeJson(targetDir, 'crm-mileage.json', { trips: records, ratePerMile: rate, _meta: meta })
    written.push(`crm-mileage.json (${records.length} trips, rate ${rate})`)
  }

  // ---- 8. crm-tasks.json ----
  // { _meta, tasks: [...] }. NOTE the on-disk order here is _meta FIRST, then tasks (unlike the
  // ledger files). Sorted by createdAt for a stable file order.
  {
    const records = tasks
      .map(taskRecord)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    const meta = carryMeta(readExistingMeta(srcMetaDir, 'crm-tasks.json'), {
      fileName: 'crm-tasks.json',
      count: records.length,
      fallbackPurpose: 'CRM-owned task list, mirrored from Supabase.',
    })
    // On-disk key order: _meta FIRST, then tasks.
    writeJson(targetDir, 'crm-tasks.json', { _meta: meta, tasks: records })
    written.push(`crm-tasks.json (${records.length})`)
  }

  // ---- 9. crm-emails.json ----
  // { emails: [...], _meta }. Sorted by createdAt for a stable order.
  {
    const records = emails
      .map(emailRecord)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    const meta = carryMeta(readExistingMeta(srcMetaDir, 'crm-emails.json'), {
      fileName: 'crm-emails.json',
      count: records.length,
      fallbackPurpose: 'CRM-owned per-project composed emails, mirrored from Supabase.',
    })
    // On-disk key order: emails FIRST, then _meta.
    writeJson(targetDir, 'crm-emails.json', { emails: records, _meta: meta })
    written.push(`crm-emails.json (${records.length})`)
  }

  // (crm-templates.json is no longer written: the email-template library was removed 2026-07-31.)

  // ---- 11. crm-notifications.json ----
  // { events: [...], _meta }. Sorted by createdAt for a stable order.
  {
    const records = notifications
      .map(notificationRecord)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    const meta = carryMeta(readExistingMeta(srcMetaDir, 'crm-notifications.json'), {
      fileName: 'crm-notifications.json',
      count: records.length,
      fallbackPurpose: 'Status-change bell notifications, mirrored from Supabase.',
    })
    // On-disk key order: events FIRST, then _meta.
    writeJson(targetDir, 'crm-notifications.json', { events: records, _meta: meta })
    written.push(`crm-notifications.json (${records.length})`)
  }

  // ---- 12. crm-text-markers.json ----
  // { markers: [...], _meta }. Sorted by projectId+kind for a stable order.
  {
    const records = textMarkers
      .map(textMarkerRecord)
      .sort((a, b) => `${a.projectId}|${a.kind}`.localeCompare(`${b.projectId}|${b.kind}`))
    const meta = carryMeta(readExistingMeta(srcMetaDir, 'crm-text-markers.json'), {
      fileName: 'crm-text-markers.json',
      count: records.length,
      fallbackPurpose: 'Manual text/SMS sent markers, mirrored from Supabase.',
    })
    // On-disk key order: markers FIRST, then _meta.
    writeJson(targetDir, 'crm-text-markers.json', { markers: records, _meta: meta })
    written.push(`crm-text-markers.json (${records.length})`)
  }

  // ---- 13. crm-invoices.json ----
  // { invoices: { [projectId]: ref }, _meta } from the row-per-project jsonb rows.
  {
    const map = keyedMap(invoices, 'project_id', 'data')
    const meta = carryMeta(readExistingMeta(srcMetaDir, 'crm-invoices.json'), {
      fileName: 'crm-invoices.json',
      count: Object.keys(map).length,
      fallbackPurpose: 'Per-project QuickBooks invoice references, mirrored from Supabase.',
    })
    writeJson(targetDir, 'crm-invoices.json', { invoices: map, _meta: meta })
    written.push(`crm-invoices.json (${Object.keys(map).length})`)
  }

  // ---- 14. crm-contracts.json ----
  // { contracts: { [projectId]: [versions] }, _meta } from the row-per-project `versions` jsonb rows.
  {
    const map = keyedMap(contracts, 'project_id', 'versions')
    const meta = carryMeta(readExistingMeta(srcMetaDir, 'crm-contracts.json'), {
      fileName: 'crm-contracts.json',
      count: Object.keys(map).length,
      fallbackPurpose: 'Per-project contract versions, mirrored from Supabase.',
    })
    writeJson(targetDir, 'crm-contracts.json', { contracts: map, _meta: meta })
    written.push(`crm-contracts.json (${Object.keys(map).length})`)
  }

  // ---- 17. crm-recipients.json ----
  // { recipients: { [projectId]: {...} }, _meta } from the row-per-project jsonb rows.
  {
    const map = keyedMap(recipients, 'project_id', 'data')
    const meta = carryMeta(readExistingMeta(srcMetaDir, 'crm-recipients.json'), {
      fileName: 'crm-recipients.json',
      count: Object.keys(map).length,
      fallbackPurpose: 'Per-project document recipients (signer + bill-to), mirrored from Supabase.',
    })
    writeJson(targetDir, 'crm-recipients.json', { recipients: map, _meta: meta })
    written.push(`crm-recipients.json (${Object.keys(map).length})`)
  }

  // ---- 18. crm-inquiries.json ----
  // { inquiries: { [id]: {...} }, _meta } from the row-per-inquiry jsonb rows (includes dismissed).
  {
    const map = keyedMap(inquiries, 'id', 'data')
    const meta = carryMeta(readExistingMeta(srcMetaDir, 'crm-inquiries.json'), {
      fileName: 'crm-inquiries.json',
      count: Object.keys(map).length,
      fallbackPurpose: 'Website contact-form inquiries + dismissal state, mirrored from Supabase.',
    })
    writeJson(targetDir, 'crm-inquiries.json', { inquiries: map, _meta: meta })
    written.push(`crm-inquiries.json (${Object.keys(map).length})`)
  }

  // ---- 19. crm-config.json ----
  // The single crm_config row's { data } payload (the config minus _meta) plus a _meta block. The
  // DB stores only the config data; the _meta doc block is carried forward from the existing file (or
  // synthesized). Key order is not preserved by jsonb, but the verify compares CONTENT (order + _meta
  // insensitive), so this is a faithful mirror.
  {
    const meta = carryMeta(readExistingMeta(srcMetaDir, 'crm-config.json'), {
      fileName: 'crm-config.json',
      count: Object.keys(crmConfig || {}).length,
      fallbackPurpose: 'CRM editable settings (Settings page), mirrored from Supabase.',
    })
    writeJson(targetDir, 'crm-config.json', { ...(crmConfig || {}), _meta: meta })
    written.push(`crm-config.json (${Object.keys(crmConfig || {}).length} keys)`)
  }

  // ---- 20. crm-calendar-map.json ----
  // { calendars, projects, tasks, _meta } from the single calendar_map row (id=1).
  {
    const meta = carryMeta(readExistingMeta(srcMetaDir, 'crm-calendar-map.json'), {
      fileName: 'crm-calendar-map.json',
      count:
        Object.keys(calendarMap?.projects || {}).length + Object.keys(calendarMap?.tasks || {}).length,
      fallbackPurpose: 'Project/task -> Google Calendar event id map, mirrored from Supabase.',
    })
    // On-disk key order: calendars, projects, tasks, then _meta.
    writeJson(targetDir, 'crm-calendar-map.json', {
      calendars: calendarMap?.calendars || {},
      projects: calendarMap?.projects || {},
      tasks: calendarMap?.tasks || {},
      _meta: meta,
    })
    written.push(`crm-calendar-map.json (${Object.keys(calendarMap?.projects || {}).length} projects, ${Object.keys(calendarMap?.tasks || {}).length} tasks)`)
  }

  return { targetDir, written }
}

// ---- CLI ----
// argv[2] = target dir. Default: a temp dir (safe; never the real Project Records).
if (import.meta.url === `file://${process.argv[1]}`) {
  const targetArg = process.argv[2]
  const targetDir = targetArg
    ? path.resolve(targetArg)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'crm-backup-export-'))
  // Case-insensitive compare: macOS paths are case-insensitive, and the launchd arg / REAL_RECORDS_DIR
  // can differ only in the "Claude"/"claude" casing while pointing at the same real directory.
  const isReal = path.resolve(targetDir).toLowerCase() === path.resolve(REAL_RECORDS_DIR).toLowerCase()
  exportBackup({ targetDir })
    .then(({ written }) => {
      console.log(`Exported ${written.length} files to:`)
      console.log(`  ${targetDir}${isReal ? '  (THE REAL Project Records)' : '  (temp dir)'}`)
      for (const w of written) console.log(`    ${w}`)
      if (!isReal) console.log('\n(Default/temp target: the real Project Records was NOT touched.)')
    })
    .catch((err) => {
      console.error('backup-export failed:', err?.message || err)
      process.exit(1)
    })
}
