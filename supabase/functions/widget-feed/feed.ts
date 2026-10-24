// What the home-screen widgets show (2026-10-24). Kept apart from index.ts so it can be run from
// Node against the real data with a service client, the same way phone-api/logic.ts is tested.
//
// Michael's three large widgets, in his words:
//   TASKS  "show all of my tasks... priority to tasks that are overdue above all else, and then it'll
//          show tasks that are due... beyond that, priority to tasks that are within a specific
//          project before showing tasks that are more general."
//   GIGS   the "Gigs next 7 days" cards from the app's Home: name, type of event, date, address, the
//          quote, and the pipeline stage. Soonest first.
//   MAIL   unread email to OR from anyone on an active project: the same list as the app's Home
//          "Unread email" tile (changed 2026-10-24 from "from" only, after the widget showed none while
//          the tile showed his 3 unread invoice emails, which he had SENT to clients).
//
// Everything here mirrors a rule the phone app already applies, so a widget never disagrees with the
// app it opens: tasks of a DELETED project are hidden (renderTasks), due state uses the due TIME as
// well as the date (dueState), a project's addresses are its contact_emails plus every linked
// contact's emails (projectEmails), and the Gmail search is chunked with from:{a b c} (MAIL_CHUNK).
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

const TZ = 'America/New_York'
const str = (v: unknown) => (v == null ? '' : String(v))

function nowParts() {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
  const p = Object.fromEntries(f.formatToParts(new Date()).map((x) => [x.type, x.value]))
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: (Number(p.hour) % 24) * 60 + Number(p.minute) }
}
function addDays(iso: string, n: number) {
  const [y, m, d] = iso.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + n))
  return t.toISOString().slice(0, 10)
}
// "14:00", "2:00 PM", "2 PM" -> minutes after midnight, or null.
function timeMinutes(t: string): number | null {
  const s = str(t).trim()
  let m = /^(\d{1,2}):(\d{2})$/.exec(s)
  if (m) return Number(m[1]) * 60 + Number(m[2])
  m = /^(\d{1,2})(?::(\d{2}))?\s*([AaPp])\.?[Mm]\.?/.exec(s)
  if (m) return ((Number(m[1]) % 12) + (/p/i.test(m[3]) ? 12 : 0)) * 60 + Number(m[2] || 0)
  return null
}
function time12(t: string) {
  const mins = timeMinutes(t)
  if (mins == null) return str(t)
  const h = Math.floor(mins / 60), mm = mins % 60
  return `${h % 12 === 0 ? 12 : h % 12}:${String(mm).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}
function shortDate(iso: string) {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' })
}
function money(n: unknown) {
  const v = Number(n)
  return n == null || n === '' || !Number.isFinite(v) ? '' : '$' + Math.round(v).toLocaleString('en-US')
}

export async function buildFeed(sb: SupabaseClient, googleToken: () => Promise<string>) {
  const { date: today, minutes: nowMin } = nowParts()
  const [{ data: projects, error: e1 }, { data: tasks, error: e2 }, { data: meta }, { data: contacts }, { data: links }] = await Promise.all([
    sb.from('projects').select('id,client_name,project_name,bucket,stage_id,event_type,event_date,event_location,venue_type,total_fee,total_fee_text,show_start_time,contact_emails'),
    sb.from('tasks').select('id,title,due_date,due_time,done,project_id').eq('done', false),
    sb.from('pipeline_meta').select('structure').maybeSingle(),
    sb.from('contacts').select('id,emails'),
    sb.from('contact_links').select('project_id,contact_id'),
  ])
  if (e1) throw e1
  if (e2) throw e2
  const byId = new Map((projects || []).map((p: any) => [p.id, p]))
  const nameOf = (p: any) => str(p.project_name) || str(p.client_name)
  const stageName: Record<string, string> = {}
  for (const u of (meta?.structure?.umbrellas || [])) for (const st of (u.stages || [])) stageName[st.id] = st.name

  // ---- TASKS ----
  const rows = (tasks || [])
    .filter((t: any) => { const p = t.project_id ? byId.get(t.project_id) : null; return !(p && p.bucket === 'deleted') })
    .map((t: any) => {
      const due = str(t.due_date)
      const mins = timeMinutes(t.due_time)
      let state: 'overdue' | 'today' | 'upcoming' | 'none' = 'none'
      if (due) {
        if (due < today || (due === today && mins != null && mins < nowMin)) state = 'overdue'
        else if (due === today) state = 'today'
        else state = 'upcoming'
      }
      const p = t.project_id ? byId.get(t.project_id) : null
      const when = !due ? '' : state === 'today' ? (mins != null ? `Today ${time12(t.due_time)}` : 'Today') : shortDate(due) + (mins != null ? ` ${time12(t.due_time)}` : '')
      return {
        id: str(t.id), title: str(t.title) || 'Task', projectId: p ? str(p.id) : '', project: p ? nameOf(p) : '',
        due, when, state, rank: { overdue: 0, today: 1, upcoming: 2, none: 3 }[state], mins: mins ?? 24 * 60,
      }
    })
  // Overdue, then due today, then the rest; inside each, project tasks before general ones; then the
  // soonest due date and time first (the same order the app's Tasks page reads in).
  rows.sort((a, b) => a.rank - b.rank || (a.projectId ? 0 : 1) - (b.projectId ? 0 : 1) || (a.due || '9999').localeCompare(b.due || '9999') || a.mins - b.mins)
  const taskCounts = {
    overdue: rows.filter((r) => r.state === 'overdue').length,
    today: rows.filter((r) => r.state === 'today').length,
    total: rows.length,
  }

  // ---- GIGS: active projects with an event in the next 7 days, soonest first (homeData().gigs) ----
  const end7 = addDays(today, 7)
  const gigs = (projects || [])
    .filter((p: any) => p.bucket === 'active' && p.event_date && p.event_date >= today && p.event_date <= end7)
    .sort((a: any, b: any) => str(a.event_date).localeCompare(str(b.event_date)) || (timeMinutes(a.show_start_time) ?? 9999) - (timeMinutes(b.show_start_time) ?? 9999))
    .map((p: any) => {
      const days = Math.round((Date.parse(p.event_date + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000)
      return {
        id: str(p.id), name: nameOf(p), eventType: str(p.event_type) || 'Event',
        date: str(p.event_date), dateLabel: shortDate(p.event_date),
        countdown: days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : `In ${days} days`,
        location: str(p.event_location) || str(p.venue_type) || 'Location TBD',
        fee: money(p.total_fee ?? p.total_fee_text), stage: stageName[str(p.stage_id)] || '',
      }
    })

  // ---- MAIL: unread, FROM anyone on an active project ----
  const contactEmails = new Map((contacts || []).map((c: any) => [c.id, (Array.isArray(c.emails) ? c.emails : []).map((e: unknown) => str(e).trim().toLowerCase())]))
  const linksBy = new Map<string, string[]>()
  for (const l of links || []) { const a = linksBy.get(l.project_id) || []; a.push(l.contact_id); linksBy.set(l.project_id, a) }
  const projectEmails = (p: any) => {
    const out = new Set<string>()
    str(p.contact_emails).split(/[,;]/).forEach((e) => { const v = e.trim().toLowerCase(); if (v) out.add(v) })
    for (const cid of linksBy.get(p.id) || []) for (const e of contactEmails.get(cid) || []) if (e) out.add(e)
    return [...out]
  }
  const emailToProject = new Map<string, any>()
  for (const p of (projects || []).filter((x: any) => x.bucket === 'active')) for (const e of projectEmails(p)) if (!emailToProject.has(e)) emailToProject.set(e, p)
  const addrs = [...emailToProject.keys()].filter((e) => /^[^\s{}]+@[^\s{}]+\.[^\s{}]+$/.test(e))

  let mail: any[] = []
  let mailError = ''
  if (addrs.length) {
    try {
      const token = await googleToken()
      const auth = { Authorization: `Bearer ${token}` }
      const api = (path: string) => `https://gmail.googleapis.com/gmail/v1/users/me/${path}`
      const queries: string[] = []
      for (let i = 0; i < addrs.length; i += 12) {
        const g = addrs.slice(i, i + 12).join(' ')
        queries.push(`is:unread (from:{${g}} OR to:{${g}})`)
      }
      const lists = await Promise.all(queries.map(async (q) => {
        const r = await fetch(api(`messages?q=${encodeURIComponent(q)}&maxResults=25`), { headers: auth })
        return r.ok ? await r.json() : { messages: [] }
      }))
      const ids = [...new Set(lists.flatMap((l: any) => (l.messages || []).map((m: any) => m.id)))].slice(0, 40)
      const metas = await Promise.all(ids.map(async (id) => {
        const r = await fetch(api(`messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject`), { headers: auth })
        return r.ok ? await r.json() : null
      }))
      const byThread = new Map<string, any>()
      for (const m of metas) {
        if (!m || !(m.labelIds || []).includes('UNREAD')) continue
        const hs = m.payload?.headers || []
        const h = (n: string) => str(hs.find((x: any) => str(x.name).toLowerCase() === n.toLowerCase())?.value)
        const fromRaw = h('From')
        const em = (/<([^>]+)>/.exec(fromRaw)?.[1] || fromRaw).trim().toLowerCase()
        let name = fromRaw.replace(/<[^>]+>/, '').replace(/"/g, '').trim() || em
        let p = emailToProject.get(em)
        // THE NAME ON THE ROW IS THE CLIENT, never Michael (the app's mailRow rule). When the sender is
        // not a client, the client is a recipient: show them, marked "To".
        let outbound = false
        if (!p) {
          const tos = h('To').split(',').map((x) => (/<([^>]+)>/.exec(x)?.[1] || x).trim().toLowerCase()).filter(Boolean)
          const hit = tos.find((x) => emailToProject.has(x))
          if (hit) { p = emailToProject.get(hit); name = nameOf(p); outbound = true }
        }
        const row = {
          threadId: str(m.threadId), from: name, fromEmail: em, outbound, subject: h('Subject') || '(no subject)',
          snippet: str(m.snippet).replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'),
          ts: Number(m.internalDate) || 0, projectId: p ? str(p.id) : '', project: p ? nameOf(p) : '',
        }
        const prev = byThread.get(row.threadId)
        if (!prev || row.ts > prev.ts) byThread.set(row.threadId, row)
      }
      mail = [...byThread.values()].sort((a, b) => b.ts - a.ts)
    } catch (e) {
      mailError = String((e as Error)?.message || e)
    }
  }

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    today,
    tasks: rows.slice(0, 120).map(({ rank: _r, mins: _m, ...r }) => r),
    taskCounts,
    gigs,
    mail: mail.slice(0, 40),
    mailCount: mail.length,
    mailError,
  }
}
