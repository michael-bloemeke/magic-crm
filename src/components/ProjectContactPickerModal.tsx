import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { Contact, ContactType } from '../api'

// Pick an existing contact to add to a project, or create a new one. Used by the
// project Details "Add contact" button. "Create new contact" opens a small form
// right away (no need to type a name into the search first); only the name is
// required.

type NewContact = { name: string; email?: string; phone?: string; type?: ContactType }

type Props = {
  open: boolean
  contacts: Contact[]
  linkedIds: Set<string>
  onPick: (c: Contact) => void
  onCreate: (details: NewContact) => void
  onClose: () => void
}

export function ProjectContactPickerModal({ open, contacts, linkedIds, onPick, onCreate, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setQuery('')
      setCreating(false)
      setTimeout(() => inputRef.current?.focus(), 20)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (creating) setCreating(false)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, creating])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    return contacts
      .filter((c) => !linkedIds.has(c.id))
      .filter((c) => (q ? [c.name, c.emails.join(' '), c.phones.join(' ')].join(' ').toLowerCase().includes(q) : true))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 40)
  }, [contacts, linkedIds, query])

  const trimmed = query.trim()

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[70] flex justify-center px-4 pt-[14vh]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
          <motion.div
            initial={{ opacity: 0, y: -10, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.985 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className="relative z-10 flex max-h-[72vh] w-[460px] max-w-[92vw] flex-col overflow-hidden rounded-2xl border border-line-strong bg-surface shadow-[0_40px_80px_-30px_rgba(0,0,0,0.18)]"
          >
            {creating ? (
              <CreateForm
                prefill={trimmed}
                onBack={() => setCreating(false)}
                onSubmit={(d) => onCreate(d)}
              />
            ) : (
              <>
                <div className="flex items-center gap-2 border-b border-line px-4 py-3">
                  <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-faint" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="7" />
                    <path d="M21 21l-4.3-4.3" />
                  </svg>
                  <input
                    ref={inputRef}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search contacts…"
                    className="w-full bg-transparent text-[14px] text-parchment placeholder:text-faint focus:outline-none"
                  />
                </div>

                <div className="board-scroll min-h-0 flex-1 overflow-y-auto p-2">
                  {results.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => onPick(c)}
                      className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-surface-2"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13.5px] text-parchment">{c.name}</span>
                        <span className="block truncate text-[11px] text-faint">{c.emails[0] || c.phones[0] || 'No contact info'}</span>
                      </span>
                      <span className="shrink-0 rounded-full border border-line px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-faint">
                        {c.type}
                      </span>
                    </button>
                  ))}
                  {results.length === 0 && (
                    <p className="px-3 py-6 text-center text-[12px] text-faint">
                      {trimmed ? 'No existing contacts match.' : 'No other contacts to add.'}
                    </p>
                  )}
                </div>

                <div className="border-t border-line p-2">
                  <button
                    type="button"
                    onClick={() => setCreating(true)}
                    className="flex w-full items-center gap-2 rounded-lg border border-brass-dim/60 bg-surface-3 px-3 py-2 text-[12.5px] font-semibold text-brass-bright transition-colors hover:border-brass"
                  >
                    <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                    Create new contact
                  </button>
                </div>
              </>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

const TYPES: ContactType[] = ['client', 'vendor', 'associate', 'other']

function CreateForm({
  prefill,
  onBack,
  onSubmit,
}: {
  prefill: string
  onBack: () => void
  onSubmit: (d: NewContact) => void
}) {
  const [name, setName] = useState(prefill)
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [type, setType] = useState<ContactType>('client')
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setTimeout(() => nameRef.current?.focus(), 20)
  }, [])

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const n = name.trim()
    if (!n) return
    onSubmit({ name: n, email: email.trim() || undefined, phone: phone.trim() || undefined, type })
  }

  const labelCls = 'mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-faint'
  const inputCls = 'w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-[13px] text-parchment placeholder:text-faint focus:border-brass-dim focus:outline-none'

  return (
    <form onSubmit={submit}>
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <button type="button" onClick={onBack} aria-label="Back to search" className="rounded-md p-1 text-muted transition-colors hover:text-parchment">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 6l-6 6 6 6" />
          </svg>
        </button>
        <p className="text-[14px] font-semibold text-parchment">New contact</p>
      </div>

      <div className="space-y-3 p-4">
        <label className="block">
          <span className={labelCls}>Name *</span>
          <input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" className={inputCls} />
        </label>
        <label className="block">
          <span className={labelCls}>Email</span>
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@email.com" className={inputCls} />
        </label>
        <div className="flex gap-3">
          <label className="block flex-1">
            <span className={labelCls}>Phone</span>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(919) 555-1234" className={inputCls} />
          </label>
          <label className="block w-36">
            <span className={labelCls}>Type</span>
            <select value={type} onChange={(e) => setType(e.target.value as ContactType)} className={inputCls}>
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {t[0].toUpperCase() + t.slice(1)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-line p-3">
        <button type="button" onClick={onBack} className="rounded-lg border border-line px-3.5 py-2 text-[12.5px] font-medium text-muted transition-colors hover:border-line-strong hover:text-parchment">
          Cancel
        </button>
        <button
          type="submit"
          disabled={!name.trim()}
          className="rounded-lg bg-brass px-4 py-2 text-[12.5px] font-semibold text-[#ffffff] transition-all hover:brightness-110 disabled:opacity-40"
        >
          Create contact
        </button>
      </div>
    </form>
  )
}
