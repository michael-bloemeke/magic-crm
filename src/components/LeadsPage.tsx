import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  LEAD_SOURCES,
  LEAD_SOURCE_LABELS,
  addLead,
  archiveLead,
  convertLead,
  loadLeads,
  updateLead,
  type Lead,
  type LeadSource,
} from '../api'

// LEADS: enquiries that have not entered the pipeline yet.
//
// The pipeline is work Michael is actually doing. A GigSalad enquiry he has not replied to is not
// that, and letting those in would make every pipeline count meaningless. So they live here until
// one of two things happens, and NEITHER throws anything away:
//
//   Move to pipeline -> collect what a project needs, create it, stamp the lead
//   Clear            -> offer to save the person to Contacts first, then stamp the lead
//
// The "offer to save" is the point of the whole page. Michael, 2026-08-07: "i do want to save the
// contact information of all these leads even if they never get on the phone so that I can add them
// to my mailing list and out reach."

const SOURCE_ACCENT: Record<LeadSource, string> = {
  gigsalad: 'var(--color-umb-postcall)',
  'the-bash': 'var(--color-umb-booked)',
  bark: 'var(--color-umb-archive)',
  other: 'var(--color-umb-inquiry)',
}

const todayISO = () => new Date().toISOString().slice(0, 10)

function prettyDate(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return ''
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

// How long it has been sitting. A marketplace enquiry goes cold fast, so age is the most useful
// thing the card can tell you at a glance.
function ageLabel(iso: string): { text: string; stale: boolean } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null
  const [y, m, d] = iso.split('-').map(Number)
  const then = new Date(y, m - 1, d)
  const days = Math.floor((Date.now() - then.getTime()) / 86400000)
  if (days < 0) return null
  if (days === 0) return { text: 'Today', stale: false }
  if (days === 1) return { text: 'Yesterday', stale: false }
  return { text: `${days} days ago`, stale: days >= 7 }
}

const inputCls =
  'w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-[13.5px] text-parchment placeholder:text-faint focus:border-brass focus:outline-none'
const labelCls = 'mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-faint'

export function LeadsPage({ onConverted }: { onConverted: () => void }) {
  const [leads, setLeads] = useState<Lead[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)
  const [convertTarget, setConvertTarget] = useState<Lead | null>(null)
  const [clearTarget, setClearTarget] = useState<Lead | null>(null)
  const [query, setQuery] = useState('')

  const refresh = () =>
    loadLeads()
      .then((l) => {
        setLeads(l)
        setError('')
      })
      .catch((e) => setError(e?.message || 'Could not load leads.'))
      .finally(() => setLoading(false))

  useEffect(() => {
    void refresh()
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return leads
    return leads.filter((l) =>
      [l.title, l.name, l.email, l.phone, l.notes].join(' ').toLowerCase().includes(q),
    )
  }, [leads, query])

  // Grouped by source, in a fixed order so the page does not reshuffle as leads come and go.
  const groups = useMemo(
    () => LEAD_SOURCES.map((s) => ({ source: s, items: filtered.filter((l) => l.source === s) })),
    [filtered],
  )

  const followUpsDue = useMemo(
    () => leads.filter((l) => l.followUpDate && l.followUpDate <= todayISO()).length,
    [leads],
  )

  const patch = async (id: string, p: Partial<Lead>) => {
    const saved = await updateLead(id, p)
    setLeads((prev) => prev.map((l) => (l.id === saved.id ? saved : l)))
  }

  return (
    <div className="board-scroll flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[1180px] px-8 py-8">
        <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-[30px] leading-tight text-parchment">Leads</h1>
            <p className="mt-1 text-[13px] text-muted">
              Enquiries you have not worked yet. Nothing here counts as pipeline until you move it.
              {followUpsDue > 0 && (
                <span className="ml-2 font-semibold text-[#b45309]">
                  {followUpsDue} follow-up{followUpsDue === 1 ? '' : 's'} due.
                </span>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search leads…"
              className="w-56 rounded-lg border border-line bg-surface px-3 py-2 text-[13px] text-parchment placeholder:text-faint focus:border-brass focus:outline-none"
            />
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="rounded-lg bg-brass px-4 py-2 text-[13px] font-semibold text-white transition-all hover:brightness-110"
            >
              New lead
            </button>
          </div>
        </header>

        {error && (
          <p className="mb-5 rounded-lg border border-[#dc2626]/40 bg-[#dc2626]/8 px-4 py-3 text-[13px] text-[#dc2626]">
            {error}
          </p>
        )}

        {loading ? (
          <p className="px-1 py-16 text-center text-[13px] text-faint">Loading…</p>
        ) : leads.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-line px-6 py-20 text-center">
            <p className="text-[14px] text-muted">No leads yet.</p>
            <p className="mx-auto mt-2 max-w-[440px] text-[12.5px] leading-relaxed text-faint">
              Add the enquiries that come in from GigSalad, The Bash and Bark here. They stay out of
              the pipeline until you have actually made contact.
            </p>
          </div>
        ) : (
          groups.map(({ source, items }) =>
            items.length === 0 ? null : (
              <section key={source} className="mb-9">
                <div className="mb-3 flex items-center gap-2.5">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: SOURCE_ACCENT[source] }} />
                  <h2 className="text-[11px] font-bold uppercase tracking-[0.16em] text-faint">
                    {LEAD_SOURCE_LABELS[source]}
                  </h2>
                  <span className="text-[11px] tabular-nums text-faint">{items.length}</span>
                </div>
                <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                  {items.map((lead) => (
                    <LeadCard
                      key={lead.id}
                      lead={lead}
                      onPatch={(p) => patch(lead.id, p)}
                      onConvert={() => setConvertTarget(lead)}
                      onClear={() => setClearTarget(lead)}
                    />
                  ))}
                </div>
              </section>
            ),
          )
        )}
        {!loading && leads.length > 0 && filtered.length === 0 && (
          <p className="px-1 py-16 text-center text-[13px] text-faint">No leads match “{query}”.</p>
        )}
      </div>

      <NewLeadModal
        open={adding}
        onClose={() => setAdding(false)}
        onCreate={async (input) => {
          const lead = await addLead(input)
          setLeads((prev) => [lead, ...prev])
          setAdding(false)
        }}
      />

      <ConvertModal
        lead={convertTarget}
        onClose={() => setConvertTarget(null)}
        onDone={(id) => {
          setLeads((prev) => prev.filter((l) => l.id !== id))
          setConvertTarget(null)
          onConverted()
        }}
      />

      <ClearModal
        lead={clearTarget}
        onClose={() => setClearTarget(null)}
        onDone={(id) => {
          setLeads((prev) => prev.filter((l) => l.id !== id))
          setClearTarget(null)
        }}
      />
    </div>
  )
}

// Defined at module scope on purpose. Declaring this inside LeadCard makes React see a NEW component
// type on every parent render, which unmounts the input and takes the caret with it: you lose focus
// mid-word the moment anything upstream re-renders.
function LeadField({
  value,
  placeholder,
  multiline,
  type,
  onCommit,
}: {
  value: string
  placeholder: string
  multiline?: boolean
  type?: string
  onCommit: (next: string) => void
}) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  const commit = () => {
    if (v.trim() === (value ?? '').trim()) return
    onCommit(v.trim())
  }
  const cls =
    'w-full rounded-md border border-transparent bg-transparent px-2 py-1 text-[13.5px] text-parchment transition-colors placeholder:text-faint/70 hover:bg-surface-2 focus:border-line-strong focus:bg-surface-2 focus:outline-none'
  return multiline ? (
    <textarea
      value={v}
      rows={2}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      placeholder={placeholder}
      className={`${cls} resize-none`}
    />
  ) : (
    <input
      type={type || 'text'}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      placeholder={placeholder}
      className={cls}
    />
  )
}

// A card big enough to hold the whole lead, because the point of this page is reading and acting on
// one without opening anything. Every field edits in place and saves on blur.
function LeadCard({
  lead,
  onPatch,
  onConvert,
  onClear,
}: {
  lead: Lead
  onPatch: (p: Partial<Lead>) => Promise<void>
  onConvert: () => void
  onClear: () => void
}) {
  const age = ageLabel(lead.leadDate)
  const followUpDue = !!lead.followUpDate && lead.followUpDate <= todayISO()

  return (
    <article className="flex flex-col rounded-2xl border border-line bg-surface p-5 shadow-[0_2px_8px_-4px_rgba(0,0,0,0.10)]">
      <div className="mb-1 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <LeadField value={lead.title} placeholder="What is it? (untitled lead)" onCommit={(v) => void onPatch({ title: v })} />
        </div>
        <select
          value={lead.source}
          onChange={(e) => void onPatch({ source: e.target.value as LeadSource })}
          className="shrink-0 cursor-pointer rounded-full border px-2.5 py-1 text-[10.5px] font-bold uppercase tracking-[0.08em] focus:outline-none"
          style={{ color: SOURCE_ACCENT[lead.source], borderColor: SOURCE_ACCENT[lead.source] }}
        >
          {LEAD_SOURCES.map((s) => (
            <option key={s} value={s} style={{ color: 'var(--color-parchment)' }}>
              {LEAD_SOURCE_LABELS[s]}
            </option>
          ))}
        </select>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 px-2 text-[11.5px] text-faint">
        <span>Lead date {prettyDate(lead.leadDate) || 'not set'}</span>
        {age && <span className={age.stale ? 'font-semibold text-[#b45309]' : ''}>· {age.text}</span>}
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div>
          <span className={labelCls}>Name</span>
          <LeadField value={lead.name} placeholder="Who got in touch" onCommit={(v) => void onPatch({ name: v })} />
        </div>
        <div>
          <span className={labelCls}>Phone</span>
          <LeadField value={lead.phone} placeholder="Phone" onCommit={(v) => void onPatch({ phone: v })} />
        </div>
        <div className="sm:col-span-2">
          <span className={labelCls}>Email</span>
          <LeadField value={lead.email} placeholder="Email" onCommit={(v) => void onPatch({ email: v })} />
        </div>
      </div>

      <div className="mt-2">
        <span className={labelCls}>Notes</span>
        <LeadField value={lead.notes} placeholder="What they asked for, what you owe them…" onCommit={(v) => void onPatch({ notes: v })} multiline />
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2">
        <div>
          <span className={labelCls}>Lead date</span>
          <LeadField value={lead.leadDate} placeholder="" onCommit={(v) => void onPatch({ leadDate: v })} type="date" />
        </div>
        <div>
          <span className={[labelCls, followUpDue ? 'text-[#b45309]' : ''].join(' ')}>
            Follow up{followUpDue ? ' · due' : ''}
          </span>
          <LeadField value={lead.followUpDate} placeholder="" onCommit={(v) => void onPatch({ followUpDate: v })} type="date" />
        </div>
      </div>

      <div className="mt-4 flex items-center gap-2 border-t border-line pt-4">
        <button
          type="button"
          onClick={onConvert}
          className="flex-1 rounded-lg bg-brass px-3 py-2 text-[12.5px] font-semibold text-white transition-all hover:brightness-110"
        >
          Move to pipeline
        </button>
        <button
          type="button"
          onClick={onClear}
          className="rounded-lg border border-line px-3 py-2 text-[12.5px] font-medium text-muted transition-colors hover:border-[#dc2626]/50 hover:text-[#dc2626]"
        >
          Clear
        </button>
      </div>
    </article>
  )
}

function Modal({
  open,
  onClose,
  title,
  children,
  wide,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
  wide?: boolean
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[80] flex justify-center overflow-y-auto px-4 py-[8vh]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
          <motion.div
            initial={{ opacity: 0, y: -10, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.985 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className={[
              'relative z-10 h-fit w-full rounded-2xl border border-line-strong bg-surface shadow-[0_40px_80px_-30px_rgba(0,0,0,0.25)]',
              wide ? 'max-w-[620px]' : 'max-w-[460px]',
            ].join(' ')}
          >
            <div className="border-b border-line px-5 py-4">
              <p className="text-[15px] font-semibold text-parchment">{title}</p>
            </div>
            <div className="p-5">{children}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function NewLeadModal({
  open,
  onClose,
  onCreate,
}: {
  open: boolean
  onClose: () => void
  onCreate: (input: Partial<Lead>) => Promise<void>
}) {
  const [f, setF] = useState<Partial<Lead>>({ source: 'gigsalad', leadDate: todayISO() })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => {
    if (open) {
      setF({ source: 'gigsalad', leadDate: todayISO() })
      setErr('')
    }
  }, [open])

  const set = (k: keyof Lead) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setF((p) => ({ ...p, [k]: e.target.value }))

  const submit = async () => {
    // Deliberately lenient: a lead often arrives as nothing but a name, and refusing to save it
    // would send Michael back to the marketplace tab to re-read it.
    if (!String(f.title || '').trim() && !String(f.name || '').trim()) {
      setErr('Give it a title or a name, so you can tell it apart later.')
      return
    }
    setBusy(true)
    try {
      await onCreate(f)
    } catch (e) {
      setErr((e as Error)?.message || 'Could not save.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="New lead" wide>
      <div className="space-y-3">
        <div>
          <span className={labelCls}>Title</span>
          <input value={f.title || ''} onChange={set('title')} placeholder="Wedding cocktail hour, Sept" className={inputCls} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <span className={labelCls}>Source</span>
            <select value={f.source} onChange={set('source')} className={inputCls}>
              {LEAD_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {LEAD_SOURCE_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <span className={labelCls}>Lead date</span>
            <input type="date" value={f.leadDate || ''} onChange={set('leadDate')} className={inputCls} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <span className={labelCls}>Name</span>
            <input value={f.name || ''} onChange={set('name')} placeholder="Full name" className={inputCls} />
          </div>
          <div>
            <span className={labelCls}>Phone</span>
            <input value={f.phone || ''} onChange={set('phone')} placeholder="(919) 555-1234" className={inputCls} />
          </div>
        </div>
        <div>
          <span className={labelCls}>Email</span>
          <input value={f.email || ''} onChange={set('email')} placeholder="name@email.com" className={inputCls} />
        </div>
        <div>
          <span className={labelCls}>Follow up on (optional)</span>
          <input type="date" value={f.followUpDate || ''} onChange={set('followUpDate')} className={inputCls} />
        </div>
        <div>
          <span className={labelCls}>Notes</span>
          <textarea value={f.notes || ''} onChange={set('notes')} rows={3} placeholder="What they asked for" className={inputCls} />
        </div>
        {err && <p className="text-[12.5px] text-[#dc2626]">{err}</p>}
        <div className="flex items-center justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="rounded-lg border border-line px-3.5 py-2 text-[12.5px] text-muted hover:text-parchment">
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="rounded-lg bg-brass px-4 py-2 text-[12.5px] font-semibold text-white hover:brightness-110 disabled:opacity-40"
          >
            {busy ? 'Saving…' : 'Add lead'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

// Moving to the pipeline is where a lead turns into a real project, so this is the moment to collect
// the things a project needs and a marketplace enquiry never has. Only the name is required; the
// rest can be filled in later, and leaving them blank shows up red in Event details.
function ConvertModal({
  lead,
  onClose,
  onDone,
}: {
  lead: Lead | null
  onClose: () => void
  onDone: (id: string) => void
}) {
  const [f, setF] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!lead) return
    setF({
      clientName: lead.title || lead.name,
      name: lead.name,
      email: lead.email,
      phone: lead.phone,
      notes: lead.notes,
      eventType: '',
      eventDate: '',
      eventLocation: '',
      totalFee: '',
    })
    setErr('')
  }, [lead])

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setF((p) => ({ ...p, [k]: e.target.value }))

  const submit = async () => {
    if (!lead) return
    if (!String(f.clientName || '').trim()) {
      setErr('A project name is required.')
      return
    }
    setBusy(true)
    try {
      await convertLead(lead.id, f as never)
      onDone(lead.id)
    } catch (e) {
      setErr((e as Error)?.message || 'Could not move this lead.')
      setBusy(false)
    }
  }

  return (
    <Modal open={!!lead} onClose={onClose} title="Move to pipeline" wide>
      <p className="mb-4 text-[12.5px] leading-relaxed text-muted">
        This creates a real project in Inquiry and saves {f.name?.trim() || 'this person'} to Contacts,
        linked to it. The lead leaves this page but is kept on record. Anything you skip can be filled
        in later on the project.
      </p>
      <div className="space-y-3">
        <div>
          <span className={labelCls}>Project name *</span>
          <input value={f.clientName || ''} onChange={set('clientName')} className={inputCls} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <span className={labelCls}>Event type</span>
            <select value={f.eventType || ''} onChange={set('eventType')} className={inputCls}>
              <option value="">Not set</option>
              {['Wedding', 'Corporate', 'Private Event', 'Bachelorette', 'Other'].map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div>
            <span className={labelCls}>Event date</span>
            <input type="date" value={f.eventDate || ''} onChange={set('eventDate')} className={inputCls} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <span className={labelCls}>Location</span>
            <input value={f.eventLocation || ''} onChange={set('eventLocation')} className={inputCls} />
          </div>
          <div>
            <span className={labelCls}>Quote</span>
            <input value={f.totalFee || ''} onChange={set('totalFee')} placeholder="1500" className={inputCls} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <span className={labelCls}>Contact name</span>
            <input value={f.name || ''} onChange={set('name')} className={inputCls} />
          </div>
          <div>
            <span className={labelCls}>Contact phone</span>
            <input value={f.phone || ''} onChange={set('phone')} className={inputCls} />
          </div>
        </div>
        <div>
          <span className={labelCls}>Contact email</span>
          <input value={f.email || ''} onChange={set('email')} className={inputCls} />
        </div>
        <div>
          <span className={labelCls}>Notes</span>
          <textarea value={f.notes || ''} onChange={set('notes')} rows={3} className={inputCls} />
        </div>
        {err && <p className="text-[12.5px] text-[#dc2626]">{err}</p>}
        <div className="flex items-center justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="rounded-lg border border-line px-3.5 py-2 text-[12.5px] text-muted hover:text-parchment">
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="rounded-lg bg-brass px-4 py-2 text-[12.5px] font-semibold text-white hover:brightness-110 disabled:opacity-40"
          >
            {busy ? 'Moving…' : 'Create project'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

// Clearing a lead is the branch that matters for outreach: the booking died, the contact details did
// not. Keeping them is the default, and the button says exactly what it will do.
function ClearModal({
  lead,
  onClose,
  onDone,
}: {
  lead: Lead | null
  onClose: () => void
  onDone: (id: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [result, setResult] = useState<string>('')
  useEffect(() => {
    setErr('')
    setResult('')
  }, [lead])

  const go = async (keep: boolean) => {
    if (!lead) return
    setBusy(true)
    try {
      const r = await archiveLead(lead.id, keep)
      if (keep && r.contact) setResult(r.reused ? 'Already in Contacts, so nothing was duplicated.' : 'Saved to Contacts.')
      onDone(lead.id)
    } catch (e) {
      setErr((e as Error)?.message || 'Could not clear this lead.')
      setBusy(false)
    }
  }

  const hasPerson = !!lead && !!lead.name.trim()
  return (
    <Modal open={!!lead} onClose={onClose} title="Clear this lead?">
      <p className="text-[13px] leading-relaxed text-muted">
        {lead?.title?.trim() || lead?.name?.trim() || 'This lead'} comes off the board. It is kept on
        record either way, so nothing is destroyed.
      </p>
      {hasPerson ? (
        <p className="mt-3 rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-[12.5px] leading-relaxed text-muted">
          Save <span className="font-semibold text-parchment">{lead?.name}</span> to Contacts first, so
          they can go on your mailing list? If that email is already on a contact, it will be reused
          rather than duplicated.
        </p>
      ) : (
        <p className="mt-3 text-[12.5px] text-faint">This lead has no name, so there is nobody to save.</p>
      )}
      {err && <p className="mt-3 text-[12.5px] text-[#dc2626]">{err}</p>}
      {result && <p className="mt-3 text-[12.5px] text-[#15803d]">{result}</p>}
      <div className="mt-5 flex items-center justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded-lg border border-line px-3.5 py-2 text-[12.5px] text-muted hover:text-parchment">
          Cancel
        </button>
        <button
          type="button"
          onClick={() => go(false)}
          disabled={busy}
          className="rounded-lg border border-line px-3.5 py-2 text-[12.5px] font-medium text-muted transition-colors hover:border-[#dc2626]/50 hover:text-[#dc2626] disabled:opacity-40"
        >
          Clear without saving
        </button>
        {hasPerson && (
          <button
            type="button"
            onClick={() => go(true)}
            disabled={busy}
            className="rounded-lg bg-brass px-4 py-2 text-[12.5px] font-semibold text-white hover:brightness-110 disabled:opacity-40"
          >
            {busy ? 'Working…' : 'Save contact and clear'}
          </button>
        )}
      </div>
    </Modal>
  )
}
