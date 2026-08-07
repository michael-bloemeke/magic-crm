import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { EVENT_TYPE_ACCENT, formatEventDate, type CategoryDef, type Project } from '../pipeline'
import type { Contact } from '../api'
import { REL_COLOR } from '../contacts'

type Props = {
  projects: Project[]
  contacts: Contact[]
  categories: CategoryDef[]
  open: boolean
  onClose: () => void
  onOpen: (project: Project) => void
  onOpenContact: (contact: Contact) => void
}

type Result = { type: 'project'; item: Project } | { type: 'contact'; item: Contact }

const digits = (s: string) => s.replace(/\D/g, '')

function projectHaystack(p: Project): string {
  return [
    p.client,
    p.contactNames,
    p.contactEmails,
    p.contactPhones,
    p.eventLocation,
    p.venueType,
    p.eventType,
    p.eventDate,
    p.performanceStyle,
    p.vips,
    p.bookingSource,
    p.eventDescription,
    p.projectNotes,
  ]
    .join(' ')
    .toLowerCase()
}

export function SearchPalette({ projects, contacts, categories, open, onClose, onOpen, onOpenContact }: Props) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const stageNames = useMemo<Record<string, string>>(
    () => Object.fromEntries(categories.flatMap((u) => u.stages.map((s) => [s.id, s.name]))),
    [categories],
  )

  useEffect(() => {
    if (open) {
      setQuery('')
      setActive(0)
      setTimeout(() => inputRef.current?.focus(), 20)
    }
  }, [open])

  const results = useMemo<Result[]>(() => {
    const q = query.trim().toLowerCase()
    if (!q) {
      // Default: a few projects, alphabetical.
      return projects
        .slice()
        .sort((a, b) => a.client.localeCompare(b.client))
        .slice(0, 8)
        .map((p) => ({ type: 'project', item: p }) as Result)
    }
    const qd = digits(q)

    const matchedProjects = projects
      .filter((p) => {
        if (projectHaystack(p).includes(q)) return true
        if (qd.length >= 3 && digits(p.contactPhones).includes(qd)) return true
        return false
      })
      .sort((a, b) => {
        const an = a.client.toLowerCase().includes(q) ? 0 : 1
        const bn = b.client.toLowerCase().includes(q) ? 0 : 1
        if (an !== bn) return an - bn
        return a.client.localeCompare(b.client)
      })
      .slice(0, 30)

    const matchedContacts = contacts
      .filter((c) => {
        const hay = [c.name, c.emails.join(' '), c.notes, c.tags.join(' ')].join(' ').toLowerCase()
        if (hay.includes(q)) return true
        if (qd.length >= 3 && digits(c.phones.join(' ')).includes(qd)) return true
        return false
      })
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 20)

    return [
      ...matchedProjects.map((p) => ({ type: 'project', item: p }) as Result),
      ...matchedContacts.map((c) => ({ type: 'contact', item: c }) as Result),
    ]
  }, [query, projects, contacts])

  useEffect(() => {
    setActive(0)
  }, [query])

  const openResult = (r: Result) => {
    if (r.type === 'project') onOpen(r.item)
    else onOpenContact(r.item)
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActive((i) => Math.min(i + 1, results.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const r = results[active]
        if (r) openResult(r)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, results, active, onClose])

  // Keep the active row in view.
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${active}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const firstContactIdx = results.findIndex((r) => r.type === 'contact')

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[60] flex justify-center px-4 pt-[12vh]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          <div className="absolute inset-0 bg-black/55 backdrop-blur-[2px]" onClick={onClose} aria-hidden />

          <motion.div
            initial={{ opacity: 0, y: -12, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -12, scale: 0.985 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className="relative z-10 flex max-h-[70vh] w-[640px] max-w-[92vw] flex-col overflow-hidden rounded-2xl border border-line-strong bg-surface shadow-[0_40px_80px_-30px_rgba(0,0,0,0.18)]"
          >
            {/* Input */}
            <div className="flex items-center gap-3 border-b border-line px-4">
              <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-faint" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="7" />
                <path d="M21 21l-4.3-4.3" />
              </svg>
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search projects + contacts by name, email, phone, location…"
                className="w-full bg-transparent py-4 text-[15px] text-parchment placeholder:text-faint focus:outline-none"
              />
              <kbd className="shrink-0 rounded border border-line px-1.5 py-0.5 text-[10px] text-faint">esc</kbd>
            </div>

            {/* Results */}
            <div ref={listRef} className="board-scroll min-h-0 flex-1 overflow-y-auto p-2">
              {results.length === 0 ? (
                <p className="px-3 py-10 text-center text-[13px] text-faint">No matches for "{query}".</p>
              ) : (
                results.map((r, i) =>
                  r.type === 'project' ? (
                    <ProjectResult
                      key={`p-${r.item.id}`}
                      p={r.item}
                      idx={i}
                      active={i === active}
                      stageName={stageNames[r.item.stageId] ?? ''}
                      onHover={() => setActive(i)}
                      onClick={() => onOpen(r.item)}
                    />
                  ) : (
                    <ContactResult
                      key={`c-${r.item.id}`}
                      c={r.item}
                      idx={i}
                      active={i === active}
                      showHeader={i === firstContactIdx}
                      onHover={() => setActive(i)}
                      onClick={() => onOpenContact(r.item)}
                    />
                  ),
                )
              )}
            </div>

            <div className="flex items-center gap-4 border-t border-line px-4 py-2 text-[10.5px] text-faint">
              <span><span className="text-muted">↑↓</span> navigate</span>
              <span><span className="text-muted">↵</span> open</span>
              <span><span className="text-muted">esc</span> close</span>
              <span className="ml-auto">{results.length} result{results.length === 1 ? '' : 's'}</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function ProjectResult({
  p,
  idx,
  active,
  stageName,
  onHover,
  onClick,
}: {
  p: Project
  idx: number
  active: boolean
  stageName: string
  onHover: () => void
  onClick: () => void
}) {
  const typeColor = EVENT_TYPE_ACCENT[p.eventType]
  const contact = (p.contactEmails || p.contactPhones || '').split(/[,;]/)[0].trim()
  return (
    <button
      data-idx={idx}
      type="button"
      onMouseEnter={onHover}
      onClick={onClick}
      className={[
        'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors',
        active ? 'bg-surface-3' : 'hover:bg-surface-2',
      ].join(' ')}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-display text-[15px] text-parchment">{p.client}</span>
          <span
            className="shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em]"
            style={{ color: typeColor, backgroundColor: `color-mix(in oklab, ${typeColor} 14%, transparent)` }}
          >
            {p.eventType}
          </span>
        </div>
        {contact && <p className="mt-0.5 truncate text-[11.5px] text-faint">{contact}</p>}
      </div>
      <div className="shrink-0 text-right text-[11px]">
        <p className="text-muted">{stageName}</p>
        <p className="tabular-nums text-faint">{formatEventDate(p.eventDate)}</p>
      </div>
    </button>
  )
}

function ContactResult({
  c,
  idx,
  active,
  showHeader,
  onHover,
  onClick,
}: {
  c: Contact
  idx: number
  active: boolean
  showHeader: boolean
  onHover: () => void
  onClick: () => void
}) {
  const dot = c.relationship ? REL_COLOR[c.relationship] : undefined
  return (
    <>
      {showHeader && (
        <p className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-faint">Contacts</p>
      )}
      <button
        data-idx={idx}
        type="button"
        onMouseEnter={onHover}
        onClick={onClick}
        className={[
          'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors',
          active ? 'bg-surface-3' : 'hover:bg-surface-2',
        ].join(' ')}
      >
        {dot ? (
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: dot }} />
        ) : (
          <span className="h-2 w-2 shrink-0 rounded-full border border-line" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[14px] text-parchment">{c.name}</span>
            <span className="shrink-0 rounded-full border border-line px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-faint">
              {c.type}
            </span>
          </div>
          <p className="mt-0.5 truncate text-[11.5px] text-faint">{c.emails[0] || c.phones[0] || 'No contact info'}</p>
        </div>
        <span className="shrink-0 text-[10px] uppercase tracking-[0.12em] text-faint">Contact</span>
      </button>
    </>
  )
}
