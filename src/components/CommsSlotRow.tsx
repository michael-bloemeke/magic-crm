import { useEffect, useRef, useState } from 'react'
import type { MarkerChannel, TextMarker } from '../api'

// One step in a project's communication timeline (e.g. "Post-call email", "Follow-up #2",
// "Check-in #1"). This is a record, not a composer: Michael drafts in Gmail and sends from there,
// then flags the step here. Each row carries two independent marks, email and text, and marking
// either one asks for the date it went out. Clicking a mark that's already set reopens the same
// popover so the date can be corrected or the mark cleared.

// Local YYYY-MM-DD for "today" (not UTC, so the date doesn't jump late at night).
function todayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// '2026-07-14' -> 'Jul 14'. Parsed as local parts so it never slips a day.
function fmtShort(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return iso
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

const EMAIL_TONE = { fg: 'var(--color-brass-bright)', edge: 'var(--color-brass-dim)', tint: 'var(--color-brass)' }
const TEXT_TONE = { fg: '#7fc795', edge: '#5aa86d', tint: '#5aa86d' }

export function CommsSlotRow({
  title,
  kind,
  email,
  text,
  onSet,
  onDelete,
}: {
  title: string
  kind: string
  // The saved marks for this slot, by channel. Null when the step hasn't been flagged.
  email: TextMarker | null
  text: TextMarker | null
  onSet: (kind: string, channel: MarkerChannel, sent: boolean, date: string) => void
  // Provided only for removable slots (added follow-ups / check-ins). Hidden once anything is marked.
  onDelete?: () => void
}) {
  const [picking, setPicking] = useState<MarkerChannel | null>(null)
  const [draftDate, setDraftDate] = useState('')
  const wrap = useRef<HTMLDivElement>(null)

  const emailSent = !!email?.sent
  const textSent = !!text?.sent
  const anySent = emailSent || textSent

  // Close on an outside click or Escape, so the popover behaves like every other menu in the app.
  useEffect(() => {
    if (!picking) return
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setPicking(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPicking(null)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [picking])

  const open = (channel: MarkerChannel) => {
    if (picking === channel) {
      setPicking(null)
      return
    }
    const current = channel === 'email' ? email : text
    setDraftDate(current?.date || todayISO())
    setPicking(channel)
  }

  const commit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!picking || !draftDate) return
    onSet(kind, picking, true, draftDate)
    setPicking(null)
  }

  const clear = () => {
    if (!picking) return
    onSet(kind, picking, false, '')
    setPicking(null)
  }

  return (
    <div ref={wrap} className="relative flex items-center gap-3 py-1.5">
      {/* Timeline node: filled once any part of this step has gone out. */}
      <span
        aria-hidden
        className={[
          'z-10 h-[7px] w-[7px] shrink-0 rounded-full border',
          anySent ? 'border-brass bg-brass' : 'border-line-strong bg-surface-2',
        ].join(' ')}
      />
      <p className={['min-w-0 flex-1 truncate text-[13px]', anySent ? 'text-parchment' : 'text-muted'].join(' ')}>
        {title}
      </p>

      <div className="flex shrink-0 items-center gap-1.5">
        {onDelete && !anySent && (
          <button
            type="button"
            onClick={onDelete}
            aria-label={`Remove ${title}`}
            title={`Remove ${title}`}
            className="mr-0.5 text-faint transition-colors hover:text-[#e08a6b]"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6M10 11v6M14 11v6" />
            </svg>
          </button>
        )}
        <Mark
          label="Email"
          tone={EMAIL_TONE}
          sent={emailSent}
          date={email?.date || ''}
          active={picking === 'email'}
          onClick={() => open('email')}
          icon={
            <>
              <rect x="2.5" y="5" width="19" height="14" rx="2" />
              <path d="m3 7 9 6 9-6" />
            </>
          }
        />
        <Mark
          label="Text"
          tone={TEXT_TONE}
          sent={textSent}
          date={text?.date || ''}
          active={picking === 'text'}
          onClick={() => open('text')}
          icon={<path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 9.5 9.5 0 0 1-4-.9L3 21l1.9-5.5A8.5 8.5 0 0 1 4 11.5 8.38 8.38 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5z" />}
        />
      </div>

      {picking && (
        <form
          onSubmit={commit}
          className="absolute right-0 top-full z-30 mt-1 w-[14.5rem] rounded-xl border border-line-strong bg-surface-2 p-3 shadow-[0_10px_30px_-8px_rgba(0,0,0,0.65)]"
        >
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">
            {picking === 'email' ? 'Email sent on' : 'Text sent on'}
          </p>
          <input
            type="date"
            autoFocus
            value={draftDate}
            onChange={(e) => setDraftDate(e.target.value)}
            className="w-full rounded-lg border border-line bg-surface-3 px-2 py-1.5 text-[12.5px] text-parchment focus:border-brass-dim focus:outline-none"
            style={{ colorScheme: 'dark' }}
          />
          <div className="mt-2.5 flex items-center gap-2">
            <button
              type="submit"
              disabled={!draftDate}
              className="rounded-lg bg-brass px-3 py-1.5 text-[12px] font-semibold text-[#231a0c] transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Save
            </button>
            {(picking === 'email' ? emailSent : textSent) && (
              <button
                type="button"
                onClick={clear}
                className="text-[11.5px] font-medium text-muted transition-colors hover:text-[#e08a6b]"
              >
                Clear
              </button>
            )}
            <button
              type="button"
              onClick={() => setPicking(null)}
              className="ml-auto text-[11.5px] font-medium text-faint transition-colors hover:text-parchment"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  )
}

// One channel's toggle. Unset it reads as a label ("Email"); set it reads as the date it went out.
function Mark({
  label,
  tone,
  sent,
  date,
  active,
  onClick,
  icon,
}: {
  label: string
  tone: { fg: string; edge: string; tint: string }
  sent: boolean
  date: string
  active: boolean
  onClick: () => void
  icon: React.ReactNode
}) {
  const style = sent
    ? {
        color: tone.fg,
        borderColor: `color-mix(in oklab, ${tone.edge} 60%, transparent)`,
        backgroundColor: `color-mix(in oklab, ${tone.tint} 14%, transparent)`,
      }
    : undefined
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={sent}
      title={sent ? `${label} sent${date ? ` ${fmtShort(date)}` : ''}. Click to change or clear.` : `Mark ${label.toLowerCase()} sent`}
      className={[
        'inline-flex min-w-[5.25rem] items-center gap-1.5 rounded-lg border px-2 py-1 text-[11.5px] font-medium tabular-nums transition-colors',
        sent ? '' : 'border-line text-faint hover:border-line-strong hover:text-parchment',
        active ? 'ring-1 ring-brass-dim/60' : '',
      ].join(' ')}
      style={style}
    >
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        {icon}
      </svg>
      {sent && date ? fmtShort(date) : label}
    </button>
  )
}
