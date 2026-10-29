import { useState } from 'react'
import { motion } from 'motion/react'
import type { Project, Stage } from '../pipeline'
import { ProjectCard } from './ProjectCard'
import { InlineRename } from './InlineRename'

type Props = {
  stage: Stage
  accentVar: string
  index: number
  onOpenFull: (project: Project) => void
  onOpenSide: (project: Project) => void
  onDropProject: (projectId: string, stageId: string) => void
  unread: Record<string, number>
  pendingPaymentIds: Set<string>
  dateConflictIds: Set<string>
  editMode?: boolean
  canDelete?: boolean
  canMoveLeft?: boolean
  canMoveRight?: boolean
  onRename?: (name: string) => void
  onMoveLeft?: () => void
  onMoveRight?: () => void
  onDelete?: () => void
  // Set when this is the only stage in its category holding cards: the column fills the rest of its
  // row (PipelineBoard pins that row to the board's visible width), grows to fit its cards, and lays
  // them out in a grid.
  wide?: boolean
  // An empty stage outside edit mode, drawn as a faint dashed outline so it stops pulling the eye
  // (Michael, 2026-10-29). It stays in place and still takes a dropped card, lighting up as normal.
  ghost?: boolean
  // A ghost squeezed to a slim rail with its name running down it, used beside a wide stage so the
  // wide one has the room.
  rail?: boolean
}

export function StageColumn({
  stage,
  accentVar,
  index,
  onOpenFull,
  onOpenSide,
  onDropProject,
  unread,
  pendingPaymentIds,
  dateConflictIds,
  editMode = false,
  canDelete = false,
  canMoveLeft = false,
  canMoveRight = false,
  onRename,
  onMoveLeft,
  onMoveRight,
  onDelete,
  wide = false,
  ghost = false,
  rail = false,
}: Props) {
  const [isDragOver, setIsDragOver] = useState(false)
  const count = stage.projects.length
  // Quiet until a card is dragged over it, then it shows like any other drop target. The fade sits on
  // the header and body, not the outer div: motion owns that one's opacity for its entrance.
  const faded = ghost && !isDragOver
  const fade = faded ? 'opacity-45 group-hover/stage:opacity-75' : ''

  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.04 * index, ease: [0.22, 1, 0.36, 1] }}
      className={[
        'group/stage flex flex-col',
        wide ? 'min-w-0 flex-1' : rail ? 'w-11 shrink-0' : 'w-[244px] shrink-0',
      ].join(' ')}
      title={rail ? stage.name : undefined}
    >
      {/* Column header (a rail keeps just the dot, so its body lines up with its neighbours) */}
      <div
        className={[
          'mb-2.5 flex min-h-5 items-center gap-2 transition-opacity duration-200',
          rail ? 'justify-center' : 'justify-between px-1',
          fade,
        ].join(' ')}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={ghost ? 'h-1.5 w-1.5 shrink-0 rounded-full border' : 'h-1.5 w-1.5 shrink-0 rounded-full'}
            style={ghost ? { borderColor: accentVar } : { backgroundColor: accentVar, boxShadow: `0 0 8px ${accentVar}` }}
          />
          {rail ? null : editMode ? (
            <InlineRename
              value={stage.name}
              ariaLabel="Stage name"
              onSave={(v) => onRename?.(v)}
              className="min-w-0 flex-1 rounded border border-line bg-surface-2 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.13em] text-parchment focus:border-brass-dim focus:outline-none"
            />
          ) : (
            <h3 className={['truncate text-[11px] font-semibold uppercase tracking-[0.13em]', ghost ? 'text-faint' : 'text-muted'].join(' ')}>
              {stage.name}
            </h3>
          )}
        </div>
        {editMode ? (
          <div className="flex shrink-0 items-center gap-0.5">
            {canMoveLeft && (
              <button
                type="button"
                onClick={onMoveLeft}
                title="Move stage left"
                aria-label="Move stage left"
                className="rounded-md p-0.5 text-muted transition-colors hover:text-parchment"
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 6l-6 6 6 6" />
                </svg>
              </button>
            )}
            {canMoveRight && (
              <button
                type="button"
                onClick={onMoveRight}
                title="Move stage right"
                aria-label="Move stage right"
                className="rounded-md p-0.5 text-muted transition-colors hover:text-parchment"
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 6l6 6-6 6" />
                </svg>
              </button>
            )}
            {canDelete && (
              <button
                type="button"
                onClick={onDelete}
                title="Delete stage"
                aria-label="Delete stage"
                className="rounded-md p-0.5 text-faint transition-colors hover:text-[#dc2626]"
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
                </svg>
              </button>
            )}
          </div>
        ) : ghost ? null : (
          <span className="shrink-0 rounded-full border border-line px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-faint">
            {count}
          </span>
        )}
      </div>

      {/* Column body (drop target) */}
      <div
        onDragOver={(e) => {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          if (!isDragOver) setIsDragOver(true)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDragOver(false)
        }}
        onDrop={(e) => {
          e.preventDefault()
          setIsDragOver(false)
          const id = e.dataTransfer.getData('text/plain')
          if (id) onDropProject(id, stage.id)
        }}
        className={[
          'group/col relative flex flex-1 flex-col rounded-xl border transition-all duration-200',
          rail ? 'p-1' : 'p-2',
          ghost ? 'border-dashed' : '',
          faded ? 'bg-transparent' : 'bg-surface/60',
          wide ? 'min-h-[340px]' : 'min-h-0',
          isDragOver ? 'border-brass-dim' : 'border-line hover:border-line-strong',
          fade,
        ].join(' ')}
        style={{
          boxShadow: isDragOver
            ? `inset 0 0 0 1px ${accentVar}`
            : faded
              ? 'none'
              : 'inset 0 1px 0 rgba(255,255,255,0.02)',
        }}
      >
        {/* Scrollable card area */}
        <div className={wide ? 'flex-1' : 'board-scroll min-h-0 flex-1 overflow-y-auto pr-1'}>
          {rail ? (
            <div className="flex h-full justify-center pt-2">
              <span className="text-[10px] font-semibold uppercase tracking-[0.13em] text-faint [writing-mode:vertical-rl]">
                {stage.name}
              </span>
            </div>
          ) : faded ? null : count === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <span
                className="flex h-9 w-9 items-center justify-center rounded-full border border-dashed"
                style={{ borderColor: `color-mix(in oklab, ${accentVar} 35%, transparent)` }}
              >
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: `color-mix(in oklab, ${accentVar} 60%, transparent)` }}
                />
              </span>
              <p className="text-[11px] font-medium tracking-wide text-faint">
                {isDragOver ? 'Drop here' : 'No projects'}
              </p>
            </div>
          ) : (
            <div className={wide ? 'grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(236px,1fr))]' : 'flex flex-col gap-2'}>
              {stage.projects.map((project) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  accentVar={accentVar}
                  onOpenFull={onOpenFull}
                  onOpenSide={onOpenSide}
                  unreadCount={unread[project.id] || 0}
                  pendingPayment={pendingPaymentIds.has(project.id)}
                  dateConflict={dateConflictIds.has(project.id)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Add affordance — placeholder for a future intake flow */}
        {!ghost && (
          <button
            type="button"
            title="Add project (coming soon)"
            className="mt-2 flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-dashed border-line py-2 text-[11px] font-medium text-faint opacity-0 transition-all duration-200 hover:border-brass-dim hover:text-brass group-hover/col:opacity-100"
          >
            <span className="text-sm leading-none">+</span> Add
          </button>
        )}
      </div>
    </motion.div>
  )
}
