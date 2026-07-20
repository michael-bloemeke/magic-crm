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
import {
  CRM_STORE,
  getCachedCalendarMap,
  setCalendarMap as sbSetCalendarMap,
  cacheSetCalendarMap,
} from './crm-store.mjs'

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

// The single { calendars, projects, tasks } event-id map for the current backend. Under supabase it
// comes from the single calendar_map row (id=1), served synchronously from the cache; under files
// from crm-calendar-map.json. The three maps always exist (defaulting to {}).
function readMap() {
  if (CRM_STORE === 'supabase') {
    const m = getCachedCalendarMap() || {}
    return { calendars: m.calendars || {}, projects: m.projects || {}, tasks: m.tasks || {} }
  }
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
async function writeMap(map) {
  if (CRM_STORE === 'supabase') {
    // Persist all three maps into the single calendar_map row (id=1). No _meta (DB-side).
    const patch = { calendars: map.calendars || {}, projects: map.projects || {}, tasks: map.tasks || {} }
    cacheSetCalendarMap(patch)
    await sbSetCalendarMap(patch)
    return
  }
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

// Fresh lookup: list the account's calendars, match by the name the user SEES, and update the cache
// (positive or negative). Google stores a calendar's own title as `summary`, but if the user renamed
// it in their calendar list that custom name lives in `summaryOverride` (e.g. a calendar whose real
// title is "Social" but shown as "Gigs"). We match the display name = summaryOverride ?? summary.
// Used by calendarStatus so the Settings view always reflects reality.
async function listCalendarId(cal, name) {
  const target = name.trim().toLowerCase()
  const res = await cal.calendarList.list({ maxResults: 250 })
  const found = (res.data.items || []).find(
    (c) => (c.summaryOverride || c.summary || '').trim().toLowerCase() === target,
  )
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

// Pull the FIRST clear time-of-day out of a value into {h, m} (24h), or null. This handles both the
// strict "HH:MM" a task's time input produces AND note-style gig fields like
// "Festival 4:00 PM to 9:00 PM (per Tina's questionnaire)" -> 16:00. We only accept a token that has
// an am/pm marker or an HH:MM colon, so we never mistake a bare number (a year, a guest count,
// "30-minute", a phone number) for a time.
function parseTime(raw) {
  const s = String(raw || '').toLowerCase()
  if (!s.trim()) return null
  // If the value LEADS with TBD/unknown, the time isn't set yet — keep the gig all-day even if a
  // window is mentioned in a note (e.g. "TBD (anywhere within the 5-10 PM window)").
  if (/^\s*(tbd|to be determined|unknown|n\/?a|none)\b/.test(s)) return null
  // An explicit am/pm time anywhere in the string wins first: "4:15 pm", "4pm", "4 p.m.".
  let m = s.match(/(\d{1,2})(?::([0-5]\d))?\s*([ap])\.?\s?m\.?/)
  if (m) {
    let h = Number(m[1])
    const min = m[2] ? Number(m[2]) : 0
    const pm = m[3] === 'p'
    if (pm && h < 12) h += 12
    else if (!pm && h === 12) h = 0
    if (h > 23 || min > 59) return null
    return { h, m: min }
  }
  // Otherwise the first 24h HH:MM: "16:00", "9:30".
  m = s.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/)
  if (m) return { h: Number(m[1]), m: Number(m[2]) }
  return null
}

// A real calendar date: strictly YYYY-MM-DD AND an actual day (so "TBD", "2026", or "2026-13-40"
// never get sent to Google, which would 400). Guards both gig eventDates and task dueDates.
function isValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false
  const [y, m, d] = s.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d
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
  // The project's Description blurb leads the event details, when there is one.
  if (String(project.eventSummary || '').trim()) description += `${String(project.eventSummary).trim()}\n\n`
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
    await writeMap(map)
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
    await writeMap(map)
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
    // A gig stays on the calendar while it's active OR completed (so past gigs you actually did
    // remain as a record). It's removed when archived/deleted, or if it has no real date yet ("TBD").
    const eligible =
      project && (project.bucket === 'active' || project.bucket === 'completed') && isValidDate(project.eventDate)
    if (!eligible) {
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
    if (!task || task.done || !isValidDate(task.dueDate)) {
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
  const projects = loadAll().projects.filter((p) => p.bucket === 'active' && isValidDate(p.eventDate))
  const tasks = loadTasks().filter((t) => !t.done && isValidDate(t.dueDate))
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

// ---- One-off calendar invite (project Booking section) ----------------------

// Create a standalone event on the "Work" calendar and email an invitation to the
// attendees (sendUpdates:'all', so Google adds it to their calendars too). Unlike
// syncProject/syncTask this is NOT tracked in the event-id map: it's a fire-once
// invite Michael sends by hand from a project's Booking section, so the background
// sync never updates or removes it. Returns the created event (or an error).
export async function sendCalendarInvite({
  summary,
  dateISO,
  startTime = '',
  durationMin = 30,
  attendees = [],
  location = '',
  description = '',
  allDay = false,
}) {
  if (!isCalendarConnected()) return { ok: false, error: 'Not connected to Google Calendar. Connect it in Settings first.' }
  if (!isValidDate(dateISO)) return { ok: false, error: 'Pick a valid date.' }
  const emails = [...new Set((attendees || []).map((e) => String(e || '').trim()).filter((e) => /.+@.+\..+/.test(e)))]
  try {
    const cal = api()
    const calId = await resolveCalendarId(cal, WORK_CALENDAR)
    if (!calId) return { ok: false, error: `Calendar "${WORK_CALENDAR}" not found in your Google account.` }
    const body = {
      summary: String(summary || 'Appointment').trim() || 'Appointment',
      location: String(location || '').trim() || undefined,
      description: String(description || '').trim() || undefined,
      attendees: emails.map((email) => ({ email })),
      reminders: { useDefault: true },
    }
    const t = allDay ? null : parseTime(startTime)
    if (t) {
      const mins = Math.max(5, Math.min(720, Number(durationMin) || 30))
      body.start = { dateTime: dateTimeAt(dateISO, t), timeZone: TIMEZONE }
      body.end = { dateTime: dateTimeAt(dateISO, t, mins), timeZone: TIMEZONE }
    } else {
      // No usable start time -> an all-day event.
      body.start = { date: dateISO }
      body.end = { date: shiftDate(dateISO, 1) }
    }
    // sendUpdates:'all' is what actually emails the invitation to the attendees.
    const res = await cal.events.insert({ calendarId: calId, requestBody: body, sendUpdates: 'all' })
    return { ok: true, eventId: res.data.id, htmlLink: res.data.htmlLink, summary: body.summary, attendees: emails }
  } catch (e) {
    console.error('[crm-calendar] sendCalendarInvite failed:', e?.message || e)
    return { ok: false, error: String(e?.message || e) }
  }
}

// ---- Reading the Gigs calendar (pull manual events into the CRM) ------------

// List events on the "Gigs" Google calendar in [fromISO, toISO] (YYYY-MM-DD), EXCLUDING the events the
// CRM itself created for its projects (those are already shown as CRM projects). What's left is what
// Michael added by hand on his phone/Google. Feeds the CRM Calendar page + the date-conflict flag, so
// a manual Gigs entry both shows up in the CRM and warns of a double-booking. Best-effort; never throws.
export async function listGigsEvents(fromISO, toISO) {
  if (!isCalendarConnected()) return { ok: false, events: [], reason: 'not-connected' }
  try {
    const cal = api()
    const calId = await resolveCalendarId(cal, GIGS_CALENDAR)
    if (!calId) return { ok: false, events: [], error: `Calendar "${GIGS_CALENDAR}" not found in your account.` }
    const crmEventIds = new Set(Object.values(readMap().projects || {}))
    const res = await cal.events.list({
      calendarId: calId,
      timeMin: new Date(`${fromISO}T00:00:00Z`).toISOString(),
      timeMax: new Date(`${toISO}T23:59:59Z`).toISOString(),
      singleEvents: true, // expand recurring events into individual instances
      orderBy: 'startTime',
      maxResults: 2500,
    })
    const events = (res.data.items || [])
      .filter((e) => e.status !== 'cancelled' && !crmEventIds.has(e.id))
      .map((e) => {
        const allDay = !!(e.start && e.start.date)
        const date = allDay ? e.start.date : (e.start && e.start.dateTime ? e.start.dateTime.slice(0, 10) : '')
        return {
          id: e.id,
          title: e.summary || '(untitled)',
          date,
          allDay,
          startTime: !allDay && e.start && e.start.dateTime ? e.start.dateTime : '',
          location: e.location || '',
          htmlLink: e.htmlLink || '',
        }
      })
      .filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date))
    return { ok: true, events }
  } catch (e) {
    console.error('[crm-calendar] listGigsEvents failed:', e?.message || e)
    return { ok: false, events: [], error: String(e?.message || e) }
  }
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
