import { useEffect, useRef, useState } from 'react'
import {
  claudeDraftReply,
  markThreadRead as apiMarkThreadRead,
  sendEmail,
  type EmailThread,
  type Template,
} from '../api'
import type { Project } from '../pipeline'

const ME = 'michael@michaelbloemeke.com'

// The full-page thread reader: all messages, oldest at the top, newest at the
// bottom, with the reply box below them. Opens scrolled to the bottom (the reply
// box) and marks the thread read like Gmail does. Back returns to the project
// Details. (Previously lived inside the now-removed Communications tab.)
export function ThreadReader({
  thread,
  project,
  templates,
  canMarkRead,
  onRead,
  onBack,
}: {
  thread: EmailThread
  project: Project
  templates: Template[]
  canMarkRead: boolean
  onRead: () => void
  onBack: () => void
}) {
  const [reply, setReply] = useState('')
  const [drafting, setDrafting] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  // The reply box starts as a single line so the latest message is fully visible
  // when the thread opens scrolled to the bottom; it expands once you click in.
  const [composing, setComposing] = useState(false)
  const to = thread.participants.find((p) => p !== ME) ?? ''
  const unread = thread.unread ?? 0
  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const expanded = composing || reply.trim().length > 0

  const startComposing = () => {
    setComposing(true)
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      bottomRef.current?.scrollIntoView({ block: 'end' })
    })
  }

  // On open: scroll to the bottom (the reply box), and mark the thread read like
  // Gmail does when you open a conversation.
  useEffect(() => {
    const id = requestAnimationFrame(() =>
      requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: 'end' })),
    )
    if (unread > 0 && canMarkRead) {
      apiMarkThreadRead(thread.id)
        .then((r) => {
          if (r.ok) onRead()
        })
        .catch(() => {})
    }
    return () => cancelAnimationFrame(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const doDraft = async () => {
    setDrafting(true)
    setStatus('Drafting with Claude. This can take up to a minute.')
    try {
      const threadText = thread.messages
        .map((m) => `${m.from === ME ? 'Michael' : m.fromName || 'Client'}: ${m.body}`)
        .join('\n\n')
      const draft = await claudeDraftReply({ projectId: project.id, threadText })
      setReply(draft)
      setStatus('Drafted with Claude. Review before sending.')
    } catch (e) {
      setStatus(String(e instanceof Error ? e.message : e))
    } finally {
      setDrafting(false)
    }
  }

  const doSend = async (mode: 'send' | 'draft') => {
    if (!reply.trim()) return
    setStatus(mode === 'send' ? 'Sending…' : 'Saving…')
    const subject = /^re:/i.test(thread.subject) ? thread.subject : `Re: ${thread.subject}`
    try {
      const r = await sendEmail({ projectId: project.id, threadId: thread.id, to, subject, body: reply, mode })
      if (r.demo) {
        setStatus(
          mode === 'send'
            ? `Demo: this would send to ${to}. Nothing was actually sent.`
            : `Demo: this would be saved to your Gmail drafts.`,
        )
      } else {
        setStatus(mode === 'send' ? 'Sent.' : 'Saved to drafts.')
        if (mode === 'send') {
          setReply('')
          onRead() // replying clears the unread flag
        }
      }
    } catch {
      setStatus('Something went wrong.')
    }
  }

  return (
    // No overflow-hidden here so the header can stay sticky while the thread scrolls.
    <div className="rounded-2xl border border-[#e3dfd6] bg-[#f4f2ed] shadow-[0_24px_60px_-34px_rgba(0,0,0,0.85)]">
      {/* Header: back + subject — sticky so Back is reachable anywhere in the thread */}
      <div className="sticky top-0 z-20 flex items-center gap-3 rounded-t-2xl border-b border-[#e3dfd6] bg-white px-4 py-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-[#d8d3c8] bg-white px-2.5 py-1.5 text-[12px] font-medium text-[#5f5a50] transition-colors hover:bg-[#f6f4ef]"
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 6l-6 6 6 6" />
          </svg>
          Back
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-semibold text-[#201c17]">{thread.subject}</p>
          {to && <p className="truncate text-[11.5px] text-[#6f6a60]">{to}</p>}
        </div>
        <span className="shrink-0 text-[11px] tabular-nums text-[#8a857a]">
          {thread.messages.length} {thread.messages.length === 1 ? 'msg' : 'msgs'}
        </span>
      </div>

      {/* Messages — oldest at top, newest at bottom. Mine = blue, client = white. */}
      <div className="space-y-2.5 bg-[#faf9f6] px-4 py-4">
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

      {/* Composer (the bottom of the page) — collapsed to one line until clicked */}
      <div className="rounded-b-2xl border-t border-[#ece8e0] bg-[#f4f2ed] px-4 pb-4 pt-3">
        {!expanded ? (
          <button
            type="button"
            onClick={startComposing}
            className="flex w-full items-center gap-2 rounded-lg border border-[#dcd7cc] bg-white px-3 py-2.5 text-left text-[13px] text-[#9b958a] transition-colors hover:border-[#cb9b5d]"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-[#bdb7aa]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 10h11M3 6h18M3 14h18M3 18h11" />
              <path d="M18 14l3 3-3 3" />
            </svg>
            Reply{to && ` to ${to}`}…
          </button>
        ) : (
          <div className="rounded-lg border border-[#e3dfd6] bg-white p-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8a857a]">
              Reply {to && <span className="font-normal normal-case tracking-normal text-[#6f6a60]">to {to}</span>}
            </p>
            <div className="flex items-center gap-2">
              {templates.length > 0 && (
                <div className="relative">
                  <select
                    value=""
                    onChange={(e) => {
                      const t = templates.find((x) => x.id === e.target.value)
                      if (t) {
                        setReply(t.body)
                        setStatus(null)
                      }
                      e.currentTarget.selectedIndex = 0
                    }}
                    className="cursor-pointer appearance-none rounded-lg border border-[#dcd7cc] bg-white py-1 pl-2.5 pr-7 text-[11.5px] font-medium text-[#5f5a50] focus:border-[#cb9b5d] focus:outline-none"
                    title="Insert a template"
                  >
                    <option value="" disabled>
                      Use template…
                    </option>
                    {templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                  <svg viewBox="0 0 24 24" className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-[#9b958a]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </div>
              )}
              <button
                type="button"
                onClick={doDraft}
                disabled={drafting}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#e0cfa6] bg-[#fbf4e6] px-2.5 py-1 text-[11.5px] font-semibold text-[#8a6a2f] transition-colors hover:bg-[#f7edd6] disabled:opacity-50"
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8z" />
                  <path d="M19 14l.9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9z" />
                </svg>
                {drafting ? 'Drafting…' : 'Draft with Claude'}
              </button>
            </div>
          </div>

          <textarea
            ref={textareaRef}
            value={reply}
            onChange={(e) => {
              setReply(e.target.value)
              setStatus(null)
            }}
            rows={6}
            placeholder="Write a reply, or let Claude draft one in your voice…"
            className="w-full resize-y rounded-lg border border-[#dcd7cc] bg-[#faf9f6] p-3 text-[13px] leading-relaxed text-[#221e18] placeholder:text-[#9b958a] focus:border-[#cb9b5d] focus:outline-none"
          />

          <div className="mt-2 flex items-center justify-between gap-3">
            <span className="text-[11.5px] text-[#6f6a60]">{status}</span>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => doSend('draft')}
                disabled={!reply.trim()}
                className="rounded-lg border border-[#d8d3c8] bg-white px-3 py-1.5 text-[12px] font-medium text-[#5f5a50] transition-colors hover:bg-[#f6f4ef] disabled:opacity-40"
              >
                Save to Gmail drafts
              </button>
              <button
                type="button"
                onClick={() => doSend('send')}
                disabled={!reply.trim()}
                className="rounded-lg bg-brass px-4 py-1.5 text-[12px] font-semibold text-[#231a0c] transition-all hover:brightness-110 disabled:opacity-40"
              >
                Send
              </button>
            </div>
          </div>
          </div>
        )}
      </div>

      <div ref={bottomRef} />
    </div>
  )
}
