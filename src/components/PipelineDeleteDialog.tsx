import { AnimatePresence, motion } from 'motion/react'

// Shown when deleting a stage or category that still has projects in it. Offers to
// either back out (and reassign the projects by hand) or dump them all into Inquiry
// and proceed with the delete.
export type DeleteBlock = { kind: 'stage' | 'category'; id: string; name: string; count: number }

export function PipelineDeleteDialog({
  target,
  onCancel,
  onDump,
}: {
  target: DeleteBlock | null
  onCancel: () => void
  onDump: () => void
}) {
  return (
    <AnimatePresence>
      {target && (
        <motion.div
          className="fixed inset-0 z-[70] flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={onCancel} aria-hidden />
          <motion.div
            className="relative w-full max-w-md overflow-hidden rounded-2xl border border-line-strong bg-surface shadow-[0_30px_70px_-30px_rgba(0,0,0,0.9)]"
            initial={{ y: 16, opacity: 0.6, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 16, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="px-6 pb-5 pt-5">
              <h2 className="font-display text-[20px] leading-tight text-parchment">
                This {target.kind} still has projects
              </h2>
              <p className="mt-2 text-[13px] leading-relaxed text-muted">
                “{target.name}” has {target.count} {target.count === 1 ? 'project' : 'projects'} in it. You can't delete it
                until those projects have somewhere to go.
              </p>
            </div>
            <div className="flex flex-col gap-2 border-t border-line px-6 py-4">
              <button
                type="button"
                onClick={onCancel}
                className="rounded-lg border border-line px-4 py-2.5 text-[13px] font-semibold text-parchment transition-colors hover:border-line-strong"
              >
                OK, I'll reassign the projects individually
              </button>
              <button
                type="button"
                onClick={onDump}
                className="rounded-lg border border-brass-dim/60 bg-gradient-to-b from-surface-3 to-surface px-4 py-2.5 text-[13px] font-semibold text-brass-bright transition-all hover:border-brass"
              >
                Dump all projects into Inquiry
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
