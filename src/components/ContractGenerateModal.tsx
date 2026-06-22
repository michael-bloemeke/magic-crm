import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { draftContract, createContract, type ContractDraft, type ContractVersion } from '../api'
import { type Project } from '../pipeline'
import { ContractDocStyles, TB, Divider, Dropdown, MenuItem } from './contractEditorShared'

// Generate / new-version dialog for the Performance Services Agreement. The contract opens
// auto-filled and fully editable (rich text via the browser's built-in editing: headings,
// bold/italic/underline/strikethrough, multi-color highlight, bullet + numbered lists,
// alignment). An "Insert field" menu drops project details at the cursor. The Media clause
// toggles in/out IN PLACE (no rebuild), so manual edits and scroll position are preserved.
// "Generate PDF" saves the version; the PDF (pdfmake) renders this HTML. Section headings
// carry data-section so they auto-renumber when Media is added/removed.

type Props = {
  project: Project | null
  onCancel: () => void
  onCreated: (contract: ContractVersion) => void
}

const HIGHLIGHTS = [
  { label: 'Yellow', color: '#fff19a' },
  { label: 'Green', color: '#b7f0c2' },
  { label: 'Blue', color: '#bcdcff' },
  { label: 'Pink', color: '#ffc6e0' },
  { label: 'Orange', color: '#ffd9a8' },
]
const STYLES = [
  { label: 'Normal text', tag: '<p>' },
  { label: 'Heading 1', tag: '<h1>' },
  { label: 'Heading 2', tag: '<h2>' },
  { label: 'Heading 3', tag: '<h3>' },
]

type Menu = null | 'style' | 'highlight' | 'fields'

export function ContractGenerateModal({ project, onCancel, onCreated }: Props) {
  const [includeMedia, setIncludeMedia] = useState(false)
  const [draft, setDraft] = useState<ContractDraft | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState<Menu>(null)
  const editorRef = useRef<HTMLDivElement>(null)

  // Load the auto-filled draft ONCE when the dialog opens (not on Media toggle).
  useEffect(() => {
    if (!project) return
    let live = true
    setLoading(true)
    setError(null)
    setIncludeMedia(false)
    draftContract(project.id)
      .then((d) => live && setDraft(d))
      .catch((e) => live && setError(String(e instanceof Error ? e.message : e)))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [project])

  // Render the draft into the editable body (uncontrolled so the cursor stays put).
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

  // Renumber the section headings (1., 2., ...) in DOM order, preserving any title edits.
  const renumber = () => {
    const ed = editorRef.current
    if (!ed) return
    ed.querySelectorAll('[data-section]').forEach((el, i) => {
      el.textContent = `${i + 1}. ` + (el.textContent || '').replace(/^\s*\d+\.\s*/, '')
    })
  }
  // Add / remove the Media clause in place, then fix the numbering. Edits + scroll untouched.
  const setMedia = (on: boolean) => {
    const ed = editorRef.current
    if (!ed || !draft) return
    const existing = ed.querySelector('[data-clause="media"]')
    if (on && !existing) {
      const tmp = document.createElement('div')
      tmp.innerHTML = draft.mediaHtml
      const node = tmp.firstElementChild
      if (node) {
        const anchor = ed.querySelector('[data-key="independentContractor"]')
        if (anchor) ed.insertBefore(node, anchor)
        else ed.appendChild(node)
      }
    } else if (!on && existing) {
      existing.remove()
    }
    renumber()
  }

  const insertField = (value: string) => {
    exec('insertText', value)
    setMenu(null)
  }

  // As the user fills an unfilled field (replaces its [Label] placeholder), drop the warning.
  const onEditorInput = () => {
    const ed = editorRef.current
    if (!ed) return
    ed.querySelectorAll('.cf-missing').forEach((el) => {
      if (!/\[.+\]/.test(el.textContent || '')) el.classList.remove('cf-missing')
    })
  }

  const generate = async () => {
    const ed = editorRef.current
    if (!project || !ed) return
    renumber()
    const stillMissing = Array.from(ed.querySelectorAll('.cf-missing')).filter((el) => /\[.+\]/.test(el.textContent || ''))
    if (stillMissing.length) {
      setError(
        'Fill in the highlighted fields first: ' +
          stillMissing.map((el) => (el.textContent || '').replace(/[[\]]/g, '')).join(', '),
      )
      return
    }
    const html = ed.innerHTML.trim()
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
          <ContractDocStyles />

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
                  onChange={(e) => {
                    setIncludeMedia(e.target.checked)
                    setMedia(e.target.checked)
                  }}
                  className="h-3.5 w-3.5 accent-[var(--color-brass)]"
                />
                <span className="text-[12.5px] text-parchment">Include Media clause</span>
                <span className="text-[11px] text-faint">(photo/video permission)</span>
              </label>
            </div>

            {/* Formatting toolbar */}
            {!loading && draft && (
              <div className="mx-6 mt-3 flex flex-wrap items-center gap-1 rounded-lg border border-line bg-surface-2/40 px-2 py-1.5">
                {/* Paragraph style */}
                <Dropdown open={menu === 'style'} onToggle={() => setMenu(menu === 'style' ? null : 'style')} label="Style ▾">
                  {STYLES.map((s) => (
                    <MenuItem key={s.tag} onPick={() => { exec('formatBlock', s.tag); setMenu(null) }}>
                      {s.label}
                    </MenuItem>
                  ))}
                </Dropdown>
                <Divider />
                <TB onApply={() => exec('bold')} title="Bold"><span className="font-bold">B</span></TB>
                <TB onApply={() => exec('italic')} title="Italic"><span className="italic">I</span></TB>
                <TB onApply={() => exec('underline')} title="Underline"><span className="underline">U</span></TB>
                <TB onApply={() => exec('strikeThrough')} title="Strikethrough"><span className="line-through">S</span></TB>
                {/* Highlight colors */}
                <Dropdown
                  open={menu === 'highlight'}
                  onToggle={() => setMenu(menu === 'highlight' ? null : 'highlight')}
                  label={<span className="rounded-sm px-1" style={{ backgroundColor: '#fff19a', color: '#1f1c17' }}>H ▾</span>}
                >
                  {HIGHLIGHTS.map((h) => (
                    <MenuItem key={h.color} onPick={() => { exec('hiliteColor', h.color); setMenu(null) }}>
                      <span className="inline-block h-3 w-3 rounded-sm" style={{ backgroundColor: h.color }} />
                      {h.label}
                    </MenuItem>
                  ))}
                  <MenuItem onPick={() => { exec('hiliteColor', 'transparent'); setMenu(null) }}>
                    <span className="inline-block h-3 w-3 rounded-sm border border-line" />
                    Remove
                  </MenuItem>
                </Dropdown>
                <Divider />
                <TB onApply={() => exec('insertUnorderedList')} title="Bulleted list">• List</TB>
                <TB onApply={() => exec('insertOrderedList')} title="Numbered list">1. List</TB>
                <Divider />
                <TB onApply={() => exec('justifyLeft')} title="Align left">Left</TB>
                <TB onApply={() => exec('justifyCenter')} title="Center">Center</TB>
                <TB onApply={() => exec('justifyRight')} title="Align right">Right</TB>
                <Divider />
                {/* Insert project field */}
                <Dropdown
                  open={menu === 'fields'}
                  onToggle={() => setMenu(menu === 'fields' ? null : 'fields')}
                  label="Insert field ▾"
                  accent
                  wide
                >
                  {draft.fields.map((f) => (
                    <MenuItem key={f.label} onPick={() => insertField(f.value)}>
                      <span className="flex flex-col items-start gap-0.5">
                        <span className="text-[12px] text-parchment">{f.label}</span>
                        <span className="line-clamp-1 text-[10.5px] text-faint">{f.value}</span>
                      </span>
                    </MenuItem>
                  ))}
                </Dropdown>
              </div>
            )}

            {draft && draft.missingFields.length > 0 && (
              <p className="mx-6 mt-2 rounded-lg border border-[#e08a6b]/40 bg-[#e08a6b]/10 px-3 py-2 text-[11.5px] leading-relaxed text-[#e0a98b]">
                Missing from the project (shown as <span className="text-parchment">[bracketed]</span> placeholders):{' '}
                {draft.missingFields.join(', ')}.
              </p>
            )}

            {/* The editable document on a light "page" so it reads like the final contract. */}
            <div className="board-scroll min-h-0 flex-1 overflow-y-auto px-6 py-4" onMouseDown={() => menu && setMenu(null)}>
              {loading ? (
                <p className="animate-pulse text-[12.5px] text-faint">Building draft…</p>
              ) : (
                <div className="ct-page mx-auto max-w-[760px] rounded-md bg-[#fbfaf6] px-16 py-16 shadow-[0_10px_40px_-12px_rgba(0,0,0,0.6)]">
                  {/* Letterhead (logo goes here once Michael has one). */}
                  <div className="ct-brand">{draft?.brand}</div>
                  <div className="ct-title">{draft?.title}</div>
                  <div ref={editorRef} className="ct-doc" contentEditable suppressContentEditableWarning onInput={onEditorInput} />
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
