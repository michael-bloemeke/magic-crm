import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { draftContract, createContract, type ContractDraft, type ContractVersion } from '../api'
import { type Project } from '../pipeline'

// Generate / new-version dialog for the Performance Services Agreement. The contract opens
// auto-filled from the project as a formatted, fully editable document (rich text via the
// browser's built-in editing: bold/italic/underline/strikethrough/highlight, bullet +
// numbered lists, alignment). An "Insert field" menu drops project details at the cursor.
// The fixed chrome (letterhead, title + rule, signature block) frames the editable body.
// "Generate PDF" saves the version; the PDF (pdfmake) renders this HTML. Toggling Media
// re-assembles the draft (resets manual edits), so set it before editing.

type Props = {
  project: Project | null
  onCancel: () => void
  onCreated: (contract: ContractVersion) => void
}

export function ContractGenerateModal({ project, onCancel, onCreated }: Props) {
  const [includeMedia, setIncludeMedia] = useState(false)
  const [draft, setDraft] = useState<ContractDraft | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fieldsOpen, setFieldsOpen] = useState(false)
  const editorRef = useRef<HTMLDivElement>(null)

  // Fetch a fresh auto-filled draft when the dialog opens or the Media toggle flips.
  useEffect(() => {
    if (!project) return
    let live = true
    setLoading(true)
    setError(null)
    draftContract(project.id, includeMedia)
      .then((d) => live && setDraft(d))
      .catch((e) => live && setError(String(e instanceof Error ? e.message : e)))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [project, includeMedia])

  // Load the draft HTML into the editable body (uncontrolled so the cursor stays put).
  useEffect(() => {
    if (loading || !draft || !editorRef.current) return
    editorRef.current.innerHTML = draft.html
    try {
      document.execCommand('styleWithCSS', false, 'true') // emit CSS styles, better for the PDF
    } catch {
      // older browsers; ignore
    }
    editorRef.current.focus()
  }, [loading, draft])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const exec = (cmd: string, val?: string) => document.execCommand(cmd, false, val)
  const insertField = (value: string) => {
    exec('insertText', value)
    setFieldsOpen(false)
  }

  const generate = async () => {
    if (!project || !editorRef.current) return
    const html = editorRef.current.innerHTML.trim()
    if (!html) return
    setBusy(true)
    setError(null)
    try {
      onCreated(await createContract(project.id, html, includeMedia))
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
            .ct-title { text-align: center; font-family: Georgia, 'Times New Roman', serif; font-weight: 700;
              font-size: 16.5px; letter-spacing: 0.06em; color: #1f1c17; padding-bottom: 12px;
              margin: 0 0 14px; border-bottom: 1px solid #9a7536; }
            .ct-doc { font-family: Georgia, 'Times New Roman', serif; color: #1f1c17; }
            .ct-doc p { margin: 0 0 6px; font-size: 12px; line-height: 1.65; }
            .ct-doc ul, .ct-doc ol { margin: 0 0 6px; padding-left: 22px; }
            .ct-doc li { font-size: 12px; line-height: 1.65; margin-bottom: 2px; }
            .ct-doc:focus { outline: none; }
            .ct-sig { font-family: Georgia, 'Times New Roman', serif; color: #1f1c17; font-size: 12px;
              margin-top: 16px; padding-top: 13px; border-top: 1px solid #9a7536; }
            .ct-sig div { margin-bottom: 10px; }
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
                For <span className="text-parchment">{project.client}</span>. Auto-filled and fully editable. Format the
                text, insert project fields, then generate the PDF.
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
                <span className="text-[11px] text-faint">(photo/video permission)</span>
              </label>
            </div>

            {/* Formatting toolbar */}
            {!loading && (
              <div className="mx-6 mt-3 flex flex-wrap items-center gap-1 rounded-lg border border-line bg-surface-2/40 px-2 py-1.5">
                <TB onApply={() => exec('bold')} title="Bold"><span className="font-bold">B</span></TB>
                <TB onApply={() => exec('italic')} title="Italic"><span className="italic">I</span></TB>
                <TB onApply={() => exec('underline')} title="Underline"><span className="underline">U</span></TB>
                <TB onApply={() => exec('strikeThrough')} title="Strikethrough"><span className="line-through">S</span></TB>
                <TB onApply={() => exec('hiliteColor', '#fff19a')} title="Highlight">
                  <span className="rounded-sm px-1" style={{ backgroundColor: '#fff19a', color: '#1f1c17' }}>H</span>
                </TB>
                <Divider />
                <TB onApply={() => exec('insertUnorderedList')} title="Bulleted list">• List</TB>
                <TB onApply={() => exec('insertOrderedList')} title="Numbered list">1. List</TB>
                <Divider />
                <TB onApply={() => exec('justifyLeft')} title="Align left">Left</TB>
                <TB onApply={() => exec('justifyCenter')} title="Center">Center</TB>
                <TB onApply={() => exec('justifyRight')} title="Align right">Right</TB>
                <Divider />
                <div className="relative">
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault()
                      setFieldsOpen((o) => !o)
                    }}
                    className="rounded-md border border-brass-dim/60 px-2 py-1 text-[11.5px] font-medium text-brass-bright hover:border-brass"
                  >
                    Insert field ▾
                  </button>
                  {fieldsOpen && draft && (
                    <div className="absolute left-0 top-[calc(100%+4px)] z-10 max-h-64 w-60 overflow-y-auto rounded-lg border border-line-strong bg-surface-2 py-1 shadow-[0_20px_50px_-20px_rgba(0,0,0,0.9)]">
                      {draft.fields.map((f) => (
                        <button
                          key={f.label}
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault()
                            insertField(f.value)
                          }}
                          className="flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left hover:bg-surface-3"
                        >
                          <span className="text-[12px] text-parchment">{f.label}</span>
                          <span className="line-clamp-1 text-[10.5px] text-faint">{f.value}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {draft && draft.missingFields.length > 0 && (
              <p className="mx-6 mt-2 rounded-lg border border-[#e08a6b]/40 bg-[#e08a6b]/10 px-3 py-2 text-[11.5px] leading-relaxed text-[#e0a98b]">
                Missing from the project (shown as <span className="text-parchment">[bracketed]</span> placeholders):{' '}
                {draft.missingFields.join(', ')}.
              </p>
            )}

            {/* The editable document on a light "page" so it reads like the final contract. */}
            <div className="board-scroll min-h-0 flex-1 overflow-y-auto px-6 py-4" onMouseDown={() => fieldsOpen && setFieldsOpen(false)}>
              {loading ? (
                <p className="animate-pulse text-[12.5px] text-faint">Building draft…</p>
              ) : (
                <div className="mx-auto max-w-[760px] rounded-md bg-[#fbfaf6] px-16 py-16 shadow-[0_10px_40px_-12px_rgba(0,0,0,0.6)]">
                  {/* Letterhead (logo goes here once Michael has one). */}
                  <div className="ct-brand">{draft?.brand}</div>
                  <div className="ct-title">{draft?.title}</div>
                  <div ref={editorRef} className="ct-doc" contentEditable suppressContentEditableWarning />
                  <div className="ct-sig">
                    {(draft?.signatureLines ?? []).map((line, i) => (
                      <div key={i}>{line}</div>
                    ))}
                  </div>
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

// Toolbar button: act on mousedown (with preventDefault) so the editor keeps its selection.
function TB({ onApply, title, children }: { onApply: () => void; title: string; children: ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      onMouseDown={(e) => {
        e.preventDefault()
        onApply()
      }}
      className="min-w-[28px] rounded-md border border-transparent px-2 py-1 text-[11.5px] text-muted transition-colors hover:border-line hover:bg-surface-3 hover:text-parchment"
    >
      {children}
    </button>
  )
}
function Divider() {
  return <span className="mx-0.5 h-4 w-px bg-line" aria-hidden />
}
