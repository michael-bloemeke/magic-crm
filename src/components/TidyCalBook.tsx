import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { TIDYCAL_BOOKING_PAGES, tidyCalBookingUrl, type TidyCalBookingPage } from '../tidycal'

// Book a TidyCal call from inside the CRM (Michael, 2026-11-13). Two buttons, Follow-up call and Event
// planning call, each opening that TidyCal page in a window over the CRM. Given `who` (a project's
// primary contact) the page arrives with their name and email filled in; without it, it is blank. The
// booking then shows on the project's TidyCal bar within about 20 seconds, like any other booking.
type Who = { name?: string; email?: string; phone?: string }

// "Book a follow-up call", "Book an event planning call".
function bookLabel(p: TidyCalBookingPage): string {
  const l = p.label.toLowerCase()
  return `Book ${/^[aeiou]/.test(l) ? 'an' : 'a'} ${l}`
}

export function TidyCalBookButtons({ who, className = '' }: { who?: Who; className?: string }) {
  const [open, setOpen] = useState<TidyCalBookingPage | null>(null)
  return (
    <div className={['inline-flex flex-wrap items-center gap-1.5', className].join(' ')}>
      {TIDYCAL_BOOKING_PAGES.map((p) => (
        <button
          key={p.key}
          type="button"
          onClick={() => setOpen(p)}
          title={`${bookLabel(p)}${who?.name ? ` with ${who.name}` : ''}`}
          className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 text-[12.5px] font-medium text-muted transition-colors hover:border-line-strong hover:text-parchment"
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4.5" width="18" height="17" rx="2" />
            <path d="M16 2.5v4M8 2.5v4M3 10h18M12 13.5v5M9.5 16h5" />
          </svg>
          {p.label}
        </button>
      ))}
      {open && <TidyCalBookModal page={open} who={who} onClose={() => setOpen(null)} />}
    </div>
  )
}

function TidyCalBookModal({ page, who, onClose }: { page: TidyCalBookingPage; who?: Who; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  // A portal, so the window is never trapped inside a transformed (animated) parent.
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={page.label}
        className="relative flex h-[min(88vh,900px)] w-[min(980px,94vw)] flex-col overflow-hidden rounded-2xl border border-line-strong bg-surface shadow-[0_40px_80px_-30px_rgba(0,0,0,0.35)]"
      >
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
          <div className="min-w-0">
            <h2 className="font-display text-[19px] leading-tight text-parchment">{bookLabel(page)}</h2>
            <p className="truncate text-[12.5px] text-muted">
              {who?.name || who?.email
                ? `For ${[who?.name, who?.email].filter(Boolean).join(', ')}. TidyCal sends them the invite.`
                : "Type in the client's name and email. TidyCal sends them the invite."}
            </p>
          </div>
          {/* The Event Planning Call asks for the CLIENT's phone number, and TidyCal's page only takes a
              name and email from the link (checked in its booking-page code, 2026-11-13). So the number is
              shown here with a Copy button to paste into that field. */}
          {page.key === 'planning' && who?.phone ? <CopyPhone phone={who.phone} /> : null}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg border border-line p-1.5 text-muted transition-colors hover:border-line-strong hover:text-parchment"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <iframe title={page.label} src={tidyCalBookingUrl(page.path, who)} className="min-h-0 w-full flex-1 border-0 bg-white" />
      </div>
    </div>,
    document.body,
  )
}

function CopyPhone({ phone }: { phone: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="ml-auto flex shrink-0 items-center gap-2 text-[12.5px] text-muted">
      <span>
        Their phone: <span className="font-medium text-parchment">{phone}</span>
      </span>
      <button
        type="button"
        onClick={() => {
          navigator.clipboard
            .writeText(phone)
            .then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
            .catch(() => {})
        }}
        className="rounded-lg border border-line px-2.5 py-1 font-medium text-muted transition-colors hover:border-line-strong hover:text-parchment"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}
