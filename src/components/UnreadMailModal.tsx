import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { loadInbox, type InboxData, type InboxThread } from '../api'
import { InboxRow } from './InboxPage'

// A focused window of ONLY the unread messages from active-project contacts,
// opened from the home page mail icon. Reuses the inbox row.

type Props = {
  open: boolean
  onClose: () => void
  onOpenProject: (projectId: string) => void
  onThreadRead: (projectId: string, count: number) => void
}

export function UnreadMailModal({ open, onClose, onOpenProject, onThreadRead }: Props) {
  const [data, setData] = useState<InboxData | null>(null)
  const [threads, setThreads] = useState<InboxThread[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setData(null)
    setError(null)
    setOpenId(null)
    loadInbox()
      .then((d) => {
        setData(d)
        setThreads(d.threads.filter((t) => (t.unread ?? 0) > 0))
      })
      .catch((e) => setError(String(e?.message || e)))
  }, [open])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    if (open) window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const clearThread = (threadId: string) => {
    const t = threads.find((x) => x.id === threadId)
    const count = t?.unread ?? 0
    setThreads((prev) => prev.filter((x) => x.id !== threadId)) // drop it from the unread window
    if (count > 0 && t?.project) onThreadRead(t.project.id, count)
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[60] flex items-start justify-center p-4 pt-[8vh]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          <div className="absolute inset-0 bg-black/55 backdrop-blur-[2px]" onClick={onClose} aria-hidden />

          <motion.div
            className="relative flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-[#e3dfd6] bg-[#f4f2ed] shadow-[0_30px_70px_-25px_rgba(0,0,0,0.9)]"
            initial={{ y: 18, opacity: 0.6, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 18, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="flex items-center justify-between gap-4 border-b border-[#e3dfd6] bg-white px-5 py-3">
              <div>
                <p className="text-[14px] font-semibold text-[#201c17]">Unread mail</p>
                <p className="text-[11.5px] text-[#6f6a60]">New messages from your active clients</p>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-[#d8d3c8] bg-white p-1.5 text-[#6f6a60] transition-colors hover:bg-[#f6f4ef]"
                aria-label="Close"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>

            <div className="board-scroll min-h-0 flex-1 overflow-y-auto">
              {error ? (
                <p className="px-5 py-12 text-center text-[13px] text-[#8a6a2f]">{error}</p>
              ) : !data ? (
                <p className="animate-pulse px-5 py-12 text-center text-[13px] text-[#8a857a]">Loading…</p>
              ) : !data.connected ? (
                <p className="px-5 py-12 text-center text-[13px] text-[#8a857a]">
                  Connect Gmail to see unread client mail here.
                </p>
              ) : threads.length === 0 ? (
                <p className="px-5 py-14 text-center text-[13px] text-[#8a857a]">No unread client messages. Inbox zero.</p>
              ) : (
                <div className="space-y-2.5 p-4">
                  {threads.map((t) => (
                    <InboxRow
                      key={t.id}
                      thread={t}
                      canMarkRead={data.canMarkRead !== false}
                      onRead={() => clearThread(t.id)}
                      open={openId === t.id}
                      onToggle={() => setOpenId((id) => (id === t.id ? null : t.id))}
                      onOpenProject={(id) => {
                        onClose()
                        onOpenProject(id)
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
