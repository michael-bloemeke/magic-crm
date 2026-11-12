// THE DAILY REPORT: the shared rules and the page itself (2026-11-11).
//
// Michael: "a daily document that I can click on this button on the homepage... it's going to outline
// everything that I need to do today... it's like an update and a schedule. It's the kind of thing
// that I could theoretically just print off this one sheet and then be good for the day."
//
// WHAT IS ON IT, in his order:
//   1. The tasks with no set time, at the top, in FOUR groups in this exact priority: overdue on
//      projects, overdue of his own, due today on projects, due today of his own. Each can carry a
//      short note from Claude on how to handle it and what to send.
//   2. The day's schedule as a timeline: the 6:00 AM wake-up, working out and getting ready until
//      8:00, then everything with a set time (calendar events from EVERY calendar including the
//      personal ones, booked gigs, and tasks that have a time).
//      ⚠️ TASKS WITHOUT A TIME NEVER GO ON THE TIMELINE. He asked for that, then took it back in the
//      same breath: "Don't try to jam those non-scheduled tasks, because I don't want you to try to
//      estimate how long they're going to take. I don't trust your judgment on that."
//   3. The larger project to work on once the tasks are done, chosen by Claude from his plans and his
//      own "On my plate" list.
//
// STANDING CONTENT: things that are on the report EVERY day because he said so once, not because
// they are in the calendar or the task list. Add to this list when he names another; never drop one.
//   a. The morning routine: up at 6:00, working out and getting ready until 8:00 (2026-11-11).
//   b. NEW INQUIRIES (2026-11-12): every active project still in the `inquiry` stage. That stage
//      means he has not reached out AT ALL: "Once I even reach out to them at all, regardless of
//      whether or not they answer, I move it over to the answered inquiry stage. So for that reason,
//      anything that's sitting in the inquiry stage should get my attention." Each is listed with
//      what it is and how long it has waited, and Claude may add a short recommendation.
//   c. PROJECTS WITH NO TASK (2026-11-12): every other active project with no open task. His rule is
//      that every project has something scheduled "that way, it's never just going to get forgotten
//      about... include in the report if there's any projects that have slipped by that have no
//      tasks." Inquiry-stage projects are left out of this list: they are already in (b), and a new
//      website inquiry has no task by design.
//
// TWO LAYERS. The FACTS (tasks, calendar, On my plate) are read live every time, so the report is
// never stale and opens instantly. CLAUDE'S NOTES (how to handle each task, where things stand, what
// to work on) are written on the Mac, saved in `daily_reports`, and laid over the facts when they
// exist. No notes yet is a normal state, not an error: the report is still complete without them.
//
// ONE FILE, FOUR READERS: the Mac's page (src/components/DailyReportPage.tsx, typed by
// dailyreport-core.d.ts), the phone (app.js), the Mac's note writer (crm-daily-report.mjs), and the
// tests. Everything here is pure: data in, a model or an HTML string out. The page is ONE
// self-contained HTML document, shown in a frame on both apps, so it looks the same on the laptop,
// on the phone and on paper. It is a SIMPLE DOCUMENT: no links, no tooltips, nothing that follows
// the scroll. The one live thing on it is the checkbox. See the note above renderReportHtml.

// The day's fixed shape (Michael, 2026-11-11): up at 6:00, working out and getting ready take two
// hours, at the computer by 8:00. Minutes after midnight.
export const ROUTINE = { wake: 6 * 60, deskAt: 8 * 60 }
// A task with a time blocks half an hour, the same as its calendar event (crm-calendar.mjs).
export const TIMED_TASK_MIN = 30
// The first stage of the pipeline: a lead nobody has reached out to yet.
export const INQUIRY_STAGE = 'inquiry'

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const str = (v) => (v == null ? '' : String(v))
const isISO = (s) => /^\d{4}-\d{2}-\d{2}$/.test(str(s))

function dateOf(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(iso))
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null
}
// Whole days from a to b (b later = positive). Local calendar days, so DST never makes it 0.96.
export function daysBetween(aISO, bISO) {
  const a = dateOf(aISO), b = dateOf(bISO)
  if (!a || !b) return 0
  return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86400000)
}
// "Wednesday, November 11, 2026"
export function longDate(iso, withYear = true) {
  const d = dateOf(iso)
  if (!d) return str(iso)
  return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}${withYear ? `, ${d.getFullYear()}` : ''}`
}
// The device's own today, as YYYY-MM-DD.
export function localToday(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}
// The instants that bound a local day, for asking Google for that day's events. Worked out on the
// device, because only the device knows which time zone Michael is standing in.
export function dayBounds(dateISO) {
  const d = dateOf(dateISO) || new Date()
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)
  return { from: d.toISOString(), to: next.toISOString() }
}

// "14:30", "2:30 PM", "2pm" -> minutes after midnight, or null. Times are stored both ways in the CRM.
export function parseClock(raw) {
  const t = str(raw).trim().toLowerCase().replace(/\./g, '')
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?$/.exec(t)
  if (!m) return null
  let h = Number(m[1])
  const min = Number(m[2] || 0)
  if (m[3]) {
    if (h === 12) h = 0
    if (m[3].startsWith('p')) h += 12
  }
  if (h > 24 || min > 59) return null
  return h * 60 + min
}
// 870 -> "2:30 PM". Always 12-hour (his rule).
export function clock(min) {
  const m = ((Math.round(min) % 1440) + 1440) % 1440
  const h = Math.floor(m / 60)
  return `${h % 12 || 12}:${String(m % 60).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`
}
// "2:00 to 3:00 PM", or "11:30 AM to 1:00 PM" when the halves differ.
export function clockRange(a, b) {
  const A = clock(a), B = clock(b)
  return A.slice(-2) === B.slice(-2) ? `${A.slice(0, -3)} to ${B}` : `${A} to ${B}`
}

// Claude's words, made safe for his eyes: no em or en dashes (a hard rule of his), no markdown.
export function tidy(text) {
  return str(text)
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(\d)\s*[—–]\s*(\d)/g, '$1 to $2')
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

// ---------------------------------------------------------------------------------------------
// Calendar events
// ---------------------------------------------------------------------------------------------
//
// The servers (the Mac's crm-daily-report.mjs and the cloud's phone-api) hand over the day's events
// from EVERY calendar in this plain shape, with the instants untouched:
//   { id, calendar, title, start, end, allDay, startDate, endDate, busy, location, booking, crm }
// `crm` says the CRM wrote the event itself: 'task' (a timed task) or 'project' (a gig). Turning
// instants into "minutes into his day" happens HERE, on the device, in the device's own time zone.

function kindOf(ev) {
  const cal = str(ev.calendar).toLowerCase()
  if (ev.crm === 'project' || cal === 'gigs') return 'gig'
  if (cal.includes('mastermind')) return 'mastermind'
  if (cal.includes('personal')) return 'personal'
  if (cal.includes('holiday')) return 'holiday'
  if (ev.booking || /\b(call|zoom|meet|meeting|interview)\b/i.test(str(ev.title))) return 'call'
  return 'work'
}

// -> { timed: [{ id, startMin, endMin, title, kind, where }], allDay: [{ title, kind }] }
export function placeEvents(events, dateISO) {
  const day = dateOf(dateISO)
  const timed = []
  const allDay = []
  if (!day) return { timed, allDay }
  const dayStart = day.getTime()
  const dayEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime()
  for (const ev of events || []) {
    if (!ev) continue
    // A timed task the CRM put on the calendar: the task itself is added from the task list, so the
    // calendar's copy would show it twice.
    if (ev.crm === 'task') continue
    const kind = kindOf(ev)
    const title = str(ev.title).trim() || '(untitled)'
    if (ev.allDay) {
      if (!(isISO(ev.startDate) && ev.startDate <= dateISO && (!isISO(ev.endDate) || dateISO < ev.endDate))) continue
      // An all-day entry marked FREE on his own work calendars is a placeholder (an unbooked
      // "Inquiry: ..." date), not something he is doing today. Holidays and personal days stay.
      if (!ev.busy && kind !== 'holiday' && kind !== 'personal') continue
      allDay.push({ title, kind })
      continue
    }
    const s = Date.parse(ev.start), e = Date.parse(ev.end || ev.start)
    if (!Number.isFinite(s) || e <= dayStart || s >= dayEnd) continue
    const startMin = Math.max(0, Math.round((s - dayStart) / 60000))
    const endMin = Math.min(1440, Math.max(startMin + 15, Math.round((e - dayStart) / 60000)))
    timed.push({
      id: str(ev.id), startMin, endMin, title, kind, where: str(ev.location).trim(),
      startsEarlier: s < dayStart, endsLater: e > dayEnd,
    })
  }
  timed.sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin)
  return { timed, allDay }
}

// Side-by-side columns for things that overlap, the way a calendar draws them.
function assignLanes(items) {
  let cluster = []
  let clusterEnd = -1
  const flush = () => {
    const lanes = []
    for (const it of cluster) {
      let lane = lanes.findIndex((end) => end <= it.startMin)
      if (lane === -1) { lane = lanes.length; lanes.push(0) }
      lanes[lane] = it.endMin
      it.lane = lane
    }
    for (const it of cluster) it.lanes = lanes.length
    cluster = []
  }
  for (const it of items) {
    if (cluster.length && it.startMin >= clusterEnd) flush()
    cluster.push(it)
    clusterEnd = Math.max(clusterEnd, it.endMin)
  }
  if (cluster.length) flush()
  return items
}

// ---------------------------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------------------------

// The four groups, in the order he works them. Keys are used by the note writer too.
export const GROUPS = [
  { key: 'overdueProject', title: 'Overdue, on projects' },
  { key: 'overdueOwn', title: 'Overdue, your own' },
  { key: 'todayProject', title: 'Due today, on projects' },
  { key: 'todayOwn', title: 'Due today, your own' },
]

// Which group a task belongs in, or '' when it is not on today's report at all.
export function groupOf(task, dateISO, projectIds) {
  if (!task || !isISO(task.dueDate) || task.dueDate > dateISO) return ''
  const onProject = !!task.projectId && (!projectIds || projectIds.has(task.projectId))
  if (task.dueDate < dateISO) return onProject ? 'overdueProject' : 'overdueOwn'
  return onProject ? 'todayProject' : 'todayOwn'
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many || one + 's'}`
}

// One line that places a project: its stage, what it is, and when.
function projectLine(p, dateISO, stageNames) {
  if (!p) return ''
  const bits = []
  const stage = str(stageNames && stageNames[p.stageId]).trim()
  if (stage) bits.push(stage)
  if (isISO(p.eventDate)) {
    const n = daysBetween(dateISO, p.eventDate)
    const when = n === 0 ? 'today' : n === 1 ? 'tomorrow' : n > 0 ? `in ${n} days` : `${plural(-n, 'day')} ago`
    bits.push(`${str(p.eventType).trim() || 'Event'} on ${longDate(p.eventDate, daysBetween(dateISO, p.eventDate) > 300 || n < 0).replace(/^\w+, /, '')} (${when})`)
  } else if (str(p.eventType).trim()) {
    bits.push(`${p.eventType}, no date yet`)
  }
  return bits.join('. ')
}

// input:
//   dateISO        the day the report is for
//   tasks          every open task [{ id, projectId, title, dueDate, dueTime, done }]
//   projects       live projects [{ id, client, bucket, stageId, eventDate, eventType, eventLocation,
//                  bookingSource, leadDate }]
//   stageNames     { stageId: 'Proposal Sent' }
//   bookedStageIds [stageId] of the Booked category, for "next show"
//   events         the day's calendar events (see above)
//   plate          On my plate [{ id, text, depth }], already in order
//   notes          Claude's notes row { reportDate, status, generatedAt, notes: {...} } or null
//   unreadMail     unread client emails (a count), or null when not known
//   checkedIds     tasks ticked off while this report is open: they stay on the page, struck through
export function buildReport(input) {
  const dateISO = isISO(input.dateISO) ? input.dateISO : localToday()
  const projects = input.projects || []
  const byId = new Map(projects.map((p) => [p.id, p]))
  const projectIds = new Set(byId.keys())
  const checked = new Set(input.checkedIds || [])
  // The row can exist with no notes in it yet (asked for, or being written, for the first time ever).
  const row = input.notes || null
  const n = (row && row.notes) || {}
  // Notes laid under today's row from an earlier day are still that earlier day's notes.
  const notesDate = row ? str(row.borrowedFrom || row.reportDate) : ''
  const taskNotes = n.tasks || {}

  // ---- tasks ----
  const groups = GROUPS.map((g) => ({ key: g.key, title: g.title, items: [] }))
  const groupByKey = Object.fromEntries(groups.map((g) => [g.key, g]))
  const timedTasks = []
  for (const t of input.tasks || []) {
    if (!t || (t.done && !checked.has(t.id))) continue
    const key = groupOf(t, dateISO, projectIds)
    if (!key) continue
    const p = t.projectId ? byId.get(t.projectId) : null
    const late = daysBetween(t.dueDate, dateISO)
    const at = t.dueDate === dateISO ? parseClock(t.dueTime) : null
    const note = taskNotes[t.id] || null
    const item = {
      id: t.id,
      title: str(t.title).trim() || '(untitled task)',
      done: checked.has(t.id),
      late,
      lateLabel: late > 0 ? `${plural(late, 'day')} late` : '',
      timeLabel: at != null ? clock(at) : '',
      projectId: p ? p.id : '',
      projectName: p ? str(p.client).trim() : '',
      projectLine: p ? projectLine(p, dateISO, input.stageNames) : '',
      how: note ? tidy(note.how) : '',
      send: note ? tidy(note.send) : '',
    }
    groupByKey[key].items.push(item)
    if (at != null) timedTasks.push({ item, at })
  }
  const order = (a, b) => b.late - a.late || a.projectName.localeCompare(b.projectName) || a.title.localeCompare(b.title)
  for (const g of groups) g.items.sort(order)
  const openCount = (keys) => groups.filter((g) => keys.includes(g.key)).reduce((s, g) => s + g.items.filter((i) => !i.done).length, 0)
  const overdue = openCount(['overdueProject', 'overdueOwn'])
  const dueToday = openCount(['todayProject', 'todayOwn'])

  // ---- the two standing flags: new inquiries, and projects with nothing scheduled ----
  // A task ticked off on this screen still counts as open until he leaves, like everywhere else on
  // the page, so a project does not jump into the "no task" list while he is reading.
  const hasOpenTask = new Set()
  for (const t of input.tasks || []) if (t && t.projectId && (!t.done || checked.has(t.id))) hasOpenTask.add(t.projectId)
  const inquiryNotes = n.inquiries || {}
  const live = projects.filter((p) => p.bucket === 'active')
  const inquiries = live
    .filter((p) => p.stageId === INQUIRY_STAGE)
    .map((p) => {
      const waited = isISO(p.leadDate) ? Math.max(0, daysBetween(p.leadDate, dateISO)) : null
      return {
        id: p.id,
        name: str(p.client).trim() || '(no name)',
        line: projectLine(p, dateISO, null),
        where: str(p.eventLocation).trim(),
        source: str(p.bookingSource).trim(),
        waited,
        waitedLabel: waited == null ? '' : waited === 0 ? 'Came in today' : waited === 1 ? 'Came in yesterday' : `Waiting ${waited} days`,
        note: tidy(inquiryNotes[p.id]),
      }
    })
    // Longest wait first, the same way the tasks put the most overdue first.
    .sort((a, b) => (b.waited == null ? -1 : b.waited) - (a.waited == null ? -1 : a.waited) || a.name.localeCompare(b.name))
  const noTask = live
    .filter((p) => p.stageId !== INQUIRY_STAGE && !hasOpenTask.has(p.id))
    .sort((a, b) => str(a.eventDate || '9999').localeCompare(str(b.eventDate || '9999')) || str(a.client).localeCompare(str(b.client)))
    .map((p) => ({ id: p.id, name: str(p.client).trim() || '(no name)', line: projectLine(p, dateISO, input.stageNames) }))

  // ---- timeline ----
  const placed = placeEvents(input.events, dateISO)
  const blocks = [
    { id: 'routine', startMin: ROUTINE.wake, endMin: ROUTINE.deskAt, title: 'Work out and get ready', kind: 'routine', where: '' },
    ...placed.timed,
    ...timedTasks.map(({ item, at }) => ({
      id: 'task-' + item.id, startMin: at, endMin: Math.min(1440, at + TIMED_TASK_MIN),
      title: item.projectName ? `${item.title}: ${item.projectName}` : item.title, kind: 'task', where: '', projectId: item.projectId,
    })),
  ].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin)
  assignLanes(blocks)
  const scheduled = blocks.filter((b) => b.kind !== 'routine')
  const firstMin = Math.min(ROUTINE.wake, ...blocks.map((b) => b.startMin))
  const lastMin = Math.max(...blocks.map((b) => b.endMin), 0)
  const startMin = Math.floor(firstMin / 60) * 60
  // Through 9:00 PM by default, so the whole day reads at a glance; later when something runs late.
  const endMin = Math.min(1440, Math.max(21 * 60, Math.ceil((lastMin + 30) / 60) * 60))

  // ---- the facts line ----
  const facts = []
  if (overdue || dueToday) {
    facts.push(overdue && dueToday ? `${overdue} overdue and ${dueToday} due today.` : overdue ? `${plural(overdue, 'overdue task')}.` : `${plural(dueToday, 'task')} due today.`)
  } else {
    facts.push('No tasks due. The list is clear.')
  }
  if (scheduled.length) {
    const first = scheduled[0]
    facts.push(`${plural(scheduled.length, 'thing')} on the schedule, the first at ${clock(first.startMin)}.`)
  } else {
    facts.push('Nothing with a set time today.')
  }
  if (input.unreadMail != null && input.unreadMail > 0) facts.push(`${plural(input.unreadMail, 'unread client email')}.`)
  if (inquiries.length) facts.push(`${plural(inquiries.length, 'new inquiry', 'new inquiries')} waiting on a first reply.`)
  if (noTask.length) facts.push(`${plural(noTask.length, 'project')} ${noTask.length === 1 ? 'has' : 'have'} no task.`)
  const booked = new Set(input.bookedStageIds || [])
  const nextShow = projects
    .filter((p) => p.bucket === 'active' && booked.has(p.stageId) && isISO(p.eventDate) && p.eventDate >= dateISO)
    .sort((a, b) => (a.eventDate < b.eventDate ? -1 : 1))[0]
  if (nextShow) {
    const d = daysBetween(dateISO, nextShow.eventDate)
    facts.push(`Next show: ${str(nextShow.client).trim()}, ${d === 0 ? 'today' : d === 1 ? 'tomorrow' : `${longDate(nextShow.eventDate, false)} (in ${d} days)`}.`)
  }

  // ---- Claude's notes ----
  const noted = groups.reduce((s, g) => s + g.items.filter((i) => i.how || i.send).length, 0)
  const total = groups.reduce((s, g) => s + g.items.length, 0)
  // Tasks Claude has not SEEN (added after the notes were written). A task it saw and left without
  // a note, because the title says it all, is not missing anything.
  const covered = new Set(Array.isArray(n.covered) ? n.covered : Object.keys(taskNotes))
  const unseen = row && row.notes ? groups.reduce((s, g) => s + g.items.filter((i) => !i.done && !covered.has(i.id)).length, 0) : 0
  let notesState = 'none' // none | asked | writing | fresh | old | error
  if (row && row.status === 'requested') notesState = 'asked' // the phone asked; the Mac has not started
  else if (row && row.status === 'writing') notesState = 'writing'
  else if (row && row.status === 'error' && row.reportDate === dateISO && (notesDate !== dateISO || (!n.briefing && !noted))) notesState = 'error'
  else if (row && (n.briefing || n.focus || noted)) notesState = notesDate === dateISO ? 'fresh' : 'old'
  const focus = n.focus && str(n.focus.title).trim()
    ? { title: tidy(n.focus.title), why: tidy(n.focus.why), firstStep: tidy(n.focus.firstStep) }
    : null
  const alsoOpen = (Array.isArray(n.alsoOpen) ? n.alsoOpen : [])
    .map((x) => ({ title: tidy(x && x.title), why: tidy(x && x.why) }))
    .filter((x) => x.title)
    .slice(0, 3)

  return {
    dateISO,
    dateLabel: longDate(dateISO, false),
    year: dateISO.slice(0, 4),
    facts,
    briefing: tidy(n.briefing),
    groups,
    inquiries,
    noTask,
    counts: { overdue, dueToday, total, noted, unseen, inquiries: inquiries.length, noTask: noTask.length },
    timeline: { startMin, endMin, blocks, allDay: placed.allDay, deskAt: ROUTINE.deskAt },
    focus,
    alsoOpen,
    plate: (input.plate || []).map((x) => ({ text: str(x.text).trim(), depth: Number(x.depth) || 0 })).filter((x) => x.text),
    notes: {
      state: notesState,
      generatedAt: row ? str(row.generatedAt) : '',
      reportDate: notesDate,
      error: row ? str(row.error) : '',
      // Older notes are on the page under a newer request, a write in progress, or a failed write.
      showingOld: !!(n.briefing || n.focus || noted) && notesDate !== dateISO,
    },
  }
}

// ---------------------------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------------------------

function esc(s) {
  return str(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
// Claude's prose may arrive as a few paragraphs.
function paras(text, cls) {
  return str(text).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((p) => `<p class="${cls}">${esc(p).replace(/\n/g, '<br>')}</p>`).join('')
}
function timeOfDay(iso) {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : clock(d.getHours() * 60 + d.getMinutes())
}

const PX_PER_MIN = 0.65 // 39px to the hour: half hours still read clearly, and 6 AM to 9 PM is under 600px tall

const KIND_LABEL = { gig: 'Show', call: 'Call', mastermind: 'Mastermind', personal: 'Personal', work: 'Calendar', task: 'Task', routine: '' }

const CSS = `
:root{--ink:#14171b;--muted:#545b64;--faint:#8a919b;--line:#dfe3e8;--soft:#f3f5f8;--navy:#18295f;--navy-soft:#e9edf7;--gold:#b8923c;--gold-soft:#faf3e1;--red:#b42318;--red-soft:#fdf0ee;--blue:#2563eb;--paper:#fff;--ground:#eef0f3;
  --display:'Fraunces',Georgia,'Times New Roman',serif;--sans:'Hanken Grotesk',-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--ground);color:var(--ink);font:400 14px/1.5 var(--sans);-webkit-font-smoothing:antialiased}
.sheet{max-width:1120px;margin:20px auto 40px;background:var(--paper);border-radius:6px;box-shadow:0 1px 2px rgba(20,23,27,.08),0 12px 32px -18px rgba(20,23,27,.28);border-top:6px solid var(--navy);padding:30px 36px 36px}
h1,h2,h3,p,ul{margin:0}
ul{padding:0;list-style:none}

/* ---- top: the date, and where things stand ---- */
.top{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,7fr);gap:8px 40px;align-items:start;padding-bottom:22px;border-bottom:1px solid var(--line)}
.date{font:500 40px/1.05 var(--display);letter-spacing:-.01em;color:var(--navy);text-wrap:balance}
.doc{margin-top:8px;font-size:13px;color:var(--muted)}
.facts{font-size:14.5px;line-height:1.55;color:var(--ink)}
.brief{margin-top:8px;font-size:14px;line-height:1.6;color:var(--muted);max-width:68ch}
.brief+.brief{margin-top:6px}
.after{margin-top:14px;font-size:14px;line-height:1.5;color:var(--ink)}
.after b{font-weight:600;color:var(--navy)}

/* The schedule is a block at the top right and the task list wraps around it: beside it at first,
   then the full width of the page. It does NOT follow the scroll (he tried that and dropped it,
   2026-11-11: it "is causing everything else to have less space, so it's more crammed into more of
   a vertical thing"). Every row is its own grid or flex box, so a row beside the schedule narrows
   instead of running underneath it. */
.cols{display:block}
.cols::after{content:"";display:block;clear:both}
.day{float:right;width:300px;margin:22px 0 20px 38px}
.tasks{padding-top:22px}
.next{margin-top:28px}
h2{font:600 19px/1.2 var(--display);color:var(--ink)}
.lede{margin-top:3px;font-size:12.5px;color:var(--muted)}

/* ---- tasks ---- */
.group{margin-top:20px}
.group:first-of-type{margin-top:16px}
.gh{display:flex;align-items:baseline;gap:9px;padding-bottom:6px;border-bottom:2px solid var(--ink)}
.gh .n{font:600 13px/1 var(--sans);font-variant-numeric:tabular-nums;color:var(--paper);background:var(--ink);border-radius:3px;padding:3px 6px}
.gh h3{font:600 14.5px/1.2 var(--sans)}
.gh .c{margin-left:auto;font-size:12.5px;color:var(--muted);font-variant-numeric:tabular-nums}
.group.late .gh{border-color:var(--red)}
.group.late .gh .n{background:var(--red)}
/* What it is on the left, how to handle it on the right: half the height of stacking them. */
.task{display:grid;grid-template-columns:20px minmax(0,34%) minmax(0,1fr);gap:0 14px;padding:10px 0;border-bottom:1px solid var(--line);break-inside:avoid}
.box{appearance:none;-webkit-appearance:none;width:17px;height:17px;margin:2px 0 0;border:1.5px solid #7a828c;border-radius:3px;background:#fff;cursor:pointer;padding:0;display:block}
.box:hover{border-color:var(--blue)}
.box:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
.task.done .box{background:var(--ink);border-color:var(--ink);background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M3.5 8.5l3 3 6-7' fill='none' stroke='%23fff' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")}
.tt{font-weight:600;font-size:14.5px;line-height:1.35}
.task.done .tt,.task.done .how,.task.done .send{text-decoration:line-through;color:var(--faint)}
.who{font-weight:400;color:var(--muted)}
.who b{font-weight:600;color:var(--navy)}
.meta{margin-top:1px;font-size:12.5px;color:var(--muted)}
.meta .late{color:var(--red);font-weight:600}
.meta .at{color:var(--navy);font-weight:600}
.how{font-size:13.5px;line-height:1.5;color:#2a2f36;max-width:74ch}
.send{font-size:13.5px;line-height:1.5;color:#2a2f36;max-width:74ch}
.how+.send{margin-top:4px}
.send b{font-weight:600}
.none{padding:10px 0;font-size:13px;color:var(--faint);border-bottom:1px solid var(--line)}
/* The two standing lists (new inquiries, projects with no task): task rows without a checkbox. */
.tasks h2:not(:first-child){margin-top:30px}
.flags{margin-top:12px;border-top:2px solid var(--ink)}
.dot{width:7px;height:7px;margin:7px 0 0 5px;border-radius:50%;background:var(--gold)}
.quiet-line{color:var(--muted)}
.clear{margin-top:16px;padding:16px 18px;background:var(--soft);border-radius:5px;font-size:14px;color:var(--muted)}

/* ---- the day ---- */
.allday{margin-top:10px;font-size:13px;color:var(--muted)}
.allday b{font-weight:600;color:var(--ink)}
.tl{position:relative;margin-top:14px}
.hr{position:absolute;left:0;right:0;border-top:1px solid var(--line)}
.hr.half{left:50px;border-top:1px dotted #e3e7ec}
.hr span{position:absolute;left:0;top:-8px;width:42px;text-align:right;font-size:11.5px;line-height:16px;color:var(--faint);font-variant-numeric:tabular-nums;background:var(--paper)}
.lane{position:absolute;left:50px;right:0;top:0;bottom:0}
.blk{position:absolute;overflow:hidden;border-radius:4px;padding:3px 8px 3px 9px;font-size:12.5px;line-height:1.3;border-left:3px solid var(--navy);background:var(--navy-soft);color:var(--ink)}
.blk .t{font-weight:600;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:1;overflow-wrap:anywhere}
.blk .w{font-size:11.5px;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.blk.routine{background:repeating-linear-gradient(135deg,#f3f5f8 0 6px,#fafbfc 6px 12px);border-left-color:#b6bdc7;color:var(--muted)}
.blk.gig{background:var(--navy);border-left-color:var(--gold);color:#fff}
.blk.gig .w{color:#cfd6ea}
.blk.personal{background:var(--gold-soft);border-left-color:var(--gold)}
.blk.task{background:#fff;border:1px solid #b9c3dc;border-left:3px solid var(--blue)}
.blk.short{padding-top:0;padding-bottom:0;display:flex;gap:7px;align-items:center}
.blk.short .w{flex:none}
.blk.short .t{display:block;white-space:nowrap;text-overflow:ellipsis;min-width:0}
.desk{position:absolute;left:50px;right:0;border-top:2px solid var(--ink)}
.desk span{position:absolute;right:0;top:3px;font-size:11.5px;font-weight:600;color:var(--ink);background:var(--paper);padding-left:6px}
.now{position:absolute;left:44px;right:0;border-top:2px solid var(--red);z-index:3}
.now::before{content:"";position:absolute;left:-4px;top:-5px;width:8px;height:8px;border-radius:50%;background:var(--red)}
.quiet{margin-top:10px;font-size:12.5px;color:var(--faint)}

/* ---- after the tasks ---- */
.next{display:flow-root;container-type:inline-size;border:1px solid var(--line);border-left:4px solid var(--gold);border-radius:5px;padding:18px 20px 18px 20px;background:#fff}
@container (min-width:700px){
  .nx{display:grid;grid-template-columns:minmax(0,11fr) minmax(0,9fr);gap:0 40px;align-items:start}
  .nx-b .also{margin-top:12px}
  .nx-b .plate:first-child{margin-top:12px;padding-top:0;border-top:0}
}
.focus{margin-top:12px;font:500 25px/1.2 var(--display);color:var(--navy);letter-spacing:-.005em}
.why{margin-top:8px;font-size:14px;line-height:1.6;max-width:66ch}
.step{margin-top:10px;font-size:14px;line-height:1.55;padding:9px 12px;background:var(--gold-soft);border-radius:4px;max-width:66ch}
.step b{font-weight:600}
.also{margin-top:14px;font-size:13.5px;color:var(--muted)}
.also li{margin-top:4px;max-width:66ch}
.also b{font-weight:600;color:var(--ink)}
.plate{margin-top:16px;padding-top:12px;border-top:1px solid var(--line)}
.plate h4{margin:0;font:600 13px/1.3 var(--sans);color:var(--ink)}
.plate ul{margin-top:6px;columns:2 190px;column-gap:28px;font-size:13px;color:var(--muted)}
.plate li{break-inside:avoid;padding:1.5px 0}
.plate li.d1{padding-left:14px}.plate li.d2{padding-left:28px}.plate li.d3{padding-left:42px}

.foot{margin-top:26px;padding-top:12px;border-top:1px solid var(--line);font-size:12px;color:var(--faint)}
.foot.warn{color:var(--red)}

/* Screen only: a printed page is narrower than this and must keep the wide layout. */
@media screen and (max-width:820px){
  body{background:var(--paper)}
  .sheet{margin:0;border-radius:0;box-shadow:none;padding:20px 18px 32px}
  .top{grid-template-columns:1fr;gap:12px}
  .date{font-size:31px}
  /* One column, in his order: the tasks, then the day, then the project. */
  .cols{display:flex;flex-direction:column}
  .cols::after{display:none}
  .tasks{order:1}
  .day{order:2;float:none;width:auto;margin:30px 0 0}
  .next{order:3}
  .box{width:22px;height:22px;margin-top:0}
  .task{grid-template-columns:26px minmax(0,1fr);padding:12px 0}
  .notes{grid-column:2;margin-top:5px}
  .notes:empty{display:none}
  .plate ul{columns:1}
}
@media print{
  @page{size:letter;margin:.5in}
  body{background:#fff;font-size:11.5px}
  .sheet{max-width:none;margin:0;padding:14px 0 0;box-shadow:none;border-radius:0;border-top-width:4px}
  .top{padding-bottom:12px}
  .date{font-size:30px}
  .facts{font-size:12px}.brief{font-size:11.5px}.after{font-size:12px;margin-top:10px}
  /* The same layout as the screen, at paper size: the schedule at the top right of page one, the
     list beside it and then the full width of every later page. */
  .day{width:226px;margin:14px 0 12px 24px}
  .tl{zoom:.86}
  .tasks{padding-top:14px}
  .task{grid-template-columns:16px minmax(0,34%) minmax(0,1fr);gap:0 10px}
  .gh,.tasks h2,.tasks .lede{break-after:avoid}
  .tasks h2:not(:first-child){margin-top:18px}
  .dot{width:5px;height:5px;margin:5px 0 0 4px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .clear{display:flow-root}
  .tt{font-size:12px}.how,.send{font-size:11px}.meta{font-size:10.5px}
  .task{padding:6px 0}
  .box{width:13px;height:13px;border-color:#14171b;cursor:default}
  .group{margin-top:12px}
  .now{display:none}
  .next{margin-top:16px;break-inside:avoid}
  .focus{font-size:19px}
  .plate ul{font-size:11px}
  .foot{margin-top:16px;font-size:10px}
  .blk,.gh .n,.step,.task.done .box{-webkit-print-color-adjust:exact;print-color-adjust:exact}
}
`

function taskHtml(t) {
  const meta = []
  if (t.timeLabel) meta.push(`<span class="at">At ${esc(t.timeLabel)}</span>`)
  if (t.lateLabel) meta.push(`<span class="late">${esc(t.lateLabel)}</span>`)
  if (t.projectLine) meta.push(esc(t.projectLine))
  // The project is NAMED, never linked (see the note above renderReportHtml).
  const who = t.projectName ? ` <span class="who">for <b>${esc(t.projectName)}</b></span>` : ''
  return `<li class="task${t.done ? ' done' : ''}">
<button type="button" class="box" data-task="${esc(t.id)}" role="checkbox" aria-checked="${t.done ? 'true' : 'false'}" aria-label="Done: ${esc(t.title)}"></button>
<div class="what"><div class="tt">${esc(t.title)}${who}</div>${meta.length ? `<div class="meta">${meta.join('. ')}</div>` : ''}</div>
<div class="notes">${t.how ? `<p class="how">${esc(t.how)}</p>` : ''}${t.send ? `<p class="send"><b>Send:</b> ${esc(t.send)}</p>` : ''}</div>
</li>`
}

// A new inquiry: who and what on the left, Claude's recommendation on the right. No checkbox: it is
// not a task, and it leaves this list when he moves the project out of the Inquiry stage.
function inquiryHtml(q) {
  const meta = []
  if (q.waitedLabel) meta.push(q.waited >= 2 ? `<span class="late">${esc(q.waitedLabel)}</span>` : esc(q.waitedLabel))
  if (q.line) meta.push(esc(q.line))
  if (q.where) meta.push(esc(q.where))
  if (q.source) meta.push(esc(`From ${q.source}`))
  return `<li class="task flag"><span class="dot" aria-hidden="true"></span>
<div class="what"><div class="tt">${esc(q.name)}</div>${meta.length ? `<div class="meta">${meta.join('. ')}</div>` : ''}</div>
<div class="notes">${q.note ? `<p class="how">${esc(q.note)}</p>` : ''}</div>
</li>`
}
// A project with nothing scheduled: its name, and where it stands.
function noTaskHtml(x) {
  return `<li class="task flag"><span class="dot" aria-hidden="true"></span>
<div class="what"><div class="tt">${esc(x.name)}</div></div>
<div class="notes">${x.line ? `<p class="how quiet-line">${esc(x.line)}</p>` : ''}</div>
</li>`
}

function timelineHtml(tl, dateISO) {
  const H = (m) => Math.round((m - tl.startMin) * PX_PER_MIN)
  const height = H(tl.endMin)
  // The data attributes let the page's own script draw the "now" line and keep it moving.
  let out = `<div class="tl" style="height:${height + 8}px" data-date="${esc(dateISO)}" data-start="${tl.startMin}" data-end="${tl.endMin}" data-scale="${PX_PER_MIN}">`
  for (let m = tl.startMin; m <= tl.endMin; m += 30) {
    const hour = m % 60 === 0
    out += `<div class="hr${hour ? '' : ' half'}" style="top:${H(m)}px">${hour ? `<span>${esc(clock(m).replace(':00', ''))}</span>` : ''}</div>`
  }
  out += '<div class="lane">'
  for (const b of tl.blocks) {
    const top = H(b.startMin)
    const h = Math.max(18, H(b.endMin) - top - 2)
    const w = 100 / (b.lanes || 1)
    const when = clockRange(b.startMin, b.endMin)
    const place = `top:${top + 1}px;height:${h}px;left:calc(${w * (b.lane || 0)}% + ${(b.lane || 0) ? 2 : 0}px);width:calc(${w}% - ${(b.lanes || 1) > 1 ? 2 : 0}px)`
    if (h < 38) {
      // Under 45 minutes there is one line: the start time, then as much of the title as fits.
      out += `<div class="blk ${b.kind} short" style="${place}"><span class="w">${esc(clock(b.startMin))}</span><span class="t">${esc(b.title)}</span></div>`
      continue
    }
    // Taller blocks: the title wraps for as many lines as the block has room for, above its times.
    const lines = Math.max(1, Math.floor((h - 8) / 16) - 1)
    const sub = [when, b.where && h > 60 ? b.where : ''].filter(Boolean).join(', ')
    out += `<div class="blk ${b.kind}" style="${place}"><div class="t" style="-webkit-line-clamp:${lines}">${esc(b.title)}</div><div class="w">${esc(sub)}</div></div>`
  }
  out += '</div>'
  if (tl.deskAt > tl.startMin && tl.deskAt < tl.endMin) out += `<div class="desk" style="top:${H(tl.deskAt)}px"><span>At the computer</span></div>`
  return out + '</div>'
}

function notesLine(model) {
  const s = model.notes
  const old = s.showingOld && s.reportDate ? ` The notes on this page are from ${longDate(s.reportDate, false)}.` : ''
  if (s.state === 'asked') return { text: `Your Mac has been asked to write today’s notes. It writes them as soon as Bloom CRM is open there, and they appear here on their own.${old}`, warn: false }
  if (s.state === 'writing') return { text: `Claude is writing today’s notes. They appear here on their own, usually within a couple of minutes.${old}`, warn: false }
  if (s.state === 'error') return { text: `Claude could not write today’s notes: ${s.error || 'no reason given'}.${old || ' The tasks and the schedule above are complete without them.'}`, warn: true }
  if (s.state === 'fresh') {
    const missing = model.counts.unseen
    return { text: `Notes written by Claude at ${timeOfDay(s.generatedAt)}.${missing > 0 ? ` ${plural(missing, 'task')} added since then ${missing === 1 ? 'has' : 'have'} no note yet.` : ''} The tasks and the schedule are always live.`, warn: false }
  }
  if (s.state === 'old') return { text: `These notes are from ${longDate(s.reportDate, false)}. Today’s have not been written yet. The tasks and the schedule are live.`, warn: false }
  return { text: 'Claude has not written notes for today yet. The tasks and the schedule are complete without them.', warn: false }
}

// The whole report as ONE self-contained HTML document.
//
// ⚠️ IT IS A SIMPLE DOCUMENT, NOT A SCREEN OF THE APP (Michael, 2026-11-11): "I just want it to
// basically generate a document for me that I can reference, whether that be like a PDF I can pull
// up on my computer or something I want to print... I don't want it to be so embedded in the app."
//   - NO LINKS, of any kind. Not to projects ("the whole ability to click on a project and it takes
//     me there is not really needed"), and not within the page. This document is shown from a
//     `srcdoc` frame, where even href="#next" resolves against the APP's address and loads the whole
//     CRM inside the report ("a report inside of a report... up until infinity"). That happened.
//   - NO HOVER TOOLTIPS. Anything worth saying is printed on the page.
//   - THE ONE INTERACTIVE THING IS THE CHECKBOX, which he asked to keep: "I do want to maintain the
//     ability to click a checkbox and it completely crosses off everything." On paper it is an empty
//     box to tick with a pen. Clicking one posts { source: 'daily-report', type: 'toggle-task', id, done }
//     to the page that framed it, and the document draws the tick itself, at once, so the app never
//     has to rebuild the page for it.
//   - IT MUST PRINT WELL AS IT IS. There is no Print button in the CRM, by his choice ("I don't need
//     the CRM to connect to my printer"); the Mac's "Open as PDF" runs this same document through the
//     print styles below.
//   - THE SCHEDULE DOES NOT FOLLOW THE SCROLL. It did at first, and he dropped it the same day: a
//     column held open down the whole page left the tasks "crammed into more of a vertical thing".
//     It is a block at the top right; the list wraps around it and then runs the full width. Do not
//     bring back `position: sticky` here.
// The red "now" line is the document's own too: it places itself and moves every minute.
export function renderReportHtml(model) {
  const hasTasks = model.counts.total > 0
  let n = 0
  const groupsHtml = model.groups
    .map((g) => {
      n += 1
      if (!g.items.length) return ''
      const open = g.items.filter((i) => !i.done).length
      return `<section class="group${g.key.startsWith('overdue') ? ' late' : ''}"><div class="gh"><span class="n">${n}</span><h3>${esc(g.title)}</h3><span class="c">${open}</span></div><ul>${g.items.map(taskHtml).join('')}</ul></section>`
    })
    .join('')

  const tl = model.timeline
  const allDay = tl.allDay.length ? `<p class="allday"><b>All day:</b> ${tl.allDay.map((a) => esc(a.title)).join(', ')}</p>` : ''
  const scheduled = tl.blocks.filter((b) => b.kind !== 'routine').length

  // Left: the one project to work on. Right: the fallbacks and his own list.
  let nextA = '', nextB = ''
  if (model.focus) {
    nextA += `<p class="focus">${esc(model.focus.title)}</p>${paras(model.focus.why, 'why')}`
    if (model.focus.firstStep) nextA += `<p class="step"><b>Start with:</b> ${esc(model.focus.firstStep)}</p>`
    if (model.alsoOpen.length) {
      nextB += `<div class="also">If that one is blocked:<ul>${model.alsoOpen.map((a) => `<li><b>${esc(a.title)}.</b> ${esc(a.why)}</li>`).join('')}</ul></div>`
    }
  } else {
    nextA += `<p class="why">Claude picks one of these for the day once the notes are written. Until then, this is your own list.</p>`
  }
  if (model.plate.length) {
    nextB += `<div class="plate"><h4>On my plate</h4><ul>${model.plate.map((p) => `<li class="d${Math.min(3, p.depth)}">${esc(p.text)}</li>`).join('')}</ul></div>`
  }
  const next = `<div class="nx"><div class="nx-a">${nextA}</div>${nextB ? `<div class="nx-b">${nextB}</div>` : ''}</div>`

  const foot = notesLine(model)

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Daily report, ${esc(model.dateLabel)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400..600&family=Hanken+Grotesk:wght@400;500;600;700&display=swap">
<style>${CSS}</style></head>
<body><main class="sheet">
<header class="top">
<div><h1 class="date">${esc(model.dateLabel)}</h1><p class="doc">Daily report, ${esc(model.year)}</p>${model.focus ? `<p class="after">After the tasks: <b>${esc(model.focus.title)}</b></p>` : ''}</div>
<div><p class="facts">${model.facts.map(esc).join(' ')}</p>${paras(model.briefing, 'brief')}</div>
</header>
<div class="cols">
<section class="day" aria-label="Schedule"><h2>The day</h2><p class="lede">${scheduled ? 'Everything with a set time, from every calendar.' : 'Nothing has a set time today.'}</p>
${allDay}${timelineHtml(tl, model.dateISO)}
</section>
<section class="tasks" aria-label="Tasks">
${model.inquiries.length ? `<h2>New inquiries</h2><p class="lede">Still in the Inquiry stage, so you have not reached out to ${model.inquiries.length === 1 ? 'this one' : 'these'} yet.</p><ul class="flags">${model.inquiries.map(inquiryHtml).join('')}</ul>` : ''}
<h2>Tasks</h2><p class="lede">No set time. Work down the list in this order.</p>
${hasTasks ? groupsHtml : '<p class="clear">Nothing is overdue and nothing is due today. Straight to the project below.</p>'}
${model.noTask.length ? `<h2>No task scheduled</h2><p class="lede">${model.noTask.length === 1 ? 'This project has' : 'These projects have'} nothing scheduled, so nothing will bring ${model.noTask.length === 1 ? 'it' : 'them'} back up. Add a task to each.</p><ul class="flags">${model.noTask.map(noTaskHtml).join('')}</ul>` : ''}
</section>
<section class="next" aria-label="After the tasks"><h2>After the tasks</h2>
${next}
</section>
</div>
<p class="foot${foot.warn ? ' warn' : ''}">${esc(foot.text)}</p>
</main>
<script>
document.addEventListener('click', function (e) {
  var el = e.target && e.target.closest ? e.target.closest('[data-task]') : null
  if (!el) return
  var row = el.closest('.task')
  var done = row ? row.classList.toggle('done') : false
  el.setAttribute('aria-checked', done ? 'true' : 'false')
  // The message carries the box's NEW state, so the app never has to work it out from what it
  // last knew (two quick clicks used to be read as done twice, and the task stayed done).
  try { window.parent.postMessage({ source: 'daily-report', type: 'toggle-task', id: el.getAttribute('data-task'), done: done }, '*') } catch (err) {}
})
;(function () {
  var tl = document.querySelector('.tl')
  if (!tl) return
  var line = null
  function place() {
    var d = new Date()
    var today = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
    var now = d.getHours() * 60 + d.getMinutes()
    var start = Number(tl.getAttribute('data-start')), end = Number(tl.getAttribute('data-end'))
    var show = today === tl.getAttribute('data-date') && now >= start && now <= end
    if (!show) { if (line) { line.remove(); line = null } return }
    if (!line) { line = document.createElement('div'); line.className = 'now'; line.setAttribute('aria-label', 'Now'); tl.appendChild(line) }
    line.style.top = Math.round((now - start) * Number(tl.getAttribute('data-scale'))) + 'px'
  }
  place()
  setInterval(place, 60000)
})()
</script>
</body></html>`
}
