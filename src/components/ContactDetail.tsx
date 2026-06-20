import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { EVENT_TYPE_ACCENT, formatEventDate, type Project } from '../pipeline'
import type { Contact, ContactType } from '../api'
import { EditableField } from './EditableField'
import { RelationshipChips } from './RelationshipChips'
import { TagEditor } from './TagEditor'
import { formatPhoneField } from '../phone'

// Side-panel for one contact: relationship + type + engagement + tags + notes +
// contact info + the projects linked to them. Edits save immediately.

type Props = {
  contact: Contact | null
  linkedProjects: Project[]
  knownTags: string[]
  onNewTag?: (tag: string) => void
  onChange: (patch: Partial<Contact>) => void
  onDelete: () => void
  onClose: () => void
  onOpenProject: (id: string) => void
  // When provided, shows a back arrow (e.g. to return to the project pane).
  onBack?: () => void
}

const TYPES: ContactType[] = ['client', 'vendor', 'associate', 'other']

export function ContactDetail({ contact, linkedProjects, knownTags, onNewTag, onChange, onDelete, onClose, onOpenProject, onBack }: Props) {
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Escape mirrors the Back arrow when there's a project to return to.
      if (e.key === 'Escape') (onBack ?? onClose)()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, onBack])

  // Reset transient state when switching to a different contact.
  useEffect(() => {
    setConfirmingDelete(false)
  }, [contact?.id])

  const showEngagement = contact?.type === 'vendor' || contact?.type === 'associate'

  return (
    <AnimatePresence>
      {contact && (
        <motion.div
          className="fixed inset-0 z-50 flex justify-end"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          <div className="absolute inset-0 bg-black/55 backdrop-blur-[2px]" onClick={onClose} aria-hidden />

          <motion.aside
            className="board-scroll relative h-full w-[460px] max-w-[92vw] overflow-y-auto border-l border-line-strong bg-surface shadow-[-30px_0_60px_-30px_rgba(0,0,0,0.9)]"
            initial={{ x: 36, opacity: 0.4 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 36, opacity: 0 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="sticky top-0 z-10 border-b border-line bg-surface/95 px-7 pb-5 pt-6 backdrop-blur">
              {onBack && (
                <button
                  type="button"
                  onClick={onBack}
                  className="mb-3 inline-flex items-center gap-1.5 text-[12px] font-medium text-muted transition-colors hover:text-parchment"
                >
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M15 6l-6 6 6 6" />
                  </svg>
                  Back to project
                </button>
              )}
              <div className="flex items-start justify-between gap-4">
                <h2 className="font-display text-[24px] leading-tight text-parchment">{contact.name || 'Contact'}</h2>
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-lg border border-line p-1.5 text-muted transition-colors hover:border-line-strong hover:text-parchment"
                  aria-label="Close"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              </div>
            </div>

            <div className="space-y-7 px-7 py-6">
              {/* Relationship */}
              <section>
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-brass-dim">Relationship</h3>
                <RelationshipChips value={contact.relationship} onChange={(v) => onChange({ relationship: v })} />
                <p className="mt-1.5 text-[11px] text-faint">
                  Active = in the pipeline now. Yes / Maybe / No is the lasting call once they've left it.
                </p>
              </section>

              {/* Type + engagement */}
              <section>
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-brass-dim">Type</h3>
                <div className="flex flex-wrap gap-1.5">
                  {TYPES.map((t) => {
                    const active = contact.type === t
                    return (
                      <button
                        key={t}
                        type="button"
                        onClick={() => onChange({ type: t })}
                        className={[
                          'rounded-full border px-3 py-1 text-[12px] font-medium capitalize transition-colors',
                          active ? 'border-brass-dim bg-surface-3 text-brass-bright' : 'border-line text-muted hover:text-parchment',
                        ].join(' ')}
                      >
                        {t}
                      </button>
                    )
                  })}
                </div>
                {showEngagement && (
                  <div className="mt-3">
                    <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-faint">Engagement</p>
                    <div className="flex gap-1.5">
                      {([
                        { v: 'emailed', label: 'Emailed only' },
                        { v: 'collaborated', label: 'Worked together' },
                      ] as const).map((e) => {
                        const active = contact.engagement === e.v
                        return (
                          <button
                            key={e.v}
                            type="button"
                            onClick={() => onChange({ engagement: active ? '' : e.v })}
                            className={[
                              'rounded-full border px-3 py-1 text-[11.5px] font-medium transition-colors',
                              active ? 'border-brass-dim bg-surface-3 text-brass-bright' : 'border-line text-muted hover:text-parchment',
                            ].join(' ')}
                          >
                            {e.label}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}
              </section>

              {/* Tags */}
              <section>
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-brass-dim">Tags</h3>
                <TagEditor
                  tags={contact.tags}
                  knownTags={knownTags}
                  onChange={(tags) => onChange({ tags })}
                  onNewTag={onNewTag}
                />
              </section>

              {/* Contact info */}
              <section>
                <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-brass-dim">Contact</h3>
                <div className="space-y-3">
                  <EditableField label="Name" value={contact.name} onSave={(v) => onChange({ name: v })} />
                  <EditableField label="Email(s)" value={contact.emails.join(', ')} onSave={(v) => onChange({ emails: splitCsv(v) })} />
                  <EditableField label="Phone(s)" value={contact.phones.join(', ')} onSave={(v) => onChange({ phones: splitCsv(v) })} format={formatPhoneField} />
                </div>
              </section>

              {/* Notes */}
              <section>
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-brass-dim">Notes</h3>
                <EditableField value={contact.notes} onSave={(v) => onChange({ notes: v })} multiline />
                <p className="mt-1 text-[11px] text-faint">Profession, how you know them, vendor details, anything useful.</p>
              </section>

              {/* Linked projects */}
              <section>
                <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-brass-dim">
                  Linked projects {linkedProjects.length > 0 && <span className="text-faint">({linkedProjects.length})</span>}
                </h3>
                {linkedProjects.length === 0 ? (
                  <p className="text-[12.5px] text-faint">No projects linked to this contact.</p>
                ) : (
                  <div className="space-y-2">
                    {linkedProjects.map((p) => {
                      const color = EVENT_TYPE_ACCENT[p.eventType]
                      return (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => onOpenProject(p.id)}
                          className="flex w-full items-center justify-between gap-3 rounded-lg border border-line bg-surface-2/60 px-3 py-2 text-left transition-colors hover:border-line-strong hover:bg-surface-3/70"
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-[13px] text-parchment">{p.client}</span>
                            <span className="text-[11px] text-faint">
                              {p.eventType} · {formatEventDate(p.eventDate)} · {p.bucket}
                            </span>
                          </span>
                          <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                        </button>
                      )
                    })}
                  </div>
                )}
              </section>

              <div className="border-t border-line pt-4">
                {confirmingDelete ? (
                  <div className="flex items-center gap-3">
                    <span className="text-[12px] text-muted">Delete this contact permanently?</span>
                    <button
                      type="button"
                      onClick={onDelete}
                      className="rounded-md border px-2.5 py-1 text-[12px] font-semibold transition-colors"
                      style={{ borderColor: 'color-mix(in oklab, #e08a6b 55%, transparent)', color: '#f0a087' }}
                    >
                      Delete
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmingDelete(false)}
                      className="text-[12px] font-medium text-faint transition-colors hover:text-parchment"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmingDelete(true)}
                    className="text-[12px] font-medium text-faint transition-colors hover:text-[#e08a6b]"
                  >
                    Delete contact
                  </button>
                )}
                {confirmingDelete && linkedProjects.length > 0 && (
                  <p className="mt-2 text-[11px] text-faint">
                    This deletes the contact and removes it from{' '}
                    {linkedProjects.length === 1 ? 'its project' : `its ${linkedProjects.length} projects`}. The{' '}
                    {linkedProjects.length === 1 ? 'project stays' : 'projects stay'}; only the contact is gone, and it
                    won’t come back on its own.
                  </p>
                )}
              </div>
            </div>
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function splitCsv(s: string): string[] {
  return s
    .split(/[,;]/)
    .map((x) => x.trim())
    .filter(Boolean)
}
