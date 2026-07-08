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

// ---------- phone normalization (mirrors crm-phone.mjs formatPhoneField) ----------
// Formats each phone-number run found in a string IN PLACE: 10 digits -> (XXX) XXX-XXXX ;
// 11 digits -> +X (XXX) XXX-XXXX. Surrounding text (names, "(cell)", "TBD", a 2nd number) is
// preserved; runs that aren't 10/11 digits are left untouched. "/" is excluded so dates like
// 8/19/2026 never match. Byte-identical to the desktop so contact_phones round-trips the same.
function fmtDigits(d) {
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
  if (d.length === 11) return `+${d[0]} (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`
  return null
}
const PHONE_RUN = /\+?\(?\d[\d\s().\-]{7,}\d/g
export function formatPhoneField(raw) {
  const s = String(raw == null ? '' : raw).trim()
  if (!s) return ''
  return s.replace(PHONE_RUN, (run) => fmtDigits(run.replace(/\D/g, '')) || run)
}

// The bell's labels, matching NOTIF_LABELS in crm-data-plugin.mjs. task-due is resolved to the
// task's real title in loadNotifications (this map is only the fallback); new-inquiry gets special
// styling in the Alerts view.
const NOTIF_LABELS = {
  'invoice-paid': 'Invoice paid',
  'contract-viewed': 'Contract viewed',
  'contract-signed': 'Contract signed',
  'task-due': 'Task due',
  'new-inquiry': 'New inquiry',
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
// name (resolved from the projects map), matching what crm-data-plugin.mjs produces. For task-due,
// the source_id is resolved to the task's REAL title (via tasksById) so the alert shows the task name
// instead of the generic "Task due"; the raw kind is kept so the view can style new-inquiry specially.
export async function loadNotifications(projectsById, tasksById) {
  const { data, error } = await sb
    .from('notifications')
    .select('id,project_id,kind,source_id,seen,created_at')
    .eq('seen', false)
  if (error) throw error
  const byId = projectsById || new Map()
  const tById = tasksById || new Map()
  return (data || []).map((r) => {
    const kind = str(r.kind)
    const projectId = str(r.project_id)
    const sourceId = str(r.source_id)
    let label = NOTIF_LABELS[kind] || kind
    if (kind === 'task-due') {
      const t = tById.get(sourceId)
      if (t && t.title) label = String(t.title)
    }
    return {
      id: str(r.id),
      projectId,
      kind,
      sourceId,
      label,
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

// ============================================================================
// WRITES (Stage C). The phone writes DIRECTLY to Supabase via supabase-js, so the DATABASE does NOT
// enforce the CRM business rules (those live in the desktop's crm-data-core.mjs). Every rule that
// matters is therefore replicated HERE, client-side, before the write hits PostgREST. Each function
// returns the freshly written/updated record (already mapped to the app's camelCase shape) so the
// caller can optimistically patch the on-screen data, and throws on failure with a clear message.
// ============================================================================

// "July 6, 2026" — the activity_log date style, matching logDate() in crm-data-core.mjs. Newest
// entries are PREPENDED so the log stays newest-first.
function logDate() {
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  const d = new Date()
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`
}

// dueTime kept as "HH:MM" (24h) or "" for an all-day task. Mirrors normalizeTime() in crm-data-core.
function normalizeTime(t) {
  const s = String(t == null ? '' : t).trim()
  const m = s.match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return ''
  const h = Number(m[1]), min = Number(m[2])
  if (h > 23 || min > 59) return ''
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

// A fresh uuid (the desktop uses crypto.randomUUID() for task/payment ids; the DB columns are uuid).
function uuid() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID()
  // Fallback for older webviews without crypto.randomUUID.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

// ---------- tasks ----------
// addTask: same shape + id generation as crm-data-core.addTask (uuid id, normalized dueTime, done
// false, created_at now). Returns the app task record.
export async function addTask({ projectId, title, dueDate, dueTime } = {}) {
  const t = String(title == null ? '' : title).trim()
  if (!t) throw new Error('Task title is required.')
  const row = {
    id: uuid(),
    project_id: String(projectId || ''),
    title: t,
    due_date: String(dueDate || ''),
    due_time: normalizeTime(dueTime),
    done: false,
    created_at: new Date().toISOString(),
  }
  const { error } = await sb.from('tasks').insert(row)
  if (error) throw error
  return { id: row.id, projectId: row.project_id, title: row.title, dueDate: row.due_date, dueTime: row.due_time, done: false }
}

// updateTask: edit a task's title / due date / due time (crm-data-core.updateTask). Only the given
// fields are written. If the due date or time actually changes, notified_at is reset to NULL so the
// cloud alarm (notify-cron) will fire again at the new time. Mirrors the desktop reschedule reset.
// (No phone UI calls this yet, but it's here and correct for when task-editing lands on the phone.)
export async function updateTask({ id, title, dueDate, dueTime } = {}) {
  if (!id) throw new Error('Task id is required.')
  const patch = {}
  if (title != null) patch.title = String(title)
  const rescheduling = dueDate != null || dueTime != null
  if (dueDate != null) patch.due_date = String(dueDate)
  if (dueTime != null) patch.due_time = normalizeTime(dueTime)
  if (rescheduling) {
    // Compare against the current row so we only clear notified_at when the alarm time really moved.
    const { data: cur } = await sb.from('tasks').select('due_date,due_time').eq('id', id).single()
    const prevDate = str(cur && cur.due_date)
    const prevTime = normalizeTime(cur && cur.due_time)
    const nextDate = dueDate != null ? String(dueDate) : prevDate
    const nextTime = dueTime != null ? normalizeTime(dueTime) : prevTime
    if (nextDate !== prevDate || nextTime !== prevTime) patch.notified_at = null
  }
  if (!Object.keys(patch).length) return { ok: true }
  const { error } = await sb.from('tasks').update(patch).eq('id', id)
  if (error) throw error
  return { ok: true }
}

// toggleTask: flip the done flag (crm-data-core.updateTask with just {done}).
export async function toggleTask(id, done) {
  if (!id) throw new Error('Task id is required.')
  const { error } = await sb.from('tasks').update({ done: !!done }).eq('id', id)
  if (error) throw error
  return { ok: true }
}

// deleteTask: crm-data-core.deleteTask.
export async function deleteTask(id) {
  if (!id) throw new Error('Task id is required.')
  const { error } = await sb.from('tasks').delete().eq('id', id)
  if (error) throw error
  return { ok: true }
}

// ---------- project notes / activity log ----------
// addNote: prepend a dated line to the project's activity_log jsonb array (newest first), matching
// appendActivityLog() in crm-data-core.mjs. The whole array is rewritten (jsonb has no push). Returns
// the new full activityLog array so the caller can patch SNAP without a re-fetch.
export async function addNote(projectId, text) {
  const clean = String(text == null ? '' : text).trim()
  if (!projectId) throw new Error('Project id is required.')
  if (!clean) throw new Error('Note text is required.')
  const { data: cur, error: readErr } = await sb.from('projects').select('activity_log').eq('id', projectId).single()
  if (readErr) throw readErr
  const existing = Array.isArray(cur && cur.activity_log) ? cur.activity_log.map(String) : []
  const entry = `${logDate()}: ${clean}`
  const activity_log = [entry, ...existing]
  const { error } = await sb.from('projects').update({ activity_log }).eq('id', projectId)
  if (error) throw error
  return { ok: true, entry, activityLog: activity_log }
}

// ---------- project field edits ----------
// A SAFE, allow-listed set of editable columns (camelCase field -> snake_case column). client_name is
// deliberately NOT here: it is the immutable slug/join key. project_name holds the editable display
// name. Mirrors the relevant subset of EDITABLE_FIELDS in crm-data-core.mjs.
const PROJECT_FIELD_COLUMNS = {
  eventDate: 'event_date',
  eventLocation: 'event_location',
  venueType: 'venue_type',
  indoorsOrOutdoors: 'indoors_or_outdoors',
  eventStartTime: 'event_start_time',
  showStartTime: 'show_start_time',
  numberOfGuests: 'number_of_guests',
  ageOfGuests: 'age_of_guests',
  performanceStyle: 'performance_style',
  eventDescription: 'event_description',
  projectNotes: 'project_notes',
  contactNames: 'contact_names',
  contactEmails: 'contact_emails',
  contactPhones: 'contact_phones',
  bookingSource: 'booking_source',
  projectName: 'project_name',
  vips: 'vips',
  av: 'av',
}
// updateProjectField: write one allow-listed text column. contact_phones gets the desktop's phone
// normalization applied on save (coerceFieldValue in crm-data-core.mjs). All these columns are text,
// so values are stored as strings. Returns the stored value for optimistic UI patching.
export async function updateProjectField(id, col, value) {
  if (!id) throw new Error('Project id is required.')
  const column = PROJECT_FIELD_COLUMNS[col]
  if (!column) throw new Error(`Field not editable on phone: ${col}`)
  let stored = value == null ? '' : String(value)
  if (column === 'contact_phones') stored = formatPhoneField(stored)
  const { error } = await sb.from('projects').update({ [column]: stored }).eq('id', id)
  if (error) throw error
  return { ok: true, id, field: col, column, value: stored }
}

// ---------- payments ----------
// addPayment: insert a payment row (uuid id, numeric amount + amount_text companion for non-numeric,
// created_at now), matching addPayment()/paymentToRow() in crm-finance.mjs. type is clamped to the
// same allowed set. A dated (non-pending) payment is what the Booked-stage gate looks for. Returns the
// app payment record so the Money tab can be refreshed / patched.
export async function addPayment({ projectId, amount, dateReceived, type, method, note, pending } = {}) {
  if (!projectId) throw new Error('Project id is required.')
  const isPending = !!pending
  const amtNum = num(amount)
  const numeric = Number.isFinite(amtNum) ? amtNum : null
  const row = {
    id: uuid(),
    project_id: String(projectId || ''),
    amount: numeric,
    amount_text: numeric === null ? String(amount) : null,
    date_received: isPending ? '' : String(dateReceived || ''),
    pending: isPending,
    type: ['deposit', 'balance', 'full', 'other'].includes(type) ? type : 'deposit',
    method: String(method || ''),
    note: String(note || ''),
    created_at: new Date().toISOString(),
  }
  const { error } = await sb.from('payments').insert(row)
  if (error) throw error
  return paymentFromRow(row)
}

// ---------- stage move (with the desktop's gates replicated) ----------
// Returns the umbrella whose role matches, from the loaded structure (pipeline_meta.structure).
function umbrellaByRole(structure, role) {
  return (structure.umbrellas || []).find((u) => u.role === role) || null
}
function stageIdsForRole(structure, role) {
  const u = umbrellaByRole(structure, role)
  return new Set(u ? (u.stages || []).map((s) => s.id) : [])
}
function validStageIds(structure) {
  const s = new Set()
  for (const u of structure.umbrellas || []) for (const st of u.stages || []) s.add(st.id)
  return s
}
// A project has a RECEIVED payment iff there's a non-pending payment with a positive amount AND a real
// date_received. Mirrors hasReceivedPaymentFor() / isReceivedPayment() in crm-data-core.mjs.
function hasReceivedPayment(payments, projectId) {
  return (payments || []).some(
    (pm) => pm.projectId === projectId && !pm.pending && num(pm.amount) > 0 && String(pm.dateReceived || '').trim() !== '',
  )
}
// setStage: move a project to stageId, replicating crm-data-core.setStage's two gates:
//   1. Post Show (role 'postshow') is AUTO-ONLY: block a manual move INTO it (moving out is fine).
//   2. Booked category (role 'booked') is PAYMENT-GATED: block moving into any of its stages unless
//      the project has a received payment on file.
// `structure` and `payments` are passed in (the app already has them loaded) so no extra fetch is
// needed and the gate reads the same data the UI shows. Throws (with the desktop's messages) when a
// gate blocks; on success writes stage_id and returns { ok, id, stageId }.
export async function setStage(projectId, stageId, structure, payments) {
  if (!projectId || !stageId) throw new Error('Project id and stage are required.')
  if (!validStageIds(structure).has(stageId)) throw new Error('Invalid stage.')
  if (stageIdsForRole(structure, 'postshow').has(stageId)) {
    throw new Error('Projects move into Post Show automatically the day after the event; they can be moved out but not in.')
  }
  if (stageIdsForRole(structure, 'booked').has(stageId) && !hasReceivedPayment(payments, projectId)) {
    throw new Error('Cannot move to a Booked stage without a received payment (amount + date). Log a payment for this project first.')
  }
  const { error } = await sb.from('projects').update({ stage_id: stageId }).eq('id', projectId)
  if (error) throw error
  return { ok: true, id: projectId, stageId }
}

// ---------- contacts ----------
// A contact for a project is matched by email/name on the desktop; the phone edits the contact row
// directly by id. updateContact patches an allow-listed set (name, relationship, tags, notes, emails,
// phones), normalizing phones the same way as the desktop and bumping updated_at. emails/phones/tags
// are jsonb arrays. Mirrors updateContact() in crm-contacts.mjs (the fields the phone exposes).
const CONTACT_RELATIONSHIPS = ['', 'active', 'yes', 'maybe', 'no']
function toList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean)
  return String(v == null ? '' : v).split(/[,;\n]/).map((s) => s.trim()).filter(Boolean)
}
export async function updateContact(id, patch = {}) {
  if (!id) throw new Error('Contact id is required.')
  const row = { updated_at: new Date().toISOString() }
  if ('name' in patch) row.name = String(patch.name == null ? '' : patch.name)
  if ('relationship' in patch) row.relationship = CONTACT_RELATIONSHIPS.includes(patch.relationship) ? patch.relationship : ''
  if ('notes' in patch) row.notes = String(patch.notes == null ? '' : patch.notes)
  if ('tags' in patch) row.tags = toList(patch.tags)
  if ('emails' in patch) row.emails = toList(patch.emails)
  if ('phones' in patch) row.phones = toList(patch.phones).map((p) => formatPhoneField(p))
  const { error } = await sb.from('contacts').update(row).eq('id', id)
  if (error) throw error
  return { ok: true, id, patch: row }
}

// Load contacts (id + editable fields) so the phone can show/edit them. Mirrors the read shape of
// crm-contacts.mjs (jsonb arrays -> string arrays).
export async function loadContacts() {
  const { data, error } = await sb.from('contacts').select('id,name,emails,phones,type,relationship,engagement,tags,notes')
  if (error) throw error
  return (data || []).map((c) => ({
    id: str(c.id),
    name: str(c.name),
    emails: Array.isArray(c.emails) ? c.emails.map(String) : [],
    phones: Array.isArray(c.phones) ? c.phones.map(String) : [],
    type: str(c.type),
    relationship: str(c.relationship),
    engagement: str(c.engagement),
    tags: Array.isArray(c.tags) ? c.tags.map(String) : [],
    notes: str(c.notes),
  }))
}

// Refresh just the payments ledger + recompute finance (used after addPayment). Returns { payments,
// finance } so the Money tab and the stage gate stay in sync without a full loadEverything().
export async function reloadPaymentsFinance(projects, config) {
  const { data, error } = await sb.from('payments').select('id,project_id,amount,amount_text,date_received,pending,type,method,note,created_at')
  if (error) throw error
  const payments = (data || []).map(paymentFromRow)
  const finance = computeFinance(projects, payments, config)
  return { payments, finance }
}

// ---------- web push ----------
// savePushSubscription: UPSERT this device's Web Push subscription into push_subscriptions so the Mac
// can send lock-screen notifications to it. Keyed by endpoint (unique), so re-subscribing the same
// device just refreshes the row instead of piling up duplicates. RLS requires a logged-in session
// (the anon/publishable key alone can't touch this table). `sub` is the PushSubscription (its .toJSON()
// or the object itself); we store the full JSON in `subscription` and its endpoint in `endpoint`.
export async function savePushSubscription(sub) {
  const s = sub && typeof sub.toJSON === 'function' ? sub.toJSON() : sub
  const endpoint = s && s.endpoint
  if (!endpoint) throw new Error('Subscription has no endpoint.')
  const row = {
    endpoint,
    subscription: s,
    user_agent: (typeof navigator !== 'undefined' && navigator.userAgent) || '',
  }
  const { error } = await sb.from('push_subscriptions').upsert(row, { onConflict: 'endpoint' })
  if (error) throw error
  return { ok: true, endpoint }
}

// One call that pulls everything a load-and-render needs, and assembles the exact `SNAP`-shaped
// object the view code consumes. This is the single seam the boot code hits after login.
export async function loadEverything() {
  const [projects, structure, tasks, config, contacts, paymentsRaw] = await Promise.all([
    loadProjects(),
    loadStructure(),
    loadTasks(),
    loadConfig(),
    loadContacts(),
    sb.from('payments').select('id,project_id,amount,amount_text,date_received,pending,type,method,note,created_at'),
  ])
  if (paymentsRaw.error) throw paymentsRaw.error
  const payments = (paymentsRaw.data || []).map(paymentFromRow)
  const byIdName = new Map(projects.map((p) => [p.id, p.client]))
  const tasksById = new Map(tasks.map((t) => [t.id, t]))
  const notifications = await loadNotifications(byIdName, tasksById)
  const finance = computeFinance(projects, payments, config)
  return {
    generatedAt: new Date().toISOString(),
    projects,
    structure,
    tasks,
    notifications,
    finance,
    // Raw ledgers/config kept on SNAP so writes (stage gate, finance refresh, contact edits) work off
    // the same data the UI shows, without an extra round-trip.
    payments,
    config,
    contacts,
    customFields: config.customFields,
    customValues: {}, // custom values are desktop-file-only; the phone has none
    eventFieldLabels: config.eventFieldLabels,
    eventFieldHidden: config.eventFieldHidden,
    eventFieldDeleted: config.eventFieldDeleted,
  }
}
