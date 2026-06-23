import { useEffect, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { formatFee, type CategoryDef, type Project } from '../pipeline'
import {
  loadThreads,
  loadTemplates,
  type CommsData,
  type Contact,
  type Payment,
  type ProjectLinks,
  type Task,
  type Template,
} from '../api'
import { StageSelect } from './StageSelect'
import { EventTypeSelect } from './EventTypeSelect'
import { ProjectDetailsBody } from './ProjectDetailsBody'
import { ThreadReader } from './ThreadReader'
import { MiniComms } from './MiniComms'
import { NotesDrawer } from './NotesDrawer'
import { EmailBuilderModal } from './EmailBuilderModal'
import { PortalModal } from './PortalModal'
import { ProjectActions } from './ProjectActions'
import { EditableTitle } from './EditableTitle'
import { contactsForProject } from '../contacts'

// A prominent, readable event date for the header (e.g. "Friday, June 20, 2026").
// Parsed from parts so the local day never shifts by a timezone.
function longDate(iso: string): string {
  if (!iso) return 'Date TBD'
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}

type Props = {
  project: Project
  tasks: Task[]
  onChangeStage: (stageId: string) => void
  onSaveField: (field: string, value: string) => void
  onAddTask: (title: string, dueDate: string) => void
  onToggleTask: (id: string, done: boolean) => void
  onDeleteTask: (id: string) => void
  onArchive: () => void
  onComplete: () => void
  onRestore: () => void
  onDelete: () => void
  onLogCall: () => void
  onPaymentsChange?: (payments: Payment[]) => void
  onProjectChanged?: () => void
  contacts: Contact[]
  links: ProjectLinks
  onOpenContact: (c: Contact) => void
  onUnlinkContact: (c: Contact) => void
  onAddContact: () => void
  onThreadRead: (count: number) => void
  onBack: () => void
  headerRight?: ReactNode
  categories: CategoryDef[]
}

export function ProjectView({
  project,
  tasks,
  onChangeStage,
  onSaveField,
  onAddTask,
  onToggleTask,
  onDeleteTask,
  onArchive,
  onComplete,
  onRestore,
  onDelete,
  onLogCall,
  onPaymentsChange,
  onProjectChanged,
  contacts,
  links,
  onOpenContact,
  onUnlinkContact,
  onAddContact,
  onThreadRead,
  onBack,
  headerRight,
  categories,
}: Props) {
  // Comms data is owned here so the Details conversations box and the full-page
  // thread reader share one source and one "open thread" selection.
  const [comms, setComms] = useState<CommsData | null>(null)
  const [commsError, setCommsError] = useState<string | null>(null)
  const [templates, setTemplates] = useState<Template[]>([])
  const [openThreadId, setOpenThreadId] = useState<string | null>(null)
  const [notesOpen, setNotesOpen] = useState(false)
  const [writeOpen, setWriteOpen] = useState(false)
  const [portalOpen, setPortalOpen] = useState(false)

  // Recipient emails for the one-off "Write email" composer: every email on the
  // project's linked contacts.
  const recipientEmails = Array.from(
    new Set(
      contactsForProject(project, contacts, links)
        .flatMap((c) => c.emails || [])
        .map((e) => e.trim())
        .filter(Boolean),
    ),
  )

  useEffect(() => {
    let alive = true
    setComms(null)
    setCommsError(null)
    setOpenThreadId(null)
    loadThreads(project.id)
      .then((d) => alive && setComms(d))
      .catch((e) => alive && setCommsError(String(e?.message || e)))
    return () => {
      alive = false
    }
  }, [project.id])

  useEffect(() => {
    loadTemplates()
      .then(setTemplates)
      .catch(() => setTemplates([]))
  }, [])

  // Clear a thread's unread highlight locally + tell the app to drop the badge count.
  const markThreadReadLocal = (threadId: string) => {
    const t = comms?.threads.find((x) => x.id === threadId)
    const count = t?.unread ?? 0
    setComms((d) => (d ? { ...d, threads: d.threads.map((x) => (x.id === threadId ? { ...x, unread: 0 } : x)) } : d))
    if (count > 0) onThreadRead(count)
  }

  // Open / close the thread reader window (overlays Details; closing returns to it).
  const openThread = (threadId: string) => setOpenThreadId(threadId)
  const closeThread = () => setOpenThreadId(null)

  useEffect(() => {
    if (!openThreadId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenThreadId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openThreadId])

  const openThreadObj = openThreadId ? comms?.threads.find((t) => t.id === openThreadId) ?? null : null

  return (
    <motion.div
      key={project.id}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      className="flex h-full min-h-0 flex-col"
    >
      {/* Slim top bar — always visible: back, title, actions. The bulky event
          header now scrolls inside the Details tab so it doesn't eat the viewport
          while you read. */}
      <div className="px-8 pt-6">
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={onBack}
              title="Back"
              aria-label="Back"
              className="shrink-0 rounded-lg border border-line p-1.5 text-muted transition-colors hover:border-line-strong hover:text-parchment"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 6l-6 6 6 6" />
              </svg>
            </button>
            <div className="min-w-0">
              <EditableTitle
                value={project.client}
                onSave={(v) => onSaveField('client', v)}
                className="font-display text-[22px] leading-tight text-parchment"
              />
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-3">
            {headerRight}
            <button
              type="button"
              onClick={() => setNotesOpen(true)}
              title="Description, notes & activity log"
              className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-[12.5px] font-semibold text-muted transition-colors hover:border-brass-dim hover:text-brass-bright"
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 5h16M4 10h16M4 15h10M4 20h7" />
              </svg>
              Notes
            </button>
            <button
              type="button"
              onClick={() => setPortalOpen(true)}
              title="Client portal (share a page with the client)"
              className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-[12.5px] font-semibold text-muted transition-colors hover:border-brass-dim hover:text-brass-bright"
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 12a8 8 0 1 0 16 0 8 8 0 0 0-16 0M4 12h16M12 4a13 13 0 0 1 0 16M12 4a13 13 0 0 0 0 16" />
              </svg>
              Portal
            </button>
            <ProjectActions
              project={project}
              onArchive={onArchive}
              onComplete={onComplete}
              onRestore={onRestore}
              onDelete={onDelete}
              onLogCall={onLogCall}
            />
          </div>
        </div>

        {/* Event meta — type / stage / date / fee / location, kept up top with the title */}
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
          <EventTypeSelect value={project.eventType} onChange={(v) => onSaveField('eventType', v)} />
          {project.bucket === 'active' && (
            <StageSelect value={project.stageId} onChange={onChangeStage} categories={categories} />
          )}
          <span className="mx-1 hidden h-4 w-px bg-line sm:block" />
          <span className="flex items-center gap-1.5">
            <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-brass-dim" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4.5" width="18" height="17" rx="2" />
              <path d="M16 2.5v4M8 2.5v4M3 10h18" />
            </svg>
            <span className={['text-[14px]', project.eventDate ? 'font-medium text-parchment' : 'text-faint'].join(' ')}>
              {longDate(project.eventDate)}
            </span>
          </span>
          <span className="h-1 w-1 rounded-full bg-faint" />
          <span className="text-[14px] font-semibold text-brass">{formatFee(project.totalFee)}</span>
          {project.eventLocation && (
            <>
              <span className="h-1 w-1 rounded-full bg-faint" />
              <span className="max-w-[34rem] truncate text-[14px] text-muted">{project.eventLocation}</span>
            </>
          )}
        </div>
      </div>

      {/* Content: the full-page thread reader when a conversation is open,
          otherwise the project Details (with the conversations box alongside Tasks). */}
      <div className="board-scroll min-h-0 flex-1 overflow-y-auto px-8 pb-12">
        <div className="max-w-6xl pt-4">
          <ProjectDetailsBody
            project={project}
            tasks={tasks}
            contacts={contacts}
            links={links}
            onSaveField={onSaveField}
            onAddTask={onAddTask}
            onToggleTask={onToggleTask}
            onDeleteTask={onDeleteTask}
            onPaymentsChange={onPaymentsChange}
            onProjectChanged={onProjectChanged}
            onOpenContact={onOpenContact}
            onUnlinkContact={onUnlinkContact}
            onAddContact={onAddContact}
            fullView
            tasksAside={<MiniComms data={comms} error={commsError} onOpen={openThread} onWrite={() => setWriteOpen(true)} />}
          />
        </div>
      </div>

      <NotesDrawer project={project} open={notesOpen} onClose={() => setNotesOpen(false)} onSaveField={onSaveField} />

      <PortalModal project={project} open={portalOpen} onClose={() => setPortalOpen(false)} />

      <EmailBuilderModal
        open={writeOpen}
        project={project}
        recipientEmails={recipientEmails}
        existing={null}
        kind="custom"
        title="New email"
        defaultSubject=""
        onClose={() => setWriteOpen(false)}
        onSaved={() => {}}
      />

      {/* Reading a thread opens a big window over the project, instead of swapping
          the page, so the Details stay in context behind it. */}
      <AnimatePresence>
        {openThreadObj && (
          <motion.div
            className="fixed inset-0 z-[60] flex items-start justify-center p-4 sm:p-6"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
          >
            <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={closeThread} aria-hidden />
            <motion.div
              key={openThreadObj.id}
              className="board-scroll relative z-10 max-h-[88vh] w-full max-w-3xl overflow-y-auto"
              initial={{ y: 18, opacity: 0, scale: 0.985 }}
              animate={{ y: 0, opacity: 1, scale: 1 }}
              exit={{ y: 18, opacity: 0 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            >
              <ThreadReader
                thread={openThreadObj}
                project={project}
                templates={templates}
                canMarkRead={comms?.canMarkRead !== false}
                onRead={() => markThreadReadLocal(openThreadObj.id)}
                onBack={closeThread}
              />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
