import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ALERT_KINDS,
  DAY_LABELS,
  loadCalendarAlerts,
  saveCalendarAlerts,
  type CalendarAlertSettings,
  type CalendarAlertStatus,
} from '../api'
import { to12h } from '../format'

// Calendar alerts, on Settings > Calendar.
//
// The cloud (edge function `calendar-alerts`, every minute) pushes his phone about the Google
// Calendar: new bookings and events, a morning schedule, and a heads-up before a meeting. Michael's
// rule is that anything on a schedule must be visible and adjustable in the app, so every setting the
// cloud reads is here, with a status line showing it is actually running. There is deliberately no
// "Run now" or "Send test" button: the schedule existing is what says it is running
// (crm-task-scheduler, 2026-08-24).
//
// Changes save on their own a moment after the last click, so there is no Save button to forget.

const SOON_CHOICES = [5, 10, 15, 20, 30, 45, 60]
const SAVE_DELAY_MS = 600
const STATUS_REFRESH_MS = 30_000

function ago(iso: string, nowMs: number): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const mins = Math.max(0, Math.round((nowMs - t) / 60_000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} hr ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

function clock(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true })
}

function localDateISO(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// The On/Off checkbox the rest of Settings uses (Phone notifications).
function OnOff({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex shrink-0 cursor-pointer items-center gap-2.5 text-[13px] text-parchment">
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} aria-label={label} className="h-4 w-4 accent-[#1a4fd0]" />
      <span>{on ? 'On' : 'Off'}</span>
    </label>
  )
}

function Tick({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-parchment">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-3.5 w-3.5 accent-[#1a4fd0]" />
      <span>{children}</span>
    </label>
  )
}

function Block({ title, blurb, on, onToggle, children }: { title: string; blurb: string; on: boolean; onToggle: (v: boolean) => void; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[13.5px] font-semibold text-parchment">{title}</p>
          <p className="mt-0.5 text-[12px] text-muted">{blurb}</p>
        </div>
        <OnOff on={on} onChange={onToggle} label={title} />
      </div>
      {on && <div className="mt-3 space-y-3 border-t border-line pt-3">{children}</div>}
    </div>
  )
}

function StatusLine({ settings, status, nowMs }: { settings: CalendarAlertSettings; status: CalendarAlertStatus; nowMs: number }) {
  const parts: string[] = []
  const lastRun = Date.parse(status.lastRunAt)
  const stalled = Number.isFinite(lastRun) && nowMs - lastRun > 5 * 60_000
  if (!status.lastRunAt) parts.push('Waiting for the first check')
  else parts.push(`Checked ${ago(status.lastRunAt, nowMs)}`)
  if (settings.digestEnabled) {
    if (status.lastDigestOn === localDateISO() && status.lastDigestAt) parts.push(`Morning schedule sent ${clock(status.lastDigestAt)}`)
    else parts.push(`Morning schedule goes out at ${to12h(settings.digestTime)}`)
  }
  if (status.lastAlertAt) parts.push(`Last alert ${ago(status.lastAlertAt, nowMs)}`)
  return (
    <div className="space-y-1 rounded-lg border border-line bg-surface px-3 py-2 text-[12px]">
      <p className={stalled ? 'text-[#dc2626]' : 'text-muted'}>
        {parts.join(' · ')}
        {stalled && '. The cloud check has stopped running.'}
      </p>
      {status.lastAlertText && <p className="truncate text-faint" title={status.lastAlertText}>{status.lastAlertText}</p>}
      {status.failCount > 0 && status.lastError && (
        <p className="text-[#dc2626]">
          {status.failCount === 1 ? 'The last check failed' : `The last ${status.failCount} checks failed`}: {status.lastError}
        </p>
      )}
    </div>
  )
}

export function CalendarAlerts({ active }: { active: boolean }) {
  const [settings, setSettings] = useState<CalendarAlertSettings | null>(null)
  const [status, setStatus] = useState<CalendarAlertStatus | null>(null)
  const [err, setErr] = useState('')
  const [note, setNote] = useState('')
  const [nowMs, setNowMs] = useState(() => Date.now())
  const pending = useRef<Partial<CalendarAlertSettings>>({})
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Load once, then keep the status line fresh while the Calendar tab is showing. The settings are
  // only taken from the server the first time, so a background refresh never undoes a click.
  useEffect(() => {
    let alive = true
    const load = () =>
      loadCalendarAlerts()
        .then((d) => {
          if (!alive) return
          setStatus(d.status)
          setSettings((cur) => cur ?? d.settings)
          setNowMs(Date.now())
        })
        .catch((e) => alive && setErr(e instanceof Error ? e.message : String(e)))
    void load()
    if (!active) return () => {
      alive = false
    }
    const t = setInterval(load, STATUS_REFRESH_MS)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [active])

  const flush = async () => {
    timer.current = null
    const patch = pending.current
    pending.current = {}
    try {
      const d = await saveCalendarAlerts(patch)
      setStatus(d.status)
      // A newer click may already be waiting; only take the server's copy when nothing is.
      if (!timer.current) setSettings(d.settings)
      setNote('Saved')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setNote('')
      loadCalendarAlerts().then((d) => setSettings(d.settings)).catch(() => {})
    }
  }

  const change = (patch: Partial<CalendarAlertSettings>) => {
    setSettings((cur) => (cur ? { ...cur, ...patch } : cur))
    pending.current = { ...pending.current, ...patch }
    setErr('')
    setNote('Saving…')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void flush(), SAVE_DELAY_MS)
  }

  if (!settings || !status) {
    return <p className="text-[12.5px] text-faint">{err || 'Loading calendar alerts…'}</p>
  }

  const toggleIn = <T,>(list: T[], item: T, on: boolean): T[] => (on ? [...list.filter((x) => x !== item), item] : list.filter((x) => x !== item))
  const calendars = [...new Set([...(status.calendars.length ? status.calendars : ['Work', 'Gigs']), ...settings.digestCalendars])]
  const soonChoices = SOON_CHOICES.includes(settings.soonMinutes) ? SOON_CHOICES : [...SOON_CHOICES, settings.soonMinutes].sort((a, b) => a - b)

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-[17px] text-parchment">Calendar alerts</h2>
          <p className="mt-0.5 text-[12px] text-muted">
            Your phone gets a heads-up about your Google Calendar. This runs in the cloud every minute, so your laptop can be shut.
          </p>
        </div>
        {note && <span className="shrink-0 text-[11.5px] text-muted">{note}</span>}
      </div>

      <StatusLine settings={settings} status={status} nowMs={nowMs} />

      <Block
        title="New bookings and events"
        blurb="A heads-up when something new lands on your Work calendar."
        on={settings.newEventEnabled}
        onToggle={(v) => change({ newEventEnabled: v })}
      >
        <div className="space-y-1.5">
          {ALERT_KINDS.map((k) => (
            <Tick
              key={k.id}
              checked={settings.newEventKinds.includes(k.id)}
              onChange={(v) => change({ newEventKinds: toggleIn(settings.newEventKinds, k.id, v) })}
            >
              {k.label}
            </Tick>
          ))}
        </div>
        <p className="text-[11px] leading-relaxed text-faint">
          You also hear when one of these is cancelled or moved. Tasks and gigs from the CRM keep their own reminders, and
          all-day events go in the morning schedule.
        </p>
      </Block>

      <Block
        title="Morning schedule"
        blurb="One message each morning with your day, in time order."
        on={settings.digestEnabled}
        onToggle={(v) => change({ digestEnabled: v })}
      >
        <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-parchment">
          <span>Send at</span>
          <input
            type="time"
            value={settings.digestTime}
            onChange={(e) => e.target.value && change({ digestTime: e.target.value })}
            className="rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 text-[12.5px] text-parchment focus:border-brass-dim focus:outline-none"
          />
          <span className="text-faint">Eastern time</span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {DAY_LABELS.map((d, i) => {
            const isoDay = i + 1
            const on = settings.digestDays.includes(isoDay)
            return (
              <button
                key={d}
                type="button"
                onClick={() => {
                  if (on && settings.digestDays.length === 1) {
                    setErr('Keep at least one day, or turn the morning schedule off.')
                    return
                  }
                  change({ digestDays: toggleIn(settings.digestDays, isoDay, !on).sort((a, b) => a - b) })
                }}
                className={[
                  'rounded-lg border px-3 py-1.5 text-[12px] font-medium transition-colors',
                  on ? 'border-brass bg-brass text-white' : 'border-line text-muted hover:text-parchment',
                ].join(' ')}
              >
                {d}
              </button>
            )
          })}
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-1.5">
          {calendars.map((name) => {
            const on = settings.digestCalendars.includes(name)
            return (
              <Tick
                key={name}
                checked={on}
                onChange={(v) => {
                  if (!v && settings.digestCalendars.length === 1) {
                    setErr('Keep at least one calendar, or turn the morning schedule off.')
                    return
                  }
                  change({ digestCalendars: toggleIn(settings.digestCalendars, name, v) })
                }}
              >
                {name}
              </Tick>
            )
          })}
        </div>
        <p className="text-[11px] leading-relaxed text-faint">
          Booked gigs show as the time you leave home. Gigs that are still inquiries stay out of it.
        </p>
      </Block>

      <Block
        title="Before a meeting"
        blurb="A heads-up shortly before anything on your Work calendar with a start time."
        on={settings.soonEnabled}
        onToggle={(v) => change({ soonEnabled: v })}
      >
        <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-parchment">
          <select
            value={settings.soonMinutes}
            onChange={(e) => change({ soonMinutes: Number(e.target.value) })}
            className="rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 text-[12.5px] text-parchment focus:border-brass-dim focus:outline-none"
          >
            {soonChoices.map((m) => (
              <option key={m} value={m}>
                {m} minutes
              </option>
            ))}
          </select>
          <span>before it starts</span>
        </div>
        <Tick checked={settings.soonSkipFree} onChange={(v) => change({ soonSkipFree: v })}>
          Skip events marked Free
        </Tick>
        <p className="text-[11px] leading-relaxed text-faint">
          Google Calendar also reminds you 10 minutes before Work events. If you get both, keep whichever you like and turn the
          other off.
        </p>
      </Block>

      {err && <p className="text-[11.5px] text-[#dc2626]">{err}</p>}
    </div>
  )
}
