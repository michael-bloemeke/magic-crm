import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { type Project } from '../pipeline'
import {
  getGmailDraft,
  deleteEmailAttachment,
  loadConfig,
  loadCustomValues,
  type EmailAttachment,
  type GmailAttachment,
  type DraftFields,
} from '../api'
import { RichTextEditor } from './RichTextEditor'
import { SMART_FIELDS, resolveSmartField, resolveMergeFields, unfilledFields } from '../smartFields'
import { findTemplate } from '../emailTemplates'
import { TemplateMenu } from './TemplateMenu'
import { hasSignature, withSignature, withoutSignature } from '../emailSignature'
import { EmailAttachments } from './EmailAttachments'
import { GmailAttachmentChips } from './ThreadReader'
import { DraftSession, draftStatusText, htmlHasContent, type DraftStatus } from '../gmailDraft'

// The "Write email" composer for a NEW email on a project.
//
// IT WRITES A GMAIL DRAFT (2026-11-10). Everything typed is saved straight into Gmail Drafts, so the
// email is in Gmail too, and a draft started in Gmail to this client opens here to finish. Closing
// keeps the draft. Send hands the email to the project page, which holds it for a few seconds with
// an Undo before Gmail sends it. Discard does the same with a delete.
//
// A template picker sits between To and Subject. Picking one fills the subject and the message with
// a Ghostbuster follow-up (see src/emailTemplates.ts). Everything a template inserts is ordinary
// editor content, so it can be rewritten freely before sending.
//
// Replies are written in the conversation itself (ThreadReader), not here.
export function EmailBuilderModal({
  open,
  project,
  recipientEmails,
  draftId,
  onClose,
  onChanged,
  onQueueSend,
  onDiscard,
}: {
  open: boolean
  project: Project
  recipientEmails: string[]
  // A Gmail draft to open, or null for a fresh email.
  draftId: string | null
  onClose: () => void
  // A draft was created or saved: re-read the conversations so the list matches Gmail.
  onChanged: () => void
  // Send this (the parent shows "Sending… Undo" and sends after a few seconds).
  onQueueSend: (fields: DraftFields & { draftId?: string }, label: string) => void
  // Discard this Gmail draft (the parent deletes it after an Undo window).
  onDiscard: (draftId: string) => void
}) {
  const [to, setTo] = useState('')
  const [cc, setCc] = useState('')
  const [bcc, setBcc] = useState('')
  const [showCc, setShowCc] = useState(false)
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [attachments, setAttachments] = useState<EmailAttachment[]>([])
  const [gmailAtts, setGmailAtts] = useState<GmailAttachment[]>([])
  const [loading, setLoading] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [draftStatus, setDraftStatus] = useState<DraftStatus>({ kind: 'idle' })
  // Set once the user has been warned that the email still has unfilled placeholders, so a
  // second Send click goes through.
  const [confirmUnfilled, setConfirmUnfilled] = useState(false)
  // Which template is currently selected ('' = No template). Purely a picker.
  const [templateId, setTemplateId] = useState('')
  // The signature CONTENT (configured in Settings). Whether this email carries it is derived from the
  // body, because ticking the box literally puts the signature block into the message.
  const [sig, setSig] = useState<{ enabled: boolean; html: string }>({ enabled: false, html: '' })
  const signatureOn = hasSignature(body)
  const [customFields, setCustomFields] = useState<{ id: string; label: string }[]>([])
  const [customVals, setCustomVals] = useState<Record<string, string>>({})
  const smartFieldList = [...SMART_FIELDS, ...customFields.map((f) => ({ key: f.id, label: f.label }))]
  // Ids of one-off uploads made in THIS editing session (EmailAttachments tracks them).
  const sessionUploads = useRef<Set<string>>(new Set())
  const session = useRef<DraftSession | null>(null)
  // True after a real edit, so opening a draft never re-saves it untouched.
  const dirty = useRef(false)

  useEffect(() => {
    if (!open) return
    dirty.current = false
    session.current = new DraftSession({ draftId: draftId || undefined }, setDraftStatus)
    sessionUploads.current = new Set()
    setTo(recipientEmails.join(', '))
    setCc('')
    setBcc('')
    setShowCc(false)
    setSubject('')
    setBody('')
    setAttachments([])
    setGmailAtts([])
    setConfirmUnfilled(false)
    setTemplateId('')
    setNote(null)
    setDraftStatus(draftId ? { kind: 'saved', at: Date.now() } : { kind: 'idle' })
    let alive = true
    loadConfig()
      .then((c) => {
        if (!alive) return
        setSig({ enabled: !!c.signatureEnabled, html: c.signatureHtml || '' })
        setCustomFields(c.customFields || [])
        // Settings' "signature enabled" is the DEFAULT for a brand-new email only. An existing draft
        // keeps whatever was decided when it was written.
        if (!draftId && c.signatureEnabled) setBody((b) => (hasSignature(b) ? b : withSignature(b, c.signatureHtml || '')))
      })
      .catch(() => setSig({ enabled: false, html: '' }))
    loadCustomValues(project.id)
      .then((cv) => {
        if (!alive) return
        setCustomVals(cv)
        setBody((b) => resolveMergeFields(b, project, cv))
      })
      .catch(() => setCustomVals({}))
    if (draftId) {
      setLoading(true)
      getGmailDraft(draftId)
        .then((d) => {
          if (!alive) return
          setTo(d.to)
          setCc(d.cc)
          setBcc(d.bcc)
          setShowCc(!!(d.cc || d.bcc))
          setSubject(d.subject)
          setBody(resolveMergeFields(d.html, project))
          setGmailAtts(d.gmailAttachments)
        })
        .catch((e) => alive && setNote(`Could not open the draft: ${e instanceof Error ? e.message : e}`))
        .finally(() => alive && setLoading(false))
    }
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, draftId])

  const fields = (over: Partial<DraftFields> = {}): DraftFields => ({
    projectId: project.id,
    to,
    cc,
    bcc,
    subject: subject.trim(),
    html: body,
    attachments,
    keepGmailAttachments: gmailAtts,
    ...over,
  })

  // Autosave into Gmail after a real edit. Emptying a draft this window created deletes it, so an
  // abandoned blank email never lingers in Gmail.
  useEffect(() => {
    if (!open || !dirty.current) return
    const s = session.current!
    if (htmlHasContent(body) || subject.trim() || attachments.length > 0 || gmailAtts.length > 0) {
      s.schedule(fields())
    } else if (s.draftId) {
      void s.release().then((id) => {
        if (id) onDiscard(id)
      })
    } else {
      s.cancelPending()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, subject, to, cc, bcc, attachments, gmailAtts])

  const edit = <T,>(set: (v: T) => void) => (v: T) => {
    dirty.current = true
    setConfirmUnfilled(false)
    set(v)
  }

  // Closing KEEPS the draft: whatever was typed is flushed into Gmail first.
  const handleClose = () => {
    const s = session.current
    if (s && dirty.current) void s.flush().then(onChanged)
    onClose()
  }
  const closeRef = useRef(handleClose)
  useEffect(() => {
    closeRef.current = handleClose
  })
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const discard = async () => {
    const s = session.current!
    const id = await s.release()
    // One-off uploads made this session belonged only to this email.
    for (const uid of sessionUploads.current) deleteEmailAttachment(uid).catch(() => {})
    sessionUploads.current = new Set()
    dirty.current = false
    if (id) onDiscard(id)
    onClose()
  }

  const send = async () => {
    if (!to.trim() && !cc.trim() && !bcc.trim()) {
      setNote('Add who this goes to.')
      return
    }
    if (!subject.trim()) {
      setNote('Add a subject before sending.')
      return
    }
    // Fill any placeholders the project can now resolve; warn (once) about any that remain so a raw
    // "[Client name]" doesn't go out unnoticed.
    const resolved = resolveMergeFields(body, project, customVals)
    const remaining = unfilledFields(resolved)
    if (remaining.length > 0 && !confirmUnfilled) {
      setNote(`These placeholders still need filling: ${remaining.join(', ')}. Fill them in, or press Send again to send as-is.`)
      setConfirmUnfilled(true)
      return
    }
    // Save the final version first, so Undo can bring back exactly this email.
    const s = session.current!
    s.schedule(fields({ html: resolved }))
    await s.flush()
    const id = s.draftId
    dirty.current = false
    onQueueSend({ ...fields({ html: resolved }), draftId: id }, to.split(',')[0].trim() || 'your recipient')
    onClose()
  }

  // Add or remove the signature block at the end of the message. Nothing else in the body is touched.
  const toggleSignature = (on: boolean) => {
    dirty.current = true
    setBody((b) => (on ? withSignature(b, sig.html) : withoutSignature(b)))
    setConfirmUnfilled(false)
  }

  // Applying a template REPLACES the subject and the message, after a confirm if anything is typed.
  const applyTemplate = (id: string) => {
    const t = id ? findTemplate(id) : null
    if (id && !t) return
    const hasText = htmlHasContent(body) || subject.trim() !== ''
    const label = t ? `Replace what's here with "${t.name}"?` : 'Clear the subject and message?'
    if (hasText && !window.confirm(label)) return
    dirty.current = true
    setTemplateId(id)
    setSubject(t ? t.subject : '')
    const next = t ? resolveMergeFields(t.body, project, customVals) : ''
    setBody(signatureOn ? withSignature(next, sig.html) : next)
    setConfirmUnfilled(false)
    setNote(null)
  }

  const canSend = !!(to.trim() || cc.trim() || bcc.trim()) && subject.trim().length > 0 && (htmlHasContent(body) || attachments.length > 0 || gmailAtts.length > 0) && !loading
  const statusText = note || draftStatusText(draftStatus)
  const field = 'w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-[13px] text-parchment placeholder:text-faint focus:border-brass-dim focus:outline-none'

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[60] flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={handleClose} aria-hidden />
          <motion.div
            className="relative flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-line-strong bg-surface shadow-[0_40px_90px_-40px_rgba(0,0,0,0.18)]"
            initial={{ y: 16, opacity: 0, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 16, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canSend) {
                e.preventDefault()
                void send()
              }
            }}
          >
            <div className="flex items-start justify-between gap-4 border-b border-line px-6 pb-4 pt-5">
              <div className="min-w-0">
                <h2 className="font-display text-[20px] leading-tight text-parchment">{draftId ? 'Draft' : 'New email'}</h2>
                <p className="mt-0.5 truncate text-[12.5px] text-muted">{project.client}</p>
              </div>
              <button
                type="button"
                onClick={handleClose}
                aria-label="Close"
                title="Close (the draft stays in Gmail)"
                className="rounded-lg border border-line p-1.5 text-muted transition-colors hover:border-line-strong hover:text-parchment"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>

            {loading ? (
              <div className="animate-pulse px-6 py-16 text-center text-[13px] text-muted">Opening your Gmail draft…</div>
            ) : (
              <div className="board-scroll min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">To</span>
                    {!showCc && (
                      <button type="button" onClick={() => setShowCc(true)} className="text-[11px] font-medium text-muted hover:text-parchment">
                        Cc / Bcc
                      </button>
                    )}
                  </div>
                  <input value={to} onChange={(e) => edit(setTo)(e.target.value)} placeholder="client@email.com" className={field} />
                  <span className="mt-1 block text-[10.5px] text-faint">Separate multiple addresses with commas.</span>
                </div>
                {showCc && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block">
                      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Cc</span>
                      <input value={cc} onChange={(e) => edit(setCc)(e.target.value)} className={field} />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Bcc</span>
                      <input value={bcc} onChange={(e) => edit(setBcc)(e.target.value)} className={field} />
                    </label>
                  </div>
                )}

                {/* Template picker: folders that fly out into their templates. Fills the subject +
                    message below; "No template" clears both. */}
                <div className="block">
                  <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Template</span>
                  <TemplateMenu value={templateId} onPick={applyTemplate} />
                  <span className="mt-1 block text-[10.5px] text-faint">Fills the subject and message below. Edit them freely before sending.</span>
                </div>

                <label className="block">
                  <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Subject</span>
                  <input value={subject} onChange={(e) => edit(setSubject)(e.target.value)} className={field} />
                </label>

                <div className="block">
                  <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Message</span>
                  <RichTextEditor
                    value={body}
                    onChange={edit(setBody)}
                    smartFields={smartFieldList}
                    resolveField={(key) => resolveSmartField(key, project, customVals)}
                    placeholder="Write your message…"
                  />
                  {/* Ticking this puts the signature block into the message above, so what you see
                      in the editor is exactly what the client receives. */}
                  <label className="mt-2 flex w-fit cursor-pointer items-center gap-2 text-[12.5px] text-parchment">
                    <input
                      type="checkbox"
                      checked={signatureOn}
                      onChange={(e) => toggleSignature(e.target.checked)}
                      className="h-3.5 w-3.5 rounded border-line"
                      style={{ accentColor: 'var(--color-brass)' }}
                    />
                    Signature
                    <span className="text-[11px] text-faint">adds your name, website and number at the bottom</span>
                  </label>
                </div>

                {/* Attachments: what the Gmail draft already holds, then the Files page or a one-off upload. */}
                <div className="space-y-2">
                  {gmailAtts.length > 0 && (
                    <GmailAttachmentChips
                      dark
                      list={gmailAtts}
                      onRemove={(name) => edit(setGmailAtts)(gmailAtts.filter((a) => a.name !== name))}
                    />
                  )}
                  <EmailAttachments attachments={attachments} onChange={edit(setAttachments)} onStatus={setNote} sessionUploads={sessionUploads} />
                </div>
              </div>
            )}

            <div className="flex items-center justify-between gap-3 border-t border-line px-6 py-4">
              <div className="flex min-w-0 items-center gap-3">
                {(draftId || draftStatus.kind === 'saved' || draftStatus.kind === 'saving') && (
                  <button
                    type="button"
                    onClick={() => void discard()}
                    className="shrink-0 rounded-lg px-1 py-2 text-[12.5px] font-medium text-[#dc2626] transition-colors hover:brightness-110"
                  >
                    Discard
                  </button>
                )}
                <span className={['truncate text-[11.5px]', draftStatus.kind === 'error' && !note ? 'text-[#dc2626]' : 'text-muted'].join(' ')}>
                  {statusText}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="hidden text-[10.5px] text-faint sm:inline">⌘ Enter</span>
                <button
                  type="button"
                  onClick={() => void send()}
                  disabled={!canSend}
                  className="rounded-lg bg-brass px-4 py-2 text-[12.5px] font-semibold text-[#ffffff] transition-all hover:brightness-110 disabled:opacity-40"
                >
                  {confirmUnfilled ? 'Send anyway' : 'Send'}
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
