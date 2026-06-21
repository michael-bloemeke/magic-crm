import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { draftContract, createContract, type ContractVersion } from '../api'
import { type Project } from '../pipeline'

// Generate / new-version dialog for the Performance Services Agreement. Opens the contract
// auto-filled from the project as a formatted, editable "document page" (looks like the
// final PDF: serif, centered title, bold section headings). Edit inline for the client,
// toggle the optional Media clause, then "Generate PDF" saves the version. The PDF is
// produced from this text and signed/sent outside the app. Toggling Media re-assembles
// the draft (resets manual edits), so set it before editing.

type Props = {
  project: Project | null
  onCancel: () => void
  onCreated: (contract: ContractVersion) => void
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Contract text -> formatted HTML blocks for the editable document page. The PDF renderer
// re-derives this formatting from the text on generate, so what you see here matches the
// output even after edits.
function renderHtml(text: string) {
  const lines = text.split('\n')
  return lines
    .map((raw, i) => {
      const line = raw.replace(/\s+$/, '')
      if (i === 0) return `<p class="ct-title">${escapeHtml(line)}</p>`
      if (line === '') return '<p class="ct-gap"><br></p>'
      if (/^Client signature:/.test(line)) return `<p class="ct-sig">${escapeHtml(line)}</p>`
      if (/^\d+\.\s/.test(line)) return `<p class="ct-head">${escapeHtml(line)}</p>`
      if (/^[•-]\s/.test(line)) return `<p class="ct-bullet">${escapeHtml(line)}</p>`
      return `<p class="ct-body">${escapeHtml(line)}</p>`
    })
    .join('')
}

export function ContractGenerateModal({ project, onCancel, onCreated }: Props) {
  const [includeMedia, setIncludeMedia] = useState(false)
  const [draftText, setDraftText] = useState('')
  const [missing, setMissing] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const editorRef = useRef<HTMLDivElement>(null)

  // Fetch a fresh auto-filled draft when the dialog opens or the Media toggle flips.
  useEffect(() => {
    if (!project) return
    let live = true
    setLoading(true)
    setError(null)
    draftContract(project.id, includeMedia)
      .then(({ body, missingFields }) => {
        if (!live) return
        setDraftText(body)
        setMissing(missingFields)
      })
      .catch((e) => live && setError(String(e instanceof Error ? e.message : e)))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [project, includeMedia])

  // Render the draft into the contentEditable page once it's loaded (uncontrolled, so the
  // cursor doesn't jump while typing). Re-runs when a new draft arrives.
  useEffect(() => {
    if (!loading && editorRef.current) editorRef.current.innerHTML = renderHtml(draftText)
  }, [loading, draftText])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const generate = async () => {
    if (!project || !editorRef.current) return
    const body = (editorRef.current.innerText || '').replace(/\n{3,}/g, '\n\n').trim()
    if (!body) return
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
          <style>{`
            .ct-brand { text-align: center; font-family: Georgia, 'Times New Roman', serif; font-weight: 700;
              font-size: 13.5px; letter-spacing: 0.08em; color: #9a7536; margin: 0 0 6px; }
            .ct-doc { font-family: Georgia, 'Times New Roman', serif; color: #1f1c17; }
            .ct-doc p { margin: 0 0 4px; }
            .ct-doc .ct-title { text-align: center; font-weight: 700; font-size: 16.5px; letter-spacing: 0.06em;
              margin: 2px 0 0; padding-bottom: 12px; border-bottom: 1px solid #9a7536; }
            .ct-doc .ct-head { font-weight: 700; font-size: 13px; margin: 15px 0 5px; }
            .ct-doc .ct-body { font-size: 12px; line-height: 1.65; }
            .ct-doc .ct-bullet { font-size: 12px; line-height: 1.65; padding-left: 18px; text-indent: -14px; }
            .ct-doc .ct-sig { font-size: 12px; margin-top: 16px; padding-top: 13px; border-top: 1px solid #9a7536; }
            .ct-doc .ct-gap { min-height: 9px; }
            .ct-doc:focus { outline: none; }
          `}</style>

          <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={onCancel} aria-hidden />

          <motion.div
            className="relative flex max-h-[94vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-line-strong bg-surface shadow-[0_30px_70px_-30px_rgba(0,0,0,0.9)]"
            initial={{ y: 16, opacity: 0.6, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 16, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="border-b border-line px-6 pb-4 pt-5">
              <h2 className="font-display text-[20px] leading-tight text-parchment">Generate contract</h2>
              <p className="mt-1 text-[12.5px] text-muted">
                For <span className="text-parchment">{project.client}</span>. Auto-filled from the project. Edit the
                document below for this client, then generate the PDF to sign and send.
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 px-6 pt-3">
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
              <p className="mx-6 mt-3 rounded-lg border border-[#e08a6b]/40 bg-[#e08a6b]/10 px-3 py-2 text-[11.5px] leading-relaxed text-[#e0a98b]">
                Missing from the project, shown as <span className="text-parchment">[bracketed]</span> placeholders to fill
                in: {missing.join(', ')}.
              </p>
            )}

            {/* The editable document, on a light "page" so it reads like the final contract. */}
            <div className="board-scroll min-h-0 flex-1 overflow-y-auto px-6 py-4">
              {loading ? (
                <p className="animate-pulse text-[12.5px] text-faint">Building draft…</p>
              ) : (
                <div className="mx-auto max-w-[760px] rounded-md bg-[#fbfaf6] px-16 py-16 shadow-[0_10px_40px_-12px_rgba(0,0,0,0.6)]">
                  {/* Letterhead (logo goes here once Michael has one). */}
                  <div className="ct-brand">The Award-Winning Magic of Michael Bloemeke</div>
                  <div ref={editorRef} className="ct-doc" contentEditable suppressContentEditableWarning />
                </div>
              )}
            </div>

            {error && <p className="px-6 text-[11.5px] leading-relaxed text-[#e08a6b]">{error}</p>}

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
                disabled={loading || busy}
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
