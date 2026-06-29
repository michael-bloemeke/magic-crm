import { useEffect, useRef, useState } from 'react'
import {
  claudeDraftReply,
  markThreadRead as apiMarkThreadRead,
  sendEmail,
  saveProjectEmail,
  deleteProjectEmail,
  type EmailThread,
  type ProjectEmail,
  type Template,
} from '../api'
import { RichTextEditor } from './RichTextEditor'
import { resolveMergeFields, textToHtml } from '../smartFields'
import type { Project } from '../pipeline'

const ME = 'michael@michaelbloemeke.com'

// True if the HTML body has any actual text/content (ignoring empty tags). The reply is HTML now, so
// reply.trim() would treat a lone <br> as "content"; this checks real text/attachments instead.
function htmlHasContent(html: string): boolean {
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim() !== ''
}

// The reply draft for a thread is stored as a normal CRM email with the kind `reply-<threadId>`, so
// it rides the same draft store as every other composed email and shows up in the conversations list.
function replyKind(threadId: string): string {
  return `reply-${threadId}`
}

// The full-page thread reader: all messages, oldest at the top, newest at the bottom, with the reply
// box below them. Opens scrolled to the bottom (the reply box) and marks the thread read like Gmail
// does. The reply box now carries the same formatting toolbar + template picker as the other email
// boxes, and anything typed auto-saves to drafts (no Save button). Back returns to the project
// Details. The thread dialog itself (header + message bubbles) is unchanged.
export function ThreadReader({
  thread,
  project,
  templates,
  canMarkRead,
  existingDraft,
  onRead,
  onBack,
  onDraftChange,
  onDraftDeleted,
  onStarMessage,
}: {
  thread: EmailThread
  project: Project
  templates: Template[]
  canMarkRead: boolean
  // The reply draft already saved for this thread (so reopening restores what was typed).
  existingDraft?: ProjectEmail | null
  onRead: () => void
  onBack: () => void
  // Keep the parent's draft list in sync as the reply auto-saves / is sent.
  onDraftChange?: (email: ProjectEmail) => void
  onDraftDeleted?: (id: string) => void
  // Toggle the star on a single message (writes through to Gmail). Absent id = a demo message.
  onStarMessage?: (messageId: string, starred: boolean) => void
}) {
  const [reply, setReply] = useState(existingDraft?.body || '')
  const [drafting, setDrafting] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  // The reply box starts as a single line so the latest message is fully visible when the thread
  // opens scrolled to the bottom; it expands once you click in (or when a draft is already present).
  const [composing, setComposing] = useState(!!existingDraft && htmlHasContent(existingDraft.body))
  const to = thread.participants.find((p) => p !== ME) ?? ''
  const subject = /^re:/i.test(thread.subject) ? thread.subject : `Re: ${thread.subject}`
  const unread = thread.unread ?? 0
  const bottomRef = useRef<HTMLDivElement>(null)
  const draftId = useRef<string | undefined>(existingDraft?.id)
  // Becomes true on the first real edit, so the auto-save effect never re-saves a freshly loaded
  // draft on mount (and only deletes on empty after the user actually cleared it).
  const dirty = useRef(false)
  const expanded = composing || htmlHasContent(reply)

  const startComposing = () => {
    setComposing(true)
    requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: 'end' }))
  }

  // On open: scroll to the bottom (the reply box), and mark the thread read like Gmail does when you
  // open a conversation.
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

  // Auto-save the reply to drafts (debounced). Anything written persists as a `reply-<threadId>`
  // draft; clearing it back to empty deletes the draft. Only runs after a real edit (dirty).
  useEffect(() => {
    if (!dirty.current) return
    const t = setTimeout(() => {
      void (async () => {
        try {
          if (htmlHasContent(reply)) {
            const saved = await saveProjectEmail({
              id: draftId.current,
              projectId: project.id,
              kind: replyKind(thread.id),
              to: to ? [to] : [],
              subject,
              body: reply,
              format: 'html',
            })
            draftId.current = saved.id
            onDraftChange?.(saved)
            setStatus('Draft saved.')
          } else if (draftId.current) {
            const id = draftId.current
            draftId.current = undefined
            await deleteProjectEmail(id)
            onDraftDeleted?.(id)
            setStatus(null)
          }
        } catch {
          // best-effort; a failed autosave just leaves the text in the box
        }
      })()
    }, 800)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reply])

  const changeReply = (html: string) => {
    dirty.current = true
    setReply(html)
    if (status) setStatus(null)
  }

  const doDraft = async () => {
    setDrafting(true)
    setStatus('Drafting with Claude. This can take up to a minute.')
    try {
      const threadText = thread.messages
        .map((m) => `${m.from === ME ? 'Michael' : m.fromName || 'Client'}: ${m.body}`)
        .join('\n\n')
      const draft = await claudeDraftReply({ projectId: project.id, threadText })
      changeReply(textToHtml(draft))
      setComposing(true)
      setStatus('Drafted with Claude. Review before sending.')
    } catch (e) {
      setStatus(String(e instanceof Error ? e.message : e))
    } finally {
      setDrafting(false)
    }
  }

  const applyTemplate = (id: string) => {
    const t = templates.find((x) => x.id === id)
    if (!t) return
    const html = t.format === 'html' ? t.body : textToHtml(t.body)
    changeReply(resolveMergeFields(html, project))
    setComposing(true)
  }

  const doSend = async () => {
    if (!htmlHasContent(reply)) return
    setStatus('Sending…')
    try {
      const r = await sendEmail({ projectId: project.id, threadId: thread.id, to, subject, body: reply, format: 'html', mode: 'send' })
      if (r.demo) {
        setStatus(`Demo: this would send to ${to}. Nothing was actually sent.`)
        return
      }
      setStatus('Sent.')
      // The reply went out, so drop its draft.
      if (draftId.current) {
        const id = draftId.current
        draftId.current = undefined
        deleteProjectEmail(id).catch(() => {})
        onDraftDeleted?.(id)
      }
      dirty.current = false
      setReply('')
      onRead() // replying clears the unread flag
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
              key={m.id || i}
              className={['rounded-lg border p-3', mine ? 'border-[#cfe0f5] bg-[#eef4fc]' : 'border-[#e8e4db] bg-white'].join(' ')}
            >
              <div className="mb-1.5 flex items-center justify-between gap-2 text-[11.5px]">
                <span className={mine ? 'font-semibold text-[#2c5a9e]' : 'font-semibold text-[#201c17]'}>
                  {mine ? 'Michael Bloemeke' : m.fromName}
                </span>
                <div className="flex shrink-0 items-center gap-2">
                  {m.id && (
                    <button
                      type="button"
                      onClick={() => onStarMessage?.(m.id as string, !m.starred)}
                      title={m.starred ? 'Unstar (also unstars in Gmail)' : 'Star (also stars in Gmail)'}
                      aria-label={m.starred ? 'Unstar message' : 'Star message'}
                      aria-pressed={!!m.starred}
                      className={['rounded p-0.5 transition-colors', m.starred ? 'text-[#e0a93a]' : 'text-[#c4bfb4] hover:text-[#e0a93a]'].join(' ')}
                    >
                      <StarIcon filled={!!m.starred} />
                    </button>
                  )}
                  <span className="tabular-nums text-[#8a857a]">{m.date}</span>
                </div>
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
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8a857a]">
                Reply {to && <span className="font-normal normal-case tracking-normal text-[#6f6a60]">to {to}</span>}
              </p>
              <div className="flex items-center gap-2">
                {templates.length > 0 && (
                  <div className="relative">
                    <select
                      value=""
                      onChange={(e) => {
                        applyTemplate(e.target.value)
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

            <RichTextEditor
              value={reply}
              onChange={changeReply}
              tone="light"
              minHeight={120}
              placeholder="Write a reply, or let Claude draft one in your voice…"
            />

            <div className="mt-2 flex items-center justify-between gap-3">
              <span className="text-[11.5px] text-[#6f6a60]">{status}</span>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={doSend}
                  disabled={!htmlHasContent(reply)}
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

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l2.7 5.5 6 .9-4.35 4.25 1 6L12 17.8 6.65 19.6l1-6L3.3 9.4l6-.9z" />
    </svg>
  )
}
