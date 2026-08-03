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
// ONE control:
//
//   Ready to book   publishes the agreement to the website, issues the form link, and leaves a
//                   ready-to-send draft in Gmail. Disabled until the two gated fields are filled.
//
// The agreement itself is an ATTACHMENT, not a button. It used to be "View contract", which forced a
// download; the document exists, so it should sit on the project the way a PDF sits on an email, one
// tap to look and a download only if he actually wants the file.
//
// Everything after "Ready to book" runs without him: the client signs on the website, and the
// `booking-complete` edge function emails the signed PDF and sends the invoice, with his Mac off.
// The card reports; it does not ask him to drive.

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
  const [showPdf, setShowPdf] = useState(false)

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

  const doReady = async (variant: string) => {
    setBusy(true)
    setNote(null)
    setPickVariant(false)
    try {
      const r = await readyToBook(project.id, variant)
      const label = variants.find((v) => v.id === variant)?.label || variant
      setNote(`Draft ready in Gmail, addressed to ${r.to}, using the ${label} agreement. Everything after you send it is automatic.`)
      refresh()
    } catch (e) {
      setNote(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(false)
    }
  }

  const primary =
    'rounded-lg border border-brass-dim/60 bg-surface-3 px-3 py-1.5 text-[12.5px] font-semibold text-brass-bright transition-colors hover:border-brass disabled:cursor-not-allowed disabled:opacity-40'

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
      </div>

      {/* The agreement, as an attachment rather than a button.
          It used to be a "View contract" button that forced a download. Michael's point was right:
          the document exists, so it should just sit on the project the way a PDF sits on an email,
          one tap to look at it and a download only if he actually wants the file. */}
      {submitted && (
        <button
          type="button"
          onClick={() => setShowPdf(true)}
          className="mt-2.5 flex w-full items-center gap-2.5 rounded-lg border border-line bg-surface-2/40 px-3 py-2 text-left transition-colors hover:border-line-strong"
        >
          <span
            className="flex h-7 w-7 flex-none items-center justify-center rounded text-[8.5px] font-bold tracking-tight"
            style={{ color: 'var(--color-umb-booked)', backgroundColor: 'color-mix(in oklab, var(--color-umb-booked) 16%, transparent)' }}
          >
            PDF
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[12.5px] font-medium text-parchment">
              Agreement - {project.client}{signed ? ' (signed)' : ''}.pdf
            </span>
            <span className="block text-[10.5px] text-faint">
              {signed ? 'The copy the client received' : 'Draft, not signed yet'} · tap to preview
            </span>
          </span>
        </button>
      )}

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

      <PdfPreview
        open={showPdf}
        title={`Agreement - ${project.client}${signed ? ' (signed)' : ''}`}
        src={bookingAgreementPdfUrl(project.id)}
        downloadHref={bookingAgreementPdfUrl(project.id, true)}
        onClose={() => setShowPdf(false)}
      />
    </div>
  )
}

// A PDF shown in place, the way a mail client shows an attachment.
//
// The route serves `Content-Disposition: inline` when download isn't asked for, so the browser's own
// viewer renders it in the frame. Downloading is still one click away, it just isn't the only way to
// look at the thing.
function PdfPreview({
  open, title, src, downloadHref, onClose,
}: {
  open: boolean
  title: string
  src: string
  downloadHref: string
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

  if (!open) return null
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
      <div className="relative flex h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-line-strong bg-surface shadow-[0_30px_70px_-30px_rgba(0,0,0,0.9)]">
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
          <p className="truncate text-[13px] font-medium text-parchment">{title}</p>
          <div className="flex flex-none items-center gap-2">
            <a
              href={downloadHref}
              className="rounded-lg border border-line px-3 py-1.5 text-[12px] font-medium text-muted transition-colors hover:border-line-strong hover:text-parchment"
            >
              Download
            </a>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-line px-3 py-1.5 text-[12px] font-medium text-muted transition-colors hover:border-line-strong hover:text-parchment"
            >
              Close
            </button>
          </div>
        </div>
        <iframe src={src} title={title} className="min-h-0 flex-1 bg-white" />
      </div>
    </div>
  )
}
