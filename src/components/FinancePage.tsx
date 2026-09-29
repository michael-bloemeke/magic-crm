import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { byEventDateAsc, formatEventDate, type Project } from '../pipeline'
import { evalNumberFormula } from '../calc'
import {
  addExpense as apiAddExpense,
  addPayment as apiAddPayment,
  addTrip as apiAddTrip,
  deleteExpense as apiDeleteExpense,
  deletePayment as apiDeletePayment,
  deleteTrip as apiDeleteTrip,
  loadBankBalances,
  loadBusinessExpenses,
  loadExpenses,
  loadFinance,
  loadMileage,
  loadPayments,
  saveConfig,
  setMileageRate as apiSetRate,
  PAYMENT_METHODS,
  type BankBalances,
  type BreakdownItem,
  type BusinessExpenses,
  type Expense,
  type FinanceBasis,
  type FinanceSummary,
  type MileageData,
  type MonthMoney,
  type Payment,
} from '../api'

// A figure on the overview can be opened to show which projects fed it.
type Breakdown = { title: string; subtitle?: string; items: BreakdownItem[] }

const money = (n: number) => {
  const v = Math.round(n || 0)
  return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US')
}
// To the penny. Michael, 2026-09-28: "you can include dollars and cents." Used only for the figures
// that come from QuickBooks, which is the ledger of the actual money; everything derived from the
// quote stays in round dollars, because cents on a number that was never exact is false precision.
const money2 = (n: number) =>
  ((n || 0) < 0 ? '-$' : '$') +
  Math.abs(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
// 'YYYY-MM' -> 'Jan 2026'. Used for the note that says which months an expense figure covers.
const monthName = (key: string) => {
  const m = /^(\d{4})-(\d{2})$/.exec(key || '')
  if (!m) return key
  return new Date(Number(m[1]), Number(m[2]) - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
}
const todayISO = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

type Tab = 'overview' | 'payments' | 'tips' | 'expenses' | 'mileage'

export function FinancePage({ projects, onOpenProject }: { projects: Project[]; onOpenProject?: (p: Project) => void }) {
  const [tab, setTab] = useState<Tab>('overview')
  // Open a referenced project from anywhere on the Finance page (breakdown,
  // payments, tips). Resolves the id to the loaded Project, then hands it up.
  const openId = (id: string) => {
    const p = projects.find((x) => x.id === id)
    if (p) onOpenProject?.(p)
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.35 }}
      className="board-scroll h-full overflow-y-auto px-8 pb-12"
    >
      {/* Sub-tabs */}
      <div className="mb-6 flex items-center gap-1 rounded-xl border border-line bg-surface/60 p-1 w-fit">
        {(
          [
            ['overview', 'Overview'],
            ['payments', 'Payments'],
            ['tips', 'Tips'],
            ['expenses', 'Expenses'],
            ['mileage', 'Mileage'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={[
              'rounded-lg px-4 py-1.5 text-[12.5px] font-semibold transition-colors duration-200',
              tab === id
                ? 'bg-surface-3 text-brass-bright shadow-[inset_0_0_0_1px_var(--color-brass-dim)]'
                : 'text-muted hover:text-parchment',
            ].join(' ')}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'overview' && <Overview onOpenProject={openId} />}
      {tab === 'payments' && <Payments projects={projects} onOpenProject={openId} />}
      {tab === 'tips' && <Tips projects={projects} onOpenProject={openId} />}
      {tab === 'expenses' && <Expenses />}
      {tab === 'mileage' && <Mileage projects={projects} />}
    </motion.div>
  )
}

// --- Overview ----------------------------------------------------------------

function Overview({ onOpenProject }: { onOpenProject?: (id: string) => void }) {
  const [data, setData] = useState<FinanceSummary | null>(null)
  const [basis, setBasis] = useState<FinanceBasis>('received')
  const [includeTips, setIncludeTips] = useState(false)
  const [editingGoals, setEditingGoals] = useState(false)
  const [goalDraft, setGoalDraft] = useState<string[]>([])
  const [editingMonthly, setEditingMonthly] = useState(false)
  const [monthlyDraft, setMonthlyDraft] = useState('')
  const [breakdown, setBreakdown] = useState<Breakdown | null>(null)
  const [expenses, setExpenses] = useState<BusinessExpenses | null>(null)

  useEffect(() => {
    loadFinance()
      .then(setData)
      .catch(() => setData(null))
  }, [])

  // Separate from loadFinance on purpose. This one goes out to QuickBooks, and the Finance page
  // must not sit blank waiting for it, nor break when it is down.
  useEffect(() => {
    loadBusinessExpenses()
      .then(setExpenses)
      .catch(() => setExpenses(null))
  }, [])

  if (!data) return <p className="animate-pulse text-[13px] text-faint">Loading finances…</p>

  const startEditGoals = () => {
    setGoalDraft(data.goals.map((g) => String(g.goal)))
    setEditingGoals(true)
  }
  const saveGoals = async () => {
    const nums = goalDraft.map((s) => Number(String(s).replace(/[^0-9.]/g, ''))).filter((n) => n > 0)
    await saveConfig({ incomeGoals: nums.length ? nums : [80000] })
    setData(await loadFinance())
    setEditingGoals(false)
  }
  const startEditMonthly = () => {
    setMonthlyDraft(String(data.monthlyGoal))
    setEditingMonthly(true)
  }
  const saveMonthly = async () => {
    const n = Number(monthlyDraft.replace(/[^0-9.]/g, ''))
    await saveConfig({ monthlyGoal: n > 0 ? n : 10000 })
    setData(await loadFinance())
    setEditingMonthly(false)
  }

  // Every figure reads from the PAYMENTS field. The basis only changes which month
  // a payment counts in (received = month it arrived, earned = its event month).
  // Tips fold in only when the toggle is on.
  const valueOf = (m: MonthMoney) => (basis === 'received' ? m.received : m.earned) + (includeTips ? m.tips : 0)
  const baseItems = (m: MonthMoney) => (basis === 'received' ? m.receivedItems : m.earnedItems)
  const itemsOf = (m: MonthMoney) =>
    includeTips ? [...baseItems(m), ...m.tipItems.map((t) => ({ ...t, name: `${t.name} · tip` }))] : baseItems(m)

  const basisLabel = basis === 'received' ? 'Money received' : 'Money earned'
  const tipNote = includeTips ? ' + tips' : ''
  const itemSubtitle =
    (basis === 'received' ? 'Payments by date received, by project' : 'Payments by event month, by project') +
    (includeTips ? ' (tips included)' : '')
  const last12Value = valueOf(data.last12)

  // ---- MONEY RECEIVED NOW COMES FROM QUICKBOOKS ----
  //
  // Michael, 2026-09-28: "Can you change that so that it's being pulled from QuickBooks instead of
  // being just calculated by adding up all of the money from gigs? I think QuickBooks is much more
  // accurate."
  //
  // He is right about what it measures. The CRM logs the QUOTE; QuickBooks records what actually
  // landed, including the 3% card fee he adds on top, so for September the CRM says $10,355 and
  // QuickBooks says $9,426.37 for the same nine gigs plus one the CRM had not caught.
  //
  // ⚠️ BLENDED PER MONTH, on his instruction, because QuickBooks holds nothing before January 2026
  // and an uncovered month reports 0.00 rather than saying it does not know. Taking QuickBooks at
  // face value for the whole window would show $66,798 instead of $96,270 and drop his annual goal
  // bar from 96% to 66%, none of which would be real. So each month uses QuickBooks where
  // QuickBooks has data and the CRM's logged payments where it does not, and the card says which
  // months came from where. As QuickBooks fills in, the CRM half shrinks on its own.
  const crmReceived = (m: MonthMoney) => m.received + (includeTips ? m.tips : 0)
  const qbMonths = expenses?.connected ? expenses.months || [] : []
  const qbByMonth = new Map(qbMonths.map((m) => [m.month, m]))
  const usingQuickBooks = qbMonths.some((m) => m.covered)

  // One month's money, from whichever ledger can speak for it. Tips are a CRM concept and are added
  // on top either way: a cash tip never went through QuickBooks.
  const moneyFor = (m: MonthPoint) => {
    const qb = qbByMonth.get(m.key)
    if (qb?.covered) return qb.income + (includeTips ? m.tips : 0)
    return crmReceived(m)
  }
  const thisMonthKey = data.months.length ? data.months[data.months.length - 1].key : ''
  const thisMonthQb = qbByMonth.get(thisMonthKey)
  const thisMonthValue = thisMonthQb?.covered
    ? thisMonthQb.income + (includeTips ? data.thisMonth.tips : 0)
    : crmReceived(data.thisMonth)
  const last12Received = usingQuickBooks
    ? data.months.reduce((sum, m) => sum + moneyFor(m), 0)
    : crmReceived(data.last12)
  // The goal bars follow the card above them. On the earned basis there is no QuickBooks
  // equivalent, so they stay on the CRM figure, which is what that basis means anyway.
  const goalValue = basis === 'received' && usingQuickBooks ? last12Received : last12Value

  // Which months in the window the CRM still has to cover for. Named on the card so the blend is
  // visible rather than a silent mixture of two ledgers.
  const crmMonths = usingQuickBooks ? data.months.filter((m) => !qbByMonth.get(m.key)?.covered) : []
  const blendNote = crmMonths.length
    ? `${monthName(crmMonths[0].key)} to ${monthName(crmMonths[crmMonths.length - 1].key)} from your logged payments. QuickBooks starts ${monthName(expenses?.dataStartsMonth || '')}.`
    : undefined

  // Expenses, for the "after business expenses" line. Same per-month coverage rule: only months
  // QuickBooks can vouch for are netted off, and the income they are netted against is those same
  // months, so the two sides always describe one period.
  const coveredMonths = qbMonths.filter((m) => m.covered)
  const windowExpenses = coveredMonths.reduce((sum, m) => sum + m.expenses, 0)
  const windowReceivedForExpenses = data.months
    .filter((m) => qbByMonth.get(m.key)?.covered)
    .reduce((sum, m) => sum + moneyFor(m), 0)
  const expenseNote =
    coveredMonths.length && coveredMonths.length < qbMonths.length
      ? `${monthName(coveredMonths[0].month)} onward only. QuickBooks has no expenses before then.`
      : undefined
  // Month blocks fill toward the monthly goal (100% at goal or above), not relative
  // to the highest month.
  const monthlyGoal = Math.max(1, data.monthlyGoal)

  return (
    <div className="space-y-8">
      {/* Master controls: one basis toggle + tips toggle drive the whole page */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-[12px] leading-snug text-muted">
          <span className="text-parchment">Money received</span> comes from{' '}
          <span className="text-parchment">QuickBooks</span> for every month it covers, and from the{' '}
          <span className="text-parchment">payments</span> you've logged before that. It counts money in the month it
          arrived. <span className="text-parchment">Money earned</span> is your logged payments only, counted in the
          gig's event month. The quote and tips stay out unless you turn tips on.
        </p>
        <div className="flex items-center gap-3">
          <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-muted">
            <input
              type="checkbox"
              checked={includeTips}
              onChange={(e) => setIncludeTips(e.target.checked)}
              className="h-3.5 w-3.5 accent-[var(--color-brass)]"
            />
            Include tips
          </label>
          <BasisToggle value={basis} onChange={setBasis} />
        </div>
      </div>

      {/* What is actually sitting in the bank right now. Separate from everything else on this
          page, because every other figure here is derived from logged payments and this one is
          read straight off the accounts. */}
      <BankBalancesCard />

      {/* Stat cards: This month / Last 12 months / Still expected */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Card label={`This month${tipNote}`}>
          <Figure
            label={basisLabel}
            value={basis === 'received' && thisMonthQb?.covered ? money2(thisMonthValue) : money(valueOf(data.thisMonth))}
            hint={
              basis === 'received'
                ? thisMonthQb?.covered
                  ? 'money that hit your account this month, from QuickBooks'
                  : 'money that hit your account this month'
                : 'payments for gigs performed this month'
            }
            onClick={() =>
              setBreakdown({ title: `This month · ${basisLabel}`, subtitle: itemSubtitle, items: itemsOf(data.thisMonth) })
            }
          />
          {thisMonthQb?.covered && (
            <NetOfExpenses received={thisMonthValue} expenses={thisMonthQb.expenses} basis={basis} />
          )}
        </Card>

        <Card label={`Last 12 months${tipNote}`}>
          <Figure
            label={basisLabel}
            value={basis === 'received' && usingQuickBooks ? money2(last12Received) : money(last12Value)}
            hint={
              basis === 'received'
                ? usingQuickBooks
                  ? 'money received over the last 12 months, from QuickBooks'
                  : 'money received over the last 12 months'
                : 'payments by event month, last 12 months'
            }
            note={basis === 'received' ? blendNote : undefined}
            onClick={() =>
              setBreakdown({ title: `Last 12 months · ${basisLabel}`, subtitle: itemSubtitle, items: itemsOf(data.last12) })
            }
          />
          {coveredMonths.length > 0 && (
            <NetOfExpenses
              received={windowReceivedForExpenses}
              expenses={windowExpenses}
              periodNote={expenseNote}
              basis={basis}
            />
          )}
        </Card>

        <Card label="Still expected to come in">
          <button
            type="button"
            onClick={() =>
              setBreakdown({
                title: 'Still expected to come in',
                subtitle: 'Quote minus what each active gig has already paid',
                items: data.expectedItems,
              })
            }
            title="See the breakdown"
            className="-m-1 block w-full rounded-lg p-1 text-left transition-colors hover:bg-surface-3/60"
          >
            <p className="font-display text-[30px] leading-none tabular-nums" style={{ color: 'var(--color-umb-postcall)' }}>
              {money(data.expectedRemaining)}
            </p>
            <p className="mt-1 text-[11.5px] text-muted">if every active gig closes and no one cancels</p>
            <p className="mt-1 text-[11px] text-faint">from the quote, not yet in the door</p>
          </button>
        </Card>
      </div>

      {/* Goals */}
      <section>
        <div className="mb-3 flex items-center gap-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-brass-dim">Goals</h3>
          {!editingGoals ? (
            <button
              type="button"
              onClick={startEditGoals}
              className="rounded-md border border-line px-2 py-0.5 text-[11px] font-medium text-muted transition-colors hover:border-line-strong hover:text-parchment"
            >
              Edit
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={saveGoals}
                className="rounded-md border border-brass-dim/60 bg-surface-3 px-2.5 py-0.5 text-[11px] font-semibold text-brass-bright transition-colors hover:border-brass"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => setEditingGoals(false)}
                className="rounded-md border border-line px-2 py-0.5 text-[11px] font-medium text-muted hover:text-parchment"
              >
                Cancel
              </button>
            </div>
          )}
        </div>

        {editingGoals ? (
          <div className="space-y-2">
            {goalDraft.map((g, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="text-[13px] text-muted">$</span>
                <input
                  value={g}
                  onChange={(e) => setGoalDraft((d) => d.map((x, j) => (j === i ? e.target.value : x)))}
                  className="input w-32"
                  placeholder="Goal amount"
                />
                <span className="text-[12px] text-faint">/ yr</span>
                <button
                  type="button"
                  onClick={() => setGoalDraft((d) => d.filter((_, j) => j !== i))}
                  className="text-faint transition-colors hover:text-[#dc2626]"
                  title="Remove"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setGoalDraft((d) => [...d, ''])}
              className="text-[12px] font-medium text-brass-dim transition-colors hover:text-brass"
            >
              + Add goal
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {/* Tracks the same number the Last 12 months card shows, so the two can never disagree
                about how the year is going. */}
            {data.goals.map((g) => (
              <GoalBar key={g.goal} goal={g.goal} value={goalValue} />
            ))}
          </div>
        )}

        {!editingGoals && (
          <p className="mt-2 text-[11.5px] text-faint">
            Tracking {basisLabel.toLowerCase()} over the last 12 months against each goal
            {includeTips ? ', tips included' : ''}
            {basis === 'received' && usingQuickBooks ? ', from QuickBooks where it has the data' : ''}.
          </p>
        )}
      </section>

      {/* 12-month blocks */}
      <section>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-brass-dim">Month by month</h3>
          {editingMonthly ? (
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-faint">Goal $</span>
              <input
                autoFocus
                value={monthlyDraft}
                onChange={(e) => setMonthlyDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveMonthly()
                  if (e.key === 'Escape') setEditingMonthly(false)
                }}
                className="w-24 rounded-md border border-line bg-surface-2/40 px-2 py-1 text-[12px] tabular-nums text-parchment outline-none focus:border-brass-dim"
              />
              <button
                type="button"
                onClick={saveMonthly}
                className="rounded-md border border-brass-dim/60 px-2 py-1 text-[11px] font-semibold text-brass-bright hover:border-brass"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => setEditingMonthly(false)}
                className="px-1 text-[11px] text-faint hover:text-muted"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={startEditMonthly}
              className="text-[11px] text-faint underline-offset-2 transition-colors hover:text-muted hover:underline"
            >
              Goal {money(data.monthlyGoal)}/mo · edit
            </button>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {/* The blocks use the SAME number as the cards above, so a month cannot read $10,355 here
              and $9,426.37 four inches higher up. The breakdown behind each one is still the CRM's
              per-project list, because that is the only thing that knows which gig was which; the
              sheet says so when the total came from QuickBooks. */}
          {data.months.map((m) => {
            const fromQb = basis === 'received' && !!qbByMonth.get(m.key)?.covered
            const val = basis === 'received' && usingQuickBooks ? moneyFor(m) : valueOf(m)
            const pct = Math.min(1, val / monthlyGoal)
            return (
              <button
                type="button"
                key={m.key}
                onClick={() =>
                  setBreakdown({
                    title: `${m.label} · ${basisLabel}`,
                    subtitle: fromQb
                      ? `${itemSubtitle}. The month's total comes from QuickBooks; this is the gig-by-gig record behind it.`
                      : itemSubtitle,
                    items: itemsOf(m),
                  })
                }
                title={`${money(val)} of ${money(data.monthlyGoal)} goal · see the breakdown`}
                className="relative overflow-hidden rounded-xl border border-line bg-surface-2/60 p-3 text-left transition-colors hover:border-line-strong"
              >
                <div
                  className="absolute inset-x-0 bottom-0"
                  style={{
                    height: `${pct * 100}%`,
                    backgroundColor: 'color-mix(in oklab, var(--color-umb-booked) 28%, transparent)',
                  }}
                  aria-hidden
                />
                <div className="relative">
                  <p className="text-[10.5px] uppercase tracking-[0.12em] text-faint">{m.label}</p>
                  <p className="mt-1 font-display text-[18px] leading-none tabular-nums text-parchment">{money(val)}</p>
                </div>
              </button>
            )
          })}
        </div>
        {!data.hasPayments && (
          <p className="mt-2 text-[11.5px] text-faint">
            No payments logged yet. Log them on each project (or the Payments tab) and these figures fill in.
          </p>
        )}
      </section>

      <BreakdownModal breakdown={breakdown} onClose={() => setBreakdown(null)} onOpenProject={onOpenProject} />
    </div>
  )
}

// Popover that shows which projects fed a given figure, and how much from each.
// A project name that links to its project when an opener is provided, else plain text.
function ProjectNameLink({
  id,
  name,
  onOpen,
  className,
}: {
  id: string
  name: string
  onOpen?: (id: string) => void
  className?: string
}) {
  if (!onOpen || !id) return <span className={className}>{name}</span>
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onOpen(id)
      }}
      title="Open this project"
      className={[className, 'block cursor-pointer text-left underline-offset-2 transition-colors hover:text-brass hover:underline'].filter(Boolean).join(' ')}
    >
      {name}
    </button>
  )
}

function BreakdownModal({ breakdown, onClose, onOpenProject }: { breakdown: Breakdown | null; onClose: () => void; onOpenProject?: (id: string) => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    if (breakdown) window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [breakdown, onClose])

  const items = breakdown?.items ?? []
  const total = items.reduce((s, it) => s + it.amount, 0)

  return (
    <AnimatePresence>
      {breakdown && (
        <motion.div
          className="fixed inset-0 z-[60] flex items-start justify-center p-4 pt-[12vh]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
          <motion.div
            className="relative flex max-h-[70vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-line-strong bg-surface shadow-[0_30px_70px_-30px_rgba(0,0,0,0.18)]"
            initial={{ y: 16, opacity: 0.6, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 16, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="flex items-start justify-between gap-4 border-b border-line px-5 pb-3 pt-4">
              <div>
                <h2 className="font-display text-[17px] leading-tight text-parchment">{breakdown.title}</h2>
                {breakdown.subtitle && <p className="mt-0.5 text-[11.5px] text-faint">{breakdown.subtitle}</p>}
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="shrink-0 rounded-lg border border-line p-1.5 text-muted transition-colors hover:border-line-strong hover:text-parchment"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>

            <div className="board-scroll min-h-0 flex-1 overflow-y-auto px-2 py-2">
              {items.length === 0 ? (
                <p className="px-3 py-8 text-center text-[12.5px] text-faint">Nothing contributing to this figure yet.</p>
              ) : (
                items.map((it, i) => (
                  <div
                    key={(it.id || 'none') + i}
                    className={['flex items-center gap-3 rounded-lg px-3 py-2 text-[13px]', i % 2 ? 'bg-surface-2/30' : ''].join(' ')}
                  >
                    <ProjectNameLink
                      id={it.id}
                      name={it.name}
                      onOpen={onOpenProject}
                      className="min-w-0 flex-1 truncate text-parchment"
                    />
                    <span className="shrink-0 font-semibold tabular-nums text-brass">{money(it.amount)}</span>
                  </div>
                ))
              )}
            </div>

            {items.length > 0 && (
              <div className="flex items-center justify-between border-t border-line px-5 py-3 text-[13px]">
                <span className="text-faint">
                  {items.length} {items.length === 1 ? 'project' : 'projects'}
                </span>
                <span className="font-semibold tabular-nums text-brass">Total {money(total)}</span>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

// --- In the bank -------------------------------------------------------------
//
// READ ONLY. Coastal -> Plaid -> YNAB -> the bank-balances edge function -> here. Nothing on that
// path can move, deposit or withdraw money; the only thing fetched is a balance per account.
// Michael's ask was deliberately narrow: a number saying how much is sitting there, nothing else.
//
// Accounts are NOT hardcoded. Whatever is open in YNAB shows up, so when Magic Income is added to
// the Coastal link it appears here on its own with no code change.
//
// The figure shown is the CLEARED balance, which is what the bank says. YNAB's other balance
// includes transactions entered but not yet hit the bank, so a difference is flagged rather than
// silently averaged away.
function BankBalancesCard() {
  const [data, setData] = useState<BankBalances | null>(null)
  const [busy, setBusy] = useState(false)

  const load = (force = false) => {
    setBusy(true)
    loadBankBalances(force)
      .then(setData)
      .catch(() => setData({ ok: false, connected: false, generatedAt: '', accounts: [], reason: 'Could not reach the CRM server.' }))
      .finally(() => setBusy(false))
  }
  useEffect(() => load(false), [])

  if (!data) return null

  const when = data.generatedAt
    ? new Date(data.generatedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : ''

  return (
    <div className="rounded-2xl border border-line bg-surface-2/50 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-faint">In the bank</p>
        <div className="flex items-center gap-3">
          {data.connected && when && <span className="text-[11px] text-faint">as of {when}</span>}
          <button
            type="button"
            onClick={() => load(true)}
            disabled={busy}
            className="rounded-lg px-2 py-1 text-[11px] font-semibold text-muted transition-colors hover:text-parchment disabled:opacity-50"
          >
            {busy ? 'Checking…' : 'Refresh'}
          </button>
        </div>
      </div>

      {!data.connected ? (
        <div className="text-[12.5px] leading-relaxed text-muted">
          <p className="text-parchment">Not connected yet.</p>
          <p className="mt-1">
            This reads your balances from YNAB, which holds the read-only link to Coastal. Generate a personal access
            token in YNAB's account settings, then set it as a Supabase secret:
          </p>
          <code className="mt-2 block rounded-lg bg-surface-3/60 px-3 py-2 text-[11.5px] text-parchment">
            npx supabase secrets set YNAB_TOKEN=&lt;token&gt; --project-ref yfmacqvcmkogvkcxfjkr
          </code>
          {data.reason && <p className="mt-2 text-[11.5px] text-faint">{data.reason}</p>}
        </div>
      ) : data.accounts.length === 0 ? (
        <p className="text-[12.5px] text-muted">
          Connected to YNAB, but no open accounts came back. Check that Coastal is still linked in YNAB.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.accounts.map((a) => {
              const drift = Math.abs(a.balance - a.cleared) >= 0.01
              // ⚠️ THIS NUMBER IS YNAB'S LEDGER, NOT THE BANK'S BALANCE, and the two drift apart.
              // YNAB reconstructs a balance from a starting figure plus whatever transactions it
              // managed to import. If the bank sync misses anything, the number silently goes wrong
              // and keeps going wrong. On 2026-09-10 it read -$2,039 against a real balance of
              // $1,162, because the account had not been reconciled since the day it was set up.
              // So the reconcile date is shown, and shouted about once it goes stale. Without it
              // this card is confidently wrong and gives no clue that it is.
              const rec = a.lastReconciledAt ? new Date(a.lastReconciledAt) : null
              const daysStale = rec ? Math.floor((Date.now() - rec.getTime()) / 86_400_000) : null
              const stale = daysStale === null || daysStale > 7
              return (
                <div key={a.id} className="rounded-xl border border-line bg-surface-3/40 px-3 py-3">
                  <p className="truncate text-[12px] font-semibold text-parchment" title={a.name}>
                    {a.name}
                  </p>
                  <p
                    className="mt-1 font-display text-[26px] leading-none tabular-nums"
                    style={{ color: a.cleared < 0 ? 'var(--color-umb-postcall)' : 'var(--color-brass)' }}
                  >
                    {money(a.cleared)}
                  </p>
                  {drift && (
                    <p className="mt-1 text-[11px] text-faint" title="YNAB has transactions entered that have not reached the bank yet">
                      {money(a.balance)} in YNAB
                    </p>
                  )}
                  <p
                    className={`mt-1 text-[11px] ${stale ? 'text-[var(--color-umb-postcall)]' : 'text-faint'}`}
                    title="YNAB rebuilds this from imported transactions. It is only known-correct as of the last reconcile against the bank."
                  >
                    {rec
                      ? daysStale === 0
                        ? 'Reconciled today'
                        : `Reconciled ${daysStale} day${daysStale === 1 ? '' : 's'} ago${stale ? ', may be wrong' : ''}`
                      : 'Never reconciled, treat as unreliable'}
                  </p>
                </div>
              )
            })}
          </div>
          {data.accounts.length > 1 && typeof data.total === 'number' && (
            <p className="mt-3 text-[11.5px] text-faint">
              Across every account: <span className="text-muted tabular-nums">{money(data.total)}</span>
            </p>
          )}
          {data.budgetName && <p className="mt-1 text-[11px] text-faint">YNAB budget: {data.budgetName}</p>}
        </>
      )}
    </div>
  )
}

function Card({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-line bg-surface-2/50 p-4">
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-faint">{label}</p>
      {children}
    </div>
  )
}
function Figure({
  label,
  value,
  hint,
  note,
  color = 'var(--color-brass)',
  onClick,
}: {
  label: string
  value: string
  hint?: string
  // A caveat about where the figure came from. Amber, because it qualifies the number above it.
  note?: string
  color?: string
  onClick?: () => void
}) {
  const content = (
    <>
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">{label}</p>
      <p className="mt-1 font-display text-[26px] leading-none tabular-nums" style={{ color }}>
        {value}
      </p>
      {hint && <p className="mt-1 max-w-[15rem] text-[11px] leading-snug text-faint">{hint}</p>}
      {note && (
        <p className="mt-1 max-w-[17rem] text-[11px] leading-snug" style={{ color: 'var(--color-umb-archive)' }}>
          {note}
        </p>
      )}
    </>
  )
  if (!onClick) return <div>{content}</div>
  return (
    <button type="button" onClick={onClick} title="See the breakdown" className="-m-1 rounded-lg p-1 text-left transition-colors hover:bg-surface-3/60">
      {content}
    </button>
  )
}

// What he actually kept: money received, less what QuickBooks says went back out.
//
// Michael, 2026-09-28: "I want to know how much money I've received that didn't have to get spent
// on business expenses." It sits UNDER the received figure rather than replacing it, because the
// gross number is still the one he checks against his goals.
//
// ⚠️ TWO LEDGERS, AND THEY DO NOT COVER THE SAME PERIOD. The income is the CRM's logged payments;
// the expenses are QuickBooks, which holds nothing before January 2026 while the CRM has payments
// back to May 2025. When the periods differ this nets off only the months QuickBooks can vouch for
// and says which ones, rather than quietly subtracting nine months of spending from twelve months
// of income and flattering the answer by about three months of costs.
//
// It is always computed from RECEIVED, whichever basis the page is on, and says so. Netting
// expenses off "money earned" (payments sorted into their gig's event month) would be comparing
// money that left the bank this month against money attributed to a gig next March.
function NetOfExpenses({
  received,
  expenses,
  periodNote,
  basis,
}: {
  received: number
  expenses: number
  periodNote?: string
  basis: FinanceBasis
}) {
  return (
    <div className="mt-3 border-t border-line/70 pt-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">
        {basis === 'received' ? 'After business expenses' : 'Received, after business expenses'}
      </p>
      <p className="mt-1 font-display text-[21px] leading-none tabular-nums" style={{ color: 'var(--color-umb-booked)' }}>
        {money2(received - expenses)}
      </p>
      <p className="mt-1 text-[11px] leading-snug text-faint">
        received less {money2(expenses)} of expenses, from QuickBooks
      </p>
      {/* On the EARNED basis this line's figure is bigger than the headline above it, which reads
          as a fault unless the mismatch is explained. It stays on the received basis on purpose:
          netting money that actually left the bank this month against money attributed to a gig
          next March would not mean anything. */}
      {basis === 'earned' && (
        <p className="mt-0.5 text-[11px] leading-snug text-faint">
          still on money received, not earned, so expenses line up with the month they were paid
        </p>
      )}
      {periodNote && (
        <p className="mt-0.5 text-[11px] leading-snug" style={{ color: 'var(--color-umb-archive)' }}>
          {periodNote}
        </p>
      )}
    </div>
  )
}

// Money received (by payment date) vs Money earned (by the gig's event month).
// One master toggle drives the whole overview.
function BasisToggle({ value, onChange }: { value: FinanceBasis; onChange: (v: FinanceBasis) => void }) {
  return (
    <div className="flex items-center gap-1 rounded-lg border border-line bg-surface/60 p-0.5">
      {(
        [
          ['received', 'Received'],
          ['earned', 'Earned'],
        ] as const
      ).map(([id, label]) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          className={[
            'rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors',
            value === id ? 'bg-surface-3 text-brass-bright' : 'text-muted hover:text-parchment',
          ].join(' ')}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

function GoalBar({ goal, value }: { goal: number; value: number }) {
  const pct = goal ? value / goal : 0
  const w = Math.min(100, Math.max(0, pct * 100))
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2 text-[12px]">
        <span className="font-semibold text-parchment">${(goal / 1000).toLocaleString('en-US')}k / yr</span>
        <span className="tabular-nums text-muted">
          {money(value)} ({Math.round(pct * 100)}%)
        </span>
      </div>
      <div className="relative h-2.5 overflow-hidden rounded-full bg-surface-3">
        <div className="absolute inset-y-0 left-0 rounded-full bg-brass" style={{ width: `${w}%` }} />
      </div>
    </div>
  )
}

// --- Payments ----------------------------------------------------------------

function Payments({ projects, onOpenProject }: { projects: Project[]; onOpenProject?: (id: string) => void }) {
  const [payments, setPayments] = useState<Payment[] | null>(null)
  const [amount, setAmount] = useState('')
  const [projectId, setProjectId] = useState('')
  const [date, setDate] = useState(todayISO())
  const [type, setType] = useState('deposit')
  const [method, setMethod] = useState('QuickBooks invoice')

  useEffect(() => {
    loadPayments()
      .then(setPayments)
      .catch(() => setPayments([]))
  }, [])

  const byName = useMemo(() => [...projects].sort((a, b) => a.client.localeCompare(b.client)), [projects])
  const nameFor = (id: string) => projects.find((p) => p.id === id)?.client ?? id

  const add = async () => {
    if (!amount.trim()) return
    const p = await apiAddPayment({ projectId, amount, dateReceived: date, type, method })
    setPayments((prev) => [p, ...(prev ?? [])])
    setAmount('')
  }
  const remove = (id: string) => {
    setPayments((prev) => (prev ?? []).filter((p) => p.id !== id))
    apiDeletePayment(id).catch(() => {})
  }

  const sorted = (payments ?? []).slice().sort((a, b) => (b.dateReceived || '').localeCompare(a.dateReceived || ''))
  const total = sorted.reduce((s, p) => s + (p.amount || 0), 0)

  return (
    <div className="max-w-3xl space-y-5">
      <p className="text-[12.5px] leading-relaxed text-muted">
        Log a payment when money actually lands (deposits, balances). This drives the cash-basis figures, so you can see
        what you literally brought in each month vs. what you earned from the events you performed.
      </p>

      <div className="flex flex-wrap items-end gap-2 rounded-xl border border-line bg-surface-2/50 p-3">
        <Field label="Date">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="input" />
        </Field>
        <Field label="Amount">
          <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="$" className="input w-28" />
        </Field>
        <Field label="Project">
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="input min-w-[180px]">
            <option value="">(none)</option>
            {byName.map((p) => (
              <option key={p.id} value={p.id}>
                {p.client}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Type">
          <select value={type} onChange={(e) => setType(e.target.value)} className="input">
            <option value="deposit">Deposit</option>
            <option value="balance">Balance</option>
            <option value="full">Full</option>
            <option value="other">Other</option>
          </select>
        </Field>
        <Field label="Method">
          <select value={method} onChange={(e) => setMethod(e.target.value)} className="input">
            <option value="">—</option>
            {PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Field>
        <button
          type="button"
          onClick={add}
          disabled={!amount.trim()}
          className="rounded-lg border border-brass-dim/60 bg-surface-3 px-4 py-2 text-[13px] font-semibold text-brass-bright transition-colors hover:border-brass disabled:opacity-40"
        >
          Add
        </button>
      </div>

      {!payments ? (
        <p className="animate-pulse text-[13px] text-faint">Loading…</p>
      ) : sorted.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-4 py-10 text-center text-[12.5px] text-faint">
          No payments logged yet.
        </p>
      ) : (
        <div>
          <div className="mb-2 flex items-center justify-between text-[12px]">
            <span className="text-faint">{sorted.length} payments</span>
            <span className="font-semibold tabular-nums text-brass">Total logged {money(total)}</span>
          </div>
          <div className="overflow-hidden rounded-xl border border-line">
            {sorted.map((p, i) => (
              <div
                key={p.id}
                className={['group flex items-center gap-3 px-3 py-2.5 text-[13px]', i % 2 ? 'bg-surface-2/40' : 'bg-surface-2/20'].join(' ')}
              >
                <span className="w-24 shrink-0 tabular-nums text-muted">{formatEventDate(p.dateReceived)}</span>
                <ProjectNameLink
                  id={p.projectId}
                  name={nameFor(p.projectId) || '(unassigned)'}
                  onOpen={onOpenProject}
                  className="min-w-0 flex-1 truncate text-parchment"
                />
                {p.method && (
                  <span className="hidden shrink-0 rounded-full border border-line px-1.5 py-0.5 text-[10px] text-muted sm:inline">
                    {p.method}
                  </span>
                )}
                <span className="shrink-0 rounded-full border border-line px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-faint">
                  {p.type}
                </span>
                <span className="w-20 shrink-0 text-right font-semibold tabular-nums text-brass">{money(p.amount)}</span>
                <button
                  type="button"
                  onClick={() => remove(p.id)}
                  className="shrink-0 text-faint opacity-0 transition-opacity hover:text-[#dc2626] group-hover:opacity-100"
                  title="Delete"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// --- Tips --------------------------------------------------------------------
// A log of the tips field across projects, totaled over a date range (by event
// date). These are kept OUT of the financial reports by default (the Overview has
// an "Include tips" toggle for that); this tab is for tracking them on their own.
// An optional view also flags gigs that paid MORE than their quote (the implicit
// "tips" baked into an overpayment, which DO live in the payments/income figures).

function Tips({ projects, onOpenProject }: { projects: Project[]; onOpenProject?: (id: string) => void }) {
  const [payments, setPayments] = useState<Payment[] | null>(null)
  const [showOverpaid, setShowOverpaid] = useState(false)
  // Default range = the current calendar month.
  const now = todayISO()
  const monthStart = now.slice(0, 8) + '01'
  const [start, setStart] = useState(monthStart)
  const [end, setEnd] = useState(now)

  useEffect(() => {
    loadPayments()
      .then(setPayments)
      .catch(() => setPayments([]))
  }, [])

  const inRange = (iso: string) => !!iso && (!start || iso >= start) && (!end || iso <= end)

  const tipped = useMemo(
    () =>
      projects
        .filter((p) => (p.tips ?? 0) > 0 && inRange(p.eventDate))
        .sort((a, b) => (b.eventDate || '').localeCompare(a.eventDate || '')),
    [projects, start, end],
  )
  const totalTips = tipped.reduce((s, p) => s + (p.tips || 0), 0)

  // Received total per project (real, non-pending payments) for the overpaid view.
  const receivedByProject = useMemo(() => {
    const by: Record<string, number> = {}
    for (const pm of payments ?? []) {
      if (pm.pending || !pm.dateReceived || !(pm.amount > 0)) continue
      by[pm.projectId] = (by[pm.projectId] || 0) + pm.amount
    }
    return by
  }, [payments])

  const overpaid = useMemo(
    () =>
      projects
        .filter((p) => p.totalFee != null && inRange(p.eventDate))
        .map((p) => ({ p, received: receivedByProject[p.id] || 0 }))
        .filter((x) => x.received > (x.p.totalFee || 0) + 0.005)
        .map((x) => ({ ...x, over: x.received - (x.p.totalFee || 0) }))
        .sort((a, b) => b.over - a.over),
    [projects, receivedByProject, start, end],
  )
  const totalOver = overpaid.reduce((s, x) => s + x.over, 0)

  return (
    <div className="max-w-3xl space-y-5">
      <p className="text-[12.5px] leading-relaxed text-muted">
        Tips you've logged on your projects, totaled by event date. These are kept out of the income figures by default
        (the Overview has an "Include tips" toggle if you want to fold them in).
      </p>

      <div className="flex flex-wrap items-end gap-2 rounded-xl border border-line bg-surface-2/50 p-3">
        <Field label="From">
          <input type="date" value={start} onChange={(e) => setStart(e.target.value)} className="input" />
        </Field>
        <Field label="To">
          <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="input" />
        </Field>
        <div className="ml-auto text-right">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Tips in range</p>
          <p className="font-display text-[24px] leading-none tabular-nums text-brass">{money(totalTips)}</p>
        </div>
      </div>

      {!payments ? (
        <p className="animate-pulse text-[13px] text-faint">Loading…</p>
      ) : tipped.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-4 py-10 text-center text-[12.5px] text-faint">
          No tips logged in this range. Add a tip on a project's Details (next to the Quote).
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line">
          {tipped.map((p, i) => (
            <div
              key={p.id}
              className={['flex items-center gap-3 px-3 py-2.5 text-[13px]', i % 2 ? 'bg-surface-2/40' : 'bg-surface-2/20'].join(' ')}
            >
              <span className="w-24 shrink-0 tabular-nums text-muted">{formatEventDate(p.eventDate)}</span>
              <ProjectNameLink id={p.id} name={p.client} onOpen={onOpenProject} className="min-w-0 flex-1 truncate text-parchment" />
              <span className="shrink-0 rounded-full border border-line px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-faint">
                {p.tipsMethod || 'Cash'}
              </span>
              <span className="w-20 shrink-0 text-right font-semibold tabular-nums text-brass">{money(p.tips || 0)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Optional: gigs that were paid above their quote (overpayment = implicit tip) */}
      <div className="rounded-xl border border-line bg-surface-2/40 p-3">
        <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-parchment">
          <input
            type="checkbox"
            checked={showOverpaid}
            onChange={(e) => setShowOverpaid(e.target.checked)}
            className="h-3.5 w-3.5 accent-[var(--color-brass)]"
          />
          Show gigs paid above their quote
          <span className="text-[11.5px] text-faint">(overpayments, already counted in your income)</span>
        </label>

        {showOverpaid &&
          (overpaid.length === 0 ? (
            <p className="mt-3 text-center text-[12px] text-faint">No gigs were paid above quote in this range.</p>
          ) : (
            <div className="mt-3 overflow-hidden rounded-lg border border-line">
              <div className="flex items-center justify-between bg-surface-3/40 px-3 py-1.5 text-[11px] text-faint">
                <span>{overpaid.length} gigs over quote</span>
                <span className="font-semibold tabular-nums text-brass">+{money(totalOver)} over</span>
              </div>
              {overpaid.map(({ p, received, over }, i) => (
                <div
                  key={p.id}
                  className={['flex items-center gap-3 px-3 py-2.5 text-[13px]', i % 2 ? 'bg-surface-2/40' : 'bg-surface-2/20'].join(' ')}
                >
                  <span className="w-24 shrink-0 tabular-nums text-muted">{formatEventDate(p.eventDate)}</span>
                  <ProjectNameLink id={p.id} name={p.client} onOpen={onOpenProject} className="min-w-0 flex-1 truncate text-parchment" />
                  <span className="hidden shrink-0 text-[11.5px] tabular-nums text-faint sm:inline">
                    {money(p.totalFee || 0)} quote · {money(received)} paid
                  </span>
                  <span className="w-20 shrink-0 text-right font-semibold tabular-nums text-brass">+{money(over)}</span>
                </div>
              ))}
            </div>
          ))}
      </div>
    </div>
  )
}

// --- Expenses ----------------------------------------------------------------

const PER_MONTH: Record<Expense['cadence'], number> = {
  monthly: 1,
  quarterly: 1 / 3,
  yearly: 1 / 12,
  weekly: 52 / 12,
  'one-time': 0,
}

function Expenses() {
  const [expenses, setExpenses] = useState<Expense[] | null>(null)
  const [name, setName] = useState('')
  const [amount, setAmount] = useState('')
  const [cadence, setCadence] = useState('monthly')
  const [category, setCategory] = useState('')

  useEffect(() => {
    loadExpenses()
      .then(setExpenses)
      .catch(() => setExpenses([]))
  }, [])

  const add = async () => {
    if (!name.trim() || !amount.trim()) return
    const e = await apiAddExpense({ name, amount, cadence, category })
    setExpenses((prev) => [...(prev ?? []), e])
    setName('')
    setAmount('')
    setCategory('')
  }
  const remove = (id: string) => {
    setExpenses((prev) => (prev ?? []).filter((e) => e.id !== id))
    apiDeleteExpense(id).catch(() => {})
  }

  const list = expenses ?? []
  const monthly = list.reduce((s, e) => s + e.amount * (PER_MONTH[e.cadence] ?? 0), 0)
  const annual = monthly * 12

  return (
    <div className="max-w-3xl space-y-5">
      <p className="text-[12.5px] leading-relaxed text-muted">
        Your regular business overhead. This isn't a receipt-by-receipt ledger (a budgeting app is better for that). It
        tracks recurring/known costs so you get a monthly and annual overhead figure next to your earnings.
      </p>

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-2xl border border-line bg-surface-2/50 p-4">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-faint">Monthly overhead</p>
          <p className="font-display text-[26px] leading-none tabular-nums text-parchment">{money(monthly)}</p>
        </div>
        <div className="rounded-2xl border border-line bg-surface-2/50 p-4">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-faint">Annual overhead</p>
          <p className="font-display text-[26px] leading-none tabular-nums text-parchment">{money(annual)}</p>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-2 rounded-xl border border-line bg-surface-2/50 p-3">
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. HoneyBook" className="input min-w-[160px]" />
        </Field>
        <Field label="Amount">
          <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="$" className="input w-24" />
        </Field>
        <Field label="Cadence">
          <select value={cadence} onChange={(e) => setCadence(e.target.value)} className="input">
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly</option>
            <option value="yearly">Yearly</option>
            <option value="weekly">Weekly</option>
            <option value="one-time">One-time</option>
          </select>
        </Field>
        <Field label="Category">
          <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="optional" className="input w-28" />
        </Field>
        <button
          type="button"
          onClick={add}
          disabled={!name.trim() || !amount.trim()}
          className="rounded-lg border border-brass-dim/60 bg-surface-3 px-4 py-2 text-[13px] font-semibold text-brass-bright transition-colors hover:border-brass disabled:opacity-40"
        >
          Add
        </button>
      </div>

      {!expenses ? (
        <p className="animate-pulse text-[13px] text-faint">Loading…</p>
      ) : list.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-4 py-10 text-center text-[12.5px] text-faint">
          No expenses yet. Add your recurring business costs.
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line">
          {list.map((e, i) => (
            <div
              key={e.id}
              className={['group flex items-center gap-3 px-3 py-2.5 text-[13px]', i % 2 ? 'bg-surface-2/40' : 'bg-surface-2/20'].join(' ')}
            >
              <span className="min-w-0 flex-1 truncate text-parchment">
                {e.name}
                {e.category && <span className="ml-2 text-[11px] text-faint">{e.category}</span>}
              </span>
              <span className="shrink-0 rounded-full border border-line px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-faint">
                {e.cadence}
              </span>
              <span className="w-20 shrink-0 text-right font-semibold tabular-nums text-parchment">{money(e.amount)}</span>
              <span className="w-24 shrink-0 text-right text-[11.5px] tabular-nums text-muted">{money(e.amount * (PER_MONTH[e.cadence] ?? 0))}/mo</span>
              <button
                type="button"
                onClick={() => remove(e.id)}
                className="shrink-0 text-faint opacity-0 transition-opacity hover:text-[#dc2626] group-hover:opacity-100"
                title="Delete"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// --- Mileage -----------------------------------------------------------------

function Mileage({ projects }: { projects: Project[] }) {
  const [data, setData] = useState<MileageData | null>(null)
  const [date, setDate] = useState(todayISO())
  const [miles, setMiles] = useState('')
  const [purpose, setPurpose] = useState('')
  const [projectId, setProjectId] = useState('')
  const [rate, setRate] = useState('')

  useEffect(() => {
    loadMileage()
      .then((d) => {
        setData(d)
        setRate(String(d.ratePerMile))
      })
      .catch(() => setData({ trips: [], ratePerMile: 0.7 }))
  }, [])

  const byName = useMemo(() => [...projects].sort(byEventDateAsc), [projects])
  const nameFor = (id: string) => projects.find((p) => p.id === id)?.client ?? ''

  const add = async () => {
    if (!miles.trim()) return
    const t = await apiAddTrip({ date, miles, purpose, projectId })
    setData((prev) => (prev ? { ...prev, trips: [t, ...prev.trips] } : prev))
    setMiles('')
    setPurpose('')
  }
  const remove = (id: string) => {
    setData((prev) => (prev ? { ...prev, trips: prev.trips.filter((t) => t.id !== id) } : prev))
    apiDeleteTrip(id).catch(() => {})
  }
  const saveRate = () => {
    const r = Number(rate) || 0.7
    setData((prev) => (prev ? { ...prev, ratePerMile: r } : prev))
    apiSetRate(r).catch(() => {})
  }

  if (!data) return <p className="animate-pulse text-[13px] text-faint">Loading mileage…</p>

  const year = new Date().getFullYear()
  const today = todayISO()
  const trips = data.trips.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''))
  const tripMiles = trips.filter((t) => t.date.startsWith(String(year))).reduce((s, t) => s + (t.miles || 0), 0)
  // Per-project gig mileage for gigs already performed this year.
  const gigMiles = projects
    .filter((p) => p.mileage && p.eventDate && p.eventDate.startsWith(String(year)) && p.eventDate <= today)
    .reduce((s, p) => s + (p.mileage || 0), 0)
  const ytdMiles = gigMiles + tripMiles
  const ytdDeduction = ytdMiles * data.ratePerMile

  return (
    <div className="max-w-3xl space-y-5">
      <p className="text-[12.5px] leading-relaxed text-muted">
        Gig mileage comes from each project's Mileage field (you set it when you complete a gig); add any other business
        trips below. Both count toward the estimated deduction.
      </p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border border-line bg-surface-2/50 p-4">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-faint">Miles · {year}</p>
          <p className="font-display text-[26px] leading-none tabular-nums text-parchment">{Math.round(ytdMiles).toLocaleString('en-US')}</p>
          <p className="mt-1 text-[10.5px] text-faint">
            {Math.round(gigMiles).toLocaleString('en-US')} from gigs · {Math.round(tripMiles).toLocaleString('en-US')} other
          </p>
        </div>
        <div className="rounded-2xl border border-line bg-surface-2/50 p-4">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-faint">Est. deduction · {year}</p>
          <p className="font-display text-[26px] leading-none tabular-nums text-brass">{money(ytdDeduction)}</p>
        </div>
        <div className="rounded-2xl border border-line bg-surface-2/50 p-4">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-faint">Rate / mile</p>
          <div className="flex items-center gap-1">
            <span className="text-[20px] text-muted">$</span>
            <input
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              onBlur={saveRate}
              className="w-16 rounded-md border border-line bg-surface-2 px-2 py-1 font-display text-[20px] tabular-nums text-parchment focus:border-brass-dim focus:outline-none"
            />
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-2 rounded-xl border border-line bg-surface-2/50 p-3">
        <Field label="Date">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="input" />
        </Field>
        <Field label="Miles">
          <input value={miles} onChange={(e) => setMiles(e.target.value)} onBlur={() => setMiles(evalNumberFormula(miles))} placeholder="0" className="input w-20" />
        </Field>
        <Field label="Purpose">
          <input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="e.g. drive to gig" className="input min-w-[150px]" />
        </Field>
        <Field label="Project">
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="input min-w-[160px]">
            <option value="">(none)</option>
            {byName.map((p) => (
              <option key={p.id} value={p.id}>
                {p.client}
              </option>
            ))}
          </select>
        </Field>
        <button
          type="button"
          onClick={add}
          disabled={!miles.trim()}
          className="rounded-lg border border-brass-dim/60 bg-surface-3 px-4 py-2 text-[13px] font-semibold text-brass-bright transition-colors hover:border-brass disabled:opacity-40"
        >
          Add
        </button>
      </div>

      {trips.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-4 py-10 text-center text-[12.5px] text-faint">
          No separate trips logged. Gig mileage is pulled from each project's Mileage field.
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line">
          {trips.map((t, i) => (
            <div
              key={t.id}
              className={['group flex items-center gap-3 px-3 py-2.5 text-[13px]', i % 2 ? 'bg-surface-2/40' : 'bg-surface-2/20'].join(' ')}
            >
              <span className="w-24 shrink-0 tabular-nums text-muted">{formatEventDate(t.date)}</span>
              <span className="min-w-0 flex-1 truncate text-parchment">
                {t.purpose || 'Trip'}
                {nameFor(t.projectId) && <span className="ml-2 text-[11px] text-faint">{nameFor(t.projectId)}</span>}
              </span>
              <span className="w-16 shrink-0 text-right font-semibold tabular-nums text-parchment">{Math.round(t.miles)} mi</span>
              <button
                type="button"
                onClick={() => remove(t.id)}
                className="shrink-0 text-faint opacity-0 transition-opacity hover:text-[#dc2626] group-hover:opacity-100"
                title="Delete"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">{label}</span>
      {children}
    </label>
  )
}
