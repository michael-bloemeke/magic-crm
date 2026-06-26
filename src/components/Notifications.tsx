import { useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { todayISO, type Project } from '../pipeline'
import type { Task, InquiryNotification, QuestionnaireSubmission } from '../api'
import { TaskRow } from './TaskRow'

type Props = {
  tasks: Task[]
  projects: Project[]
  inquiries: InquiryNotification[]
  onDismissInquiry: (blockId: string) => void
  submissions: QuestionnaireSubmission[]
  onDismissSubmission: (projectId: string) => void
  onToggle: (id: string, done: boolean) => void
  onDelete: (id: string) => void
  onOpenProject: (project: Project) => void
}

export function Notifications({ tasks, projects, inquiries, onDismissInquiry, submissions, onDismissSubmission, onToggle, onDelete, onOpenProject }: Props) {
  const [open, setOpen] = useState(false)
  const byId = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects])

  const today = todayISO()
  const overdue = tasks
    .filter((t) => !t.done && t.dueDate && t.dueDate < today)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
  const dueToday = tasks.filter((t) => !t.done && t.dueDate === today)
  const count = submissions.length + inquiries.length + overdue.length + dueToday.length

  const openProject = (projectId: string) => {
    const p = byId.get(projectId)
    if (p) {
      onOpenProject(p)
      setOpen(false)
    }
  }

  const renderTask = (t: Task) => (
    <TaskRow
      key={t.id}
      task={t}
      projectName={byId.get(t.projectId)?.client ?? 'Unknown project'}
      onToggle={(done) => onToggle(t.id, done)}
      onDelete={() => onDelete(t.id)}
      onOpenProject={() => openProject(t.projectId)}
    />
  )

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Notifications"
        className="relative flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-surface/60 text-muted transition-colors hover:border-line-strong hover:text-parchment"
      >
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.5 21a2 2 0 0 1-3 0" />
        </svg>
        {count > 0 && (
          <span
            className="absolute -right-1 -top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10px] font-bold text-canvas"
            style={{ backgroundColor: overdue.length ? '#e08a6b' : 'var(--color-brass)' }}
          >
            {count}
          </span>
        )}
      </button>

      <AnimatePresence>
        {open && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
            <motion.div
              initial={{ opacity: 0, y: -8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.98 }}
              transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
              className="board-scroll absolute right-0 top-12 z-50 max-h-[70vh] w-[380px] overflow-y-auto rounded-2xl border border-line-strong bg-surface p-3 shadow-[0_30px_60px_-25px_rgba(0,0,0,0.9)]"
            >
              <div className="mb-2 flex items-center justify-between px-1">
                <h3 className="font-display text-[16px] text-parchment">Notifications</h3>
                <span className="text-[11px] text-faint">{count} need attention</span>
              </div>

              {count === 0 ? (
                <p className="px-1 py-6 text-center text-[12px] text-faint">
                  You’re all caught up. Nothing due today or overdue.
                </p>
              ) : (
                <div className="space-y-3">
                  {submissions.length > 0 && (
                    <section>
                      <p className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-brass">
                        Questionnaire submitted · {submissions.length}
                      </p>
                      <div className="space-y-1.5">
                        {submissions.map((s) => (
                          <div key={s.projectId} className="rounded-lg border border-line bg-surface-2/50 px-3 py-2">
                            <div className="flex items-center justify-between gap-2">
                              <span className="min-w-0 truncate text-[12.5px] font-medium text-parchment">{s.projectName}</span>
                              <button
                                type="button"
                                onClick={() => onDismissSubmission(s.projectId)}
                                className="shrink-0 text-[11px] text-faint transition-colors hover:text-parchment"
                              >
                                Dismiss
                              </button>
                            </div>
                            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-faint">
                              <span>Filled out their questionnaire</span>
                              {byId.has(s.projectId) && (
                                <button
                                  type="button"
                                  onClick={() => openProject(s.projectId)}
                                  className="text-brass-bright underline-offset-2 hover:underline"
                                >
                                  View project
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}
                  {inquiries.length > 0 && (
                    <section>
                      <p className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-brass">
                        New inquiries · {inquiries.length}
                      </p>
                      <div className="space-y-1.5">
                        {inquiries.map((i) => (
                          <div key={i.blockId} className="rounded-lg border border-line bg-surface-2/50 px-3 py-2">
                            <div className="flex items-center justify-between gap-2">
                              <span className="min-w-0 truncate text-[12.5px] font-medium text-parchment">
                                {i.name || i.email || 'New inquiry'}
                              </span>
                              <button
                                type="button"
                                onClick={() => onDismissInquiry(i.blockId)}
                                className="shrink-0 text-[11px] text-faint transition-colors hover:text-parchment"
                              >
                                Dismiss
                              </button>
                            </div>
                            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-faint">
                              {i.eventDate && <span>Event {i.eventDate}</span>}
                              {i.projectId ? (
                                <button
                                  type="button"
                                  onClick={() => openProject(i.projectId as string)}
                                  className="text-brass-bright underline-offset-2 hover:underline"
                                >
                                  View project
                                </button>
                              ) : (
                                <span className="text-[#e08a6b]">Needs review (possible duplicate)</span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}
                  {overdue.length > 0 && (
                    <section>
                      <p className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-[0.16em]" style={{ color: '#e08a6b' }}>
                        Overdue · {overdue.length}
                      </p>
                      <div className="space-y-1.5">{overdue.map(renderTask)}</div>
                    </section>
                  )}
                  {dueToday.length > 0 && (
                    <section>
                      <p className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-brass">
                        Due today · {dueToday.length}
                      </p>
                      <div className="space-y-1.5">{dueToday.map(renderTask)}</div>
                    </section>
                  )}
                </div>
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  )
}
