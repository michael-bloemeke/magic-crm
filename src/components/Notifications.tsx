import { useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { type Project } from '../pipeline'
import type { InquiryNotification, StatusNotification } from '../api'

// The bell is NOTIFICATIONS ONLY. Tasks live on the Tasks badge and nowhere else, so one overdue
// task is one thing needing attention rather than two. Michael, 2026-08-16: "The bell is
// notification. Tasks are tasks."
type Props = {
  projects: Project[]
  inquiries: InquiryNotification[]
  onDismissInquiry: (blockId: string) => void
  statusNotifications: StatusNotification[]
  onDismissStatus: (id: string) => void
  // Unread client mail, per project. Derived from the live Gmail sync, NOT stored, so reading a
  // message in Gmail makes it disappear from here on the next sync with nothing to dismiss by hand.
  unread: Record<string, number>
  onOpenProject: (project: Project) => void
}

export function Notifications({ projects, inquiries, onDismissInquiry, statusNotifications, onDismissStatus, unread, onOpenProject }: Props) {
  const [open, setOpen] = useState(false)
  const byId = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects])

  // Unread mail, resolved to the projects it belongs to and ignoring anything with a zero count.
  const unreadProjects = useMemo(
    () =>
      Object.entries(unread)
        .filter(([, n]) => n > 0)
        .map(([id, n]) => ({ project: byId.get(id), n }))
        .filter((x): x is { project: Project; n: number } => !!x.project),
    [unread, byId],
  )
  const unreadTotal = unreadProjects.reduce((a, x) => a + x.n, 0)
  const count = statusNotifications.length + inquiries.length + unreadTotal

  const openProject = (projectId: string) => {
    const p = byId.get(projectId)
    if (p) {
      onOpenProject(p)
      setOpen(false)
    }
  }

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
            style={{ backgroundColor: 'var(--color-brass)' }}
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
              className="board-scroll absolute right-0 top-12 z-50 max-h-[70vh] w-[380px] overflow-y-auto rounded-2xl border border-line-strong bg-surface p-3 shadow-[0_30px_60px_-25px_rgba(0,0,0,0.18)]"
            >
              <div className="mb-2 flex items-center justify-between px-1">
                <h3 className="font-display text-[16px] text-parchment">Notifications</h3>
                <span className="text-[11px] text-faint">{count} need attention</span>
              </div>

              {count === 0 ? (
                <p className="px-1 py-6 text-center text-[12px] text-faint">
                  You’re all caught up. Nothing needs a look.
                </p>
              ) : (
                <div className="space-y-3">
                  {statusNotifications.length > 0 && (
                    <section>
                      <p className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-brass">
                        Updates · {statusNotifications.length}
                      </p>
                      <div className="space-y-1.5">
                        {statusNotifications.map((n) => {
                          // A brand-new website inquiry is Michael's top-priority alert: give it a
                          // distinct gold-emphasized card + a sparkle so it stands out from routine
                          // status updates (which stay in the muted style).
                          const isInquiry = n.kind === 'new-inquiry'
                          return (
                          <div
                            key={n.id}
                            className={
                              isInquiry
                                ? 'rounded-lg border border-brass/70 bg-brass/10 px-3 py-2 shadow-[0_0_0_1px_var(--color-brass)]'
                                : 'rounded-lg border border-line bg-surface-2/50 px-3 py-2'
                            }
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span
                                className={
                                  isInquiry
                                    ? 'min-w-0 truncate text-[12.5px] font-semibold text-brass-bright'
                                    : 'min-w-0 truncate text-[12.5px] font-medium text-parchment'
                                }
                              >
                                {isInquiry ? '✨ ' : ''}
                                {n.projectName}
                              </span>
                              <button
                                type="button"
                                onClick={() => onDismissStatus(n.id)}
                                className="shrink-0 text-[11px] text-faint transition-colors hover:text-parchment"
                              >
                                Dismiss
                              </button>
                            </div>
                            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-faint">
                              <span className={isInquiry ? 'font-semibold text-brass' : undefined}>
                                {isInquiry ? 'New website inquiry' : n.label}
                              </span>
                              {byId.has(n.projectId) && (
                                <button
                                  type="button"
                                  onClick={() => openProject(n.projectId)}
                                  className="text-brass-bright underline-offset-2 hover:underline"
                                >
                                  View project
                                </button>
                              )}
                            </div>
                          </div>
                          )
                        })}
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
                                <span className="text-[#dc2626]">Needs review (possible duplicate)</span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}
                  {unreadProjects.length > 0 && (
                    <section>
                      <p className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-brass">
                        Unread mail · {unreadTotal}
                      </p>
                      <div className="space-y-1.5">
                        {unreadProjects.map(({ project, n }) => (
                          <button
                            key={project.id}
                            type="button"
                            onClick={() => openProject(project.id)}
                            className="flex w-full items-center gap-2.5 rounded-lg border border-line bg-surface-2 px-3 py-2 text-left transition-colors hover:bg-surface-3"
                          >
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[13px] font-medium text-parchment">
                                {project.client}
                              </span>
                              <span className="block text-[11px] text-faint">
                                {n} unread message{n === 1 ? '' : 's'}
                              </span>
                            </span>
                          </button>
                        ))}
                      </div>
                      {/* No dismiss button on purpose: these clear themselves when the mail is read,
                          in the CRM or in Gmail. */}
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
