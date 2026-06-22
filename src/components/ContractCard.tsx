import { useEffect, useState } from 'react'
import { type Project } from '../pipeline'
import {
  loadContracts,
  deleteContract,
  contractPdfUrl,
  loadEsignStatus,
  sendContractForSignature,
  refreshContractSignature,
  signedContractPdfUrl,
  type ContractVersion,
  type EsignInfo,
  type EsignStatus,
} from '../api'
import { ContractGenerateModal } from './ContractGenerateModal'
import { SignerModal } from './SignerModal'

// The Booking-section "Contract" card. Generates a Performance Services Agreement
// (auto-filled, rich-text editable), keeps every version, and can send a version for
// e-signature via SignWell (then poll status and fetch the signed PDF). He can also just
// preview/download the PDF to sign manually.

function fmtDate(iso: string) {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

const STATUS_STYLE: Record<string, { label: string; color: string }> = {
  draft: { label: 'Draft', color: 'var(--color-faint)' },
  sent: { label: 'Sent', color: 'var(--color-umb-booked)' },
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

export function ContractCard({ project }: { project: Project }) {
  const [versions, setVersions] = useState<ContractVersion[] | null>(null)
  const [esignCfg, setEsignCfg] = useState<EsignStatus | null>(null)
  const [genOpen, setGenOpen] = useState(false)
  const [signerFor, setSignerFor] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const refresh = () => {
    loadContracts()
      .then((all) => setVersions(all[project.id] ?? []))
      .catch(() => setVersions([]))
  }
  useEffect(refresh, [project.id])
  useEffect(() => {
    loadEsignStatus()
      .then(setEsignCfg)
      .catch(() => setEsignCfg({ configured: false, testMode: true }))
  }, [])

  const defaultEmail = (project.contactEmails || '').split(/[,;]/)[0].trim()

  const onCreated = (c: ContractVersion) => {
    setGenOpen(false)
    setNote(`Contract v${c.version} generated.`)
    refresh()
  }
  const preview = (id: string) => window.open(contractPdfUrl(project.id, id), '_blank')
  const remove = async (id: string) => {
    if (!window.confirm('Delete this contract version? This cannot be undone.')) return
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
  const sendSign = async (name: string, email: string) => {
    if (!signerFor) return
    setBusy(true)
    setNote(null)
    try {
      await sendContractForSignature(project.id, signerFor, name, email)
      setSignerFor(null)
      setNote(`Sent to ${email} for signature.`)
      refresh()
    } catch (e) {
      setNote(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(false)
    }
  }
  const refreshSign = async (id: string) => {
    setBusy(true)
    setNote(null)
    try {
      const v = await refreshContractSignature(project.id, id)
      refresh()
      if (v.esign && isSigned(v.esign)) setNote('Signed. The signed PDF is now available.')
      else setNote('Status updated. Not signed yet.')
    } catch (e) {
      setNote(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(false)
    }
  }

  const sorted = (versions ?? []).slice().sort((a, b) => b.version - a.version)
  const hasAny = sorted.length > 0

  return (
    <div className="rounded-xl border border-line bg-surface-2/30 px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] font-medium text-parchment">Contract</p>
        {hasAny && (
          <button
            type="button"
            onClick={() => setGenOpen(true)}
            className="rounded-lg border border-line px-2.5 py-1 text-[11.5px] font-medium text-muted transition-colors hover:border-line-strong hover:text-parchment"
          >
            New version
          </button>
        )}
      </div>

      {versions == null ? (
        <p className="mt-1 text-[11.5px] text-faint">Loading…</p>
      ) : !hasAny ? (
        <>
          <p className="mt-1 text-[11.5px] leading-relaxed text-faint">
            Generate a performance agreement, auto-filled from this project. Edit it for the client, then send it for
            e-signature or download the PDF to sign manually.
          </p>
          <button
            type="button"
            onClick={() => setGenOpen(true)}
            className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-brass-dim/60 bg-surface-3 px-3 py-1.5 text-[12px] font-semibold text-brass-bright transition-colors hover:border-brass"
          >
            Generate contract
          </button>
        </>
      ) : (
        <ul className="mt-2 space-y-2">
          {sorted.map((c) => {
            const st = STATUS_STYLE[c.status] ?? STATUS_STYLE.draft
            const e = c.esign
            return (
              <li key={c.id} className="rounded-lg border border-line bg-surface-2/40 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] font-semibold text-parchment">v{c.version}</span>
                    <span
                      className="rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em]"
                      style={{ color: st.color, backgroundColor: `color-mix(in oklab, ${st.color} 16%, transparent)` }}
                    >
                      {st.label}
                    </span>
                    {c.includeMedia && <span className="text-[10px] text-faint">+ media</span>}
                  </div>
                  <span className="text-[10.5px] text-faint">{fmtDate(c.createdAt)}</span>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                  <button type="button" onClick={() => preview(c.id)} className="text-brass-bright underline-offset-2 hover:underline">
                    Preview
                  </button>
                  {esignCfg?.configured && !e && (
                    <button type="button" disabled={busy} onClick={() => setSignerFor(c.id)} className="text-muted hover:text-parchment disabled:opacity-40">
                      Send for signature
                    </button>
                  )}
                  <button type="button" disabled={busy} onClick={() => remove(c.id)} className="text-[#e08a6b] hover:brightness-110 disabled:opacity-40">
                    Delete
                  </button>
                </div>

                {e && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line/60 pt-1.5 text-[11px]">
                    {(() => {
                      const el = esignLabel(e)
                      return (
                        <span
                          className="rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em]"
                          style={{ color: el.color, backgroundColor: `color-mix(in oklab, ${el.color} 16%, transparent)` }}
                        >
                          {el.label}
                        </span>
                      )
                    })()}
                    <span className="text-faint">
                      {isSigned(e) ? `signed ${fmtDate(e.signedAt)}` : `sent to ${e.signerEmail}`}
                      {e.testMode ? ' · test' : ''}
                    </span>
                    {isSigned(e) ? (
                      <button
                        type="button"
                        onClick={() => window.open(signedContractPdfUrl(project.id, c.id), '_blank')}
                        className="text-brass-bright underline-offset-2 hover:underline"
                      >
                        Signed PDF
                      </button>
                    ) : (
                      <button type="button" disabled={busy} onClick={() => refreshSign(c.id)} className="text-muted hover:text-parchment disabled:opacity-40">
                        Refresh status
                      </button>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {note && <p className="mt-2 text-[11px] leading-relaxed text-muted">{note}</p>}

      <ContractGenerateModal project={genOpen ? project : null} onCancel={() => setGenOpen(false)} onCreated={onCreated} />
      <SignerModal
        open={signerFor != null}
        defaultName={project.client}
        defaultEmail={defaultEmail}
        testMode={esignCfg?.testMode ?? true}
        busy={busy}
        onCancel={() => setSignerFor(null)}
        onSend={sendSign}
      />
    </div>
  )
}
