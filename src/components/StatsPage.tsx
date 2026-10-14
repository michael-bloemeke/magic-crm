import { useEffect, useMemo, useState } from 'react'
import { motion } from 'motion/react'
import { ARCHIVE_REASONS, EVENT_TYPE_ACCENT, todayISO, type EventType, type Project } from '../pipeline'

// Lead statistics, computed client-side from the loaded projects. Only projects Michael has SIGNED OFF
// in the Audit tab feed the numbers (so the stats reflect verified data). The Audit tab is a temporary
// tool for that one-time review; delete it (and this gating) once every project is signed off.

type Period = 'all' | 'year' | 'last12' | 'last30'
type Basis = 'event' | 'lead'
type Tab = 'overview' | 'audit'

const money = (n: number) => '$' + Math.round(n || 0).toLocaleString('en-US')
const pct = (n: number) => Math.round(n * 100) + '%'
function isoDaysAgo(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const THIS_YEAR = String(new Date().getFullYear())
const dateOf = (p: Project, basis: Basis) => (basis === 'lead' ? p.leadDate : p.eventDate)
function inRange(d: string, period: Period): boolean {
  if (period === 'all') return true
  if (!/^\d{4}-\d{2}-\d{2}/.test(d)) return false
  if (period === 'year') return d.slice(0, 4) === THIS_YEAR
  const today = todayISO()
  if (period === 'last12') return d >= isoDaysAgo(365) && d <= today
  if (period === 'last30') return d >= isoDaysAgo(30) && d <= today
  return true
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const monthLabel = (k: string) => `${MONTHS[Number(k.slice(5, 7)) - 1]} '${k.slice(2, 4)}`

// Won (booked) = paid a deposit or completed. Lost = archived. Still-open active projects are neither.
const isWon = (p: Project) => p.bucket === 'completed' || p.stageId === 'deposit-paid'
const isLost = (p: Project) => p.bucket === 'archived'

const EVENT_TYPE_OPTIONS: EventType[] = ['Wedding', 'Corporate', 'Private Event', 'Bachelor(ette) Party', 'Other']

// The canonical lead-source options (the audit dropdown). Stats bucket everything into these.
// ⚠️ MUST stay identical to LEAD_SOURCES in mobile/supabase-data.js (the phone's New project
// dropdown): a value not on this list is bucketed by normalizeSource below, so a mismatch is silent.
// "AI" and "Repeat client" added 2026-10-14: Michael put an AI option on the website form on purpose
// to measure ChatGPT-sourced leads, and both were landing in Other.
const LEAD_SOURCES = ['Google/Web', 'Bark', 'The Bash', 'GigSalad', 'In Person', 'Referral', 'Instagram/TikTok', 'AI', 'Repeat client', 'Other']

// Map a stored booking_source (canonical or legacy free-text) to one of the canonical options.
//
// The stored values are free text, much of it long HoneyBook-era notes like "The Bash (HoneyBook lead
// source; Michael's note also says he 'called on Bark')" or "Client Referral - from Olivia ... (likely
// the 'Bark - Olivia' client)". So it is NOT first-rule-wins: every keyword is located, and the one
// that appears EARLIEST in the text decides, because the source is written first and the asides come
// after it. That one change is what keeps the two examples above out of Bark.
const SOURCE_KEYWORDS: Array<[RegExp, string]> = [
  [/\bai\b|chatgpt|chat gpt|gemini|perplexity|claude|copilot/, 'AI'],
  [/repeat|returning client|past client/, 'Repeat client'],
  [/gigsalad|gig salad/, 'GigSalad'],
  [/\bbash\b/, 'The Bash'],
  [/\bbark\b/, 'Bark'],
  [/instagram|tiktok|tik tok/, 'Instagram/TikTok'],
  [/google|website|wix|online|\bweb\b|search|internet/, 'Google/Web'],
  [/referral|referred|recommend/, 'Referral'],
  [/live show|in person|in-person|saw michael|saw him|perform|went to|met michael|\bmet\b/, 'In Person'],
  // Fellow magicians in Michael's referral network, named without the word "referral".
  [/magician|jack kelly|kevin|evan driggs|gary goodman|steve vaught|wayne haarhaus/, 'Referral'],
]
function normalizeSource(raw: string): string {
  const s = (raw || '').toLowerCase().trim()
  if (!s) return 'Other'
  const exact = LEAD_SOURCES.find((o) => o.toLowerCase() === s)
  if (exact) return exact
  let best = 'Other'
  let at = Infinity
  for (const [re, bucket] of SOURCE_KEYWORDS) {
    const m = re.exec(s)
    if (m && m.index < at) {
      at = m.index
      best = bucket
    }
  }
  return best
}

type Row = { k: string; n: number }
function tally<T>(items: T[], keyFn: (x: T) => string): Row[] {
  const m = new Map<string, number>()
  for (const x of items) m.set(keyFn(x), (m.get(keyFn(x)) || 0) + 1)
  return [...m.entries()].map(([k, n]) => ({ k, n })).sort((a, b) => b.n - a.n)
}

const SECTION = 'mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint'
const CARD = 'rounded-xl border border-line bg-surface p-5'
const RED = '#ef4444'
const AMBER = '#eab308'

function StatCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4" style={accent ? { borderLeft: `3px solid ${accent}` } : undefined}>
      <div className="text-[26px] font-bold leading-none tabular-nums text-parchment">{value}</div>
      <div className="mt-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-faint">{label}</div>
      {sub && <div className="mt-1 text-[12px] text-muted">{sub}</div>}
    </div>
  )
}
function BarList({ rows, color }: { rows: Row[]; color?: string | ((k: string) => string) }) {
  const max = Math.max(1, ...rows.map((r) => r.n))
  const sum = rows.reduce((s, r) => s + r.n, 0)
  if (!rows.length) return <p className="text-[12.5px] text-faint">No data in this view.</p>
  return (
    <div>
      {rows.map((r) => (
        <div key={r.k} className="mb-2.5 last:mb-0">
          <div className="mb-1 flex items-baseline justify-between gap-3 text-[12.5px]">
            <span className="truncate text-parchment">{r.k}</span>
            <span className="flex-none tabular-nums text-muted">
              {r.n}
              {sum ? <span className="text-faint"> · {Math.round((r.n / sum) * 100)}%</span> : null}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-surface-2">
            <div className="h-full rounded-full" style={{ width: `${(r.n / max) * 100}%`, background: typeof color === 'function' ? color(r.k) : color || 'var(--color-brass)' }} />
          </div>
        </div>
      ))}
    </div>
  )
}
function RateList({ rows }: { rows: { k: string; leads: number; booked: number; rate: number }[] }) {
  if (!rows.length) return <p className="text-[12.5px] text-faint">No resolved leads in this view.</p>
  return (
    <div>
      {rows.map((r) => (
        <div key={r.k} className="mb-2.5 last:mb-0">
          <div className="mb-1 flex items-baseline justify-between gap-3 text-[12.5px]">
            <span className="truncate text-parchment">{r.k}</span>
            <span className="flex-none tabular-nums text-muted">
              {r.booked}/{r.leads} <span className="font-semibold text-parchment">{pct(r.rate)}</span>
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-surface-2">
            <div className="h-full rounded-full" style={{ width: `${r.rate * 100}%`, background: 'var(--color-umb-booked)' }} />
          </div>
        </div>
      ))}
    </div>
  )
}
function MonthBars({ rows }: { rows: Row[] }) {
  const max = Math.max(1, ...rows.map((r) => r.n))
  if (!rows.length) return <p className="text-[12.5px] text-faint">No dated leads in this view.</p>
  return (
    <div className="flex h-44 items-end gap-1.5">
      {rows.map((r) => (
        <div key={r.k} className="flex flex-1 flex-col items-center justify-end gap-1">
          <span className="text-[10px] tabular-nums text-muted">{r.n}</span>
          <div className="w-full rounded-t" style={{ height: `${(r.n / max) * 100}%`, minHeight: r.n ? 4 : 0, background: 'var(--color-brass)' }} />
          <span className="whitespace-nowrap text-[9px] text-faint">{monthLabel(r.k)}</span>
        </div>
      ))}
    </div>
  )
}

// ---- Overview (the stats) ----------------------------------------------------
function Overview({ projects }: { projects: Project[] }) {
  const [period, setPeriod] = useState<Period>('year')
  const [basis, setBasis] = useState<Basis>('event')
  const [preview, setPreview] = useState(false)

  const s = useMemo(() => {
    const pool = preview ? projects : projects.filter((p) => p.signedOff)
    const leads = pool.filter((p) => inRange(dateOf(p, basis), period))
    const won = leads.filter(isWon)
    const lost = leads.filter(isLost)
    const open = leads.filter((p) => p.bucket === 'active' && !isWon(p))
    const resolved = leads.filter((p) => isWon(p) || isLost(p)) // active-open projects sit out conversion
    const closeRate = resolved.length ? won.length / resolved.length : 0
    const bookedRevenue = won.reduce((sum, p) => sum + (p.totalFee || 0), 0)
    const avgValue = won.length ? bookedRevenue / won.length : 0

    // Close rate by channel / type: denominator is RESOLVED leads only (won + lost), never the open ones.
    const rateBy = (keyFn: (p: Project) => string) =>
      [...new Set(resolved.map(keyFn))]
        .map((k) => {
          const ls = resolved.filter((p) => keyFn(p) === k)
          const b = ls.filter(isWon).length
          return { k, leads: ls.length, booked: b, rate: ls.length ? b / ls.length : 0 }
        })
        .sort((a, b) => b.leads - a.leads)

    const monthMap = new Map<string, number>()
    for (const p of leads) {
      const d = dateOf(p, basis)
      if (/^\d{4}-\d{2}/.test(d)) monthMap.set(d.slice(0, 7), (monthMap.get(d.slice(0, 7)) || 0) + 1)
    }
    const months = [...monthMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, n]) => ({ k, n }))

    return {
      poolSize: pool.length,
      total: leads.length,
      won: won.length,
      lost: lost.length,
      open: open.length,
      closeRate,
      bookedRevenue,
      avgValue,
      months,
      sources: tally(leads, (p) => normalizeSource(p.bookingSource)),
      leadTypes: tally(leads, (p) => p.eventType),
      bookedTypes: tally(won, (p) => p.eventType),
      lostReasons: tally(lost, (p) => p.archiveReason || 'Unspecified'),
      rateBySource: rateBy((p) => normalizeSource(p.bookingSource)),
      rateByType: rateBy((p) => p.eventType),
    }
  }, [projects, period, basis, preview])

  const typeColor = (k: string) => EVENT_TYPE_ACCENT[k as EventType] || 'var(--color-faint)'
  const seg = (active: boolean) =>
    ['rounded-lg px-4 py-1.5 text-[12.5px] font-semibold transition-colors duration-200', active ? 'bg-surface-3 text-brass-bright shadow-[inset_0_0_0_1px_var(--color-brass-dim)]' : 'text-muted hover:text-parchment'].join(' ')

  return (
    <>
      {/* Period + basis + preview */}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1 rounded-xl border border-line bg-surface/60 p-1">
          {([['year', `This year (${THIS_YEAR})`], ['last12', 'Last 12 months'], ['last30', 'Last 30 days'], ['all', 'All-time']] as const).map(([id, label]) => (
            <button key={id} type="button" onClick={() => setPeriod(id)} className={seg(period === id)}>{label}</button>
          ))}
        </div>
        <div className="flex items-center gap-1 rounded-xl border border-line bg-surface/60 p-1">
          {([['event', 'By event date'], ['lead', 'By lead date']] as const).map(([id, label]) => (
            <button key={id} type="button" onClick={() => setBasis(id)} className={seg(basis === id)}>{label}</button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setPreview((v) => !v)}
          className={['rounded-lg border px-3 py-1.5 text-[12px] font-semibold transition-colors', preview ? 'border-brass-dim text-brass-bright' : 'border-line text-faint hover:text-muted'].join(' ')}
        >
          {preview ? 'Previewing unsigned' : 'Preview unsigned'}
        </button>
      </div>

      <div className="mb-6 rounded-lg border border-line bg-surface/50 px-4 py-2.5 text-[12px] leading-relaxed text-muted">
        {preview
          ? 'Previewing ALL projects, including ones you have not signed off. These numbers are not final.'
          : `Showing ${s.poolSize} signed-off project${s.poolSize === 1 ? '' : 's'}. Sign projects off in the Audit tab to include them.`}{' '}
        Conversion excludes still-open projects; close rate = won of resolved (won + lost).
      </div>

      {s.poolSize === 0 ? (
        <div className="rounded-xl border border-line bg-surface p-10 text-center">
          <p className="text-[14px] text-parchment">No signed-off projects yet.</p>
          <p className="mt-1 text-[12.5px] text-muted">Open the Audit tab to review each project and sign it off, or tap "Preview unsigned" above to peek at the raw numbers.</p>
        </div>
      ) : (
        <>
          <div className="mb-8 grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard label="Leads" value={String(s.total)} accent="var(--color-brass)" />
            <StatCard label="Booked" value={String(s.won)} sub={`${pct(s.closeRate)} close rate`} accent="var(--color-umb-booked)" />
            <StatCard label="Lost" value={String(s.lost)} accent="var(--color-red)" />
            <StatCard label="Still open" value={String(s.open)} accent="var(--color-umb-inquiry)" />
            <StatCard label="Booked revenue" value={money(s.bookedRevenue)} accent="var(--color-brass)" />
            <StatCard label="Avg booking" value={money(s.avgValue)} accent="var(--color-brass)" />
          </div>

          <div className="mb-8">
            <div className={CARD}>
              <div className={SECTION}>Leads over time · by {basis === 'lead' ? 'lead date' : 'event date'}</div>
              <MonthBars rows={s.months} />
            </div>
          </div>

          <div className="mb-8 grid gap-4 lg:grid-cols-2">
            <div className={CARD}>
              <div className={SECTION}>Where leads came from</div>
              <BarList rows={s.sources} />
            </div>
            <div className={CARD}>
              <div className={SECTION}>Close rate by source</div>
              <RateList rows={s.rateBySource} />
            </div>
          </div>

          <div className="mb-8 grid gap-4 lg:grid-cols-2">
            <div className={CARD}>
              <div className={SECTION}>Lead type mix</div>
              <BarList rows={s.leadTypes} color={typeColor} />
            </div>
            <div className={CARD}>
              <div className={SECTION}>Booked type mix</div>
              <BarList rows={s.bookedTypes} color={typeColor} />
            </div>
            <div className={CARD}>
              <div className={SECTION}>Close rate by event type</div>
              <RateList rows={s.rateByType} />
            </div>
            <div className={CARD}>
              <div className={SECTION}>Why leads were lost</div>
              <BarList rows={s.lostReasons} color="var(--color-red)" />
            </div>
          </div>
        </>
      )}
    </>
  )
}

// ---- Audit tool (temporary) --------------------------------------------------
// One always-editable field. Red ring when empty, amber ring when a lazy default (Other / Unknown).
function AuditField({ label, value, kind, options, warn, onSave }: {
  label: string
  value: string
  kind: 'text' | 'number' | 'date' | 'select'
  options?: string[]
  warn?: boolean
  onSave: (v: string) => void
}) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  const empty = !String(v).trim()
  const style = empty
    ? { borderColor: RED, background: 'rgba(239,68,68,0.12)' }
    : warn
      ? { borderColor: AMBER, background: 'rgba(234,179,8,0.14)' }
      : undefined
  const cls = 'w-full rounded-md border border-line bg-surface-2 px-2 py-1 text-[12.5px] text-parchment focus:border-brass-dim focus:outline-none'
  const commit = (nv: string) => { if (nv !== value) onSave(nv) }
  return (
    <label className="block">
      <span className="mb-0.5 block text-[9.5px] font-semibold uppercase tracking-[0.1em] text-faint">{label}</span>
      {kind === 'select' ? (
        <select className={cls} style={style} value={v} onChange={(e) => { setV(e.target.value); commit(e.target.value) }}>
          <option value="">(none)</option>
          {v && !(options || []).includes(v) && <option value={v}>{v} (uncategorized)</option>}
          {(options || []).map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
      ) : (
        <input
          className={cls}
          style={style}
          type={kind === 'date' ? 'date' : 'text'}
          inputMode={kind === 'number' ? 'decimal' : undefined}
          value={v}
          onChange={(e) => setV(e.target.value)}
          onBlur={() => commit(v)}
        />
      )}
    </label>
  )
}

// Lead source dropdown. Picking "Referral" reveals a "Referred by" box; it's stored as
// "Referral - <name>" so the stats still bucket all referrals together while keeping the name.
function LeadSourceField({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const isReferral = /^referral\b/i.test(value.trim())
  const parsedName = isReferral ? value.trim().replace(/^referral\s*[-:]?\s*/i, '').trim() : ''
  const [name, setName] = useState(parsedName)
  useEffect(() => setName(parsedName), [value])
  const empty = !value.trim()
  const canonical = LEAD_SOURCES.includes(value) || isReferral
  const style = empty
    ? { borderColor: RED, background: 'rgba(239,68,68,0.12)' }
    : !canonical
      ? { borderColor: AMBER, background: 'rgba(234,179,8,0.14)' }
      : undefined
  const cls = 'w-full rounded-md border border-line bg-surface-2 px-2 py-1 text-[12.5px] text-parchment focus:border-brass-dim focus:outline-none'
  const commitReferral = (nm: string) => { const c = nm.trim(); onSave(c ? `Referral - ${c}` : 'Referral') }
  return (
    <label className="block">
      <span className="mb-0.5 block text-[9.5px] font-semibold uppercase tracking-[0.1em] text-faint">Lead source</span>
      <select className={cls} style={style} value={isReferral ? 'Referral' : value} onChange={(e) => (e.target.value === 'Referral' ? commitReferral(name) : onSave(e.target.value))}>
        <option value="">(none)</option>
        {value.trim() && !LEAD_SOURCES.includes(value) && !isReferral && <option value={value}>{value} (uncategorized)</option>}
        {LEAD_SOURCES.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
      {isReferral && (
        <input className={cls + ' mt-1'} type="text" placeholder="Referred by (name)" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => commitReferral(name)} />
      )}
    </label>
  )
}

function AuditCard({ p, onSave, onOpen }: { p: Project; onSave: (id: string, field: string, value: string) => void; onOpen?: (p: Project) => void }) {
  const set = (field: string) => (val: string) => onSave(p.id, field, val)
  const signed = p.signedOff
  return (
    <div className="rounded-xl border border-line bg-surface p-3" style={{ opacity: signed ? 0.55 : 1 }}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <button type="button" onClick={() => onOpen?.(p)} className="truncate text-[13.5px] font-semibold text-parchment hover:text-brass-bright">
          {p.client}
        </button>
        <button
          type="button"
          onClick={() => onSave(p.id, 'signedOff', signed ? 'false' : 'true')}
          className={[
            'flex-none rounded-md px-2.5 py-1 text-[11.5px] font-semibold transition-colors',
            signed ? 'bg-[var(--color-umb-booked)]/20 text-[var(--color-umb-booked)]' : 'border border-brass-dim text-brass-bright hover:bg-surface-2',
          ].join(' ')}
        >
          {signed ? '✓ Signed off' : 'Sign off'}
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
        <AuditField label="Lead date" kind="date" value={p.leadDate} onSave={set('leadDate')} />
        <AuditField label="Event date" kind="date" value={p.eventDate} onSave={set('eventDate')} />
        <LeadSourceField value={p.bookingSource} onSave={set('bookingSource')} />
        <AuditField label="Event type" kind="select" options={EVENT_TYPE_OPTIONS} value={p.eventType} warn={p.eventType === 'Other'} onSave={set('eventType')} />
        {p.bucket === 'archived' && (
          <AuditField label="Archive reason" kind="select" options={ARCHIVE_REASONS} value={p.archiveReason} warn={p.archiveReason === 'Other'} onSave={set('archiveReason')} />
        )}
        <AuditField label="Total fee" kind="number" value={p.totalFee == null ? '' : String(p.totalFee)} onSave={set('totalFee')} />
      </div>
    </div>
  )
}

function AuditPane({ projects, onSave, onOpen }: { projects: Project[]; onSave: (id: string, field: string, value: string) => void; onOpen?: (p: Project) => void }) {
  const [filter, setFilter] = useState<'all' | 'needs' | 'signed'>('needs')
  const signedCount = projects.filter((p) => p.signedOff).length
  const shown = (p: Project) => (filter === 'all' ? true : filter === 'needs' ? !p.signedOff : p.signedOff)
  const groups: [string, Project['bucket']][] = [['Active', 'active'], ['Completed', 'completed'], ['Archived', 'archived']]
  const seg = (active: boolean) =>
    ['rounded-lg px-3.5 py-1.5 text-[12px] font-semibold transition-colors', active ? 'bg-surface-3 text-brass-bright shadow-[inset_0_0_0_1px_var(--color-brass-dim)]' : 'text-muted hover:text-parchment'].join(' ')

  return (
    <>
      <div className="mb-5">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
          <div className="text-[13px] text-muted">
            <span className="font-semibold text-parchment">{signedCount}</span> of {projects.length} signed off
          </div>
          <div className="flex items-center gap-1 rounded-xl border border-line bg-surface/60 p-1">
            {([['needs', 'Needs review'], ['signed', 'Signed off'], ['all', 'All']] as const).map(([id, label]) => (
              <button key={id} type="button" onClick={() => setFilter(id)} className={seg(filter === id)}>{label}</button>
            ))}
          </div>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-surface-2">
          <div className="h-full rounded-full bg-[var(--color-umb-booked)]" style={{ width: `${projects.length ? (signedCount / projects.length) * 100 : 0}%` }} />
        </div>
      </div>

      {groups.map(([label, bucket]) => {
        const all = projects.filter((p) => p.bucket === bucket)
        const list = all.filter(shown).sort((a, b) => Number(a.signedOff) - Number(b.signedOff) || a.client.localeCompare(b.client))
        if (!all.length) return null
        return (
          <section key={bucket} className="mb-8">
            <div className={SECTION}>
              {label} · {all.filter((p) => p.signedOff).length}/{all.length} signed off
            </div>
            {list.length ? (
              <div className="grid gap-2.5 xl:grid-cols-2">
                {list.map((p) => (
                  <AuditCard key={p.id} p={p} onSave={onSave} onOpen={onOpen} />
                ))}
              </div>
            ) : (
              <p className="text-[12.5px] text-faint">Nothing here for this filter.</p>
            )}
          </section>
        )
      })}
    </>
  )
}

export function StatsPage({ projects, onOpenProject, onSaveField }: {
  projects: Project[]
  onOpenProject?: (p: Project) => void
  onSaveField?: (id: string, field: string, value: string) => void
}) {
  const [tab, setTab] = useState<Tab>('overview')
  const seg = (active: boolean) =>
    ['rounded-lg px-4 py-1.5 text-[12.5px] font-semibold transition-colors duration-200', active ? 'bg-surface-3 text-brass-bright shadow-[inset_0_0_0_1px_var(--color-brass-dim)]' : 'text-muted hover:text-parchment'].join(' ')

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.35 }} className="board-scroll h-full overflow-y-auto px-8 pb-12">
      <div className="mb-6 flex items-center gap-1 rounded-xl border border-line bg-surface/60 p-1 w-fit">
        {([['overview', 'Overview'], ['audit', 'Audit']] as const).map(([id, label]) => (
          <button key={id} type="button" onClick={() => setTab(id)} className={seg(tab === id)}>{label}</button>
        ))}
      </div>

      {tab === 'overview' ? (
        <Overview projects={projects} />
      ) : (
        <AuditPane projects={projects} onSave={onSaveField || (() => {})} onOpen={onOpenProject} />
      )}
    </motion.div>
  )
}
