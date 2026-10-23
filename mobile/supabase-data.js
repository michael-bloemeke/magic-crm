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

// VENDORED, not loaded from a CDN (2026-08-05).
//
// This used to be `import ... from 'https://esm.sh/@supabase/supabase-js@2'`, which meant the app
// downloaded and executed third-party code on every open, unpinned to any version. If esm.sh were
// ever compromised or DNS-hijacked, that code would run INSIDE Michael's logged-in session and could
// read every client record in the CRM. That is the single realest path to a data breach here, and it
// had nothing to do with who hosts the files: the import happened in the browser regardless.
//
// vendor/ now holds supabase-js 2.112.1 plus the Node shims it needs, with every import rewritten to
// a local path. Nothing in the app loads code from any other origin.
//
// To update: re-fetch the bundle from esm.sh, re-point its /node/*.mjs imports at ./node-*.js, and
// check the closure again. Deliberately a manual, visible step rather than an automatic one.
import { createClient } from './vendor/supabase-js.js'
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

// ---------- change sentinel (egress guard) ----------
// data_version is a one-row table a DB trigger bumps on every write to any CRM table. The
// background refresh fetches just this (~30 bytes) and skips the full reload when nothing
// changed, instead of re-downloading every table each 30s tick. On any error, report
// changed=true so a sentinel hiccup can never freeze the app on stale data.
let lastSeenV = null
export async function dataChangedSinceLastLoad() {
  try {
    const { data, error } = await sb.from('data_version').select('v').eq('id', 1).single()
    if (error || !data) return true
    return lastSeenV === null || Number(data.v) !== lastSeenV
  } catch (_) {
    return true
  }
}
// Called by the load path after a successful full load, so the next poll compares against it.
export async function noteDataVersionLoaded() {
  try {
    const { data } = await sb.from('data_version').select('v').eq('id', 1).single()
    if (data) lastSeenV = Number(data.v)
  } catch (_) { /* leave stale -> next poll reloads, which is safe */ }
}

// ---------- small mappers (mirror the desktop's crm-data-core.mjs / crm-finance.mjs) ----------
function str(v) { return v == null ? '' : String(v) }
// total_fee / tips / mileage: a numeric column with a text companion for values that are not
// numbers ("TBD", "$750-$1500"). The two are meant to be mutually exclusive: import-phase1.mjs
// only fills the companion when the numeric parse FAILS.
//
// ⚠️ THE NUMBER WINS. This used to return the companion whenever it was non-empty, which is the
// wrong way round the moment both columns are populated, and five projects have ended up that way.
// On "Jacqueline and David's wedding", total_fee is 1250 and total_fee_text holds a sentence about
// the conversation, so the phone showed "Quote: Not set" on a project with a quote, left the fee
// off its pipeline card, and would have held the "Ready to book" gate red on a job that was ready.
// The Proposals page, the backup exporter and verify-phone-read all read number-first; this was the
// one place that did not.
function numOrNull(v, text) {
  if (typeof v === 'number') return v
  if (v != null && v !== '') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  if (text != null && text !== '') return text // a genuinely non-numeric value, kept verbatim
  return null
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
    arrivalTime: str(p.arrival_time),
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
    // When it was soft-deleted. The Deleted page counts the 30-day window down from this.
    deletedAt: str(p.deleted_at),
    activityLog: Array.isArray(p.activity_log) ? p.activity_log.map(String) : [],
    // Added 2026-10-23 for parity with the Mac: Post Show tips, Stats (lead date, sign-off), the
    // Booked-stage gig-times gate, the Initial inquiry window, and the archive tooltip.
    tipsMethod: str(p.tips_method),
    leadDate: str(p.lead_date),
    signedOff: !!p.stat_signed_off,
    leaveHomeTime: str(p.leave_home_time),
    backHomeTime: str(p.back_home_time),
    initialInquiry: str(p.initial_inquiry),
    whyArchived: str(p.why_archived),
    createdAt: str(p.created_at),
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
  'proposal-viewed': 'Proposal viewed',
}

// ---------- loaders (one per tab; the seams for later writes) ----------

// Pipeline: all projects + the pipeline structure (grouping/labels). The board shows bucket='active';
// we return every project so a task/notification can still resolve a client name for any bucket.
export async function loadProjects() {
  const { data, error } = await sb
    .from('projects')
    .select('id,client_name,project_name,bucket,stage_id,status,event_type,event_date,arrival_time,event_start_time,show_start_time,event_location,venue_type,indoors_or_outdoors,number_of_guests,age_of_guests,performance_style,total_fee,total_fee_text,tips,tips_method,mileage,vips,av,booking_source,event_summary,event_description,project_notes,contact_names,contact_emails,contact_phones,flags,archive_reason,why_archived,completed_date,deleted_at,activity_log,lead_date,stat_signed_off,leave_home_time,back_home_time,initial_inquiry,created_at')
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
  // task-due is EXCLUDED. A due task is counted once, on the Tasks badge; it used to also land here,
  // so one overdue task showed as two things needing attention. Worse, the row outlived the task:
  // completing or deleting the task never cleared it. The cloud cron no longer writes these, and the
  // filter stays as a guard so any historical row cannot come back.
  const { data, error } = await sb
    .from('notifications')
    .select('id,project_id,kind,source_id,seen,created_at')
    .eq('seen', false)
    .neq('kind', 'task-due')
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

// Dismiss (or un-dismiss) an alert. Alerts are rows in `notifications` with a seen flag; the phone
// only ever loads the unseen ones, so flipping the flag is the whole operation. Nothing is deleted,
// which is what makes Undo possible.
export async function setNotificationSeen(id, seen = true) {
  if (!id) throw new Error('Notification id is required.')
  const { error } = await sb.from('notifications').update({ seen: !!seen }).eq('id', id)
  if (error) throw error
  return { ok: true, id, seen: !!seen }
}

// The editable config row (crm_config.data jsonb). Holds the monthly goal + income goal tiers +
// event-field label overrides / hidden / deleted lists that the finance + detail views use.
const DEFAULT_GOALS = [80000, 100000, 150000]
const DEFAULT_MONTHLY_GOAL = 10000
// The desktop's starter archive-reason list (src/pipeline.ts ARCHIVE_REASONS). Used to populate the
// Archive sheet on the phone when the config has no custom list saved.
export const DEFAULT_ARCHIVE_REASONS = [
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
export async function loadConfig() {
  const { data, error } = await sb.from('crm_config').select('data').limit(1).single()
  if (error) throw error
  const d = (data && data.data) || {}
  const goals = Array.isArray(d.incomeGoals) && d.incomeGoals.length
    ? d.incomeGoals.map(num).filter((n) => n > 0)
    : DEFAULT_GOALS
  const monthlyGoal = num(d.monthlyGoal) > 0 ? num(d.monthlyGoal) : DEFAULT_MONTHLY_GOAL
  const archiveReasons = Array.isArray(d.archiveReasons) && d.archiveReasons.length
    ? d.archiveReasons.map(String).filter(Boolean)
    : DEFAULT_ARCHIVE_REASONS
  return {
    incomeGoals: [...goals].sort((a, b) => a - b),
    monthlyGoal,
    archiveReasons,
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

  // The Mac computes finance over LIVE projects only (crm-finance.mjs): anything in Deleted is gone
  // from every figure, its payments and tips included. The phone used to count them.
  const deletedIds = new Set(projects.filter((p) => p.bucket === 'deleted').map((p) => p.id))
  projects = projects.filter((p) => p.bucket !== 'deleted')
  payments = payments.filter((pm) => !deletedIds.has(pm.projectId))
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
    months,
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
  arrivalTime: 'arrival_time',
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
  eventSummary: 'event_summary',
  // Added 2026-10-23 for parity with the Mac (all text columns).
  leadDate: 'lead_date',
  eventType: 'event_type',
  archiveReason: 'archive_reason',
  tipsMethod: 'tips_method',
  leaveHomeTime: 'leave_home_time',
  backHomeTime: 'back_home_time',
  initialInquiry: 'initial_inquiry',
}
// Numeric and boolean columns, written the way coerceFieldValue in crm-data-core.mjs writes them.
const NUMERIC_FIELD_COLUMNS = { tips: 'tips', mileage: 'mileage' }
const BOOLEAN_FIELD_COLUMNS = { signedOff: 'stat_signed_off' }
// The QUOTE is not in the map above because total_fee is a NUMERIC column with a total_fee_text
// companion for legacy non-numeric values, so it cannot be written like the text fields. It gets
// its own branch in updateProjectField.
//
// ⚠️ This was the bug. totalFee was added to EDITABLE_DETAIL_FIELDS on the phone (2026-08-05) to
// unblock "Ready to book", whose gate needs a quote, but nothing was added HERE. So the field
// appeared in Event details, accepted a number, and then threw "Field not editable on phone:
// totalFee" on blur. The gate that the field existed to satisfy stayed red.
const FEE_FIELD = 'totalFee'
// updateProjectField: write one allow-listed text column. contact_phones gets the desktop's phone
// normalization applied on save (coerceFieldValue in crm-data-core.mjs). All these columns are text,
// so values are stored as strings. Returns the stored value for optimistic UI patching.
export async function updateProjectField(id, col, value) {
  if (!id) throw new Error('Project id is required.')
  if (col === FEE_FIELD) {
    // Mirrors coerceFieldValue for total_fee in crm-data-core.mjs: a clean number goes in the
    // numeric column and clears the text companion; anything else (blank, "TBD", a range) goes in
    // the companion and nulls the number, so the finance maths never sees a half-parsed value.
    const raw = String(value == null ? '' : value).trim().replace(/[$,]/g, '')
    const n = raw === '' ? null : Number(raw)
    const numeric = n != null && Number.isFinite(n) ? n : null
    const { error } = await sb
      .from('projects')
      .update({ total_fee: numeric, total_fee_text: numeric == null && raw !== '' ? raw : null })
      .eq('id', id)
    if (error) throw error
    return { ok: true, id, field: col, column: 'total_fee', value: numeric != null ? numeric : raw }
  }
  if (NUMERIC_FIELD_COLUMNS[col]) {
    const raw = String(value == null ? '' : value).trim().replace(/[$,]/g, '')
    const n = raw === '' ? null : Number(raw)
    if (n !== null && !Number.isFinite(n)) throw new Error('Enter a number.')
    const { error } = await sb.from('projects').update({ [NUMERIC_FIELD_COLUMNS[col]]: n }).eq('id', id)
    if (error) throw error
    return { ok: true, id, field: col, column: NUMERIC_FIELD_COLUMNS[col], value: n }
  }
  if (BOOLEAN_FIELD_COLUMNS[col]) {
    const b = value === true || String(value).toLowerCase() === 'true'
    const { error } = await sb.from('projects').update({ [BOOLEAN_FIELD_COLUMNS[col]]: b }).eq('id', id)
    if (error) throw error
    return { ok: true, id, field: col, column: BOOLEAN_FIELD_COLUMNS[col], value: b }
  }
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
  // A payment may stand on its own (the Finance page's Payments tab allows "(none)", as the Mac does).
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
  // The Mac's Type and Engagement chips (2026-10-23). Stored lower-case, the way the Mac stores them.
  if ('type' in patch) row.type = ['client', 'vendor', 'associate', 'other'].includes(String(patch.type).toLowerCase()) ? String(patch.type).toLowerCase() : 'client'
  if ('engagement' in patch) row.engagement = ['', 'emailed', 'collaborated'].includes(patch.engagement) ? patch.engagement : ''
  const { error } = await sb.from('contacts').update(row).eq('id', id)
  if (error) throw error
  return { ok: true, id, patch: row }
}

// Create a contact record and link it to a project, or link an existing one.
//
// WHY THIS EXISTS. Until 2026-08-05 the phone wrote contact details as plain TEXT onto the project
// (contact_names / contact_emails / contact_phones) and never touched the contacts table. The desktop
// does both: a real contacts row plus a contact_links join. So a person added on the phone existed
// only as a string on one project. They did not appear in Contacts, could not be reused, and had no
// history.
//
// It also caused a live failure: "Ready to book" reads the linked contact when the project's own
// email field is blank, so a project built one way behaved differently from a project built the
// other. Michael hit that on Jack Kelly and quite reasonably said "i do have his email as you can
// see".
//
// linkOrCreateContact takes what the sheet collected and does the right thing either way:
//   - contactId given (he picked a suggestion) -> just link it, leave their record alone
//   - no id, but a name -> create the contact, then link it
//
// Best-effort by design: the project has already been written by the time this runs, and a failure
// to build the join must never make a saved project look unsaved. The text fields on the project are
// still written either way, so nothing regresses if this fails.
export async function linkOrCreateContact(projectId, { contactId = '', name = '', email = '', phone = '' } = {}) {
  if (!projectId) return { ok: false, skipped: 'no project' }
  let id = String(contactId || '').trim()

  if (!id) {
    const clean = String(name || '').trim()
    if (!clean) return { ok: false, skipped: 'no name' }
    const row = {
      name: clean,
      emails: toList(email),
      phones: toList(phone).map((p) => formatPhoneField(p)),
      tags: [],
      // Matches what the desktop defaults a hand-added contact to: a client, currently in play.
      type: 'Client',
      relationship: 'active',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    const { data, error } = await sb.from('contacts').insert(row).select('id').single()
    if (error) throw error
    id = String(data.id)
  }

  // Append: a new contact goes after the ones already on the project, so adding somebody never
  // silently reassigns who the contract is addressed to. position 0 is the primary.
  const { data: existing, error: posErr } = await sb
    .from('contact_links')
    .select('position')
    .eq('project_id', projectId)
    .order('position', { ascending: false })
    .limit(1)
  if (posErr) throw posErr
  const nextPos = existing && existing.length ? Number(existing[0].position ?? 0) + 1 : 0

  // ignoreDuplicates so re-linking somebody already on the project is a no-op. Without it the
  // upsert would rewrite their position and quietly demote the primary.
  const { error: linkErr } = await sb
    .from('contact_links')
    .upsert({ project_id: projectId, contact_id: id, position: nextPos },
            { onConflict: 'project_id,contact_id', ignoreDuplicates: true })
  if (linkErr) throw linkErr
  return { ok: true, contactId: id, position: nextPos }
}

// Detach a contact from a project. Deletes only the join row: the contact record itself is left
// alone, because the same person is very often on other projects. Mirrors the desktop's
// unlinkContactFromProject, which likewise only ever touches contact_links.
export async function unlinkContact(projectId, contactId) {
  if (!projectId || !contactId) throw new Error('Project and contact are required.')
  const { error } = await sb
    .from('contact_links')
    .delete()
    .eq('project_id', projectId)
    .eq('contact_id', contactId)
  if (error) throw error
  return { ok: true, projectId, contactId }
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

// ============================================================================
// PROJECT LIFECYCLE (create / archive / complete / restore / delete). The phone writes straight to
// Supabase, so every rule the desktop's crm-data-core.mjs enforces is replicated HERE, client-side,
// before the write. Faithful to the CRM_STORE==='supabase' branches of createProject/archiveProject/
// completeProject/restoreProject/deleteProject. Each returns enough to optimistically patch SNAP.
// ============================================================================

// slugify(): the project id is the slug of client_name and is the STABLE join key for
// stage/tasks/payments/mileage/links. Byte-identical to crm-data-core.slugify so ids match the desktop.
export function slugify(name) {
  return (
    String(name == null ? '' : name)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project'
  )
}

const ORPHAN_STAGE = 'inquiry' // where a new/orphaned/restored active project lands (crm-data-core)
const EVENT_TYPES = new Set(['Wedding', 'Corporate', 'Private Event', 'Bachelor(ette) Party', 'Other'])

// Fee / mileage input coercion, matching createProject in crm-data-core.mjs: strip to digits+dot,
// null for empty/non-numeric.
function numOrNullInput(raw) {
  if (raw === '' || raw == null) return null
  const n = Number(String(raw).replace(/[^0-9.]/g, ''))
  return Number.isNaN(n) ? null : n
}

// Total of RECEIVED payments (non-pending, dated, positive) for a project, from the loaded ledger.
// Mirrors receivedTotalFor() in crm-data-core.mjs (the paid-in-full completion gate).
function receivedTotalForPayments(payments, projectId) {
  return (payments || []).reduce(
    (s, pm) =>
      pm.projectId === projectId && !pm.pending && String(pm.dateReceived || '').trim() !== '' ? s + num(pm.amount) : s,
    0,
  )
}

// createProject: insert one active projects row, mirroring crm-data-core.createProject's supabase
// branch (all columns filled so normalize() reads it like an imported row). Only the name is required.
// The slug must be unique (checked against the DB). Stage is clamped to a valid, non-Booked, non-Post
// Show stage (a brand-new project has no payment yet), defaulting to Inquiry. Returns the app record.
// The canonical lead sources. MUST stay identical to LEAD_SOURCES in
// src/components/StatsPage.tsx, which is what buckets them on the Stats page: a value that is not
// on this list falls into "Other" there, so an extra one here would silently vanish from the chart.
export const LEAD_SOURCES = ['Google/Web', 'Bark', 'The Bash', 'GigSalad', 'In Person', 'Referral', 'Instagram/TikTok', 'AI', 'Repeat client', 'Other']

export async function createProject(input = {}, structure = { umbrellas: [] }) {
  const name = String(input.clientName == null ? '' : input.clientName).trim()
  if (!name) throw new Error('Project name is required.')
  const id = slugify(name)

  const { data: existing, error: exErr } = await sb.from('projects').select('id').eq('id', id).limit(1)
  if (exErr) throw exErr
  if (existing && existing.length) throw new Error(`A project named "${name}" already exists.`)

  const total_fee = numOrNullInput(input.totalFee)
  const mileage = numOrNullInput(input.mileage)

  const valid = validStageIds(structure)
  const booked = stageIdsForRole(structure, 'booked')
  const postshow = stageIdsForRole(structure, 'postshow')
  let stageId = valid.has(input.stageId) ? input.stageId : ORPHAN_STAGE
  if (booked.has(stageId) || postshow.has(stageId)) stageId = ORPHAN_STAGE

  const row = {
    id,
    client_name: name,
    project_name: name, // editable display name; client_name stays the id key
    bucket: 'active',
    stage_id: stageId,
    event_type: EVENT_TYPES.has(String(input.eventType)) ? String(input.eventType) : '',
    event_date: String(input.eventDate == null ? '' : input.eventDate),
    event_location: String(input.eventLocation == null ? '' : input.eventLocation),
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
    contact_names: String(input.contactNames == null ? '' : input.contactNames),
    contact_emails: String(input.contactEmails == null ? '' : input.contactEmails),
    contact_phones: formatPhoneField(String(input.contactPhones == null ? '' : input.contactPhones)),
    // Where the lead came from. Was hardcoded null until 2026-09-21, which meant the ONE app that
    // is used to log a gig-site lead in the moment, on the phone, was guaranteed to leave the one
    // field the Stats page needs to attribute it empty. Defaults to 'Other' rather than null so a
    // project created here is always attributable to something, even if only to "not recorded".
    // The canonical values are LEAD_SOURCES in src/components/StatsPage.tsx.
    booking_source: LEAD_SOURCES.indexOf(String(input.bookingSource || '')) >= 0 ? String(input.bookingSource) : 'Other',
    event_summary: null,
    event_description: null,
    project_notes: String(input.projectNotes == null ? '' : input.projectNotes),
    how_it_went: null,
    assets: null,
    status: 'open',
    flags: [],
    activity_log: [`${logDate()}: Project created in the CRM.`],
    archive_reason: null,
    why_archived: null,
    completed_date: null,
    // The desktop seeds a contact + link the next time it loads (seedLinksIfNeeded keys off this flag),
    // so leaving it false means the phone-created project gets its contact reconciled on the Mac.
    links_seeded: false,
  }
  const { error } = await sb.from('projects').insert(row)
  if (error) throw error
  return projectFromRow(row)
}

// archiveProject: active -> archived. Ungated (a lost/ghosted lead has $0 collected and must still be
// archivable). Prepends a dated log line, records the reason, clears the stage. Mirrors the supabase
// branch of crm-data-core.archiveProject.
export async function archiveProject(id, reason) {
  if (!id) throw new Error('Project id is required.')
  const r = String(reason == null ? '' : reason).trim()
  const { data: cur, error: rErr } = await sb.from('projects').select('bucket,activity_log').eq('id', id).single()
  if (rErr) throw rErr
  if ((str(cur.bucket) || 'active') !== 'active') throw new Error('Only an active project can be archived.')
  const existing = Array.isArray(cur.activity_log) ? cur.activity_log.map(String) : []
  const activity_log = [`${logDate()}: Project archived in CRM.${r ? ` Reason: ${r}.` : ''}`, ...existing]
  const patch = { bucket: 'archived', stage_id: null, activity_log }
  if (r) patch.archive_reason = r
  const { error } = await sb.from('projects').update(patch).eq('id', id)
  if (error) throw error
  return { ok: true, id, bucket: 'archived', archiveReason: r, activityLog: activity_log }
}

// completeProject: active -> completed. GATED paid-in-full (received payments must cover the total
// fee), matching crm-data-core.completeProject. The desktop's Complete modal also requires event date
// + mileage; the caller passes them and they're written here before the move. Reads the fee + current
// log fresh from the DB; the paid-in-full check uses the loaded payments ledger (same data the UI shows).
export async function completeProject(id, opts = {}, payments = []) {
  if (!id) throw new Error('Project id is required.')
  const { data: cur, error: rErr } = await sb
    .from('projects')
    .select('bucket,total_fee,total_fee_text,activity_log')
    .eq('id', id)
    .single()
  if (rErr) throw rErr
  if ((str(cur.bucket) || 'active') !== 'active') throw new Error('Only an active project can be completed.')
  const feeRaw = cur.total_fee
  const fee =
    feeRaw == null || feeRaw === ''
      ? null
      : Number(typeof feeRaw === 'number' ? feeRaw : String(feeRaw).replace(/[^0-9.]/g, ''))
  if (fee == null || Number.isNaN(fee)) {
    throw new Error('Set a total fee before completing, so its payments can be reconciled to it.')
  }
  const received = receivedTotalForPayments(payments, id)
  if (received + 0.005 < fee) {
    throw new Error(
      `Cannot complete: $${Math.round(fee - received)} still outstanding (received $${Math.round(received)} of the $${Math.round(fee)} fee). Log the remaining payment first.`,
    )
  }
  const patch = { bucket: 'completed', stage_id: null, completed_date: new Date().toISOString().slice(0, 10) }
  if (opts.mileage != null && String(opts.mileage) !== '') {
    const m = Number(String(opts.mileage).replace(/[^0-9.]/g, ''))
    if (Number.isFinite(m)) patch.mileage = m
  }
  if (opts.eventDate != null && String(opts.eventDate) !== '') patch.event_date = String(opts.eventDate)
  const existing = Array.isArray(cur.activity_log) ? cur.activity_log.map(String) : []
  patch.activity_log = [`${logDate()}: Project marked complete in CRM.`, ...existing]
  const { error } = await sb.from('projects').update(patch).eq('id', id)
  if (error) throw error
  return { ok: true, id, bucket: 'completed', completedDate: patch.completed_date, mileage: patch.mileage, eventDate: patch.event_date, activityLog: patch.activity_log }
}

// restoreProject: archived/completed -> active. Clears the archive/complete markers and lands the
// project back in Inquiry. The desktop clears stage_id and re-derives to Inquiry on its next load; we
// set Inquiry directly so the phone is correct immediately even with the Mac off. Mirrors the supabase
// branch of crm-data-core.restoreProject.
export async function restoreProject(id) {
  if (!id) throw new Error('Project id is required.')
  const { data: cur, error: rErr } = await sb.from('projects').select('bucket,activity_log').eq('id', id).single()
  if (rErr) throw rErr
  if ((str(cur.bucket) || 'active') === 'active') throw new Error('Project is already active.')
  const existing = Array.isArray(cur.activity_log) ? cur.activity_log.map(String) : []
  const activity_log = [`${logDate()}: Project returned to the active pipeline.`, ...existing]
  // deleted_at is cleared too, so a project restored from the Deleted page does not carry a stale
  // delete stamp around. The desktop's restoreProject does the same (crm-data-core.mjs).
  const patch = { bucket: 'active', stage_id: ORPHAN_STAGE, archive_reason: null, completed_date: null, deleted_at: null, activity_log }
  const { error } = await sb.from('projects').update(patch).eq('id', id)
  if (error) throw error
  return { ok: true, id, bucket: 'active', stageId: ORPHAN_STAGE, activityLog: activity_log }
}

// deleteProject: permanent, no undo. Purges the project's overlay data (tasks / payments / mileage
// trips) then deletes the project row; contact_links rows cascade via their FK (ON DELETE CASCADE).
// Mirrors deleteProject + deletePaymentsForProject + deleteTripsForProject on the desktop.
// SOFT delete: move to the 'deleted' bucket, stamped, exactly like crm-data-core.deleteProject.
//
// ⚠️ This used to HARD delete (2026-08-05). It removed the project row outright and, worse, wiped its
// tasks, payments and mileage_trips first. So a mis-tap on a phone permanently destroyed financial
// records with no undo, while the same button on the Mac moved the project to a Deleted page it could
// be restored from for 30 days. Two buttons with the same label and wildly different consequences.
//
// Nothing is destroyed here beyond the bucket flip, so restoring is lossless. Permanent purge stays
// where it belongs: the desktop's explicit "Delete permanently" action, or the 30-day auto-sweep.
export async function deleteProject(id) {
  if (!id) throw new Error('Project id is required.')
  const { data: row, error: readErr } = await sb
    .from('projects')
    .select('bucket, activity_log')
    .eq('id', id)
    .maybeSingle()
  if (readErr) throw readErr
  if (!row) throw new Error('Project not found.')
  if (str(row.bucket) === 'deleted') return { ok: true, id, alreadyDeleted: true }

  const activity_log = [
    `${logDate()}: Project moved to Deleted.`,
    ...(Array.isArray(row.activity_log) ? row.activity_log.map(String) : []),
  ]
  const { error } = await sb
    .from('projects')
    .update({ bucket: 'deleted', stage_id: null, deleted_at: new Date().toISOString(), activity_log })
    .eq('id', id)
  if (error) throw error
  return { ok: true, id, to: 'deleted' }
}

// ---------- contact links ----------
//
// loadTemplates() used to live here. The `templates` table was DROPPED on 2026-07-31 when Michael
// removed email templates from the desktop, and because this load sat inside the Promise.all below,
// its error rejected the whole batch: the phone stopped showing ANY data at all, not just templates.
// That is what "my phone app isn't even loading" was.
//
// Lesson worth keeping: a single failed table read in loadEverything takes the entire app down. If a
// future slice becomes optional, give it its own catch rather than adding it to the batch.

// Per-project, per-step emails (the booking workflow's email cards). kind = the step (postcall,
// inquiry-response, followup-1, thankyou, ...); status = draft | sent. Body is HTML.
export async function loadEmails() {
  const { data, error } = await sb.from('emails').select('id,project_id,kind,to,subject,body,status,sent_at')
  if (error) throw error
  return (data || []).map((e) => ({
    id: str(e.id),
    projectId: str(e.project_id),
    kind: str(e.kind),
    to: Array.isArray(e.to) ? e.to.map(String) : [],
    subject: str(e.subject),
    body: str(e.body),
    status: str(e.status) || 'draft',
    sentAt: isoZ(e.sent_at),
  }))
}

// Send an email as Michael via the send-email Edge Function (cloud Gmail; works with the Mac off).
// supabase-js attaches the logged-in session JWT, which the function verifies. The function also flips
// the matching draft in `emails` to sent. Returns { ok, id, emailId, sentAt }.
// threadId replies inside that Gmail conversation; emailId completes one saved draft row (otherwise a
// new sent row is written, so a draft the Mac is still writing is never overwritten); html sends a
// formatted body; signature:false leaves the Settings signature off this one email.
export async function sendEmail({ to, subject, body, html, projectId, kind, threadId, emailId, signature } = {}) {
  const { data, error } = await sb.functions.invoke('send-email', { body: { to, subject, body, html, projectId, kind, threadId, emailId, signature } })
  if (error) {
    let msg = error.message || 'Could not send.'
    try { const j = await error.context.json(); if (j && j.error) msg = j.error } catch (_) { /* keep msg */ }
    throw new Error(msg)
  }
  if (data && data.ok === false) throw new Error(data.error || 'Could not send.')
  return data || {}
}

// ---------- proposals ----------
//
// Through an Edge Function, not a table read, and deliberately so. `proposals` has RLS on with no
// policy for `authenticated`, and `push_config` holds the admin preview key, which should never be
// on the device at all. The function computes the state, the outcome and the already-flagged
// preview URL with the service role and hands back something safe to render.
//
// ⚠️ `openUrl` is Michael's link and always carries preview=1 (plus the admin key when the page is
// no longer public). `url` is the CLEAN link, the one he sends a client. Never swap them: opening
// the clean one from inside the CRM would count as a client view and corrupt the only number that
// tells him whether anybody read his proposal.
export async function loadProposalsOverview() {
  const { data, error } = await sb.functions.invoke('proposals-overview', { body: {} })
  if (error) {
    let msg = error.message || 'Could not load proposals.'
    try { const j = await error.context.json(); if (j && j.error) msg = j.error } catch (_) { /* keep msg */ }
    throw new Error(msg)
  }
  if (data && data.ok === false) throw new Error(data.error || 'Could not load proposals.')
  return {
    items: Array.isArray(data?.items) ? data.items : [],
    bookings: Array.isArray(data?.bookings) ? data.bookings : [],
    samples: data?.samples || {},
  }
}

// ---------- reading Gmail, from the cloud ----------
//
// All three go through the `gmail` Edge Function, which holds the OAuth refresh token server-side
// and verifies the logged-in session JWT. Nothing about the mailbox is reachable from the phone
// without being signed in, and no Google credential ever reaches the device.
//
// This replaces nothing on the desktop: crm-gmail.mjs still serves the Mac. It EXISTS because that
// module is Node, loaded by the Vite dev plugin, so every read path in the CRM needed the laptop
// awake. Michael, 2026-09-21: "I want to read and send emails."

async function gmail(body) {
  const { data, error } = await sb.functions.invoke('gmail', { body })
  if (error) {
    let msg = error.message || 'Could not reach email.'
    try { const j = await error.context.json(); if (j && j.error) msg = j.error } catch (_) { /* keep msg */ }
    throw new Error(msg)
  }
  if (data && data.ok === false) throw new Error(data.error || 'Could not reach email.')
  return data || {}
}

// Thread summaries for a Gmail search. `q` is Gmail query syntax, passed straight through, and may
// be an ARRAY of queries when one will not fit (see buildClientMailQueries in app.js). Returns the
// merged, de-duplicated, newest-first list.
export async function gmailList({ q = 'in:inbox', max = 25 } = {}) {
  const r = await gmail({ action: 'list', q, max })
  return Array.isArray(r.threads) ? r.threads : []
}

// One conversation, with message bodies. Reading does NOT mark anything read; that is a separate,
// explicit call, so opening a thread to check who it is from cannot quietly clear the badge.
export async function gmailThread(threadId) {
  const r = await gmail({ action: 'thread', threadId })
  return { threadId, subject: r.subject || '(no subject)', messages: Array.isArray(r.messages) ? r.messages : [] }
}

export async function gmailMarkRead(threadId) {
  return gmail({ action: 'markRead', threadId })
}

// The unread inbox: the true count AND the threads, in ONE call.
//
// Both, because they feed two things that must not disagree: the drawer badge, and the "waiting on
// you" marks on the pipeline. Gmail's own resultSizeEstimate gives the real count even though only
// 25 threads are fetched, so the badge is right whether he has 3 unread or 300 while the payload
// stays small. Roughly 130 quota units per call against a 1.2M/day allowance, on a five-minute
// timer: about 37k a day, or 3% of the budget.
export async function gmailUnread(queries) {
  const q = Array.isArray(queries) && queries.length ? queries : 'is:unread in:inbox'
  const r = await gmail({ action: 'list', q, max: 25 })
  return { count: Number(r.resultSize) || 0, threads: Array.isArray(r.threads) ? r.threads : [] }
}

// Save (or update) a draft email for a project + step, directly in `emails` (status draft). Phone-side,
// so drafts are stored as plain text (format 'text'); the cloud send re-stores as HTML on send.
export async function saveEmailDraft({ projectId, kind, to, subject, body } = {}) {
  if (!projectId) throw new Error('Project id is required.')
  const toArr = Array.isArray(to) ? to : String(to || '').split(/[,;]/).map((s) => s.trim()).filter(Boolean)
  const nowIso = new Date().toISOString()
  const row = { project_id: projectId, kind: String(kind || 'custom'), to: toArr, subject: String(subject || ''), body: String(body || ''), format: 'text', status: 'draft', updated_at: nowIso }
  const { data: ex } = await sb.from('emails').select('id').eq('project_id', projectId).eq('kind', kind).neq('status', 'sent').order('updated_at', { ascending: false }).limit(1)
  if (ex && ex.length) {
    const { error } = await sb.from('emails').update(row).eq('id', ex[0].id)
    if (error) throw error
    return { id: ex[0].id, subject: row.subject, body: row.body, to: toArr }
  }
  const id = uuid()
  const { error } = await sb.from('emails').insert({ id, created_at: nowIso, ...row })
  if (error) throw error
  return { id, subject: row.subject, body: row.body, to: toArr }
}

// ---------- inquiries to review (the Mac bell's "Inquiries to review") ----------
// Every website inquiry not yet dismissed, newest first. Dismissing sets data.dismissed, exactly as
// the Mac's dismissNotification does, so clearing one on either device clears it on both.
export async function loadInquiryReview() {
  const { data, error } = await sb.from('inquiries').select('id,data')
  if (error) throw error
  return (data || []).filter((r) => r.data && !r.data.dismissed).map((r) => ({
    id: str(r.id), name: str(r.data.name), email: str(r.data.email), eventDate: str(r.data.eventDate), projectId: str(r.data.projectId),
    at: str(r.data.importedAt || r.data.submittedAt), note: str(r.data.note),
  })).sort((a, b) => b.at.localeCompare(a.at))
}
export async function dismissInquiryReview(id) {
  const { data: row, error: e1 } = await sb.from('inquiries').select('data').eq('id', id).maybeSingle()
  if (e1) throw e1
  if (!row) return
  const { error } = await sb.from('inquiries').update({ data: { ...(row.data || {}), dismissed: true } }).eq('id', id)
  if (error) throw error
}

// ---------- recurring tasks (task_schedules), a port of crm-task-schedules.mjs ----------
//
// Every recurrence is a ROW; one Postgres job (materialize_scheduled_tasks, every minute, Eastern
// time) creates the tasks. Never add a bespoke cron job. Same normalisation as the Mac, so a schedule
// saved from either device reads the same on both.
export const SCHEDULE_FREQUENCIES = ['daily', 'weekly', 'monthly']
export const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] // index 0 = ISO day 1
const schedHhmm = (v, fallback = '07:00') => {
  const m = String(v == null ? '' : v).trim().match(/^(\d{1,2}):(\d{1,2})$/)
  if (!m) return fallback
  const h = Number(m[1]), min = Number(m[2])
  if (h > 23 || min > 59) return fallback
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}
function schedFromRow(r) {
  return {
    id: str(r.id), title: str(r.title), projectId: str(r.project_id), frequency: str(r.frequency),
    daysOfWeek: Array.isArray(r.days_of_week) ? r.days_of_week.map(Number) : [],
    dayOfMonth: r.day_of_month == null ? null : Number(r.day_of_month),
    runTime: str(r.run_time), dueTime: str(r.due_time), active: !!r.active, lastCreatedOn: str(r.last_created_on), createdAt: str(r.created_at),
  }
}
function schedToRow(input) {
  const f = SCHEDULE_FREQUENCIES.includes(String(input.frequency || '').toLowerCase()) ? String(input.frequency).toLowerCase() : 'weekly'
  const dows = [...new Set((Array.isArray(input.daysOfWeek) ? input.daysOfWeek : []).map(Number).filter((n) => n >= 1 && n <= 7))].sort()
  const dom = Number(input.dayOfMonth)
  return {
    title: String(input.title || '').trim(),
    project_id: String(input.projectId || '').trim(),
    frequency: f,
    days_of_week: f === 'weekly' ? dows : [],
    day_of_month: f === 'monthly' ? (dom >= 1 && dom <= 31 ? dom : 1) : null,
    run_time: schedHhmm(input.runTime),
    due_time: String(input.dueTime || '').trim(),
    active: input.active === undefined ? true : !!input.active,
  }
}
export async function loadTaskSchedules() {
  const { data, error } = await sb.from('task_schedules').select('*').order('title')
  if (error) throw error
  return (data || []).map(schedFromRow)
}
export async function saveTaskSchedule(id, input) {
  let base = {}
  if (id) {
    const { data: cur, error: readErr } = await sb.from('task_schedules').select('*').eq('id', id).maybeSingle()
    if (readErr) throw readErr
    if (!cur) throw new Error('Schedule not found.')
    base = schedFromRow(cur)
  }
  const row = schedToRow({ ...base, ...input })
  if (!row.title) throw new Error('A title is required.')
  if (row.frequency === 'weekly' && !row.days_of_week.length) throw new Error('Pick at least one day of the week.')
  const q = id ? sb.from('task_schedules').update(row).eq('id', id) : sb.from('task_schedules').insert(row)
  const { data, error } = await q.select('*').single()
  if (error) throw error
  return schedFromRow(data)
}
// Stops FUTURE tasks only; the tasks it already created stay on the list.
export async function deleteTaskSchedule(id) {
  const { error } = await sb.from('task_schedules').delete().eq('id', id)
  if (error) throw error
}
export function describeSchedule(s) {
  const [h, m] = String(s.runTime || '07:00').split(':').map(Number)
  const time = `${h % 12 === 0 ? 12 : h % 12}:${String(m || 0).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
  if (s.frequency === 'daily') return `Every day at ${time}`
  if (s.frequency === 'monthly') {
    const d = s.dayOfMonth ?? 1
    const suffix = d % 10 === 1 && d !== 11 ? 'st' : d % 10 === 2 && d !== 12 ? 'nd' : d % 10 === 3 && d !== 13 ? 'rd' : 'th'
    return `Monthly on the ${d}${suffix} at ${time}`
  }
  const days = [...s.daysOfWeek].sort().map((n) => DAY_LABELS[n - 1]).join(', ')
  return `Every ${days || '(no day set)'} at ${time}`
}

// ---------- the composer's drafts and attachments (Mac parity, 2026-10-23) ----------
//
// A draft is an `emails` row with status 'draft', kind 'custom', HTML body: exactly what the Mac's
// "New email" composer autosaves, so a draft started on either device opens on the other. Saved BY ID,
// never by "the latest draft of this kind", so two drafts can never overwrite each other.
export async function saveComposeDraft({ id, projectId, to, subject, html, threadId, threadSubject, attachments } = {}) {
  if (!projectId) throw new Error('Project id is required.')
  const toArr = Array.isArray(to) ? to : String(to || '').split(/[,;]/).map((s) => s.trim()).filter(Boolean)
  const nowIso = new Date().toISOString()
  const row = {
    project_id: projectId, kind: 'custom', to: toArr, subject: String(subject || '') || '(no subject)', body: String(html || ''), format: 'html',
    status: 'draft', updated_at: nowIso, thread_id: threadId || '', thread_subject: threadSubject || '',
    attachments: (attachments || []).map((a) => ({ source: 'cloud', name: a.name, id: a.path, size: a.size || undefined })),
  }
  if (id) {
    const { error } = await sb.from('emails').update(row).eq('id', id).neq('status', 'sent')
    if (error) throw error
    return id
  }
  const newId = uuid()
  const { error } = await sb.from('emails').insert({ id: newId, created_at: nowIso, ...row })
  if (error) throw error
  return newId
}
// Only ever a DRAFT: the status guard means a sent receipt can never be removed from here.
export async function deleteDraft(id) {
  if (!id) return
  const { error } = await sb.from('emails').delete().eq('id', id).eq('status', 'draft')
  if (error) throw error
}
export async function loadProjectDrafts(projectId) {
  const { data, error } = await sb.from('emails').select('id,project_id,kind,to,subject,body,format,status,thread_id,thread_subject,attachments,updated_at')
    .eq('project_id', projectId).eq('status', 'draft').order('updated_at', { ascending: false })
  if (error) throw error
  return (data || []).map((e) => ({
    id: str(e.id), projectId: str(e.project_id), kind: str(e.kind), to: Array.isArray(e.to) ? e.to.map(String) : [],
    subject: str(e.subject), body: str(e.body), format: str(e.format) || 'text', threadId: str(e.thread_id), threadSubject: str(e.thread_subject),
    attachments: (Array.isArray(e.attachments) ? e.attachments : []).filter((a) => a && a.source === 'cloud' && a.id).map((a) => ({ name: str(a.name), path: str(a.id), size: Number(a.size) || 0 })),
    updatedAt: str(e.updated_at),
  }))
}
// A one-off attachment picked from the phone. Kept apart from the Files library, under its own folder.
export async function uploadEmailAttachment(file) {
  const name = String(file.name || 'file').replace(/[\\/]/g, '-')
  const path = 'email-attachments/' + uuid() + '/' + name
  const { error } = await sb.storage.from('crm-files').upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false })
  if (error) throw error
  return { name, path, size: file.size || 0, type: file.type || '' }
}

// Contact links: { [projectId]: [contactId, ...] }. Powers "linked projects" on a contact and
// contacts-on-a-project. Mirrors crm-links.
//
// ORDER MATTERS: position 0 is the primary contact, the person the contract and invoice are
// addressed to. The table had no ordering column until 2026-08-06, so "the first contact" was
// whatever order Postgres felt like returning and could change on any write. contact_id is the
// tiebreak so the result is fully deterministic.
export async function loadLinks() {
  const { data, error } = await sb
    .from('contact_links')
    .select('project_id,contact_id,position')
    .order('position', { ascending: true })
    .order('contact_id', { ascending: true })
  if (error) throw error
  const links = {}
  ;(data || []).forEach((r) => {
    const p = str(r.project_id)
    ;(links[p] = links[p] || []).push(str(r.contact_id))
  })
  return links
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


// ============================================================================
// PARITY WITH THE MAC (2026-10-23). Michael: "I want there to be no gaps between the two apps."
// Each function below is the phone's version of one Mac endpoint in crm-data-plugin.mjs, writing the
// same rows the same way, so the Mac picks the change up on its next data_version poll.
// ============================================================================

// The phone's server-side half (supabase/functions/phone-api). Everything that needs a secret the
// phone must never hold: QuickBooks, Google Calendar, calendar-alert status.
export async function phoneApi(action, body = {}) {
  const { data, error } = await sb.functions.invoke('phone-api', { body: { action, ...body } })
  if (error) {
    let msg = error.message || 'phone-api failed'
    try { const j = await error.context.json(); if (j && j.error) msg = j.error } catch (_) { /* keep msg */ }
    throw new Error(msg)
  }
  if (data && data.ok === false && data.error) throw new Error(data.error)
  return data
}

// crm_config is ONE row of settings that the Mac also writes (goals, signature, field labels, tags,
// archive reasons...). A blind write of a partial object would wipe everything else in it, so every
// change reads the current row and merges, exactly like the Mac's saveConfig.
export async function saveConfigPatch(patch = {}) {
  const { data, error } = await sb.from('crm_config').select('id,data').eq('id', 1).single()
  if (error) throw error
  const merged = { ...((data && data.data) || {}), ...patch }
  const { error: e2 } = await sb.from('crm_config').update({ data: merged }).eq('id', 1)
  if (e2) throw e2
  return merged
}
export async function loadRawConfig() {
  const { data, error } = await sb.from('crm_config').select('data').eq('id', 1).single()
  if (error) throw error
  return (data && data.data) || {}
}

// ---------- QuickBooks months + bank balances (cached like the Mac: 15 minutes) ----------
const FIFTEEN_MIN = 15 * 60 * 1000
let qboCache = { at: 0, data: null }
export async function loadQuickBooksMonths(force = false) {
  if (!force && qboCache.data && Date.now() - qboCache.at < FIFTEEN_MIN) return qboCache.data
  let data
  try { data = await phoneApi('finance-qbo') } catch (e) { data = { ok: false, connected: false, reason: String(e && e.message || e) } }
  qboCache = { at: Date.now(), data }
  return data
}
let bankCache = { at: 0, data: null }
export async function loadBankBalances(force = false) {
  if (!force && bankCache.data && Date.now() - bankCache.at < FIFTEEN_MIN) return bankCache.data
  let data
  try {
    const r = await sb.functions.invoke('bank-balances', { body: {} })
    if (r.error) throw r.error
    data = r.data
  } catch (e) {
    data = { ok: false, connected: false, accounts: [], generatedAt: '', reason: String(e && e.message || e) }
  }
  bankCache = { at: Date.now(), data }
  return data
}

// ---------- payments ----------
export async function deletePayment(id) {
  const { error } = await sb.from('payments').delete().eq('id', id)
  if (error) throw error
  return { ok: true }
}

// ---------- recurring business expenses (the Mac's Expenses tab) ----------
export const EXPENSE_CADENCES = ['monthly', 'quarterly', 'yearly', 'weekly', 'one-time']
function expenseFromRow(r) {
  return { id: str(r.id), name: str(r.name), amount: amountOf({ amount: r.amount, amount_text: r.amount_text }), cadence: str(r.cadence) || 'monthly',
    category: str(r.category), note: str(r.note), createdAt: isoZ(r.created_at) }
}
export async function loadExpenses() {
  const { data, error } = await sb.from('expenses').select('*')
  if (error) throw error
  return (data || []).map(expenseFromRow).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
}
export async function addExpense({ name, amount, cadence, category } = {}) {
  const n = Number(String(amount == null ? '' : amount).replace(/[^0-9.\-]/g, ''))
  const row = { id: uuid(), name: String(name || 'Expense'), amount: Number.isFinite(n) ? n : null, amount_text: Number.isFinite(n) ? null : String(amount),
    cadence: EXPENSE_CADENCES.includes(cadence) ? cadence : 'monthly', category: String(category || ''), note: '', created_at: new Date().toISOString() }
  const { error } = await sb.from('expenses').insert(row)
  if (error) throw error
  return expenseFromRow(row)
}
export async function deleteExpense(id) {
  const { error } = await sb.from('expenses').delete().eq('id', id)
  if (error) throw error
}

// ---------- mileage (the Mac's Mileage tab) ----------
function tripFromRow(r) {
  return { id: str(r.id), date: str(r.date), miles: amountOf({ amount: r.miles, amount_text: r.miles_text }), purpose: str(r.purpose),
    projectId: str(r.project_id), createdAt: isoZ(r.created_at) }
}
export async function loadMileage() {
  const [t, s] = await Promise.all([
    sb.from('mileage_trips').select('*'),
    sb.from('crm_settings').select('mileage_rate_per_mile').eq('id', 1).maybeSingle(),
  ])
  if (t.error) throw t.error
  const rate = s.data && Number(s.data.mileage_rate_per_mile) > 0 ? Number(s.data.mileage_rate_per_mile) : 0.7
  return { trips: (t.data || []).map(tripFromRow), rate }
}
export async function addTrip({ date, miles, purpose, projectId } = {}) {
  const n = Number(String(miles == null ? '' : miles).replace(/[^0-9.\-]/g, ''))
  const row = { id: uuid(), date: String(date || ''), miles: Number.isFinite(n) ? n : null, miles_text: Number.isFinite(n) ? null : String(miles),
    purpose: String(purpose || ''), project_id: String(projectId || ''), created_at: new Date().toISOString() }
  const { error } = await sb.from('mileage_trips').insert(row)
  if (error) throw error
  return tripFromRow(row)
}
export async function deleteTrip(id) {
  const { error } = await sb.from('mileage_trips').delete().eq('id', id)
  if (error) throw error
}
export async function setMileageRate(rate) {
  const r = Number(rate) > 0 ? Number(rate) : 0.7
  const { error } = await sb.from('crm_settings').upsert({ id: 1, mileage_rate_per_mile: r }, { onConflict: 'id' })
  if (error) throw error
  return r
}


// Live website analytics: the same website-analytics function the Mac's Website page reads (GA4 +
// Search Console). Cached for a minute, as the Mac does.
let analyticsCache = { at: 0, data: null }
export async function loadAnalytics(force = false) {
  if (!force && analyticsCache.data && Date.now() - analyticsCache.at < 60 * 1000) return analyticsCache.data
  const { data, error } = await sb.functions.invoke('website-analytics', { body: {} })
  if (error) throw error
  analyticsCache = { at: Date.now(), data }
  return data
}


// Calendar-alert settings: the one row the calendar-alerts function reads (id 1). RLS lets the phone
// read and write it; the status row beside it is service-only and comes through phone-api.
export async function sbCalendarAlertSettings() {
  const { data, error } = await sb.from('calendar_alert_settings').select('*').eq('id', 1).maybeSingle()
  if (error) throw error
  return data || { id: 1, new_event_enabled: true, new_event_kinds: ['booking', 'invite'], digest_enabled: false, digest_time: '07:00', digest_days: [1, 2, 3, 4, 5, 6, 7], digest_calendars: ['Work'], soon_enabled: false, soon_minutes: 15, soon_skip_free: true }
}
export async function saveCalendarAlertSettings(patch = {}) {
  const cur = await sbCalendarAlertSettings()
  const row = { ...cur, ...patch, id: 1, updated_at: new Date().toISOString() }
  const { error } = await sb.from('calendar_alert_settings').upsert(row, { onConflict: 'id' })
  if (error) throw error
  return row
}


// ---------- Files (the Mac's Files page, in the private crm-files Storage bucket) ----------
export async function listFiles() {
  const { data, error } = await sb.storage.from('crm-files').list('', { limit: 500, sortBy: { column: 'name', order: 'asc' } })
  if (error) throw error
  // A folder comes back with id null. The only folder is email-attachments/ (one-off uploads from the
  // composer), which is not part of the Files library.
  return (data || []).filter((f) => f.name && f.id && !f.name.startsWith('.')).map((f) => ({
    name: f.name, size: (f.metadata && f.metadata.size) || 0, updatedAt: f.updated_at || f.created_at || '', type: (f.metadata && f.metadata.mimetype) || '',
  }))
}
export async function fileUrl(name) {
  const { data, error } = await sb.storage.from('crm-files').createSignedUrl(name, 60 * 60)
  if (error) throw error
  return data.signedUrl
}
export async function uploadFile(file) {
  const name = String(file.name || 'file').replace(/[\\/]/g, '-')
  const { error } = await sb.storage.from('crm-files').upload(name, file, { contentType: file.type || 'application/octet-stream', upsert: true })
  if (error) throw error
  return name
}
export async function deleteFile(name) {
  const { error } = await sb.storage.from('crm-files').remove([name])
  if (error) throw error
}


// The website form behind a project, from the inquiries table (the Mac's inquiryFormForProject).
const INQUIRY_LABELS = [['name', 'Name'], ['email', 'Email'], ['phone', 'Phone'], ['eventDate', 'Event date'], ['eventTime', 'Event time'], ['venue', 'Venue / location'],
  ['guests', 'Guest count'], ['ages', 'Guest ages'], ['showTypes', 'Performance interest'], ['source', 'How they heard'], ['message', 'Message']]
export async function loadInquiryForm(projectId) {
  const { data, error } = await sb.from('inquiries').select('data').eq('data->>projectId', projectId)
  if (error) throw error
  let rec = null
  for (const r of data || []) { const v = r.data || {}; if (v.form && (!rec || String(v.importedAt || '') > String(rec.importedAt || ''))) rec = v }
  if (!rec) return null
  const fields = INQUIRY_LABELS.map(([k, label]) => ({ key: k, label, value: Array.isArray(rec.form[k]) ? rec.form[k].join(', ') : rec.form[k] })).filter((x) => x.value)
  return { submittedAt: rec.form.submittedAt || rec.importedAt || '', formLocation: rec.form.formLocation || '', fields }
}
// The QuickBooks invoice record a booking produced (invoices.data), for the Booking card's invoice line.
export async function loadInvoice(projectId) {
  const { data, error } = await sb.from('invoices').select('data').eq('project_id', projectId).maybeSingle()
  if (error) throw error
  return (data && data.data) || null
}


// A standalone contact (the Contacts page's "New contact"), and deleting one. Deleting removes its
// project links with it (contact_links cascades), the same as the Mac.
export async function createContact({ name, email, phone, type } = {}) {
  const now = new Date().toISOString()
  const row = { id: uuid(), name: String(name || 'New contact'), emails: email ? [String(email)] : [], phones: phone ? [formatPhoneField(String(phone))] : [],
    type: ['client', 'vendor', 'associate', 'other'].includes(type) ? type : 'client', relationship: '', engagement: '', tags: [], notes: '', created_at: now, updated_at: now }
  const { error } = await sb.from('contacts').insert(row)
  if (error) throw error
  return row
}
export async function deleteContact(id) {
  const { error } = await sb.from('contacts').delete().eq('id', id)
  if (error) throw error
}


// One project's activity log, re-read after a server-side action wrote a line to it.
export async function reloadProjectLog(projectId) {
  const { data, error } = await sb.from('projects').select('activity_log').eq('id', projectId).maybeSingle()
  if (error) throw error
  return data && Array.isArray(data.activity_log) ? data.activity_log.map(String) : null
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
  // Record the sentinel BEFORE loading: a write landing mid-load leaves v ahead of what we
  // saw, so the next background poll reloads again rather than missing it.
  await noteDataVersionLoaded()
  const [projects, structure, tasks, config, contacts, links, paymentsRaw] = await Promise.all([
    loadProjects(),
    loadStructure(),
    loadTasks(),
    loadConfig(),
    loadContacts(),
    loadLinks(),
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
    links,
    customFields: config.customFields,
    customValues: {}, // custom values are desktop-file-only; the phone has none
    eventFieldLabels: config.eventFieldLabels,
    eventFieldHidden: config.eventFieldHidden,
    eventFieldDeleted: config.eventFieldDeleted,
  }
}

// ---------- issuing a booking form (the phone's "Ready to book") ----------
//
// The desktop builds the agreement with JSDOM, which the phone obviously cannot do. So the Mac
// publishes each contract VARIANT to `contract_templates` as rendered HTML with the `data-f` field
// markers still unfilled, and the phone fills in this project's own numbers here. The actual
// contract wording therefore still exists in exactly one place (the Node template); only the
// substitution is repeated, which is a few lines of string work rather than a legal document.
//
// ⚠️ The five fields below mirror FIELD_DEFS in crm-contract-template.mjs. Anything the CLIENT
// supplies (event date, address, times) is deliberately left unfilled: the `booking` edge function
// fills those from their answers when they open the form.

const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

function contractDateToday() {
  const d = new Date()
  return `${MONTHS_LONG[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`
}
function contractMoney(n) {
  const v = Number(n)
  if (!v || Number.isNaN(v)) return ''
  return '$' + Math.round(v).toLocaleString('en-US')
}
function escapeContractHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
// Swap the contents of <span ... data-f="KEY" ...>…</span>. Same shape the edge functions use.
function fillContractMarker(html, key, value) {
  const re = new RegExp(`<span[^>]*data-f="${key}"[^>]*>[^<]*</span>`, 'g')
  const out = `<span class="cf" data-f="${key}">${escapeContractHtml(value)}</span>`
  return html.replace(re, () => out)
}

// Which agreements can be sent. Published by the Mac; read-only to the phone.
export async function loadContractVariants() {
  const { data, error } = await sb.from('contract_templates').select('variant,label,hint,html').order('sort')
  if (error) throw error
  return data || []
}

// Issue this project's booking form: pick the agreement, fill in the internal numbers, stamp the
// token, and hand back the link for Michael to send however he likes.
//
// Deliberately does NOT send an email. The phone has no Gmail drafting, and he said he doesn't want
// it to; this returns the URL so he can text or mail it himself.
export async function readyToBookOnPhone(project, variantId) {
  const style = String(project.performanceStyle || '').trim()
  const fee = Number(project.totalFee)
  const missing = []
  if (!style) missing.push('performance style')
  if (!fee || Number.isNaN(fee) || fee <= 0) missing.push('quote')
  // The date is never asked on the form, so a blank one reaches the client as "Date: [Event date]".
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(project.eventDate || '').trim())) missing.push('event date')
  if (missing.length) {
    throw new Error(`Set the ${missing.join(', ')} first. The client reads all of it on the agreement.`)
  }

  const variants = await loadContractVariants()
  const chosen = variants.find((v) => v.variant === variantId) || variants[0]
  if (!chosen) throw new Error('No contract templates have been published yet. Open the Mac app once.')

  let html = chosen.html
  html = fillContractMarker(html, 'contract_date', contractDateToday())
  html = fillContractMarker(html, 'client_name', String(project.client || ''))
  html = fillContractMarker(html, 'client_email', String(project.contactEmails || '').split(/[,;]/)[0].trim())
  html = fillContractMarker(html, 'client_phone', String(project.contactPhones || '').split(/[,;]/)[0].trim())
  html = fillContractMarker(html, 'booking_fee', contractMoney(fee))
  html = fillContractMarker(html, 'services_description', style)

  // Reuse an existing token so a link already in a client's inbox keeps working.
  const { data: row } = await sb.from('projects').select('booking_token').eq('id', project.id).maybeSingle()
  let token = String(row?.booking_token || '')
  if (!token) {
    const bytes = new Uint8Array(18)
    crypto.getRandomValues(bytes)
    token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }

  const { error } = await sb
    .from('projects')
    .update({ booking_token: token, agreement_html: html, agreement_variant: chosen.variant, booking_sent_at: new Date().toISOString() })
    .eq('id', project.id)
  if (error) throw error

  return { url: `https://michaelbloemeke.com/book/?t=${token}`, variant: chosen.variant, label: chosen.label }
}

// How far the client has got, read live. Mirrors liveProgress() on the desktop.
export async function loadBookingProgress(projectId) {
  const [{ data: proj }, { data: row }] = await Promise.all([
    sb.from('projects').select('booking_viewed_at, agreement_variant, booking_token, booking_sent_at').eq('id', projectId).maybeSingle(),
    sb.from('booking_submissions').select('submitted_at, signed_at, signed_name, answers, complete_error').eq('project_id', projectId).maybeSingle(),
  ])
  const viewedAt = proj?.booking_viewed_at || ''
  const submittedAt = row?.submitted_at || ''
  const signedAt = row?.signed_at || ''
  return {
    stage: signedAt ? 'signed' : submittedAt ? 'submitted' : viewedAt ? 'viewed' : 'none',
    viewedAt, submittedAt, signedAt,
    signedName: row?.signed_name || '',
    variant: proj?.agreement_variant || '',
    linkOut: !!proj?.booking_token,
    token: proj?.booking_token || '',
    sentAt: proj?.booking_sent_at || '',
    completeError: row?.complete_error || '',
    // What the client actually TYPED on the booking form, verbatim, as [{id, value}].
    //
    // Michael, 2026-09-21: "I need to be able to see the PDF of their completed booking form...
    // so I can see what they entered and so that I can especially see the address of the event."
    // The answers are already a column here, so reading them costs nothing extra and gives the
    // phone something better than a PDF: selectable, tappable text. The agreement PDF stays too,
    // because that is the DOCUMENT, and these are the ANSWERS. Two different questions.
    answers: Array.isArray(row?.answers) ? row.answers : [],
  }
}

// ---------- the agreement PDF, for previewing on the phone ----------
//
// Fetched from the CLOUD renderer, the same one that produced the copy the client received, so what
// Michael looks at on his phone is the document that was actually signed rather than a lookalike.
// An <iframe src> can't carry an Authorization header, so this pulls the bytes with the logged-in
// session and hands back a blob URL for the viewer to point at.
export async function agreementPdfUrl(projectId) {
  const { data } = await sb.auth.getSession()
  const token = data?.session?.access_token
  if (!token) throw new Error('Not signed in.')
  const res = await fetch(`${SUPABASE_URL}/functions/v1/booking-complete?projectId=${encodeURIComponent(projectId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    let msg = `The agreement could not be built (${res.status}).`
    try { msg = (await res.json())?.error || msg } catch (_) { /* not json */ }
    throw new Error(msg)
  }
  const blob = await res.blob()
  return URL.createObjectURL(blob)
}

// Wipe a previous booking attempt so a resend starts clean. Mirrors resetBooking() on the desktop:
// the timestamps, the signature and the CRM's invoice record all go; the TOKEN stays so a link
// already in the client's inbox still resolves and now serves the corrected agreement.
export async function resetBookingOnPhone(projectId) {
  await sb.from('booking_submissions').delete().eq('project_id', projectId)
  await sb.from('invoices').delete().eq('project_id', projectId)
  const { error } = await sb.from('projects').update({ booking_viewed_at: null }).eq('id', projectId)
  if (error) throw error
}

// saveNativePushToken: the NATIVE (iOS/APNs) counterpart of savePushSubscription above.
//
// iOS hands the app a device token, not a Web Push subscription, so there is no endpoint URL to key
// on. Rather than add a second table and a second fan-out path on the server, the token is stored in
// the SAME push_subscriptions table under a synthetic `apns://<token>` endpoint.
//
// WHY THAT IS WORTH DOING RATHER THAN A CLEAN SEPARATE TABLE:
//   - Every sender (notify-cron, inquiry, and anything added later) already walks this one table.
//     They branch on the endpoint scheme and pick APNs or Web Push. Nothing has to learn about a
//     second source of devices, so a new notification type cannot accidentally support only one.
//   - The PWA and the native app can be registered AT THE SAME TIME while the native build is
//     proven out. Michael keeps getting notifications on the old route until he decides to drop it.
//
// `endpoint` is unique, so re-registering the same device refreshes its row instead of piling up.
// RLS requires a logged-in session, exactly like the web path.
export async function saveNativePushToken(token) {
  const value = String(token || '').trim()
  if (!value) throw new Error('No device token from iOS.')
  const row = {
    endpoint: `apns://${value}`,
    subscription: { kind: 'apns', token: value, platform: 'ios' },
    user_agent: (typeof navigator !== 'undefined' && navigator.userAgent) || 'ios-native',
  }
  const { error } = await sb.from('push_subscriptions').upsert(row, { onConflict: 'endpoint' })
  if (error) throw error

  // Drop any OTHER apns:// row. There is exactly one iPhone, so a second Apple token is always a
  // dead one left behind by a token rotation, and every sender in the system walks this table and
  // would keep posting to it forever. APNs answers a dead token with BadDeviceToken rather than an
  // error anybody sees, so nothing would ever have cleaned them up.
  //
  // Web Push rows are deliberately untouched: the PWA and the native app are allowed to be
  // registered at the same time while the native build is being proven out.
  const { error: sweepErr } = await sb
    .from('push_subscriptions')
    .delete()
    .like('endpoint', 'apns://%')
    .neq('endpoint', row.endpoint)
  if (sweepErr) console.warn('[push] could not clear an old Apple token:', sweepErr.message)

  return { ok: true, endpoint: row.endpoint }
}
