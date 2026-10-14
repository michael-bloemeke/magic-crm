import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { type Project } from '../pipeline'
import { claudeChat, claudeStatus, type ClaudeChatMessage } from '../api'

// A per-project chat with Claude (headless Claude Code, READ-ONLY). It answers questions about this
// project from the live CRM record, the client's emails, the call recordings and the business files.
// It cannot change anything (Michael, 2026-10-14: changes are made in the Claude app, not from inside
// the CRM). The conversation is kept in component state for the session.
export function ProjectChat({
  open,
  project,
  onClose,
}: {
  open: boolean
  project: Project
  onClose: () => void
}) {
  const [messages, setMessages] = useState<ClaudeChatMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [avail, setAvail] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  // Fresh conversation per project.
  useEffect(() => {
    setMessages([])
    setInput('')
    setError(null)
  }, [project.id])
  useEffect(() => {
    if (!open) return
    claudeStatus()
      .then((s) => setAvail(s.configured))
      .catch(() => setAvail(false))
  }, [open])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [messages, busy])

  const send = async () => {
    const msg = input.trim()
    if (!msg || busy) return
    const history = messages
    setMessages((m) => [...m, { role: 'user', text: msg }])
    setInput('')
    setBusy(true)
    setError(null)
    try {
      const reply = await claudeChat({ projectId: project.id, message: msg, history })
      setMessages((m) => [...m, { role: 'assistant', text: reply }])
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[60] flex items-stretch justify-end"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" onClick={() => !busy && onClose()} aria-hidden />
          <motion.div
            className="relative flex h-full w-full max-w-md flex-col border-l border-line-strong bg-surface shadow-[0_0_80px_-20px_rgba(0,0,0,0.18)]"
            initial={{ x: 40, opacity: 0.6 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 40, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="flex items-start justify-between gap-3 border-b border-line px-5 pb-4 pt-5">
              <div className="min-w-0">
                <h2 className="font-display text-[18px] text-parchment">Ask Claude</h2>
                <p className="mt-0.5 truncate text-[12px] text-muted">
                  Questions about {project.client}. It reads everything and changes nothing.
                </p>
              </div>
              <button
                type="button"
                onClick={() => !busy && onClose()}
                aria-label="Close"
                className="rounded-lg border border-line p-1.5 text-muted transition-colors hover:border-line-strong hover:text-parchment"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>

            <div className="board-scroll min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
              {messages.length === 0 && (
                <p className="px-1 py-6 text-center text-[12.5px] leading-relaxed text-faint">
                  Ask anything about this project. For example: "what did they say about parking on the call?", "when did
                  they last email?", or "summarize where this one stands."
                </p>
              )}
              {messages.map((m, i) => (
                <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                  <div
                    className={[
                      'max-w-[85%] whitespace-pre-line rounded-xl px-3 py-2 text-[13px] leading-relaxed',
                      m.role === 'user' ? 'bg-brass text-[#ffffff]' : 'border border-line bg-surface-2/50 text-parchment',
                    ].join(' ')}
                  >
                    {m.text}
                  </div>
                </div>
              ))}
              {busy && <p className="text-[12px] text-faint">Claude is working. This can take up to a minute.</p>}
              {error && <p className="text-[12px] leading-relaxed text-[#dc2626]">{error}</p>}
              <div ref={bottomRef} />
            </div>

            <div className="border-t border-line px-5 py-4">
              {!avail && (
                <p className="mb-2 text-[11px] leading-relaxed text-[#dc2626]">
                  Claude is not set up yet. In Terminal run "claude setup-token", paste the token into
                  magic-crm/claude-credentials.json, then restart the CRM.
                </p>
              )}
              <div className="flex items-end gap-2">
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send()
                  }}
                  rows={2}
                  placeholder="Ask a question about this project… (Cmd+Enter to send)"
                  className="min-h-[2.5rem] flex-1 resize-y rounded-lg border border-line bg-surface-2 px-3 py-2 text-[13px] text-parchment placeholder:text-faint focus:border-brass-dim focus:outline-none"
                />
                <button
                  type="button"
                  onClick={send}
                  disabled={busy || !input.trim()}
                  className="shrink-0 rounded-lg bg-brass px-4 py-2 text-[12.5px] font-semibold text-[#ffffff] transition-all hover:brightness-110 disabled:opacity-40"
                >
                  {busy ? '…' : 'Send'}
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
