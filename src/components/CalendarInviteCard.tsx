import { useEffect, useState } from 'react'
import { type Project } from '../pipeline'
import { loadCalendarStatus, sendCalendarInvite, type CalendarStatus } from '../api'

// The Booking-section "Calendar invite" card. Reuses the CRM's existing Google
// Calendar connection (the same one that syncs gigs/tasks). "Schedule invite" opens
// a small form to pick a title, date, time, and recipients (auto-filled from the
// project's contacts, editable). Sending creates an event on the "Work" calendar and
// emails a Google Calendar invitation to the recipients, so it lands on their
// calendars too. Nothing sends until Michael clicks Send.

const DEFAULT_TITLE = 'Call with Michael Bloemeke'
const DURATIONS = [15, 30, 45, 60, 90]

function parseEmails(raw: string): string[] {
  return [...new Set(raw.split(/[\s,;]+/).map((s) => s.trim()).filter((s) => /.+@.+\..+/.test(s)))]
}

function CalendarInviteModal({
  project,
  defaultRecipients,
  onClose,
  onSent,
}: {
  project: Project
  defaultRecipients: string[]
  onClose: () => void
  onSent?: () => void
}) {
  const [title, setTitle] = useState(DEFAULT_TITLE)
  const [date, setDate] = useState(/^\d{4}-\d{2}-\d{2}$/.test(project.eventDate) ? project.eventDate : '')
  const [allDay, setAllDay] = useState(false)
  const [time, setTime] = useState('12:00')
  const [durationMin, setDurationMin] = useState(30)
  const [recipients, setRecipients] = useState(defaultRecipients.join(', '))
  const [location, setLocation] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const emails = parseEmails(recipients)
  const canSend = !!date && !!title.trim() && !busy

  const send = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await sendCalendarInvite({
        projectId: project.id,
        summary: title.trim(),
        date,
        startTime: allDay ? '' : time,
        durationMin,
        attendees: emails,
        location: location.trim(),
        description: notes.trim(),
        allDay,
      })
      if (!res.ok) {
        setError(res.error || 'Could not send the invite.')
        return
      }
      onSent?.()
      onClose()
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(false)
    }
  }

  const inputCls =
    'mt-1 w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-[13px] text-parchment placeholder:text-faint focus:border-brass-dim focus:outline-none'

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={() => !busy && onClose()} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        className="board-scroll relative max-h-[88vh] w-full max-w-md overflow-y-auto rounded-2xl border border-line-strong bg-surface shadow-[0_30px_70px_-30px_rgba(0,0,0,0.18)]"
      >
        <div className="px-6 pt-5">
          <h3 className="font-display text-[19px] text-parchment">Calendar invite</h3>
          <p className="mt-1 text-[12px] text-muted">
            Lands on your <span className="text-parchment">Work</span> calendar and sends a Google invite to the recipients.
          </p>
        </div>

        <div className="space-y-3 px-6 py-4">
          <label className="block">
            <span className="text-[11.5px] font-medium text-muted">Title</span>
            <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Call with Michael Bloemeke" />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-[11.5px] font-medium text-muted">Date</span>
              <input type="date" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
            {!allDay && (
              <label className="block">
                <span className="text-[11.5px] font-medium text-muted">Start time</span>
                <input type="time" className={inputCls} value={time} onChange={(e) => setTime(e.target.value)} />
              </label>
            )}
          </div>

          <div className="flex items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-[12px] text-muted">
              <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} className="accent-[var(--color-brass)]" />
              All-day
            </label>
            {!allDay && (
              <label className="flex items-center gap-2 text-[12px] text-muted">
                Duration
                <select
                  className="rounded-lg border border-line bg-surface-2 px-2 py-1.5 text-[12.5px] text-parchment focus:border-brass-dim focus:outline-none"
                  value={durationMin}
                  onChange={(e) => setDurationMin(Number(e.target.value))}
                >
                  {DURATIONS.map((m) => (
                    <option key={m} value={m}>{m} min</option>
                  ))}
                </select>
              </label>
            )}
          </div>

          <label className="block">
            <span className="text-[11.5px] font-medium text-muted">Recipients</span>
            <input
              className={inputCls}
              value={recipients}
              onChange={(e) => setRecipients(e.target.value)}
              placeholder="client@email.com, other@email.com"
            />
            <span className="mt-1 block text-[10.5px] text-faint">
              {emails.length ? `${emails.length} valid recipient${emails.length === 1 ? '' : 's'}` : 'No valid emails yet — the event will only go on your Work calendar.'}
            </span>
          </label>

          <label className="block">
            <span className="text-[11.5px] font-medium text-muted">Location <span className="text-faint">(optional)</span></span>
            <input className={inputCls} value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Phone call, address, or link" />
          </label>

          <label className="block">
            <span className="text-[11.5px] font-medium text-muted">Notes <span className="text-faint">(optional)</span></span>
            <textarea className={inputCls + ' min-h-[64px] resize-y'} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anything to include in the invite description" />
          </label>

          {error && <p className="text-[11.5px] leading-relaxed text-[var(--color-red)]">{error}</p>}
        </div>

        <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-line bg-surface/95 px-6 py-4 backdrop-blur">
          <button
            type="button"
            onClick={() => !busy && onClose()}
            className="rounded-lg border border-line px-3.5 py-2 text-[12.5px] font-medium text-muted transition-colors hover:border-line-strong hover:text-parchment"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={send}
            disabled={!canSend}
            className="rounded-lg bg-brass px-4 py-2 text-[12.5px] font-semibold text-[#ffffff] transition-all hover:brightness-110 disabled:opacity-40"
          >
            {busy ? 'Sending…' : 'Send invite'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function CalendarInviteCard({ project, recipientEmails = [] }: { project: Project; recipientEmails?: string[] }) {
  const [status, setStatus] = useState<CalendarStatus | null>(null)
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    loadCalendarStatus()
      .then((s) => live && setStatus(s))
      .catch(() => live && setStatus({ connected: false, hasScope: false, gigsName: 'Gigs', workName: 'Work', gigsCalendar: false, workCalendar: false }))
    return () => {
      live = false
    }
  }, [])

  const ready = !!status?.connected && !!status?.hasScope
  const noWorkCal = ready && !status?.workCalendar

  return (
    <div className="rounded-xl border border-line bg-surface-2/30 px-4 py-3">
      <div className="flex items-center gap-2">
        <p className="text-[13px] font-medium text-parchment">Calendar invite</p>
        {ready && (
          <span className="rounded-full border border-line px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em] text-faint">
            Google Calendar
          </span>
        )}
      </div>

      {!status ? (
        <p className="mt-1 text-[11.5px] text-faint">Loading…</p>
      ) : !ready ? (
        <p className="mt-1 text-[11.5px] leading-relaxed text-faint">
          Connect Google Calendar in <span className="text-muted">Settings</span> to send invites.
        </p>
      ) : noWorkCal ? (
        <p className="mt-1 text-[11.5px] leading-relaxed text-faint">
          No calendar named <span className="text-muted">Work</span> found in your Google account. Add one to send invites.
        </p>
      ) : (
        <>
          <p className="mt-1 text-[11.5px] leading-relaxed text-faint">
            Send a Google Calendar invite to the client. It goes on your Work calendar and theirs.
          </p>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-brass-dim/60 bg-surface-3 px-3 py-1.5 text-[12px] font-semibold text-brass-bright transition-colors hover:border-brass"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3.5" y="5" width="17" height="15" rx="2" />
              <path d="M3.5 9.5h17M8 3.5v3M16 3.5v3" />
            </svg>
            Schedule invite
          </button>
        </>
      )}

      {note && <p className="mt-2 text-[11px] leading-relaxed text-muted">{note}</p>}

      {open && (
        <CalendarInviteModal
          project={project}
          defaultRecipients={recipientEmails}
          onClose={() => setOpen(false)}
          onSent={() => setNote('Invite sent and added to your Work calendar.')}
        />
      )}
    </div>
  )
}
