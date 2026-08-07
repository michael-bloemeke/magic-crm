import type { ReactNode } from 'react'
import { EVENT_TYPE_ACCENT, formatEventDate, formatFee, type Project } from '../pipeline'
import { DateConflictFlag } from './DateConflictFlag'

// One project as a horizontal row: a left button that opens the side pane, the
// client + event type, an optional badge, an unread-mail pill, the event date,
// fee, and a chevron. Clicking the row opens the full project view. Shared by
// the flow view, the Archive page, and the Completed page so they all match.

type Props = {
  project: Project
  onOpenFull: (p: Project) => void
  onOpenSide: (p: Project) => void
  unreadCount?: number
  pendingPayment?: boolean
  dateConflict?: boolean
  badge?: ReactNode
  // Flow-view list: show the event description as the preview line and drop the
  // guest count. Off (records pages) keeps the location line + guest count.
  summary?: boolean
}

export function ProjectRow({ project: p, onOpenFull, onOpenSide, unreadCount = 0, pendingPayment = false, dateConflict = false, badge, summary = false }: Props) {
  const typeColor = EVENT_TYPE_ACCENT[p.eventType]
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpenFull(p)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpenFull(p)
        }
      }}
      className={[
        'group flex w-full cursor-pointer items-stretch overflow-hidden rounded-xl border text-left transition-all duration-150',
        unreadCount > 0
          ? 'border-brass-dim bg-surface-3/70'
          : 'border-line bg-surface-2/60 hover:border-line-strong hover:bg-surface-3/70',
      ].join(' ')}
    >
      {/* Left button — opens the side pane instead of the full view */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onOpenSide(p)
        }}
        title="Open in side panel"
        aria-label="Open in side panel"
        className="flex w-8 shrink-0 items-center justify-center border-r border-line/60 text-faint transition-colors hover:bg-surface-3 hover:text-brass"
        style={{ borderLeft: `2px solid ${typeColor}` }}
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M15 4v16" />
        </svg>
      </button>

      <div className="flex min-w-0 flex-1 items-center gap-4 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-display text-[15px] text-parchment">{p.client}</span>
            <span
              className="shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em]"
              style={{ color: typeColor, backgroundColor: `color-mix(in oklab, ${typeColor} 14%, transparent)` }}
            >
              {p.eventType}
            </span>
            {dateConflict && <DateConflictFlag />}
            {badge}
            {pendingPayment && (
              <span
                title="A payment is pending (amount logged, date not yet received)"
                className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em]"
                style={{ color: '#2563eb', backgroundColor: 'color-mix(in oklab, #2563eb 16%, transparent)' }}
              >
                <svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 7v5l3 2" />
                </svg>
                Payment pending
              </span>
            )}
            {unreadCount > 0 && (
              <span
                title={`${unreadCount} unread email${unreadCount === 1 ? '' : 's'}`}
                className="inline-flex shrink-0 items-center gap-1 rounded-full bg-brass px-1.5 py-0.5 text-[10px] font-bold text-canvas"
              >
                <svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="5" width="18" height="14" rx="2" />
                  <path d="M4 7l8 6 8-6" />
                </svg>
                {unreadCount}
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate text-[11.5px] text-faint">
            {summary
              ? p.eventSummary || p.eventLocation || p.venueType || 'No description yet'
              : p.eventLocation || p.venueType || 'Location TBD'}
          </p>
        </div>

        <div className="hidden shrink-0 items-center gap-6 text-[12px] sm:flex">
          <div className="max-w-[10rem] text-right">
            <p className="tabular-nums text-muted">{formatEventDate(p.eventDate)}</p>
            {/* Only show the guest count when it's an actual short count. Some projects hold a whole
                sentence here (e.g. a festival's "thousands across the footprint..."), which would
                otherwise blow out the row; the full value still lives on the project page. */}
            {!summary && p.numberOfGuests && p.numberOfGuests.length <= 22 ? (
              <p className="truncate text-[10.5px] text-faint">{p.numberOfGuests} guests</p>
            ) : null}
          </div>
          <span className="w-16 text-right font-semibold tabular-nums text-brass">{formatFee(p.totalFee)}</span>
        </div>

        <svg
          viewBox="0 0 24 24"
          className="h-4 w-4 shrink-0 text-faint transition-colors group-hover:text-brass"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M9 6l6 6-6 6" />
        </svg>
      </div>
    </div>
  )
}
