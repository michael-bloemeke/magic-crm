import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { isReceivedPayment, type Payment } from '../api'
import { type Project } from '../pipeline'
import { PaymentsEditor } from './PaymentsEditor'

// Moving a project to "Deposit Paid" requires at least one received payment
// (amount + date). Opens when Michael picks that stage without one on file.
// Additional payments can be logged as PENDING (date TBD) for a payment plan.

type Props = {
  project: Project | null
  onCancel: () => void
  onConfirm: () => void
  onPaymentsChange?: (payments: Payment[]) => void
}

export function DepositPaidModal({ project, onCancel, onConfirm, onPaymentsChange }: Props) {
  const [payments, setPayments] = useState<Payment[] | null>(null)

  useEffect(() => {
    setPayments(null)
  }, [project])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const hasReceived = (payments ?? []).some(isReceivedPayment)

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
            className="board-scroll relative max-h-[88vh] w-full max-w-md overflow-y-auto rounded-2xl border border-line-strong bg-surface shadow-[0_30px_70px_-30px_rgba(0,0,0,0.18)]"
            initial={{ y: 16, opacity: 0.6, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 16, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="border-b border-line px-6 pb-4 pt-5">
              <h2 className="font-display text-[20px] leading-tight text-parchment">Mark as Deposit Paid</h2>
              <p className="mt-1 text-[12.5px] text-muted">
                <span className="text-parchment">{project.client}</span> moves to Deposit Paid once a payment is on
                file. Log the deposit below (amount + date). Expecting more? Add another payment when it arrives.
              </p>
            </div>

            <div className="space-y-3 px-6 py-5">
              <span className="block text-[10px] font-semibold uppercase tracking-[0.16em] text-faint">Payments</span>
              {payments != null && !hasReceived && (
                <p className="text-[11px] text-[#dc2626]">Log at least one received payment (amount + date) to continue.</p>
              )}
              <PaymentsEditor
                projectId={project.id}
                onChange={(pmts) => {
                  setPayments(pmts)
                  onPaymentsChange?.(pmts)
                }}
              />
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
                disabled={!hasReceived}
                onClick={onConfirm}
                className="inline-flex items-center gap-1.5 rounded-lg border px-4 py-2 text-[12.5px] font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-40"
                style={{
                  borderColor: 'color-mix(in oklab, var(--color-umb-booked) 55%, transparent)',
                  color: 'var(--color-umb-booked)',
                }}
              >
                Mark Deposit Paid
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
