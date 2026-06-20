import type { Contact } from '../api'
import { REL_COLOR } from '../contacts'

// A contact shown on a project: name + email + phone grouped, click to open the
// contact panel, × to unlink from the project.

export function ContactCard({
  contact,
  onOpen,
  onRemove,
}: {
  contact: Contact
  onOpen: (c: Contact) => void
  onRemove: (c: Contact) => void
}) {
  const dot = contact.relationship ? REL_COLOR[contact.relationship] : undefined
  return (
    <div className="group relative flex items-stretch overflow-hidden rounded-xl border border-line bg-surface-2/60 transition-colors hover:border-line-strong hover:bg-surface-3/70">
      <button
        type="button"
        onClick={() => onOpen(contact)}
        title="Open contact"
        className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left"
      >
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={dot ? { backgroundColor: dot } : { boxShadow: 'inset 0 0 0 1px var(--color-line-strong)' }}
          title={contact.relationship ? `Relationship: ${contact.relationship}` : undefined}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-[14px] text-parchment">{contact.name}</span>
            <span className="shrink-0 rounded-full border border-line px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-faint">
              {contact.type}
            </span>
          </span>
          <span className="mt-0.5 flex flex-wrap gap-x-3 text-[11.5px] text-faint">
            {contact.emails[0] && <span className="truncate">{contact.emails[0]}</span>}
            {contact.phones[0] && <span className="truncate">{contact.phones[0]}</span>}
            {!contact.emails[0] && !contact.phones[0] && <span>No contact info</span>}
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={() => onRemove(contact)}
        title="Remove this contact from the project"
        aria-label="Remove contact from project"
        className="flex w-9 shrink-0 items-center justify-center border-l border-line/60 text-faint opacity-0 transition-all hover:bg-surface-3 hover:text-[#e08a6b] group-hover:opacity-100"
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  )
}
