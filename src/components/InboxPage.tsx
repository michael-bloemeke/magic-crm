import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { loadInbox, markThreadRead as apiMarkThreadRead, type InboxData, type InboxThread } from '../api'

// One inbox for the whole pipeline: every thread that touches a contact on an
// active project, newest first. Mail unrelated to the pipeline is filtered out.
// Unread threads are highlighted; the composer stays in each project's tab.

const ME = 'michael@michaelbloemeke.com'

type Props = {
  onOpenProject: (projectId: string) => void
  onThreadRead: (projectId: string, count: number) => void
}

export function InboxPage({ onOpenProject, onThreadRead }: Props) {
  const [data, setData] = useState<InboxData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)

  useEffect(() => {
    loadInbox()
      .then((d) => setData(d))
      .catch((e) => setError(String(e?.message || e)))
  }, [])

  // Clear a thread's unread highlight locally + drop its count from the badge.
  const clearThread = (threadId: string) => {
    const t = data?.threads.find((x) => x.id === threadId)
    const count = t?.unread ?? 0
    setData((d) => (d ? { ...d, threads: d.threads.map((x) => (x.id === threadId ? { ...x, unread: 0 } : x)) } : d))
    if (count > 0 && t?.project) onThreadRead(t.project.id, count)
  }

  // Open a thread in the side panel. Opening marks it read, like opening an email.
  const openRow = (t: InboxThread) => {
    setOpenId(t.id)
    if ((t.unread ?? 0) > 0 && data?.canMarkRead !== false) {
      apiMarkThreadRead(t.id)
        .then((r) => r.ok && clearThread(t.id))
        .catch(() => {})
    }
  }

  if (error) {
    return <p className="px-8 pt-10 text-center text-[13px] text-muted">{error}</p>
  }
  if (!data) {
    return <p className="animate-pulse px-8 pt-10 text-center text-[13px] text-faint">Loading inbox…</p>
  }

  const unreadTotal = data.threads.reduce((n, t) => n + (t.unread ?? 0), 0)
  const openThread = openId ? data.threads.find((t) => t.id === openId) ?? null : null

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.35 }}
      className="board-scroll h-full overflow-y-auto px-8 pb-12"
    >
      {!data.connected && (
        <div className="mb-4 flex items-start justify-between gap-4 rounded-xl border border-brass-dim/40 bg-surface-2/60 px-4 py-3">
          <p className="text-[12.5px] leading-relaxed text-muted">
            <span className="font-semibold text-parchment">Showing sample mail.</span> Connect Gmail to load real
            conversations across your active projects.
          </p>
          <a
            href="/api/gmail/auth"
            className="shrink-0 self-center rounded-lg border border-brass-dim/60 bg-gradient-to-b from-surface-3 to-surface px-3 py-1.5 text-[12px] font-semibold text-brass-bright transition-all hover:border-brass"
          >
            Connect Gmail
          </a>
        </div>
      )}

      {data.connected && data.canMarkRead === false && (
        <div className="mb-4 flex items-start justify-between gap-4 rounded-xl border border-brass-dim/40 bg-surface-2/60 px-4 py-3">
          <p className="text-[12.5px] leading-relaxed text-muted">
            <span className="font-semibold text-parchment">Reconnect Gmail</span> to enable marking messages as read
            from the CRM (a one-time permission update).
          </p>
          <a
            href="/api/gmail/auth"
            className="shrink-0 self-center rounded-lg border border-brass-dim/60 bg-gradient-to-b from-surface-3 to-surface px-3 py-1.5 text-[12px] font-semibold text-brass-bright transition-all hover:border-brass"
          >
            Reconnect Gmail
          </a>
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border border-[#e3dfd6] bg-[#f4f2ed] shadow-[0_24px_60px_-34px_rgba(0,0,0,0.85)]">
        <div className="flex items-center justify-between gap-4 border-b border-[#e3dfd6] bg-white px-5 py-3">
          <div>
            <p className="text-[13px] font-semibold text-[#201c17]">Pipeline inbox</p>
            <p className="text-[11.5px] text-[#6f6a60]">Conversations with contacts on your active projects</p>
          </div>
          <span className="shrink-0 text-[11.5px] tabular-nums text-[#8a857a]">
            {data.threads.length} {data.threads.length === 1 ? 'thread' : 'threads'}
            {unreadTotal > 0 ? ` · ${unreadTotal} unread` : ''}
          </span>
        </div>

        {data.error && (
          <p className="px-5 py-3 text-[12.5px] text-[#8a6a2f]">Connected to Gmail, but couldn't load mail: {data.error}</p>
        )}

        {data.threads.length === 0 ? (
          <p className="mx-auto max-w-md px-5 py-14 text-center text-[13px] leading-relaxed text-[#8a857a]">
            No conversations found with any active project's contacts yet.
          </p>
        ) : (
          <div className="space-y-2.5 p-4">
            {data.threads.map((t) => (
              <InboxRow
                key={t.id}
                thread={t}
                canMarkRead={data.canMarkRead !== false}
                onRead={() => clearThread(t.id)}
                onOpen={() => openRow(t)}
                onOpenProject={onOpenProject}
              />
            ))}
          </div>
        )}
      </div>

      <InboxThreadDrawer
        thread={openThread}
        onClose={() => setOpenId(null)}
        onOpenProject={(id) => {
          setOpenId(null)
          onOpenProject(id)
        }}
      />
    </motion.div>
  )
}

// Reading pane: clicking an inbox row opens the thread in a right-side panel (a
// light "email window"). Read-only; replying still happens inside the project.
function InboxThreadDrawer({
  thread,
  onClose,
  onOpenProject,
}: {
  thread: InboxThread | null
  onClose: () => void
  onOpenProject: (projectId: string) => void
}) {
  useEffect(() => {
    if (!thread) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [thread, onClose])

  return (
    <AnimatePresence>
      {thread && (
        <motion.div
          className="fixed inset-0 z-[60] flex justify-end"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          <div className="absolute inset-0 bg-black/55 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
          <motion.aside
            className="board-scroll relative flex h-full w-[560px] max-w-[94vw] flex-col overflow-y-auto border-l border-[#e3dfd6] bg-[#f4f2ed] shadow-[-30px_0_60px_-30px_rgba(0,0,0,0.9)]"
            initial={{ x: 40, opacity: 0.4 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 40, opacity: 0 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-[#e3dfd6] bg-white px-5 py-3.5">
              <div className="min-w-0">
                <p className="truncate text-[14px] font-semibold text-[#201c17]">{thread.subject}</p>
                {thread.project && (
                  <button
                    type="button"
                    onClick={() => onOpenProject(thread.project!.id)}
                    className="mt-1 inline-flex items-center gap-1 rounded-full border border-[#d8c7a4] bg-[#f3ead3] px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.08em] text-[#8a6a2f] transition-colors hover:bg-[#ecdfbf]"
                    title="Open project"
                  >
                    {thread.project.client}
                  </button>
                )}
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="shrink-0 rounded-lg border border-[#d8d3c8] bg-white p-1.5 text-[#6f6a60] transition-colors hover:bg-[#f6f4ef]"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>

            <div className="flex-1 space-y-2.5 px-4 py-4">
              {thread.messages.map((m, i) => {
                const mine = m.from === ME
                return (
                  <div
                    key={i}
                    className={['rounded-lg border p-3', mine ? 'border-[#cfe0f5] bg-[#eef4fc]' : 'border-[#e8e4db] bg-white'].join(' ')}
                  >
                    <div className="mb-1.5 flex items-center justify-between gap-2 text-[11.5px]">
                      <span className={mine ? 'font-semibold text-[#2c5a9e]' : 'font-semibold text-[#201c17]'}>
                        {mine ? 'Michael Bloemeke' : m.fromName}
                      </span>
                      <span className="shrink-0 tabular-nums text-[#8a857a]">{m.date}</span>
                    </div>
                    <p className="whitespace-pre-line text-[13px] leading-relaxed text-[#2c2820]">{m.body}</p>
                  </div>
                )
              })}
            </div>

            {thread.project && (
              <div className="sticky bottom-0 border-t border-[#ece8e0] bg-[#f4f2ed] px-4 py-3">
                <button
                  type="button"
                  onClick={() => onOpenProject(thread.project!.id)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[#d8d3c8] bg-white px-3 py-1.5 text-[12px] font-medium text-[#5f5a50] transition-colors hover:bg-[#f6f4ef]"
                >
                  Open {thread.project.client} to reply
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 6l6 6-6 6" />
                  </svg>
                </button>
              </div>
            )}
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export function InboxRow({
  thread,
  canMarkRead,
  onRead,
  open = false,
  onToggle,
  onOpen,
  onOpenProject,
}: {
  thread: InboxThread
  canMarkRead: boolean
  onRead: () => void
  // Inline-expand mode (UnreadMailModal): open + onToggle, expands the thread below.
  open?: boolean
  onToggle?: () => void
  // Side-panel mode (Inbox page): onOpen opens the thread in a drawer; no inline expand.
  onOpen?: () => void
  onOpenProject: (projectId: string) => void
}) {
  const [marking, setMarking] = useState(false)
  const unread = thread.unread ?? 0
  const last = thread.messages[thread.messages.length - 1]
  const who = last ? (last.from === ME ? 'You' : last.fromName.split(' ')[0]) : ''
  const preview = last ? `${who}: ${last.body.replace(/\s+/g, ' ').trim()}` : ''
  // Newest message on top, first message at the bottom (inline-expand mode).
  const ordered = [...thread.messages].reverse()
  const act = onOpen ?? onToggle ?? (() => {})

  const doMarkRead = async () => {
    setMarking(true)
    try {
      const r = await apiMarkThreadRead(thread.id)
      if (r.ok) onRead()
    } finally {
      setMarking(false)
    }
  }

  return (
    <div
      className={[
        'overflow-hidden rounded-xl border',
        unread > 0 ? 'border-[#e0c386] bg-[#fcf6ea]' : 'border-[#e3dfd6] bg-white',
      ].join(' ')}
    >
      <div className="flex w-full items-center gap-2 px-4 py-3">
        <button type="button" onClick={act} className="flex min-w-0 flex-1 items-center gap-3 text-left">
          {unread > 0 && <span className="h-2 w-2 shrink-0 self-start mt-1 rounded-full bg-[#cb9b5d]" title={`${unread} unread`} />}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className={['truncate text-[14px]', unread > 0 ? 'font-bold text-[#17130d]' : 'font-semibold text-[#201c17]'].join(' ')}>
                {thread.subject}
              </p>
              {thread.project && (
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation()
                    onOpenProject(thread.project!.id)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      e.stopPropagation()
                      onOpenProject(thread.project!.id)
                    }
                  }}
                  className="shrink-0 rounded-full border border-[#d8c7a4] bg-[#f3ead3] px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.08em] text-[#8a6a2f] transition-colors hover:bg-[#ecdfbf]"
                  title="Open project"
                >
                  {thread.project.client}
                </span>
              )}
              {unread > 0 && (
                <span className="shrink-0 rounded-full bg-[#cb9b5d] px-1.5 py-0.5 text-[9.5px] font-bold text-white">
                  {unread} new
                </span>
              )}
            </div>
            <p className={['mt-0.5 truncate text-[12px]', unread > 0 ? 'text-[#5a5347]' : 'text-[#6f6a60]'].join(' ')}>
              {preview}
            </p>
          </div>
        </button>

        {unread > 0 && canMarkRead && (
          <button
            type="button"
            onClick={doMarkRead}
            disabled={marking}
            title="Mark as read"
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-[#d8d3c8] bg-white px-2 py-1 text-[10.5px] font-medium text-[#6f6a60] transition-colors hover:bg-[#f6f4ef] disabled:opacity-50"
          >
            <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6L9 17l-5-5" />
            </svg>
            {marking ? '…' : 'Mark read'}
          </button>
        )}

        <span className="shrink-0 text-[11px] tabular-nums text-[#8a857a]">{thread.lastDate}</span>
        <button type="button" onClick={act} aria-label={onOpen ? 'Open' : open ? 'Collapse' : 'Expand'} className="shrink-0">
          <svg
            viewBox="0 0 24 24"
            className={['h-4 w-4 text-[#9b958a] transition-transform', !onOpen && open ? 'rotate-180' : ''].join(' ')}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d={onOpen ? 'M9 6l6 6-6 6' : 'M6 9l6 6 6-6'} />
          </svg>
        </button>
      </div>

      {open && (
        <div className="border-t border-[#ece8e0] bg-[#faf9f6] px-4 pb-4 pt-3">
          <div className="space-y-2.5">
            {ordered.map((m, i) => {
              const mine = m.from === ME
              return (
                <div
                  key={i}
                  className={['rounded-lg border p-3', mine ? 'border-[#cfe0f5] bg-[#eef4fc]' : 'border-[#e8e4db] bg-white'].join(' ')}
                >
                  <div className="mb-1.5 flex items-center justify-between gap-2 text-[11.5px]">
                    <span className={mine ? 'font-semibold text-[#2c5a9e]' : 'font-semibold text-[#201c17]'}>
                      {mine ? 'Michael Bloemeke' : m.fromName}
                    </span>
                    <span className="shrink-0 tabular-nums text-[#8a857a]">{m.date}</span>
                  </div>
                  <p className="whitespace-pre-line text-[13px] leading-relaxed text-[#2c2820]">{m.body}</p>
                </div>
              )
            })}
          </div>
          {thread.project && (
            <button
              type="button"
              onClick={() => onOpenProject(thread.project!.id)}
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-[#d8d3c8] bg-white px-3 py-1.5 text-[12px] font-medium text-[#5f5a50] transition-colors hover:bg-[#f6f4ef]"
            >
              Open {thread.project.client} to reply
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 6l6 6-6 6" />
              </svg>
            </button>
          )}
        </div>
      )}
    </div>
  )
}
