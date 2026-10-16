import { useMemo, useState } from 'react'
import { motion } from 'motion/react'
import { todayISO, type Project } from '../pipeline'
import type { CalendarEvent, Task } from '../api'

// Month calendar. Each day shows the gigs and tasks that fall on it, plus what is on the Google Work
// and Gigs calendars that the CRM did not write itself. Gigs are color-coded by whether they're
// booked (green) or not yet (blue); tasks, manual Gigs-calendar events and Work-calendar meetings
// each have their own color. TidyCal bookings are tagged. Click a gig or task to open its project;
// click a Google event to open it in Google Calendar. Each day lists its items in time order.

const COLORS = {
  booked: 'var(--color-umb-booked)', // green
  unbooked: 'var(--color-umb-postcall)', // blue / teal
  task: '#dc2626', // coral
  gcal: '#c084fc', // manually-added Google "Gigs" calendar events (purple)
  work: '#0e7490', // Google "Work" calendar meetings, bookings and invites (teal)
}

const GRID_LINE = 'rgba(255,255,255,0.18)' // calendar grid lines (visible on both dark themes)

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const pad = (n: number) => String(n).padStart(2, '0')
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

type Entry = {
  kind: 'gig' | 'task' | 'gcal' | 'work'
  label: string
  color: string
  projectId: string
  href?: string
  time: string // "2:00 PM", or '' when the item has no time
  sortMin: number // minutes after midnight; -1 for untimed items, which lead the day
  booking?: boolean // a TidyCal booking on Michael's page
}

type Props = {
  projects: Project[]
  tasks: Task[]
  calendarEvents: CalendarEvent[]
  bookedIds: Set<string> // stage ids in the Booked category
  postshowIds: Set<string> // stage ids in the Post Show category
  onOpenProject: (p: Project) => void
  onOpenProjectById: (id: string) => void
}

// The first clear time in a gig's free-text field ("5:30 PM", "6pm", "16:00"), as minutes after
// midnight. Same rule as parseTime in crm-calendar.mjs: only a token with am/pm or an HH:MM colon
// counts, so a guest count or a year is never read as a time.
function minutesOf(raw: string): number {
  const s = String(raw || '').toLowerCase()
  if (!s.trim() || /^\s*(tbd|to be determined|unknown|n\/?a|none)\b/.test(s)) return -1
  const ap = s.match(/(\d{1,2})(?::([0-5]\d))?\s*([ap])\.?\s?m\.?/)
  if (ap) {
    let h = Number(ap[1])
    const m = ap[2] ? Number(ap[2]) : 0
    if (ap[3] === 'p' && h < 12) h += 12
    else if (ap[3] === 'a' && h === 12) h = 0
    return h > 23 ? -1 : h * 60 + m
  }
  const hm = s.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/)
  return hm ? Number(hm[1]) * 60 + Number(hm[2]) : -1
}

// Booked = the same rule as isProjectBooked in crm-data-core.mjs: completed, or sitting in any Booked
// or Post Show stage. (This page used to check only the deposit-paid stage, so a gig in any other
// Booked stage, or in Post Show, showed as not booked.) The server's extra case, a paid invoice on a
// gig whose stage has not moved yet, lives in the invoice records and is not loaded here.
function isBooked(p: Project, bookedIds: Set<string>, postshowIds: Set<string>): boolean {
  return p.bucket === 'completed' || bookedIds.has(p.stageId) || postshowIds.has(p.stageId)
}

// 845 -> "2:05 PM"
function label12(min: number): string {
  if (min < 0) return ''
  const h = Math.floor(min / 60)
  return `${h % 12 === 0 ? 12 : h % 12}:${pad(min % 60)} ${h < 12 ? 'AM' : 'PM'}`
}

export function CalendarPage({ projects, tasks, calendarEvents, bookedIds, postshowIds, onOpenProject, onOpenProjectById }: Props) {
  const now = new Date()
  const [cursor, setCursor] = useState({ y: now.getFullYear(), m: now.getMonth() })

  // Build entries per day-iso, each day in time order.
  const byDay = useMemo(() => {
    const map: Record<string, Entry[]> = {}
    const add = (key: string, e: Entry) => {
      if (!key) return
      ;(map[key] = map[key] || []).push(e)
    }
    for (const p of projects) {
      if (p.bucket === 'archived' || !p.eventDate) continue
      const booked = isBooked(p, bookedIds, postshowIds)
      // Sorted by the same time the calendar event's title carries: arrival, else start, else show.
      const at = [p.arrivalTime, p.eventStartTime, p.showStartTime].map(minutesOf).find((m) => m >= 0) ?? -1
      add(p.eventDate, { kind: 'gig', label: p.client, color: booked ? COLORS.booked : COLORS.unbooked, projectId: p.id, time: '', sortMin: at })
    }
    for (const t of tasks) {
      if (t.done || !t.dueDate) continue
      const at = minutesOf(t.dueTime)
      add(t.dueDate, { kind: 'task', label: t.title, color: COLORS.task, projectId: t.projectId, time: label12(at), sortMin: at })
    }
    for (const e of calendarEvents) {
      if (!e.date) continue
      const start = e.allDay || !e.startTime ? null : new Date(e.startTime)
      const at = start && !Number.isNaN(start.getTime()) ? start.getHours() * 60 + start.getMinutes() : -1
      const work = e.calendar === 'Work'
      add(e.date, {
        kind: work ? 'work' : 'gcal',
        label: e.title,
        color: work ? COLORS.work : COLORS.gcal,
        projectId: '',
        href: e.htmlLink,
        time: label12(at),
        sortMin: at,
        booking: e.booking,
      })
    }
    for (const list of Object.values(map)) list.sort((a, b) => a.sortMin - b.sortMin)
    return map
  }, [projects, tasks, calendarEvents, bookedIds, postshowIds])

  // Grid starting from the Sunday on/before the 1st, only as many weeks as the
  // month actually spans (5 or 6) so there's no empty trailing week.
  const cells = useMemo(() => {
    const first = new Date(cursor.y, cursor.m, 1)
    const start = new Date(first)
    start.setDate(first.getDate() - first.getDay())
    const daysInMonth = new Date(cursor.y, cursor.m + 1, 0).getDate()
    const weeks = Math.ceil((first.getDay() + daysInMonth) / 7)
    return Array.from({ length: weeks * 7 }, (_, i) => {
      const d = new Date(start)
      d.setDate(start.getDate() + i)
      return d
    })
  }, [cursor])

  const today = todayISO()
  const projectById = useMemo(() => {
    const m: Record<string, Project> = {}
    for (const p of projects) m[p.id] = p
    return m
  }, [projects])

  const openEntry = (e: Entry) => {
    if (e.kind === 'gcal' || e.kind === 'work') {
      if (e.href) window.open(e.href, '_blank')
      return
    }
    const p = projectById[e.projectId]
    if (p) onOpenProject(p)
    else if (e.projectId) onOpenProjectById(e.projectId)
  }

  const go = (delta: number) => {
    setCursor((c) => {
      const d = new Date(c.y, c.m + delta, 1)
      return { y: d.getFullYear(), m: d.getMonth() }
    })
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.35 }}
      className="board-scroll flex h-full flex-col overflow-y-auto px-8 pb-10"
    >
      {/* Toolbar */}
      <div className="mb-4 flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => go(-1)} className="rounded-lg border border-line p-1.5 text-muted transition-colors hover:border-line-strong hover:text-parchment" aria-label="Previous month">
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 6l-6 6 6 6" /></svg>
          </button>
          <h2 className="min-w-[180px] text-center font-display text-[22px] leading-none text-parchment">
            {MONTHS[cursor.m]} {cursor.y}
          </h2>
          <button type="button" onClick={() => go(1)} className="rounded-lg border border-line p-1.5 text-muted transition-colors hover:border-line-strong hover:text-parchment" aria-label="Next month">
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
          </button>
        </div>
        <button type="button" onClick={() => setCursor({ y: now.getFullYear(), m: now.getMonth() })} className="rounded-lg border border-line px-3 py-1.5 text-[11.5px] font-medium text-muted transition-colors hover:border-line-strong hover:text-parchment">
          Today
        </button>
        <div className="ml-auto flex flex-wrap items-center gap-4 text-[11px] text-muted">
          <Legend color={COLORS.booked} label="Booked gig" />
          <Legend color={COLORS.unbooked} label="Not booked" />
          <Legend color={COLORS.work} label="Work calendar" />
          <Legend color={COLORS.gcal} label="Gigs calendar" />
          <Legend color={COLORS.task} label="Task due" />
        </div>
      </div>

      {/* Weekday header */}
      <div className="grid grid-cols-7">
        {WEEKDAYS.map((w) => (
          <div key={w} className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">
            {w}
          </div>
        ))}
      </div>

      {/* Day grid — built as explicit week rows so each row carries its own
          bottom border (horizontal lines) and each day a right border (vertical). */}
      <div className="flex flex-1 flex-col overflow-hidden rounded-xl border" style={{ borderColor: GRID_LINE }}>
        {Array.from({ length: cells.length / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7)).map((week, wi, arr) => (
          <div
            key={wi}
            className="flex flex-1"
            style={{ borderBottom: wi < arr.length - 1 ? `1px solid ${GRID_LINE}` : undefined }}
          >
            {week.map((d, di) => {
              const key = iso(d)
              const inMonth = d.getMonth() === cursor.m
              const isToday = key === today
              const entries = byDay[key] || []
              const shown = entries.slice(0, 3)
              const more = entries.length - shown.length
              return (
                <div
                  key={di}
                  className={['flex min-h-[90px] min-w-0 flex-1 flex-col gap-0.5 p-1.5', inMonth ? 'bg-surface' : 'bg-canvas'].join(' ')}
                  style={{ borderRight: di < 6 ? `1px solid ${GRID_LINE}` : undefined }}
                >
                  <div className="flex justify-end">
                    <span
                      className={[
                        'flex h-5 w-5 items-center justify-center rounded-full text-[11px] tabular-nums',
                        isToday ? 'bg-brass font-bold text-canvas' : inMonth ? 'text-muted' : 'text-faint/60',
                      ].join(' ')}
                    >
                      {d.getDate()}
                    </span>
                  </div>
                  {shown.map((e, j) =>
                    e.kind === 'task' ? (
                      // Tasks stay as a small dot + label.
                      <button
                        key={j}
                        type="button"
                        onClick={() => openEntry(e)}
                        title={`Task: ${e.time ? `${e.time} ` : ''}${e.label}`}
                        className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-[10.5px] leading-tight text-parchment/80 transition-colors hover:bg-surface-3"
                      >
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: e.color }} />
                        <span className="min-w-0 truncate">
                          {e.time && <span className="tabular-nums text-muted">{e.time} </span>}
                          {e.label}
                        </span>
                      </button>
                    ) : (
                      // A highlighted bar with a left color stripe. CRM gigs (green = booked, blue = not
                      // yet) open the project; Google events (teal = Work, purple = Gigs) open in Google.
                      <button
                        key={j}
                        type="button"
                        onClick={() => openEntry(e)}
                        title={entryTitle(e)}
                        className="block w-full truncate rounded-md px-1.5 py-[3px] text-left text-[10.5px] font-semibold leading-tight text-parchment transition-opacity hover:opacity-90"
                        style={{
                          backgroundColor: `color-mix(in oklab, ${e.color} 26%, transparent)`,
                          boxShadow: `inset 2px 0 0 ${e.color}`,
                        }}
                      >
                        {e.booking && (
                          <span className="mr-1 rounded px-1 py-px text-[9px] font-bold text-white" style={{ backgroundColor: e.color }}>
                            TidyCal
                          </span>
                        )}
                        {e.time && <span className="font-medium tabular-nums">{e.time} </span>}
                        {e.label}
                      </button>
                    ),
                  )}
                  {more > 0 && <span className="px-1 text-[10px] text-faint">+{more} more</span>}
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </motion.div>
  )
}

// Hover text for a bar: where it came from, then the time and title.
function entryTitle(e: Entry): string {
  const what = `${e.time ? `${e.time} ` : ''}${e.label}`
  if (e.kind === 'work') return `Work calendar: ${what}${e.booking ? ' (TidyCal booking)' : ''}`
  if (e.kind === 'gcal') return `Gigs calendar: ${what}`
  return `Gig: ${what}`
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
      {label}
    </span>
  )
}
