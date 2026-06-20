import { useEffect, useState } from 'react'
import { type Project } from '../pipeline'
import {
  loadQuickBooks,
  sendQbInvoice,
  qbInvoicePdfUrl,
  type QuickBooksInvoice,
  type QuickBooksStatus,
} from '../api'
import { InvoiceGenerateModal } from './InvoiceGenerateModal'

// The Booking-section "Invoice" card, backed by QuickBooks. If QuickBooks isn't
// connected it offers a one-time Connect. Once connected, "Generate invoice" creates
// the invoice in QuickBooks from the project's client + quote, and a separate "Send"
// button emails it to the client. The invoice itself lives in QuickBooks; the CRM
// just shows its number, total, and sent status.
function money(n: number) {
  return '$' + Math.round(n || 0).toLocaleString('en-US')
}
function fmtDate(iso: string) {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
function fmtDay(ymd: string) {
  if (!ymd) return ''
  const d = new Date(ymd + 'T00:00:00')
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function InvoiceCard({ project }: { project: Project }) {
  const [status, setStatus] = useState<QuickBooksStatus | null>(null)
  const [invoice, setInvoice] = useState<QuickBooksInvoice | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [genOpen, setGenOpen] = useState(false)

  useEffect(() => {
    let live = true
    loadQuickBooks()
      .then(({ status, invoices }) => {
        if (!live) return
        setStatus(status)
        setInvoice(invoices[project.id] ?? null)
      })
      .catch(() => {
        if (live) setStatus({ configured: false, connected: false, environment: 'sandbox' })
      })
    return () => {
      live = false
    }
  }, [project.id])

  const onCreated = (inv: QuickBooksInvoice) => {
    setInvoice(inv)
    setNote(invoice ? 'Invoice regenerated in QuickBooks.' : 'Invoice created in QuickBooks.')
    setGenOpen(false)
  }
  const send = async () => {
    setBusy(true)
    setNote(null)
    try {
      setInvoice(await sendQbInvoice(project.id))
      setNote('Invoice emailed to the client.')
    } catch (e) {
      setNote(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(false)
    }
  }

  const preview = () => {
    // Open the QuickBooks-rendered PDF in a new browser tab. Synchronous (no await)
    // so the browser keeps it tied to the click and doesn't block the popup.
    window.open(qbInvoicePdfUrl(project.id), '_blank')
  }

  const sandbox = status?.environment !== 'production'

  return (
    <div className="rounded-xl border border-line bg-surface-2/30 px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <p className="text-[13px] font-medium text-parchment">Invoice</p>
          {status?.connected && (
            <span className="rounded-full border border-line px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em] text-faint">
              QuickBooks{sandbox ? ' (test)' : ''}
            </span>
          )}
          {invoice?.sentAt && (
            <span
              className="rounded-full px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.1em]"
              style={{ color: 'var(--color-umb-booked)', backgroundColor: 'color-mix(in oklab, var(--color-umb-booked) 16%, transparent)' }}
            >
              Sent
            </span>
          )}
        </div>
      </div>

      {!status ? (
        <p className="mt-1 text-[11.5px] text-faint">Loading…</p>
      ) : !status.configured ? (
        <p className="mt-1 text-[11.5px] leading-relaxed text-faint">
          QuickBooks isn't set up yet. Add your keys to <span className="text-muted">quickbooks-credentials.json</span>.
        </p>
      ) : !status.connected ? (
        <>
          <p className="mt-1 text-[11.5px] leading-relaxed text-faint">Connect QuickBooks once to generate invoices.</p>
          <a
            href="/api/quickbooks/auth"
            className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-brass-dim/60 bg-surface-3 px-3 py-1.5 text-[12px] font-semibold text-brass-bright transition-colors hover:border-brass"
          >
            Connect QuickBooks
          </a>
        </>
      ) : invoice ? (
        <>
          <p className="mt-1 text-[11.5px] leading-relaxed text-faint">
            Invoice {invoice.docNumber ? `#${invoice.docNumber}` : ''} for {money(invoice.total)} to {invoice.customer}.
            {invoice.processingFee ? ` Includes ${money(invoice.processingFee)} card fee.` : ''}
            {invoice.dueDate ? ` Due ${fmtDay(invoice.dueDate)}.` : ''}
            {invoice.sentAt ? ` Sent ${fmtDate(invoice.sentAt)}.` : ' Not sent yet.'}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={send}
              disabled={busy}
              className="rounded-lg bg-brass px-3 py-1.5 text-[12px] font-semibold text-[#231a0c] transition-all hover:brightness-110 disabled:opacity-40"
            >
              {busy ? 'Working…' : invoice.sentAt ? 'Send again' : 'Send to client'}
            </button>
            <button
              type="button"
              onClick={preview}
              className="rounded-lg border border-line px-3 py-1.5 text-[12px] font-medium text-muted transition-colors hover:border-line-strong hover:text-parchment"
            >
              Preview
            </button>
            <button
              type="button"
              onClick={() => setGenOpen(true)}
              disabled={busy}
              className="rounded-lg border border-line px-3 py-1.5 text-[12px] font-medium text-muted transition-colors hover:border-line-strong hover:text-parchment disabled:opacity-40"
            >
              Regenerate
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="mt-1 text-[11.5px] leading-relaxed text-faint">Generate an invoice from this project's quote.</p>
          <button
            type="button"
            onClick={generate}
            disabled={busy}
            className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-brass-dim/60 bg-surface-3 px-3 py-1.5 text-[12px] font-semibold text-brass-bright transition-colors hover:border-brass disabled:opacity-40"
          >
            {busy ? 'Generating…' : 'Generate invoice'}
          </button>
        </>
      )}

      {note && <p className="mt-2 text-[11px] leading-relaxed text-muted">{note}</p>}
    </div>
  )
}
