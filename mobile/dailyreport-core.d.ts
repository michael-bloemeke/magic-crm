// Types for dailyreport-core.js, for the Mac's TypeScript (src/components/DailyReportPage.tsx). The
// phone loads the .js directly and never reads this file; it is not published.
export type ReportEvent = {
  id: string
  calendar: string
  title: string
  allDay: boolean
  start: string
  end: string
  startDate: string
  endDate: string
  busy: boolean
  location: string
  booking: boolean
  crm: '' | 'task' | 'project'
}
export type ReportNotes = {
  briefing?: string
  tasks?: Record<string, { how: string; send: string }>
  focus?: { title: string; why: string; firstStep: string } | null
  alsoOpen?: { title: string; why: string }[]
  // Every task Claude was shown when it wrote the notes, noted or not.
  covered?: string[]
  model?: string
}
// The `daily_reports` row for the day, as both servers hand it over.
export type ReportNotesRow = {
  reportDate: string
  status: 'requested' | 'writing' | 'ready' | 'error' | string
  generatedAt: string
  requestedAt?: string
  error: string
  notes: ReportNotes | null
  /** Set when today's row has no notes yet and an earlier day's are laid under it. */
  borrowedFrom?: string
}
export type ReportInput = {
  dateISO: string
  tasks: { id: string; projectId?: string; title: string; dueDate?: string; dueTime?: string; done?: boolean }[]
  projects: { id: string; client: string; bucket: string; stageId?: string; eventDate?: string; eventType?: string }[]
  stageNames?: Record<string, string>
  bookedStageIds?: string[]
  events?: ReportEvent[]
  plate?: { text: string; depth?: number }[]
  notes?: ReportNotesRow | null
  unreadMail?: number | null
  checkedIds?: string[]
}
export type ReportModel = {
  dateISO: string
  dateLabel: string
  counts: { overdue: number; dueToday: number; total: number; noted: number; unseen: number }
  notes: { state: 'none' | 'asked' | 'writing' | 'fresh' | 'old' | 'error'; generatedAt: string; reportDate: string; error: string; showingOld: boolean }
  [key: string]: unknown
}
export const ROUTINE: { wake: number; deskAt: number }
export const GROUPS: { key: string; title: string }[]
export function localToday(now?: Date): string
export function dayBounds(dateISO: string): { from: string; to: string }
export function longDate(iso: string, withYear?: boolean): string
export function buildReport(input: ReportInput): ReportModel
export function renderReportHtml(model: ReportModel): string
