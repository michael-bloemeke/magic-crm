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
  createFillableContract,
  contractFillablePdfUrl,
  loadFillableQuestions,
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
  const [questions, setQuestions] = useState<string[]>([])
  const [fillBusy, setFillBusy] = useState(false)

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
    loadFillableQuestions(project.id)
      .then(setQuestions)
      .catch(() => setQuestions([]))
  }, [project.id])

  // Build the agreement from the CRM template, save it as a version, and open the fillable PDF.
  const makeFillable = async (download: boolean) => {
    setFillBusy(true)
    setNote(null)
    try {
      const c = await createFillableContract(project.id)
      window.open(contractFillablePdfUrl(project.id, c.id, download), '_blank')
      refresh()
    } catch (e) {
      setNote(String(e instanceof Error ? e.message : e))
    } finally {
      setFillBusy(false)
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

      {/* Fillable-PDF route: always available, since it needs no third-party account. */}
      <div className="mt-2 rounded-lg border border-line bg-surface-2/40 px-3 py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[12px] font-medium text-parchment">Fillable PDF</p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-faint">
              {questions.length > 0
                ? `Asks the client ${questions.length} missing detail${questions.length === 1 ? '' : 's'}, then they tick the box and type their name.`
                : 'Every event detail is already filled in, so it just asks them to tick the box and type their name.'}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              disabled={fillBusy}
              onClick={() => makeFillable(false)}
              className="rounded-lg border border-line px-2.5 py-1 text-[11.5px] font-medium text-muted transition-colors hover:border-line-strong hover:text-parchment disabled:opacity-40"
            >
              {fillBusy ? 'Building…' : 'Preview'}
            </button>
            <button
              type="button"
              disabled={fillBusy}
              onClick={() => makeFillable(true)}
              className="rounded-lg border border-brass-dim/60 bg-surface-3 px-2.5 py-1 text-[11.5px] font-semibold text-brass-bright transition-colors hover:border-brass disabled:opacity-40"
            >
              Download to email
            </button>
          </div>
        </div>
        {questions.length > 0 && (
          <ul className="mt-2 space-y-0.5 border-t border-line/60 pt-2">
            {questions.map((q) => (
              <li key={q} className="text-[10.5px] leading-relaxed text-faint">• {q}</li>
            ))}
          </ul>
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
