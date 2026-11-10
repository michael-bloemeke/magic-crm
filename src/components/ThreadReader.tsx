import { useEffect, useRef, useState } from 'react'
import {
  claudeDraftReply,
  getGmailDraft,
  markThreadRead as apiMarkThreadRead,
  loadConfig,
  loadCustomValues,
  type EmailAttachment,
  type EmailThread,
  type GmailAttachment,
  type DraftFields,
} from '../api'
import type { EmailMessage } from '../api'
import { RichTextEditor } from './RichTextEditor'
import { EmailAttachments } from './EmailAttachments'
import { textToHtml, resolveMergeFields } from '../smartFields'
import { findTemplate } from '../emailTemplates'
import { TemplateMenu } from './TemplateMenu'
import { hasSignature, withSignature, withoutSignature } from '../emailSignature'
import { DraftSession, draftStatusText, htmlHasContent, type DraftStatus } from '../gmailDraft'
import { fmtSize } from '../attachments'
import type { Project } from '../pipeline'

const ME = 'michael@michaelbloemeke.com'
// How long the reply is held (showing "Undo") before it actually sends, Gmail-style.
const UNDO_WINDOW_MS = 5000

// A readable plain-text version of the reply HTML for the optimistic message bubble (which renders
// plain text with line breaks). Not what gets sent (that stays full HTML), just the preview.
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

// The full-page thread reader: all messages, oldest at the top, newest at the bottom, with the reply
// box below them. Opens scrolled to the bottom and marks the thread read, like Gmail.
//
// THE REPLY BOX IS A GMAIL DRAFT (2026-11-10). Whatever is typed is saved into Gmail Drafts as a reply
// in this conversation, so it is there in Gmail too. If the conversation already has a draft (started
// in Gmail, or in the CRM earlier), it opens in the reply box, ready to edit and send. Sending it is
// Gmail's own send, so the draft leaves Drafts. Discarding hands the draft to the parent, which deletes
// it after a few seconds unless Undo is pressed.
//
// The reply box also carries the Ghostbuster TEMPLATE picker (body only: the subject belongs to the
// thread), Claude drafting, the SIGNATURE checkbox, and ATTACHMENTS.
export function ThreadReader({
  thread,
  project,
  canMarkRead,
  onRead,
  onBack,
  onStarMessage,
  onReplySent,
  onReplyUndone,
  onDraftsChanged,
  onDiscardDraft,
}: {
  thread: EmailThread
  project: Project
  canMarkRead: boolean
  onRead: () => void
  onBack: () => void
  // Toggle the star on a single message (writes through to Gmail). Absent id = a demo message.
  onStarMessage?: (messageId: string, starred: boolean) => void
  // Optimistically add my reply to the thread the instant I send (before the real Gmail round-trip),
  // and remove it again if I hit Undo or the send fails.
  onReplySent?: (threadId: string, message: EmailMessage) => void
  onReplyUndone?: (threadId: string, messageId: string) => void
  // A draft was created, sent or deleted: re-read the conversations so the list matches Gmail.
  onDraftsChanged?: () => void
  // Discard this Gmail draft. The parent deletes it after an Undo window.
  onDiscardDraft?: (draftId: string) => void
}) {
  // Like Gmail's Reply: to whoever wrote the latest message that was not mine.
  const lastIncoming = [...thread.messages].reverse().find((m) => !m.isDraft && m.from !== ME)
  const defaultTo = lastIncoming?.from || thread.participants.find((p) => p !== ME) || ''
  const people = thread.participants.filter((p) => p !== ME).join(', ')
  const defaultSubject = /^re:/i.test(thread.subject) ? thread.subject : `Re: ${thread.subject}`
  // The newest draft in this conversation that can be opened (it has a Gmail draft id). It is shown
  // IN the reply box, so it is left out of the message list above.
  const draftMsg = [...thread.messages].reverse().find((m) => m.isDraft && m.draftId) ?? null

  const [reply, setReply] = useState('')
  const [to, setTo] = useState(defaultTo)
  const [cc, setCc] = useState('')
  const [showCc, setShowCc] = useState(false)
  const [subject, setSubject] = useState(defaultSubject)
  const [quoteHtml, setQuoteHtml] = useState('')
  const [attachments, setAttachments] = useState<EmailAttachment[]>([])
  const [gmailAtts, setGmailAtts] = useState<GmailAttachment[]>([])
  const [loadingDraft, setLoadingDraft] = useState(!!draftMsg)
  const [fromGmailDraft, setFromGmailDraft] = useState(false)
  // Selected template ('' = none). Fills the BODY only; a reply's subject belongs to the thread.
  const [templateId, setTemplateId] = useState('')
  // Signature content from Settings; whether this reply carries it is derived from the body.
  const [sig, setSig] = useState<{ enabled: boolean; html: string }>({ enabled: false, html: '' })
  const [customVals, setCustomVals] = useState<Record<string, string>>({})
  const signatureOn = hasSignature(reply)
  const [drafting, setDrafting] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [draftStatus, setDraftStatus] = useState<DraftStatus>({ kind: 'idle' })
  // The reply box starts as a single line so the latest message is fully visible when the thread
  // opens scrolled to the bottom; it expands once you click in, or when a draft is loaded.
  const [composing, setComposing] = useState(false)
  const unread = thread.unread ?? 0
  const bottomRef = useRef<HTMLDivElement>(null)
  const [firstSession] = useState(() => new DraftSession({ threadId: thread.id }, setDraftStatus))
  const session = useRef<DraftSession>(firstSession)
  // A Gmail draft exists for this reply (loaded, or saved at least once). Drives the Discard button.
  const draftExists = draftStatus.kind === 'saved' || draftStatus.kind === 'saving'
  // Becomes true on the first real edit, so a freshly loaded draft is never re-saved on open.
  const dirty = useRef(false)
  const sessionUploads = useRef<Set<string>>(new Set())
  // Undo-send: when true, the reply has been queued (shown in the thread) but not actually sent yet.
  const [pending, setPending] = useState(false)
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingFields = useRef<DraftFields | null>(null)
  const pendingAtts = useRef<EmailAttachment[]>([])
  const pendingTempId = useRef<string | null>(null)
  // Points at the latest fireSend so the unmount flush runs the exact same send/cleanup logic.
  const fireSendRef = useRef<((fields: DraftFields, tempId: string | null, atts: EmailAttachment[]) => void) | null>(null)
  const expanded = composing || htmlHasContent(reply) || loadingDraft

  const startComposing = () => {
    setComposing(true)
    requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: 'end' }))
  }

  // On open: scroll to the bottom (the reply box), and mark the thread read like Gmail does.
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

  // Open the conversation's Gmail draft in the reply box. Runs again if a different draft appears
  // (say, Undo after a discard), but never over something already being typed here.
  const loadedDraftId = useRef<string | null>(null)
  useEffect(() => {
    const id = draftMsg?.draftId
    if (!id || id === loadedDraftId.current || dirty.current) return
    let alive = true
    loadedDraftId.current = id
    getGmailDraft(id)
      .then((d) => {
        if (!alive || dirty.current) return
        session.current = new DraftSession(
          { draftId: d.draftId, threadId: d.threadId || thread.id, inReplyTo: d.inReplyTo, references: d.references },
          setDraftStatus,
        )
        setReply(d.html)
        setTo(d.to || defaultTo)
        setCc(d.cc)
        setShowCc(!!d.cc)
        setSubject(d.subject || defaultSubject)
        setQuoteHtml(d.quoteHtml)
        setGmailAtts(d.gmailAttachments)
        setFromGmailDraft(true)
        setComposing(true)
        setDraftStatus({ kind: 'saved', at: Date.now() })
        requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: 'end' }))
      })
      .catch((e) => alive && setNote(`Could not open the Gmail draft: ${e instanceof Error ? e.message : e}`))
      .finally(() => alive && setLoadingDraft(false))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftMsg?.draftId])

  const fields = (over: Partial<DraftFields> = {}): DraftFields => ({
    projectId: project.id,
    to,
    cc,
    subject,
    html: reply,
    quoteHtml,
    attachments,
    keepGmailAttachments: gmailAtts,
    ...over,
  })

  // Autosave into Gmail (debounced inside the session). Only after a real edit. Clearing the reply
  // back to nothing deletes a draft this box created, so an emptied reply never lingers in Gmail.
  useEffect(() => {
    if (!dirty.current || pending) return
    const s = session.current
    if (htmlHasContent(reply) || attachments.length > 0 || gmailAtts.length > 0) {
      s.schedule(fields())
    } else if (s.draftId) {
      void s.release().then((id) => {
        if (id) onDiscardDraft?.(id)
      })
    } else {
      s.cancelPending()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reply, to, cc, attachments, gmailAtts])

  // Closing the thread saves anything typed in the last second, then refreshes the list so the
  // conversation row shows its Draft badge.
  useEffect(() => {
    return () => {
      const s = session.current
      if (s && dirty.current) void s.flush().then(() => onDraftsChanged?.())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const changeReply = (html: string) => {
    dirty.current = true
    setReply(html)
    if (note) setNote(null)
  }

  // Signature content + this project's custom field values, so the checkbox and the template chips
  // behave exactly as they do in the full composer.
  useEffect(() => {
    let alive = true
    loadConfig()
      .then((c) => alive && setSig({ enabled: !!c.signatureEnabled, html: c.signatureHtml || '' }))
      .catch(() => {})
    loadCustomValues(project.id)
      .then((cv) => alive && setCustomVals(cv))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [project.id])

  const changeAttachments = (next: EmailAttachment[]) => {
    dirty.current = true
    setAttachments(next)
  }
  const removeGmailAtt = (name: string) => {
    dirty.current = true
    setGmailAtts((list) => list.filter((a) => a.name !== name))
  }

  // Add / remove the signature at the end of the reply. Nothing else in the body is touched.
  const toggleSignature = (on: boolean) => {
    dirty.current = true
    setReply((b) => (on ? withSignature(b, sig.html) : withoutSignature(b)))
    setComposing(true)
  }

  // Templates fill the BODY only: a reply's subject is the thread's, and changing it would break
  // Gmail threading. A signature already switched on stays on, below the new text.
  const applyTemplate = (id: string) => {
    const t = id ? findTemplate(id) : null
    if (id && !t) return
    if (htmlHasContent(reply) && !window.confirm(t ? `Replace this reply with "${t.name}"?` : 'Clear this reply?')) return
    dirty.current = true
    setTemplateId(id)
    const next = t ? resolveMergeFields(t.body, project, customVals) : ''
    setReply(signatureOn ? withSignature(next, sig.html) : next)
    setComposing(true)
    setNote(null)
  }

  const doDraft = async () => {
    setDrafting(true)
    setNote('Drafting with Claude. This can take up to a minute.')
    try {
      const threadText = thread.messages
        .filter((m) => !m.isDraft)
        .map((m) => `${m.from === ME ? 'Michael' : m.fromName || 'Client'}: ${m.body}`)
        .join('\n\n')
      const draft = await claudeDraftReply({ projectId: project.id, threadText })
      changeReply(textToHtml(draft))
      setComposing(true)
      setNote('Drafted with Claude. Review before sending.')
    } catch (e) {
      setNote(String(e instanceof Error ? e.message : e))
    } finally {
      setDrafting(false)
    }
  }

  // Put a reply back in the box after an Undo or a failed send.
  const restore = (f: DraftFields, atts: EmailAttachment[]) => {
    setReply(f.html)
    setAttachments(atts)
    setComposing(true)
    dirty.current = true
  }

  // Actually send (after the undo window elapses, or on flush).
  const fireSend = async (f: DraftFields, tempId: string | null, atts: EmailAttachment[] = []) => {
    if (pendingTimer.current) {
      clearTimeout(pendingTimer.current)
      pendingTimer.current = null
    }
    pendingFields.current = null
    setPending(false)
    try {
      await session.current.send(f)
      pendingTempId.current = null
      dirty.current = false
      loadedDraftId.current = null
      setGmailAtts([])
      setQuoteHtml('')
      setFromGmailDraft(false)
      setDraftStatus({ kind: 'idle' })
      onRead() // replying clears the unread flag
      onDraftsChanged?.()
    } catch (e) {
      if (tempId) onReplyUndone?.(thread.id, tempId)
      pendingTempId.current = null
      restore(f, atts)
      setNote(`Could not send: ${e instanceof Error ? e.message : e}. Your reply was put back.`)
    }
  }

  // Click Send: show the reply in the thread immediately and hold the real send for a few seconds so
  // it can be undone, Gmail-style.
  const queueSend = () => {
    if (!htmlHasContent(reply) || pending) return
    if (!to.trim()) {
      setNote('Add who this goes to.')
      return
    }
    const f = fields()
    const atts = attachments
    session.current.cancelPending()
    pendingFields.current = f
    pendingAtts.current = atts
    const tempId = `pending-${Date.now()}`
    pendingTempId.current = tempId
    onReplySent?.(thread.id, {
      id: tempId,
      from: ME,
      fromName: 'Michael Bloemeke',
      date: fmtToday(),
      ts: Date.now(),
      body: htmlToPlainText(f.html),
    })
    setReply('')
    setAttachments([])
    setComposing(false)
    setNote(null)
    setPending(true)
    pendingTimer.current = setTimeout(() => void fireSend(f, tempId, atts), UNDO_WINDOW_MS)
    requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: 'end' }))
  }

  // Undo within the window: cancel the timer, pull the optimistic message, restore the composer. The
  // draft was never touched, so it is still in Gmail exactly as it was.
  const undoSend = () => {
    if (!pendingTimer.current) return
    clearTimeout(pendingTimer.current)
    pendingTimer.current = null
    const f = pendingFields.current
    const atts = pendingAtts.current
    pendingFields.current = null
    pendingAtts.current = []
    setPending(false)
    if (pendingTempId.current) {
      onReplyUndone?.(thread.id, pendingTempId.current)
      pendingTempId.current = null
    }
    if (f) restore(f, atts)
    setNote(null)
  }

  // Discard: clear the box and hand the draft to the parent, which deletes it unless Undo is pressed.
  const discard = async () => {
    const id = await session.current.release()
    dirty.current = false
    // Forget it, so that if Undo brings the draft back it opens in the box again.
    loadedDraftId.current = null
    setReply('')
    setAttachments([])
    setGmailAtts([])
    setQuoteHtml('')
    setFromGmailDraft(false)
    setComposing(false)
    setNote(null)
    if (id) onDiscardDraft?.(id)
  }

  // Keep the unmount flush pointed at the current send logic (fireSend closes over live state).
  useEffect(() => {
    fireSendRef.current = fireSend
  })

  // If the thread is closed while a send is still queued, flush it through the SAME fireSend path so
  // the reply isn't lost. The parent (ProjectView) stays mounted, so its callbacks still take effect.
  useEffect(() => {
    return () => {
      if (!pendingTimer.current) return
      const f = pendingFields.current
      if (f) fireSendRef.current?.(f, pendingTempId.current, pendingAtts.current)
    }
  }, [])

  // Cmd+Enter (Ctrl+Enter) sends, as in Gmail.
  const onComposerKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      queueSend()
    }
  }

  const statusText = note || draftStatusText(draftStatus)

  return (
    // No overflow-hidden here so the header can stay sticky while the thread scrolls.
    <div className="rounded-2xl border border-[#dfe3e8] bg-[#f5f7f9] shadow-[0_24px_60px_-34px_rgba(0,0,0,0.17)]">
      {/* Header: back + subject. Sticky so Back is reachable anywhere in the thread */}
      <div className="sticky top-0 z-20 flex items-center gap-3 rounded-t-2xl border-b border-[#dfe3e8] bg-white px-4 py-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-[#d1d7de] bg-white px-2.5 py-1.5 text-[12px] font-medium text-[#3f454c] transition-colors hover:bg-[#f7f9fb]"
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 6l-6 6 6 6" />
          </svg>
          Back
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-semibold text-[#14171b]">{thread.subject}</p>
          {people && <p className="truncate text-[11.5px] text-[#545b64]">{people}</p>}
        </div>
        <span className="shrink-0 text-[11px] tabular-nums text-[#858d97]">
          {thread.messages.filter((m) => !m.isDraft).length} {thread.messages.filter((m) => !m.isDraft).length === 1 ? 'msg' : 'msgs'}
        </span>
      </div>

      {/* Messages: oldest at top, newest at bottom. Mine = blue, client = white. */}
      <div className="space-y-2.5 bg-[#fafbfc] px-4 py-4">
        {thread.messages.map((m, i) => {
          if (m.isDraft && draftMsg && m.id === draftMsg.id) return null // it is in the reply box
          const mine = m.from === ME
          // Any other unsent draft (Gmail allows several). Loud about being unsent, because the
          // whole point of this pane is knowing what the client has actually received.
          if (m.isDraft) {
            return (
              <div key={m.id || i} className="rounded-lg border border-dashed border-[#a9c2f6] bg-[#f4f8fe] p-3">
                <div className="mb-1.5 flex items-center justify-between gap-2 text-[11.5px]">
                  <span className="flex items-center gap-1.5 font-semibold text-[#545b64]">
                    <PencilIcon />
                    Another unsent draft
                  </span>
                  <span className="shrink-0 font-medium text-[#545b64]">Not sent</span>
                </div>
                <p className="whitespace-pre-line text-[13px] leading-relaxed text-[#4a5058]">{m.body}</p>
              </div>
            )
          }
          return (
            <div
              key={m.id || i}
              className={['rounded-lg border p-3', mine ? 'border-[#cfe0f5] bg-[#eef4fc]' : 'border-[#e4e8ec] bg-white'].join(' ')}
            >
              <div className="mb-1.5 flex items-center justify-between gap-2 text-[11.5px]">
                <span className={mine ? 'font-semibold text-[#2c5a9e]' : 'font-semibold text-[#14171b]'}>
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
                      className={['rounded p-0.5 transition-colors', m.starred ? 'text-[#ca8a04]' : 'text-[#c4bfb4] hover:text-[#ca8a04]'].join(' ')}
                    >
                      <StarIcon filled={!!m.starred} />
                    </button>
                  )}
                  <span className="tabular-nums text-[#858d97]">{m.date}</span>
                </div>
              </div>
              <p className="whitespace-pre-line text-[13px] leading-relaxed text-[#1f2429]">{m.body}</p>
            </div>
          )
        })}
      </div>

      {/* Composer (the bottom of the page), collapsed to one line until clicked. While a send is held
          in the undo window, the undo bar takes its place. */}
      <div className="rounded-b-2xl border-t border-[#eaedf1] bg-[#f5f7f9] px-4 pb-4 pt-3">
        {pending ? (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-[#cfe3d4] bg-[#eef6f0] px-3.5 py-2.5">
            <span className="flex items-center gap-2 text-[12.5px] font-medium text-[#2f6b43]">
              <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 6L9 17l-5-5" />
              </svg>
              Sending…
            </span>
            <button
              type="button"
              onClick={undoSend}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#bcd9c5] bg-white px-3 py-1.5 text-[12px] font-semibold text-[#2f6b43] transition-colors hover:bg-[#f3faf5]"
            >
              <UndoIcon />
              Undo
            </button>
          </div>
        ) : !expanded ? (
          <button
            type="button"
            onClick={startComposing}
            className="flex w-full items-center gap-2 rounded-lg border border-[#d8dde3] bg-white px-3 py-2.5 text-left text-[13px] text-[#949ba4] transition-colors hover:border-[#2563eb]"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-[#bdb7aa]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 10h11M3 6h18M3 14h18M3 18h11" />
              <path d="M18 14l3 3-3 3" />
            </svg>
            Reply{defaultTo && ` to ${defaultTo}`}…
          </button>
        ) : loadingDraft ? (
          <div className="animate-pulse rounded-lg border border-[#dfe3e8] bg-white px-3 py-6 text-center text-[12.5px] text-[#858d97]">
            Opening your Gmail draft…
          </div>
        ) : (
          <div className="rounded-lg border border-[#dfe3e8] bg-white p-3" onKeyDown={onComposerKey}>
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="flex items-center gap-2 text-[12.5px] font-semibold text-[#14171b]">
                {fromGmailDraft ? (
                  <>
                    <PencilIcon />
                    Your draft
                    <span className="font-normal text-[#545b64]">from Gmail. Edit it here or there.</span>
                  </>
                ) : (
                  'Reply'
                )}
              </p>
              <div className="flex items-center gap-2">
                {/* Fills the reply body. No subject: a reply keeps the thread's, or Gmail breaks
                    the conversation apart. Opens upward, since the reply box is at the page bottom. */}
                <TemplateMenu value={templateId} onPick={applyTemplate} tone="light" direction="up" />
                <button
                  type="button"
                  onClick={doDraft}
                  disabled={drafting}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[#a9c2f6] bg-[#f4f8fe] px-2.5 py-1 text-[11.5px] font-semibold text-[#2c5a9e] transition-colors hover:bg-[#e8f0fd] disabled:opacity-50"
                >
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8z" />
                    <path d="M19 14l.9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9z" />
                  </svg>
                  {drafting ? 'Drafting…' : 'Draft with Claude'}
                </button>
              </div>
            </div>

            {/* Recipients, editable like Gmail's. Cc hides until it is wanted. */}
            <div className="mb-2 space-y-1.5">
              <AddressRow label="To" value={to} onChange={(v) => { dirty.current = true; setTo(v) }}>
                {!showCc && (
                  <button type="button" onClick={() => setShowCc(true)} className="shrink-0 text-[11.5px] font-medium text-[#545b64] hover:text-[#14171b]">
                    Cc
                  </button>
                )}
              </AddressRow>
              {showCc && <AddressRow label="Cc" value={cc} onChange={(v) => { dirty.current = true; setCc(v) }} />}
            </div>

            <RichTextEditor
              value={reply}
              onChange={changeReply}
              tone="light"
              minHeight={120}
              placeholder="Write a reply, or let Claude draft one in your voice…"
            />
            {quoteHtml && (
              <p className="mt-1.5 text-[11px] text-[#858d97]">The earlier messages are quoted below your reply, the way Gmail does it.</p>
            )}

            <div className="mt-2 space-y-1.5">
              {gmailAtts.length > 0 && <GmailAttachmentChips list={gmailAtts} onRemove={removeGmailAtt} />}
              <EmailAttachments
                attachments={attachments}
                onChange={changeAttachments}
                onStatus={setNote}
                sessionUploads={sessionUploads}
                tone="light"
                label={false}
              />
            </div>

            {/* Ticking this puts the signature block into the reply above, so the box shows exactly
                what the client receives. */}
            <label className="mt-2 flex w-fit cursor-pointer items-center gap-2 text-[12px] text-[#14171b]">
              <input
                type="checkbox"
                checked={signatureOn}
                onChange={(e) => toggleSignature(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-[#d8dde3]"
                style={{ accentColor: 'var(--color-brass)' }}
              />
              Signature
              <span className="text-[11px] text-[#858d97]">adds your name, website and number at the bottom</span>
            </label>

            <div className="mt-3 flex items-center justify-between gap-3 border-t border-[#eef1f4] pt-2.5">
              <div className="flex min-w-0 items-center gap-3">
                {(draftExists || htmlHasContent(reply)) && (
                  <button
                    type="button"
                    onClick={() => void discard()}
                    className="shrink-0 text-[12px] font-medium text-[#b42318] transition-colors hover:text-[#7a1810]"
                  >
                    Discard
                  </button>
                )}
                <span
                  className={['truncate text-[11.5px]', draftStatus.kind === 'error' && !note ? 'text-[#b42318]' : 'text-[#545b64]'].join(' ')}
                >
                  {statusText}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="hidden text-[10.5px] text-[#9aa1a9] sm:inline">⌘ Enter</span>
                <button
                  type="button"
                  onClick={queueSend}
                  disabled={!htmlHasContent(reply)}
                  className="rounded-lg bg-brass px-4 py-1.5 text-[12px] font-semibold text-[#ffffff] transition-all hover:brightness-110 disabled:opacity-40"
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

// A To / Cc line: a plain text box, comma separated, exactly what Gmail accepts.
function AddressRow({
  label,
  value,
  onChange,
  children,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  children?: React.ReactNode
}) {
  return (
    <label className="flex items-center gap-2 rounded-md border border-[#e4e8ec] px-2.5 py-1.5 focus-within:border-[#2563eb]">
      <span className="w-6 shrink-0 text-[11.5px] font-medium text-[#858d97]">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="name@example.com, another@example.com"
        className="min-w-0 flex-1 bg-transparent text-[12.5px] text-[#14171b] placeholder:text-[#b4bac2] focus:outline-none"
      />
      {children}
    </label>
  )
}

// Files that live in the Gmail draft itself. They stay attached unless removed here.
export function GmailAttachmentChips({
  list,
  onRemove,
  dark = false,
}: {
  list: GmailAttachment[]
  onRemove: (name: string) => void
  dark?: boolean
}) {
  return (
    <ul className="flex flex-wrap gap-1.5">
      {list.map((a) => (
        <li
          key={a.name}
          className={[
            'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11.5px]',
            dark ? 'border-line bg-surface-2 text-parchment' : 'border-[#dfe3e8] bg-[#f7f9fb] text-[#14171b]',
          ].join(' ')}
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0 opacity-60" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21.4 11.05 12.25 20.2a5 5 0 0 1-7.07-7.07l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
          <span className="max-w-[16rem] truncate">{a.name}</span>
          {a.size ? <span className="opacity-60">{fmtSize(a.size)}</span> : null}
          <button type="button" onClick={() => onRemove(a.name)} aria-label={`Remove ${a.name}`} className="opacity-60 transition-opacity hover:opacity-100">
            ×
          </button>
        </li>
      ))}
    </ul>
  )
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  )
}

function UndoIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h11a5 5 0 0 1 0 10h-1" />
    </svg>
  )
}

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l2.7 5.5 6 .9-4.35 4.25 1 6L12 17.8 6.65 19.6l1-6L3.3 9.4l6-.9z" />
    </svg>
  )
}
