import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { loadDailyReport, makeDailyReportPdf, writeDailyNotes, type DailyReportData, type Task } from '../api'
import type { PipelineStructure, Project } from '../pipeline'
import { buildReport, dayBounds, localToday, renderReportHtml } from '../../mobile/dailyreport-core.js'

// THE DAILY REPORT, on the Mac (2026-11-11). Opened from the button on Home.
//
// Michael: "I want it to pull up in the window of the actual CRM." So it is a screen in the app, and
// what it shows is ONE self-contained document in a frame. The same document the phone shows, built
// by the same file (mobile/dailyreport-core.js; read the top of it for what is on the report and why).
//
// ⚠️ IT IS A SIMPLE DOCUMENT, NOT PART OF THE APP (reworked 2026-11-11, his words: "I don't want it
// to be so embedded in the app"). Nothing on it links into the CRM, so this page listens for ONE
// thing from the frame: a ticked checkbox. There is no Print button either ("I don't need the CRM to
// connect to my printer"). "Open as PDF" saves the document as a real PDF file and opens it in
// Preview; printing from there is the Mac's job.
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
  onToggleTask,
}: {
  projects: Project[]
  tasks: Task[]
  structure: PipelineStructure
  bookedIds: Set<string>
  unreadMail: number
  onToggleTask: (id: string, done: boolean) => void
}) {
  const [date] = useState(() => localToday())
  const [data, setData] = useState<DailyReportData | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  // Tasks ticked off on this screen. They stay on the page, struck through, until he leaves.
  const [checked, setChecked] = useState<Set<string>>(() => new Set())
  // "Open as PDF": '' idle, 'making' while Chrome prints it, otherwise the line to show afterwards.
  const [pdf, setPdf] = useState<{ state: '' | 'making' | 'done' | 'error'; text: string }>({ state: '', text: '' })
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
      .map((t) => [t.id, t.title, t.dueDate, t.dueTime, t.durationMin, t.projectId])
    const named = projects.map((p) => [p.id, p.client, p.stageId, p.eventDate, p.bucket, p.eventType, p.eventLocation, p.bookingSource, p.leadDate])
    // Which projects have an open task at all (for the "No task scheduled" list). A task ticked on
    // this screen still counts, so ticking never rebuilds the page.
    const withTask = [...new Set(tasks.filter((t) => t.projectId && (!t.done || checked.has(t.id))).map((t) => t.projectId))].sort()
    return JSON.stringify([date, onReport, named, withTask, stageNames, data?.events, data?.plate, data?.notes, writing, unreadMail])
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

  // The one thing the document ever reports: a task's checkbox.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const m = e.data as { source?: string; type?: string; id?: string; done?: boolean } | null
      if (!m || m.source !== 'daily-report' || !m.id) return
      if (frame.current && e.source !== frame.current.contentWindow) return
      if (m.type === 'toggle-task') {
        const id = m.id
        // The document says which way the box went. Never work it out from `checked`: two quick
        // clicks arrive before React has re-rendered, and both would read as "done".
        const done = m.done === true
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
  }, [onToggleTask])

  // The PDF is made from the document as it stands in the frame right now, so a task he has just
  // ticked is crossed off in the file too.
  const openPdf = () => {
    const doc = frame.current?.contentDocument
    const now = doc ? '<!doctype html>' + doc.documentElement.outerHTML : html
    setPdf({ state: 'making', text: 'Making the PDF…' })
    makeDailyReportPdf(date, now)
      .then((r) => setPdf({ state: 'done', text: `Saved as “${r.name}” in the “${r.folder}” folder, and opened.` }))
      .catch((e) => setPdf({ state: 'error', text: String(e instanceof Error ? e.message : e) }))
  }

  const note = loadError
    ? loadError
    : pdf.state
      ? pdf.text
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
        <p className={`min-w-0 flex-1 truncate text-[12.5px] ${loadError || pdf.state === 'error' || (!pdf.state && status === 'error') ? 'text-[#ffb4a8]' : 'text-parchment/80'}`}>
          {writing && !pdf.state && <span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-[#e3c279] align-middle" />}
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
          onClick={openPdf}
          disabled={!html || pdf.state === 'making'}
          title="Save this report as a PDF file and open it"
          className="shrink-0 rounded-lg border border-line bg-surface px-3.5 py-2 text-[12.5px] font-semibold text-parchment transition-colors hover:border-line-strong disabled:opacity-50"
        >
          {pdf.state === 'making' ? 'Making the PDF…' : 'Open as PDF'}
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
