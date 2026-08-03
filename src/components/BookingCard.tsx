import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { type Project } from '../pipeline'
import {
  loadBookingStatus,
  readyToBook,
  pullBookingSubmission,
  resendAgreement,
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
//   1. Ready to book   -> publishes the agreement to the website, issues the form link, and leaves
//                          a ready-to-send draft in Gmail.
//   2. Waiting         -> the link is out; check whether they've got to it.
//   3. Details in      -> they answered the questions but haven't signed yet.
//   4. Signed          -> they signed on the website; the CRM emails them a PDF copy automatically.
//
// Step 1 is blocked while the performance style or the quote is blank. Both appear in the agreement
// the client reads, and they now read it seconds after finishing the form, so this is the last
// moment a human could catch either missing.
//
// Send invoice stays MANUAL (Michael's call). It unlocks once the form comes back, because the
// invoice is addressed to whoever they named on it.

function fmtWhen(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function BookingCard({ project }: { project: Project }) {
  const [booking, setBooking] = useState<BookingStatus | null>(null)
  const [invoice, setInvoice] = useState<QuickBooksInvoice | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [showResponse, setShowResponse] = useState(false)

  const refresh = () => {
    loadBookingStatus(project.id).then(setBooking).catch(() => setBooking(null))
    loadQuickBooks()
      .then((d) => setInvoice(d.invoices[project.id] ?? null))
      .catch(() => setInvoice(null))
  }
  useEffect(refresh, [project.id])

  const submitted = !!booking?.submission
  const signature = booking?.signature ?? null
  const signed = !!signature
  const agreementSent = !!booking?.agreementSentAt

  // Both of these appear in the agreement the client reads on the website. Blank means they'd be
  // looking at a literal "[Performance scope]" or "[Booking fee]", so the link can't go out yet.
  const missingForAgreement = [
    String(project.performanceStyle || '').trim() ? '' : 'performance style',
    project.totalFee != null && Number(project.totalFee) > 0 ? '' : 'quote',
  ].filter(Boolean)
  const readyToSend = missingForAgreement.length === 0

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
      else if (!r.submission) setNote("Nothing back from them yet. They haven't opened the form.")
      else if (r.agreementError) setNote(`They signed, but their copy did not send: ${r.agreementError}`)
      else if (r.agreementSent) setNote(`${r.signature?.name} signed it. Their copy is on its way to ${r.agreementTo}.`)
      else if (r.freshSignature) setNote(`${r.signature?.name} signed the agreement.`)
      else if (r.fresh) setNote(`Their details came in. Filled: ${(r.filledFields || []).join(', ')}. Waiting on their signature.`)
      else if (r.signature) setNote('Nothing new. They already signed and have their copy.')
      else setNote('They filled in the details but have not signed yet.')
      refresh()
    } finally {
      setBusy(false)
    }
  }

  const doResend = async () => {
    setBusy(true)
    setNote(null)
    try {
      const r = await resendAgreement(project.id)
      setNote(`A fresh copy of the agreement is on its way to ${r.to}.`)
      refresh()
    } catch (e) {
      setNote(String(e instanceof Error ? e.message : e))
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
        {signed ? (
          <span
            className="rounded-full px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.1em]"
            style={{ color: 'var(--color-umb-booked)', backgroundColor: 'color-mix(in oklab, var(--color-umb-booked) 16%, transparent)' }}
          >
            Signed
          </span>
        ) : submitted ? (
          <span
            className="rounded-full px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.1em]"
            style={{ color: 'var(--color-umb-postcall)', backgroundColor: 'color-mix(in oklab, var(--color-umb-postcall) 16%, transparent)' }}
          >
            Details in
          </span>
        ) : null}
      </div>

      <p className="mt-1 text-[11.5px] leading-relaxed text-faint">
        {booking?.agreementError
          ? `They signed, but their copy could not be sent: ${booking.agreementError}`
          : signed
            ? `${signature!.name} signed it ${fmtWhen(signature!.signedAt)}.${
                agreementSent ? ' Their copy has been emailed.' : ' Sending their copy…'
              } The invoice is yours to send.`
            : submitted
              ? 'They filled in the details but have not signed the agreement yet.'
              : booking?.sentAt
                ? `Form sent ${fmtWhen(booking.sentAt)}. They sign the agreement on the website right after it.`
                : !readyToSend
                  ? `Set the ${missingForAgreement.join(' and ')} in Event details first. The client reads the agreement on the website seconds after the form, so this has to be right before the link goes out.`
                  : 'Send the client the booking form. They fill it in, then sign the agreement on the website in the same sitting.'}
      </p>

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {!submitted && (
          <button
            type="button"
            disabled={busy || !readyToSend}
            onClick={doReady}
            title={readyToSend ? '' : `Add a ${missingForAgreement.join(' and ')} in Event details first`}
            className={primary}
          >
            {busy ? 'Working…' : booking?.sentAt ? 'Resend booking form' : 'Ready to book'}
          </button>
        )}
        {booking?.sentAt && !signed && (
          <button type="button" disabled={busy} onClick={doCheck} className={secondary}>
            {busy ? 'Checking…' : submitted ? 'Check for signature' : 'Check for answers'}
          </button>
        )}
        {submitted && (
          <button
            type="button"
            onClick={() => window.open(bookingAgreementPdfUrl(project.id, true), '_blank')}
            title={signed ? 'The signed copy, as the client received it' : 'The agreement as it currently stands, unsigned'}
            className={primary}
          >
            {signed ? 'Signed PDF' : 'Agreement PDF'}
          </button>
        )}
        {signed && (
          <button
            type="button"
            disabled={busy}
            onClick={doResend}
            title="Send their copy again, if they say it never arrived"
            className={secondary}
          >
            {busy ? 'Sending…' : agreementSent ? 'Resend their copy' : 'Send their copy now'}
          </button>
        )}
        <button
          type="button"
          disabled={!submitted}
          onClick={() => setShowResponse(true)}
          title={submitted ? 'Read exactly what they sent back' : "Unlocks once they've filled in the booking form"}
          className={secondary}
        >
          See response
        </button>
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

      <ResponseDialog
        open={showResponse}
        client={project.client}
        submittedAt={booking?.submission?.submittedAt || ''}
        rows={booking?.summary || []}
        onClose={() => setShowResponse(false)}
      />
    </div>
  )
}

// What the client actually sent back, verbatim. Read-only on purpose: this is the record of what
// they told you, and the place to correct a detail is the project's own Event details, not here.
function ResponseDialog({
  open,
  client,
  submittedAt,
  rows,
  onClose,
}: {
  open: boolean
  client: string
  submittedAt: string
  rows: { label: string; value: string }[]
  onClose: () => void
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const when = submittedAt
    ? new Date(submittedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
    : ''

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[60] flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
          <motion.div
            className="board-scroll relative max-h-[88vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-line-strong bg-surface shadow-[0_30px_70px_-30px_rgba(0,0,0,0.9)]"
            initial={{ y: 16, opacity: 0.6, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 16, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="border-b border-line px-6 pb-4 pt-5">
              <h2 className="font-display text-[20px] leading-tight text-parchment">Their booking form</h2>
              <p className="mt-1 text-[12.5px] text-muted">
                What <span className="text-parchment">{client}</span> sent back{when ? ` on ${when}` : ''}.
              </p>
            </div>

            <div className="space-y-4 px-6 py-5">
              {rows.length === 0 ? (
                <p className="text-[12.5px] text-faint">Nothing came through on this one.</p>
              ) : (
                rows.map((r) => (
                  <div key={r.label}>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">{r.label}</p>
                    <p className="mt-0.5 whitespace-pre-wrap text-[13.5px] leading-relaxed text-parchment">{r.value}</p>
                  </div>
                ))
              )}
            </div>

            <div className="sticky bottom-0 flex items-center justify-end border-t border-line bg-surface/95 px-6 py-4 backdrop-blur">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-line px-4 py-2 text-[12.5px] font-medium text-muted transition-colors hover:border-line-strong hover:text-parchment"
              >
                Close
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
