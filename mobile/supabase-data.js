// Data + auth layer for the Magic CRM phone app.
//
// This is the ONLY place that talks to Supabase. It owns the supabase-js client (loaded from a CDN as
// an ES module), the login/logout/session helpers, and one loader per tab. Each loader reads live
// rows with the logged-in session (RLS lets the authenticated user read everything) and maps the
// snake_case DB columns into the exact camelCase shapes the UI (app.js) already expects, so the view
// code did not have to change when the data source moved from the snapshot blob to Supabase.
//
// WRITES (Stage C) slot in here: add e.g. updateProject()/toggleTask() next to the matching load*()
// and call them from the view. supabase-js is already configured with the session, so a write is just
// `sb.from('tasks').update({done}).eq('id', id)`. No UI wiring is built yet.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js'

// supabase-js persists the session in localStorage (persistSession + autoRefreshToken default on), so
// login is once-per-device and the token silently refreshes. That gives us the "log in, then it just
// works" behavior the passcode used to have, but backed by real auth + RLS.
export const sb = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
})

// ---------- auth ----------
export async function getSession() {
  const { data } = await sb.auth.getSession()
  return data.session || null
}
export async function signIn(email, password) {
  const { data, error } = await sb.auth.signInWithPassword({ email: String(email || '').trim(), password: String(password || '') })
  if (error) throw error
  return data.session
}
export async function signOut() {
  try { await sb.auth.signOut() } catch (_) { /* ignore */ }
}
export async function currentUserEmail() {
  const s = await getSession()
  return (s && s.user && s.user.email) || ''
}

// ---------- small mappers (mirror the desktop's crm-data-core.mjs / crm-finance.mjs) ----------
function str(v) { return v == null ? '' : String(v) }
// total_fee / tips / mileage: numeric column, but keep a text companion for non-numeric legacy values.
function numOrNull(v, text) {
  if (text != null && text !== '') return text // preserve a non-numeric legacy value verbatim
  if (typeof v === 'number') return v
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
// Payments store amount in a numeric column with an amount_text companion (see crm-finance.mjs).
function amountOf(r) {
  if (r.amount_text != null && r.amount_text !== '') return r.amount_text
  const n = Number(r.amount)
  return Number.isFinite(n) ? n : 0
}
function num(v) {
  const n = Number(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''))
  return Number.isFinite(n) ? n : 0
}
// timestamptz -> the "...Z" ISO string the UI's timeAgo() expects.
function isoZ(v) {
  const s = str(v).trim()
  if (!s) return ''
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? s : d.toISOString()
}

// Raw projects row (snake_case) -> the app's project record (camelCase). Mirrors normalize() in
// crm-data-core.mjs and trimProject() in crm-snapshot.mjs (only the fields the phone UI reads).
// id: the app keys projects by the slug of client_name, but the DB row already stores that slug in
// projects.id, so we read it straight off the row (no re-slugging needed).
function projectFromRow(p) {
  return {
    id: str(p.id),
    client: str(p.project_name) || str(p.client_name),
    bucket: str(p.bucket),
    stageId: str(p.stage_id),
    status: str(p.status),
    eventType: str(p.event_type),
    eventDate: str(p.event_date),
    eventStartTime: str(p.event_start_time),
    showStartTime: str(p.show_start_time),
    eventLocation: str(p.event_location),
    venueType: str(p.venue_type),
    indoorsOrOutdoors: str(p.indoors_or_outdoors),
    numberOfGuests: str(p.number_of_guests),
    ageOfGuests: str(p.age_of_guests),
    performanceStyle: str(p.performance_style),
    totalFee: numOrNull(p.total_fee, p.total_fee_text),
    tips: numOrNull(p.tips, null),
    mileage: numOrNull(p.mileage, null),
    vips: str(p.vips),
    av: str(p.av),
    bookingSource: str(p.booking_source),
    eventSummary: str(p.event_summary),
    eventDescription: str(p.event_description),
    projectNotes: str(p.project_notes),
    contactNames: str(p.contact_names),
    contactEmails: str(p.contact_emails),
    contactPhones: str(p.contact_phones),
    flags: Array.isArray(p.flags) ? p.flags.map(String) : [],
    archiveReason: str(p.archive_reason),
    completedDate: str(p.completed_date),
    activityLog: Array.isArray(p.activity_log) ? p.activity_log.map(String) : [],
  }
}

function paymentFromRow(r) {
  return {
    id: str(r.id),
    projectId: str(r.project_id),
    amount: amountOf(r),
    dateReceived: str(r.date_received),
    pending: !!r.pending,
    type: r.type == null ? 'deposit' : str(r.type),
    method: str(r.method),
    note: str(r.note),
    createdAt: isoZ(r.created_at),
  }
}

// The bell's labels, matching NOTIF_LABELS in crm-snapshot.mjs.
const NOTIF_LABELS = {
  'invoice-paid': 'Invoice paid',
  'contract-viewed': 'Contract viewed',
  'contract-signed': 'Contract signed',
  'task-due': 'Task due',
}

// ---------- loaders (one per tab; the seams for later writes) ----------

// Pipeline: all projects + the pipeline structure (grouping/labels). The board shows bucket='active';
// we return every project so a task/notification can still resolve a client name for any bucket.
export async function loadProjects() {
  const { data, error } = await sb
    .from('projects')
    .select('id,client_name,project_name,bucket,stage_id,status,event_type,event_date,event_start_time,show_start_time,event_location,venue_type,indoors_or_outdoors,number_of_guests,age_of_guests,performance_style,total_fee,total_fee_text,tips,mileage,vips,av,booking_source,event_summary,event_description,project_notes,contact_names,contact_emails,contact_phones,flags,archive_reason,completed_date,activity_log')
  if (error) throw error
  return (data || []).map(projectFromRow)
}

// The editable pipeline structure (umbrellas -> stages), used to group/sort the board and to label
// each project's stage. Shape already matches what the UI's applySnapshot() consumed: it is
// pipeline_meta.structure verbatim ({ umbrellas: [{ id, label, color, stages: [{ id, name }] }] }).
export async function loadStructure() {
  const { data, error } = await sb.from('pipeline_meta').select('structure').limit(1).single()
  if (error) throw error
  const s = (data && data.structure) || {}
  return { umbrellas: Array.isArray(s.umbrellas) ? s.umbrellas : [] }
}

// Tasks: project_id, title, due_date, due_time, done. Grouped overdue/today/upcoming in the view.
export async function loadTasks() {
  const { data, error } = await sb.from('tasks').select('id,project_id,title,due_date,due_time,done')
  if (error) throw error
  return (data || []).map((t) => ({
    id: str(t.id),
    projectId: str(t.project_id),
    title: str(t.title),
    dueDate: str(t.due_date),
    dueTime: str(t.due_time),
    done: !!t.done,
  }))
}

// Alerts: unseen notifications, newest handled by the view. Attaches the friendly label + the client
// name (resolved from the projects map), matching what crm-snapshot.mjs produced.
export async function loadNotifications(projectsById) {
  const { data, error } = await sb
    .from('notifications')
    .select('id,project_id,kind,source_id,seen,created_at')
    .eq('seen', false)
  if (error) throw error
  const byId = projectsById || new Map()
  return (data || []).map((r) => {
    const kind = str(r.kind)
    const projectId = str(r.project_id)
    return {
      id: str(r.id),
      projectId,
      kind,
      label: NOTIF_LABELS[kind] || kind,
      createdAt: isoZ(r.created_at),
      projectName: byId.get(projectId) || projectId,
    }
  })
}

// The editable config row (crm_config.data jsonb). Holds the monthly goal + income goal tiers +
// event-field label overrides / hidden / deleted lists that the finance + detail views use.
const DEFAULT_GOALS = [80000, 100000, 150000]
const DEFAULT_MONTHLY_GOAL = 10000
export async function loadConfig() {
  const { data, error } = await sb.from('crm_config').select('data').limit(1).single()
  if (error) throw error
  const d = (data && data.data) || {}
  const goals = Array.isArray(d.incomeGoals) && d.incomeGoals.length
    ? d.incomeGoals.map(num).filter((n) => n > 0)
    : DEFAULT_GOALS
  const monthlyGoal = num(d.monthlyGoal) > 0 ? num(d.monthlyGoal) : DEFAULT_MONTHLY_GOAL
  return {
    incomeGoals: [...goals].sort((a, b) => a - b),
    monthlyGoal,
    eventFieldLabels: d.eventFieldLabels && typeof d.eventFieldLabels === 'object' ? d.eventFieldLabels : {},
    eventFieldHidden: Array.isArray(d.eventFieldHidden) ? d.eventFieldHidden.map(String) : [],
    eventFieldDeleted: Array.isArray(d.eventFieldDeleted) ? d.eventFieldDeleted.map(String) : [],
    // Custom event fields live in files on the desktop and are NOT in Supabase, so the phone has none.
    customFields: Array.isArray(d.customFields)
      ? d.customFields.filter((f) => f && f.id).map((f) => ({ id: String(f.id), label: String(f.label || '') }))
      : [],
  }
}

// Finance: computed CLIENT-SIDE from payments + projects + config, replicating computeFinance() in
// crm-finance.mjs exactly. All money comes from the PAYMENTS ledger (not the quote), except the
// forward-looking "expected rest of year" which uses each active project's total_fee minus payments.
//   - "received" = a real (non-pending, dated) payment bucketed by the month the money arrived.
//   - "earned"   = the same payment bucketed by its project's EVENT month.
//   - expectedRemaining = sum over active projects of max(0, total_fee - payments received so far).
// Returns the same finance object the Money tab already renders (thisMonth, monthlyGoal, goals,
// expectedRemaining, last12), so the view is untouched.
export function computeFinance(projects, payments, config) {
  const now = new Date()
  const year = now.getFullYear()
  const mKey = (iso) => (iso && /^\d{4}-\d{2}/.test(iso) ? iso.slice(0, 7) : '')
  const quote = (p) => (typeof p.totalFee === 'number' ? p.totalFee : 0)
  const tipOf = (p) => (typeof p.tips === 'number' ? p.tips : 0)

  const byId = new Map(projects.map((p) => [p.id, p]))
  const projName = (id) => (byId.get(id) ? byId.get(id).client : '(unassigned)')
  const eventMonthOf = (pm) => mKey(byId.get(pm.projectId) ? byId.get(pm.projectId).eventDate : '')

  // Real money in = a logged payment that isn't date-pending and has a positive amount.
  const realPayments = payments.filter((pm) => !pm.pending && num(pm.amount) > 0)

  const groupByProject = (items) => {
    const by = new Map()
    for (const it of items) by.set(it.id, (by.get(it.id) || 0) + it.amount)
    return [...by.entries()]
      .map(([id, amount]) => ({ id, name: projName(id), amount }))
      .sort((a, b) => b.amount - a.amount)
  }
  const paysToItems = (pmts) => groupByProject(pmts.map((pm) => ({ id: pm.projectId || '', amount: num(pm.amount) })))
  const tipItemsForMonth = (key) =>
    projects
      .filter((p) => tipOf(p) > 0 && mKey(p.eventDate) === key)
      .map((p) => ({ id: p.id, name: p.client, amount: tipOf(p) }))
      .sort((a, b) => b.amount - a.amount)

  // Trailing 12 months (oldest first).
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

  // Still expected to come in this year: each ACTIVE project's quote minus what it already paid.
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

  const goals = config.incomeGoals.map((goal) => ({ goal }))

  return {
    year,
    thisMonth,
    last12,
    expectedRemaining,
    expectedItems,
    goals,
    monthlyGoal: config.monthlyGoal,
    hasPayments: payments.length > 0,
  }
}

// One call that pulls everything a load-and-render needs, and assembles the exact `SNAP`-shaped
// object the view code consumes. This is the single seam the boot code hits after login.
export async function loadEverything() {
  const [projects, structure, tasks, config, paymentsRaw] = await Promise.all([
    loadProjects(),
    loadStructure(),
    loadTasks(),
    loadConfig(),
    sb.from('payments').select('id,project_id,amount,amount_text,date_received,pending,type,method,note,created_at'),
  ])
  if (paymentsRaw.error) throw paymentsRaw.error
  const payments = (paymentsRaw.data || []).map(paymentFromRow)
  const byIdName = new Map(projects.map((p) => [p.id, p.client]))
  const notifications = await loadNotifications(byIdName)
  const finance = computeFinance(projects, payments, config)
  return {
    generatedAt: new Date().toISOString(),
    projects,
    structure,
    tasks,
    notifications,
    finance,
    customFields: config.customFields,
    customValues: {}, // custom values are desktop-file-only; the phone has none
    eventFieldLabels: config.eventFieldLabels,
    eventFieldHidden: config.eventFieldHidden,
    eventFieldDeleted: config.eventFieldDeleted,
  }
}
