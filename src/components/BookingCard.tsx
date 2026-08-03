import { useEffect, useState } from 'react'
import { type Project } from '../pipeline'
import {
  loadBookingStatus,
  readyToBook,
  pullBookingSubmission,
  bookingAgreementPdfUrl,
  sendQbInvoice,
  loadQuickBooks,
  type BookingStatus,
  type QuickBooksInvoice,
} from '../api'

// The whole booking sequence in ONE card, replacing the old Recipients / Contract / Questionnaire /
// Invoice blocks. Michael's complaint about those was fair: four cards, a dozen controls, and at any
// given moment only one of them was the thing he actually needed to do next.
//
// So this card shows the CURRENT STEP and nothing else:
//
//   1. Ready to book   -> issues the form link and leaves a ready-to-send draft in Gmail.
//   2. Waiting         -> the link is out; check whether they've filled it in.
//   3. They submitted  -> the agreement is ready to download, and Send invoice unlocks.
//
// Send invoice is deliberately DISABLED until the form comes back, because the invoice is addressed
// to whoever they named on it and priced off the booking fee. Enabling it earlier would just invite
// sending an invoice made of guesses.

function fmtWhen(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function BookingCard({ project }: { project: Project }) {
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
  useEffect(refresh, [project.id])

  const submitted = !!booking?.submission

  const doReady = async () => {
    setBusy(true)
    setNote(null)
    try {
      const r = await readyToBook(project.id)
      setNote(`Draft ready in Gmail, addressed to ${r.to}. Go send it when you're happy with it.`)
      refresh()
    } catch (e) {
      setNote(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(false)
    }
  }

  const doCheck = async () => {
    setBusy(true)
    setNote(null)
    try {
      const r = await pullBookingSubmission(project.id)
      if (!r.ok) setNote(r.error || 'Could not check for a submission.')
      else if (r.fresh) setNote(`Their details came in. Filled: ${(r.filledFields || []).join(', ')}.`)
      else setNote('Nothing back from them yet.')
      refresh()
    } finally {
      setBusy(false)
    }
  }

  const doSendInvoice = async () => {
    setBusy(true)
    setNote(null)
    try {
      await sendQbInvoice(project.id, booking?.invoiceTo?.email || undefined)
      setNote('Invoice sent.')
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

  return (
    <div className="rounded-xl border border-line-strong bg-surface-3/60 px-4 py-3 shadow-[0_2px_8px_-3px_rgba(0,0,0,0.35)]">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] font-medium text-parchment">Booking</p>
        {submitted && (
          <span
            className="rounded-full px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.1em]"
            style={{ color: 'var(--color-umb-booked)', backgroundColor: 'color-mix(in oklab, var(--color-umb-booked) 16%, transparent)' }}
          >
            Details in
          </span>
        )}
      </div>

      <p className="mt-1 text-[11.5px] leading-relaxed text-faint">
        {submitted
          ? `They sent their details${booking?.submission ? '' : ''}. The agreement is ready, and the invoice can go out once they've signed.`
          : booking?.sentAt
            ? `Form sent ${fmtWhen(booking.sentAt)}. Waiting on their details.`
            : 'Send the client the booking form to collect the event details.'}
      </p>

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {!submitted && (
          <button type="button" disabled={busy} onClick={doReady} className={primary}>
            {busy ? 'Working…' : booking?.sentAt ? 'Resend booking form' : 'Ready to book'}
          </button>
        )}
        {booking?.sentAt && !submitted && (
          <button type="button" disabled={busy} onClick={doCheck} className={secondary}>
            {busy ? 'Checking…' : 'Check for answers'}
          </button>
        )}
        {submitted && (
          <button
            type="button"
            onClick={() => window.open(bookingAgreementPdfUrl(project.id, true), '_blank')}
            className={primary}
          >
            Agreement PDF
          </button>
        )}
        <button
          type="button"
          disabled={busy || !submitted || !!invoice?.sentAt}
          onClick={doSendInvoice}
          title={
            !submitted
              ? "Unlocks once they've filled in the booking form (that's where the invoice recipient comes from)"
              : invoice?.sentAt
                ? 'Already sent'
                : 'Send the invoice'
          }
          className={secondary}
        >
          {invoice?.sentAt ? `Invoice sent ${fmtWhen(invoice.sentAt)}` : 'Send invoice'}
        </button>
      </div>

      {booking?.invoiceTo?.name && (
        <p className="mt-2 border-t border-line/60 pt-2 text-[11px] text-faint">
          Invoice to <span className="text-muted">{booking.invoiceTo.name}</span>
          {booking.invoiceTo.email ? ` (${booking.invoiceTo.email})` : ''}
        </p>
      )}
      {note && <p className="mt-2 text-[11px] leading-relaxed text-muted">{note}</p>}
    </div>
  )
}
