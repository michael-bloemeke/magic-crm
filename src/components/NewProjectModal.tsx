import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { createProject as apiCreateProject } from '../api'
import { EVENT_TYPE_ACCENT, type CategoryDef, type Project } from '../pipeline'
import { StageSelect } from './StageSelect'
import { formatPhoneField } from '../phone'

// Create a project. Only the name is required; everything else is optional and
// editable later. Contacts can be picked from existing projects or typed fresh.

type Props = {
  open: boolean
  projects: Project[]
  categories: CategoryDef[]
  onClose: () => void
  onCreated: (p: Project) => void
}

const EVENT_TYPES = Object.keys(EVENT_TYPE_ACCENT)

export function NewProjectModal({ open, projects, categories, onClose, onCreated }: Props) {
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

  // Unique existing contacts (first contact of each project).
  const contacts = useMemo(() => {
    const seen = new Set<string>()
    const out: { key: string; label: string; name: string; email: string; phone: string }[] = []
    for (const p of projects) {
      const cn = (p.contactNames || '').split(/[,;]/)[0].trim()
      const ce = (p.contactEmails || '').split(/[,;]/)[0].trim()
      const cp = (p.contactPhones || '').split(/[,;]/)[0].trim()
      if (!cn && !ce) continue
      const key = `${cn}|${ce}`.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ key, label: cn + (ce ? ` · ${ce}` : ''), name: cn, email: ce, phone: cp })
    }
    return out.sort((a, b) => a.label.localeCompare(b.label))
  }, [projects])

  const pickContact = (key: string) => {
    const c = contacts.find((x) => x.key === key)
    if (!c) return
    setContactName(c.name)
    setContactEmail(c.email)
    setContactPhone(c.phone)
  }

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
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-faint">Contact (optional)</span>
                  {contacts.length > 0 && (
                    <div className="relative">
                      <select
                        value=""
                        onChange={(e) => {
                          if (e.target.value) pickContact(e.target.value)
                          e.currentTarget.selectedIndex = 0
                        }}
                        className="input cursor-pointer py-1 pr-7 text-[11.5px]"
                      >
                        <option value="">Use existing…</option>
                        {contacts.map((c) => (
                          <option key={c.key} value={c.key}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
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
