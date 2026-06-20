import { EVENT_TYPE_ACCENT, formatEventDate, formatFee, type Project } from '../pipeline'

type Props = {
  project: Project
  accentVar: string
  onOpenFull: (project: Project) => void
  onOpenSide: (project: Project) => void
  unreadCount?: number
  pendingPayment?: boolean
}

export function ProjectCard({ project, accentVar, onOpenFull, onOpenSide, unreadCount = 0, pendingPayment = false }: Props) {
  const typeColor = EVENT_TYPE_ACCENT[project.eventType]

  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', project.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onClick={() => onOpenFull(project)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpenFull(project)
        }
      }}
      className={[
        'group/card relative flex cursor-pointer overflow-hidden rounded-xl border text-left transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_10px_24px_-14px_rgba(0,0,0,0.8)] active:cursor-grabbing',
        unreadCount > 0
          ? 'border-brass-dim bg-surface-3/80 hover:border-brass-dim'
          : 'border-line bg-surface-2/80 hover:border-line-strong hover:bg-surface-3/80',
      ].join(' ')}
    >
      {/* Left button — opens the side pane instead of the full view */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onOpenSide(project)
        }}
        title="Open in side panel"
        aria-label="Open in side panel"
        className="flex w-7 shrink-0 items-center justify-center border-r border-line/60 text-faint transition-colors hover:bg-surface-3 hover:text-brass"
        style={{ borderLeft: `2px solid ${accentVar}` }}
      >
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M15 4v16" />
        </svg>
      </button>

      {/* Main content — opens the full view */}
      <div className="min-w-0 flex-1 p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <span
              className="inline-flex items-center rounded-full px-2 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.1em]"
              style={{ color: typeColor, backgroundColor: `color-mix(in oklab, ${typeColor} 14%, transparent)` }}
            >
              {project.eventType}
            </span>
            {unreadCount > 0 && (
              <span
                title={`${unreadCount} unread email${unreadCount === 1 ? '' : 's'}`}
                className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-brass px-1.5 py-0.5 text-[9.5px] font-bold text-canvas"
              >
                <svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="5" width="18" height="14" rx="2" />
                  <path d="M4 7l8 6 8-6" />
                </svg>
                {unreadCount}
              </span>
            )}
          </div>
          <span className="shrink-0 text-[12px] font-semibold tabular-nums text-brass">
            {formatFee(project.totalFee)}
          </span>
        </div>

        <h4 className="font-display text-[16px] leading-snug text-parchment">{project.client}</h4>

        {pendingPayment && (
          <span
            title="A payment is pending (amount logged, date not yet received)"
            className="mt-1.5 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.08em]"
            style={{ color: '#d9a441', backgroundColor: 'color-mix(in oklab, #d9a441 16%, transparent)' }}
          >
            <svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </svg>
            Payment pending
          </span>
        )}

        <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted">
          <svg viewBox="0 0 24 24" className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8">
            <rect x="3.5" y="5" width="17" height="15" rx="2" />
            <path d="M3.5 9.5h17M8 3.5v3M16 3.5v3" strokeLinecap="round" />
          </svg>
          <span className="tabular-nums">{formatEventDate(project.eventDate)}</span>
        </div>

        <p className="mt-1.5 line-clamp-2 text-[11px] leading-snug text-faint">
          {project.eventLocation || project.venueType || 'Location TBD'}
        </p>

        {/* Hover hint that the card opens a full view */}
        <span className="pointer-events-none absolute right-2 top-2 text-faint opacity-0 transition-opacity group-hover/card:opacity-100">
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
          </svg>
        </span>
      </div>
    </div>
  )
}
