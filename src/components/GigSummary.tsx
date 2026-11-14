import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { loadGigSummary, writeGigSummary, type GigSummary, type GigSummaryRow } from '../api'

// THE GIG SUMMARY (Michael, 2026-11-14): "everything that I need to know about the gig... as if I were
// going to leave for that gig today." One button on every project page and on each Home "Next 7 days"
// card. It opens a window over the CRM (the same kind as Book a follow-up call). The first open has
// Claude write the summary; after that it just shows the saved one, with the date and time it was
// written at the top and a Regenerate button. Writing happens on the Mac (crm-gig-summary.mjs).
//
// Module scope on purpose: never declare a component inside another (the inner-component trap).

const TIMEZONE = 'America/New_York'
function whenWritten(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const day = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(d)
  const time = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, hour: 'numeric', minute: '2-digit' }).format(d)
  return `${day} at ${time}`
}

const ICON = (
  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5M9 13h6M9 17h6M9 9h2" />
  </svg>
)

export function GigSummaryButton({ projectId, projectName, compact = false }: { projectId: string; projectName: string; compact?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          setOpen(true)
        }}
        onKeyDown={(e) => e.stopPropagation()}
        title="What you need to know for this gig, written by Claude"
        className={[
          'inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-brass-dim/60 bg-surface-2 font-semibold text-brass-bright transition-colors hover:border-brass',
          compact ? 'px-2 py-1 text-[11.5px]' : 'px-2.5 py-1.5 text-[12.5px]',
        ].join(' ')}
      >
        {ICON}
        Gig summary
      </button>
      {open && <GigSummaryModal projectId={projectId} projectName={projectName} onClose={() => setOpen(false)} />}
    </>
  )
}

function GigSummaryModal({ projectId, projectName, onClose }: { projectId: string; projectName: string; onClose: () => void }) {
  const [row, setRow] = useState<GigSummaryRow | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false) // a write is running (here or reported by the server)
  const [err, setErr] = useState('')
  const started = useRef(false)

  const refresh = useCallback(async () => {
    try {
      const r = await loadGigSummary(projectId)
      setRow(r.row)
      const writing = r.writing || r.row?.status === 'writing' || r.row?.status === 'requested'
      setBusy(writing)
      setErr('')
      return { row: r.row, writing }
    } catch (e) {
      setErr(String((e as Error)?.message || e))
      return { row: null, writing: false }
    } finally {
      setLoaded(true)
    }
  }, [projectId])

  const write = useCallback(async () => {
    setBusy(true)
    setErr('')
    try {
      await writeGigSummary(projectId)
    } catch (e) {
      setErr(String((e as Error)?.message || e))
      setBusy(false)
    }
  }, [projectId])

  // First open: show the saved summary, or start writing one when there is none yet.
  useEffect(() => {
    void refresh().then(({ row: r, writing }) => {
      if (started.current) return
      started.current = true
      if (!r?.summary && !writing) void write()
    })
  }, [refresh, write])

  // While Claude is writing, look again every few seconds.
  useEffect(() => {
    if (!busy) return
    const t = window.setInterval(() => void refresh(), 3000)
    return () => window.clearInterval(t)
  }, [busy, refresh])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const summary = row?.summary || null
  const failed = !busy && row?.status === 'error'

  // A portal, so the window is never trapped inside a transformed (animated) parent. Clicks and keys
  // are stopped at the root: React events bubble through a portal to its React parents, and a Home card
  // would otherwise open the project when the window is clicked.
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-6" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Gig summary: ${projectName}`}
        className="relative flex max-h-[min(90vh,960px)] w-[min(760px,94vw)] flex-col overflow-hidden rounded-2xl border border-line-strong bg-surface shadow-[0_40px_80px_-30px_rgba(0,0,0,0.35)]"
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-6 py-4">
          <div className="min-w-0">
            <h2 className="font-display text-[21px] leading-tight text-parchment">{summary?.headline || `Gig summary: ${projectName}`}</h2>
            <p className="mt-1 text-[13px] font-semibold text-parchment">
              {summary && row?.generated_at ? `Generated ${whenWritten(row.generated_at)}` : busy ? 'Claude is writing this summary now.' : ''}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {summary && (
              <button
                type="button"
                onClick={() => void write()}
                disabled={busy}
                className="rounded-lg border border-line px-2.5 py-1.5 text-[12.5px] font-semibold text-parchment transition-colors hover:border-line-strong disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? 'Writing...' : 'Regenerate'}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded-lg border border-line p-1.5 text-parchment transition-colors hover:border-line-strong"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {busy && summary && (
            <p className="mb-4 rounded-lg border border-brass-dim/60 bg-surface-2 px-3 py-2 text-[13px] text-parchment">
              Writing a new summary. This one stays here until it is ready.
            </p>
          )}
          {(err || failed) && (
            <div className="mb-4 rounded-lg border border-[#dc2626]/60 px-3 py-2 text-[13px] text-parchment">
              <p className="font-semibold text-[#dc2626]">The summary could not be written.</p>
              <p className="mt-0.5">{err || row?.error}</p>
              <button type="button" onClick={() => void write()} className="mt-2 rounded-lg border border-line px-2.5 py-1 text-[12.5px] font-semibold text-parchment hover:border-line-strong">
                Try again
              </button>
            </div>
          )}
          {!loaded ? (
            <p className="py-10 text-center text-[14px] text-parchment">Loading...</p>
          ) : summary ? (
            <SummaryBody s={summary} />
          ) : busy ? (
            <p className="py-10 text-center text-[14px] text-parchment">Claude is reading this project and writing the summary. It takes about a minute.</p>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-5">
      <h3 className="mb-1.5 font-display text-[17px] text-parchment">{title}</h3>
      {children}
    </section>
  )
}

function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="list-disc space-y-1 pl-5 text-[14px] leading-relaxed text-parchment">
      {items.map((t, i) => (
        <li key={i}>{t}</li>
      ))}
    </ul>
  )
}

function SummaryBody({ s }: { s: GigSummary }) {
  const loc = s.location || { venue: '', address: '', details: [] }
  return (
    <div>
      {s.overview && <p className="mb-5 text-[15px] leading-relaxed text-parchment">{s.overview}</p>}

      {s.missing.length > 0 && (
        <div className="mb-5 rounded-lg border border-[#d97706]/70 bg-[#d97706]/10 px-4 py-3">
          <h3 className="mb-1 text-[14px] font-bold text-parchment">Still missing</h3>
          <Bullets items={s.missing} />
        </div>
      )}

      {s.schedule.length > 0 && (
        <Section title="Schedule">
          <dl className="grid grid-cols-[minmax(6.5rem,auto)_1fr] gap-x-4 gap-y-1.5 text-[14px] text-parchment">
            {s.schedule.map((x, i) => (
              <div key={i} className="contents">
                <dt className="font-bold tabular-nums">{x.time}</dt>
                <dd>{x.what}</dd>
              </div>
            ))}
          </dl>
        </Section>
      )}

      {(loc.venue || loc.address || loc.details.length > 0) && (
        <Section title="Where">
          {loc.venue && <p className="text-[14px] font-semibold text-parchment">{loc.venue}</p>}
          {loc.address && (
            <p className="text-[14px] text-parchment">
              <a
                href={`https://maps.google.com/?q=${encodeURIComponent(loc.address)}`}
                target="_blank"
                rel="noreferrer"
                className="underline decoration-brass-dim underline-offset-2 hover:decoration-brass"
              >
                {loc.address}
              </a>
            </p>
          )}
          {loc.details.length > 0 && <div className="mt-1.5"><Bullets items={loc.details} /></div>}
        </Section>
      )}

      {s.performance.length > 0 && (
        <Section title="The performance">
          <Bullets items={s.performance} />
        </Section>
      )}

      {s.notes.length > 0 && (
        <Section title="Good to know">
          <Bullets items={s.notes} />
        </Section>
      )}

      {s.contacts.length > 0 && (
        <Section title="Contacts">
          <ul className="space-y-1 text-[14px] text-parchment">
            {s.contacts.map((c, i) => (
              <li key={i}>
                <span className="font-semibold">{c.name}</span>
                {c.role ? `, ${c.role}` : ''}
                {c.phone ? <span className="tabular-nums">{`: ${c.phone}`}</span> : ''}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {s.collect && (
        <Section title="To collect at the gig">
          <p className="text-[14px] font-semibold text-parchment">{s.collect}</p>
        </Section>
      )}
    </div>
  )
}
