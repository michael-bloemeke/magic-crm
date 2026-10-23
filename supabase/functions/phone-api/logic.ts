// The phone-api actions themselves, kept apart from the HTTP and auth wrapper in index.ts so the exact
// same code can be exercised from the Mac (Node 22 with --experimental-strip-types and the CRM's
// service client) without weakening the function's sign-in check. Nothing in here touches Deno.
//
// `sb` is a service-role Supabase client; the caller has already been authenticated.
// deno-lint-ignore-file no-explicit-any
type SupabaseClient = any

export const TIMEZONE = 'America/New_York'
const WORK_CALENDAR = 'Work'
const GIGS_CALENDAR = 'Gigs'
const CRM_MARKER = 'Synced from Magic CRM'

// ---------------------------------------------------------------------------------------------
// QuickBooks. Same client as booking-complete's qbClient: reuse the stored access token while it is
// live, otherwise refresh and write the rotated refresh token straight back to quickbooks_config.
// ---------------------------------------------------------------------------------------------
const QB_MINOR = '70'
const qbBase = (env: string) =>
  env === 'production' ? 'https://quickbooks.api.intuit.com' : 'https://sandbox-quickbooks.api.intuit.com'

async function qbClient(sb: SupabaseClient) {
  const { data: cfg, error } = await sb.from('quickbooks_config').select('*').eq('id', 1).single()
  if (error || !cfg) throw new Error('QuickBooks is not connected.')
  if (!cfg.refresh_token || !cfg.realm_id) throw new Error('QuickBooks is not connected.')
  let access = cfg.access_token as string | null
  const expires = cfg.access_expires_at ? new Date(cfg.access_expires_at).getTime() : 0
  if (!access || expires - 60_000 < Date.now()) {
    const res = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${cfg.client_id}:${cfg.client_secret}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: cfg.refresh_token }),
    })
    const tok = await res.json()
    if (!res.ok || !tok.access_token) throw new Error(`QuickBooks auth failed: ${tok?.error_description || res.status}`)
    access = tok.access_token
    await sb.from('quickbooks_config').update({
      access_token: tok.access_token,
      refresh_token: tok.refresh_token || cfg.refresh_token,
      access_expires_at: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', 1)
  }
  return async (pathPart: string) => {
    const sep = pathPart.includes('?') ? '&' : '?'
    const url = `${qbBase(cfg.environment)}/v3/company/${cfg.realm_id}${pathPart}${sep}minorversion=${QB_MINOR}`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${access}`, Accept: 'application/json' } })
    const text = await res.text()
    let body: any = null
    try { body = text ? JSON.parse(text) : null } catch { /* empty */ }
    if (!res.ok) throw new Error(`QuickBooks ${res.status}: ${body?.Fault?.Error?.[0]?.Message || text.slice(0, 200)}`)
    return body
  }
}

// A straight port of crm-quickbooks.mjs profitAndLossByMonth + quickbooksExpensesSince, wrapped the
// way the Mac's /api/finance/expenses wraps them, so the phone's Finance page reads the same numbers.
export async function financeQbo(sb: SupabaseClient) {
  const call = await qbClient(sb)
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: TIMEZONE }))
  const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const today = ymd(now)
  const twelveStart = new Date(now.getFullYear(), now.getMonth() - 11, 1)
  const startYmd = ymd(twelveStart)

  const [firstPurchase, report] = await Promise.all([
    call(`/query?query=${encodeURIComponent('select * from Purchase order by TxnDate asc maxresults 1')}`),
    call(`/reports/ProfitAndLoss?start_date=${startYmd}&end_date=${today}&accounting_method=Cash&summarize_column_by=Month`),
  ])
  const since = String(firstPurchase?.QueryResponse?.Purchase?.[0]?.TxnDate || '')

  const cols: Array<{ index: number; month: string }> = []
  ;(report?.Columns?.Column || []).forEach((col: any, i: number) => {
    const meta = (col.MetaData || []).find((m: any) => m.Name === 'StartDate')
    if (meta?.Value) cols.push({ index: i, month: String(meta.Value).slice(0, 7) })
  })
  const cellOf = (group: string, index: number): number => {
    const walk = (list: any[]): number | null => {
      for (const r of list || []) {
        if (r.group === group) {
          const cells = r.Summary?.ColData || r.ColData || []
          const n = Number(String(cells[index]?.value ?? '').replace(/[$,]/g, ''))
          return Number.isFinite(n) ? n : 0
        }
        const inner = walk(r.Rows?.Row)
        if (inner != null) return inner
      }
      return null
    }
    return walk(report?.Rows?.Row) ?? 0
  }
  const startsMonth = since ? since.slice(0, 7) : ''
  const months = cols.map(({ index, month }) => ({
    month,
    income: cellOf('Income', index),
    expenses: Math.round((cellOf('Expenses', index) + cellOf('COGS', index) + cellOf('OtherExpenses', index)) * 100) / 100,
    covered: !startsMonth || month >= startsMonth,
  }))
  return {
    ok: true,
    connected: true,
    generatedAt: new Date().toISOString(),
    dataStartsAt: since,
    dataStartsMonth: startsMonth,
    months,
    thisMonth: months.length ? months[months.length - 1] : null,
  }
}

// ---------------------------------------------------------------------------------------------
// Google Calendar, through the same Google login the gmail function uses (email_config).
// ---------------------------------------------------------------------------------------------
export async function googleToken(sb: SupabaseClient): Promise<string> {
  const { data: cfg, error } = await sb.from('email_config').select('*').eq('id', 1).single()
  if (error || !cfg) throw new Error('Google is not connected.')
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.client_id, client_secret: cfg.client_secret, refresh_token: cfg.refresh_token, grant_type: 'refresh_token',
    }),
  })
  const j: any = await res.json().catch(() => ({}))
  if (!res.ok || !j?.access_token) throw new Error(`Google sign-in failed (${res.status}${j?.error ? `: ${j.error}` : ''})`)
  return String(j.access_token)
}

async function gcal(token: string, path: string, init: RequestInit = {}, params: Record<string, unknown> = {}) {
  const u = new URL(`https://www.googleapis.com/calendar/v3/${path}`)
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v))
  const res = await fetch(u, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) } })
  const body: any = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Google Calendar ${res.status}${body?.error?.message ? `: ${body.error.message}` : ''}`)
  return body
}

async function calendarIdByName(token: string, name: string): Promise<string> {
  let pageToken = ''
  do {
    const r = await gcal(token, 'users/me/calendarList', {}, { maxResults: 250, pageToken })
    for (const c of r.items || []) if (String(c.summaryOverride || c.summary || '').trim() === name) return String(c.id)
    pageToken = r.nextPageToken || ''
  } while (pageToken)
  return ''
}

// Same rule as crm-calendar.mjs isTidyCalEvent: a booking on HIS TidyCal page.
function isTidyCal(e: any): boolean {
  const org = e?.organizer
  if (org && !org.self && !['michael@michaelbloemeke.com', 'mchlbloemeke@gmail.com'].includes(String(org.email || '').toLowerCase())) return false
  let host = ''
  try { host = new URL(String(e?.source?.url || '')).hostname.toLowerCase() } catch { host = '' }
  return host === 'tidycal.com' || host.endsWith('.tidycal.com') || /tidycal\.com/i.test(String(e?.description || ''))
}

// A port of crm-calendar.mjs listCalendarEvents: Work + Gigs, minus everything the CRM wrote itself
// (by the calendar_map ids AND the "Synced from Magic CRM" marker), minus cancelled, declined,
// working-location and focus-time entries.
export async function calendarEvents(sb: SupabaseClient, from: string, to: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Error('from and to must be YYYY-MM-DD.')
  const token = await googleToken(sb)
  const { data: mapRow } = await sb.from('calendar_map').select('*').eq('id', 1).maybeSingle()
  const crmIds = new Set<string>([...Object.values(mapRow?.projects || {}), ...Object.values(mapRow?.tasks || {})].map(String))
  const events: any[] = []
  const errors: string[] = []
  for (const name of [WORK_CALENDAR, GIGS_CALENDAR]) {
    try {
      const calId = await calendarIdByName(token, name)
      if (!calId) { errors.push(`Calendar "${name}" not found in your account.`); continue }
      let pageToken = ''
      let pages = 0
      do {
        const r = await gcal(token, `calendars/${encodeURIComponent(calId)}/events`, {}, {
          timeMin: new Date(`${from}T00:00:00Z`).toISOString(),
          timeMax: new Date(`${to}T23:59:59Z`).toISOString(),
          singleEvents: true, orderBy: 'startTime', maxResults: 2500, pageToken,
        })
        for (const e of r.items || []) {
          if (e.status === 'cancelled' || crmIds.has(String(e.id))) continue
          if (String(e.description || '').includes(CRM_MARKER)) continue
          if (e.eventType === 'workingLocation' || e.eventType === 'focusTime') continue
          if ((e.attendees || []).some((a: any) => a.self && a.responseStatus === 'declined')) continue
          const allDay = !!e.start?.date
          const date = allDay ? e.start.date : e.start?.dateTime ? String(e.start.dateTime).slice(0, 10) : ''
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
          events.push({
            id: e.id, calendar: name, title: e.summary || '(untitled)', date, allDay,
            startTime: !allDay && e.start?.dateTime ? e.start.dateTime : '',
            location: e.location || '', htmlLink: e.htmlLink || '', booking: isTidyCal(e),
          })
        }
        pageToken = r.nextPageToken || ''
        pages++
      } while (pageToken && pages < 10)
    } catch (e) {
      errors.push(String((e as Error)?.message || e))
    }
  }
  return { ok: errors.length === 0, events, ...(errors.length ? { errors } : {}) }
}

// "2:00 PM", "14:00", "2pm" -> { h, m }
function parseTime(s: string): { h: number; m: number } | null {
  const t = String(s || '').trim().toLowerCase()
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?$/.exec(t.replace(/\./g, ''))
  if (!m) return null
  let h = Number(m[1]); const min = Number(m[2] || 0)
  const ap = m[3]
  if (ap) { if (h === 12) h = 0; if (ap.startsWith('p')) h += 12 }
  if (h > 23 || min > 59) return null
  return { h, m: min }
}
function addMinutes(dateISO: string, t: { h: number; m: number }, plus = 0) {
  const total = t.h * 60 + t.m + plus
  const dayShift = Math.floor(total / 1440)
  const mins = ((total % 1440) + 1440) % 1440
  const d = new Date(`${dateISO}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + dayShift)
  const day = d.toISOString().slice(0, 10)
  return `${day}T${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}:00`
}

// A port of crm-calendar.mjs sendCalendarInvite + the activity-log line the Mac's endpoint writes.
export async function calendarInvite(sb: SupabaseClient, b: any) {
  const dateISO = String(b.date || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return { ok: false, error: 'Pick a valid date.' }
  const emails = [...new Set((Array.isArray(b.attendees) ? b.attendees : []).map((e: any) => String(e || '').trim()).filter((e: string) => /.+@.+\..+/.test(e)))]
  const token = await googleToken(sb)
  const calId = await calendarIdByName(token, WORK_CALENDAR)
  if (!calId) return { ok: false, error: `Calendar "${WORK_CALENDAR}" not found in your Google account.` }
  const body: any = {
    summary: String(b.summary || 'Appointment').trim() || 'Appointment',
    location: String(b.location || '').trim() || undefined,
    description: String(b.description || '').trim() || undefined,
    attendees: emails.map((email) => ({ email })),
    reminders: { useDefault: true },
  }
  const t = b.allDay ? null : parseTime(b.startTime)
  if (t) {
    const mins = Math.max(5, Math.min(720, Number(b.durationMin) || 30))
    body.start = { dateTime: addMinutes(dateISO, t), timeZone: TIMEZONE }
    body.end = { dateTime: addMinutes(dateISO, t, mins), timeZone: TIMEZONE }
  } else {
    const next = new Date(`${dateISO}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 1)
    body.start = { date: dateISO }
    body.end = { date: next.toISOString().slice(0, 10) }
  }
  const ev = await gcal(token, `calendars/${encodeURIComponent(calId)}/events`, { method: 'POST', body: JSON.stringify(body) }, { sendUpdates: 'all' })
  if (b.projectId) {
    const { data: p } = await sb.from('projects').select('activity_log').eq('id', String(b.projectId)).maybeSingle()
    if (p) {
      const day = new Date().toLocaleDateString('en-US', { timeZone: TIMEZONE, month: 'long', day: 'numeric', year: 'numeric' })
      const when = `${dateISO}${b.startTime ? ' ' + b.startTime : ''}`
      const line = `${day}: Sent calendar invite "${body.summary}" (${when})${emails.length ? ' to ' + emails.join(', ') : ''}.`
      await sb.from('projects').update({ activity_log: [line, ...(p.activity_log || [])], updated_at: new Date().toISOString() }).eq('id', String(b.projectId))
    }
  }
  return { ok: true, eventId: ev.id, htmlLink: ev.htmlLink, summary: body.summary, attendees: emails }
}

