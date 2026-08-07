import { useEffect } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { type Project } from '../pipeline'
import { ProjectNotesPanel } from './ProjectNotesPanel'

// A right-side slide-in panel for the full project view: the fuller event
// description, project notes, and the activity log, kept off the main page so the
// Details surface stays focused on the working fields. Opened from the header
// button next to "Log a call". Escape or the backdrop closes it.
export function NotesDrawer({
  project,
  open,
  onClose,
  onSaveField,
}: {
  project: Project
  open: boolean
  onClose: () => void
  onSaveField: (field: string, value: string) => void
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex justify-end"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          <div className="absolute inset-0 bg-black/55 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
          <motion.aside
            className="board-scroll relative h-full w-[460px] max-w-[92vw] overflow-y-auto border-l border-line-strong bg-surface shadow-[-30px_0_60px_-30px_rgba(0,0,0,0.18)]"
            initial={{ x: 36, opacity: 0.4 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 36, opacity: 0 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-line bg-surface/95 px-7 pb-4 pt-5 backdrop-blur">
              <div className="min-w-0">
                <p className="font-display text-[18px] leading-tight text-parchment">Description &amp; notes</p>
                <p className="truncate text-[12px] text-faint">{project.client}</p>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="shrink-0 rounded-lg border border-line p-1.5 text-muted transition-colors hover:border-line-strong hover:text-parchment"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
            <div className="px-7 py-6">
              <ProjectNotesPanel project={project} onSaveField={onSaveField} />
            </div>
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
