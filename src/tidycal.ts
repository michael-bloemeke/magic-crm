import { createContext, type CSSProperties } from 'react'
import type { CalendarEvent, Contact, ProjectLinks } from './api'
import type { Project } from './pipeline'

// TIDYCAL BOOKINGS ON A PROJECT (Michael, 2026-11-12). A TidyCal booking only ever lived on his Google
// Calendar and in a phone alert, so a project gave no sign that a call was booked. Two things read
// this now: the TidyCal bar on the project page (dull when nothing is booked, green with the date and
// time when something is) and the green glow on the pipeline card.
//
// HOW A BOOKING FINDS ITS PROJECT: by the client's email. TidyCal writes the event as Michael with the
// client as the one guest, and crm-calendar.mjs passes those guest emails through as `guests`. A
// project's emails are its contactEmails field plus the emails of every contact linked to it.
// NOT by name: the event title reads "Event Strategy Call with Michael Bloemeke" (the title is
// written from the guest's side), so it never carries the client's name. Checked on Heath Little's
// real booking, 2026-11-12. A client who books with a different email from the one on the project
// will not match.
//
// THE GLOW IS ONLY FOR CALLS THE CLIENT BOOKED. Michael: "not just a call that I told them I'd call
// with them, but they actually filled out my TidyCal calendar." The follow-up calls he books himself
// on the sales call go through his HIDDEN TidyCal page, so they are TidyCal bookings too. They still
// show on the bar, but they do not light up the card. Listed by the names they carry on his
// calendar; everything else counts as client-booked, so a renamed public call can never lose its glow.
const SELF_BOOKED_CALLS = ['follow-up call', 'event planning call']

export type TidyCalBooking = {
  callName: string // "Event Strategy Call", the part of the title before " with "
  start: string // RFC 3339 with offset
  end: string
  clientBooked: boolean
}

export function callNameOf(title: string): string {
  const i = title.toLowerCase().lastIndexOf(' with ')
  return (i > 0 ? title.slice(0, i) : title).trim() || 'Call'
}

function emailsOf(text: string | undefined): string[] {
  return String(text || '')
    .split(/[\s,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.includes('@'))
}

// Upcoming TidyCal bookings per project id, soonest first. A booking stays until its end time passes.
export function tidyCalByProject(
  events: CalendarEvent[],
  projects: Project[],
  contacts: Contact[],
  links: ProjectLinks,
  now = Date.now(),
): Map<string, TidyCalBooking[]> {
  const out = new Map<string, TidyCalBooking[]>()
  const upcoming = events.filter((e) => {
    if (!e.booking || !e.startTime || !e.guests?.length) return false
    const end = Date.parse(e.endTime || e.startTime)
    return Number.isFinite(end) && end > now
  })
  if (upcoming.length === 0) return out
  const contactEmails = new Map(contacts.map((c) => [c.id, (c.emails || []).map((x) => String(x).toLowerCase())]))
  for (const p of projects) {
    if (p.bucket === 'deleted') continue
    const mine = new Set([...emailsOf(p.contactEmails), ...(links[p.id] || []).flatMap((id) => contactEmails.get(id) || [])])
    if (mine.size === 0) continue
    const hits = upcoming
      .filter((e) => (e.guests || []).some((g) => mine.has(g)))
      .map((e): TidyCalBooking => {
        const callName = callNameOf(e.title)
        return { callName, start: e.startTime, end: e.endTime || e.startTime, clientBooked: !SELF_BOOKED_CALLS.includes(callName.toLowerCase()) }
      })
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    if (hits.length) out.set(p.id, hits)
  }
  return out
}

// Built once in App.tsx and read by the bar and the pipeline cards, the same way the date-conflict flag
// reads DateConflictContext.
export const TidyCalContext = createContext<Map<string, TidyCalBooking[]>>(new Map())

export function hasClientBooking(map: Map<string, TidyCalBooking[]>, projectId: string): boolean {
  return (map.get(projectId) || []).some((b) => b.clientBooked)
}

// The green glow on a pipeline card. Inline on purpose: the navy brand ground repaints every
// bg-surface card from the stylesheet, and an inline style is the one thing that always wins.
// The top edge is separate for the Cards view, whose top border is a `borderTop` shorthand.
export const TIDYCAL_GLOW_NO_TOP: CSSProperties = {
  borderLeftColor: '#22c55e',
  borderRightColor: '#22c55e',
  borderBottomColor: '#22c55e',
  backgroundColor: '#effbf3',
  boxShadow: '0 0 0 1px rgba(34, 197, 94, 0.6), 0 0 20px 2px rgba(34, 197, 94, 0.45)',
}
export const TIDYCAL_GLOW: CSSProperties = { ...TIDYCAL_GLOW_NO_TOP, borderTopColor: '#22c55e' }

// "Friday, November 13 at 1:30 PM", Eastern.
export function whenLabel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const day = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' })
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })
  return `${day} at ${time}`
}
