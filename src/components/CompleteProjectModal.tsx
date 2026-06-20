import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { isReceivedPayment, type Payment } from '../api'
import { type Project } from '../pipeline'
import { PaymentsEditor } from './PaymentsEditor'
import { ContactTagger } from './ContactTagger'
import { evalNumberFormula } from '../calc'

// Completing a project moves it out of the pipeline, so the CRM requires the two
// things that matter for the books first: mileage driven and at least one
// recorded payment. Payments are logged live via PaymentsEditor (so they persist
// whether or not you complete), and the gate just checks that one exists. The
// client tagger lets Michael set the lasting relationship + tags as the client
// leaves the pipeline.

export type CompletePayload = {
  mileage: number
  eventDate: string
}

type Props = {
  project: Project | null
  onCancel: () => void
  onConfirm: (data: CompletePayload) => void
  onPaymentsChange?: (payments: Payment[]) => void
}

export function CompleteProjectModal({ project, onCancel, onConfirm, onPaymentsChange }: Props) {
  const [mileage, setMileage] = useState('')
  const [eventDate, setEventDate] = useState('')
  const [payments, setPayments] = useState<Payment[] | null>(null)

  useEffect(() => {
    if (!project) return
    setMileage(project.mileage == null ? '' : String(project.mileage))
    setEventDate(project.eventDate || '')
    setPayments(null)
  }, [project])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const mileageOk = mileage.trim() !== '' && !Number.isNaN(Number(mileage.replace(/[^0-9.]/g, '')))
  const eventDateOk = eventDate.trim() !== ''
  // No discrepancies: payments received must cover the full fee.
  const fee = project?.totalFee ?? null
  const receivedTotal = (payments ?? []).filter(isReceivedPayment).reduce((s, p) => s + (p.amount || 0), 0)
  const remaining = fee == null ? null : fee - receivedTotal
  const paidInFull = fee != null && remaining !== null && remaining <= 0.005
  const canConfirm = mileageOk && eventDateOk && paidInFull

  const confirm = () => {
    if (!canConfirm) return
    onConfirm({ mileage: Number(mileage.replace(/[^0-9.]/g, '')) || 0, eventDate })
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
              <h2 className="font-display text-[20px] leading-tight text-parchment">Complete project</h2>
              <p className="mt-1 text-[12.5px] text-muted">
                <span className="text-parchment">{project.client}</span> will move to Completed. Confirm the mileage and
                payment first so the books stay accurate.
              </p>
            </div>

            <div className="space-y-4 px-6 py-5">
              <label className="block">
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.16em] text-faint">
                  Event date
                </span>
                <div className="flex items-center gap-2">
                  <input
                    type="date"
                    value={eventDate}
                    onChange={(e) => setEventDate(e.target.value)}
                    className="input [color-scheme:dark] w-44"
                  />
                  {!eventDateOk && <span className="text-[11px] text-[#e08a6b]">required</span>}
                </div>
              </label>

              <label className="block">
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.16em] text-faint">
                  Round-trip mileage
                </span>
                <div className="flex items-center gap-2">
                  <input
                    autoFocus
                    value={mileage}
                    onChange={(e) => setMileage(e.target.value)}
                    onBlur={() => setMileage(evalNumberFormula(mileage))}
                    placeholder="miles driven"
                    className="input w-40"
                  />
                  <span className="text-[12px] text-faint">mi</span>
                  {!mileageOk && <span className="text-[11px] text-[#e08a6b]">required</span>}
                </div>
              </label>

              <div>
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.16em] text-faint">
                  Payments
                </span>
                {payments != null &&
                  (fee == null ? (
                    <p className="mb-1 text-[11px] text-[#e08a6b]">Set a fee on this project first so its payments can be reconciled to it.</p>
                  ) : !paidInFull ? (
                    <p className="mb-1 text-[11px] text-[#e08a6b]">
                      Paid ${Math.round(receivedTotal).toLocaleString('en-US')} of ${Math.round(fee).toLocaleString('en-US')}. ${Math.round(remaining ?? 0).toLocaleString('en-US')} still outstanding, must be paid in full to complete.
                    </p>
                  ) : (
                    <p className="mb-1 text-[11px]" style={{ color: 'var(--color-umb-booked)' }}>
                      Paid in full (${Math.round(fee).toLocaleString('en-US')}).
                    </p>
                  ))}
                <PaymentsEditor
                  projectId={project.id}
                  onChange={(pmts) => {
                    setPayments(pmts)
                    onPaymentsChange?.(pmts)
                  }}
                />
              </div>

              <div className="border-t border-line pt-4">
                <ContactTagger project={project} />
              </div>
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
                disabled={!canConfirm}
                onClick={confirm}
                className="inline-flex items-center gap-1.5 rounded-lg border px-4 py-2 text-[12.5px] font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-40"
                style={{
                  borderColor: 'color-mix(in oklab, var(--color-umb-booked) 55%, transparent)',
                  color: 'var(--color-umb-booked)',
                }}
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
                Complete
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
