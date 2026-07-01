// Google Calendar sync for the CRM.
//
// Reuses the single Google connection (crm-gmail.mjs shares the OAuth client + gmail-token.json,
// which now carries the calendar scope). One-way push, CRM -> Calendar: the CRM owns the events and
// maps each project/task to a Google event id in Project Records/crm-calendar-map.json. Gigs/projects
// go on the "Gigs" calendar; tasks on "Work". Nothing is pushed until Michael connects and a sync
// runs (auto after edits, or the manual "Sync now").
//
// - A gig is a TIMED block starting at its arrival time (falling back to event start, then show
//   start), 2h long by default; if no time parses it becomes an all-day event. It carries the
//   location + the times + basic details, and is prefixed "Inquiry: " until the project is booked.
// - A task is all-day when it has no time, or timed (with 10-min + at-time reminders) when it does.
//   The CRM's own due reminders stay date-based regardless; these are just the calendar's reminders.

import fs from 'node:fs'
import path from 'node:path'
import { google } from 'googleapis'
import { authedClient, isConnected, hasCalendarScope } from './crm-gmail.mjs'
import { RECORDS_DIR, loadAll, loadTasks, isProjectBooked } from './crm-data-core.mjs'

const MAP_FILE = path.join(RECORDS_DIR, 'crm-calendar-map.json')
const TIMEZONE = 'America/New_York' // Michael is in Durham, NC
const GIGS_CALENDAR = 'Gigs'
const WORK_CALENDAR = 'Work'
const GIG_DEFAULT_DURATION_MIN = 120 // a gig with a start time blocks 2h by default
const TASK_DURATION_MIN = 30 // a timed task blocks 30 min

// ---- Connection -------------------------------------------------------------

export function isCalendarConnected() {
  return isConnected() && hasCalendarScope()
}
function api() {
  return google.calendar({ version: 'v3', auth: authedClient() })
}

// ---- The event-id map (crm-calendar-map.json) -------------------------------

function readMap() {
  try {
    const d = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'))
    if (d && typeof d === 'object') {
      d.calendars = d.calendars || {}
      d.projects = d.projects || {}
      d.tasks = d.tasks || {}
      return d
    }
  } catch {
    // missing/corrupt -> fresh
  }
  return { calendars: {}, projects: {}, tasks: {} }
}
function writeMap(map) {
  try {
    map._meta = {
      file: 'crm-calendar-map.json',
      owner: 'Magic CRM app (~/Desktop/Claude/magic-crm)',
      purpose:
        'Maps CRM projects/tasks to the Google Calendar event ids the CRM created for them, plus the resolved ids of the "Gigs" and "Work" calendars. Lets the CRM update/remove the right events. Safe to delete to force a fresh re-sync (a new sync re-creates events, which may duplicate any left behind).',
    }
    fs.writeFileSync(MAP_FILE, JSON.stringify(map, null, 2) + '\n')
  } catch (e) {
    console.error('[crm-calendar] could not write crm-calendar-map.json:', e?.message || e)
  }
}

// Calendar ids by name, cached in-memory for THIS server session only (never persisted). So a
// deleted/recreated "Gigs" or "Work" calendar self-heals: the cache clears on restart, calendarStatus
// re-lists to refresh it, and a stale-id operation error also clears it (see upsertEvent).
const calIdCache = new Map()

// Fresh lookup: list the account's calendars, match by exact name, and update the cache (positive or
// negative). Used by calendarStatus so the Settings view always reflects reality.
async function listCalendarId(cal, name) {
  const res = await cal.calendarList.list({ maxResults: 250 })
  const found = (res.data.items || []).find((c) => (c.summary || '').trim().toLowerCase() === name.toLowerCase())
  const id = found ? found.id : null
  if (id) calIdCache.set(name, id)
  else calIdCache.delete(name)
  return id
}
// Cached lookup for the sync hot path; lists once when the name isn't cached yet. Returns null when
// there is no such calendar in the account.
async function resolveCalendarId(cal, name) {
  return calIdCache.has(name) ? calIdCache.get(name) : listCalendarId(cal, name)
}

// ---- Date / time helpers ----------------------------------------------------

// Parse a free-text time ("6:00 PM", "6pm", "18:00", "6", "6:30") into {h, m} (24h), or null. Also
// handles the strict "HH:MM" a task's time input produces.
function parseTime(raw) {
  const s = String(raw || '').trim().toLowerCase()
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/)
  if (!m) return null
  let h = Number(m[1])
  const min = m[2] ? Number(m[2]) : 0
  if (min > 59) return null
  const ap = m[3]
  if (ap === 'pm' && h < 12) h += 12
  else if (ap === 'am' && h === 12) h = 0
  if (h > 23) return null
  return { h, m: min }
}

// Shift a YYYY-MM-DD date by whole days (UTC math so it's timezone-safe date arithmetic).
function shiftDate(dateISO, days) {
  const [y, mo, d] = dateISO.split('-').map(Number)
  const dt = new Date(Date.UTC(y, mo - 1, d))
  dt.setUTCDate(dt.getUTCDate() + days)
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`
}

// A local RFC3339 datetime (no offset; the event carries timeZone) at date + {h,m} + addMin, rolling
// into following days if the minutes overflow midnight.
function dateTimeAt(dateISO, t, addMin = 0) {
  let total = t.h * 60 + t.m + addMin
  let dayOffset = 0
  while (total >= 1440) {
    total -= 1440
    dayOffset += 1
  }
  while (total < 0) {
    total += 1440
    dayOffset -= 1
  }
  const date = dayOffset === 0 ? dateISO : shiftDate(dateISO, dayOffset)
  return `${date}T${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}:00`
}

// ---- Event bodies -----------------------------------------------------------

function line(label, value) {
  const v = String(value || '').trim()
  return v ? `${label}: ${v}\n` : ''
}

function projectEventBody(project) {
  const booked = isProjectBooked(project)
  const summary = `${booked ? '' : 'Inquiry: '}${project.client}`

  let description = ''
  description += line('Event type', project.eventType)
  description += line('Arrival', project.arrivalTime)
  description += line('Event start', project.eventStartTime)
  description += line('Show start', project.showStartTime)
  description += line('Location', project.eventLocation)
  description += line('Guests', project.numberOfGuests)
  description += line('Contact', [project.contactNames, project.contactPhones].filter(Boolean).join(' · '))
  description += '\n(Synced from Magic CRM. Edit details in the CRM.)'

  const body = {
    summary,
    location: project.eventLocation || undefined,
    description: description.trim(),
    reminders: { useDefault: true },
  }

  // Timed block from the first available time (arrival -> event start -> show start); else all-day.
  const t = parseTime(project.arrivalTime) || parseTime(project.eventStartTime) || parseTime(project.showStartTime)
  if (t) {
    body.start = { dateTime: dateTimeAt(project.eventDate, t), timeZone: TIMEZONE }
    body.end = { dateTime: dateTimeAt(project.eventDate, t, GIG_DEFAULT_DURATION_MIN), timeZone: TIMEZONE }
  } else {
    body.start = { date: project.eventDate }
    body.end = { date: shiftDate(project.eventDate, 1) }
  }
  return body
}

function taskEventBody(task, project) {
  const body = {
    summary: task.title,
    description: (project ? `Project: ${project.client}\n\n` : '') + '(Synced from Magic CRM.)',
  }
  const t = parseTime(task.dueTime)
  if (t) {
    // Timed task: block a short slot with reminders 10 min before and at the time.
    body.start = { dateTime: dateTimeAt(task.dueDate, t), timeZone: TIMEZONE }
    body.end = { dateTime: dateTimeAt(task.dueDate, t, TASK_DURATION_MIN), timeZone: TIMEZONE }
    body.reminders = { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }, { method: 'popup', minutes: 0 }] }
  } else {
    // All-day task: no calendar reminder (the CRM handles the date-based "due today" nudge).
    body.start = { date: task.dueDate }
    body.end = { date: shiftDate(task.dueDate, 1) }
    body.reminders = { useDefault: false, overrides: [] }
  }
  return body
}

// ---- Upsert / remove --------------------------------------------------------

// Every map-touching operation runs through this one promise chain, so the "does this key already
// have an event?" check and the insert+id-write are one critical section. Without it, two concurrent
// first-time syncs of the SAME project/task would both insert -> a duplicate event + an orphan the
// CRM can never manage. These ops are fire-and-forget and network-bound, so serializing is fine.
let opChain = Promise.resolve()
function serialize(fn) {
  const run = opChain.then(fn, fn)
  opChain = run.catch(() => {}) // keep the chain alive even if one op rejects
  return run
}

function errorCode(e) {
  return e?.code || e?.response?.status
}

async function upsertEvent(cal, calId, bucket, key, body) {
  return serialize(async () => {
    const existingId = readMap()[bucket][key]
    if (existingId) {
      try {
        await cal.events.update({ calendarId: calId, eventId: existingId, requestBody: body })
        return existingId
      } catch (e) {
        const code = errorCode(e)
        if (code !== 404 && code !== 410) throw e
        // The event was deleted in Google; fall through and re-create it.
      }
    }
    let res
    try {
      res = await cal.events.insert({ calendarId: calId, requestBody: body })
    } catch (e) {
      // A 404 here means the calendar id itself is stale (e.g. the calendar was recreated). Drop the
      // cached ids so the next sync re-resolves them, then surface the error.
      if (errorCode(e) === 404) calIdCache.clear()
      throw e
    }
    const map = readMap()
    map[bucket][key] = res.data.id
    writeMap(map)
    return res.data.id
  })
}

async function removeEvent(cal, calId, bucket, key) {
  return serialize(async () => {
    const id = readMap()[bucket][key]
    if (!id) return
    try {
      await cal.events.delete({ calendarId: calId, eventId: id })
    } catch {
      // already gone / 404 — fine
    }
    const map = readMap()
    delete map[bucket][key]
    writeMap(map)
  })
}

// ---- Public sync API --------------------------------------------------------

// Upsert (or remove) a single project's Gigs-calendar event. A project belongs on the calendar while
// it's active and has an event date; otherwise its event is removed. Best-effort: never throws.
export async function syncProject(projectId) {
  if (!isCalendarConnected()) return { ok: false, skipped: 'not-connected' }
  try {
    const cal = api()
    const calId = await resolveCalendarId(cal, GIGS_CALENDAR)
    if (!calId) return { ok: false, error: `Calendar "${GIGS_CALENDAR}" not found in your account.` }
    const project = loadAll().projects.find((p) => p.id === projectId)
    if (!project || project.bucket !== 'active' || !project.eventDate) {
      await removeEvent(cal, calId, 'projects', projectId)
      return { ok: true, removed: true }
    }
    const id = await upsertEvent(cal, calId, 'projects', projectId, projectEventBody(project))
    return { ok: true, eventId: id }
  } catch (e) {
    console.error('[crm-calendar] syncProject failed:', e?.message || e)
    return { ok: false, error: String(e?.message || e) }
  }
}

// Upsert (or remove) a single task's Work-calendar event. A task belongs on the calendar while it's
// open (not done) and has a due date; otherwise its event is removed. Best-effort: never throws.
export async function syncTask(taskId) {
  if (!isCalendarConnected()) return { ok: false, skipped: 'not-connected' }
  try {
    const cal = api()
    const calId = await resolveCalendarId(cal, WORK_CALENDAR)
    if (!calId) return { ok: false, error: `Calendar "${WORK_CALENDAR}" not found in your account.` }
    const task = loadTasks().find((t) => t.id === taskId)
    if (!task || task.done || !task.dueDate) {
      await removeEvent(cal, calId, 'tasks', taskId)
      return { ok: true, removed: true }
    }
    const project = task.projectId ? loadAll().projects.find((p) => p.id === task.projectId) : null
    const id = await upsertEvent(cal, calId, 'tasks', taskId, taskEventBody(task, project))
    return { ok: true, eventId: id }
  } catch (e) {
    console.error('[crm-calendar] syncTask failed:', e?.message || e)
    return { ok: false, error: String(e?.message || e) }
  }
}

// Explicit removals (used when a project/task is deleted, so we don't need to load it).
export async function removeProjectEvent(projectId) {
  if (!isCalendarConnected()) return { ok: false, skipped: 'not-connected' }
  try {
    const cal = api()
    const calId = await resolveCalendarId(cal, GIGS_CALENDAR)
    if (calId) await removeEvent(cal, calId, 'projects', projectId)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
}
export async function removeTaskEvent(taskId) {
  if (!isCalendarConnected()) return { ok: false, skipped: 'not-connected' }
  try {
    const cal = api()
    const calId = await resolveCalendarId(cal, WORK_CALENDAR)
    if (calId) await removeEvent(cal, calId, 'tasks', taskId)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
}

// Full sync: push every eligible active-dated project and open-dated task. Idempotent (upserts by the
// stored map), so re-running just updates. Returns counts + any distinct errors.
export async function syncAll() {
  if (!isCalendarConnected()) return { ok: false, error: 'Not connected to Google Calendar.' }
  const projects = loadAll().projects.filter((p) => p.bucket === 'active' && p.eventDate)
  const tasks = loadTasks().filter((t) => !t.done && t.dueDate)
  let projectCount = 0
  let taskCount = 0
  const errors = new Set()
  for (const p of projects) {
    const r = await syncProject(p.id)
    if (r.ok) projectCount += 1
    else if (r.error) errors.add(r.error)
  }
  for (const t of tasks) {
    const r = await syncTask(t.id)
    if (r.ok) taskCount += 1
    else if (r.error) errors.add(r.error)
  }
  return { ok: true, projects: projectCount, tasks: taskCount, errors: [...errors] }
}

// Connection + calendar-availability status for the Settings UI.
export async function calendarStatus() {
  const connected = isConnected()
  const scope = hasCalendarScope()
  const base = { connected, hasScope: scope, gigsName: GIGS_CALENDAR, workName: WORK_CALENDAR, gigsCalendar: false, workCalendar: false }
  if (!connected || !scope) return base
  try {
    const cal = api()
    // Fresh list (not the cache) so Settings reflects reality and refreshes any stale cached id.
    const gigs = await listCalendarId(cal, GIGS_CALENDAR)
    const work = await listCalendarId(cal, WORK_CALENDAR)
    return { ...base, gigsCalendar: !!gigs, workCalendar: !!work }
  } catch (e) {
    return { ...base, error: String(e?.message || e) }
  }
}
