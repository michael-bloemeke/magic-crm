import { useEffect, useMemo, useState } from 'react'
import { motion } from 'motion/react'
import type { Project } from '../pipeline'
import {
  addContact as apiAdd,
  deleteContact as apiDelete,
  loadConfig,
  loadContacts,
  loadLinks,
  saveConfig,
  updateContact as apiUpdate,
  type Contact,
  type ContactType,
  type ProjectLinks,
  type Relationship,
} from '../api'
import { linkedProjectsFor, REL_COLOR, REL_FILTER_VALUES } from '../contacts'
import { phoneDigits } from '../phone'
import { ContactDetail } from './ContactDetail'

// First-class contacts: searchable + filterable list; click a row for the side panel.

const TYPE_FILTERS: (ContactType | 'all')[] = ['all', 'client', 'vendor', 'associate', 'other']

type Props = {
  projects: Project[]
  onOpenProject: (id: string) => void
  // When set (e.g. from the global search), open that contact's panel.
  openContactId?: string | null
  onContactOpened?: () => void
}

export function ContactsPage({ projects, onOpenProject, openContactId, onContactOpened }: Props) {
  const [contacts, setContacts] = useState<Contact[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<ContactType | 'all'>('all')
  const [relFilter, setRelFilter] = useState<Relationship | 'all'>('all')
  const [tagLibrary, setTagLibrary] = useState<string[]>([])
  const [links, setLinks] = useState<ProjectLinks>({})

  useEffect(() => {
    loadContacts()
      .then(setContacts)
      .catch(() => setContacts([]))
    loadLinks()
      .then(setLinks)
      .catch(() => {})
    loadConfig()
      .then((c) => setTagLibrary(c.contactTags ?? []))
      .catch(() => {})
  }, [])

  const list = contacts ?? []
  // Reusable tag suggestions = the saved library plus every tag already in use.
  const knownTags = useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const t of [...tagLibrary, ...list.flatMap((c) => c.tags)]) {
      const s = t.trim()
      if (!s || seen.has(s.toLowerCase())) continue
      seen.add(s.toLowerCase())
      out.push(s)
    }
    return out
  }, [tagLibrary, list])
  const registerTag = (tag: string) => {
    setTagLibrary((prev) => (prev.some((t) => t.toLowerCase() === tag.toLowerCase()) ? prev : [...prev, tag]))
    saveConfig({ contactTags: [...tagLibrary, tag] }).catch(() => {})
  }

  // Open a contact requested from outside (e.g. the global search palette).
  useEffect(() => {
    if (openContactId) {
      setSelectedId(openContactId)
      onContactOpened?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openContactId])
  const counts = useMemo(() => {
    const byCount: Record<string, number> = {}
    for (const c of list) byCount[c.id] = linkedProjectsFor(c, projects, links).length
    return byCount
  }, [list, projects, links])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return list
      .filter((c) => (typeFilter === 'all' ? true : c.type === typeFilter))
      .filter((c) => (relFilter === 'all' ? true : c.relationship === relFilter))
      .filter((c) => {
        if (!q) return true
        const hay = [c.name, c.emails.join(' '), c.phones.join(' '), c.notes, c.tags.join(' ')].join(' ').toLowerCase()
        if (hay.includes(q)) return true
        // Phone: match any digit substring, ignoring formatting.
        const qd = phoneDigits(query)
        if (qd.length >= 3 && phoneDigits(c.phones.join(' ')).includes(qd)) return true
        return false
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [list, query, typeFilter, relFilter])

  const selected = list.find((c) => c.id === selectedId) ?? null

  const patch = (id: string, p: Partial<Contact>) => {
    setContacts((prev) => (prev ? prev.map((c) => (c.id === id ? { ...c, ...p } : c)) : prev))
    apiUpdate({ id, ...p }).catch(() => loadContacts().then(setContacts).catch(() => {}))
  }
  const removeContact = (id: string) => {
    setContacts((prev) => (prev ? prev.filter((c) => c.id !== id) : prev))
    setSelectedId(null)
    apiDelete(id).catch(() => {})
  }
  const newContact = async () => {
    const c = await apiAdd({ name: 'New contact', type: 'client' })
    setContacts((prev) => [...(prev ?? []), c])
    setSelectedId(c.id)
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.35 }}
      className="board-scroll h-full overflow-y-auto px-8 pb-12"
    >
      {/* Toolbar */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative">
          <svg viewBox="0 0 24 24" className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search contacts…"
            className="w-64 rounded-lg border border-line bg-surface-2 py-2 pl-8 pr-3 text-[13px] text-parchment placeholder:text-faint focus:border-brass-dim focus:outline-none"
          />
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={newContact}
            className="rounded-lg border border-brass-dim/60 bg-gradient-to-b from-surface-3 to-surface px-3 py-2 text-[12.5px] font-semibold text-brass-bright transition-all hover:border-brass"
          >
            + New contact
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {TYPE_FILTERS.map((t) => (
          <Chip key={t} active={typeFilter === t} label={t === 'all' ? 'All types' : t} onClick={() => setTypeFilter(t)} />
        ))}
        <span className="mx-1 h-4 w-px bg-line" />
        {REL_FILTER_VALUES.map((r) => (
          <Chip
            key={r}
            active={relFilter === r}
            label={r === 'all' ? 'All relationships' : r}
            color={r !== 'all' ? REL_COLOR[r] : undefined}
            onClick={() => setRelFilter(r)}
          />
        ))}
      </div>

      {!contacts ? (
        <p className="animate-pulse text-[13px] text-faint">Loading contacts…</p>
      ) : list.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line px-4 py-16 text-center">
          <p className="text-[13px] text-muted">No contacts yet.</p>
          <p className="mt-1 text-[12px] text-faint">
            Contacts are created automatically from your projects. Add a new project and its contact shows up here, or
            add someone manually.
          </p>
          <button
            type="button"
            onClick={newContact}
            className="mt-4 rounded-lg border border-brass-dim/60 bg-surface-3 px-4 py-2 text-[12.5px] font-semibold text-brass-bright transition-colors hover:border-brass"
          >
            + New contact
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-4 py-10 text-center text-[12.5px] text-faint">
          No contacts match these filters.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {filtered.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setSelectedId(c.id)}
              className="flex items-center gap-3 rounded-xl border border-line bg-surface-2/60 px-4 py-2.5 text-left transition-colors hover:border-line-strong hover:bg-surface-3/70"
            >
              {c.relationship ? (
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: REL_COLOR[c.relationship] }} title={`Relationship: ${c.relationship}`} />
              ) : (
                <span className="h-2 w-2 shrink-0 rounded-full border border-line" title="No relationship set" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[14px] text-parchment">{c.name}</span>
                  <span className="shrink-0 rounded-full border border-line px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-faint">
                    {c.type}
                  </span>
                  {c.tags.slice(0, 2).map((t) => (
                    <span key={t} className="hidden shrink-0 rounded-full bg-surface-3 px-1.5 py-0.5 text-[9.5px] text-muted sm:inline">
                      {t}
                    </span>
                  ))}
                </div>
                <p className="mt-0.5 truncate text-[11.5px] text-faint">{c.emails[0] || c.phones[0] || 'No contact info'}</p>
              </div>
              {counts[c.id] > 0 && (
                <span className="shrink-0 text-[11px] tabular-nums text-muted">
                  {counts[c.id]} {counts[c.id] === 1 ? 'project' : 'projects'}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      <ContactDetail
        contact={selected}
        linkedProjects={selected ? linkedProjectsFor(selected, projects, links) : []}
        knownTags={knownTags}
        onNewTag={registerTag}
        onChange={(p) => selected && patch(selected.id, p)}
        onDelete={() => selected && removeContact(selected.id)}
        onClose={() => setSelectedId(null)}
        onOpenProject={(id) => {
          setSelectedId(null)
          onOpenProject(id)
        }}
      />
    </motion.div>
  )
}

function Chip({ active, label, color, onClick }: { active: boolean; label: string; color?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11.5px] font-medium capitalize transition-colors',
        active ? 'border-brass-dim bg-surface-3 text-brass-bright' : 'border-line bg-surface-2/60 text-muted hover:border-line-strong hover:text-parchment',
      ].join(' ')}
    >
      {color && <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />}
      {label}
    </button>
  )
}
