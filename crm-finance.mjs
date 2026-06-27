// Finance layer for the CRM. Computes an income / goals summary from the project
// records, and owns three small ledgers in Project Records: payments received
// (cash basis), recurring business expenses, and a mileage log. Read-only on the
// canonical project JSONs (income is derived from total_fee + event_date + stage).

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { RECORDS_DIR, loadAll } from './crm-data-core.mjs'

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

export function loadConfig() {
  const d = readJson(CONFIG_FILE, {})
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
    signatureEnabled,
    signatureHtml,
  }
}
export function saveConfig(patch) {
  const cur = readJson(CONFIG_FILE, {})
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
  if (patch.signatureEnabled != null) {
    cur.signatureEnabled = !!patch.signatureEnabled
  }
  if (patch.signatureHtml != null) {
    cur.signatureHtml = String(patch.signatureHtml)
  }
  cur._meta = metaBlock(
    'crm-config.json',
    'CRM editable settings: income goal tiers, a monthly income goal (drives the Finance month-block fill), the archive-reason list, the reusable contact-tag library, the editable default contract template HTML, event-field label overrides + hidden event fields, and the email signature (Settings page).',
    'incomeGoals[] (numbers), monthlyGoal (number), archiveReasons[] (strings), contactTags[] (strings), contractTemplate (HTML string), eventFieldLabels {fieldId:label}, eventFieldHidden[] (field ids hidden from Event details), signatureEnabled (bool), signatureHtml (HTML string, may embed a data: logo)',
  )
  writeJson(CONFIG_FILE, cur)
  return loadConfig()
}

// --- Payments ledger (cash received) ----------------------------------------

export function loadPayments() {
  const d = readJson(PAYMENTS_FILE, { payments: [] })
  if (!Array.isArray(d.payments)) d.payments = []
  return d.payments
}
function paymentsMeta() {
  return metaBlock(
    'crm-payments.json',
    'Cash received from projects. Each payment: projectId (client_name slug), amount, dateReceived (YYYY-MM-DD, empty if pending), pending (bool: amount known but date not yet received), type (deposit/balance/full/other), method (how it was paid: "Online (HB)" / Cash / Check / PayPal / Venmo / CashApp / Zelle, or empty). Pending payments do NOT count toward cash-received figures until a date is set. Powers the CRM Finance page cash-basis figures.',
    'id, projectId, amount, dateReceived, pending, type, method, note, createdAt',
  )
}
export function addPayment({ projectId, amount, dateReceived, pending, type, method, note }) {
  const d = readJson(PAYMENTS_FILE, { payments: [] })
  if (!Array.isArray(d.payments)) d.payments = []
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
  d.payments.push(p)
  d._meta = paymentsMeta()
  writeJson(PAYMENTS_FILE, d)
  return p
}
// Edit an existing payment (e.g. finalize a pending one by giving it a date).
export function updatePayment({ id, amount, dateReceived, pending, type, method, note }) {
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
export function deletePayment(id) {
  const d = readJson(PAYMENTS_FILE, { payments: [] })
  d.payments = (d.payments || []).filter((x) => x.id !== id)
  writeJson(PAYMENTS_FILE, d)
  return { ok: true }
}
// Drop every payment tied to a project (called when a project is deleted).
export function deletePaymentsForProject(projectId) {
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
  const d = readJson(EXPENSES_FILE, { expenses: [] })
  if (!Array.isArray(d.expenses)) d.expenses = []
  return d.expenses
}
export function addExpense({ name, amount, cadence, category, note }) {
  const d = readJson(EXPENSES_FILE, { expenses: [] })
  if (!Array.isArray(d.expenses)) d.expenses = []
  const e = {
    id: crypto.randomUUID(),
    name: String(name || 'Expense'),
    amount: num(amount),
    cadence: CADENCES.includes(cadence) ? cadence : 'monthly',
    category: String(category || ''),
    note: String(note || ''),
    createdAt: new Date().toISOString(),
  }
  d.expenses.push(e)
  d._meta = metaBlock(
    'crm-expenses.json',
    'Recurring / known business expenses. amount + cadence (monthly/quarterly/yearly/weekly/one-time). The Finance page rolls these into a monthly + annual overhead figure. This is NOT a full transaction ledger (Michael uses a dedicated budgeting app for that).',
    'id, name, amount, cadence, category, note, createdAt',
  )
  writeJson(EXPENSES_FILE, d)
  return e
}
export function updateExpense({ id, name, amount, cadence, category, note }) {
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
export function deleteExpense(id) {
  const d = readJson(EXPENSES_FILE, { expenses: [] })
  d.expenses = (d.expenses || []).filter((x) => x.id !== id)
  writeJson(EXPENSES_FILE, d)
  return { ok: true }
}

// --- Mileage log -------------------------------------------------------------

export function loadMileage() {
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
export function addTrip({ date, miles, purpose, projectId }) {
  const d = loadMileage()
  const t = {
    id: crypto.randomUUID(),
    date: String(date || ''),
    miles: num(miles),
    purpose: String(purpose || ''),
    projectId: String(projectId || ''),
    createdAt: new Date().toISOString(),
  }
  d.trips.push(t)
  writeMileage(d)
  return t
}
export function deleteTrip(id) {
  const d = loadMileage()
  d.trips = d.trips.filter((x) => x.id !== id)
  writeMileage(d)
  return { ok: true }
}
// Drop every mileage trip tied to a project (called when a project is deleted).
export function deleteTripsForProject(projectId) {
  const d = loadMileage()
  const before = d.trips.length
  d.trips = d.trips.filter((x) => x.projectId !== projectId)
  const removed = before - d.trips.length
  if (removed) writeMileage(d)
  return { ok: true, removed }
}
export function setMileageRate(rate) {
  const d = loadMileage()
  d.ratePerMile = num(rate) || DEFAULT_MILEAGE_RATE
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

  // Real money received: a logged payment that isn't date-pending. (A pending
  // payment is an expected amount with no date yet, so it isn't money in.)
  const realPayments = payments.filter((pm) => !pm.pending && num(pm.amount) > 0)

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
      .filter((p) => tipOf(p) > 0 && mKey(p.eventDate) === key)
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
