import { useState } from 'react'
import { motion } from 'motion/react'
import { CATEGORY_COLORS, ORPHAN_STAGE_ID, type Project, type Umbrella } from '../pipeline'
import { StageColumn } from './StageColumn'
import { InlineRename } from './InlineRename'

type Props = {
  pipeline: Umbrella[]
  editMode: boolean
  onOpenFull: (project: Project) => void
  onOpenSide: (project: Project) => void
  onDropProject: (projectId: string, stageId: string) => void
  unread: Record<string, number>
  pendingPaymentIds: Set<string>
  dateConflictIds: Set<string>
  // Structure-edit handlers (only used in edit mode).
  onAddStage: (categoryId: string) => void
  onRenameStage: (stageId: string, name: string) => void
  onReorderStage: (stageId: string, dir: -1 | 1) => void
  onDeleteStage: (stageId: string) => void
  onAddCategory: () => void
  onRenameCategory: (categoryId: string, label: string) => void
  onRecolorCategory: (categoryId: string, color: string) => void
  onDeleteCategory: (categoryId: string) => void
  onReorderCategory: (categoryId: string, dir: -1 | 1) => void
}

// Color picker popover used on a category header in edit mode.
function ColorSwatch({ color, onPick }: { color: string; onPick: (c: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Category color"
        aria-label="Category color"
        className="h-4 w-4 rounded-full border border-line-strong"
        style={{ backgroundColor: color }}
      />
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute left-0 top-6 z-50 flex w-[124px] flex-wrap gap-1.5 rounded-lg border border-line-strong bg-surface p-2 shadow-[0_20px_40px_-20px_rgba(0,0,0,0.18)]">
            {CATEGORY_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => {
                  onPick(c)
                  setOpen(false)
                }}
                className="h-5 w-5 rounded-full border border-line-strong transition-transform hover:scale-110"
                style={{ backgroundColor: c }}
                aria-label={`Use ${c}`}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function ArrowButton({ dir, onClick, title }: { dir: 'up' | 'down'; onClick: () => void; title: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="rounded-md border border-line p-0.5 text-muted transition-colors hover:border-line-strong hover:text-parchment"
    >
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {dir === 'up' ? <path d="M18 15l-6-6-6 6" /> : <path d="M6 9l6 6 6-6" />}
      </svg>
    </button>
  )
}

export function PipelineBoard({
  pipeline,
  editMode,
  onOpenFull,
  onOpenSide,
  onDropProject,
  unread,
  pendingPaymentIds,
  dateConflictIds,
  onAddStage,
  onRenameStage,
  onReorderStage,
  onDeleteStage,
  onAddCategory,
  onRenameCategory,
  onRecolorCategory,
  onDeleteCategory,
  onReorderCategory,
}: Props) {
  let columnIndex = 0

  return (
    <div className="board-scroll min-h-0 flex-1 overflow-auto px-8 pb-8">
      <div className="flex min-w-fit flex-col gap-7">
        {pipeline.map((umbrella, uIdx) => {
          const accentVar = umbrella.color
          const total = umbrella.stages.reduce((n, s) => n + s.projects.length, 0)
          const canDeleteCategory = umbrella.role === null
          // Middles live in [1, length-3]; the last two slots are Booked + Post Show.
          const canMoveUp = umbrella.role === null && uIdx > 1
          const canMoveDown = umbrella.role === null && uIdx < pipeline.length - 3

          return (
            <motion.section
              key={umbrella.id}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.4, delay: 0.05 * uIdx }}
              className="flex flex-col"
            >
              {/* Category header strip (pinned to the left while stages scroll). */}
              <div className="sticky left-0 z-10 mb-3 flex w-fit items-center gap-2.5 pr-4">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: accentVar, boxShadow: `0 0 10px ${accentVar}` }} />
                {editMode ? (
                  <InlineRename
                    value={umbrella.label}
                    ariaLabel="Category name"
                    onSave={(v) => onRenameCategory(umbrella.id, v)}
                    className="rounded border border-line bg-surface-2 px-2 py-0.5 text-[12px] font-semibold uppercase tracking-[0.18em] text-parchment focus:border-brass-dim focus:outline-none"
                    style={{ color: accentVar } as React.CSSProperties}
                  />
                ) : (
                  <span className="text-[12px] font-semibold uppercase tracking-[0.22em]" style={{ color: accentVar }}>
                    {umbrella.label}
                  </span>
                )}
                <span className="text-[11px] font-medium tabular-nums text-faint">{total}</span>

                {editMode && (
                  <div className="ml-1 flex items-center gap-1.5">
                    <ColorSwatch color={accentVar} onPick={(c) => onRecolorCategory(umbrella.id, c)} />
                    {canMoveUp && <ArrowButton dir="up" title="Move category up" onClick={() => onReorderCategory(umbrella.id, -1)} />}
                    {canMoveDown && <ArrowButton dir="down" title="Move category down" onClick={() => onReorderCategory(umbrella.id, 1)} />}
                    {canDeleteCategory && (
                      <button
                        type="button"
                        onClick={() => onDeleteCategory(umbrella.id)}
                        title="Delete category"
                        aria-label="Delete category"
                        className="rounded-md border border-line p-0.5 text-faint transition-colors hover:border-[#dc2626] hover:text-[#dc2626]"
                      >
                        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
                        </svg>
                      </button>
                    )}
                    {umbrella.role === 'first' && <LockHint label="Always first" />}
                    {umbrella.role === 'booked' && <LockHint label="Booked · locked" />}
                    {umbrella.role === 'postshow' && <LockHint label="Auto · always last" />}
                  </div>
                )}
              </div>

              {/* This category's stage columns (scroll right for more). */}
              <div className="flex h-[380px] gap-4">
                {umbrella.stages.map((stage, sIdx) => {
                  const isOrphan = stage.id === ORPHAN_STAGE_ID
                  const isLastBookedStage = umbrella.role === 'booked' && umbrella.stages.length === 1
                  // The two canonical Post Show stages (auto-targets) can't be deleted;
                  // any leftover/extra Post Show stages can be (to clean up after migration).
                  const isProtectedPostshow =
                    umbrella.role === 'postshow' && (stage.id === 'thank-you' || stage.id === 'thank-you-payment')
                  return (
                    <StageColumn
                      key={stage.id}
                      stage={stage}
                      accentVar={accentVar}
                      index={columnIndex++}
                      onOpenFull={onOpenFull}
                      onOpenSide={onOpenSide}
                      onDropProject={onDropProject}
                      unread={unread}
                      pendingPaymentIds={pendingPaymentIds}
                      dateConflictIds={dateConflictIds}
                      editMode={editMode}
                      canDelete={!isOrphan && !isLastBookedStage && !isProtectedPostshow}
                      canMoveLeft={sIdx > 0}
                      canMoveRight={sIdx < umbrella.stages.length - 1}
                      onRename={(name) => onRenameStage(stage.id, name)}
                      onMoveLeft={() => onReorderStage(stage.id, -1)}
                      onMoveRight={() => onReorderStage(stage.id, 1)}
                      onDelete={() => onDeleteStage(stage.id)}
                    />
                  )
                })}

                {editMode && umbrella.role !== 'postshow' && (
                  <button
                    type="button"
                    onClick={() => onAddStage(umbrella.id)}
                    className="flex w-[120px] shrink-0 flex-col items-center justify-center gap-1.5 self-stretch rounded-xl border border-dashed border-line text-[12px] font-medium text-faint transition-colors hover:border-brass-dim hover:text-brass"
                  >
                    <span className="text-base leading-none">+</span> Stage
                  </button>
                )}
              </div>
            </motion.section>
          )
        })}

        {editMode && (
          <button
            type="button"
            onClick={onAddCategory}
            className="sticky left-0 flex w-fit items-center gap-1.5 rounded-lg border border-dashed border-line px-3 py-2 text-[12px] font-medium text-faint transition-colors hover:border-brass-dim hover:text-brass"
          >
            <span className="text-base leading-none">+</span> Add category
          </button>
        )}
      </div>
    </div>
  )
}

function LockHint({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-line px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-[0.1em] text-faint">
      <svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="5" y="11" width="14" height="9" rx="2" />
        <path d="M8 11V8a4 4 0 0 1 8 0v3" />
      </svg>
      {label}
    </span>
  )
}
