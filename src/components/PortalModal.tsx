import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { type Project } from '../pipeline'
import { loadPortals, publishPortal, unpublishPortal, type ShareableField } from '../api'

// The "Client portal" panel for a project. Michael ticks which client-safe fields
// to share, writes a personal note, optionally adds a couple of links, then
// Publishes. Publishing writes the curated bundle and pushes it live to Vercel
// (~30s), giving a secret link to share. Only whitelisted fields can be shared;
// the panel shows exactly what the client will see.
export function PortalModal({ open, project, onClose }: { open: boolean; project: Project; onClose: () => void }) {
  const [fieldsDef, setFieldsDef] = useState<ShareableField[]>([])
  const [baseUrl, setBaseUrl] = useState('')
  const [token, setToken] = useState('')
  const [published, setPublished] = useState(false)
  const [shared, setShared] = useState<Set<string>>(new Set())
  const [message, setMessage] = useState('')
  const [video, setVideo] = useState('')
  const [reviews, setReviews] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setStatus(null)
    setBusy(false)
    loadPortals()
      .then(({ portals, shareableFields, baseUrl }) => {
        setFieldsDef(shareableFields)
        setBaseUrl(baseUrl)
        const s = portals[project.id]
        setToken(s?.token || '')
        setPublished(!!s?.published)
        setShared(new Set(s?.sharedFields || []))
        setMessage(s?.message || '')
        setVideo(s?.links?.video || '')
        setReviews(s?.links?.reviews || '')
      })
      .catch(() => setStatus('Could not load portal settings.'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busy, onClose])

  const toggle = (id: string) =>
    setShared((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const fieldValue = (id: string) => {
    const v = (project as unknown as Record<string, unknown>)[id]
    return v == null ? '' : String(v)
  }
  const link = token ? `${baseUrl}/p/${token}` : ''

  const buildPatch = () => ({
    sharedFields: [...shared],
    message,
    links: {
      ...(video.trim() ? { video: video.trim() } : {}),
      ...(reviews.trim() ? { reviews: reviews.trim() } : {}),
    },
  })

  const doPublish = async () => {
    setBusy(true)
    setStatus('Publishing… pushing to the web, this takes about 30 seconds.')
    try {
      const r = await publishPortal(project.id, buildPatch())
      setToken(r.portal.token)
      setPublished(true)
      if (r.deploy?.ok) setStatus('Live. Copy the link below to share it with your client.')
      else setStatus(`Saved, but the deploy failed: ${r.deploy?.error || 'unknown error'}. Try Publish again.`)
    } catch {
      setStatus('Something went wrong while publishing.')
    } finally {
      setBusy(false)
    }
  }

  const doUnpublish = async () => {
    setBusy(true)
    setStatus('Taking the page down…')
    try {
      const r = await unpublishPortal(project.id)
      setPublished(false)
      setStatus(r.deploy?.ok ? 'Unpublished. The link no longer works.' : `Marked unpublished, but the deploy failed: ${r.deploy?.error || ''}`)
    } catch {
      setStatus('Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  const copyLink = () => {
    if (!link) return
    navigator.clipboard?.writeText(link).then(
      () => setStatus('Link copied.'),
      () => setStatus('Could not copy. Select and copy it manually.'),
    )
  }

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
          <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={() => !busy && onClose()} aria-hidden />
          <motion.div
            className="relative flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-line-strong bg-surface shadow-[0_40px_90px_-40px_rgba(0,0,0,0.9)]"
            initial={{ y: 16, opacity: 0, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 16, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="flex items-start justify-between gap-4 border-b border-line px-6 pb-4 pt-5">
              <div className="min-w-0">
                <h2 className="font-display text-[20px] leading-tight text-parchment">Client portal</h2>
                <p className="mt-0.5 truncate text-[12.5px] text-muted">{project.client}</p>
              </div>
              <div className="flex items-center gap-2">
                {published && (
                  <span
                    className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]"
                    style={{ color: 'var(--color-umb-booked)', backgroundColor: 'color-mix(in oklab, var(--color-umb-booked) 16%, transparent)' }}
                  >
                    Live
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => !busy && onClose()}
                  aria-label="Close"
                  className="rounded-lg border border-line p-1.5 text-muted transition-colors hover:border-line-strong hover:text-parchment"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              </div>
            </div>

            <div className="board-scroll min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
              {published && link && (
                <div className="rounded-xl border border-brass-dim/50 bg-surface-2/40 p-3">
                  <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Shareable link</p>
                  <div className="flex items-center gap-2">
                    <input
                      readOnly
                      value={link}
                      onFocus={(e) => e.currentTarget.select()}
                      className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[12px] text-parchment focus:outline-none"
                    />
                    <button type="button" onClick={copyLink} className="shrink-0 rounded-lg border border-line px-3 py-1.5 text-[12px] font-medium text-muted transition-colors hover:border-line-strong hover:text-parchment">
                      Copy
                    </button>
                    <a href={link} target="_blank" rel="noopener noreferrer" className="shrink-0 rounded-lg border border-line px-3 py-1.5 text-[12px] font-medium text-muted transition-colors hover:border-line-strong hover:text-parchment">
                      Open
                    </a>
                  </div>
                  <p className="mt-1.5 text-[11px] text-faint">Anyone with this link can view the page. There's no login, so only share it with the client.</p>
                </div>
              )}

              <div>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">What to share</p>
                  <div className="flex items-center gap-2 text-[11px]">
                    <button
                      type="button"
                      onClick={() => setShared(new Set(fieldsDef.map((f) => f.id)))}
                      className="text-muted transition-colors hover:text-parchment"
                    >
                      Select all
                    </button>
                    <span className="text-faint">·</span>
                    <button type="button" onClick={() => setShared(new Set())} className="text-muted transition-colors hover:text-parchment">
                      Clear
                    </button>
                  </div>
                </div>
                <div className="space-y-1.5">
                  {fieldsDef.map((f) => {
                    const val = fieldValue(f.id)
                    const on = shared.has(f.id)
                    return (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => toggle(f.id)}
                        className={[
                          'flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors',
                          on ? 'border-brass-dim/50 bg-surface-3/40' : 'border-line bg-surface-2/40',
                        ].join(' ')}
                      >
                        <span
                          className={[
                            'flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 transition-colors',
                            on ? 'border-brass bg-brass text-canvas' : 'border-line-strong text-transparent',
                          ].join(' ')}
                        >
                          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M20 6L9 17l-5-5" />
                          </svg>
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-[13px] text-parchment">{f.label}</span>
                          <span className="block truncate text-[11px] text-faint">{val || '(empty — will not appear)'}</span>
                        </span>
                      </button>
                    )
                  })}
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-faint">
                  Only these client-safe fields can ever be shared. Pricing, notes, the activity log, mileage, and tips can never appear on the portal.
                </p>
              </div>

              <label className="block">
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Personal note</span>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={4}
                  placeholder="A short message to greet the client on their page…"
                  className="w-full resize-y rounded-lg border border-line bg-surface-2 p-3 text-[13px] leading-relaxed text-parchment placeholder:text-faint focus:border-brass-dim focus:outline-none"
                />
              </label>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Promo video link (optional)</span>
                  <input value={video} onChange={(e) => setVideo(e.target.value)} placeholder="https://…" className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-[13px] text-parchment placeholder:text-faint focus:border-brass-dim focus:outline-none" />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Reviews link (optional)</span>
                  <input value={reviews} onChange={(e) => setReviews(e.target.value)} placeholder="https://…" className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-[13px] text-parchment placeholder:text-faint focus:border-brass-dim focus:outline-none" />
                </label>
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-line px-6 py-4">
              <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted">{status}</span>
              <div className="flex shrink-0 items-center gap-2">
                {published && (
                  <button type="button" onClick={doUnpublish} disabled={busy} className="rounded-lg border border-line px-3.5 py-2 text-[12.5px] font-medium text-muted transition-colors hover:border-[#e08a6b]/60 hover:text-[#e08a6b] disabled:opacity-40">
                    Unpublish
                  </button>
                )}
                <button type="button" onClick={doPublish} disabled={busy} className="rounded-lg bg-brass px-4 py-2 text-[12.5px] font-semibold text-[#231a0c] transition-all hover:brightness-110 disabled:opacity-40">
                  {busy ? 'Working…' : published ? 'Update live page' : 'Publish'}
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
