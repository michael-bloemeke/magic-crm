import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { draftContract, createContract, type ContractVersion } from '../api'
import { type Project } from '../pipeline'

// Generate / new-version dialog for the Performance Services Agreement. Opens with the
// contract auto-filled from the project, fully editable so Michael can tweak it for a
// specific client, with one optional "Media" clause toggle. Toggling Media re-assembles
// the draft (which resets manual edits), so set it before editing. "Generate PDF" saves
// the version; the PDF itself is produced from this text and signed/sent outside the app.

type Props = {
  project: Project | null
  onCancel: () => void
  onCreated: (contract: ContractVersion) => void
}

export function ContractGenerateModal({ project, onCancel, onCreated }: Props) {
  const [includeMedia, setIncludeMedia] = useState(false)
  const [body, setBody] = useState('')
  const [missing, setMissing] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Load a fresh auto-filled draft when the dialog opens or the Media toggle flips.
  useEffect(() => {
    if (!project) return
    let live = true
    setLoading(true)
    setError(null)
    draftContract(project.id, includeMedia)
      .then(({ body, missingFields }) => {
        if (!live) return
        setBody(body)
        setMissing(missingFields)
      })
      .catch((e) => live && setError(String(e instanceof Error ? e.message : e)))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [project, includeMedia])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const generate = async () => {
    if (!project || !body.trim()) return
    setBusy(true)
    setError(null)
    try {
      onCreated(await createContract(project.id, body, includeMedia))
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
      setBusy(false)
    }
  }

  return (
    <AnimatePresence>
      {project && (
        <motion.div
          className="fixed inset-0 z-[60] flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={onCancel} aria-hidden />

          <motion.div
            className="relative flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-line-strong bg-surface shadow-[0_30px_70px_-30px_rgba(0,0,0,0.9)]"
            initial={{ y: 16, opacity: 0.6, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 16, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="border-b border-line px-6 pb-4 pt-5">
              <h2 className="font-display text-[20px] leading-tight text-parchment">Generate contract</h2>
              <p className="mt-1 text-[12.5px] text-muted">
                For <span className="text-parchment">{project.client}</span>. Auto-filled from the project. Edit anything
                below for this client, then generate the PDF to sign and send.
              </p>
            </div>

            <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 py-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={includeMedia}
                    onChange={(e) => setIncludeMedia(e.target.checked)}
                    className="h-3.5 w-3.5 accent-[var(--color-brass)]"
                  />
                  <span className="text-[12.5px] text-parchment">Include Media clause</span>
                  <span className="text-[11px] text-faint">(photo/video permission, for gigs with a videographer)</span>
                </label>
              </div>

              {missing.length > 0 && (
                <p className="rounded-lg border border-[#e08a6b]/40 bg-[#e08a6b]/10 px-3 py-2 text-[11.5px] leading-relaxed text-[#e0a98b]">
                  Missing from the project, shown as <span className="text-parchment">[bracketed]</span> placeholders to
                  fill in: {missing.join(', ')}.
                </p>
              )}

              {loading ? (
                <p className="animate-pulse text-[12.5px] text-faint">Building draft…</p>
              ) : (
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  spellCheck
                  className="board-scroll min-h-[44vh] flex-1 resize-none rounded-xl border border-line bg-surface-2/40 px-4 py-3 font-mono text-[12px] leading-relaxed text-parchment outline-none focus:border-brass-dim"
                />
              )}

              {error && <p className="text-[11.5px] leading-relaxed text-[#e08a6b]">{error}</p>}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-line bg-surface/95 px-6 py-4">
              <button
                type="button"
                onClick={onCancel}
                className="rounded-lg border border-line px-4 py-2 text-[12.5px] font-medium text-muted transition-colors hover:border-line-strong hover:text-parchment"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={loading || busy || !body.trim()}
                onClick={generate}
                className="rounded-lg bg-brass px-4 py-2 text-[12.5px] font-semibold text-[#231a0c] transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? 'Generating…' : 'Generate PDF'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
