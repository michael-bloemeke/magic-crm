import { useMemo, useState } from 'react'
import { motion } from 'motion/react'
import { EVENT_TYPE_ACCENT, todayISO, type EventType, type Project } from '../pipeline'

// Lead statistics, computed client-side from the loaded projects. Everything filters by an event-date
// period toggle (real inquiry dates aren't tracked yet, so event date is the honest proxy).

type Period = 'all' | 'year' | 'last12' | 'last30'

const money = (n: number) => '$' + Math.round(n || 0).toLocaleString('en-US')
const pct = (n: number) => Math.round(n * 100) + '%'

function isoDaysAgo(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const THIS_YEAR = String(new Date().getFullYear())

type Basis = 'event' | 'lead'
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

// A compact vertical bar chart for a monthly time series.
function MonthBars({ rows }: { rows: Row[] }) {
  const max = Math.max(1, ...rows.map((r) => r.n))
  if (!rows.length) return <p className="text-[12.5px] text-faint">No dated leads in this period.</p>
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

// A won (booked) lead: it paid its deposit (active + Deposit Paid) or it's completed.
const isWon = (p: Project) => p.bucket === 'completed' || p.stageId === 'deposit-paid'
const isLost = (p: Project) => p.bucket === 'archived'

// Collapse the free-text booking_source into a clean channel. Best-effort; refine the keywords freely.
function normalizeSource(raw: string): string {
  const s = (raw || '').toLowerCase()
  if (!s.trim()) return 'Unknown'
  if (s.includes('bark')) return 'Bark'
  if (s.includes('google')) return 'Google'
  if (s.includes('gigsalad')) return 'GigSalad'
  if (s.includes('bash')) return 'The Bash'
  if (s.includes('instagram')) return 'Instagram'
  if (s.includes('chatgpt')) return 'ChatGPT'
  if (s.includes('thumbtack')) return 'Thumbtack'
  if (s.includes('referral') || s.includes('referred')) return 'Referral'
  if (s.includes('repeat')) return 'Repeat client'
  if (s.includes('website') || s.includes('wix') || s.includes('online') || s.includes('web ')) return 'Website'
  if (s.includes('indy week') || s.includes('article') || s.includes('featured') || s.includes('press')) return 'Press'
  if (s.includes('saw michael') || s.includes('perform')) return 'Word of mouth'
  // "HoneyBook" alone, "TBD", "Other", etc. = a lead whose real channel isn't recorded.
  return 'Unknown'
}

type Row = { k: string; n: number }
function tally<T>(items: T[], keyFn: (x: T) => string): Row[] {
  const m = new Map<string, number>()
  for (const x of items) {
    const k = keyFn(x)
    m.set(k, (m.get(k) || 0) + 1)
  }
  return [...m.entries()].map(([k, n]) => ({ k, n })).sort((a, b) => b.n - a.n)
}

const SECTION = 'mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint'
const CARD = 'rounded-xl border border-line bg-surface p-5'

function StatCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4" style={accent ? { borderLeft: `3px solid ${accent}` } : undefined}>
      <div className="text-[26px] font-bold leading-none tabular-nums text-parchment">{value}</div>
      <div className="mt-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-faint">{label}</div>
      {sub && <div className="mt-1 text-[12px] text-muted">{sub}</div>}
    </div>
  )
}

// Labeled horizontal bars (count + share of the total).
function BarList({ rows, color }: { rows: Row[]; color?: string | ((k: string) => string) }) {
  const max = Math.max(1, ...rows.map((r) => r.n))
  const sum = rows.reduce((s, r) => s + r.n, 0)
  if (!rows.length) return <p className="text-[12.5px] text-faint">No data in this period.</p>
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
            <div
              className="h-full rounded-full"
              style={{ width: `${(r.n / max) * 100}%`, background: typeof color === 'function' ? color(r.k) : color || 'var(--color-brass)' }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

// Conversion rows: for each channel/type, booked / leads and a rate bar (greener = closes better).
function RateList({ rows }: { rows: { k: string; leads: number; booked: number; rate: number }[] }) {
  if (!rows.length) return <p className="text-[12.5px] text-faint">No data in this period.</p>
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

export function StatsPage({ projects }: { projects: Project[]; onOpenProject?: (p: Project) => void }) {
  const [period, setPeriod] = useState<Period>('year')
  const [basis, setBasis] = useState<Basis>('event')

  const s = useMemo(() => {
    const leads = projects.filter((p) => inRange(dateOf(p, basis), period))
    const won = leads.filter(isWon)
    const lost = leads.filter(isLost)
    const open = leads.filter((p) => p.bucket === 'active' && !isWon(p))
    const resolved = won.length + lost.length
    const closeRate = resolved ? won.length / resolved : 0
    const bookedRevenue = won.reduce((sum, p) => sum + (p.totalFee || 0), 0)
    const avgValue = won.length ? bookedRevenue / won.length : 0

    // Conversion by channel / by type (only buckets with at least one lead).
    const rateBy = (keyFn: (p: Project) => string) => {
      const keys = [...new Set(leads.map(keyFn))]
      return keys
        .map((k) => {
          const ls = leads.filter((p) => keyFn(p) === k)
          const b = ls.filter(isWon).length
          return { k, leads: ls.length, booked: b, rate: ls.length ? b / ls.length : 0 }
        })
        .sort((a, b) => b.leads - a.leads)
    }

    const monthMap = new Map<string, number>()
    for (const p of leads) {
      const d = dateOf(p, basis)
      if (/^\d{4}-\d{2}/.test(d)) monthMap.set(d.slice(0, 7), (monthMap.get(d.slice(0, 7)) || 0) + 1)
    }
    const months = [...monthMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, n]) => ({ k, n }))

    return {
      total: leads.length,
      won: won.length,
      lost: lost.length,
      open: open.length,
      closeRate,
      bookedRevenue,
      avgValue,
      months,
      datedCount: leads.filter((p) => /^\d{4}-\d{2}/.test(dateOf(p, basis))).length,
      sources: tally(leads, (p) => normalizeSource(p.bookingSource)),
      leadTypes: tally(leads, (p) => p.eventType),
      bookedTypes: tally(won, (p) => p.eventType),
      lostReasons: tally(lost, (p) => p.archiveReason || 'Unspecified'),
      rateBySource: rateBy((p) => normalizeSource(p.bookingSource)),
      rateByType: rateBy((p) => p.eventType),
    }
  }, [projects, period, basis])

  const typeColor = (k: string) => EVENT_TYPE_ACCENT[k as EventType] || 'var(--color-faint)'

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.35 }}
      className="board-scroll h-full overflow-y-auto px-8 pb-12"
    >
      {/* Period + date-basis toggles */}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1 rounded-xl border border-line bg-surface/60 p-1">
          {(
            [
              ['year', `This year (${THIS_YEAR})`],
              ['last12', 'Last 12 months'],
              ['last30', 'Last 30 days'],
              ['all', 'All-time'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setPeriod(id)}
              className={[
                'rounded-lg px-4 py-1.5 text-[12.5px] font-semibold transition-colors duration-200',
                period === id ? 'bg-surface-3 text-brass-bright shadow-[inset_0_0_0_1px_var(--color-brass-dim)]' : 'text-muted hover:text-parchment',
              ].join(' ')}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 rounded-xl border border-line bg-surface/60 p-1">
          {(
            [
              ['event', 'By event date'],
              ['lead', 'By lead date'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setBasis(id)}
              className={[
                'rounded-lg px-4 py-1.5 text-[12.5px] font-semibold transition-colors duration-200',
                basis === id ? 'bg-surface-3 text-brass-bright shadow-[inset_0_0_0_1px_var(--color-brass-dim)]' : 'text-muted hover:text-parchment',
              ].join(' ')}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Data caveats */}
      <div className="mb-6 rounded-lg border border-line bg-surface/50 px-4 py-2.5 text-[12px] leading-relaxed text-muted">
        Heads up: most historical lost/archived leads from HoneyBook aren't loaded yet, so the close rate reads high and the lost-reason
        mix is thin. Lead dates are backfilled from your inquiry emails; the <span className="text-parchment">by lead date</span> view only
        includes leads that have one ({s.datedCount} of {s.total} in view).
      </div>

      {/* Overview numbers */}
      <div className="mb-8 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Leads" value={String(s.total)} accent="var(--color-brass)" />
        <StatCard label="Booked" value={String(s.won)} sub={`${pct(s.closeRate)} close rate`} accent="var(--color-umb-booked)" />
        <StatCard label="Lost" value={String(s.lost)} accent="var(--color-red)" />
        <StatCard label="Still open" value={String(s.open)} accent="var(--color-umb-inquiry)" />
        <StatCard label="Booked revenue" value={money(s.bookedRevenue)} accent="var(--color-brass)" />
        <StatCard label="Avg booking" value={money(s.avgValue)} accent="var(--color-brass)" />
      </div>

      {/* Leads over time */}
      <div className="mb-8">
        <div className={CARD}>
          <div className={SECTION}>Leads over time · by {basis === 'lead' ? 'lead date' : 'event date'}</div>
          <MonthBars rows={s.months} />
        </div>
      </div>

      {/* Sources */}
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

      {/* Event types */}
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
    </motion.div>
  )
}
