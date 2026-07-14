import { useMemo } from 'react'
import { motion } from 'motion/react'
import { formatEventDate, type Project } from '../pipeline'
import { ProjectRow } from './ProjectRow'

// The 30-day trash. Deleting a project moves it here instead of destroying it: it
// leaves the pipeline but keeps all its data, can be returned to the pipeline, and is
// permanently purged (with a full cascade) once 30 days pass or you delete it now.

const TTL_DAYS = 30

function daysLeft(iso: string): number {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return TTL_DAYS
  const elapsed = (Date.now() - t) / 86400000
  return Math.max(0, Math.ceil(TTL_DAYS - elapsed))
}

type Props = {
  projects: Project[]
  onOpenFull: (p: Project) => void
  onOpenSide: (p: Project) => void
  onRestore: (id: string) => void
  onPurge: (p: Project) => void
}

export function DeletedPage({ projects, onOpenFull, onOpenSide, onRestore, onPurge }: Props) {
  // Most recently deleted first.
  const rows = useMemo(
    () => projects.slice().sort((a, b) => (b.deletedAt || '').localeCompare(a.deletedAt || '')),
    [projects],
  )

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.35 }}
      className="board-scroll h-full overflow-y-auto px-8 pb-12"
    >
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-[13px] leading-relaxed text-muted">
          Deleted projects stay here for {TTL_DAYS} days, then they are permanently removed along with all their
          data. Open one to see everything, or bring it back to the pipeline any time before it expires.
        </p>
        <span className="shrink-0 text-[11.5px] tabular-nums text-faint">
          {projects.length} in trash
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-4 py-16 text-center text-[13px] text-faint">
          Nothing in the trash. Deleted projects show up here for {TTL_DAYS} days before they are gone for good.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((p) => {
            const left = daysLeft(p.deletedAt)
            const urgent = left <= 7
            return (
              <div key={p.id} className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <ProjectRow
                    project={p}
                    onOpenFull={onOpenFull}
                    onOpenSide={onOpenSide}
                    badge={
                      <span
                        title={p.deletedAt ? `Deleted ${formatEventDate(p.deletedAt.slice(0, 10))}` : undefined}
                        className={[
                          'shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold',
                          urgent
                            ? 'border-[#e08a6b]/50 bg-[#e08a6b]/10 text-[#e08a6b]'
                            : 'border-line bg-surface-3/60 text-muted',
                        ].join(' ')}
                      >
                        {left === 0 ? 'Purging soon' : left === 1 ? '1 day left' : `${left} days left`}
                      </span>
                    }
                  />
                </div>
                <button
                  type="button"
                  onClick={() => onRestore(p.id)}
                  title="Return this project to the pipeline"
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-surface-2/60 px-2.5 py-2 text-[12px] font-semibold text-muted transition-colors hover:border-brass-dim hover:text-brass-bright"
                >
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5" />
                  </svg>
                  Restore
                </button>
                <button
                  type="button"
                  onClick={() => onPurge(p)}
                  title="Delete permanently now (cannot be undone)"
                  aria-label="Delete permanently"
                  className="inline-flex shrink-0 items-center justify-center rounded-lg border border-line p-2 text-faint transition-colors hover:border-[#e08a6b]/60 hover:text-[#e08a6b]"
                >
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6M10 11v6M14 11v6" />
                  </svg>
                </button>
              </div>
            )
          })}
        </div>
      )}
    </motion.div>
  )
}
