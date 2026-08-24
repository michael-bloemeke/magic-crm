// Recurring tasks, as DATA rather than a hand-written cron job.
//
// Michael, 2026-08-23: "I don't like the idea of things not being transparent... something that
// appears every week without any way for me to adjust it or change it or even see that it exists
// outside using Claude." So every recurrence is a row in `task_schedules` that he can see, edit,
// pause or delete in the CRM, and ONE Postgres job (materialize_scheduled_tasks, every minute)
// creates the tasks. Adding a schedule never means touching cron again.
//
// The firing logic lives in SQL on purpose: it must run whether or not the laptop is open, exactly
// like the booking sweep. Everything is evaluated in America/New_York, never UTC, because 7am
// Eastern is a different UTC hour in summer and winter.

import { sb } from './crm-store.mjs'
import { addTask } from './crm-data-core.mjs'

export const FREQUENCIES = ['daily', 'weekly', 'monthly']
export const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] // index 0 = ISO day 1

const str = (v) => (v == null ? '' : String(v))
const clean = (v) => str(v).trim()
// 'HH:MM' 24h, or a safe default. A malformed time would simply never match and the schedule would
// silently never fire, which is worse than being corrected.
const hhmm = (v, fallback = '07:00') => {
  // Accepts 9:5, 9:05, 09:05 and normalises to 09:05. The UI sends a real <input type="time"> value,
  // but a sloppy single-digit minute over the API used to fall through to the fallback, silently
  // turning "9:05" into "07:00". A schedule quietly firing at the wrong time is worse than one that
  // refuses to save.
  const m = clean(v).match(/^(\d{1,2}):(\d{1,2})$/)
  if (!m) return fallback
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return fallback
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}
const freq = (v) => (FREQUENCIES.includes(clean(v).toLowerCase()) ? clean(v).toLowerCase() : 'weekly')
const dows = (v) => {
  const arr = Array.isArray(v) ? v : []
  return [...new Set(arr.map((n) => Number(n)).filter((n) => n >= 1 && n <= 7))].sort()
}
const dom = (v) => {
  const n = Number(v)
  return n >= 1 && n <= 31 ? n : null
}

function fromRow(r) {
  return {
    id: str(r.id),
    title: str(r.title),
    projectId: str(r.project_id),
    frequency: str(r.frequency),
    daysOfWeek: Array.isArray(r.days_of_week) ? r.days_of_week.map(Number) : [],
    dayOfMonth: r.day_of_month == null ? null : Number(r.day_of_month),
    runTime: str(r.run_time),
    dueTime: str(r.due_time),
    active: !!r.active,
    lastCreatedOn: str(r.last_created_on),
    createdAt: str(r.created_at),
  }
}

function toRow(input) {
  const f = freq(input.frequency)
  return {
    title: clean(input.title),
    project_id: clean(input.projectId),
    frequency: f,
    // Only the field the chosen frequency actually uses is stored, so a schedule switched from
    // weekly to monthly cannot keep firing on a stale weekday.
    days_of_week: f === 'weekly' ? dows(input.daysOfWeek) : [],
    day_of_month: f === 'monthly' ? (dom(input.dayOfMonth) ?? 1) : null,
    run_time: hhmm(input.runTime),
    due_time: clean(input.dueTime),
    active: input.active === undefined ? true : !!input.active,
  }
}

export async function loadTaskSchedules() {
  const { data, error } = await sb().from('task_schedules').select('*').order('title')
  if (error) throw error
  return (data || []).map(fromRow)
}

export async function addTaskSchedule(input = {}) {
  const row = toRow(input)
  if (!row.title) throw new Error('A title is required.')
  if (row.frequency === 'weekly' && row.days_of_week.length === 0) {
    throw new Error('Pick at least one day of the week.')
  }
  const { data, error } = await sb().from('task_schedules').insert(row).select('*').single()
  if (error) throw error
  return fromRow(data)
}

export async function updateTaskSchedule(id, patch = {}) {
  if (!id) throw new Error('Schedule id is required.')
  const { data: cur, error: readErr } = await sb().from('task_schedules').select('*').eq('id', id).maybeSingle()
  if (readErr) throw readErr
  if (!cur) throw new Error('Schedule not found.')
  const merged = toRow({ ...fromRow(cur), ...patch })
  if (!merged.title) throw new Error('A title is required.')
  if (merged.frequency === 'weekly' && merged.days_of_week.length === 0) {
    throw new Error('Pick at least one day of the week.')
  }
  merged.updated_at = new Date().toISOString()
  const { data, error } = await sb().from('task_schedules').update(merged).eq('id', id).select('*').single()
  if (error) throw error
  return fromRow(data)
}

// Deleting a schedule stops FUTURE tasks. Tasks it already created are real tasks and are left
// alone, so removing a recurrence never silently clears work he still owes.
export async function deleteTaskSchedule(id) {
  if (!id) throw new Error('Schedule id is required.')
  const { error } = await sb().from('task_schedules').delete().eq('id', id)
  if (error) throw error
  return { ok: true, id }
}

// Create this schedule's task right now, ignoring the clock. For "I want that one today" without
// waiting a week, and it doubles as a way to check a schedule does what he expects.
export async function runTaskScheduleNow(id) {
  if (!id) throw new Error('Schedule id is required.')
  const { data: row, error: readErr } = await sb().from('task_schedules').select('*').eq('id', id).maybeSingle()
  if (readErr) throw readErr
  if (!row) throw new Error('Schedule not found.')
  const s = fromRow(row)

  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())

  const { data: existing } = await sb()
    .from('tasks').select('id').eq('title', s.title).eq('due_date', today).limit(1)
  if (existing && existing.length) return { ok: true, skipped: 'already exists today' }

  // Go through the app's own addTask, NOT a raw insert. The Mac keeps tasks in an in-memory cache
  // and writing straight to Supabase leaves that cache stale, so the new task does not appear until
  // something else happens to refresh it. Caught in testing: the row was in the database and the
  // task list still did not show it.
  await addTask({ projectId: s.projectId || '', title: s.title, dueDate: today, dueTime: s.dueTime || '' })

  // Stamp it so the scheduled run does not add a second copy later the same day.
  await sb().from('task_schedules').update({ last_created_on: today }).eq('id', id)
  return { ok: true, created: true, dueDate: today }
}
