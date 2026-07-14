import { useEffect } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { formatEventDate, formatFee, type CategoryDef, type Project } from '../pipeline'
import type { Contact, Payment, ProjectLinks, Task } from '../api'
import { StageSelect } from './StageSelect'
import { EventTypeSelect } from './EventTypeSelect'
import { ProjectDetailsBody } from './ProjectDetailsBody'
import { ProjectActions } from './ProjectActions'
import { EditableTitle } from './EditableTitle'

type Props = {
  project: Project | null
  tasks: Task[]
  onChangeStage: (stageId: string) => void
  onSaveField: (field: string, value: string) => void
  onAddTask: (title: string, dueDate: string, dueTime: string) => void
  onToggleTask: (id: string, done: boolean) => void
  onDeleteTask: (id: string) => void
  onEditTask: (id: string, patch: { title: string; dueDate: string; dueTime: string }) => void
  onArchive: () => void
  onComplete: () => void
  onRestore: () => void
  onDelete: () => void
  onPurge: () => void
  onLogCall: () => void
  onPaymentsChange?: (payments: Payment[]) => void
  onProjectChanged?: () => void
  contacts: Contact[]
  links: ProjectLinks
  onOpenContact: (c: Contact) => void
  onUnlinkContact: (c: Contact) => void
  onAddContact: () => void
  onExpand: (project: Project) => void
  onClose: () => void
  escActive?: boolean
  categories: CategoryDef[]
}

export function ProjectDetail({
  project,
  tasks,
  onChangeStage,
  onSaveField,
  onAddTask,
  onToggleTask,
  onDeleteTask,
  onEditTask,
  onArchive,
  onComplete,
  onRestore,
  onDelete,
  onPurge,
  onLogCall,
  onPaymentsChange,
  onProjectChanged,
  contacts,
  links,
  onOpenContact,
  onUnlinkContact,
  onAddContact,
  onExpand,
  onClose,
  escActive = true,
  categories,
}: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Only react to Escape when this pane is the topmost layer (no contact
      // pane / picker / modal open over it), so we don't close it from under them.
      if (e.key === 'Escape' && escActive) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, escActive])

  return (
    <AnimatePresence>
      {project && (
        <motion.div
          className="fixed inset-0 z-50 flex justify-end"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/55 backdrop-blur-[2px]" onClick={onClose} aria-hidden />

          {/* Drawer */}
          <motion.aside
            className="board-scroll relative h-full w-[480px] max-w-[92vw] overflow-y-auto border-l border-line-strong bg-surface shadow-[-30px_0_60px_-30px_rgba(0,0,0,0.9)]"
            initial={{ x: 36, opacity: 0.4 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 36, opacity: 0 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          >
            {/* Header */}
            <div className="sticky top-0 z-10 border-b border-line bg-surface/95 px-7 pb-5 pt-6 backdrop-blur">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <EventTypeSelect value={project.eventType} onChange={(v) => onSaveField('eventType', v)} />
                    {project.bucket === 'active' && (
                      <StageSelect value={project.stageId} onChange={onChangeStage} categories={categories} />
                    )}
                  </div>
                  <EditableTitle
                    value={project.client}
                    onSave={(v) => onSaveField('client', v)}
                    className="font-display text-[28px] leading-tight text-parchment"
                  />
                  <div className="mt-1.5 flex items-center gap-3 text-[12px] text-muted">
                    <span className="tabular-nums">{formatEventDate(project.eventDate)}</span>
                    <span className="h-1 w-1 rounded-full bg-faint" />
                    <span className="font-semibold text-brass">{formatFee(project.totalFee)}</span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => onExpand(project)}
                    title="Open full view"
                    aria-label="Open full view"
                    className="rounded-lg border border-line p-1.5 text-muted transition-colors hover:border-line-strong hover:text-parchment"
                  >
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9 4H5a1 1 0 0 0-1 1v4M15 4h4a1 1 0 0 1 1 1v4M9 20H5a1 1 0 0 1-1-1v-4M15 20h4a1 1 0 0 0 1-1v-4" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={onClose}
                    className="rounded-lg border border-line p-1.5 text-muted transition-colors hover:border-line-strong hover:text-parchment"
                    aria-label="Close"
                  >
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                      <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>

            {/* Body */}
            <div className="px-7 py-6">
              <div className="mb-6 flex justify-end">
                <ProjectActions
                  project={project}
                  onArchive={onArchive}
                  onComplete={onComplete}
                  onRestore={onRestore}
                  onDelete={onDelete}
                  onPurge={onPurge}
                  onLogCall={onLogCall}
                  compact
                />
              </div>
              <ProjectDetailsBody
                project={project}
                tasks={tasks}
                contacts={contacts}
                links={links}
                onSaveField={onSaveField}
                onAddTask={onAddTask}
                onToggleTask={onToggleTask}
                onDeleteTask={onDeleteTask}
                onEditTask={onEditTask}
                onPaymentsChange={onPaymentsChange}
                onProjectChanged={onProjectChanged}
                onOpenContact={onOpenContact}
                onUnlinkContact={onUnlinkContact}
                onAddContact={onAddContact}
              />
            </div>
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
