import { useEffect, useRef, useState } from 'react'
import { loadContractTemplate, saveContractTemplate, type ContractTemplateData } from '../api'
import { ContractDocStyles, TB, Divider, Dropdown, MenuItem } from './contractEditorShared'

// Settings page. For now the one setting is the DEFAULT CONTRACT: edit the template that
// "Generate contract" starts from every time. Field placeholders (highlighted) are inserted
// via the Insert-field menu and get auto-filled from each project at generate time. Saved to
// crm-config.json -> contractTemplate (empty = built-in default).

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

export function SettingsPage() {
  const [data, setData] = useState<ContractTemplateData | null>(null)
  const [menu, setMenu] = useState<Menu>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const editorRef = useRef<HTMLDivElement>(null)

  const load = () => {
    loadContractTemplate()
      .then(setData)
      .catch(() => setData(null))
  }
  useEffect(load, [])

  // Render the template into the editor once it loads, and number the section headings
  // for display (numbering is re-derived at generate time, so it's cosmetic here).
  useEffect(() => {
    if (!data || !editorRef.current) return
    editorRef.current.innerHTML = data.template
    editorRef.current.querySelectorAll('[data-section]').forEach((el, i) => {
      el.textContent = `${i + 1}. ` + (el.textContent || '').replace(/^\s*\d+\.\s*/, '')
    })
    try {
      document.execCommand('styleWithCSS', false, 'true')
    } catch {
      // ignore
    }
  }, [data])

  const exec = (cmd: string, val?: string) => document.execCommand(cmd, false, val)
  const insertChip = (key: string, label: string) => {
    exec('insertHTML', `<span class="cf" data-f="${key}">${label}</span>&nbsp;`)
    setMenu(null)
  }

  const save = async () => {
    if (!editorRef.current) return
    setBusy(true)
    setNote(null)
    try {
      await saveContractTemplate(editorRef.current.innerHTML)
      setNote('Saved. New contracts will use this template.')
      load()
    } catch (e) {
      setNote(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(false)
    }
  }
  const reset = async () => {
    if (!window.confirm('Reset the default contract to the built-in version? Your edits here will be discarded.')) return
    setBusy(true)
    setNote(null)
    try {
      await saveContractTemplate('')
      setNote('Reset to the built-in default contract.')
      load()
    } catch (e) {
      setNote(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <ContractDocStyles />

      <section className="rounded-2xl border border-line bg-surface-2/30 p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-[18px] text-parchment">Default contract</h2>
            <p className="mt-1 max-w-xl text-[12.5px] leading-relaxed text-muted">
              This is the contract that "Generate contract" starts from every time. Edit the wording here, and insert
              project fields (highlighted) wherever details should auto-fill. Section numbers are added automatically when
              you generate.
            </p>
          </div>
          <span className="shrink-0 rounded-full border border-line px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">
            {data?.isCustom ? 'Custom' : 'Built-in default'}
          </span>
        </div>

        {!data ? (
          <p className="mt-4 animate-pulse text-[12.5px] text-faint">Loading…</p>
        ) : (
          <>
            {/* Toolbar */}
            <div className="mt-4 flex flex-wrap items-center gap-1 rounded-lg border border-line bg-surface-2/40 px-2 py-1.5">
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
              <Dropdown open={menu === 'fields'} onToggle={() => setMenu(menu === 'fields' ? null : 'fields')} label="Insert field ▾" accent>
                {data.fields.map((f) => (
                  <MenuItem key={f.key} onPick={() => insertChip(f.key, f.label)}>
                    {f.label}
                  </MenuItem>
                ))}
              </Dropdown>
            </div>

            {/* The editable template, on a light page so it reads like the contract. */}
            <div className="mt-3 max-h-[60vh] overflow-y-auto rounded-xl border border-line" onMouseDown={() => menu && setMenu(null)}>
              <div className="ct-page mx-auto max-w-[720px] bg-[#fbfaf6] px-14 py-12">
                <div className="ct-brand">{data.brand}</div>
                <div className="ct-title">{data.title}</div>
                <div ref={editorRef} className="ct-doc" contentEditable suppressContentEditableWarning />
                <div className="ct-sig">
                  {data.signatureLines.map((line, i) => (
                    <div key={i}>{line}</div>
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-4 flex items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={save}
                className="rounded-lg bg-brass px-4 py-2 text-[12.5px] font-semibold text-[#231a0c] transition-all hover:brightness-110 disabled:opacity-40"
              >
                {busy ? 'Saving…' : 'Save default'}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={reset}
                className="rounded-lg border border-line px-4 py-2 text-[12.5px] font-medium text-muted transition-colors hover:border-line-strong hover:text-parchment disabled:opacity-40"
              >
                Reset to built-in
              </button>
              {note && <span className="text-[11.5px] text-muted">{note}</span>}
            </div>
          </>
        )}
      </section>
    </div>
  )
}
