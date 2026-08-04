// Finance layer for the CRM. Computes an income / goals summary from the project
// records, and owns three small ledgers in Project Records: payments received
// (cash basis), recurring business expenses, and a mileage log. Read-only on the
// canonical project JSONs (income is derived from total_fee + event_date + stage).

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { RECORDS_DIR, loadAll } from './crm-data-core.mjs'
import {
  CRM_STORE,
  // cached sync getters
  getCachedPayments,
  getCachedExpenses,
  getCachedMileageTrips,
  getCachedCrmSettings,
  // async DB writers
  upsertPayment as sbUpsertPayment,
  deletePayment as sbDeletePayment,
  deletePaymentsForProject as sbDeletePaymentsForProject,
  upsertExpense as sbUpsertExpense,
  deleteExpense as sbDeleteExpense,
  upsertMileageTrip as sbUpsertMileageTrip,
  deleteMileageTrip as sbDeleteMileageTrip,
  deleteMileageTripsForProject as sbDeleteMileageTripsForProject,
  setCrmSettings as sbSetCrmSettings,
  getCachedCrmConfig,
  setCrmConfig as sbSetCrmConfig,
  cacheSetCrmConfig,
  // sync cache mutators
  cacheUpsertPayment,
  cacheRemovePayment,
  cacheRemovePaymentsForProject,
  cacheUpsertExpense,
  cacheRemoveExpense,
  cacheUpsertMileageTrip,
  cacheRemoveMileageTrip,
  cacheRemoveMileageTripsForProject,
  cacheSetCrmSettings,
} from './crm-store.mjs'

const PAYMENTS_FILE = path.join(RECORDS_DIR, 'crm-payments.json')
const EXPENSES_FILE = path.join(RECORDS_DIR, 'crm-expenses.json')
const MILEAGE_FILE = path.join(RECORDS_DIR, 'crm-mileage.json')
const CONFIG_FILE = path.join(RECORDS_DIR, 'crm-config.json')

// Defaults; the live values live in crm-config.json and are editable in the app.
const DEFAULT_GOALS = [80000, 100000, 150000]
const DEFAULT_MONTHLY_GOAL = 10000
const DEFAULT_REASONS = [
  'Booked elsewhere',
  'Went with someone else',
  'Decided against having a magician',
  'Outside budget',
  'No response / Ghosted',
  'Date no longer available',
  'Event cancelled',
  'Not the right fit',
  'Duplicate inquiry',
  'Other',
]

// Standard business mileage rate (IRS-style). Editable in the app.
const DEFAULT_MILEAGE_RATE = 0.7

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}
function writeJson(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n')
  } catch (e) {
    console.error('[crm-finance] could not write', file, e?.message || e)
  }
}
function num(v) {
  const n = Number(String(v ?? '').replace(/[^0-9.\-]/g, ''))
  return Number.isFinite(n) ? n : 0
}
function ymd(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

// Postgres returns timestamptz in offset form (e.g. "2026-06-18T03:38:04.514+00:00"); the files
// store the JS toISOString() "...Z" form. Re-serialize through Date so the supabase read yields the
// identical createdAt string the files path produces (mirrors isoZ in crm-contacts.mjs).
function isoZ(v) {
  const s = String(v ?? '').trim()
  if (!s) return ''
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? s : d.toISOString()
}

// ---- Supabase row <-> app record mappers (payments / expenses / mileage) ----
// The app record shapes use camelCase (projectId, dateReceived, createdAt); the DB columns are
// snake_case with a numeric-companion text column. amount_text preserves any non-numeric value.

// Raw DB payment row -> the app's payment record. Always emits the full canonical key set the app's
// own addPayment() writes (id, projectId, amount, dateReceived, pending, type, method, note,
// createdAt), so downstream (computeFinance, the payment gate) sees the identical shape.
function paymentFromRow(r) {
  return {
    id: r.id,
    projectId: r.project_id == null ? '' : String(r.project_id),
    amount: r.amount_text != null && r.amount_text !== '' ? String(r.amount_text) : num(r.amount),
    dateReceived: r.date_received == null ? '' : String(r.date_received),
    pending: !!r.pending,
    type: r.type == null ? 'deposit' : String(r.type),
    method: r.method == null ? '' : String(r.method),
    note: r.note == null ? '' : String(r.note),
    createdAt: isoZ(r.created_at),
  }
}
// App payment record -> raw DB row (numeric amount + companion amount_text guard).
function paymentToRow(p) {
  const amtNum = typeof p.amount === 'number' ? p.amount : Number(String(p.amount).replace(/[^0-9.\-]/g, ''))
  const numeric = Number.isFinite(amtNum) ? amtNum : null
  return {
    id: p.id,
    project_id: p.projectId || '',
    amount: numeric,
    amount_text: numeric === null ? String(p.amount) : null,
    date_received: p.dateReceived || '',
    pending: !!p.pending,
    type: p.type || 'deposit',
    method: p.method || '',
    note: p.note || '',
    created_at: p.createdAt || null,
  }
}

function expenseFromRow(r) {
  return {
    id: r.id,
    name: r.name == null ? '' : String(r.name),
    amount: r.amount_text != null && r.amount_text !== '' ? String(r.amount_text) : num(r.amount),
    cadence: r.cadence == null ? 'monthly' : String(r.cadence),
    category: r.category == null ? '' : String(r.category),
    note: r.note == null ? '' : String(r.note),
    createdAt: isoZ(r.created_at),
  }
}
function expenseToRow(e) {
  const amtNum = typeof e.amount === 'number' ? e.amount : Number(String(e.amount).replace(/[^0-9.\-]/g, ''))
  const numeric = Number.isFinite(amtNum) ? amtNum : null
  return {
    id: e.id,
    name: e.name || '',
    amount: numeric,
    amount_text: numeric === null ? String(e.amount) : null,
    cadence: e.cadence || 'monthly',
    category: e.category || '',
    note: e.note || '',
    created_at: e.createdAt || null,
  }
}

function tripFromRow(r) {
  return {
    id: r.id,
    date: r.date == null ? '' : String(r.date),
    miles: r.miles_text != null && r.miles_text !== '' ? String(r.miles_text) : num(r.miles),
    purpose: r.purpose == null ? '' : String(r.purpose),
    projectId: r.project_id == null ? '' : String(r.project_id),
    createdAt: isoZ(r.created_at),
  }
}
function tripToRow(t) {
  const mNum = typeof t.miles === 'number' ? t.miles : Number(String(t.miles).replace(/[^0-9.\-]/g, ''))
  const numeric = Number.isFinite(mNum) ? mNum : null
  return {
    id: t.id,
    date: t.date || '',
    miles: numeric,
    miles_text: numeric === null ? String(t.miles) : null,
    purpose: t.purpose || '',
    project_id: t.projectId || '',
    created_at: t.createdAt || null,
  }
}
function metaBlock(file, purpose, shape) {
  return {
    file,
    owner: 'Magic CRM app (~/Desktop/Claude/magic-crm)',
    purpose,
    cowork_guidance: 'Safe to read. The CRM manages this file. Do NOT delete or overwrite.',
    shape,
  }
}

// --- Editable settings (income goals, archive reasons) -----------------------

// De-dupe a list of strings case-insensitively, keeping first-seen casing.
function uniqStrings(arr) {
  const seen = new Set()
  const out = []
  for (const raw of arr || []) {
    const s = String(raw).trim()
    if (!s) continue
    const k = s.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(s)
  }
  return out
}

// The raw config object (minus the _meta doc block) for the current backend. Files: crm-config.json.
// Supabase: the single crm_config row's { data } payload, served synchronously from the cache.
function configData() {
  if (CRM_STORE === 'supabase') return getCachedCrmConfig() || {}
  return readJson(CONFIG_FILE, {})
}

export function loadConfig() {
  const d = configData()
  const goals = Array.isArray(d.incomeGoals) && d.incomeGoals.length ? d.incomeGoals.map(num).filter((n) => n > 0) : DEFAULT_GOALS
  const reasons =
    Array.isArray(d.archiveReasons) && d.archiveReasons.length
      ? d.archiveReasons.map((s) => String(s).trim()).filter(Boolean)
      : DEFAULT_REASONS
  const contactTags = Array.isArray(d.contactTags) ? uniqStrings(d.contactTags) : []
  const monthlyGoal = num(d.monthlyGoal) > 0 ? num(d.monthlyGoal) : DEFAULT_MONTHLY_GOAL
  const contractTemplate = typeof d.contractTemplate === 'string' ? d.contractTemplate : ''
  const eventFieldLabels = d.eventFieldLabels && typeof d.eventFieldLabels === 'object' ? d.eventFieldLabels : {}
  const eventFieldHidden = Array.isArray(d.eventFieldHidden) ? d.eventFieldHidden.map((s) => String(s)) : []
  // Built-in event fields the user "deleted" (only the display-only ones are deletable). They vanish
  // from Event details, the Settings list, and the portal options; the underlying record value is
  // untouched, so a delete is reversible (restore in Settings).
  const eventFieldDeleted = Array.isArray(d.eventFieldDeleted) ? d.eventFieldDeleted.map((s) => String(s)) : []
  // User-defined custom event fields (definitions only; values live in crm-custom-fields.json).
  const customFields = Array.isArray(d.customFields)
    ? d.customFields.filter((f) => f && f.id).map((f) => ({ id: String(f.id), label: String(f.label || '') }))
    : []
  // Which project-page section to highlight for each pipeline umbrella (umbrellaId -> sectionId).
  // Empty = use the built-in default per umbrella (computed on the front end).
  const sectionHighlights = d.sectionHighlights && typeof d.sectionHighlights === 'object' ? d.sectionHighlights : {}
  // Email signature: rich HTML appended below the body on send (can embed a logo via a data: <img>,
  // which the send layer converts to an inline cid: image). Off by default until set up.
  const signatureEnabled = !!d.signatureEnabled
  const signatureHtml = typeof d.signatureHtml === 'string' ? d.signatureHtml : ''
  return {
    incomeGoals: [...goals].sort((a, b) => a - b),
    monthlyGoal,
    archiveReasons: reasons,
    contactTags,
    contractTemplate,
    eventFieldLabels,
    eventFieldHidden,
    eventFieldDeleted,
    customFields,
    sectionHighlights,
    signatureEnabled,
    signatureHtml,
  }
}
export async function saveConfig(patch) {
  const supa = CRM_STORE === 'supabase'
  // Supabase stores the config data payload (no _meta); files store the same fields plus a _meta doc
  // block. Start from the current data (a copy of the cached payload under supabase) and merge.
  const cur = supa ? { ...(getCachedCrmConfig() || {}) } : readJson(CONFIG_FILE, {})
  if (patch.incomeGoals != null) {
    cur.incomeGoals = (patch.incomeGoals || []).map(num).filter((n) => n > 0)
  }
  if (patch.archiveReasons != null) {
    cur.archiveReasons = (patch.archiveReasons || []).map((s) => String(s).trim()).filter(Boolean)
  }
  if (patch.contactTags != null) {
    cur.contactTags = uniqStrings(patch.contactTags)
  }
  if (patch.monthlyGoal != null) {
    const g = num(patch.monthlyGoal)
    cur.monthlyGoal = g > 0 ? g : DEFAULT_MONTHLY_GOAL
  }
  if (patch.contractTemplate != null) {
    // Empty string clears it (falls back to the built-in default contract).
    cur.contractTemplate = String(patch.contractTemplate)
  }
  if (patch.eventFieldLabels != null && typeof patch.eventFieldLabels === 'object') {
    cur.eventFieldLabels = patch.eventFieldLabels
  }
  if (patch.eventFieldHidden != null) {
    cur.eventFieldHidden = (patch.eventFieldHidden || []).map((s) => String(s))
  }
  if (patch.eventFieldDeleted != null) {
    cur.eventFieldDeleted = (patch.eventFieldDeleted || []).map((s) => String(s))
  }
  if (patch.customFields != null) {
    cur.customFields = (patch.customFields || [])
      .filter((f) => f && f.id && String(f.label || '').trim())
      .map((f) => ({ id: String(f.id), label: String(f.label).trim() }))
  }
  if (patch.sectionHighlights != null && typeof patch.sectionHighlights === 'object') {
    cur.sectionHighlights = patch.sectionHighlights
  }
  if (patch.signatureEnabled != null) {
    cur.signatureEnabled = !!patch.signatureEnabled
  }
  if (patch.signatureHtml != null) {
    cur.signatureHtml = String(patch.signatureHtml)
  }
  if (supa) {
    // The DB row holds the config data payload only (never the _meta doc block).
    cacheSetCrmConfig(cur)
    await sbSetCrmConfig(cur)
    return loadConfig()
  }
  cur._meta = metaBlock(
    'crm-config.json',
    'CRM editable settings: income goal tiers, a monthly income goal (drives the Finance month-block fill), the archive-reason list, the reusable contact-tag library, the editable default contract template HTML, event-field label overrides + hidden + deleted event fields, user-defined custom event fields, and the email signature (Settings page).',
    'incomeGoals[] (numbers), monthlyGoal (number), archiveReasons[] (strings), contactTags[] (strings), contractTemplate (HTML string), eventFieldLabels {fieldId:label}, eventFieldHidden[] (field ids hidden from Event details), eventFieldDeleted[] (deleted display-only built-in field ids), customFields[] ({id,label} user-defined fields; values in crm-custom-fields.json), signatureEnabled (bool), signatureHtml (HTML string, may embed a data: logo)',
  )
  writeJson(CONFIG_FILE, cur)
  return loadConfig()
}

// --- Payments ledger (cash received) ----------------------------------------

export function loadPayments() {
  if (CRM_STORE === 'supabase') return getCachedPayments().map(paymentFromRow)
  const d = readJson(PAYMENTS_FILE, { payments: [] })
  if (!Array.isArray(d.payments)) d.payments = []
  return d.payments
}
function paymentsMeta() {
  return metaBlock(
    'crm-payments.json',
    'Cash received from projects. Each payment: projectId (client_name slug), amount, dateReceived (YYYY-MM-DD, empty if pending), pending (bool: amount known but date not yet received), type (deposit/balance/full/other), method (how it was paid: "QuickBooks invoice" / HoneyBook / Cash / Check / PayPal / Venmo / CashApp / Zelle, or empty; "HoneyBook" was labelled "Online (HB)" before 2026-08-04). Pending payments do NOT count toward cash-received figures until a date is set. Powers the CRM Finance page cash-basis figures.',
    'id, projectId, amount, dateReceived, pending, type, method, note, createdAt',
  )
}
export async function addPayment({ projectId, amount, dateReceived, pending, type, method, note }) {
  const isPending = !!pending
  const p = {
    id: crypto.randomUUID(),
    projectId: String(projectId || ''),
    amount: num(amount),
    dateReceived: isPending ? '' : String(dateReceived || ''),
    pending: isPending,
    type: ['deposit', 'balance', 'full', 'other'].includes(type) ? type : 'deposit',
    method: String(method || ''),
    note: String(note || ''),
    createdAt: new Date().toISOString(),
  }
  if (CRM_STORE === 'supabase') {
    const row = paymentToRow(p)
    cacheUpsertPayment(row)
    await sbUpsertPayment(row)
    return p
  }
  const d = readJson(PAYMENTS_FILE, { payments: [] })
  if (!Array.isArray(d.payments)) d.payments = []
  d.payments.push(p)
  d._meta = paymentsMeta()
  writeJson(PAYMENTS_FILE, d)
  return p
}
// Edit an existing payment (e.g. finalize a pending one by giving it a date).
export async function updatePayment({ id, amount, dateReceived, pending, type, method, note }) {
  if (CRM_STORE === 'supabase') {
    const existing = getCachedPayments().find((x) => x.id === id)
    if (!existing) throw new Error('payment not found')
    const p = paymentFromRow(existing)
    if (amount != null && amount !== '') p.amount = num(amount)
    if (pending != null) p.pending = !!pending
    if (dateReceived != null) p.dateReceived = String(dateReceived)
    // Setting a date finalizes a pending payment; clearing it makes it pending.
    if (dateReceived != null) p.pending = String(dateReceived) ? false : p.pending
    if (type != null && ['deposit', 'balance', 'full', 'other'].includes(type)) p.type = type
    if (method != null) p.method = String(method)
    if (note != null) p.note = String(note)
    const row = paymentToRow(p)
    cacheUpsertPayment(row)
    await sbUpsertPayment(row)
    return p
  }
  const d = readJson(PAYMENTS_FILE, { payments: [] })
  const p = (d.payments || []).find((x) => x.id === id)
  if (!p) throw new Error('payment not found')
  if (amount != null && amount !== '') p.amount = num(amount)
  if (pending != null) p.pending = !!pending
  if (dateReceived != null) p.dateReceived = String(dateReceived)
  // Setting a date finalizes a pending payment; clearing it makes it pending.
  if (dateReceived != null) p.pending = String(dateReceived) ? false : p.pending
  if (type != null && ['deposit', 'balance', 'full', 'other'].includes(type)) p.type = type
  if (method != null) p.method = String(method)
  if (note != null) p.note = String(note)
  d._meta = paymentsMeta()
  writeJson(PAYMENTS_FILE, d)
  return p
}
export async function deletePayment(id) {
  if (CRM_STORE === 'supabase') {
    cacheRemovePayment(id)
    await sbDeletePayment(id)
    return { ok: true }
  }
  const d = readJson(PAYMENTS_FILE, { payments: [] })
  d.payments = (d.payments || []).filter((x) => x.id !== id)
  writeJson(PAYMENTS_FILE, d)
  return { ok: true }
}
// Drop every payment tied to a project (called when a project is deleted).
export async function deletePaymentsForProject(projectId) {
  if (CRM_STORE === 'supabase') {
    const before = getCachedPayments().filter((x) => x.project_id === projectId).length
    cacheRemovePaymentsForProject(projectId)
    await sbDeletePaymentsForProject(projectId)
    return { ok: true, removed: before }
  }
  const d = readJson(PAYMENTS_FILE, { payments: [] })
  if (!Array.isArray(d.payments)) return { ok: true, removed: 0 }
  const before = d.payments.length
  d.payments = d.payments.filter((x) => x.projectId !== projectId)
  const removed = before - d.payments.length
  if (removed) writeJson(PAYMENTS_FILE, d)
  return { ok: true, removed }
}

// --- Recurring expenses ------------------------------------------------------

const CADENCES = ['monthly', 'quarterly', 'yearly', 'weekly', 'one-time']

export function loadExpenses() {
  if (CRM_STORE === 'supabase') return getCachedExpenses().map(expenseFromRow)
  const d = readJson(EXPENSES_FILE, { expenses: [] })
  if (!Array.isArray(d.expenses)) d.expenses = []
  return d.expenses
}
function expensesMeta() {
  return metaBlock(
    'crm-expenses.json',
    'Recurring / known business expenses. amount + cadence (monthly/quarterly/yearly/weekly/one-time). The Finance page rolls these into a monthly + annual overhead figure. This is NOT a full transaction ledger (Michael uses a dedicated budgeting app for that).',
    'id, name, amount, cadence, category, note, createdAt',
  )
}
export async function addExpense({ name, amount, cadence, category, note }) {
  const e = {
    id: crypto.randomUUID(),
    name: String(name || 'Expense'),
    amount: num(amount),
    cadence: CADENCES.includes(cadence) ? cadence : 'monthly',
    category: String(category || ''),
    note: String(note || ''),
    createdAt: new Date().toISOString(),
  }
  if (CRM_STORE === 'supabase') {
    const row = expenseToRow(e)
    cacheUpsertExpense(row)
    await sbUpsertExpense(row)
    return e
  }
  const d = readJson(EXPENSES_FILE, { expenses: [] })
  if (!Array.isArray(d.expenses)) d.expenses = []
  d.expenses.push(e)
  d._meta = expensesMeta()
  writeJson(EXPENSES_FILE, d)
  return e
}
export async function updateExpense({ id, name, amount, cadence, category, note }) {
  if (CRM_STORE === 'supabase') {
    const existing = getCachedExpenses().find((x) => x.id === id)
    if (!existing) throw new Error('expense not found')
    const e = expenseFromRow(existing)
    if (name != null) e.name = String(name)
    if (amount != null) e.amount = num(amount)
    if (cadence != null && CADENCES.includes(cadence)) e.cadence = cadence
    if (category != null) e.category = String(category)
    if (note != null) e.note = String(note)
    const row = expenseToRow(e)
    cacheUpsertExpense(row)
    await sbUpsertExpense(row)
    return e
  }
  const d = readJson(EXPENSES_FILE, { expenses: [] })
  const e = (d.expenses || []).find((x) => x.id === id)
  if (!e) throw new Error('expense not found')
  if (name != null) e.name = String(name)
  if (amount != null) e.amount = num(amount)
  if (cadence != null && CADENCES.includes(cadence)) e.cadence = cadence
  if (category != null) e.category = String(category)
  if (note != null) e.note = String(note)
  writeJson(EXPENSES_FILE, d)
  return e
}
export async function deleteExpense(id) {
  if (CRM_STORE === 'supabase') {
    cacheRemoveExpense(id)
    await sbDeleteExpense(id)
    return { ok: true }
  }
  const d = readJson(EXPENSES_FILE, { expenses: [] })
  d.expenses = (d.expenses || []).filter((x) => x.id !== id)
  writeJson(EXPENSES_FILE, d)
  return { ok: true }
}

// --- Mileage log -------------------------------------------------------------

// The per-mile rate. Files: crm-mileage.json ratePerMile. Supabase: crm_settings.mileage_rate_per_mile.
function ratePerMile() {
  if (CRM_STORE === 'supabase') {
    const r = getCachedCrmSettings()?.mileage_rate_per_mile
    return typeof r === 'number' ? r : DEFAULT_MILEAGE_RATE
  }
  const d = readJson(MILEAGE_FILE, { ratePerMile: DEFAULT_MILEAGE_RATE })
  return typeof d.ratePerMile === 'number' ? d.ratePerMile : DEFAULT_MILEAGE_RATE
}

export function loadMileage() {
  if (CRM_STORE === 'supabase') {
    return { trips: getCachedMileageTrips().map(tripFromRow), ratePerMile: ratePerMile() }
  }
  const d = readJson(MILEAGE_FILE, { trips: [], ratePerMile: DEFAULT_MILEAGE_RATE })
  if (!Array.isArray(d.trips)) d.trips = []
  if (typeof d.ratePerMile !== 'number') d.ratePerMile = DEFAULT_MILEAGE_RATE
  return { trips: d.trips, ratePerMile: d.ratePerMile }
}
function writeMileage(data) {
  data._meta = metaBlock(
    'crm-mileage.json',
    'Business mileage log + the per-mile rate. The Finance page totals miles and estimates the mileage deduction (miles * ratePerMile).',
    'trips[]: id, date, miles, purpose, projectId, createdAt; ratePerMile',
  )
  writeJson(MILEAGE_FILE, data)
}
export async function addTrip({ date, miles, purpose, projectId }) {
  const t = {
    id: crypto.randomUUID(),
    date: String(date || ''),
    miles: num(miles),
    purpose: String(purpose || ''),
    projectId: String(projectId || ''),
    createdAt: new Date().toISOString(),
  }
  if (CRM_STORE === 'supabase') {
    const row = tripToRow(t)
    cacheUpsertMileageTrip(row)
    await sbUpsertMileageTrip(row)
    return t
  }
  const d = loadMileage()
  d.trips.push(t)
  writeMileage(d)
  return t
}
export async function deleteTrip(id) {
  if (CRM_STORE === 'supabase') {
    cacheRemoveMileageTrip(id)
    await sbDeleteMileageTrip(id)
    return { ok: true }
  }
  const d = loadMileage()
  d.trips = d.trips.filter((x) => x.id !== id)
  writeMileage(d)
  return { ok: true }
}
// Drop every mileage trip tied to a project (called when a project is deleted).
export async function deleteTripsForProject(projectId) {
  if (CRM_STORE === 'supabase') {
    const before = getCachedMileageTrips().filter((x) => x.project_id === projectId).length
    cacheRemoveMileageTripsForProject(projectId)
    await sbDeleteMileageTripsForProject(projectId)
    return { ok: true, removed: before }
  }
  const d = loadMileage()
  const before = d.trips.length
  d.trips = d.trips.filter((x) => x.projectId !== projectId)
  const removed = before - d.trips.length
  if (removed) writeMileage(d)
  return { ok: true, removed }
}
export async function setMileageRate(rate) {
  const r = num(rate) || DEFAULT_MILEAGE_RATE
  if (CRM_STORE === 'supabase') {
    cacheSetCrmSettings({ mileage_rate_per_mile: r })
    await sbSetCrmSettings({ mileage_rate_per_mile: r })
    return { ok: true, ratePerMile: r }
  }
  const d = loadMileage()
  d.ratePerMile = r
  writeMileage(d)
  return { ok: true, ratePerMile: d.ratePerMile }
}

// --- Income summary ----------------------------------------------------------
// All money figures come from the PAYMENTS field (the actual money received), not
// the quote (total_fee) or tips. The only difference between the two bases is
// which month a payment lands in:
//   - "Received"  -> bucket each payment by the date the money arrived (dateReceived).
//   - "Earned"    -> bucket each payment by its project's EVENT month.
// (Same dollars, re-bucketed. A $1000 payment taken in April for a May gig shows
//  in April on the Received basis and in May on the Earned basis.)
// Tips are reported separately (by event month) and are NOT in the figures unless
// the app's "include tips" toggle is on. The quote is used only for the forward-
// looking "still expected to come in" figure.

export function computeFinance() {
  const now = new Date()
  const year = now.getFullYear()
  const today = ymd(now)
  const projects = loadAll().projects
  const payments = loadPayments()

  const quote = (p) => (typeof p.totalFee === 'number' ? p.totalFee : 0)
  const tipOf = (p) => (typeof p.tips === 'number' ? p.tips : 0)
  const mKey = (iso) => (iso && /^\d{4}-\d{2}/.test(iso) ? iso.slice(0, 7) : '')

  // Project lookups by id (slug).
  const byId = new Map(projects.map((p) => [p.id, p]))
  const projName = (id) => byId.get(id)?.client || '(unassigned)'
  const eventMonthOf = (pm) => mKey(byId.get(pm.projectId)?.eventDate || '')
  // Soft-deleted projects (in the 30-day trash) are excluded from all finance figures:
  // their money records still exist for a possible restore, but a deleted gig shouldn't
  // count as income.
  const deletedIds = new Set(projects.filter((p) => p.bucket === 'deleted').map((p) => p.id))

  // Real money received: a logged payment that isn't date-pending. (A pending
  // payment is an expected amount with no date yet, so it isn't money in.)
  const realPayments = payments.filter((pm) => !pm.pending && num(pm.amount) > 0 && !deletedIds.has(pm.projectId))

  // Sum a list of {id, amount} per project into [{ id, name, amount }], largest first.
  const groupByProject = (items) => {
    const by = new Map()
    for (const it of items) by.set(it.id, (by.get(it.id) || 0) + it.amount)
    return [...by.entries()]
      .map(([id, amount]) => ({ id, name: projName(id), amount }))
      .sort((a, b) => b.amount - a.amount)
  }
  const paysToItems = (pmts) => groupByProject(pmts.map((pm) => ({ id: pm.projectId || '', amount: num(pm.amount) })))
  // Tips contributing to an event month: one entry per project that has a tip.
  const tipItemsForMonth = (key) =>
    projects
      .filter((p) => p.bucket !== 'deleted' && tipOf(p) > 0 && mKey(p.eventDate) === key)
      .map((p) => ({ id: p.id, name: p.client, amount: tipOf(p) }))
      .sort((a, b) => b.amount - a.amount)

  // Trailing 12 months (oldest first). Both bases + tips, with per-project items.
  const months = []
  for (let i = 11; i >= 0; i--) {
    const d = new Date(year, now.getMonth() - i, 1)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    const receivedItems = paysToItems(realPayments.filter((pm) => mKey(pm.dateReceived) === key))
    const earnedItems = paysToItems(realPayments.filter((pm) => eventMonthOf(pm) === key))
    const tipItems = tipItemsForMonth(key)
    months.push({
      key,
      label: d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }),
      received: receivedItems.reduce((s, it) => s + it.amount, 0),
      earned: earnedItems.reduce((s, it) => s + it.amount, 0),
      tips: tipItems.reduce((s, it) => s + it.amount, 0),
      receivedItems,
      earnedItems,
      tipItems,
    })
  }

  const curKey = `${year}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const tmReceivedItems = paysToItems(realPayments.filter((pm) => mKey(pm.dateReceived) === curKey))
  const tmEarnedItems = paysToItems(realPayments.filter((pm) => eventMonthOf(pm) === curKey))
  const tmTipItems = tipItemsForMonth(curKey)
  const thisMonth = {
    received: tmReceivedItems.reduce((s, it) => s + it.amount, 0),
    earned: tmEarnedItems.reduce((s, it) => s + it.amount, 0),
    tips: tmTipItems.reduce((s, it) => s + it.amount, 0),
    receivedItems: tmReceivedItems,
    earnedItems: tmEarnedItems,
    tipItems: tmTipItems,
  }

  // Trailing-12-month totals (rolling window = the sum of the monthly blocks, so
  // the cards and the chart always agree). Items merge across months by project.
  const mergeItems = (lists) => {
    const by = new Map()
    for (const list of lists) for (const it of list) by.set(it.id, (by.get(it.id) || 0) + it.amount)
    return [...by.entries()]
      .map(([id, amount]) => ({ id, name: projName(id), amount }))
      .sort((a, b) => b.amount - a.amount)
  }
  const last12 = {
    received: months.reduce((s, m) => s + m.received, 0),
    earned: months.reduce((s, m) => s + m.earned, 0),
    tips: months.reduce((s, m) => s + m.tips, 0),
    receivedItems: mergeItems(months.map((m) => m.receivedItems)),
    earnedItems: mergeItems(months.map((m) => m.earnedItems)),
    tipItems: months.flatMap((m) => m.tipItems).sort((a, b) => b.amount - a.amount),
  }

  // "Still expected to come in" = money not yet in the door if every active gig
  // closes and nobody cancels: each active project's QUOTE minus what it has
  // already paid. This is the one figure that uses the quote (it is forward-
  // looking, so it can't come from the payments alone).
  const receivedByProject = {}
  for (const pm of realPayments) {
    if (!pm.dateReceived) continue
    receivedByProject[pm.projectId] = (receivedByProject[pm.projectId] || 0) + num(pm.amount)
  }
  const expectedItems = projects
    .filter((p) => p.bucket === 'active')
    .map((p) => ({ id: p.id, name: p.client, amount: Math.max(0, quote(p) - (receivedByProject[p.id] || 0)) }))
    .filter((it) => it.amount > 0)
    .sort((a, b) => b.amount - a.amount)
  const expectedRemaining = expectedItems.reduce((s, it) => s + it.amount, 0)

  const cfg = loadConfig()
  const goals = cfg.incomeGoals.map((goal) => ({ goal }))

  return {
    year,
    today,
    months,
    thisMonth,
    last12,
    expectedRemaining,
    expectedItems,
    goals,
    monthlyGoal: cfg.monthlyGoal,
    hasPayments: payments.length > 0,
  }
}
