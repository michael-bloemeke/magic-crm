import { useEffect, useState } from 'react'
import { addPayment, deletePayment, loadPayments, PAYMENT_METHODS, type Payment } from '../api'

// Per-project payments: each is an amount received on a date, with a method. These
// payments are the source for BOTH Finance figures: "money received" groups them by
// the date they arrived, "money earned" groups them by the gig's event month. (The
// Quote/total_fee is NOT income; it only drives the "still expected to come in"
// projection.) The "+" logs multiple payments (deposit now, balance later).
// onChange reports the current list so callers can gate on it.

type Props = {
  projectId: string
  onChange?: (payments: Payment[]) => void
}

const todayISO = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function money(n: number) {
  return '$' + Math.round(n || 0).toLocaleString('en-US')
}

function fmtDate(iso: string) {
  if (!iso) return ''
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function PaymentsEditor({ projectId, onChange }: Props) {
  const [payments, setPayments] = useState<Payment[] | null>(null)
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(todayISO())
  const [method, setMethod] = useState<string>('QuickBooks invoice')
  const [busy, setBusy] = useState(false)

  const update = (list: Payment[]) => {
    setPayments(list)
    onChange?.(list)
  }

  useEffect(() => {
    let live = true
    loadPayments()
      .then((all) => {
        if (live) update(all.filter((p) => p.projectId === projectId))
      })
      .catch(() => {
        if (live) update([])
      })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  const amt = Number(amount.replace(/[^0-9.]/g, ''))
  const canAdd = amt > 0 && !busy && date.trim() !== ''

  const add = async () => {
    if (!canAdd) return
    setBusy(true)
    try {
      const p = await addPayment({ projectId, amount: amt, dateReceived: date, method })
      update([...(payments ?? []), p])
      setAmount('')
      setDate(todayISO())
    } catch {
      // leave inputs so Michael can retry
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    const prev = payments ?? []
    update(prev.filter((p) => p.id !== id))
    deletePayment(id).catch(() => update(prev))
  }

  const list = payments ?? []
  const received = list.filter((p) => p.dateReceived)
  const total = received.reduce((s, p) => s + (p.amount || 0), 0)

  return (
    <div className="space-y-2">
      {payments == null ? (
        <p className="text-[12px] text-faint">Loading payments…</p>
      ) : list.length === 0 ? (
        <p className="text-[12px] text-faint">No payments logged yet.</p>
      ) : (
        <div className="space-y-1.5">
          {list.map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-2/60 px-3 py-1.5"
            >
              <span
                className="text-[13px] font-semibold tabular-nums"
                style={{ color: 'var(--color-umb-booked)' }}
              >
                {money(p.amount)}
              </span>
              <span className="flex-1 text-[11.5px] text-muted">{fmtDate(p.dateReceived)}</span>
              {p.method && (
                <span className="shrink-0 rounded-full border border-line px-1.5 py-0.5 text-[10px] text-muted">{p.method}</span>
              )}
              <button
                type="button"
                onClick={() => remove(p.id)}
                className="text-faint transition-colors hover:text-[#dc2626]"
                aria-label="Delete payment"
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
          ))}
          {received.length > 1 && (
            <p className="px-1 pt-0.5 text-[11px] text-faint">
              Received: <span className="font-semibold text-muted">{money(total)}</span>
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-end gap-2 pt-1">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-[0.12em] text-faint">Amount</span>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
            placeholder="$"
            className="w-24 rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 text-[13px] text-parchment placeholder:text-faint focus:border-brass-dim focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-[0.12em] text-faint">Date received</span>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 text-[12px] text-parchment focus:border-brass-dim focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-[0.12em] text-faint">Method</span>
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            className="rounded-lg border border-line bg-surface-2 px-2 py-1.5 text-[12px] text-parchment focus:border-brass-dim focus:outline-none"
          >
            <option value="">—</option>
            {PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={add}
          disabled={!canAdd}
          title="Add payment"
          className="inline-flex items-center gap-1 rounded-lg border border-brass-dim/60 bg-surface-3 px-3 py-1.5 text-[12.5px] font-semibold text-brass-bright transition-colors hover:border-brass disabled:cursor-not-allowed disabled:opacity-40"
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          Add
        </button>
      </div>
    </div>
  )
}
