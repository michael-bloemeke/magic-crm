import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { byEventDateAsc, formatEventDate, todayISO, type Project } from '../pipeline'
import {
  loadFinance,
  loadHomeList,
  addHomeListItem,
  deleteHomeListItem,
  type FinanceSummary,
  type HomeListItem,
  type Task,
} from '../api'
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
// working on that still need to be done. The things that are hanging over my head." Add and delete,
// nothing else: no due date, no checkbox, no rename, and it is NOT a task. The rows live in Supabase
// (`home_list`, crm-home-list.mjs) and the phone's Home shows the same list.
//
// It is one white card with its heading inside, because the navy band ends somewhere above it and a
// heading drawn straight on the band turns invisible below it (crm-page-layout-traps).
function HomeList() {
  const [items, setItems] = useState<HomeListItem[] | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // Bumped by every add and delete. A refresh that started before one would put the old list back,
  // so its answer is dropped if the count moved while it was out.
  const editSeq = useRef(0)

  const refresh = useCallback(() => {
    const seqAtStart = editSeq.current
    loadHomeList()
      .then((fresh) => {
        if (editSeq.current === seqAtStart) setItems(fresh)
      })
      .catch(() => setItems((prev) => prev ?? []))
  }, [])

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

  const add = async () => {
    const t = text.trim()
    if (!t || busy) return
    setBusy(true)
    setError('')
    editSeq.current++
    try {
      const item = await addHomeListItem(t)
      setItems((prev) => [...(prev ?? []), item])
      setText('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add that.')
    } finally {
      editSeq.current++
      setBusy(false)
    }
  }

  // Straight away, like deleting a task on the Mac.
  const remove = async (id: string) => {
    setError('')
    editSeq.current++
    setItems((prev) => (prev ?? []).filter((x) => x.id !== id))
    try {
      await deleteHomeListItem(id)
      editSeq.current++
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete that.')
      editSeq.current++
      refresh() // puts the item back, since it is still there
    }
  }

  return (
    <section className="mt-8 rounded-2xl border border-line bg-surface p-5">
      <div className="mb-3 flex items-center gap-2">
        {/* text-muted, not the band headings' brass-dim: inside a white card brass-dim is a pale blue. */}
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted">On my plate</h3>
        {items && items.length > 0 && (
          <span className="rounded-full border border-line px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-faint">
            {items.length}
          </span>
        )}
      </div>

      {items && items.length === 0 && (
        <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-[12.5px] text-faint">
          Nothing on your plate yet. Add the first thing below.
        </p>
      )}
      {items && items.length > 0 && (
        <div className="space-y-2">
          {items.map((x) => (
            <div
              key={x.id}
              className="group flex items-center gap-3 rounded-lg border border-line bg-surface-2/50 px-3 py-2.5 transition-colors hover:border-line-strong"
            >
              <span className="min-w-0 flex-1 text-[14px] leading-snug text-parchment">{x.text}</span>
              <button
                type="button"
                onClick={() => remove(x.id)}
                aria-label={`Delete ${x.text}`}
                title="Delete"
                className="shrink-0 rounded-md p-1 text-faint opacity-0 transition-all hover:text-[var(--color-brass-bright)] focus:opacity-100 group-hover:opacity-100"
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
                </svg>
              </button>
            </div>
          ))}
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
