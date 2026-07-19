import { useMemo, useState } from 'react'
import { motion } from 'motion/react'
import { todayISO, type Project } from '../pipeline'
import type { GigEvent, Task } from '../api'

// Month calendar. Each day shows the gigs and tasks that fall on it. Gigs are
// color-coded by whether they're booked (green) or not yet (blue); tasks are a
// third color. Click a gig or task to open its project.

const COLORS = {
  booked: 'var(--color-umb-booked)', // green
  unbooked: 'var(--color-umb-postcall)', // blue / teal
  task: '#e08a6b', // coral
  gcal: '#c084fc', // manually-added Google "Gigs" calendar events (purple)
}

const GRID_LINE = 'rgba(255,255,255,0.18)' // calendar grid lines (visible on both dark themes)

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const pad = (n: number) => String(n).padStart(2, '0')
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

type Entry = { kind: 'gig' | 'task' | 'gcal'; label: string; color: string; projectId: string; href?: string }

type Props = {
  projects: Project[]
  tasks: Task[]
  gigEvents: GigEvent[]
  onOpenProject: (p: Project) => void
  onOpenProjectById: (id: string) => void
}

export function CalendarPage({ projects, tasks, gigEvents, onOpenProject, onOpenProjectById }: Props) {
  const now = new Date()
  const [cursor, setCursor] = useState({ y: now.getFullYear(), m: now.getMonth() })

  const isBooked = (p: Project) => p.bucket === 'completed' || p.stageId === 'deposit-paid'

  // Build entries per day-iso.
  const byDay = useMemo(() => {
    const map: Record<string, Entry[]> = {}
    const add = (key: string, e: Entry) => {
      if (!key) return
      ;(map[key] = map[key] || []).push(e)
    }
    for (const p of projects) {
      if (p.bucket === 'archived' || !p.eventDate) continue
      add(p.eventDate, { kind: 'gig', label: p.client, color: isBooked(p) ? COLORS.booked : COLORS.unbooked, projectId: p.id })
    }
    for (const t of tasks) {
      if (t.done || !t.dueDate) continue
      add(t.dueDate, { kind: 'task', label: t.title, color: COLORS.task, projectId: t.projectId })
    }
    for (const e of gigEvents) {
      if (!e.date) continue
      add(e.date, { kind: 'gcal', label: e.title, color: COLORS.gcal, projectId: '', href: e.htmlLink })
    }
    return map
  }, [projects, tasks, gigEvents])

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
        <div className="ml-auto flex items-center gap-4 text-[11px] text-muted">
          <Legend color={COLORS.booked} label="Booked gig" />
          <Legend color={COLORS.unbooked} label="Not booked" />
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
                        title={`Task: ${e.label}`}
                        className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-[10.5px] leading-tight text-parchment/80 transition-colors hover:bg-surface-3"
                      >
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: e.color }} />
                        <span className="min-w-0 truncate">{e.label}</span>
                      </button>
                    ) : (
                      // A highlighted bar with a left color stripe. CRM gigs (green = booked, blue = not
                      // yet) open the project; manual "Gigs calendar" events (purple) open in Google.
                      <button
                        key={j}
                        type="button"
                        onClick={() => (e.kind === 'gcal' ? (e.href ? window.open(e.href, '_blank') : undefined) : openEntry(e))}
                        title={e.kind === 'gcal' ? `Gigs calendar: ${e.label}` : `Gig: ${e.label}`}
                        className="block w-full truncate rounded-md px-1.5 py-[3px] text-left text-[10.5px] font-semibold leading-tight text-parchment transition-opacity hover:opacity-90"
                        style={{
                          backgroundColor: `color-mix(in oklab, ${e.color} 26%, transparent)`,
                          boxShadow: `inset 2px 0 0 ${e.color}`,
                        }}
                      >
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

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
      {label}
    </span>
  )
}
