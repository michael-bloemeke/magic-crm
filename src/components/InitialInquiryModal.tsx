import { useEffect } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { type Project } from '../pipeline'
import { type InquiryForm } from '../api'
import { EditableField } from './EditableField'

// How a project started: the client's own first message, plus the website contact form they filled
// in (when the project came from the site). Opened from the button at the top of Communication, so
// the origin of the relationship is one click away without taking up room on the page.
// The message is editable (paste in the first email for a project that arrived some other way);
// the form fill is a read-only record of what was actually submitted.

// Gig-site leads (GigSalad, The Bash, Bark) are created by the `gig-leads` edge function, which
// writes the lead's listing link into the message as "Open the lead on <Site>: <url>". The message
// is a plain editable text box, so a URL in it is not clickable; this pulls those links out and
// shows them as real buttons under the message. Added 2026-10-11 at Michael's request.
const LEAD_SITES: Array<[RegExp, string]> = [
  [/(^|\.)gigsalad\.com$/i, 'GigSalad'],
  [/(^|\.)thebash\.com$/i, 'The Bash'],
  [/(^|\.)bark\.com$/i, 'Bark'],
]
function leadLinks(text: string): { url: string; site: string }[] {
  const out: { url: string; site: string }[] = []
  for (const raw of String(text || '').match(/https?:\/\/[^\s<>"]+/g) ?? []) {
    try {
      const host = new URL(raw).hostname
      const hit = LEAD_SITES.find(([re]) => re.test(host))
      if (hit && !out.some((x) => x.url === raw)) out.push({ url: raw, site: hit[1] })
    } catch {
      /* not a URL */
    }
  }
  return out
}

// '2026-06-24T19:31:05.883Z' -> 'Jun 24, 2026, 3:31 PM' (local).
function fmtSubmitted(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function InitialInquiryModal({
  open,
  project,
  form,
  onClose,
  onSaveField,
}: {
  open: boolean
  project: Project
  form: InquiryForm | null
  onClose: () => void
  onSaveField: (field: string, value: string) => void
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const fields = form?.fields ?? []

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
            className="board-scroll relative max-h-[88vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-line-strong bg-surface shadow-[0_30px_70px_-30px_rgba(0,0,0,0.18)]"
            initial={{ y: 16, opacity: 0.6, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 16, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="border-b border-line px-6 pb-4 pt-5">
              <h2 className="font-display text-[20px] leading-tight text-parchment">Initial inquiry</h2>
              <p className="mt-1 text-[12.5px] text-muted">
                How <span className="text-parchment">{project.client}</span> first got in touch
                {form?.submittedAt ? `, ${fmtSubmitted(form.submittedAt)}` : ''}.
              </p>
            </div>

            <div className="space-y-6 px-6 py-5">
              <section>
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-brass-dim">Their message</h3>
                <div className="rounded-xl border border-line bg-surface-2/40 px-3 py-2">
                  <EditableField
                    value={project.initialInquiry}
                    onSave={(v) => onSaveField('initialInquiry', v)}
                    multiline
                    placeholder="What the client wrote when they first reached out."
                  />
                </div>
                {leadLinks(project.initialInquiry).map((l) => (
                  <a
                    key={l.url}
                    href={l.url}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-line-strong px-3.5 py-2 text-[12.5px] font-semibold text-brass-bright transition-colors hover:border-brass hover:text-brass"
                  >
                    Open this lead on {l.site}
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M14 4h6v6M20 4l-8 8M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
                    </svg>
                  </a>
                ))}
              </section>

              {fields.length > 0 && (
                <section>
                  <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-brass-dim">Website form</h3>
                  <div className="space-y-1.5 rounded-xl border border-line bg-surface-2/40 px-3.5 py-3">
                    {fields.map((f) => (
                      <div key={f.key} className="text-[13px] leading-relaxed">
                        <span className="text-faint">{f.label}: </span>
                        <span className="whitespace-pre-wrap text-parchment">{f.value}</span>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {fields.length === 0 && leadLinks(project.initialInquiry).length === 0 && (
                <p className="text-[12px] text-faint">
                  No website form on file. (The form is saved automatically for inquiries that come through the site.)
                </p>
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
