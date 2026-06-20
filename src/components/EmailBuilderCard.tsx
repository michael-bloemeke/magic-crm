import { useState, type ReactNode } from 'react'
import { type Project } from '../pipeline'
import { sendProjectEmail, type ProjectEmail } from '../api'
import { EmailBuilderModal } from './EmailBuilderModal'

// One email slot in a project section (e.g. "Post-call email", "Follow-up #2",
// "Check-in #1", "Thank-you email"). Shows the status (none / draft / sent), a
// Send button for a saved draft, and opens the builder dialog. The record itself
// is owned by the parent (ProjectDetailsBody loads them all once and passes each
// card its match by kind), so saving/sending here reports back up via onSaved.
export function EmailBuilderCard({
  project,
  recipientEmails,
  kind,
  title,
  defaultSubject,
  templateHint,
  email,
  onSaved,
  onDelete,
}: {
  project: Project
  recipientEmails: string[]
  kind: string
  title: string
  defaultSubject: string
  templateHint?: RegExp
  email: ProjectEmail | null
  onSaved: (email: ProjectEmail) => void
  // Provided only for removable slots (added follow-ups / check-ins). The button
  // shows only while the email is unsent.
  onDelete?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const sent = email?.status === 'sent'
  const draft = !!email && email.status === 'draft'

  const sendNow = async () => {
    if (!email) return
    setBusy(true)
    setNote(null)
    try {
      const r = await sendProjectEmail(email.id)
      if (r.demo) setNote('Gmail not connected. Connect it on the Inbox page to send.')
      else onSaved(r.email)
    } catch {
      setNote('Could not send.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-xl border border-line bg-surface-2/30 px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-[13px] font-medium text-parchment">{title}</p>
          {sent && <Badge tone="booked">Sent</Badge>}
          {draft && <Badge tone="amber">Draft</Badge>}
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          {onDelete && !sent && (
            <button
              type="button"
              onClick={onDelete}
              aria-label={`Delete ${title}`}
              title={`Delete ${title}`}
              className="text-faint transition-colors hover:text-[#e08a6b]"
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6M10 11v6M14 11v6" />
              </svg>
            </button>
          )}
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="text-[11.5px] font-semibold text-brass-bright transition-colors hover:text-brass"
          >
            {sent ? 'View' : draft ? 'Edit' : 'Write'}
          </button>
        </div>
      </div>

      <p className="mt-1 text-[11.5px] leading-relaxed text-faint">
        {sent
          ? `Sent ${fmtDate(email!.sentAt)}${email!.to.length ? ` to ${email!.to.join(', ')}` : ''}.`
          : draft
            ? 'Draft saved, not sent yet.'
            : 'Not started.'}
      </p>

      {draft && (
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={sendNow}
            disabled={busy}
            className="rounded-lg bg-brass px-3 py-1.5 text-[12px] font-semibold text-[#231a0c] transition-all hover:brightness-110 disabled:opacity-40"
          >
            {busy ? 'Sending…' : 'Send'}
          </button>
          {note && <span className="text-[11px] text-muted">{note}</span>}
        </div>
      )}
      {!draft && note && <p className="mt-1 text-[11px] text-muted">{note}</p>}

      <EmailBuilderModal
        open={open}
        project={project}
        recipientEmails={recipientEmails}
        existing={email}
        kind={kind}
        title={title}
        defaultSubject={defaultSubject}
        templateHint={templateHint}
        onClose={() => setOpen(false)}
        onSaved={onSaved}
      />
    </div>
  )
}

function Badge({ tone, children }: { tone: 'booked' | 'amber'; children: ReactNode }) {
  const style =
    tone === 'booked'
      ? { color: 'var(--color-umb-booked)', backgroundColor: 'color-mix(in oklab, var(--color-umb-booked) 16%, transparent)' }
      : { color: '#d9a441', backgroundColor: 'color-mix(in oklab, #d9a441 16%, transparent)' }
  return (
    <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.1em]" style={style}>
      {children}
    </span>
  )
}

function fmtDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
