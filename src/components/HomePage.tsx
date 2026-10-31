import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { byEventDateAsc, formatEventDate, todayISO, type Project } from '../pipeline'
import {
  loadFinance,
  loadHomeList,
  addHomeListItem,
  deleteHomeListItem,
  renameHomeListItem,
  saveHomeListLayout,
  type FinanceSummary,
  type HomeListItem,
  type Task,
} from '../api'
import {
  MAX_DEPTH,
  blockEnd,
  canIndent,
  canMoveDown,
  canMoveUp,
  canOutdent,
  indent,
  insertAfter,
  layoutChanges,
  moveDown,
  moveUp,
  normalize,
  outdent,
  removeItem,
  rename,
  sortItems,
  withPositions,
} from '../../mobile/homelist-core.js'
import type { Page } from './Sidebar'
import { TaskRow } from './TaskRow'
import { ProjectRow } from './ProjectRow'
import { UnreadMailModal } from './UnreadMailModal'

const money = (n: number) => '$' + Math.round(n || 0).toLocaleString('en-US')

type Props = {
  projects: Project[]
  tasks: Task[]
  unread: Record<string, number>
  onToggleTask: (id: string, done: boolean) => void
  onDeleteTask: (id: string) => void
  onOpenFull: (p: Project) => void
  onOpenSide: (p: Project) => void
  onOpenProjectById: (id: string) => void
  onThreadRead: (projectId: string, count: number) => void
  onNavigate: (page: Page) => void
}

export function HomePage({
  projects,
  tasks,
  unread,
  onToggleTask,
  onDeleteTask,
  onOpenFull,
  onOpenSide,
  onOpenProjectById,
  onThreadRead,
  onNavigate,
}: Props) {
  const [fin, setFin] = useState<FinanceSummary | null>(null)
  const [mailOpen, setMailOpen] = useState(false)

  useEffect(() => {
    loadFinance()
      .then(setFin)
      .catch(() => setFin(null))
  }, [])

  const today = todayISO()
  const in7 = useMemo(() => {
    const d = new Date()
    d.setDate(d.getDate() + 7)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }, [])

  const byId = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects])

  const overdue = tasks.filter((t) => !t.done && t.dueDate && t.dueDate < today)
  const dueToday = tasks.filter((t) => !t.done && t.dueDate === today)
  const needsAttention = [...overdue, ...dueToday].sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || ''))

  const upcoming = useMemo(
    () =>
      projects
        .filter((p) => p.bucket === 'active' && p.eventDate && p.eventDate >= today && p.eventDate <= in7)
        .sort(byEventDateAsc),
    [projects, today, in7],
  )

  const totalUnread = useMemo(() => Object.values(unread).reduce((a, b) => a + b, 0), [unread])

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.35 }}
      className="board-scroll h-full overflow-y-auto px-8 pb-12"
    >
      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        <StatCard label="Money in this month" onClick={() => onNavigate('finance')}>
          <p className="font-display text-[28px] leading-none text-brass tabular-nums">
            {fin ? money(fin.thisMonth.received) : '--'}
          </p>
          <p className="mt-1 text-[11px] text-faint">{fin ? `${money(fin.thisMonth.earned)} earned` : ' '}</p>
        </StatCard>

        <StatCard label="Overdue" onClick={() => onNavigate('tasks')}>
          <p className="font-display text-[28px] leading-none tabular-nums" style={{ color: overdue.length ? '#dc2626' : 'var(--color-muted)' }}>
            {overdue.length}
          </p>
          <p className="mt-1 text-[11px] text-faint">tasks past due</p>
        </StatCard>

        <StatCard label="Due today" onClick={() => onNavigate('tasks')}>
          <p className="font-display text-[28px] leading-none tabular-nums text-parchment">{dueToday.length}</p>
          <p className="mt-1 text-[11px] text-faint">tasks</p>
        </StatCard>

        <StatCard label="Next 7 days" onClick={() => onNavigate('pipeline')}>
          <p className="font-display text-[28px] leading-none tabular-nums text-parchment">{upcoming.length}</p>
          <p className="mt-1 text-[11px] text-faint">gigs coming up</p>
        </StatCard>

        <StatCard label="Unread mail" onClick={() => setMailOpen(true)}>
          <div className="flex items-center gap-2.5">
            <span className="relative inline-flex">
              <svg viewBox="0 0 24 24" className="h-7 w-7 text-brass" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="5" width="18" height="14" rx="2" />
                <path d="M4 7l8 6 8-6" />
              </svg>
              {totalUnread > 0 && (
                <span className="absolute -right-2 -top-2 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-brass px-1 text-[10px] font-bold text-canvas">
                  {totalUnread}
                </span>
              )}
            </span>
            <span className="font-display text-[20px] leading-none tabular-nums text-parchment">{totalUnread}</span>
          </div>
          <p className="mt-1.5 text-[11px] text-faint">from active clients</p>
        </StatCard>
      </div>

      {/* Daily duties — large checkboxes that reset every morning */}
      <DailyDuties />

      {/* Two columns */}
      <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-2">
        <section>
          <div className="mb-3 flex items-center gap-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-brass-dim">Needs attention</h3>
            {needsAttention.length > 0 && (
              <span className="rounded-full border border-line px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-faint">
                {needsAttention.length}
              </span>
            )}
          </div>
          {needsAttention.length === 0 ? (
            <p className="rounded-xl border border-dashed border-line px-4 py-8 text-center text-[12.5px] text-faint">
              You're all caught up. No overdue or due-today tasks.
            </p>
          ) : (
            <div className="space-y-2">
              {needsAttention.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  projectName={byId.get(t.projectId)?.client ?? 'Unknown project'}
                  onToggle={(d) => onToggleTask(t.id, d)}
                  onDelete={() => onDeleteTask(t.id)}
                  onOpenProject={() => {
                    const p = byId.get(t.projectId)
                    if (p) onOpenFull(p)
                  }}
                />
              ))}
            </div>
          )}
        </section>

        <section>
          <div className="mb-3 flex items-center gap-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-brass-dim">Next 7 days</h3>
            {upcoming.length > 0 && (
              <span className="rounded-full border border-line px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-faint">
                {upcoming.length}
              </span>
            )}
          </div>
          {upcoming.length === 0 ? (
            <p className="rounded-xl border border-dashed border-line px-4 py-8 text-center text-[12.5px] text-faint">
              Nothing scheduled in the next 7 days.
            </p>
          ) : (
            <div className="space-y-2">
              {upcoming.map((p) => (
                <ProjectRow
                  key={p.id}
                  project={p}
                  unreadCount={unread[p.id] || 0}
                  onOpenFull={onOpenFull}
                  onOpenSide={onOpenSide}
                  badge={
                    <span className="shrink-0 rounded-full border border-line bg-surface-3/60 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-muted">
                      {formatEventDate(p.eventDate)}
                    </span>
                  }
                />
              ))}
            </div>
          )}
        </section>
      </div>

      {/* The big things he is working on, under everything else */}
      <HomeList />

      <UnreadMailModal
        open={mailOpen}
        onClose={() => setMailOpen(false)}
        onOpenProject={onOpenProjectById}
        onThreadRead={onThreadRead}
      />
    </motion.div>
  )
}

// --- Daily duties ------------------------------------------------------------
// Recurring things Michael does every day (go through mail, clean emails, log
// expenses, ...). The list is editable and persists; the checkmarks reset every
// morning. Both live in localStorage: the list under DUTIES_KEY, the checks under
// CHECKS_KEY stamped with the day they belong to (a new day -> empty checks).
type Duty = { id: string; label: string }
const DUTIES_KEY = 'crm-daily-duties'
const CHECKS_KEY = 'crm-daily-duty-checks'
const DEFAULT_DUTIES: Duty[] = [
  { id: 'mail', label: 'Go through my mail' },
  { id: 'emails', label: 'Clean up emails' },
  { id: 'expenses', label: 'Document expenses' },
]

function loadDuties(): Duty[] {
  try {
    const r = JSON.parse(localStorage.getItem(DUTIES_KEY) || '')
    if (Array.isArray(r) && r.every((d) => d && typeof d.id === 'string')) return r
  } catch {
    // fall through to defaults
  }
  return DEFAULT_DUTIES
}
function loadChecks(today: string): Record<string, boolean> {
  try {
    const r = JSON.parse(localStorage.getItem(CHECKS_KEY) || '')
    if (r && r.date === today && r.checked) return r.checked
  } catch {
    // new day or nothing stored -> empty (everything unchecked)
  }
  return {}
}
function newDutyId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return 'duty-' + Math.round(performance.now() * 1000).toString(36)
  }
}

function DailyDuties() {
  const today = todayISO()
  const [duties, setDuties] = useState<Duty[]>(loadDuties)
  const [checks, setChecks] = useState<Record<string, boolean>>(() => loadChecks(today))
  const [editing, setEditing] = useState(false)
  const [newLabel, setNewLabel] = useState('')

  useEffect(() => {
    localStorage.setItem(DUTIES_KEY, JSON.stringify(duties))
  }, [duties])
  useEffect(() => {
    localStorage.setItem(CHECKS_KEY, JSON.stringify({ date: today, checked: checks }))
  }, [checks, today])

  const toggle = (id: string) => setChecks((c) => ({ ...c, [id]: !c[id] }))
  const removeDuty = (id: string) => setDuties((d) => d.filter((x) => x.id !== id))
  const addDuty = () => {
    const l = newLabel.trim()
    if (!l) return
    setDuties((d) => [...d, { id: newDutyId(), label: l }])
    setNewLabel('')
  }

  const done = duties.filter((d) => checks[d.id]).length

  return (
    <section className="mt-8">
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-brass-dim">Daily duties</h3>
        {duties.length > 0 && (
          <span className="rounded-full border border-line px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-faint">
            {done}/{duties.length}
          </span>
        )}
        <button
          type="button"
          onClick={() => setEditing((v) => !v)}
          className="ml-auto text-[11.5px] font-medium text-muted transition-colors hover:text-brass"
        >
          {editing ? 'Done' : 'Edit'}
        </button>
      </div>

      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
        {duties.map((d) => {
          const checked = !!checks[d.id]
          return (
            <div
              key={d.id}
              className={[
                'flex items-center gap-3 rounded-xl border px-4 py-3.5 transition-colors',
                checked ? 'border-brass-dim/50 bg-surface-3/50' : 'border-line bg-surface-2/50',
              ].join(' ')}
            >
              <button
                type="button"
                onClick={() => toggle(d.id)}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
                aria-pressed={checked}
              >
                <span
                  className={[
                    'flex h-6 w-6 shrink-0 items-center justify-center rounded-md border-2 transition-colors',
                    checked ? 'border-brass bg-brass text-canvas' : 'border-line-strong text-transparent',
                  ].join(' ')}
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                </span>
                <span className={['text-[14px] leading-snug', checked ? 'text-faint line-through' : 'text-parchment'].join(' ')}>
                  {d.label}
                </span>
              </button>
              {editing && (
                <button
                  type="button"
                  onClick={() => removeDuty(d.id)}
                  aria-label={`Remove ${d.label}`}
                  className="shrink-0 text-faint transition-colors hover:text-[#dc2626]"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              )}
            </div>
          )
        })}
      </div>

      {editing && (
        <div className="mt-2.5 flex items-center gap-2">
          <input
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addDuty()}
            placeholder="Add a daily duty…"
            className="min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-3 py-2 text-[13px] text-parchment placeholder:text-faint focus:border-brass-dim focus:outline-none sm:max-w-xs"
          />
          <button
            type="button"
            onClick={addDuty}
            disabled={!newLabel.trim()}
            className="shrink-0 rounded-lg border border-brass-dim/60 bg-surface-3 px-3 py-2 text-[12.5px] font-semibold text-brass-bright transition-colors hover:border-brass disabled:cursor-not-allowed disabled:opacity-40"
          >
            Add
          </button>
        </div>
      )}
    </section>
  )
}

// --- On my plate -------------------------------------------------------------
// The big things Michael is working on (2026-10-24): "the major elements of my business that I'm
// working on that still need to be done. The things that are hanging over my head." No due date, no
// checkbox, and it is NOT a task. The rows live in Supabase (`home_list`, crm-home-list.mjs) and the
// phone's Home shows the same list.
//
// An OUTLINE since 2026-10-31: "I want to be able to rename it and reorder it... if I press the enter
// key, it'll make a new line with a new bullet. But if I press the tab key, it would indent that
// bullet." Click an item to rename it. While typing: Enter starts a new line below, Tab indents,
// Shift+Tab outdents, Option+Up/Down moves. The same moves sit on each row's hover buttons. The rules
// (what can indent, what moves with what) are shared with the phone in mobile/homelist-core.js.
//
// It is one white card with its heading inside, because the navy band ends somewhere above it and a
// heading drawn straight on the band turns invisible below it (crm-page-layout-traps).
type PlateDraft = { afterId: string | null; depth: number; text: string }

const plateBtn =
  'rounded-md p-1 text-faint transition-colors hover:text-[var(--color-brass-bright)] disabled:pointer-events-none disabled:opacity-25'
const plateInput =
  'min-w-0 flex-1 rounded-md border border-brass-dim bg-surface px-2 py-1 text-[14px] leading-snug text-parchment focus:outline-none'

function PlateIcon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  )
}

// The bullet, so the levels read at a glance: a filled dot, then a ring, then a dash.
function PlateBullet({ depth }: { depth: number }) {
  if (depth === 0) return <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-brass)]" />
  if (depth === 1) return <span className="mt-[6px] h-2 w-2 shrink-0 rounded-full border border-[var(--color-brass)]" />
  return <span className="mt-[9px] h-px w-2 shrink-0 bg-[var(--color-brass)]" />
}

let plateTempSeq = 0

function HomeList() {
  const [items, setItems] = useState<HomeListItem[] | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [draft, setDraft] = useState<PlateDraft | null>(null)
  const editRef = useRef<HTMLInputElement>(null)
  const draftRef = useRef<HTMLInputElement>(null)
  // The latest list, for handlers that run after an await. setList keeps it and the state in step.
  const itemsRef = useRef<HomeListItem[]>([])
  const setList = useCallback((next: HomeListItem[]) => {
    itemsRef.current = next
    setItems(next)
  }, [])
  // Bumped by every write. A refresh that started before one would put the old list back, so its
  // answer is dropped if the count moved while it was out.
  const editSeq = useRef(0)

  const refresh = useCallback(() => {
    const seqAtStart = editSeq.current
    loadHomeList()
      .then((fresh) => {
        if (editSeq.current === seqAtStart) setList(normalize(sortItems(fresh)))
      })
      .catch(() => setItems((prev) => prev ?? []))
  }, [setList])

  useEffect(() => {
    refresh()
    // The same rhythm as the rest of the Mac app (every 20 seconds, and the moment the window comes
    // back), so something added on the phone turns up here.
    const timer = setInterval(refresh, 20 * 1000)
    const onFocus = () => refresh()
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refresh])

  // A move re-orders the rows, and the browser drops focus from a row it moves, so put it back.
  useLayoutEffect(() => {
    if (editingId && document.activeElement !== editRef.current) editRef.current?.focus()
  }, [editingId, items])
  useLayoutEffect(() => {
    if (draft && document.activeElement !== draftRef.current) draftRef.current?.focus()
  }, [draft, items])

  const fail = (e: unknown, fallback: string) => {
    setError(e instanceof Error ? e.message : fallback)
    editSeq.current++
    refresh() // puts back whatever the database really holds
  }

  // Show the new order straight away, then save only the rows that moved.
  const applyLayout = async (next: HomeListItem[]) => {
    const before = itemsRef.current
    if (next === before) return
    const placed = withPositions(next)
    setError('')
    editSeq.current++
    setList(placed)
    try {
      await saveHomeListLayout(layoutChanges(before, placed))
      editSeq.current++
    } catch (e) {
      fail(e, 'Could not save the new order.')
    }
  }
  const indentItem = (id: string) => applyLayout(indent(itemsRef.current, id))
  const outdentItem = (id: string) => applyLayout(outdent(itemsRef.current, id))
  const moveItem = (id: string, dir: -1 | 1) => applyLayout(dir < 0 ? moveUp(itemsRef.current, id) : moveDown(itemsRef.current, id))

  const renameItem = async (id: string, value: string) => {
    const t = value.trim()
    const cur = itemsRef.current.find((x) => x.id === id)
    if (!cur || !t || t === cur.text) return
    setError('')
    editSeq.current++
    setList(rename(itemsRef.current, id, t))
    try {
      await renameHomeListItem(id, t)
      editSeq.current++
    } catch (e) {
      fail(e, 'Could not rename that.')
    }
  }

  // A new item after `afterId`'s block at `depth` (or at the bottom, top level). Returns the new id.
  const addItem = async (value: string, afterId: string | null, depth: number) => {
    const t = value.trim()
    if (!t) return null
    const before = itemsRef.current
    const tempId = `tmp-${++plateTempSeq}`
    const temp: HomeListItem = { id: tempId, text: t, createdAt: '', position: null, depth }
    let next = insertAfter(before, afterId, temp)
    if (afterId) next = normalize(next.map((x) => (x.id === tempId ? { ...x, depth } : x)))
    const placed = withPositions(next)
    const mine = placed.find((x) => x.id === tempId)!
    setError('')
    editSeq.current++
    setList(placed)
    try {
      const item = await addHomeListItem(t, { position: mine.position, depth: mine.depth })
      setList(itemsRef.current.map((x) => (x.id === tempId ? { ...x, id: item.id, createdAt: item.createdAt } : x)))
      setDraft((d) => (d && d.afterId === tempId ? { ...d, afterId: item.id } : d))
      await saveHomeListLayout(layoutChanges(before, placed.filter((x) => x.id !== tempId)))
      editSeq.current++
      return item.id
    } catch (e) {
      fail(e, 'Could not add that.')
      return null
    }
  }

  const add = async () => {
    if (!text.trim() || busy) return
    setBusy(true)
    const id = await addItem(text, null, 0)
    if (id) setText('')
    setBusy(false)
  }

  // Straight away, like deleting a task on the Mac. Its children stay, pulled out a level if needed.
  const remove = async (id: string) => {
    const before = itemsRef.current
    const placed = withPositions(removeItem(before, id))
    setError('')
    editSeq.current++
    setList(placed)
    if (editingId === id) setEditingId(null)
    try {
      await deleteHomeListItem(id)
      await saveHomeListLayout(layoutChanges(before.filter((x) => x.id !== id), placed))
      editSeq.current++
    } catch (e) {
      fail(e, 'Could not delete that.')
    }
  }

  const startEdit = (x: HomeListItem) => {
    setDraft(null)
    setEditingId(x.id)
    setEditText(x.text)
  }
  // Leaving the box saves it. Checked a beat later, because a move re-focuses the same box.
  const endEditSoon = () =>
    window.setTimeout(() => {
      if (document.activeElement === editRef.current) return
      setEditingId((id) => {
        if (id) void renameItem(id, editText)
        return null
      })
    }, 0)

  const onEditKey = (e: React.KeyboardEvent<HTMLInputElement>, x: HomeListItem) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void renameItem(x.id, editText)
      setEditingId(null)
      setDraft({ afterId: x.id, depth: x.depth, text: '' })
    } else if (e.key === 'Tab') {
      e.preventDefault()
      void renameItem(x.id, editText)
      void (e.shiftKey ? outdentItem(x.id) : indentItem(x.id))
    } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault()
      void moveItem(x.id, e.key === 'ArrowUp' ? -1 : 1)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setEditingId(null)
    }
  }

  // The deepest a new line may go: one level under the item it follows.
  const draftMaxDepth = (d: PlateDraft) => {
    const list = itemsRef.current
    const i = d.afterId ? list.findIndex((x) => x.id === d.afterId) : -1
    if (i < 0) return 0
    return Math.min(MAX_DEPTH, list[blockEnd(list, i) - 1].depth + 1)
  }
  const onDraftKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!draft) return
    if (e.key === 'Enter') {
      e.preventDefault()
      if (!draft.text.trim()) {
        setDraft(null)
        return
      }
      const d = draft
      // The next line goes after this one, at the same level, the way a bulleted list does.
      setDraft({ afterId: null, depth: d.depth, text: '' })
      void addItem(d.text, d.afterId, d.depth).then((id) => setDraft((cur) => (cur && id ? { ...cur, afterId: id } : null)))
    } else if (e.key === 'Tab') {
      e.preventDefault()
      const depth = e.shiftKey ? Math.max(0, draft.depth - 1) : Math.min(draftMaxDepth(draft), draft.depth + 1)
      setDraft({ ...draft, depth })
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setDraft(null)
    }
  }
  const endDraftSoon = () =>
    window.setTimeout(() => {
      if (document.activeElement === draftRef.current) return
      setDraft((d) => {
        if (d && d.text.trim() && d.afterId) void addItem(d.text, d.afterId, d.depth)
        return null
      })
    }, 0)

  const list = items ?? []
  // Where the new line sits: right after the block of the item it follows.
  const draftAt = (() => {
    if (!draft || !draft.afterId) return -1
    const i = list.findIndex((x) => x.id === draft.afterId)
    return i < 0 ? -1 : blockEnd(list, i)
  })()
  const draftRow = draft && draftAt >= 0 && (
    <div key="plate-draft" className="flex items-start gap-2.5 rounded-lg px-3 py-2" style={{ marginLeft: draft.depth * 24 }}>
      <PlateBullet depth={draft.depth} />
      <input
        ref={draftRef}
        value={draft.text}
        onChange={(e) => setDraft({ ...draft, text: e.target.value })}
        onKeyDown={onDraftKey}
        onBlur={endDraftSoon}
        placeholder="New item"
        className={plateInput}
      />
    </div>
  )

  return (
    <section className="mt-8 rounded-2xl border border-line bg-surface p-5">
      <div className="mb-3 flex items-center gap-2">
        {/* text-muted, not the band headings' brass-dim: inside a white card brass-dim is a pale blue. */}
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted">On my plate</h3>
        {list.length > 0 && (
          <span className="rounded-full border border-line px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-faint">
            {list.length}
          </span>
        )}
      </div>

      {items && list.length === 0 && (
        <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-[12.5px] text-faint">
          Nothing on your plate yet. Add the first thing below.
        </p>
      )}
      {list.length > 0 && (
        <div className="space-y-1.5">
          {list.map((x, i) => {
            const editing = editingId === x.id
            const row = (
              <div
                key={x.id}
                className="group flex items-start gap-2.5 rounded-lg border border-line bg-surface-2/50 px-3 py-2 transition-colors hover:border-line-strong"
                style={{ marginLeft: x.depth * 24 }}
              >
                <PlateBullet depth={x.depth} />
                {editing ? (
                  <input
                    ref={editRef}
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    onKeyDown={(e) => onEditKey(e, x)}
                    onBlur={endEditSoon}
                    className={plateInput}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => startEdit(x)}
                    title="Click to rename"
                    className="min-w-0 flex-1 cursor-text text-left text-[14px] leading-snug text-parchment"
                  >
                    {x.text}
                  </button>
                )}
                <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                  <button type="button" className={plateBtn} title="Move up (Option+Up)" aria-label="Move up" disabled={!canMoveUp(list, x.id)} onClick={() => moveItem(x.id, -1)}>
                    <PlateIcon d="M12 19V5M5 12l7-7 7 7" />
                  </button>
                  <button type="button" className={plateBtn} title="Move down (Option+Down)" aria-label="Move down" disabled={!canMoveDown(list, x.id)} onClick={() => moveItem(x.id, 1)}>
                    <PlateIcon d="M12 5v14M19 12l-7 7-7-7" />
                  </button>
                  <button type="button" className={plateBtn} title="Outdent (Shift+Tab)" aria-label="Outdent" disabled={!canOutdent(list, x.id)} onClick={() => outdentItem(x.id)}>
                    <PlateIcon d="M11 6H20M11 12h9M11 18h9M7 9l-3 3 3 3" />
                  </button>
                  <button type="button" className={plateBtn} title="Indent under the item above (Tab)" aria-label="Indent" disabled={!canIndent(list, x.id)} onClick={() => indentItem(x.id)}>
                    <PlateIcon d="M11 6H20M11 12h9M11 18h9M4 9l3 3-3 3" />
                  </button>
                  <button type="button" className={plateBtn} title="Delete" aria-label={`Delete ${x.text}`} onClick={() => remove(x.id)}>
                    <PlateIcon d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
                  </button>
                </div>
              </div>
            )
            return draftAt === i + 1 ? [row, draftRow] : row
          })}
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          placeholder="Add an item…"
          className="min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-3 py-2 text-[13px] text-parchment placeholder:text-faint focus:border-brass-dim focus:outline-none"
        />
        <button
          type="button"
          onClick={add}
          disabled={!text.trim() || busy}
          className="shrink-0 rounded-lg border border-brass-dim/60 bg-surface-3 px-3 py-2 text-[12.5px] font-semibold text-brass-bright transition-colors hover:border-brass disabled:cursor-not-allowed disabled:opacity-40"
        >
          Add
        </button>
      </div>
      {list.length > 0 && (
        <p className="mt-2 text-[11px] text-faint">
          Click an item to rename it. While typing: Enter adds a line below, Tab indents, Shift+Tab outdents, Option+Up/Down moves.
        </p>
      )}
      {error && <p className="mt-2 text-[12px] text-[#dc2626]">{error}</p>}
    </section>
  )
}

function StatCard({ label, onClick, children }: { label: string; onClick?: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-2xl border border-line bg-surface-2/50 p-4 text-left transition-colors hover:border-line-strong hover:bg-surface-3/60"
    >
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-faint">{label}</p>
      {children}
    </button>
  )
}
