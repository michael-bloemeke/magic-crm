import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { type Project } from '../pipeline'
import { loadTemplates, saveProjectEmail, sendProjectEmail, type ProjectEmail, type Template } from '../api'

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
  templateHint,
  onClose,
  onSaved,
}: {
  open: boolean
  project: Project
  recipientEmails: string[]
  existing: ProjectEmail | null
  kind: string
  title: string
  defaultSubject: string
  templateHint?: RegExp
  onClose: () => void
  onSaved: (email: ProjectEmail) => void
}) {
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState(defaultSubject)
  const [body, setBody] = useState('')
  const [templates, setTemplates] = useState<Template[]>([])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setTo((existing?.to?.length ? existing.to : recipientEmails).join(', '))
    setSubject(existing?.subject || defaultSubject)
    setBody(existing?.body || '')
    setStatus(existing?.status === 'sent' && existing.sentAt ? `Sent ${fmtDate(existing.sentAt)}.` : null)
    loadTemplates()
      .then(setTemplates)
      .catch(() => setTemplates([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const toList = () => to.split(',').map((s) => s.trim()).filter(Boolean)
  const dirty =
    body !== (existing?.body || '') ||
    subject !== (existing?.subject || defaultSubject) ||
    toList().join(',') !== (existing?.to || []).join(',')

  const persist = async (): Promise<ProjectEmail | null> => {
    try {
      const saved = await saveProjectEmail({
        id: existing?.id,
        projectId: project.id,
        kind,
        to: toList(),
        subject: subject.trim() || defaultSubject || '(no subject)',
        body,
      })
      onSaved(saved)
      return saved
    } catch {
      setStatus('Could not save right now.')
      return null
    }
  }

  const saveAndClose = async () => {
    setBusy(true)
    const saved = await persist()
    setBusy(false)
    if (saved) onClose()
  }

  // Closing keeps the work: save a draft if there's content and it changed.
  const handleClose = async () => {
    if (busy) return
    if (dirty && body.trim() !== '') await saveAndClose()
    else onClose()
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
    setBusy(true)
    setStatus('Sending…')
    const saved = await persist()
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
    if (t.subject) setSubject(t.subject)
    setBody(t.body)
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
    if (t.subject) setSubject(t.subject)
    setBody(t.body)
    setStatus(`Drafted from "${t.name}". Live Claude drafting is coming soon.`)
  }

  const canSend = toList().length > 0 && body.trim() !== '' && !busy

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

              <div className="flex flex-wrap items-end gap-2">
                <label className="min-w-[12rem] flex-1">
                  <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Subject</span>
                  <input
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-[13px] text-parchment focus:border-brass-dim focus:outline-none"
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

              <label className="block">
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Message</span>
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={10}
                  placeholder="Write a message, pick a template, or hit Generate…"
                  className="w-full resize-y rounded-lg border border-line bg-surface-2 p-3 text-[13px] leading-relaxed text-parchment placeholder:text-faint focus:border-brass-dim focus:outline-none"
                />
              </label>
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-line px-6 py-4">
              <span className="text-[11.5px] text-muted">{status}</span>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={saveAndClose}
                  disabled={busy}
                  className="rounded-lg border border-line px-3.5 py-2 text-[12.5px] font-medium text-muted transition-colors hover:border-line-strong hover:text-parchment disabled:opacity-40"
                >
                  Save draft
                </button>
                <button
                  type="button"
                  onClick={send}
                  disabled={!canSend}
                  className="rounded-lg bg-brass px-4 py-2 text-[12.5px] font-semibold text-[#231a0c] transition-all hover:brightness-110 disabled:opacity-40"
                >
                  {busy ? 'Working…' : 'Send'}
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
