// THE DAILY REPORT, on the Mac (2026-11-11). The page itself and its rules are
// mobile/dailyreport-core.js; read the top of that file first.
//
// This file does the two things only a server can:
//
//   1. THE DAY'S CALENDAR, from EVERY calendar on the account (Work, Gigs, the two personal ones,
//      the Mastermind feed, holidays). The Calendar page only reads Work and Gigs; the report is "my
//      whole day", so a date night or a Mastermind call belongs on it. The cloud's twin of this is
//      the `daily-events` action in supabase/functions/phone-api. Same shape out of both.
//
//   2. CLAUDE'S NOTES. One call to the local Claude Code CLI (his subscription, no API bill, the same
//      arrangement as crm-claude.mjs) writes, for the day: how to handle each task and what to send,
//      a short read on where things stand, and the larger project to work on once the tasks are
//      done. Saved to `daily_reports`, so the phone shows the same notes.
//
// ⚠️ THE NOTES ARE ADVICE, NEVER ACTION. Nothing here sends, drafts, moves a stage or completes a
// task. The writer is given no tools at all: everything it knows is in the prompt this file builds.
//
// WHY THE PHONE CANNOT WRITE THEM ITSELF. The writer needs the Claude CLI and his planning files,
// and both live on this Mac. So the phone ASKS: it sets a row to `requested`, and the Mac picks it up
// (serveRequests, called whenever the data changes). With the Mac off the phone still gets the full
// report, with the last notes written, and says so.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { google } from 'googleapis'
import { authedClient } from './crm-gmail.mjs'
import { isCalendarConnected } from './crm-calendar.mjs'
import { RECORDS_DIR, loadAll, loadTasks, loadStructure } from './crm-data-core.mjs'
import { CRM_STORE, sb, getCachedCalendarMap, getCachedInvoices } from './crm-store.mjs'
import { contactsForProject, emailsForProject } from './crm-links.mjs'
import { searchThreads, isConnected as gmailConnected } from './crm-gmail.mjs'
import { loadHomeList } from './crm-home-list.mjs'
import { proposalsOverview } from './crm-proposals.mjs'
import { GROUPS, groupOf, placeEvents, dayBounds, localToday, longDate, clock, clockRange, daysBetween, tidy, ROUTINE } from './mobile/dailyreport-core.js'

const CRM_MARKER = 'Synced from Magic CRM'
const DIR = path.dirname(fileURLToPath(import.meta.url))
const BUSINESS_DIR = path.dirname(RECORDS_DIR)
const CLAUDE_HOME = path.dirname(BUSINESS_DIR) // ~/Desktop/Claude
const MEMORY_DIR = path.join(os.homedir(), '.claude', 'projects', '-Users-michaelbloemeke', 'memory')
const CLAUDE_BIN = path.join(os.homedir(), '.local', 'bin', 'claude')
// The model that writes the notes. Sonnet 5.5 is the newest model his installed Claude Code CLI
// (2.1.175) accepts; Opus 5.5 needs CLI 2.1.280 or newer ("claude update"). Checked 2026-11-11.
const MODEL = 'claude-sonnet-5-5'
const WRITE_TIMEOUT_MS = 6 * 60 * 1000

const str = (v) => (v == null ? '' : String(v))
const clip = (v, n) => {
  const t = str(v).replace(/\s+\n/g, '\n').trim()
  return t.length > n ? t.slice(0, n).trimEnd() + ' [...]' : t
}

// ---------------------------------------------------------------------------------------------
// 1. The day's calendar
// ---------------------------------------------------------------------------------------------

// Every event between two instants, from every calendar he has switched on, in the plain shape
// dailyreport-core.js's placeEvents reads. Never throws: a calendar that fails is skipped and named.
export async function dayEvents(fromISO, toISO) {
  if (!isCalendarConnected()) return { ok: false, events: [], reason: 'not-connected' }
  let map = { projects: {}, tasks: {} }
  try {
    if (CRM_STORE === 'supabase') map = getCachedCalendarMap() || map
  } catch {
    // cache not primed: the marker check below still recognises CRM events
  }
  const taskIds = new Set(Object.values(map.tasks || {}).map(String))
  const projectIds = new Set(Object.values(map.projects || {}).map(String))
  const cal = google.calendar({ version: 'v3', auth: authedClient() })
  const events = []
  const errors = []
  const seen = new Set()
  let calendars = []
  try {
    calendars = (await cal.calendarList.list({ maxResults: 250 })).data.items || []
  } catch (e) {
    return { ok: false, events: [], error: str(e?.message || e) }
  }
  for (const c of calendars) {
    if (c.hidden || c.deleted || c.selected === false) continue // a calendar he has unticked stays out
    const name = str(c.summaryOverride || c.summary).trim()
    try {
      const res = await cal.events.list({ calendarId: c.id, timeMin: fromISO, timeMax: toISO, singleEvents: true, orderBy: 'startTime', maxResults: 250 })
      for (const e of res.data.items || []) {
        if (e.status === 'cancelled') continue
        if (e.eventType === 'workingLocation' || e.eventType === 'focusTime') continue
        if ((e.attendees || []).some((a) => a.self && a.responseStatus === 'declined')) continue
        const allDay = !!e.start?.date
        // The same event can sit on two of his calendars (an invite on Work and on Personal Gmail).
        const key = `${e.iCalUID || e.id}|${e.start?.dateTime || e.start?.date || ''}`
        if (seen.has(key)) continue
        seen.add(key)
        const marked = str(e.description).includes(CRM_MARKER)
        const crm = taskIds.has(str(e.id)) ? 'task' : projectIds.has(str(e.id)) ? 'project' : marked ? (name.toLowerCase() === 'gigs' ? 'project' : 'task') : ''
        events.push({
          id: str(e.id),
          calendar: name,
          title: str(e.summary) || '(untitled)',
          allDay,
          start: allDay ? '' : str(e.start?.dateTime),
          end: allDay ? '' : str(e.end?.dateTime),
          startDate: allDay ? str(e.start?.date) : '',
          endDate: allDay ? str(e.end?.date) : '',
          busy: e.transparency !== 'transparent',
          location: str(e.location),
          booking: /tidycal\.com/i.test(str(e.source?.url) + ' ' + str(e.description)),
          crm,
        })
      }
    } catch (e) {
      errors.push(`${name}: ${str(e?.message || e)}`)
    }
  }
  return { ok: errors.length === 0, events, ...(errors.length ? { errors } : {}) }
}

// ---------------------------------------------------------------------------------------------
// 2. The notes row
// ---------------------------------------------------------------------------------------------

const inflight = new Map() // report date -> the write in progress

function fromRow(r) {
  if (!r) return null
  return {
    reportDate: str(r.report_date),
    status: str(r.status),
    generatedAt: r.generated_at ? new Date(r.generated_at).toISOString() : '',
    requestedAt: r.requested_at ? new Date(r.requested_at).toISOString() : '',
    error: str(r.error),
    notes: r.notes || null,
  }
}

// The row the report should show for a day: that day's own, with the last notes written laid under
// it while today's are still being written (so the page is never emptier than it was yesterday).
export async function loadNotes(dateISO) {
  const { data, error } = await sb().from('daily_reports').select('*').lte('report_date', dateISO).order('report_date', { ascending: false }).limit(8)
  if (error) throw new Error(`daily_reports: ${error.message}`)
  const rows = data || []
  let today = rows.find((r) => r.report_date === dateISO) || null
  // A write that was cut off (the app was quit mid-run) must not say "writing" forever.
  if (today && today.status === 'writing' && !inflight.has(dateISO) && Date.now() - new Date(today.requested_at).getTime() > WRITE_TIMEOUT_MS + 60_000) {
    await sb().from('daily_reports').update({ status: 'error', error: 'The write was interrupted. Press Write notes to try again.' }).eq('report_date', dateISO)
    today = { ...today, status: 'error', error: 'The write was interrupted. Press Write notes to try again.' }
  }
  const lastWritten = rows.find((r) => r.notes && r.generated_at) || null
  if (today && !today.notes && lastWritten) return { ...fromRow(today), notes: lastWritten.notes, generatedAt: fromRow(lastWritten).generatedAt, borrowedFrom: lastWritten.report_date }
  return fromRow(today || lastWritten)
}

// ---------------------------------------------------------------------------------------------
// 3. What Claude is told
// ---------------------------------------------------------------------------------------------

function readText(file, max) {
  try {
    return clip(fs.readFileSync(file, 'utf8'), max)
  } catch {
    return ''
  }
}
// The markdown sections whose heading matches, each cut to `per` characters.
function sections(file, patterns, per, until) {
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
  // `until`: stop reading at this line (an archive of old material below it would match too).
  if (until) {
    const cut = text.search(until)
    if (cut > 0) text = text.slice(0, cut)
  }
  const parts = text.split(/\n(?=#{1,3} )/)
  return parts
    .filter((p) => patterns.some((re) => re.test(p.split('\n', 1)[0])))
    .map((p) => clip(p, per))
    .join('\n\n')
}

function money(n) {
  const v = Number(n)
  return Number.isFinite(v) && v > 0 ? '$' + Math.round(v).toLocaleString('en-US') : ''
}

// The last few emails with a client, oldest first within each thread. Trimmed hard: the writer needs
// the gist of where the conversation stands, not the archive.
async function mailFor(projectId) {
  if (!gmailConnected()) return ''
  const emails = emailsForProject(projectId)
  if (!emails.length) return ''
  try {
    const threads = await searchThreads(emails, 3)
    const out = []
    for (const t of threads) {
      out.push(`  Thread "${clip(t.subject, 90)}"${t.hasDraft ? ' (HAS AN UNSENT DRAFT of his waiting in Gmail)' : ''}:`)
      for (const m of t.messages.filter((x) => !x.isDraft).slice(-3)) {
        out.push(`    ${m.date} ${m.from === 'michael@michaelbloemeke.com' ? 'Michael' : clip(m.fromName, 40)}: ${clip(m.body.replace(/\s+/g, ' '), 420)}`)
      }
    }
    return out.join('\n')
  } catch (e) {
    return `  (could not read their email: ${clip(e?.message || e, 80)})`
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }))
  return out
}

// Everything the writer gets, as one text. Returns the prompt plus the short task refs it used (T1,
// T2, ...) so the answer can be matched back to real task ids.
export async function buildPrompt(dateISO) {
  const all = loadAll().projects.filter((p) => p.bucket !== 'deleted')
  const byId = new Map(all.map((p) => [p.id, p]))
  const projectIds = new Set(byId.keys())
  const structure = loadStructure()
  const stageName = {}
  for (const u of structure.umbrellas) for (const s of u.stages) stageName[s.id] = `${s.name} (${u.label})`

  // ---- tasks, in his four groups ----
  const refs = [] // [{ ref, id }]
  const grouped = Object.fromEntries(GROUPS.map((g) => [g.key, []]))
  for (const t of loadTasks()) {
    if (t.done) continue
    const key = groupOf(t, dateISO, projectIds)
    if (key) grouped[key].push(t)
  }
  const taskLines = []
  const wanted = new Set() // projects that have a task on today's report
  for (const g of GROUPS) {
    const list = grouped[g.key].sort((a, b) => str(a.dueDate).localeCompare(str(b.dueDate)))
    if (!list.length) continue
    taskLines.push(`${g.title}:`)
    for (const t of list) {
      const ref = `T${refs.length + 1}`
      refs.push({ ref, id: t.id })
      const p = t.projectId ? byId.get(t.projectId) : null
      if (p) wanted.add(p.id)
      const late = daysBetween(t.dueDate, dateISO)
      taskLines.push(`  ${ref}. "${clip(t.title, 200)}"${p ? ` | project: ${p.client}` : ''}${late > 0 ? ` | ${late} day${late === 1 ? '' : 's'} late` : ' | due today'}${t.dueTime ? ` | at ${t.dueTime}` : ''}`)
    }
  }

  // ---- the projects those tasks belong to ----
  let overview = { items: [], bookings: [] }
  try {
    overview = await proposalsOverview()
  } catch {
    // proposals are context, not a requirement
  }
  const proposalBy = new Map((overview.items || []).map((x) => [x.projectId, x]))
  const bookingBy = new Map((overview.bookings || []).map((x) => [x.projectId, x]))
  const invoices = (() => {
    try {
      return getCachedInvoices() || []
    } catch {
      return []
    }
  })()
  const projectBlocks = await mapLimit([...wanted], 3, async (id) => {
    const p = byId.get(id)
    const lines = [`PROJECT: ${p.client}`]
    const add = (label, v, n = 300) => {
      const t = clip(v, n)
      if (t) lines.push(`  ${label}: ${t}`)
    }
    add('Stage', stageName[p.stageId] || p.stageId || p.bucket)
    add('Event', [p.eventType, p.eventDate ? `${longDate(p.eventDate)} (${daysBetween(dateISO, p.eventDate)} days from today)` : 'no date yet'].filter(Boolean).join(', '))
    add('Quote', money(p.totalFee))
    add('Where', p.eventLocation, 160)
    add('Times', [p.eventStartTime && `event ${p.eventStartTime}`, p.showStartTime && `show ${p.showStartTime}`].filter(Boolean).join(', '))
    add('What', p.eventSummary, 200)
    add('Performance', p.performanceStyle, 160)
    add('Source', p.bookingSource, 80)
    const contacts = (() => {
      try {
        return contactsForProject(id) || []
      } catch {
        return []
      }
    })()
    if (contacts.length) add('Contact', contacts.map((c) => [c.name, (c.emails || [])[0], (c.phones || [])[0]].filter(Boolean).join(', ')).join(' / '), 260)
    else add('Contact', [p.contactNames, p.contactEmails, p.contactPhones].filter(Boolean).join(', '), 200)
    add('Description', p.eventDescription, 700)
    add('Notes', p.projectNotes, 1400)
    if (!emailsForProject(id).length) add('Their original inquiry', p.initialInquiry, 700)
    const pr = proposalBy.get(id)
    if (pr) add('Proposal page', `${pr.state}, opened ${pr.views} time${pr.views === 1 ? '' : 's'}${pr.lastViewedAt ? `, last on ${longDate(str(pr.lastViewedAt).slice(0, 10), false)}` : ''}`)
    const bk = bookingBy.get(id)
    if (bk) add('Booking form', [bk.sentAt && `sent ${longDate(str(bk.sentAt).slice(0, 10), false)}`, bk.views != null && `opened ${bk.views} times`, bk.signedAt && `SIGNED ${longDate(str(bk.signedAt).slice(0, 10), false)}`].filter(Boolean).join(', '))
    // An invoices row is { project_id, data }, and `data` is the CRM's record of the QuickBooks invoice.
    const inv = (invoices.find((x) => str(x.project_id) === id) || {}).data
    if (inv && inv.invoiceId) add('Invoice', `${money(inv.total || inv.amount)}${inv.paidAt || (inv.balance != null && Number(inv.balance) === 0) ? ', PAID' : ', not paid yet'}${inv.sentAt ? '' : ', not sent yet'}`)
    const log = Array.isArray(p.activityLog) ? p.activityLog.slice(0, 6) : []
    if (log.length) lines.push('  Activity log (newest first):', ...log.map((l) => `    ${clip(l, 220)}`))
    const mail = await mailFor(id)
    if (mail) lines.push('  Recent email:', mail)
    return lines.join('\n')
  })

  // ---- the day ----
  const bounds = dayBounds(dateISO)
  let dayText = 'The calendar could not be read.'
  try {
    const { events } = await dayEvents(bounds.from, bounds.to)
    const placed = placeEvents(events, dateISO)
    const rows = [
      `  ${clockRange(ROUTINE.wake, ROUTINE.deskAt)}: works out and gets ready (every day)`,
      `  ${clock(ROUTINE.deskAt)}: at the computer`,
      ...placed.timed.map((e) => `  ${clockRange(e.startMin, e.endMin)}: ${e.title} [${e.kind}]${e.where ? `, at ${clip(e.where, 80)}` : ''}`),
    ]
    for (const t of loadTasks()) if (!t.done && t.dueDate === dateISO && t.dueTime) rows.push(`  ${t.dueTime}: task "${clip(t.title, 100)}"`)
    if (placed.allDay.length) rows.push(`  All day: ${placed.allDay.map((a) => a.title).join(', ')}`)
    dayText = rows.join('\n')
  } catch (e) {
    dayText = `The calendar could not be read (${clip(e?.message || e, 80)}).`
  }

  // ---- the whole pipeline, one line each ----
  const active = all.filter((p) => p.bucket === 'active').sort((a, b) => str(a.eventDate || '9999').localeCompare(str(b.eventDate || '9999')))
  const pipeline = active.map((p) => `  ${p.client} | ${stageName[p.stageId] || p.stageId} | ${p.eventDate ? longDate(p.eventDate, false) : 'no date'} | ${money(p.totalFee) || 'no quote'}`).join('\n')

  // ---- On my plate, and the plans ----
  let plate = ''
  try {
    plate = (await loadHomeList()).map((x) => `${'  '.repeat(1 + (x.depth || 0))}- ${x.text}`).join('\n')
  } catch {
    plate = '  (could not load)'
  }
  const plans = [
    ['His own to-do list (to-do.md, the "Now" section; parts are out of date, trust the dates)', sections(path.join(CLAUDE_HOME, 'to-do.md'), [/^## Now/], 9000)],
    ['The ninety-day plan agreed with Jonah Babins, his head coach (projects.md)', sections(path.join(BUSINESS_DIR, 'projects.md'), [/Priority order/, /NINETY-DAY PLAN/, /CORPORATE MIX PUSH/, /Ideas to ask Michael about/], 4500)],
    ['The December push list (inbox/DECEMBER-PUSH)', fs.existsSync(path.join(BUSINESS_DIR, 'inbox')) ? fs.readdirSync(path.join(BUSINESS_DIR, 'inbox')).filter((f) => /PUSH.*\.md$/i.test(f)).map((f) => readText(path.join(BUSINESS_DIR, 'inbox', f), 9000)).join('\n\n') : ''],
    ['Long-range goals and strategy, from his ChatGPT planning notes (ChatGPT/memory.md)', sections(path.join(CLAUDE_HOME, 'ChatGPT', 'memory.md'), [/Strategy retained/, /Networking\/showcase/, /SEO\/backlinks/, /Catholic market/, /Current-state pointers/], 3200, /^# Preserved import sources/m)],
    ["Claude's own memory index: one line per standing fact (MEMORY.md)", readText(path.join(MEMORY_DIR, 'MEMORY.md'), 14000)],
  ].filter(([, body]) => body)

  const prompt = [
    `TODAY IS ${longDate(dateISO)}.`,
    '',
    '=== TASKS ON TODAY\'S REPORT (write one note per task, by its T number) ===',
    taskLines.length ? taskLines.join('\n') : '(none: nothing is overdue and nothing is due today)',
    '',
    '=== THE PROJECTS THOSE TASKS BELONG TO ===',
    projectBlocks.join('\n\n') || '(none)',
    '',
    '=== TODAY\'S SCHEDULE ===',
    dayText,
    '',
    '=== EVERY ACTIVE PROJECT IN THE PIPELINE (client | stage | event date | quote) ===',
    pipeline || '(empty)',
    '',
    '=== "ON MY PLATE": HIS OWN LIST OF THE LARGER THINGS HE IS WORKING ON, IN HIS ORDER ===',
    plate || '  (empty)',
    '',
    '=== HIS PLANS (background for choosing the larger project; some of it is weeks old) ===',
    ...plans.map(([label, body]) => `--- ${label} ---\n${body}\n`),
  ].join('\n')

  return { prompt, refs, taskCount: refs.length }
}

const SYSTEM_PROMPT = `You write the notes on Michael Bloemeke's daily report. Michael is a professional magician in Raleigh, North Carolina, and runs the business alone. Each morning he opens one page that lists his tasks, shows his schedule, and tells him what larger project to work on. You write three things for that page: a note on each task, a short read on where things stand, and the larger project for today.

HOW HE WORKS (use this to say how to handle a task):
- A new inquiry gets a phone call first: call twice in a row, leave a voicemail, then text and email. He does not put prices in writing before a call. Gig-site leads (GigSalad, The Bash, Bark) get answered on the site itself first, selling the experience, never a menu of formats.
- An unanswered inquiry is followed up daily: follow-up, then a funny "shark" email, then a breakup email, then archive. After a sales call the rhythm is weekly.
- Every sales call should end with the next call booked. Before that follow-up call he sends one short email with a relevant review. If a follow-up call does not close, the next email offers lettered choices (A book it, B not a fit, C need more time).
- He never chases with "just checking in" or "any questions?". Follow-ups are short, personal, and easy to answer, or funny. His email composer has ready templates (the Ghostbuster emails with GIFs, the shark email, the breakup email).
- Booked shows get check-ins: one midway, one about a week out (confirm times, address, and whether a videographer is coming), one the day before (his arrival time), and a thank-you the day after with the Google review link.
- He does not hold dates without payment. Booking is his booking form link, then the agreement, then a card invoice, paid in full.
- He sends every message himself. You only describe what to send.

RULES FOR EVERYTHING YOU WRITE:
- Write to him as "you". Plain, direct, short sentences. No preamble, no praise, no filler.
- NEVER use an em dash or an en dash. Use a comma or a period.
- Never invent a fact. Every name, date, number, and claim must come from the material you are given. If the material does not say, tell him what to check instead of guessing.
- Do not estimate how long anything takes, and do not assign times of day. He has said he does not trust those estimates.
- Do not restate the task title or the project facts shown beside it (stage, event date). Start with the action.
- Never say "World Champion". Never use the word "partner" for a spouse or fiancee.
- Anything about taxes: the note is exactly "Take this one to ChatGPT, which holds your tax history." Nothing more.
- His Penn & Teller: Fool Us appearance is a secret until it airs. Never suggest telling anyone, posting about it, or using it in marketing yet. Preparing privately is fine.
- Use 12-hour times and written-out dates.
- Where older notes disagree with these, these win: he has 400+ five-star Google reviews (not 350+ or 300+).

THE TASK NOTES. For each task give:
- "how": one to three sentences on how to get it done today. Lead with the first action. Use what the emails, the activity log, the proposal views, and his notes tell you: who to contact, by what channel, about what, and what is still unknown. For a small personal chore where the title says it all, leave "how" as an empty string rather than padding.
- "send": if finishing the task means sending a message, one or two sentences on what that message should say and by which channel (and which ready template fits, if one does). Do NOT write the message itself. Otherwise an empty string.

THE BRIEFING. Three to five sentences on where things stand this morning: what matters most today, what is waiting on clients, what is coming up soon, and anything at risk of being dropped. Facts from the material only. No pep talk.

THE LARGER PROJECT ("focus"). This is what he works on AFTER the tasks are done, when he has time. Pick ONE.
- Choose from his own "On my plate" list and his plans. Weigh what moves the business now: his coach's standing judgement is that the business has a leads problem, so work that brings in or converts leads (the website and its qualifying form, the blog, the promo video, outreach to past clients, holiday bookings in season) outranks tooling and tidying. Respect dates: skip anything already finished or past.
- "title": the project, in a few words, his wording where possible.
- "why": two or three sentences on why this one today, given the season, the pipeline, and his plans.
- "firstStep": the single concrete thing to start with, specific enough to begin without thinking.
- "alsoOpen": two or three other projects worth picking up if the first is blocked, each with one sentence of why. Different projects, not sub-steps of the focus.
- If the task list is very heavy, say in "why" that the project only starts once the list is clear, and keep the first step small.

Return only the structured answer.`

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['briefing', 'tasks', 'focus', 'alsoOpen'],
  properties: {
    briefing: { type: 'string' },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ref', 'how', 'send'],
        properties: { ref: { type: 'string' }, how: { type: 'string' }, send: { type: 'string' } },
      },
    },
    focus: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'why', 'firstStep'],
      properties: { title: { type: 'string' }, why: { type: 'string' }, firstStep: { type: 'string' } },
    },
    alsoOpen: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['title', 'why'], properties: { title: { type: 'string' }, why: { type: 'string' } } },
    },
  },
}

function authToken() {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return str(process.env.CLAUDE_CODE_OAUTH_TOKEN).trim()
  try {
    const c = JSON.parse(fs.readFileSync(path.join(DIR, 'claude-credentials.json'), 'utf8'))
    return str(c.oauthToken || c.token).trim()
  } catch {
    return ''
  }
}

// One headless run of the Claude Code CLI: no tools, our own system prompt, a JSON answer checked
// against SCHEMA by the CLI itself. Runs in the temp folder so none of his project files load on
// their own; everything the writer knows is in the prompt.
function askClaude(prompt) {
  return new Promise((resolve, reject) => {
    const token = authToken()
    if (!fs.existsSync(CLAUDE_BIN) || !token) {
      reject(new Error('Claude is not set up on this Mac. In Terminal run "claude setup-token", then put the token in magic-crm/claude-credentials.json.'))
      return
    }
    const args = [
      '--print', '--output-format', 'json', '--no-session-persistence',
      '--tools', '',
      '--model', MODEL,
      '--system-prompt', SYSTEM_PROMPT,
      '--json-schema', JSON.stringify(SCHEMA),
    ]
    const child = spawn(CLAUDE_BIN, args, { cwd: os.tmpdir(), env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token } })
    let out = ''
    let err = ''
    let done = false
    const finish = (fn) => {
      if (done) return
      done = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => finish(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      reject(new Error('Claude took too long and was stopped. Try again.'))
    }), WRITE_TIMEOUT_MS)
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => finish(() => reject(new Error(str(e?.message || e)))))
    child.on('close', () => finish(() => {
      let j = null
      try {
        j = JSON.parse(out)
      } catch {
        /* handled below */
      }
      if (j && !j.is_error && j.structured_output) {
        resolve({ answer: j.structured_output, model: Object.keys(j.modelUsage || {})[0] || MODEL })
        return
      }
      const said = str(j?.result || out || err).trim()
      if (/not logged in|setup-token|unauthorized|invalid api key|\b401\b/i.test(said)) {
        reject(new Error('Claude is not signed in for the CRM. In Terminal run "claude setup-token" and put the new token in magic-crm/claude-credentials.json.'))
      } else {
        reject(new Error(clip(said || 'Claude returned nothing.', 300)))
      }
    }))
    try {
      child.stdin.write(prompt)
      child.stdin.end()
    } catch (e) {
      finish(() => reject(new Error(str(e?.message || e))))
    }
  })
}

// ---------------------------------------------------------------------------------------------
// 4. Writing the notes
// ---------------------------------------------------------------------------------------------

// Write (or rewrite) the notes for a day. Returns at once when a write for that day is already
// running, so two clicks, or the laptop and the phone together, never start two.
export function writeNotes(dateISO, { by = 'mac' } = {}) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(str(dateISO)) ? dateISO : localToday()
  if (inflight.has(date)) return inflight.get(date)
  const job = (async () => {
    const stamp = new Date().toISOString()
    // Mark it as being written. The previous notes stay in the row until the new ones replace
    // them, so the page keeps showing something while this runs.
    const { error: upErr } = await sb().from('daily_reports').upsert({ report_date: date, status: 'writing', requested_by: by, requested_at: stamp, error: null }, { onConflict: 'report_date' })
    if (upErr) throw new Error(`daily_reports: ${upErr.message}`)
    try {
      const { prompt, refs } = await buildPrompt(date)
      const { answer, model } = await askClaude(prompt)
      const idByRef = new Map(refs.map((r) => [r.ref.toUpperCase(), r.id]))
      const tasks = {}
      for (const t of Array.isArray(answer.tasks) ? answer.tasks : []) {
        const id = idByRef.get(str(t.ref).trim().toUpperCase())
        if (!id) continue
        const how = tidy(t.how), send = tidy(t.send)
        if (how || send) tasks[id] = { how, send }
      }
      const notes = {
        briefing: tidy(answer.briefing),
        tasks,
        focus: answer.focus ? { title: tidy(answer.focus.title), why: tidy(answer.focus.why), firstStep: tidy(answer.focus.firstStep) } : null,
        alsoOpen: (Array.isArray(answer.alsoOpen) ? answer.alsoOpen : []).map((x) => ({ title: tidy(x.title), why: tidy(x.why) })).filter((x) => x.title).slice(0, 3),
        // Every task the writer was shown, noted or not, so the page can tell "added since" from
        // "seen, and needed no note".
        covered: refs.map((r) => r.id),
        model,
      }
      const { error } = await sb().from('daily_reports').update({ status: 'ready', notes, generated_at: new Date().toISOString(), error: null }).eq('report_date', date)
      if (error) throw new Error(`daily_reports: ${error.message}`)
      return { ok: true }
    } catch (e) {
      const message = clip(e?.message || e, 300)
      await sb().from('daily_reports').update({ status: 'error', error: message }).eq('report_date', date)
      console.error('[daily-report] could not write the notes:', message)
      return { ok: false, error: message }
    }
  })().finally(() => inflight.delete(date))
  inflight.set(date, job)
  return job
}

// The phone asked for notes (it set a row to `requested`). Claim each request with a conditional
// update, so a request is written once even if this runs twice, then write it. Called when the
// data changes and at boot; costs one small read when there is nothing to do.
export async function serveRequests() {
  if (CRM_STORE !== 'supabase') return
  try {
    const { data } = await sb().from('daily_reports').select('report_date').eq('status', 'requested').limit(3)
    for (const r of data || []) {
      // A request from a day that has passed (the Mac was off) is not worth two minutes of writing.
      if (r.report_date < localToday()) {
        await sb().from('daily_reports').update({ status: 'error', error: 'The Mac was not on that day, so these notes were never written.' }).eq('report_date', r.report_date).eq('status', 'requested')
        continue
      }
      const { data: claimed } = await sb().from('daily_reports').update({ status: 'writing', requested_at: new Date().toISOString() }).eq('report_date', r.report_date).eq('status', 'requested').select('report_date')
      if (claimed && claimed.length) void writeNotes(r.report_date, { by: 'phone' })
    }
  } catch (e) {
    console.warn('[daily-report] could not check for requests:', e?.message || e)
  }
}

// ---------------------------------------------------------------------------------------------
// 5. What the page asks for
// ---------------------------------------------------------------------------------------------

// Everything the Mac's page cannot work out from what it already holds: the day's events, the notes
// row and On my plate. Tasks and projects are already in the app.
export async function reportData({ date, from, to } = {}) {
  const dateISO = /^\d{4}-\d{2}-\d{2}$/.test(str(date)) ? date : localToday()
  const bounds = from && to ? { from, to } : dayBounds(dateISO)
  const [cal, notes, plate] = await Promise.all([
    dayEvents(bounds.from, bounds.to).catch((e) => ({ ok: false, events: [], error: str(e?.message || e) })),
    loadNotes(dateISO).catch(() => null),
    loadHomeList().catch(() => []),
  ])
  return { date: dateISO, events: cal.events || [], calendarOk: !!cal.ok, calendarNote: cal.reason || cal.error || (cal.errors || []).join('; ') || '', notes, plate, writing: inflight.has(dateISO) }
}
