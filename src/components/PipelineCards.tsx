import { EVENT_TYPE_ACCENT, formatEventDate, formatFee, type Project, type Umbrella } from '../pipeline'
import { DateConflictFlag } from './DateConflictFlag'

// The "Cards" pipeline view: the whole active pipeline laid out as a dense, scannable
// grid of detail cards, grouped by category and then by stage. Bigger than the board
// cards so each shows key details at a glance (type, fee, date, guests, location,
// a short description, and the contact), while still cramming many onto one screen.

type Props = {
  pipeline: Umbrella[]
  onOpenFull: (p: Project) => void
  onOpenSide: (p: Project) => void
  unread: Record<string, number>
  pendingPaymentIds: Set<string>
  dateConflictIds: Set<string>
}

function DisplayCard({
  p,
  accent,
  onOpenFull,
  onOpenSide,
  unreadCount,
  pendingPayment,
  dateConflict,
}: {
  p: Project
  accent: string
  onOpenFull: (p: Project) => void
  onOpenSide: (p: Project) => void
  unreadCount: number
  pendingPayment: boolean
  dateConflict: boolean
}) {
  const typeColor = EVENT_TYPE_ACCENT[p.eventType]
  const blurb = (p.eventDescription || p.projectNotes || '').trim()
  const contact = (p.contactNames || '').split(/[;,]/)[0].trim()

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
        'group/card relative flex cursor-pointer flex-col overflow-hidden rounded-xl border p-3 text-left transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_10px_24px_-14px_rgba(0,0,0,0.16)]',
        unreadCount > 0
          ? 'border-brass-dim bg-surface-3/80 hover:border-brass-dim'
          : 'border-line bg-surface-2/80 hover:border-line-strong hover:bg-surface-3/80',
      ].join(' ')}
      style={{ borderTop: `2px solid ${accent}` }}
    >
      {/* Top row: event type + fee */}
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className="inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.1em]"
            style={{ color: typeColor, backgroundColor: `color-mix(in oklab, ${typeColor} 14%, transparent)` }}
          >
            {p.eventType}
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
        <span className="shrink-0 text-[12.5px] font-semibold tabular-nums text-brass">{formatFee(p.totalFee)}</span>
      </div>

      {/* Client name */}
      <h4 className="font-display text-[15.5px] leading-snug text-parchment">{p.client}</h4>

      {dateConflict && (
        <div className="mt-1.5">
          <DateConflictFlag />
        </div>
      )}

      {pendingPayment && (
        <span
          title="A payment is pending (amount logged, date not yet received)"
          className="mt-1 inline-flex w-fit items-center gap-1 rounded-full px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.08em]"
          style={{ color: '#2563eb', backgroundColor: 'color-mix(in oklab, #2563eb 16%, transparent)' }}
        >
          <svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </svg>
          Payment pending
        </span>
      )}

      {/* Date + guests */}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
        <span className="inline-flex items-center gap-1.5">
          <svg viewBox="0 0 24 24" className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8">
            <rect x="3.5" y="5" width="17" height="15" rx="2" />
            <path d="M3.5 9.5h17M8 3.5v3M16 3.5v3" strokeLinecap="round" />
          </svg>
          <span className="tabular-nums">{formatEventDate(p.eventDate)}</span>
        </span>
        {p.numberOfGuests && (
          <span className="inline-flex items-center gap-1.5">
            <svg viewBox="0 0 24 24" className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1" />
              <circle cx="9" cy="7" r="3" />
              <path d="M22 19v-1a4 4 0 0 0-3-3.87" />
            </svg>
            <span>{p.numberOfGuests}</span>
          </span>
        )}
      </div>

      {/* Location */}
      <p className="mt-1 line-clamp-1 text-[11px] leading-snug text-faint">
        {p.eventLocation || p.venueType || 'Location TBD'}
      </p>

      {/* Description snippet */}
      {blurb && <p className="mt-1.5 line-clamp-2 text-[11px] leading-snug text-muted/80">{blurb}</p>}

      {/* Footer: contact + side-pane button */}
      <div className="mt-2 flex items-end justify-between gap-2 pt-0.5">
        <span className="min-w-0 truncate text-[10.5px] text-faint">{contact || ' '}</span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onOpenSide(p)
          }}
          title="Open in side panel"
          aria-label="Open in side panel"
          className="shrink-0 rounded-md p-1 text-faint opacity-0 transition-all hover:bg-surface-3 hover:text-brass group-hover/card:opacity-100"
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M15 4v16" />
          </svg>
        </button>
      </div>
    </div>
  )
}

export function PipelineCards({ pipeline, onOpenFull, onOpenSide, unread, pendingPaymentIds, dateConflictIds }: Props) {
  const totalActive = pipeline.reduce((n, u) => n + u.stages.reduce((m, s) => m + s.projects.length, 0), 0)

  if (totalActive === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-8 text-center">
        <p className="text-[13px] text-faint">No active projects in the pipeline yet.</p>
      </div>
    )
  }

  return (
    <div className="board-scroll min-h-0 flex-1 overflow-y-auto px-8 pb-16">
      {pipeline.map((u) => {
        const stages = u.stages.filter((s) => s.projects.length > 0)
        if (stages.length === 0) return null
        const count = stages.reduce((m, s) => m + s.projects.length, 0)
        return (
          <section
            key={u.id}
            className="mb-7 rounded-2xl border p-4 sm:p-5"
            style={{
              // A faint veil of the category color so each section reads as its own
              // visual group. Kept low-saturation / semi-transparent so it's easy on the eyes.
              backgroundColor: `color-mix(in oklab, ${u.color} 8%, transparent)`,
              borderColor: `color-mix(in oklab, ${u.color} 16%, transparent)`,
            }}
          >
            {/* Category band */}
            <div className="mb-3 flex items-center gap-2">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: u.color }} />
              <span className="text-[11px] font-semibold uppercase tracking-[0.16em]" style={{ color: u.color }}>
                {u.label}
              </span>
              <span className="text-[11px] text-faint">· {count}</span>
              <span className="ml-1 h-px flex-1" style={{ backgroundColor: 'color-mix(in oklab, var(--color-line) 80%, transparent)' }} />
            </div>

            <div className="space-y-5">
              {stages.map((s) => (
                <div key={s.id}>
                {/* Stage sub-header */}
                <div className="mb-2 flex items-center gap-2 pl-0.5">
                  <span className="text-[12.5px] font-semibold text-parchment">{s.name}</span>
                  <span
                    className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums"
                    style={{ color: u.color, backgroundColor: `color-mix(in oklab, ${u.color} 14%, transparent)` }}
                  >
                    {s.projects.length}
                  </span>
                </div>
                {/* Cards grid: auto-fills as many ~260px cards per row as fit */}
                <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
                  {s.projects.map((p) => (
                    <DisplayCard
                      key={p.id}
                      p={p}
                      accent={u.color}
                      onOpenFull={onOpenFull}
                      onOpenSide={onOpenSide}
                      unreadCount={unread[p.id] ?? 0}
                      pendingPayment={pendingPaymentIds.has(p.id)}
                      dateConflict={dateConflictIds.has(p.id)}
                    />
                  ))}
                </div>
              </div>
            ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}
