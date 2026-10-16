// Calendar alerts: the settings Michael edits on Settings > Calendar, and the status line under them.
//
// The alerts themselves run in the CLOUD (edge function `calendar-alerts`, pg_cron job of the same
// name, every minute), so they reach his phone with the laptop shut. This module only reads and
// writes the single `calendar_alert_settings` row and reads the function's bookkeeping row
// (`calendar_alert_state`) for the status line. Michael's rule: anything on a schedule must be
// visible and adjustable in the app. There is deliberately no "Run now" or "Send test" here: the
// schedule existing is what says it is running (crm-task-scheduler).
//
// Modelled on crm-task-schedules.mjs. Every value is validated here before it is saved, because the
// cloud reads this row every minute and a bad value would quietly stop an alert.

import { sb } from './crm-store.mjs'

// What each "new event" kind means (supabase/functions/calendar-alerts/logic.ts, classify):
//   booking = TidyCal (or another booking tool), invite = someone else's event, own = his own.
export const ALERT_KINDS = ['booking', 'invite', 'own']

const DEFAULTS = {
  newEventEnabled: true,
  newEventKinds: ['booking', 'invite'],
  digestEnabled: true,
  digestTime: '07:00',
  digestDays: [1, 2, 3, 4, 5, 6, 7],
  digestCalendars: ['Work', 'Gigs'],
  soonEnabled: true,
  soonMinutes: 10,
  soonSkipFree: false,
}

const str = (v) => (v == null ? '' : String(v))

// 'HH:MM' 24h. "7:5" becomes "07:05"; anything unreadable falls back, so a bad value can never
// leave the morning schedule unable to fire (the same reasoning as hhmm in crm-task-schedules.mjs).
function hhmm(v, fallback = '07:00') {
  const m = str(v).trim().match(/^(\d{1,2}):(\d{1,2})$/)
  if (!m) return fallback
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return fallback
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

function fromSettingsRow(r) {
  if (!r) return { ...DEFAULTS }
  return {
    newEventEnabled: r.new_event_enabled !== false,
    newEventKinds: Array.isArray(r.new_event_kinds) ? r.new_event_kinds.map(String).filter((k) => ALERT_KINDS.includes(k)) : DEFAULTS.newEventKinds,
    digestEnabled: r.digest_enabled !== false,
    digestTime: hhmm(r.digest_time),
    digestDays: Array.isArray(r.digest_days) ? r.digest_days.map(Number).filter((n) => n >= 1 && n <= 7) : DEFAULTS.digestDays,
    digestCalendars: Array.isArray(r.digest_calendars) ? r.digest_calendars.map(String).filter(Boolean) : DEFAULTS.digestCalendars,
    soonEnabled: r.soon_enabled !== false,
    soonMinutes: Number(r.soon_minutes) || DEFAULTS.soonMinutes,
    soonSkipFree: r.soon_skip_free === true,
  }
}

// Validate a full settings object into the row shape. Throws a plain-English message on anything
// that would leave a switched-on alert unable to fire.
function toSettingsRow(s) {
  const kinds = [...new Set((Array.isArray(s.newEventKinds) ? s.newEventKinds : []).map(String))].filter((k) => ALERT_KINDS.includes(k))
  const days = [...new Set((Array.isArray(s.digestDays) ? s.digestDays : []).map(Number))].filter((n) => n >= 1 && n <= 7).sort((a, b) => a - b)
  const cals = [...new Set((Array.isArray(s.digestCalendars) ? s.digestCalendars : []).map((c) => str(c).trim()))].filter(Boolean)
  const mins = Math.round(Number(s.soonMinutes))
  if (!(mins >= 1 && mins <= 120)) throw new Error('Pick between 1 and 120 minutes.')
  if (s.digestEnabled && days.length === 0) throw new Error('Pick at least one day for the morning schedule.')
  if (s.digestEnabled && cals.length === 0) throw new Error('Pick at least one calendar for the morning schedule.')
  return {
    new_event_enabled: !!s.newEventEnabled,
    new_event_kinds: kinds,
    digest_enabled: !!s.digestEnabled,
    digest_time: hhmm(s.digestTime),
    digest_days: days,
    digest_calendars: cals,
    soon_enabled: !!s.soonEnabled,
    soon_minutes: mins,
    soon_skip_free: !!s.soonSkipFree,
  }
}

// The cloud's bookkeeping, as the status line needs it. `calendars` is every calendar name the
// function found in his Google account, so the morning-schedule picker offers real names.
function fromStateRow(r) {
  const ids = r && r.calendar_ids && typeof r.calendar_ids === 'object' ? r.calendar_ids : {}
  return {
    lastRunAt: str(r?.last_run_at),
    lastOkAt: str(r?.last_ok_at),
    lastError: str(r?.last_error),
    lastErrorAt: str(r?.last_error_at),
    failCount: Number(r?.fail_count) || 0,
    lastDigestOn: str(r?.last_digest_on),
    lastDigestAt: str(r?.last_digest_at),
    lastAlertAt: str(r?.last_alert_at),
    lastAlertText: str(r?.last_alert_text),
    seededAt: str(r?.seeded_at),
    calendars: Object.keys(ids).sort((a, b) => {
      // Work and Gigs first, the rest alphabetically.
      const rank = (n) => (n === 'Work' ? 0 : n === 'Gigs' ? 1 : 2)
      return rank(a) - rank(b) || a.localeCompare(b)
    }),
  }
}

export async function loadCalendarAlerts() {
  const [settingsRes, stateRes] = await Promise.all([
    sb().from('calendar_alert_settings').select('*').eq('id', 1).maybeSingle(),
    sb().from('calendar_alert_state').select('*').eq('id', 1).maybeSingle(),
  ])
  if (settingsRes.error) throw settingsRes.error
  // The status line is a nicety: if it cannot be read, the settings still load.
  return { settings: fromSettingsRow(settingsRes.data), status: fromStateRow(stateRes.error ? null : stateRes.data) }
}

// Merge a partial change into the saved settings and write the whole row back.
export async function updateCalendarAlerts(patch = {}) {
  const { data: cur, error: readErr } = await sb().from('calendar_alert_settings').select('*').eq('id', 1).maybeSingle()
  if (readErr) throw readErr
  const row = toSettingsRow({ ...fromSettingsRow(cur), ...patch })
  row.updated_at = new Date().toISOString()
  const { error } = await sb().from('calendar_alert_settings').upsert({ id: 1, ...row }, { onConflict: 'id' })
  if (error) throw error
  return loadCalendarAlerts()
}
