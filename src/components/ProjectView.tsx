import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { formatFee, type CategoryDef, type Project } from '../pipeline'
import {
  loadThreads,
  discardGmailDraft,
  sendGmailDraft,
  starThread,
  starMessage,
  type CommsData,
  type Contact,
  type DraftFields,
  type EmailMessage,
  type Payment,
  type ProjectLinks,
  type Task,
  type TaskEditPatch,
  type TaskTiming,
} from '../api'
import { StageSelect } from './StageSelect'
import { EventTypeSelect } from './EventTypeSelect'
import { ProjectDetailsBody } from './ProjectDetailsBody'
import { type PreviewTarget } from './PreviewPage'
import { ThreadReader } from './ThreadReader'
import { MiniComms } from './MiniComms'
import { NotesDrawer } from './NotesDrawer'
import { EmailBuilderModal } from './EmailBuilderModal'
import { ProjectActions } from './ProjectActions'
import { DateConflictFlag } from './DateConflictFlag'
import { TidyCalBar } from './TidyCalBar'
import { TidyCalBookButtons } from './TidyCalBook'
import { EditableTitle } from './EditableTitle'
import { ProjectChat } from './ProjectChat'
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
  // The website's royal-blue ground. Plain navy, no damask: this is the densest screen in
  // the app and a repeating pattern behind it would fight the content. See index.css.
  groundClass?: string
  // Opens the client's proposal page as a SCREEN in the CRM rather than a new browser window.
  // See PreviewPage. Drilled from App because the preview takes over the whole main area.
  onPreview: (t: PreviewTarget) => void
  dateConflict?: boolean
  tasks: Task[]
  onChangeStage: (stageId: string) => void
  onSaveField: (field: string, value: string) => void
  onAddTask: (title: string, dueDate: string, dueTime: string, timing: TaskTiming) => void
  onToggleTask: (id: string, done: boolean) => void
  onDeleteTask: (id: string) => void
  onEditTask: (id: string, patch: TaskEditPatch) => void
  onArchive: () => void
  onComplete: () => void
  onRestore: () => void
  onDelete: () => void
  onPurge: () => void
  onLogCall: () => void
  onPaymentsChange?: (payments: Payment[]) => void
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
  onPreview,
  groundClass = '',
  dateConflict = false,
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
  const [openThreadId, setOpenThreadId] = useState<string | null>(null)
  const [notesOpen, setNotesOpen] = useState(false)
  const [writeOpen, setWriteOpen] = useState(false)
  // The Gmail draft open in the "Write email" composer, or null for a fresh email.
  const [composerDraftId, setComposerDraftId] = useState<string | null>(null)
  const [chatOpen, setChatOpen] = useState(false)
  // Drafts inside their discard Undo window: hidden everywhere, deleted from Gmail when it closes.
  const [hiddenDraftIds, setHiddenDraftIds] = useState<Set<string>>(new Set())
  // The bar at the bottom of the page for a send or a discard that can still be undone.
  const [undoBar, setUndoBar] = useState<UndoBarState | null>(null)
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const undoCommit = useRef<(() => void) | null>(null)

  // Who a TidyCal booking from this page is for: the primary (first linked) contact, else the project's
  // own contact fields. Pre-fills the TidyCal page's name and email.
  const primaryContact = contactsForProject(project, contacts, links)[0]
  const bookingWho = {
    name: primaryContact?.name || (project.contactNames || '').split(/[;,]/)[0].trim(),
    email: primaryContact?.emails?.[0] || (project.contactEmails || '').split(/[\s,;]+/).filter(Boolean)[0] || '',
    phone: primaryContact?.phones?.[0] || (project.contactPhones || '').split(/[;,]/)[0].trim(),
  }

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

  // Re-fetch threads from Gmail: after a star write fails, and after any draft is saved, sent or
  // discarded, so the list always shows what Gmail actually holds.
  const resyncComms = () => {
    loadThreads(project.id)
      .then(setComms)
      .catch(() => {})
  }

  // ---- Undo bar: a send or a discard is held for a few seconds, Gmail-style -----------------------
  const finishUndo = () => {
    if (undoTimer.current) clearTimeout(undoTimer.current)
    undoTimer.current = null
    const commit = undoCommit.current
    undoCommit.current = null
    commit?.()
  }
  const startUndo = (state: UndoBarState, commit: () => void) => {
    finishUndo() // a second action commits the first rather than losing it
    undoCommit.current = commit
    setUndoBar(state)
    undoTimer.current = setTimeout(finishUndo, UNDO_MS)
  }
  // Leaving the project commits whatever is still waiting, so nothing is silently dropped.
  useEffect(() => () => finishUndo(), [])

  const hideDraft = (id: string, hide: boolean) =>
    setHiddenDraftIds((prev) => {
      const next = new Set(prev)
      if (hide) next.add(id)
      else next.delete(id)
      return next
    })

  // Discard a Gmail draft with Undo: hidden now, deleted when the window closes.
  const discardDraft = (draftId: string) => {
    hideDraft(draftId, true)
    startUndo({ message: 'Draft discarded.', undo: () => hideDraft(draftId, false) }, () => {
      discardGmailDraft(draftId)
        .catch(() => {})
        .finally(() => {
          hideDraft(draftId, false)
          resyncComms()
        })
      setUndoBar((b) => (b?.message === 'Draft discarded.' ? null : b))
    })
  }

  // Send a new email from the composer with Undo: Gmail sends it when the window closes.
  const queueNewEmail = (fields: DraftFields, label: string) => {
    if (fields.draftId) hideDraft(fields.draftId, true)
    const message = `Sending to ${label}…`
    startUndo(
      {
        message,
        undo: () => {
          if (fields.draftId) {
            hideDraft(fields.draftId, false)
            setComposerDraftId(fields.draftId)
            setWriteOpen(true)
          }
        },
      },
      () => {
        sendGmailDraft(fields)
          .then(() => {
            setUndoBar({ message: 'Sent.', done: true })
            setTimeout(() => setUndoBar((b) => (b?.message === 'Sent.' ? null : b)), 2500)
          })
          .catch((e) => {
            // Nothing went out. The draft is still in Gmail, so it reappears in the list.
            setUndoBar({ message: `Not sent: ${e instanceof Error ? e.message : e}. The draft is still saved.`, done: true, error: true })
          })
          .finally(() => {
            if (fields.draftId) hideDraft(fields.draftId, false)
            resyncComms()
          })
      },
    )
  }
  const undoNow = () => {
    if (undoTimer.current) clearTimeout(undoTimer.current)
    undoTimer.current = null
    undoCommit.current = null
    const u = undoBar?.undo
    setUndoBar(null)
    u?.()
  }
  // Star / unstar a whole conversation, optimistically, writing through to Gmail.
  const toggleThreadStar = (threadId: string, starred: boolean) => {
    setComms((d) =>
      d
        ? {
            ...d,
            threads: d.threads.map((t) =>
              t.id === threadId
                ? { ...t, starred, messages: t.messages.map((m) => (m.id?.startsWith('pending-') ? m : { ...m, starred })) }
                : t,
            ),
          }
        : d,
    )
    starThread({ threadId, starred })
      .then((r) => {
        if (!r.ok) {
          resyncComms()
          if (r.needsReconnect) window.alert('Reconnect Gmail to sync stars (the current login predates that permission).')
        }
      })
      .catch(resyncComms)
  }
  // Star / unstar a single message, optimistically, writing through to Gmail.
  const toggleMessageStar = (messageId: string, starred: boolean) => {
    setComms((d) => {
      if (!d) return d
      return {
        ...d,
        threads: d.threads.map((t) => {
          if (!t.messages.some((m) => m.id === messageId)) return t
          const messages = t.messages.map((m) => (m.id === messageId ? { ...m, starred } : m))
          return { ...t, messages, starred: messages.some((m) => m.starred) }
        }),
      }
    })
    starMessage({ messageId, starred })
      .then((r) => {
        if (!r.ok) {
          resyncComms()
          if (r.needsReconnect) window.alert('Reconnect Gmail to sync stars (the current login predates that permission).')
        }
      })
      .catch(resyncComms)
  }

  // Open a new-email Gmail draft in the composer.
  const openDraft = (draftId: string) => {
    setComposerDraftId(draftId)
    setWriteOpen(true)
  }

  // Optimistic reply: show my message in the thread the instant I hit Send (before the Gmail
  // round-trip), and pull it back out if I Undo or the send fails.
  const appendReply = (threadId: string, message: EmailMessage) => {
    setComms((d) =>
      d
        ? {
            ...d,
            threads: d.threads.map((t) =>
              // Leave unread alone (sending a reply marks it read via onRead on the real send; an undo
              // then restores nothing). Only the message list + recency move.
              t.id === threadId
                ? { ...t, messages: [...t.messages, message], lastTs: message.ts ?? t.lastTs, lastDate: message.date || t.lastDate }
                : t,
            ),
          }
        : d,
    )
  }
  const removeReply = (threadId: string, messageId: string) => {
    setComms((d) => {
      if (!d) return d
      return {
        ...d,
        threads: d.threads.map((t) => {
          if (t.id !== threadId) return t
          const messages = t.messages.filter((m) => m.id !== messageId)
          const last = messages[messages.length - 1]
          return { ...t, messages, lastTs: last?.ts ?? 0, lastDate: last?.date ?? '' }
        }),
      }
    })
  }

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

  const openThreadRaw = openThreadId ? comms?.threads.find((t) => t.id === openThreadId) ?? null : null
  // A draft being discarded is gone from the reader too.
  const openThreadObj = openThreadRaw
    ? { ...openThreadRaw, messages: openThreadRaw.messages.filter((m) => !(m.isDraft && m.draftId && hiddenDraftIds.has(m.draftId))) }
    : null

  return (
    <motion.div
      key={project.id}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      className={`flex h-full min-h-0 flex-col ${groundClass}`}
    >
      {/* Slim top bar — always visible: back, title, actions. The bulky event
          header now scrolls inside the Details tab so it doesn't eat the viewport
          while you read. */}
      <div className="px-8 pt-6">
        <div className="flex items-center justify-between gap-4">
          {/* The name box takes all the room up to the action buttons (Michael, 2026-11-13: "Bari and Nick
              Vega's wedding" was cut off with space to spare). It only shrinks when the window does. */}
          <div className="flex min-w-0 flex-1 items-center gap-3">
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
            <div className="min-w-0 flex-1">
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
              onClick={() => setChatOpen(true)}
              title="Ask Claude about this project"
              className="inline-flex items-center gap-1.5 rounded-lg border border-brass-dim/60 bg-surface-3 px-3 py-2 text-[12.5px] font-semibold text-brass-bright transition-colors hover:border-brass"
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8z" />
              </svg>
              Ask Claude
            </button>
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
            <ProjectActions
              project={project}
              onArchive={onArchive}
              onComplete={onComplete}
              onRestore={onRestore}
              onDelete={onDelete}
              onPurge={onPurge}
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
          {dateConflict && <DateConflictFlag variant="banner" projectId={project.id} />}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <TidyCalBar projectId={project.id} />
          <TidyCalBookButtons who={bookingWho} />
        </div>
      </div>

      {/* Content: the full-page thread reader when a conversation is open,
          otherwise the project Details (with the conversations box alongside Tasks). */}
      <div className="board-scroll min-h-0 flex-1 overflow-y-auto px-8 pb-12">
        <div className="max-w-6xl pt-4">
          <ProjectDetailsBody
            onPreview={onPreview}
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
            onOpenContact={onOpenContact}
            onUnlinkContact={onUnlinkContact}
            onAddContact={onAddContact}
            fullView
            tasksAside={
              <MiniComms
                data={comms}
                error={commsError}
                hiddenDraftIds={hiddenDraftIds}
                onOpen={openThread}
                onOpenDraft={openDraft}
                onToggleStar={toggleThreadStar}
                onWrite={() => {
                  setComposerDraftId(null)
                  setWriteOpen(true)
                }}
              />
            }
          />
        </div>
      </div>

      <NotesDrawer project={project} open={notesOpen} onClose={() => setNotesOpen(false)} onSaveField={onSaveField} />

      <ProjectChat open={chatOpen} project={project} onClose={() => setChatOpen(false)} />

      <EmailBuilderModal
        open={writeOpen}
        project={project}
        recipientEmails={recipientEmails}
        draftId={composerDraftId}
        onClose={() => {
          setWriteOpen(false)
          setComposerDraftId(null)
        }}
        onChanged={resyncComms}
        onQueueSend={queueNewEmail}
        onDiscard={discardDraft}
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
                canMarkRead={comms?.canMarkRead !== false}
                onRead={() => markThreadReadLocal(openThreadObj.id)}
                onBack={closeThread}
                onStarMessage={toggleMessageStar}
                onReplySent={appendReply}
                onReplyUndone={removeReply}
                onDraftsChanged={resyncComms}
                onDiscardDraft={discardDraft}
              />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Undo bar for a send or a discard that has not happened yet. */}
      <AnimatePresence>
        {undoBar && (
          <motion.div
            className="fixed bottom-6 left-1/2 z-[70] -translate-x-1/2"
            initial={{ y: 16, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 16, opacity: 0 }}
            transition={{ duration: 0.18 }}
          >
            <div
              className={[
                'flex items-center gap-4 rounded-xl px-4 py-3 text-[13px] shadow-[0_18px_40px_-18px_rgba(0,0,0,0.45)]',
                undoBar.error ? 'bg-[#7a1810] text-white' : 'bg-[#14171b] text-white',
              ].join(' ')}
            >
              <span>{undoBar.message}</span>
              {undoBar.done ? (
                <button type="button" onClick={() => setUndoBar(null)} className="text-[12.5px] font-semibold text-white/70 hover:text-white">
                  Dismiss
                </button>
              ) : (
                <button type="button" onClick={undoNow} className="text-[12.5px] font-semibold text-[#8ab4ff] hover:text-white">
                  Undo
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

const UNDO_MS = 5000
type UndoBarState = { message: string; undo?: () => void; done?: boolean; error?: boolean }
