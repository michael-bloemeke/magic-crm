import { useEffect, useState } from 'react'
import { type Project } from '../pipeline'
import { EditableField } from './EditableField'
import {
  loadBookingStatus,
  readyToBook,
  bookingAgreementPdfUrl,
  loadQuickBooks,
  type BookingStatus,
  type QuickBooksInvoice,
} from '../api'

// The whole booking sequence in ONE card, replacing the old Recipients / Contract / Questionnaire /
// Invoice blocks. Michael's complaint about those was fair: four cards, a dozen controls, and at any
// given moment only one of them was the thing he actually needed to do next.
//
// After that it went the other way and grew a "check for answers" button, which was busywork: the
// answer to "have they done it yet" is a fact the server can just tell you. So the card now carries
// a live PROGRESS BAR (not viewed / viewed / details in / signed) that moves on its own, and exactly
// TWO controls:
//
//   Ready to book   publishes the agreement to the website, issues the form link, and leaves a
//                   ready-to-send draft in Gmail. Disabled until the two gated fields are filled.
//   View contract   opens the agreement PDF. Disabled until the client has sent their details,
//                   because before that there is nothing on it but Michael's own numbers.
//
// Everything after "Ready to book" runs without him: the client signs on the website, the CRM emails
// them the signed PDF, and the invoice follows. The card reports; it does not ask him to drive.

function fmtWhen(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

type Stage = 'none' | 'viewed' | 'submitted' | 'signed'

// The four states of a booking link, in order. `key` matches what liveProgress returns.
const STEPS: { key: Stage; label: string; done: string }[] = [
  { key: 'none', label: 'Not viewed', done: 'Sent' },
  { key: 'viewed', label: 'Viewed', done: 'Viewed' },
  { key: 'submitted', label: 'Details in', done: 'Details in' },
  { key: 'signed', label: 'Signed', done: 'Signed' },
]

export function BookingCard({
  project,
  onSaveField,
}: {
  project: Project
  onSaveField: (field: string, value: string) => void
}) {
  const [booking, setBooking] = useState<BookingStatus | null>(null)
  const [invoice, setInvoice] = useState<QuickBooksInvoice | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const refresh = () => {
    loadBookingStatus(project.id).then(setBooking).catch(() => setBooking(null))
    loadQuickBooks()
      .then((d) => setInvoice(d.invoices[project.id] ?? null))
      .catch(() => setInvoice(null))
  }
  // Poll while the project is open. Two tiny reads, and it is what lets the status move without a
  // button. Stops as soon as they have signed, since nothing after that changes here.
  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 30_000)
    return () => clearInterval(t)
  }, [project.id])

  const linkOut = !!booking?.sentAt
  const stage: Stage = (booking?.progress?.stage as Stage) || 'none'
  const signed = stage === 'signed'
  const submitted = stage === 'submitted' || signed
  const signature = booking?.signature ?? null

  // Both of these appear in the agreement the client reads on the website, seconds after they finish
  // the form. Blank means they would be looking at a literal "[Performance scope]" or "[Booking
  // fee]" on the document they are about to sign, so the link cannot go out until both are set.
  const styleSet = !!String(project.performanceStyle || '').trim()
  const feeSet = project.totalFee != null && Number(project.totalFee) > 0
  const readyToSend = styleSet && feeSet

  const doReady = async () => {
    setBusy(true)
    setNote(null)
    try {
      const r = await readyToBook(project.id)
      setNote(`Draft ready in Gmail, addressed to ${r.to}. Everything after you send it is automatic.`)
      refresh()
    } catch (e) {
      setNote(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(false)
    }
  }

  const primary =
    'rounded-lg border border-brass-dim/60 bg-surface-3 px-3 py-1.5 text-[12.5px] font-semibold text-brass-bright transition-colors hover:border-brass disabled:cursor-not-allowed disabled:opacity-40'
  const secondary =
    'rounded-lg border border-line px-3 py-1.5 text-[12.5px] font-medium text-muted transition-colors hover:border-line-strong hover:text-parchment disabled:cursor-not-allowed disabled:opacity-40'

  const reachedIdx = STEPS.findIndex((s) => s.key === stage)

  return (
    <div className="rounded-xl border border-line-strong bg-surface-3/60 px-4 py-3 shadow-[0_2px_8px_-3px_rgba(0,0,0,0.35)]">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] font-medium text-parchment">Booking</p>
        {signed && (
          <span
            className="rounded-full px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.1em]"
            style={{ color: 'var(--color-umb-booked)', backgroundColor: 'color-mix(in oklab, var(--color-umb-booked) 16%, transparent)' }}
          >
            Signed
          </span>
        )}
      </div>

      {/* The two fields the agreement can't be built without. At the top, because they gate
          everything below them and a client is going to read both. */}
      <div
        className={`mt-2.5 rounded-lg border px-3 py-2.5 ${
          readyToSend ? 'border-line bg-surface-2/40' : 'border-rose-500/40 bg-rose-500/[0.06]'
        }`}
      >
        <p className={`text-[10px] font-semibold uppercase tracking-[0.12em] ${readyToSend ? 'text-faint' : 'text-rose-300'}`}>
          {readyToSend ? 'Goes on the agreement' : 'Fill both to send the booking form'}
        </p>
        <div className="mt-1.5 space-y-1.5">
          <EditableField
            label="Performance style"
            value={String(project.performanceStyle || '')}
            onSave={(v) => onSaveField('performanceStyle', v)}
            multiline
            missing={!styleSet}
            placeholder="What you're actually doing at this event"
          />
          <EditableField
            label="Quote"
            value={project.totalFee == null ? '' : String(project.totalFee)}
            onSave={(v) => onSaveField('totalFee', v)}
            prefix="$"
            missing={!feeSet}
            placeholder="Booking fee"
          />
        </div>
      </div>

      {/* Live progress. Replaces the old "check for answers" button: the server already knows. */}
      {linkOut && (
        <div className="mt-3">
          <div className="flex items-center gap-1">
            {STEPS.map((s, i) => {
              const reached = i <= reachedIdx
              return (
                <div key={s.key} className="flex flex-1 flex-col gap-1">
                  <span
                    className="h-1 rounded-full transition-colors"
                    style={{
                      backgroundColor: reached
                        ? i === STEPS.length - 1
                          ? 'var(--color-umb-booked)'
                          : 'var(--color-umb-postcall)'
                        : 'var(--color-line)',
                    }}
                  />
                  <span
                    className={`text-[9.5px] font-medium tracking-[0.04em] ${
                      i === reachedIdx ? 'text-parchment' : reached ? 'text-muted' : 'text-faint/60'
                    }`}
                  >
                    {i === 0 && reachedIdx === 0 ? 'Not viewed' : s.done}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      <p className="mt-2 text-[11.5px] leading-relaxed text-faint">
        {booking?.agreementError
          ? `They signed, but their copy could not be sent: ${booking.agreementError}`
          : signed
            ? `${signature?.name || 'They'} signed it ${fmtWhen(signature?.signedAt || booking?.progress?.signedAt || '')}. Their copy has been emailed.`
            : submitted
              ? 'Their details are in. Waiting on their signature.'
              : stage === 'viewed'
                ? `They opened the form ${fmtWhen(booking?.progress?.viewedAt || '')} but haven't sent it back yet.`
                : linkOut
                  ? `Form sent ${fmtWhen(booking!.sentAt)}. Nothing from them yet.`
                  : readyToSend
                    ? 'Send the booking form. They fill it in, sign the agreement, and get invoiced without you.'
                    : 'Fill in the two fields above, then the booking form can go out.'}
      </p>

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy || !readyToSend}
          onClick={doReady}
          title={readyToSend ? '' : 'Add a performance style and a quote first'}
          className={primary}
        >
          {busy ? 'Working…' : linkOut ? 'Resend booking form' : 'Ready to book'}
        </button>
        <button
          type="button"
          disabled={!submitted}
          onClick={() => window.open(bookingAgreementPdfUrl(project.id, true), '_blank')}
          title={
            submitted
              ? signed
                ? 'The signed copy, as the client received it'
                : 'The agreement as it currently stands, with their details'
              : "Unlocks once they've sent their details"
          }
          className={secondary}
        >
          View contract
        </button>
      </div>

      {invoice?.sentAt && (
        <p className="mt-2 border-t border-line/60 pt-2 text-[11px] text-faint">
          Invoice{invoice.docNumber ? ` #${invoice.docNumber}` : ''} sent {fmtWhen(invoice.sentAt)}
          {invoice.email ? ` to ${invoice.email}` : ''}
          {invoice.paidAt ? (
            <span style={{ color: 'var(--color-umb-booked)' }}> · paid {fmtWhen(invoice.paidAt)}</span>
          ) : null}
        </p>
      )}
      {note && <p className="mt-2 text-[11px] leading-relaxed text-muted">{note}</p>}
    </div>
  )
}
