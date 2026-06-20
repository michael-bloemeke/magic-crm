import { useMemo, useState } from 'react'
import { motion } from 'motion/react'
import { byEventDateAsc, formatEventDate, type Project } from '../pipeline'
import { ProjectRow } from './ProjectRow'

// Shared page for the two "off-pipeline" buckets: Archive and Completed. Rows are
// sorted by event date and filterable by event type, by year (both), by month
// (completed), and by reason (archive). A running count sits in the filter bar.

type Props = {
  variant: 'archive' | 'completed'
  projects: Project[]
  onOpenFull: (p: Project) => void
  onOpenSide: (p: Project) => void
}

const UNCATEGORIZED = 'Uncategorized'
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function RecordsPage({ variant, projects, onOpenFull, onOpenSide }: Props) {
  const [type, setType] = useState<string | null>(null)
  const [reason, setReason] = useState<string | null>(null)
  const [year, setYear] = useState<string | null>(null)
  const [monthNum, setMonthNum] = useState<string | null>(null) // '01'..'12'
  // Completed records read best newest-first; the archive keeps soonest-first.
  const [soonestFirst, setSoonestFirst] = useState(variant !== 'completed')

  const types = useMemo(() => Array.from(new Set(projects.map((p) => p.eventType))).sort(), [projects])
  const reasons = useMemo(
    () => Array.from(new Set(projects.map((p) => p.archiveReason || UNCATEGORIZED))).sort(),
    [projects],
  )
  const years = useMemo(() => {
    const set = new Set<string>()
    for (const p of projects) {
      const y = (p.eventDate || '').slice(0, 4)
      if (/^\d{4}$/.test(y)) set.add(y)
    }
    return Array.from(set).sort().reverse()
  }, [projects])
  // Months present in the (year-scoped) set, so the month dropdown stays relevant.
  const monthsInView = useMemo(() => {
    const set = new Set<string>()
    for (const p of projects) {
      if (year && (p.eventDate || '').slice(0, 4) !== year) continue
      const m = (p.eventDate || '').slice(5, 7)
      if (/^\d{2}$/.test(m)) set.add(m)
    }
    return Array.from(set).sort()
  }, [projects, year])

  const rows = useMemo(() => {
    let list = projects.slice()
    if (type) list = list.filter((p) => p.eventType === type)
    if (variant === 'archive' && reason) list = list.filter((p) => (p.archiveReason || UNCATEGORIZED) === reason)
    if (year) list = list.filter((p) => (p.eventDate || '').slice(0, 4) === year)
    if (variant === 'completed' && monthNum) list = list.filter((p) => (p.eventDate || '').slice(5, 7) === monthNum)
    list.sort(byEventDateAsc)
    if (!soonestFirst) list.reverse()
    return list
  }, [projects, type, reason, year, monthNum, soonestFirst, variant])

  const empty = variant === 'archive' ? 'No archived projects yet.' : 'No completed projects yet.'
  const noun = variant === 'archive' ? 'archived' : 'completed'
  const filtered = rows.length !== projects.length
  const dropdownCls = (active: boolean) =>
    [
      'rounded-full border px-3 py-1 text-[11.5px] font-medium transition-colors focus:outline-none',
      active
        ? 'border-brass-dim bg-surface-3 text-brass-bright'
        : 'border-line bg-surface-2/60 text-muted hover:border-line-strong hover:text-parchment',
    ].join(' ')

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.35 }}
      className="board-scroll h-full overflow-y-auto px-8 pb-12"
    >
      {/* Filter bar */}
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <FilterChip active={!type} label="All types" onClick={() => setType(null)} />
        {types.map((t) => (
          <FilterChip key={t} active={type === t} label={t} onClick={() => setType(type === t ? null : t)} />
        ))}

        <span className="mx-1 h-4 w-px bg-line" />

        {/* Year (both variants) */}
        {years.length > 0 && (
          <select
            value={year ?? ''}
            onChange={(e) => {
              setYear(e.target.value || null)
              setMonthNum(null)
            }}
            className={dropdownCls(!!year)}
            title="Filter by year"
          >
            <option value="">All years</option>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        )}

        {/* Month (completed only) */}
        {variant === 'completed' && monthsInView.length > 0 && (
          <select value={monthNum ?? ''} onChange={(e) => setMonthNum(e.target.value || null)} className={dropdownCls(!!monthNum)} title="Filter by month">
            <option value="">All months</option>
            {monthsInView.map((m) => (
              <option key={m} value={m}>
                {MONTH_NAMES[Number(m) - 1]}
              </option>
            ))}
          </select>
        )}

        {/* Reason (archive only) */}
        {variant === 'archive' && reasons.length > 0 && (
          <>
            <FilterChip active={!reason} label="All reasons" onClick={() => setReason(null)} />
            {reasons.map((r) => (
              <FilterChip key={r} active={reason === r} label={r} onClick={() => setReason(reason === r ? null : r)} />
            ))}
          </>
        )}

        <div className="ml-auto flex items-center gap-3">
          <span className="text-[11.5px] tabular-nums text-faint">
            {filtered ? `${rows.length} of ${projects.length} ${noun}` : `${projects.length} ${noun}`}
          </span>
          <button
            type="button"
            onClick={() => setSoonestFirst((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2/60 px-3 py-1 text-[11.5px] font-medium text-muted transition-colors hover:border-line-strong hover:text-parchment"
            title="Toggle event-date order"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M7 4v16M7 20l-3-3M7 4l3 3M17 4v16M17 4l-3 3M17 20l3-3" />
            </svg>
            {soonestFirst ? 'Soonest first' : 'Latest first'}
          </button>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-4 py-16 text-center text-[13px] text-faint">
          {projects.length === 0 ? empty : 'No projects match these filters.'}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((p) => (
            <ProjectRow
              key={p.id}
              project={p}
              onOpenFull={onOpenFull}
              onOpenSide={onOpenSide}
              badge={
                variant === 'archive' ? (
                  <span
                    title={p.whyArchived || undefined}
                    className="shrink-0 rounded-full border border-brass-dim/50 bg-surface-3 px-2.5 py-0.5 text-[11px] font-semibold text-brass-bright"
                  >
                    {p.archiveReason || UNCATEGORIZED}
                  </span>
                ) : variant === 'completed' && p.completedDate ? (
                  <span className="shrink-0 rounded-full border border-line bg-surface-3/60 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-muted">
                    Done {formatEventDate(p.completedDate)}
                  </span>
                ) : null
              }
            />
          ))}
        </div>
      )}
    </motion.div>
  )
}

function FilterChip({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'rounded-full border px-3 py-1 text-[11.5px] font-medium transition-colors',
        active
          ? 'border-brass-dim bg-surface-3 text-brass-bright'
          : 'border-line bg-surface-2/60 text-muted hover:border-line-strong hover:text-parchment',
      ].join(' ')}
    >
      {label}
    </button>
  )
}
