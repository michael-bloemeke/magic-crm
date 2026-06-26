import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { createQbInvoice, type QuickBooksInvoice } from '../api'
import { type Project } from '../pipeline'

// The Generate / Regenerate invoice dialog. Prompts for an amount (defaults to the
// project's Quote, so partial invoices like a 50% deposit are just a lower number),
// a due date (defaults to today), and an optional card-processing-fee surcharge that
// passes the card cost on to the client.

function todayISO() {
  const d = new Date()
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}
function money(n: number) {
  return '$' + (Math.round((n || 0) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

type Props = {
  project: Project | null
  mode: 'create' | 'regenerate'
  billToName?: string
  billToEmail?: string
  onCancel: () => void
  onCreated: (invoice: QuickBooksInvoice) => void
}

export function InvoiceGenerateModal({ project, mode, billToName, billToEmail, onCancel, onCreated }: Props) {
  const [amount, setAmount] = useState('')
  const [dueDate, setDueDate] = useState(todayISO())
  const [addFee, setAddFee] = useState(true)
  const [feePct, setFeePct] = useState('3')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset the fields each time the dialog opens for a project.
  useEffect(() => {
    if (!project) return
    setAmount(project.totalFee != null ? String(project.totalFee) : '')
    setDueDate(todayISO())
    setAddFee(true)
    setFeePct('3')
    setError(null)
    setBusy(false)
  }, [project])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const amt = Number(amount)
  const pct = Number(feePct)
  const validAmt = amount.trim() !== '' && !Number.isNaN(amt) && amt > 0
  const fee = addFee && validAmt && !Number.isNaN(pct) && pct > 0 ? Math.round(amt * pct) / 100 : 0
  const total = (validAmt ? amt : 0) + fee
  const quote = project?.totalFee ?? null

  const create = async () => {
    if (!project || !validAmt) return
    setBusy(true)
    setError(null)
    try {
      const inv = await createQbInvoice(project.id, {
        amount: amt,
        dueDate,
        processingFeePercent: addFee && !Number.isNaN(pct) && pct > 0 ? pct : 0,
        customerName: billToName,
        email: billToEmail,
      })
      onCreated(inv)
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
      setBusy(false)
    }
  }

  return (
    <AnimatePresence>
      {project && (
        <motion.div
          className="fixed inset-0 z-[60] flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={onCancel} aria-hidden />

          <motion.div
            className="board-scroll relative max-h-[88vh] w-full max-w-md overflow-y-auto rounded-2xl border border-line-strong bg-surface shadow-[0_30px_70px_-30px_rgba(0,0,0,0.9)]"
            initial={{ y: 16, opacity: 0.6, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 16, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="border-b border-line px-6 pb-4 pt-5">
              <h2 className="font-display text-[20px] leading-tight text-parchment">
                {mode === 'regenerate' ? 'Regenerate invoice' : 'Generate invoice'}
              </h2>
              <p className="mt-1 text-[12.5px] text-muted">
                Bill to <span className="text-parchment">{billToName || project.client}</span>. Defaults to the full quote;
                lower the amount for a partial invoice (e.g. a 50% deposit).
              </p>
            </div>

            <div className="space-y-4 px-6 py-5">
              {/* Amount */}
              <div>
                <span className="block text-[10px] font-semibold uppercase tracking-[0.16em] text-faint">Amount</span>
                <div className="mt-1.5 flex items-center rounded-lg border border-line bg-surface-2/40 px-3 focus-within:border-brass-dim">
                  <span className="text-[13px] text-faint">$</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="w-full bg-transparent px-2 py-2 text-[13px] text-parchment outline-none"
                    placeholder="0.00"
                    autoFocus
                  />
                </div>
                {quote != null && (
                  <div className="mt-1.5 flex items-center gap-3 text-[11px] text-faint">
                    <button
                      type="button"
                      onClick={() => setAmount(String(quote))}
                      className="underline-offset-2 hover:text-muted hover:underline"
                    >
                      Full quote ({money(quote)})
                    </button>
                    <button
                      type="button"
                      onClick={() => setAmount(String(Math.round((quote / 2) * 100) / 100))}
                      className="underline-offset-2 hover:text-muted hover:underline"
                    >
                      50% ({money(quote / 2)})
                    </button>
                  </div>
                )}
              </div>

              {/* Due date */}
              <label className="block">
                <span className="block text-[10px] font-semibold uppercase tracking-[0.16em] text-faint">Due date</span>
                <input
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  className="mt-1.5 w-full rounded-lg border border-line bg-surface-2/40 px-3 py-2 text-[13px] text-parchment outline-none focus:border-brass-dim"
                />
              </label>

              {/* Processing fee */}
              <div>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={addFee}
                    onChange={(e) => setAddFee(e.target.checked)}
                    className="h-3.5 w-3.5 accent-[var(--color-brass)]"
                  />
                  <span className="text-[12.5px] text-parchment">Pass card processing fee to client</span>
                </label>
                {addFee && (
                  <div className="mt-2 flex items-center gap-2 pl-6">
                    <input
                      type="number"
                      min="0"
                      step="0.1"
                      value={feePct}
                      onChange={(e) => setFeePct(e.target.value)}
                      className="w-16 rounded-lg border border-line bg-surface-2/40 px-2 py-1.5 text-[13px] text-parchment outline-none focus:border-brass-dim"
                    />
                    <span className="text-[12px] text-muted">% surcharge{fee > 0 ? ` = ${money(fee)}` : ''}</span>
                  </div>
                )}
                <p className="mt-1.5 text-[11px] leading-relaxed text-faint">
                  Adds a separate line. Worth it only if they'll pay the invoice by card online (cash, check, Venmo, etc.
                  have no fee).
                </p>
              </div>

              {/* Total */}
              <div className="flex items-center justify-between border-t border-line pt-3">
                <span className="text-[12px] text-muted">Invoice total</span>
                <span className="text-[15px] font-semibold text-parchment">{money(total)}</span>
              </div>

              {error && <p className="text-[11.5px] leading-relaxed text-[#e08a6b]">{error}</p>}
            </div>

            <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-line bg-surface/95 px-6 py-4 backdrop-blur">
              <button
                type="button"
                onClick={onCancel}
                className="rounded-lg border border-line px-4 py-2 text-[12.5px] font-medium text-muted transition-colors hover:border-line-strong hover:text-parchment"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!validAmt || busy}
                onClick={create}
                className="rounded-lg bg-brass px-4 py-2 text-[12.5px] font-semibold text-[#231a0c] transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? 'Creating…' : mode === 'regenerate' ? 'Regenerate' : 'Create invoice'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
