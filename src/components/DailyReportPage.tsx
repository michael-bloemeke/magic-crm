import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { loadDailyReport, writeDailyNotes, type DailyReportData, type Task } from '../api'
import type { PipelineStructure, Project } from '../pipeline'
import { buildReport, dayBounds, localToday, renderReportHtml } from '../../mobile/dailyreport-core.js'

// THE DAILY REPORT, on the Mac (2026-11-11). Opened from the button on Home.
//
// Michael: "I want it to pull up in the window of the actual CRM... but I want the ability to print
// it if I really want." So it is a screen in the app, like the proposal preview, and what it shows is
// ONE self-contained document in a frame. The same document the phone shows, built by the same file
// (mobile/dailyreport-core.js; read the top of it for what is on the report and why). Framing it is
// what makes Print print the report and nothing else.
//
// THE FACTS ARE LIVE; THE NOTES ARE WRITTEN ONCE. Tasks and projects come from the app, the calendar
// and On my plate from /api/daily-report, on every open. Claude's notes take a minute or two, so
// they are written the first time the report is opened each day and kept (in `daily_reports`, where
// the phone reads them too). "Rewrite notes" does it again on demand, after the day has moved on.
//
// ⚠️ THE FRAME IS REBUILT ONLY WHEN ITS CONTENT CHANGES, never when a box is ticked. Ticking a task
// is handled inside the document itself, so the page does not jump back to the top under his cursor.
// A ticked task stays on the page, struck through, until he leaves: an undo that needs no dialog.
export function DailyReportPage({
  projects,
  tasks,
  structure,
  bookedIds,
  unreadMail,
  onOpenProject,
  onToggleTask,
}: {
  projects: Project[]
  tasks: Task[]
  structure: PipelineStructure
  bookedIds: Set<string>
  unreadMail: number
  onOpenProject: (id: string) => void
  onToggleTask: (id: string, done: boolean) => void
}) {
  const [date] = useState(() => localToday())
  const [data, setData] = useState<DailyReportData | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  // Tasks ticked off on this screen. They stay on the page, struck through, until he leaves.
  const [checked, setChecked] = useState<Set<string>>(() => new Set())
  const frame = useRef<HTMLIFrameElement>(null)
  const keepScroll = useRef(0)
  const autoWrote = useRef(false)

  const load = useCallback(() => {
    const b = dayBounds(date)
    return loadDailyReport(date, b.from, b.to)
      .then((d) => {
        setData(d)
        setLoadError(null)
        return d
      })
      .catch((e) => {
        setLoadError(String(e instanceof Error ? e.message : e))
        return null
      })
  }, [date])

  useEffect(() => {
    void load()
  }, [load])

  const status = data?.notes?.reportDate === date ? data.notes.status : ''
  const writing = !!data && (data.writing || status === 'writing' || status === 'requested')
  const haveToday = status === 'ready'

  // The first open of the day writes the notes without being asked: "all I do is I just click a
  // button and it generates the report." Once per visit, and never over a write already running.
  useEffect(() => {
    if (!data || autoWrote.current || writing || haveToday || status === 'error') return
    autoWrote.current = true
    writeDailyNotes(date)
      .then(() => load())
      .catch((e) => setLoadError(String(e instanceof Error ? e.message : e)))
  }, [data, writing, haveToday, status, date, load])

  // While Claude writes, look again every few seconds. Stops the moment the notes are in. (The
  // server reports `writing` from the instant a write is started, so no local flag is needed.)
  useEffect(() => {
    if (!writing) return
    const t = setInterval(() => void load(), 4000)
    return () => clearInterval(t)
  }, [writing, load])

  const rewrite = () => {
    writeDailyNotes(date)
      .then(() => load())
      .catch((e) => setLoadError(String(e instanceof Error ? e.message : e)))
  }

  // Everything that decides what the document says, EXCEPT which boxes are ticked. When this string
  // changes the frame is rebuilt; when it does not, the frame is left exactly as he is reading it.
  const stageNames = useMemo(() => {
    const m: Record<string, string> = {}
    for (const u of structure.umbrellas) for (const s of u.stages) m[s.id] = s.name
    return m
  }, [structure])
  const contentKey = useMemo(() => {
    const onReport = tasks
      .filter((t) => t.dueDate && t.dueDate <= date && (!t.done || checked.has(t.id)))
      .map((t) => [t.id, t.title, t.dueDate, t.dueTime, t.projectId])
    const named = projects.map((p) => [p.id, p.client, p.stageId, p.eventDate, p.bucket])
    return JSON.stringify([date, onReport, named, stageNames, data?.events, data?.plate, data?.notes, writing, unreadMail])
  }, [tasks, projects, stageNames, data, writing, unreadMail, date, checked])

  const html = useMemo(() => {
    if (!data) return ''
    // While Claude writes, the page says so, and keeps showing the last notes underneath.
    const notes = writing
      ? { reportDate: date, generatedAt: '', error: '', ...(data.notes || {}), notes: data.notes?.notes || {}, status: 'writing' }
      : data.notes
    const model = buildReport({
      dateISO: date,
      tasks,
      projects,
      stageNames,
      bookedStageIds: [...bookedIds],
      events: data.events,
      plate: data.plate,
      notes,
      unreadMail,
      checkedIds: [...checked],
    })
    return renderReportHtml(model)
    // Rebuilt on contentKey alone, on purpose (see the note at the top).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentKey])

  // Remember where he was reading, so a rebuild (the notes arriving) does not throw him to the top:
  // each fresh document is scrolled back to where the last one was, then reports its own scrolling.
  const onFrameLoad = () => {
    const w = frame.current?.contentWindow
    if (!w) return
    try {
      if (keepScroll.current) w.scrollTo(0, keepScroll.current)
      w.addEventListener('scroll', () => (keepScroll.current = w.scrollY), { passive: true })
    } catch {
      /* a frame that will not scroll is not worth an error */
    }
  }

  // The document's two buttons: a project name, and a task's checkbox.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const m = e.data as { source?: string; type?: string; id?: string } | null
      if (!m || m.source !== 'daily-report' || !m.id) return
      if (frame.current && e.source !== frame.current.contentWindow) return
      if (m.type === 'open-project') onOpenProject(m.id)
      if (m.type === 'toggle-task') {
        const id = m.id
        const done = !checked.has(id)
        setChecked((prev) => {
          const next = new Set(prev)
          if (done) next.add(id)
          else next.delete(id)
          return next
        })
        onToggleTask(id, done)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [onOpenProject, onToggleTask, checked])

  const print = () => {
    try {
      frame.current?.contentWindow?.focus()
      frame.current?.contentWindow?.print()
    } catch {
      window.print()
    }
  }

  const note = loadError
    ? loadError
    : writing
      ? 'Claude is writing today’s notes…'
      : status === 'error'
        ? 'The notes could not be written.'
        : !data
          ? ''
          : data.calendarOk
            ? ''
            : 'The calendar could not be read, so the schedule may be missing things.'

  return (
    <div className="flex h-full min-h-0 flex-col px-8 pb-6">
      <div className="mb-3 flex shrink-0 items-center gap-3">
        <p className={`min-w-0 flex-1 truncate text-[12.5px] ${loadError || status === 'error' ? 'text-[#ffb4a8]' : 'text-parchment/80'}`}>
          {writing && <span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-[#e3c279] align-middle" />}
          {note}
        </p>
        <button
          type="button"
          onClick={rewrite}
          disabled={!data || writing}
          title="Have Claude write the notes again, from where things stand right now"
          className="shrink-0 rounded-lg border border-line bg-surface px-3.5 py-2 text-[12.5px] font-semibold text-parchment transition-colors hover:border-line-strong disabled:opacity-50"
        >
          {writing ? 'Writing…' : haveToday ? 'Rewrite notes' : 'Write notes'}
        </button>
        <button
          type="button"
          onClick={print}
          disabled={!html}
          className="shrink-0 rounded-lg border border-line bg-surface px-3.5 py-2 text-[12.5px] font-semibold text-parchment transition-colors hover:border-line-strong disabled:opacity-50"
        >
          Print
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden rounded-2xl border border-line bg-[#eef0f3] shadow-[0_14px_30px_-18px_rgba(4,8,24,0.75)]">
        {html ? (
          <iframe ref={frame} title="Daily report" srcDoc={html} onLoad={onFrameLoad} className="h-full w-full border-0" />
        ) : (
          <div className="flex h-full items-center justify-center">
            <p className={`text-[13px] ${loadError ? 'text-[#b42318]' : 'animate-pulse text-[#545b64]'}`}>{loadError || 'Putting today together…'}</p>
          </div>
        )}
      </div>
    </div>
  )
}
