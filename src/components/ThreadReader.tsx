import { useEffect, useRef, useState } from 'react'
import {
  claudeDraftReply,
  markThreadRead as apiMarkThreadRead,
  sendEmail,
  saveProjectEmail,
  deleteProjectEmail,
  type EmailThread,
  type ProjectEmail,
} from '../api'
import type { EmailMessage } from '../api'
import { RichTextEditor } from './RichTextEditor'
import { textToHtml } from '../smartFields'
import type { Project } from '../pipeline'

const ME = 'michael@michaelbloemeke.com'
// How long the reply is held (showing "Undo") before it actually sends, Gmail-style.
const UNDO_WINDOW_MS = 5000

// A readable plain-text version of the reply HTML for the optimistic message bubble (which renders
// plain text with line breaks). Not what gets sent (that stays full HTML) — just the preview.
function htmlToPlainText(html: string): string {
  return html
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// "Jun 30, 2026" to match how the backend formats message dates.
function fmtToday(): string {
  return new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// True if the HTML body has any actual content (ignoring empty tags). The reply is HTML now, so
// reply.trim() would treat a lone <br> as "content"; this checks real text, or an embedded image
// (a pasted picture is real content even with no surrounding text).
function htmlHasContent(html: string): boolean {
  if (/<(img|video|audio)\b/i.test(html)) return true
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim() !== ''
}

// The reply draft for a thread is stored as a normal CRM email with the kind `reply-<threadId>`, so
// it rides the same draft store as every other composed email and shows up in the conversations list.
function replyKind(threadId: string): string {
  return `reply-${threadId}`
}

// The full-page thread reader: all messages, oldest at the top, newest at the bottom, with the reply
// box below them. Opens scrolled to the bottom (the reply box) and marks the thread read like Gmail
// does. The reply box carries the same formatting toolbar as the other email boxes, and anything
// typed auto-saves to drafts (no Save button). Back returns to the project Details. The thread
// dialog itself (header + message bubbles) is unchanged. (The template picker that used to sit here
// went away with the template library on 2026-07-31.)
export function ThreadReader({
  thread,
  project,
  canMarkRead,
  existingDraft,
  onRead,
  onBack,
  onDraftChange,
  onDraftDeleted,
  onStarMessage,
  onReplySent,
  onReplyUndone,
}: {
  thread: EmailThread
  project: Project
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
  // Optimistically add my reply to the thread the instant I send (before the real Gmail round-trip),
  // and remove it again if I hit Undo or the send fails.
  onReplySent?: (threadId: string, message: EmailMessage) => void
  onReplyUndone?: (threadId: string, messageId: string) => void
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
  // True from the moment Send starts, so a debounced autosave that fires during/after the send can't
  // resurrect the draft we're deleting. savingRef holds the in-flight autosave so Send can await it.
  const sending = useRef(false)
  const savingRef = useRef<Promise<void> | null>(null)
  // Undo-send: when true, the reply has been queued (shown in the thread) but not actually sent yet —
  // the undo bar is up. The timer/html/temp-id refs survive re-renders so the unmount flush can fire.
  const [pending, setPending] = useState(false)
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingHtml = useRef<string | null>(null)
  const pendingTempId = useRef<string | null>(null)
  // Points at the latest fireSend so the unmount flush runs the exact same send/cleanup logic.
  const fireSendRef = useRef<((html: string, tempId: string | null) => void) | null>(null)
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
      if (sending.current) return // a send is in progress; don't write a draft we're about to drop
      const run = async () => {
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
      }
      savingRef.current = run().finally(() => {
        savingRef.current = null
      })
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

  // Actually send (after the undo window elapses, or on flush). Drops the draft on success; on a demo
  // or failure it pulls the optimistic message and puts the text back so nothing is silently lost.
  const fireSend = async (html: string, tempId: string | null) => {
    if (pendingTimer.current) {
      clearTimeout(pendingTimer.current)
      pendingTimer.current = null
    }
    pendingHtml.current = null
    setPending(false)
    try {
      const r = await sendEmail({ projectId: project.id, threadId: thread.id, to, subject, body: html, format: 'html', mode: 'send' })
      if (r.demo) {
        if (tempId) onReplyUndone?.(thread.id, tempId)
        pendingTempId.current = null
        setReply(html)
        setComposing(true)
        dirty.current = true
        setStatus(`Demo: this would send to ${to}. Nothing was actually sent.`)
        sending.current = false
        return
      }
      // Sent for real: let any in-flight autosave settle (so draftId is current), then drop the draft.
      if (savingRef.current) {
        try {
          await savingRef.current
        } catch {
          // ignore; we delete by whatever id we end up with
        }
      }
      if (draftId.current) {
        const id = draftId.current
        draftId.current = undefined
        deleteProjectEmail(id).catch(() => {})
        onDraftDeleted?.(id)
      }
      pendingTempId.current = null
      dirty.current = false
      onRead() // replying clears the unread flag
      sending.current = false // a fresh follow-up reply in this thread can autosave again
    } catch {
      if (tempId) onReplyUndone?.(thread.id, tempId)
      pendingTempId.current = null
      setReply(html)
      setComposing(true)
      dirty.current = true
      setStatus('Could not send. Your message was put back.')
      sending.current = false
    }
  }

  // Click Send: show the reply in the thread immediately and start the undo window — the real send
  // is held for a few seconds so it can be undone (Gmail-style).
  const queueSend = () => {
    if (!htmlHasContent(reply)) return
    const html = reply
    sending.current = true // block autosave from touching the draft while the send is queued
    pendingHtml.current = html
    const tempId = `pending-${Date.now()}`
    pendingTempId.current = tempId
    onReplySent?.(thread.id, {
      id: tempId,
      from: ME,
      fromName: 'Michael Bloemeke',
      date: fmtToday(),
      ts: Date.now(),
      body: htmlToPlainText(html),
    })
    setReply('')
    setComposing(false)
    setStatus(null)
    setPending(true)
    pendingTimer.current = setTimeout(() => void fireSend(html, tempId), UNDO_WINDOW_MS)
    requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: 'end' }))
  }

  // Undo within the window: cancel the timer, pull the optimistic message, restore the composer.
  // If the timer already fired (fireSend cleared it), the send is committed — do nothing.
  const undoSend = () => {
    if (!pendingTimer.current) return
    clearTimeout(pendingTimer.current)
    pendingTimer.current = null
    const html = pendingHtml.current || ''
    pendingHtml.current = null
    setPending(false)
    sending.current = false
    if (pendingTempId.current) {
      onReplyUndone?.(thread.id, pendingTempId.current)
      pendingTempId.current = null
    }
    setReply(html)
    setComposing(true)
    dirty.current = true
    setStatus(null)
  }

  // Keep the unmount flush pointed at the current send logic (fireSend closes over live state).
  useEffect(() => {
    fireSendRef.current = fireSend
  })

  // If the thread is closed (or we navigate away) while a send is still queued, flush it through the
  // SAME fireSend path so the reply isn't lost and the draft / optimistic message reconcile correctly
  // (delete the draft + notify the parent on success; pull the optimistic bubble on demo/failure).
  // The parent (ProjectView) stays mounted, so its callbacks still take effect; fireSend's own
  // setState calls are harmless no-ops on the now-unmounting component.
  useEffect(() => {
    return () => {
      if (!pendingTimer.current) return
      const html = pendingHtml.current
      const tempId = pendingTempId.current
      if (html) fireSendRef.current?.(html, tempId)
    }
  }, [])

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
          // An unsent Gmail draft. Deliberately loud about being unsent (dashed amber, a badge, and
          // "Not sent" where the date would be), because the whole point of this pane is knowing
          // what the client has actually received.
          if (m.isDraft) {
            return (
              <div key={m.id || i} className="rounded-lg border border-dashed border-[#e0cfa6] bg-[#fdf8ec] p-3">
                <div className="mb-1.5 flex items-center justify-between gap-2 text-[11.5px]">
                  <span className="flex items-center gap-1.5 font-semibold text-[#8a6a2f]">
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                    </svg>
                    Unsent draft
                  </span>
                  <span className="shrink-0 font-medium text-[#a08a5c]">Not sent</span>
                </div>
                <p className="whitespace-pre-line text-[13px] leading-relaxed text-[#6b6250]">{m.body}</p>
                <p className="mt-2 text-[11px] text-[#a08a5c]">
                  Sitting in Gmail drafts. Nothing here has gone to the client.
                </p>
              </div>
            )
          }
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
                  {m.id && !m.id.startsWith('pending-') && (
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

      {/* Composer (the bottom of the page) — collapsed to one line until clicked. While a send is
          held in the undo window, the undo bar takes its place. */}
      <div className="rounded-b-2xl border-t border-[#ece8e0] bg-[#f4f2ed] px-4 pb-4 pt-3">
        {pending ? (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-[#cfe3d4] bg-[#eef6f0] px-3.5 py-2.5">
            <span className="flex items-center gap-2 text-[12.5px] font-medium text-[#2f6b43]">
              <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 6L9 17l-5-5" />
              </svg>
              Message sent.
            </span>
            <button
              type="button"
              onClick={undoSend}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#bcd9c5] bg-white px-3 py-1.5 text-[12px] font-semibold text-[#2f6b43] transition-colors hover:bg-[#f3faf5]"
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 14L4 9l5-5" />
                <path d="M4 9h11a5 5 0 0 1 0 10h-1" />
              </svg>
              Undo
            </button>
          </div>
        ) : !expanded ? (
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
                  onClick={queueSend}
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
