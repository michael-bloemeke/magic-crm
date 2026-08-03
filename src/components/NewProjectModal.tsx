import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { createProject as apiCreateProject, type Contact } from '../api'
import { EVENT_TYPE_ACCENT, type CategoryDef, type Project } from '../pipeline'
import { StageSelect } from './StageSelect'
import { formatPhoneField } from '../phone'

// Create a project. Only the name is required; everything else is optional and
// editable later. Contacts can be picked from the CRM's contact list or typed fresh.

type Props = {
  open: boolean
  contacts: Contact[]
  categories: CategoryDef[]
  onClose: () => void
  onCreated: (p: Project) => void
}

const EVENT_TYPES = Object.keys(EVENT_TYPE_ACCENT)

export function NewProjectModal({ open, contacts, categories, onClose, onCreated }: Props) {
  const [name, setName] = useState('')
  const [eventType, setEventType] = useState('Other')
  const [stageId, setStageId] = useState('inquiry')
  const [eventDate, setEventDate] = useState('')
  const [fee, setFee] = useState('')
  const [location, setLocation] = useState('')
  const [contactName, setContactName] = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [contactPhone, setContactPhone] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName('')
    setEventType('Other')
    setStageId('inquiry')
    setEventDate('')
    setFee('')
    setLocation('')
    setContactName('')
    setContactEmail('')
    setContactPhone('')
    setNotes('')
    setError(null)
    setSaving(false)
  }, [open])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    if (open) window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Every contact in the CRM, as picker options.
  //
  // Sourced from the real CONTACTS list. This used to walk `projects` and read each one's
  // contactNames/contactEmails/contactPhones instead, which quietly hid two whole groups of people:
  //
  //   - anyone with no project yet, which is exactly who you are looking for when you are creating
  //     their first project
  //   - every SECONDARY contact on a project, because that code took only `.split(',')[0]`
  //
  // Those project fields are a denormalized copy anyway. Contacts became first-class records with
  // explicit stored links (crm-links.json) back in June 2026; this picker was just never moved over.
  const options = useMemo(() => {
    return contacts
      .filter((c) => String(c.name || '').trim())
      .map((c) => {
        const email = (c.emails || []).find((e) => String(e || '').trim()) || ''
        const phone = (c.phones || []).find((p) => String(p || '').trim()) || ''
        return { key: c.id, label: c.name + (email ? ` · ${email}` : ''), name: c.name, email, phone }
      })
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [contacts])

  const create = async () => {
    if (!name.trim()) return
    setSaving(true)
    setError(null)
    try {
      const p = await apiCreateProject({
        clientName: name.trim(),
        eventType,
        stageId,
        eventDate,
        totalFee: fee,
        eventLocation: location,
        contactNames: contactName,
        contactEmails: contactEmail,
        contactPhones: contactPhone,
        projectNotes: notes,
      })
      onCreated(p)
      onClose()
    } catch (e) {
      setError(String((e as Error)?.message || e))
      setSaving(false)
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[60] flex items-start justify-center p-4 pt-[6vh]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={onClose} aria-hidden />

          <motion.div
            className="relative flex max-h-[86vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-line-strong bg-surface shadow-[0_30px_70px_-30px_rgba(0,0,0,0.9)]"
            initial={{ y: 16, opacity: 0.6, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 16, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="border-b border-line px-6 pb-4 pt-5">
              <h2 className="font-display text-[20px] leading-tight text-parchment">New project</h2>
              <p className="mt-1 text-[12.5px] text-muted">Only a name is needed. Add anything else now or later.</p>
            </div>

            <div className="board-scroll min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
              <Field label="Project name" required>
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && name.trim()) create()
                  }}
                  placeholder="e.g. Sarah & Tom Wedding"
                  className="input w-full"
                />
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Event type">
                  <select value={eventType} onChange={(e) => setEventType(e.target.value)} className="input w-full">
                    {EVENT_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Starting stage">
                  <div className="[&_select]:w-full [&_select]:rounded-lg [&_select]:py-2 [&_select]:text-[13px] [&_select]:normal-case [&_select]:tracking-normal">
                    <StageSelect value={stageId} onChange={setStageId} categories={categories} />
                  </div>
                </Field>
                <Field label="Event date">
                  <input type="date" value={eventDate} onChange={(e) => setEventDate(e.target.value)} className="input w-full [color-scheme:dark]" />
                </Field>
                <Field label="Quote">
                  <input value={fee} onChange={(e) => setFee(e.target.value)} placeholder="$" className="input w-full" />
                </Field>
              </div>

              <Field label="Location">
                <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Venue / city" className="input w-full" />
              </Field>

              {/* Contact (optional) */}
              <div className="rounded-xl border border-line bg-surface-2/40 p-3">
                <div className="mb-2 flex items-center">
                  <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-faint">Contact (optional)</span>
                </div>
                {options.length > 0 && (
                  <div className="mb-2">
                    <ContactSearchPicker
                      contacts={options}
                      onPick={(c) => {
                        setContactName(c.name)
                        setContactEmail(c.email)
                        setContactPhone(c.phone)
                      }}
                    />
                  </div>
                )}
                <div className="space-y-2">
                  <input value={contactName} onChange={(e) => setContactName(e.target.value)} placeholder="Contact name" className="input w-full" />
                  <div className="grid grid-cols-2 gap-2">
                    <input value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} placeholder="Email" className="input w-full" />
                    <input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} onBlur={() => setContactPhone(formatPhoneField(contactPhone))} placeholder="Phone" className="input w-full" />
                  </div>
                </div>
              </div>

              <Field label="Notes">
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={3}
                  placeholder="Anything worth jotting down"
                  className="input w-full resize-y"
                />
              </Field>

              {error && <p className="text-[12.5px] text-[#e08a6b]">{error}</p>}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-line px-6 py-4">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-line px-4 py-2 text-[12.5px] font-medium text-muted transition-colors hover:border-line-strong hover:text-parchment"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!name.trim() || saving}
                onClick={create}
                className="rounded-lg border border-brass-dim/60 bg-gradient-to-b from-surface-3 to-surface px-4 py-2 text-[12.5px] font-semibold text-brass-bright transition-all hover:border-brass disabled:cursor-not-allowed disabled:opacity-40"
              >
                {saving ? 'Creating…' : 'Create project'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

type ContactOpt = { key: string; label: string; name: string; email: string; phone: string }

// A search-as-you-type picker for reusing an existing contact. Replaces the old native
// <select> (which, with hundreds of contacts, was an unusable wall of options whose only
// "search" was first-letter jump). Filters by name, email, or phone digits and is
// keyboard-navigable, mirroring the global Cmd-K search.
function ContactSearchPicker({ contacts, onPick }: { contacts: ContactOpt[]; onPick: (c: ContactOpt) => void }) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [hi, setHi] = useState(0)

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return contacts.slice(0, 8)
    const tokens = q.split(/\s+/)
    const qDigits = q.replace(/\D/g, '')
    const matches = contacts.filter((c) => {
      const hay = `${c.name} ${c.email}`.toLowerCase()
      const phoneDigits = c.phone.replace(/\D/g, '')
      const byTokens = tokens.every((t) => {
        const td = t.replace(/\D/g, '')
        return hay.includes(t) || (td.length >= 2 && phoneDigits.includes(td))
      })
      return byTokens || (qDigits.length >= 3 && phoneDigits.includes(qDigits))
    })
    return matches.slice(0, 8)
  }, [query, contacts])

  useEffect(() => {
    setHi(0)
  }, [query])

  const choose = (c: ContactOpt) => {
    onPick(c)
    setQuery('')
    setOpen(false)
  }

  return (
    <div className="relative">
      <div className="relative">
        <svg
          viewBox="0 0 24 24"
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-3.6-3.6" />
        </svg>
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              if (open) {
                e.stopPropagation() // close the dropdown, not the whole modal
                setOpen(false)
              }
              return
            }
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              if (!open) setOpen(true)
              else setHi((h) => Math.min(h + 1, results.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setHi((h) => Math.max(h - 1, 0))
            } else if (e.key === 'Enter') {
              if (open && results[hi]) {
                e.preventDefault()
                choose(results[hi])
              }
            }
          }}
          placeholder="Search existing contacts…"
          className="input w-full"
          style={{ paddingLeft: '2rem' }}
        />
      </div>
      {open && results.length > 0 && (
        <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-20 max-h-56 overflow-y-auto rounded-lg border border-line-strong bg-surface-3 py-1 shadow-[0_20px_44px_-20px_rgba(0,0,0,0.9)]">
          {results.map((c, i) => (
            <button
              key={c.key}
              type="button"
              onMouseDown={(e) => e.preventDefault()} // keep input focus so onBlur doesn't beat the click
              onMouseEnter={() => setHi(i)}
              onClick={() => choose(c)}
              className={[
                'flex w-full flex-col items-start px-3 py-1.5 text-left transition-colors',
                i === hi ? 'bg-surface-2' : 'hover:bg-surface-2',
              ].join(' ')}
            >
              <span className="text-[12.5px] text-parchment">{c.name || '(no name)'}</span>
              {(c.email || c.phone) && (
                <span className="text-[10.5px] text-faint">{[c.email, c.phone].filter(Boolean).join(' · ')}</span>
              )}
            </button>
          ))}
        </div>
      )}
      {open && query.trim() && results.length === 0 && (
        <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-20 rounded-lg border border-line-strong bg-surface-3 px-3 py-2 text-[11.5px] text-faint shadow-[0_20px_44px_-20px_rgba(0,0,0,0.9)]">
          No matches.
        </div>
      )}
    </div>
  )
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.16em] text-faint">
        {label}
        {required && <span className="ml-1 text-brass">*</span>}
      </span>
      {children}
    </label>
  )
}
