import { useEffect, useState } from 'react'
import { type Project } from '../pipeline'
import {
  loadContracts,
  loadEsignStatus,
  loadContractTemplates,
  sendContract,
  refreshContractSignature,
  signedContractPdfUrl,
  deleteContract,
  loadBookingStatus,
  createBookingLink,
  pullBookingSubmission,
  bookingAgreementPdfUrl,
  type BookingStatus,
  type ContractVersion,
  type EsignInfo,
  type EsignStatus,
  type SignwellTemplate,
} from '../api'
import { SignerModal } from './SignerModal'

// The Booking-section "Contract" card. Two routes out of here:
//
//  1. E-SIGNATURE (SignWell): pick a SignWell template and send it; the card tracks status
//     (Awaiting signature -> Signed) and serves the signed PDF.
//  2. FILLABLE PDF (no service, added 2026-08-02): the CRM builds a PDF with real form fields from
//     its OWN agreement template. Michael emails it, the client types their answers and their name
//     into it and emails it back. No account, no per-signature cost, but also no audit trail and no
//     "they opened it" tracking. This is the route Michael asked for after seeing a friend use it.

function fmtDate(iso: string) {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
function isSigned(e: EsignInfo) {
  const s = (e.status || '').toLowerCase()
  return !!e.signedAt || s === 'completed' || s === 'signed'
}
function esignLabel(e: EsignInfo): { label: string; color: string } {
  const s = (e.status || '').toLowerCase()
  if (isSigned(e)) return { label: 'Signed', color: 'var(--color-umb-booked)' }
  if (s === 'declined') return { label: 'Declined', color: '#e08a6b' }
  if (s === 'expired') return { label: 'Expired', color: 'var(--color-faint)' }
  return { label: 'Awaiting signature', color: 'var(--color-brass)' }
}

export function ContractCard({ project, signerName, signerEmail }: { project: Project; signerName?: string; signerEmail?: string }) {
  const [contracts, setContracts] = useState<ContractVersion[] | null>(null)
  const [esignCfg, setEsignCfg] = useState<EsignStatus | null>(null)
  const [templates, setTemplates] = useState<SignwellTemplate[] | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [sendTarget, setSendTarget] = useState<SignwellTemplate | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  // The fillable route asks the client for whatever event facts the CRM is still missing, so show
  // the count up front: it tells Michael at a glance how much this PDF is doing for him.
  const [booking, setBooking] = useState<BookingStatus | null>(null)
  const [bookBusy, setBookBusy] = useState(false)

  const refresh = () => {
    loadContracts()
      .then((all) => setContracts(all[project.id] ?? []))
      .catch(() => setContracts([]))
  }
  useEffect(refresh, [project.id])
  useEffect(() => {
    loadEsignStatus()
      .then(setEsignCfg)
      .catch(() => setEsignCfg({ configured: false, testMode: true }))
    loadContractTemplates()
      .then(setTemplates)
      .catch(() => setTemplates([]))
  }, [])
  useEffect(() => {
    loadBookingStatus(project.id)
      .then(setBooking)
      .catch(() => setBooking(null))
  }, [project.id])

  // Issue the link. Sending the email is the next step and is not wired yet.
  const makeLink = async () => {
    setBookBusy(true)
    setNote(null)
    try {
      setBooking(await createBookingLink(project.id))
    } catch (e) {
      setNote(String(e instanceof Error ? e.message : e))
    } finally {
      setBookBusy(false)
    }
  }

  // Check whether they've submitted, and pull it into the project if so.
  const checkForSubmission = async () => {
    setBookBusy(true)
    setNote(null)
    try {
      const r = await pullBookingSubmission(project.id)
      if (!r.ok) setNote(r.error || 'Could not check for a submission.')
      else if (r.fresh) setNote(`Got it. Filled in: ${(r.filledFields || []).join(', ')}.`)
      else setNote('Nothing new yet.')
      setBooking(await loadBookingStatus(project.id))
    } finally {
      setBookBusy(false)
    }
  }


  const defaultEmail = (project.contactEmails || '').split(/[,;]/)[0].trim()

  // The project fields this contract prefills into SignWell (see sendContractFromTemplate).
  // Any left blank are flagged before sending: either set them up as Client + Required in
  // SignWell (the client fills them), or fill them here, or knowingly send anyway.
  const missingFields = (
    [
      ['eventLocation', 'Venue / location'],
      ['eventDate', 'Event date'],
      ['showStartTime', 'Show start time'],
      ['performanceStyle', 'Performance / services'],
      ['totalFee', 'Booking fee'],
    ] as const
  )
    .filter(([key]) => {
      const v = project[key]
      return v == null || String(v).trim() === ''
    })
    .map(([, label]) => label)

  const send = async (name: string, email: string) => {
    if (!sendTarget) return
    setBusy(true)
    setNote(null)
    try {
      await sendContract(project.id, sendTarget.id, sendTarget.name, name, email)
      setSendTarget(null)
      setNote(`Sent to ${email} for signature.`)
      refresh()
    } catch (e) {
      setNote(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(false)
    }
  }
  const refreshOne = async (id: string) => {
    setBusy(true)
    setNote(null)
    try {
      const v = await refreshContractSignature(project.id, id)
      refresh()
      setNote(v.esign && isSigned(v.esign) ? 'Signed. The signed PDF is ready.' : 'Status updated. Not signed yet.')
    } catch (e) {
      setNote(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(false)
    }
  }
  const remove = async (id: string) => {
    if (!window.confirm('Remove this contract from the project? (It does not delete it in SignWell.)')) return
    setBusy(true)
    setNote(null)
    try {
      await deleteContract(project.id, id)
      refresh()
    } catch (e) {
      setNote(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(false)
    }
  }

  const sorted = (contracts ?? []).slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
  const ready = esignCfg?.configured && templates && templates.length > 0

  return (
    <div className="rounded-xl border border-line bg-surface-2/30 px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] font-medium text-parchment">Contract</p>
        {ready && (
          <div className="relative">
            <button
              type="button"
              onClick={() => setPickerOpen((o) => !o)}
              className="rounded-lg border border-brass-dim/60 bg-surface-3 px-2.5 py-1 text-[11.5px] font-semibold text-brass-bright transition-colors hover:border-brass"
            >
              Send contract ▾
            </button>
            {pickerOpen && (
              <div className="absolute right-0 top-[calc(100%+4px)] z-10 w-64 overflow-hidden rounded-lg border border-line-strong bg-surface-2 py-1 shadow-[0_20px_50px_-20px_rgba(0,0,0,0.9)]">
                {templates!.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => {
                      setPickerOpen(false)
                      setSendTarget(t)
                    }}
                    className="block w-full px-3 py-1.5 text-left text-[12px] text-parchment hover:bg-surface-3"
                  >
                    {t.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Booking route: send a form, get the details back, generate the agreement. */}
      <div className="mt-2 rounded-lg border border-line bg-surface-2/40 px-3 py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[12px] font-medium text-parchment">Booking form</p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-faint">
              {booking?.submission
                ? `They submitted ${booking.summary.length} details. The agreement is ready.`
                : booking?.url
                  ? 'Link ready. Send it, then check back for their answers.'
                  : 'Send the client a form to collect the event details.'}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {!booking?.url && (
              <button
                type="button"
                disabled={bookBusy}
                onClick={makeLink}
                className="rounded-lg border border-brass-dim/60 bg-surface-3 px-2.5 py-1 text-[11.5px] font-semibold text-brass-bright transition-colors hover:border-brass disabled:opacity-40"
              >
                {bookBusy ? 'Working…' : 'Create link'}
              </button>
            )}
            {booking?.url && !booking.submission && (
              <button
                type="button"
                disabled={bookBusy}
                onClick={checkForSubmission}
                className="rounded-lg border border-line px-2.5 py-1 text-[11.5px] font-medium text-muted transition-colors hover:border-line-strong hover:text-parchment disabled:opacity-40"
              >
                {bookBusy ? 'Checking…' : 'Check for answers'}
              </button>
            )}
            {booking?.submission && (
              <button
                type="button"
                onClick={() => window.open(bookingAgreementPdfUrl(project.id, true), '_blank')}
                className="rounded-lg border border-brass-dim/60 bg-surface-3 px-2.5 py-1 text-[11.5px] font-semibold text-brass-bright transition-colors hover:border-brass"
              >
                Agreement PDF
              </button>
            )}
          </div>
        </div>
        {booking?.url && (
          <p className="mt-2 truncate border-t border-line/60 pt-2 text-[10.5px] text-faint" title={booking.url}>
            {booking.url}
          </p>
        )}
        {booking?.invoiceTo?.name && (
          <p className="mt-1 text-[10.5px] text-faint">Invoice to: {booking.invoiceTo.name} ({booking.invoiceTo.email})</p>
        )}
      </div>

      {contracts == null || templates == null || esignCfg == null ? (
        <p className="mt-1 text-[11.5px] text-faint">Loading…</p>
      ) : !esignCfg.configured ? (
        <p className="mt-1 text-[11.5px] leading-relaxed text-faint">
          SignWell isn't connected. Add your API key to <span className="text-muted">signwell-credentials.json</span>.
        </p>
      ) : templates.length === 0 ? (
        <p className="mt-1 text-[11.5px] leading-relaxed text-faint">
          No contract templates found in SignWell. Create one there first (upload the PDF from the Files page and place the
          fields), then it'll show up here to send.
        </p>
      ) : sorted.length === 0 ? (
        <p className="mt-1 text-[11.5px] leading-relaxed text-faint">
          Pick a contract above to send it for signature, auto-filled from this project.
          {esignCfg.testMode ? ' (SignWell is in test mode; flip testMode to false to send real, binding contracts.)' : ''}
        </p>
      ) : (
        <ul className="mt-2 space-y-2">
          {sorted.map((c) => {
            const e = c.esign
            const el = e ? esignLabel(e) : { label: 'Sent', color: 'var(--color-faint)' }
            return (
              <li key={c.id} className="rounded-lg border border-line bg-surface-2/40 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] font-medium text-parchment">{c.templateLabel || 'Contract'}</span>
                    <span
                      className="rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em]"
                      style={{ color: el.color, backgroundColor: `color-mix(in oklab, ${el.color} 16%, transparent)` }}
                    >
                      {el.label}
                    </span>
                    {e?.testMode && <span className="text-[10px] text-faint">test</span>}
                  </div>
                  <span className="text-[10.5px] text-faint">{fmtDate(c.createdAt)}</span>
                </div>
                {e && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                    <span className="text-faint">{isSigned(e) ? `signed ${fmtDate(e.signedAt)}` : `sent to ${e.signerEmail}`}</span>
                    {isSigned(e) ? (
                      <button
                        type="button"
                        onClick={() => window.open(signedContractPdfUrl(project.id, c.id), '_blank')}
                        className="text-brass-bright underline-offset-2 hover:underline"
                      >
                        Signed PDF
                      </button>
                    ) : (
                      <button type="button" disabled={busy} onClick={() => refreshOne(c.id)} className="text-muted hover:text-parchment disabled:opacity-40">
                        Refresh status
                      </button>
                    )}
                    <button type="button" disabled={busy} onClick={() => remove(c.id)} className="text-[#e08a6b] hover:brightness-110 disabled:opacity-40">
                      Remove
                    </button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {note && <p className="mt-2 text-[11px] leading-relaxed text-muted">{note}</p>}

      <SignerModal
        open={sendTarget != null}
        defaultName={signerName || project.client}
        defaultEmail={signerEmail || defaultEmail}
        testMode={esignCfg?.testMode ?? true}
        busy={busy}
        missingFields={missingFields}
        onCancel={() => setSendTarget(null)}
        onSend={send}
      />
    </div>
  )
}
