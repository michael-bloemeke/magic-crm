import { useContext } from 'react'
import { TidyCalContext, whenLabel } from '../tidycal'

// The TidyCal bar on a project (Michael, 2026-11-12): always there, dull when nothing is booked, green
// with the call and its date and time when a TidyCal booking is coming up. Not a task, so it never
// touches the calendar sync. Logic and matching rules are in src/tidycal.ts.
export function TidyCalBar({ projectId, className = '' }: { projectId: string; className?: string }) {
  const bookings = useContext(TidyCalContext).get(projectId) || []
  const on = bookings.length > 0
  return (
    <div
      className={[
        'inline-flex max-w-full flex-wrap items-center gap-x-2.5 gap-y-1 rounded-lg border bg-surface-2 px-3 py-1.5 text-[13px]',
        on ? 'font-medium' : 'border-line text-faint opacity-70',
        className,
      ].join(' ')}
      style={on ? { borderColor: '#22c55e', backgroundColor: '#effbf3', color: '#166534', boxShadow: '0 0 12px rgba(34, 197, 94, 0.35)' } : undefined}
    >
      <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4.5" width="18" height="17" rx="2" />
        <path d="M16 2.5v4M8 2.5v4M3 10h18" />
        {on && <path d="M8.5 15.5l2.5 2.5 4.5-5" />}
      </svg>
      <span className="font-semibold">TidyCal</span>
      {on ? (
        bookings.map((b) => (
          <span key={b.start + b.callName}>
            {b.callName}, {whenLabel(b.start)}
          </span>
        ))
      ) : (
        <span>No call booked</span>
      )}
    </div>
  )
}
