import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { type Project } from '../pipeline'
import {
  loadTemplates,
  saveProjectEmail,
  sendProjectEmail,
  loadFiles,
  loadThreads,
  uploadEmailAttachment,
  deleteEmailAttachment,
  claudeStatus,
  claudeDraftEmail,
  claudeCompleteTemplate,
  loadConfig,
  loadCustomValues,
  type ProjectEmail,
  type Template,
  type EmailAttachment,
  type EmailThread,
  type FileItem,
} from '../api'
import { RichTextEditor } from './RichTextEditor'
import { SMART_FIELDS, resolveSmartField, resolveMergeFields, unfilledFields, textToHtml } from '../smartFields'

const MICHAEL = 'michael@michaelbloemeke.com'
// Normalize a thread subject to a reply subject so Gmail keeps the message in that conversation.
function reSubject(s: string): string {
  const t = (s || '').trim()
  return /^re:/i.test(t) ? t : `Re: ${t}`
}

// True if the HTML body has any actual text/content (ignoring empty tags), for send checks.
function htmlHasContent(html: string): boolean {
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim() !== ''
}
function fmtSize(bytes: number): string {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// A generic email builder dialog used for every per-project email (post-call,
// follow-ups, shark, break-up, check-ins, thank-you, and one-off "New email").
// Michael writes or generates the note, picks a template, then either Sends it to
// the client(s) or saves it as a CRM draft (closing with content also saves).
// "Generate" drops in the best-matching template for this kind until live Claude
// drafting is wired.
export function EmailBuilderModal({
  open,
  project,
  recipientEmails,
  existing,
  kind,
  title,
  defaultSubject,
  defaultBody,
  templateHint,
  autosave = false,
  onClose,
  onSaved,
  onDiscard,
}: {
  open: boolean
  project: Project
  recipientEmails: string[]
  existing: ProjectEmail | null
  kind: string
  title: string
  defaultSubject: string
  defaultBody?: string
  templateHint?: RegExp
  // When true (the top "New email" composer), anything written auto-saves to drafts and the manual
  // "Save draft" button is hidden. Closing keeps the draft (it's already saved). The section cards
  // leave this off and keep the explicit Save-draft button.
  autosave?: boolean
  onClose: () => void
  onSaved: (email: ProjectEmail) => void
  // Permanently delete this saved draft (parent removes it + calls deleteProjectEmail).
  onDiscard?: (id: string) => void
}) {
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState(defaultSubject)
  const [body, setBody] = useState('')
  const [attachments, setAttachments] = useState<EmailAttachment[]>([])
  const [templates, setTemplates] = useState<Template[]>([])
  const [files, setFiles] = useState<FileItem[] | null>(null)
  const [attachMenuOpen, setAttachMenuOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  // Reply-into-an-existing-thread: when on, this email is added to the chosen Gmail conversation
  // instead of starting a new one (so e.g. follow-up #2 lands in follow-up #1's thread). The project's
  // threads load lazily the first time reply mode is on. Hidden in the top "New email" (autosave) mode.
  const [replyMode, setReplyMode] = useState(false)
  const [threadId, setThreadId] = useState('')
  const [threadSubject, setThreadSubject] = useState('')
  // null = not loaded yet (shows "Loading…" while reply mode is on); [] = loaded, none found.
  const [threads, setThreads] = useState<EmailThread[] | null>(null)
  const [threadsError, setThreadsError] = useState(false)
  const threadsFetched = useRef(false)
  // Set once the user has been warned that the email still has unfilled placeholders, so a
  // second Send click goes through.
  const [confirmUnfilled, setConfirmUnfilled] = useState(false)
  const [claudeAvail, setClaudeAvail] = useState(false)
  const [claudeBusy, setClaudeBusy] = useState(false)
  const [claudeInstruction, setClaudeInstruction] = useState('')
  // The signature appended to outgoing mail (configured in Settings). Shown as a read-only preview
  // under the editor so the compose view matches what actually gets sent.
  const [sig, setSig] = useState<{ enabled: boolean; html: string }>({ enabled: false, html: '' })
  // Custom event fields (definitions for the merge-field dropdown) + this project's values (so a
  // custom merge field resolves to its value, like the built-in smart fields).
  const [customFields, setCustomFields] = useState<{ id: string; label: string }[]>([])
  const [customVals, setCustomVals] = useState<Record<string, string>>({})
  const smartFieldList = [...SMART_FIELDS, ...customFields.map((f) => ({ key: f.id, label: f.label }))]
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Ids of attachments uploaded during THIS editing session. If the user cancels (closes
  // without saving or sending), they were never persisted to an email record, so we delete
  // them from the server to avoid orphaned files. Saving/sending references them instead.
  const sessionUploads = useRef<Set<string>>(new Set())
  // In autosave mode the first save (existing === null) creates a record; this holds its id so the
  // following autosaves update the same draft instead of spawning duplicates. savingRef serializes
  // saves so two triggers (debounce + close flush) can't both create before the id comes back.
  const savedIdRef = useRef<string | undefined>(existing?.id)
  const savingRef = useRef<Promise<ProjectEmail | null> | null>(null)
  // The live draft id (existing or just-autosaved), so the Discard control appears even for a
  // brand-new email that has only been auto-saved this session.
  const [draftId, setDraftId] = useState<string | undefined>(existing?.id)
  // A sent email is locked: the dialog becomes a read-only receipt of what went out. No
  // editing, no template/attach, no save, no re-send. "Once it's sent, it's sent."
  const readOnly = existing?.status === 'sent'

  useEffect(() => {
    if (!open) return
    setTo((existing?.to?.length ? existing.to : recipientEmails).join(', '))
    setSubject(existing?.subject || defaultSubject)
    // Drafts are HTML now; an old text draft is converted so it renders in the rich editor. Any
    // placeholders whose project value is now available fill in on open.
    {
      const raw = existing?.body
        ? existing.format === 'html'
          ? existing.body
          : textToHtml(existing.body)
        : defaultBody || ''
      // Resolve built-in merge fields now; custom-field chips fill in once this project's custom
      // values load below (avoids using a previous project's stale values).
      setBody(resolveMergeFields(raw, project))
    }
    setConfirmUnfilled(false)
    setAttachments(existing?.attachments ?? [])
    setReplyMode(!!existing?.threadId)
    setThreadId(existing?.threadId || '')
    setThreadSubject(existing?.threadSubject || '')
    setThreads(null)
    setThreadsError(false)
    threadsFetched.current = false
    sessionUploads.current = new Set()
    savedIdRef.current = existing?.id
    savingRef.current = null
    setDraftId(existing?.id)
    setAttachMenuOpen(false)
    setStatus(existing?.status === 'sent' && existing.sentAt ? `Sent ${fmtDate(existing.sentAt)}.` : null)
    loadTemplates()
      .then(setTemplates)
      .catch(() => setTemplates([]))
    setClaudeInstruction('')
    claudeStatus()
      .then((s) => setClaudeAvail(s.configured))
      .catch(() => setClaudeAvail(false))
    loadConfig()
      .then((c) => {
        setSig({ enabled: !!c.signatureEnabled, html: c.signatureHtml || '' })
        setCustomFields(c.customFields || [])
      })
      .catch(() => setSig({ enabled: false, html: '' }))
    loadCustomValues(project.id)
      .then((cv) => {
        setCustomVals(cv)
        // Fill any custom-field chips now that this project's values are known.
        setBody((b) => resolveMergeFields(b, project, cv))
      })
      .catch(() => setCustomVals({}))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const toList = () => to.split(',').map((s) => s.trim()).filter(Boolean)
  const attachKey = (a: EmailAttachment) => `${a.source}:${a.id || a.name}`

  // Load the project's threads the first time reply mode is on (so the conversation picker can fill).
  // A ref guards against a double fetch without a synchronous setState in the effect body. On failure
  // the guard is released so a retry (or a project change) can fetch again.
  useEffect(() => {
    if (!open || !replyMode || threadsFetched.current) return
    threadsFetched.current = true
    loadThreads(project.id)
      .then((d) => setThreads(d.threads || []))
      .catch(() => {
        threadsFetched.current = false
        setThreadsError(true)
      })
  }, [open, replyMode, project.id])

  const retryLoadThreads = () => {
    threadsFetched.current = false
    setThreadsError(false)
    setThreads(null)
  }

  const toggleReplyMode = (checked: boolean) => {
    setReplyMode(checked)
    if (!checked) {
      setThreadId('')
      setThreadSubject('')
    }
  }
  // Picking a conversation targets that thread and aligns the subject + recipients to it so the
  // message threads cleanly in Gmail.
  const pickThread = (tid: string) => {
    setThreadId(tid)
    const t = threads?.find((x) => x.id === tid)
    if (t) {
      setThreadSubject(t.subject)
      setSubject(reSubject(t.subject))
      const recips = t.participants.filter((p) => p !== MICHAEL).join(', ')
      if (recips) setTo(recips)
    } else {
      setThreadSubject('')
    }
    setConfirmUnfilled(false)
  }

  // Saves are serialized through savingRef: if one is already in flight, the next waits for it before
  // reading the id, so concurrent triggers (the debounce + the close-flush) update the same record
  // instead of each creating a fresh one with id === undefined.
  const persist = async (bodyToSave: string = body): Promise<ProjectEmail | null> => {
    const prev = savingRef.current
    const p = (async (): Promise<ProjectEmail | null> => {
      if (prev) {
        try {
          await prev
        } catch {
          // ignore; we still attempt our own save below
        }
      }
      try {
        const saved = await saveProjectEmail({
          id: existing?.id ?? savedIdRef.current,
          projectId: project.id,
          kind,
          to: toList(),
          subject: subject.trim() || defaultSubject || '(no subject)',
          body: bodyToSave,
          format: 'html',
          attachments,
          threadId: replyMode ? threadId : '',
          threadSubject: replyMode ? threadSubject : '',
        })
        savedIdRef.current = saved.id
        setDraftId(saved.id)
        onSaved(saved)
        return saved
      } catch {
        setStatus('Could not save right now.')
        return null
      }
    })()
    savingRef.current = p
    const res = await p
    if (savingRef.current === p) savingRef.current = null
    return res
  }

  // Drop the auto-saved draft when it's emptied (so an emptied "New email" doesn't linger as a blank
  // draft row). Waits for any in-flight save so a create that's still landing can't leave an orphan.
  // onDiscard removes it from the parent list and deletes it server-side.
  const dropAutosaved = async () => {
    if (savingRef.current) {
      try {
        await savingRef.current
      } catch {
        // ignore; we still drop by whatever id we have
      }
    }
    const id = savedIdRef.current
    if (!id) return
    savedIdRef.current = undefined
    setDraftId(undefined)
    onDiscard?.(id)
  }

  // Autosave (debounced): the top "New email" composer persists whatever's written without a Save
  // button, so a started email shows in the conversations list as a draft and survives a close.
  // Emptying it back out deletes the draft (mirrors the thread reply box).
  useEffect(() => {
    if (!open || !autosave || readOnly) return
    const t = setTimeout(() => {
      if (htmlHasContent(body) || attachments.length > 0) void persist()
      else void dropAutosaved()
    }, 800)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, subject, to, attachments, autosave, open])

  const saveAndClose = async () => {
    setBusy(true)
    const saved = await persist()
    setBusy(false)
    if (saved) onClose()
  }

  // Permanently delete a saved draft (distinct from Cancel, which just keeps it as-is).
  const discard = () => {
    const id = existing?.id ?? savedIdRef.current
    if (busy || !id) return
    if (!window.confirm('Discard this draft? This permanently deletes it.')) return
    // Drop any attachments uploaded this session that were never saved into the record.
    for (const uid of sessionUploads.current) deleteEmailAttachment(uid).catch(() => {})
    sessionUploads.current = new Set()
    savedIdRef.current = undefined
    onDiscard?.(id)
    onClose()
  }

  // Closing DISCARDS unsaved changes — saving is explicit now (the "Save draft" button), so a
  // block never silently accumulates a draft just because the dialog was opened and closed. Any
  // one-off attachments uploaded this session but never saved/sent are cleaned up so they don't
  // orphan on the server. (Save draft / Send call onClose directly and keep their uploads.)
  const handleClose = () => {
    if (busy) return
    // Autosave mode keeps the draft (and its uploads): flush a final save for any edits the debounce
    // hasn't caught yet, then close without discarding anything.
    if (autosave) {
      if (!readOnly && (htmlHasContent(body) || attachments.length > 0)) void persist()
      else if (!readOnly) void dropAutosaved()
      onClose()
      return
    }
    if (!readOnly && sessionUploads.current.size > 0) {
      for (const id of sessionUploads.current) deleteEmailAttachment(id).catch(() => {})
      sessionUploads.current = new Set()
    }
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

  const send = async () => {
    // Reply mode with no conversation chosen would silently start a new thread, so block it.
    if (replyMode && !threadId) {
      setStatus('Pick a conversation to reply to, or turn off "reply to a thread".')
      return
    }
    if (!subject.trim()) {
      setStatus('Add a subject before sending.')
      return
    }
    // Fill any placeholders the project can now resolve; warn (once) about any that remain so a
    // raw "[Client name]" doesn't go out unnoticed. The stored/sent body has chip markup stripped.
    const resolved = resolveMergeFields(body, project, customVals)
    const remaining = unfilledFields(resolved)
    if (remaining.length > 0 && !confirmUnfilled) {
      setStatus(`These placeholders still need filling: ${remaining.join(', ')}. Fill them in, or click Send again to send as-is.`)
      setConfirmUnfilled(true)
      return
    }
    setBusy(true)
    setStatus('Sending…')
    // Persist the resolved body WITH any unfilled chips intact; the server strips chips from the
    // outgoing email and only rewrites the stored body once the send actually succeeds. So a
    // demo/failed send never destroys the draft's placeholders.
    const saved = await persist(resolved)
    if (!saved) {
      setBusy(false)
      return
    }
    try {
      const r = await sendProjectEmail(saved.id)
      if (r.demo) {
        setStatus('Gmail is not connected, so nothing was sent. Connect it on the Inbox page to send for real.')
        setBusy(false)
        return
      }
      onSaved(r.email)
      setBusy(false)
      onClose()
    } catch {
      setStatus('Something went wrong sending.')
      setBusy(false)
    }
  }

  const applyTemplate = (id: string) => {
    const t = templates.find((x) => x.id === id)
    if (!t) return
    if (t.subject && !replyMode) setSubject(t.subject) // in reply mode the subject must stay the thread's
    const html = t.format === 'html' ? t.body : textToHtml(t.body)
    setBody(resolveMergeFields(html, project, customVals))
    setConfirmUnfilled(false)
    setStatus(`Inserted "${t.name}".`)
  }

  // "Generate" stand-in until live Claude drafting is wired: drop in the template
  // that best matches this kind. No match -> nudge to the picker rather than
  // inserting something unrelated.
  const generate = () => {
    const t = templateHint ? templates.find((x) => templateHint.test(x.name)) : null
    if (!t) {
      setStatus('No template for this one yet. Pick one below or write your own.')
      return
    }
    if (t.subject && !replyMode) setSubject(t.subject) // in reply mode the subject must stay the thread's
    const html = t.format === 'html' ? t.body : textToHtml(t.body)
    setBody(resolveMergeFields(html, project, customVals))
    setConfirmUnfilled(false)
    setStatus(`Drafted from "${t.name}". Live Claude drafting is coming soon.`)
  }

  // --- Claude drafting (headless Claude Code) --------------------------------
  const doClaudeDraft = async () => {
    setClaudeBusy(true)
    setStatus('Drafting with Claude. This can take up to a minute.')
    try {
      const html = await claudeDraftEmail({ projectId: project.id, label: title, instruction: claudeInstruction })
      setBody(html)
      setConfirmUnfilled(false)
      setStatus('Drafted with Claude. Review it before sending.')
    } catch (e) {
      setStatus(String(e instanceof Error ? e.message : e))
    } finally {
      setClaudeBusy(false)
    }
  }
  const doClaudeComplete = async () => {
    setClaudeBusy(true)
    setStatus('Completing the template with Claude. This can take up to a minute.')
    try {
      const html = await claudeCompleteTemplate({ projectId: project.id, body })
      setBody(html)
      setConfirmUnfilled(false)
      setStatus('Template completed by Claude. Review it before sending.')
    } catch (e) {
      setStatus(String(e instanceof Error ? e.message : e))
    } finally {
      setClaudeBusy(false)
    }
  }

  // --- Attachments -----------------------------------------------------------
  const openFilePicker = async () => {
    setAttachMenuOpen(true)
    if (files == null) {
      try {
        setFiles(await loadFiles())
      } catch {
        setFiles([])
      }
    }
  }
  const addFromFiles = (f: FileItem) => {
    setAttachMenuOpen(false)
    setAttachments((prev) =>
      prev.some((a) => a.source === 'files' && a.name === f.name)
        ? prev
        : [...prev, { source: 'files', name: f.name, size: f.size }],
    )
  }
  const onUploadChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files || [])
    e.target.value = '' // allow re-selecting the same file later
    setAttachMenuOpen(false)
    for (const file of list) {
      setStatus(`Uploading ${file.name}…`)
      try {
        const att = await uploadEmailAttachment(file)
        if (att.id) sessionUploads.current.add(att.id)
        setAttachments((prev) => [...prev, att])
        setStatus(null)
      } catch (err) {
        setStatus(String(err instanceof Error ? err.message : err))
      }
    }
  }
  const removeAttachment = (a: EmailAttachment) => {
    setAttachments((prev) => prev.filter((x) => attachKey(x) !== attachKey(a)))
    if (a.source === 'upload' && a.id) {
      sessionUploads.current.delete(a.id)
      deleteEmailAttachment(a.id).catch(() => {})
    }
  }

  const canSend = toList().length > 0 && subject.trim().length > 0 && (htmlHasContent(body) || attachments.length > 0) && !busy

  // Read-only receipt for a sent email: a distinct render with NO editable controls, so a sent
  // email can never be edited, re-drafted, or re-sent from its block.
  if (readOnly && existing) {
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
            <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
            <motion.div
              className="relative flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-line-strong bg-surface shadow-[0_40px_90px_-40px_rgba(0,0,0,0.9)]"
              initial={{ y: 16, opacity: 0, scale: 0.98 }}
              animate={{ y: 0, opacity: 1, scale: 1 }}
              exit={{ y: 16, opacity: 0 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            >
              <div className="flex items-start justify-between gap-4 border-b border-line px-6 pb-4 pt-5">
                <div className="min-w-0">
                  <h2 className="font-display text-[20px] leading-tight text-parchment">{title}</h2>
                  <p className="mt-0.5 truncate text-[12.5px] text-muted">{project.client}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]"
                    style={{ color: 'var(--color-umb-booked)', backgroundColor: 'color-mix(in oklab, var(--color-umb-booked) 16%, transparent)' }}
                  >
                    Sent
                  </span>
                  <button
                    type="button"
                    onClick={onClose}
                    aria-label="Close"
                    className="rounded-lg border border-line p-1.5 text-muted transition-colors hover:border-line-strong hover:text-parchment"
                  >
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                      <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </button>
                </div>
              </div>

              <div className="board-scroll min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
                <p className="text-[11.5px] text-faint">
                  Sent {fmtDate(existing.sentAt)}. This is a record of what went out, and can't be changed.
                </p>
                <div>
                  <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">To</span>
                  <p className="text-[13px] text-parchment">{existing.to.join(', ') || '(no recipients)'}</p>
                </div>
                <div>
                  <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Subject</span>
                  <p className="text-[13px] text-parchment">{existing.subject || '(no subject)'}</p>
                </div>
                {existing.threadId && (
                  <div>
                    <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Thread</span>
                    <p className="text-[13px] text-parchment">Added as a reply to “{existing.threadSubject || 'an existing conversation'}”.</p>
                  </div>
                )}
                <div>
                  <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Message</span>
                  {existing.format === 'html' ? (
                    <div
                      className="email-rte rounded-lg border border-line px-3 py-3"
                      dangerouslySetInnerHTML={{ __html: existing.body }}
                    />
                  ) : (
                    // A legacy email sent as plain text: show it verbatim (whitespace preserved)
                    // rather than HTML-converted, so the receipt matches what actually went out.
                    <div className="rounded-lg border border-line bg-surface-2 px-3 py-3 text-[13px] leading-relaxed text-parchment whitespace-pre-wrap break-words">
                      {existing.body}
                    </div>
                  )}
                </div>
                {existing.attachments.length > 0 && (
                  <div>
                    <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Attachments</span>
                    <ul className="flex flex-wrap gap-1.5">
                      {existing.attachments.map((a) => (
                        <li
                          key={attachKey(a)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-2.5 py-1 text-[11.5px] text-parchment"
                        >
                          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0 text-faint" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21.4 11.05 12.25 20.2a5 5 0 0 1-7.07-7.07l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                          </svg>
                          <span className="max-w-[16rem] truncate">{a.name}</span>
                          {a.size ? <span className="text-faint">{fmtSize(a.size)}</span> : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-end gap-3 border-t border-line px-6 py-4">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-lg bg-brass px-4 py-2 text-[12.5px] font-semibold text-[#231a0c] transition-all hover:brightness-110"
                >
                  Done
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    )
  }

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
            className="relative flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-line-strong bg-surface shadow-[0_40px_90px_-40px_rgba(0,0,0,0.9)]"
            initial={{ y: 16, opacity: 0, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 16, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="flex items-start justify-between gap-4 border-b border-line px-6 pb-4 pt-5">
              <div className="min-w-0">
                <h2 className="font-display text-[20px] leading-tight text-parchment">{title}</h2>
                <p className="mt-0.5 truncate text-[12.5px] text-muted">{project.client}</p>
              </div>
              <div className="flex items-center gap-2">
                {existing?.status === 'sent' && (
                  <span
                    className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]"
                    style={{ color: 'var(--color-umb-booked)', backgroundColor: 'color-mix(in oklab, var(--color-umb-booked) 16%, transparent)' }}
                  >
                    Sent
                  </span>
                )}
                <button
                  type="button"
                  onClick={handleClose}
                  aria-label="Close"
                  className="rounded-lg border border-line p-1.5 text-muted transition-colors hover:border-line-strong hover:text-parchment"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              </div>
            </div>

            <div className="board-scroll min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
              <label className="block">
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">To</span>
                <input
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  placeholder="client@email.com"
                  className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-[13px] text-parchment placeholder:text-faint focus:border-brass-dim focus:outline-none"
                />
                <span className="mt-1 block text-[10.5px] text-faint">Separate multiple addresses with commas.</span>
              </label>

              {/* Reply into an existing conversation instead of starting a new thread. */}
              {!autosave && (
                <div className="rounded-lg border border-line bg-surface-2/40 px-3 py-2.5">
                  <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-parchment">
                    <input
                      type="checkbox"
                      checked={replyMode}
                      onChange={(e) => toggleReplyMode(e.target.checked)}
                      className="h-3.5 w-3.5 rounded border-line"
                      style={{ accentColor: 'var(--color-brass)' }}
                    />
                    Send as a reply in an existing email thread
                  </label>
                  {replyMode && (
                    <div className="mt-2">
                      {threadsError ? (
                        <p className="text-[11.5px] text-[#e08a6b]">
                          Couldn’t load conversations.{' '}
                          <button type="button" onClick={retryLoadThreads} className="font-semibold underline hover:text-parchment">
                            Retry
                          </button>
                        </p>
                      ) : threads === null ? (
                        <p className="text-[11.5px] text-faint">Loading conversations…</p>
                      ) : threads.length > 0 || threadId ? (
                        // Show the picker when there are threads, or when one is already chosen (so a
                        // saved/aged-out selection stays visible even if it isn't in the current list).
                        <div className="relative">
                          <select
                            value={threadId}
                            onChange={(e) => pickThread(e.target.value)}
                            className="w-full cursor-pointer appearance-none rounded-lg border border-line bg-surface-2 py-2 pl-3 pr-8 text-[12.5px] text-parchment focus:border-brass-dim focus:outline-none"
                          >
                            <option value="">Choose a conversation…</option>
                            {threadId && threadSubject && !threads.some((t) => t.id === threadId) && (
                              <option value={threadId}>{threadSubject}</option>
                            )}
                            {threads.map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.subject}
                                {t.lastDate ? ` · ${t.lastDate}` : ''}
                              </option>
                            ))}
                          </select>
                          <svg viewBox="0 0 24 24" className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M6 9l6 6 6-6" />
                          </svg>
                        </div>
                      ) : (
                        <p className="text-[11.5px] text-faint">No conversations on this project yet to reply to.</p>
                      )}
                      {threadId && threadSubject && (
                        <p className="mt-1.5 text-[11px] text-brass-dim">This will be added to “{threadSubject}”.</p>
                      )}
                    </div>
                  )}
                </div>
              )}

              <div className="flex flex-wrap items-end gap-2">
                <label className="min-w-[12rem] flex-1">
                  <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Subject <span className="text-[#ef4444]">*</span></span>
                  <input
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    placeholder="Required"
                    className={[
                      'w-full rounded-lg border bg-surface-2 px-3 py-2 text-[13px] text-parchment placeholder:text-faint focus:outline-none',
                      subject.trim() ? 'border-line focus:border-brass-dim' : 'border-[#ef4444]/60 focus:border-[#ef4444]',
                    ].join(' ')}
                  />
                </label>
                <div className="relative">
                  <select
                    value=""
                    onChange={(e) => {
                      applyTemplate(e.target.value)
                      e.currentTarget.selectedIndex = 0
                    }}
                    className="cursor-pointer appearance-none rounded-lg border border-line bg-surface-2 py-2 pl-3 pr-8 text-[12.5px] font-medium text-muted focus:border-brass-dim focus:outline-none"
                    title="Insert a template"
                  >
                    <option value="" disabled>
                      Insert template…
                    </option>
                    {templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                  <svg viewBox="0 0 24 24" className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </div>
                {templateHint && (
                  <button
                    type="button"
                    onClick={generate}
                    title="Draft from the matching template (live Claude drafting coming soon)"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-brass-dim/60 bg-surface-3 px-3 py-2 text-[12.5px] font-semibold text-brass-bright transition-colors hover:border-brass"
                  >
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8z" />
                      <path d="M19 14l.9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9z" />
                    </svg>
                    Generate
                  </button>
                )}
              </div>

              {claudeAvail && (
                <div className="rounded-lg border border-brass-dim/40 bg-surface-3/40 p-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      value={claudeInstruction}
                      onChange={(e) => setClaudeInstruction(e.target.value)}
                      placeholder="Tell Claude what this email should say (optional)…"
                      className="min-w-[12rem] flex-1 rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-[12.5px] text-parchment placeholder:text-faint focus:border-brass-dim focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={doClaudeDraft}
                      disabled={claudeBusy}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-brass-dim/60 bg-surface-3 px-3 py-1.5 text-[12.5px] font-semibold text-brass-bright transition-colors hover:border-brass disabled:opacity-40"
                    >
                      {claudeBusy ? 'Working…' : 'Draft with Claude'}
                    </button>
                    {htmlHasContent(body) && (
                      <button
                        type="button"
                        onClick={doClaudeComplete}
                        disabled={claudeBusy}
                        className="rounded-lg border border-line px-3 py-1.5 text-[12.5px] font-medium text-muted transition-colors hover:border-brass-dim hover:text-parchment disabled:opacity-40"
                      >
                        Complete template with Claude
                      </button>
                    )}
                  </div>
                  <p className="mt-1.5 text-[10.5px] leading-relaxed text-faint">
                    Claude reads this project, your voice and rules, and this client's recordings. Review before sending.
                  </p>
                </div>
              )}
              {!claudeAvail && (
                <p className="rounded-lg border border-line bg-surface-3/30 px-2.5 py-2 text-[11px] leading-relaxed text-faint">
                  Claude is not set up yet. In Terminal run <span className="text-muted">claude setup-token</span>, paste the token
                  into magic-crm/claude-credentials.json, then restart the CRM.
                </p>
              )}

              <div className="block">
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Message</span>
                <RichTextEditor
                  value={body}
                  onChange={(html) => {
                    setBody(html)
                    setConfirmUnfilled(false)
                  }}
                  smartFields={smartFieldList}
                  resolveField={(key) => resolveSmartField(key, project, customVals)}
                  placeholder="Write a message, pick a template, or hit Generate…"
                />
                {sig.enabled && htmlHasContent(sig.html) && (
                  <div className="mt-2">
                    <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">
                      Signature (added automatically)
                    </span>
                    <div
                      className="email-rte rounded-lg border border-dashed border-line px-3 py-3"
                      dangerouslySetInnerHTML={{ __html: sig.html }}
                    />
                  </div>
                )}
              </div>

              {/* Attachments: pick from the Files page, or upload a one-off. */}
              <div className="block">
                <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Attachments</span>
                {attachments.length > 0 && (
                  <ul className="mb-2 flex flex-wrap gap-1.5">
                    {attachments.map((a) => (
                      <li
                        key={attachKey(a)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface-2 py-1 pl-2.5 pr-1.5 text-[11.5px] text-parchment"
                      >
                        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0 text-faint" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M21.4 11.05 12.25 20.2a5 5 0 0 1-7.07-7.07l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                        </svg>
                        <span className="max-w-[14rem] truncate">{a.name}</span>
                        {a.size ? <span className="text-faint">{fmtSize(a.size)}</span> : null}
                        {a.source === 'upload' && <span className="text-[9px] uppercase tracking-wide text-faint">uploaded</span>}
                        <button
                          type="button"
                          onClick={() => removeAttachment(a)}
                          aria-label={`Remove ${a.name}`}
                          className="rounded p-0.5 text-faint transition-colors hover:text-[#e08a6b]"
                        >
                          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                            <path d="M6 6l12 12M18 6L6 18" />
                          </svg>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="relative inline-block">
                  <button
                    type="button"
                    onClick={() => (attachMenuOpen ? setAttachMenuOpen(false) : openFilePicker())}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-[12px] font-medium text-muted transition-colors hover:border-brass-dim hover:text-parchment"
                  >
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21.4 11.05 12.25 20.2a5 5 0 0 1-7.07-7.07l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                    </svg>
                    Attach
                  </button>
                  {attachMenuOpen && (
                    <div className="absolute left-0 top-[calc(100%+4px)] z-20 w-72 overflow-hidden rounded-lg border border-line-strong bg-surface-2 shadow-[0_20px_50px_-20px_rgba(0,0,0,0.9)]">
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="flex w-full items-center gap-2 border-b border-line px-3 py-2 text-left text-[12px] text-parchment hover:bg-surface-3"
                      >
                        <svg viewBox="0 0 24 24" className="h-4 w-4 text-faint" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 16V4M7 9l5-5 5 5M5 20h14" />
                        </svg>
                        Upload from this computer…
                      </button>
                      <div className="px-3 pb-1 pt-2 text-[9.5px] font-semibold uppercase tracking-[0.14em] text-faint">From your Files</div>
                      <div className="board-scroll max-h-56 overflow-y-auto pb-1">
                        {files == null ? (
                          <p className="px-3 py-2 text-[11.5px] text-faint">Loading…</p>
                        ) : files.length === 0 ? (
                          <p className="px-3 py-2 text-[11.5px] text-faint">No files yet. Add some on the Files page.</p>
                        ) : (
                          files.map((f) => (
                            <button
                              key={f.name}
                              type="button"
                              onClick={() => addFromFiles(f)}
                              className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[12px] text-parchment hover:bg-surface-3"
                            >
                              <span className="min-w-0 truncate">{f.name}</span>
                              <span className="shrink-0 text-[10.5px] text-faint">{fmtSize(f.size)}</span>
                            </button>
                          ))
                        )}
                      </div>
                    </div>
                  )}
                  <input ref={fileInputRef} type="file" multiple className="hidden" onChange={onUploadChosen} />
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-line px-6 py-4">
              <div className="flex min-w-0 items-center gap-3">
                {(existing || draftId) && (
                  <button
                    type="button"
                    onClick={discard}
                    disabled={busy}
                    className="shrink-0 rounded-lg px-2.5 py-2 text-[12.5px] font-medium text-[#e08a6b] transition-colors hover:brightness-110 disabled:opacity-40"
                  >
                    Discard draft
                  </button>
                )}
                <span className="truncate text-[11.5px] text-muted">{status}</span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={handleClose}
                  disabled={busy}
                  className="rounded-lg px-3 py-2 text-[12.5px] font-medium text-faint transition-colors hover:text-parchment disabled:opacity-40"
                >
                  {autosave ? 'Close' : 'Cancel'}
                </button>
                {!autosave && (
                  <button
                    type="button"
                    onClick={saveAndClose}
                    disabled={busy}
                    className="rounded-lg border border-line px-3.5 py-2 text-[12.5px] font-medium text-muted transition-colors hover:border-line-strong hover:text-parchment disabled:opacity-40"
                  >
                    Save draft
                  </button>
                )}
                <button
                  type="button"
                  onClick={send}
                  disabled={!canSend}
                  className="rounded-lg bg-brass px-4 py-2 text-[12.5px] font-semibold text-[#231a0c] transition-all hover:brightness-110 disabled:opacity-40"
                >
                  {busy ? 'Working…' : confirmUnfilled ? 'Send anyway' : 'Send'}
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function fmtDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
