import { useEffect, useRef, useState } from 'react'

// A lightweight rich-text editor: a contentEditable surface plus a small Gmail-style toolbar
// (bold, italic, underline, bullet/numbered lists, link). Emits HTML via onChange. No editor
// dependency; uses document.execCommand, which every browser still supports for these basics.
//
// Semi-controlled: we only write `value` back into the DOM when it differs from what's already
// there (e.g. a template was inserted), so typing never resets the caret.
//
// Links: in a contentEditable you can't click a link to follow it and there's no native way to
// remove one. So when the caret is inside a link, a small bar appears with Open / Edit / Remove.

type Cmd = { key: string; label: string; cmd: string; icon: React.ReactNode }

const ICON = (path: React.ReactNode) => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    {path}
  </svg>
)

const COMMANDS: Cmd[] = [
  { key: 'bold', label: 'Bold', cmd: 'bold', icon: ICON(<path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z" />) },
  { key: 'italic', label: 'Italic', cmd: 'italic', icon: ICON(<><line x1="19" y1="5" x2="11" y2="5" /><line x1="13" y1="19" x2="5" y2="19" /><line x1="15" y1="5" x2="9" y2="19" /></>) },
  { key: 'underline', label: 'Underline', cmd: 'underline', icon: ICON(<><path d="M7 4v6a5 5 0 0 0 10 0V4" /><line x1="5" y1="20" x2="19" y2="20" /></>) },
  { key: 'ul', label: 'Bulleted list', cmd: 'insertUnorderedList', icon: ICON(<><line x1="9" y1="6" x2="20" y2="6" /><line x1="9" y1="12" x2="20" y2="12" /><line x1="9" y1="18" x2="20" y2="18" /><circle cx="4.5" cy="6" r="1.2" fill="currentColor" stroke="none" /><circle cx="4.5" cy="12" r="1.2" fill="currentColor" stroke="none" /><circle cx="4.5" cy="18" r="1.2" fill="currentColor" stroke="none" /></>) },
  { key: 'ol', label: 'Numbered list', cmd: 'insertOrderedList', icon: ICON(<><line x1="10" y1="6" x2="20" y2="6" /><line x1="10" y1="12" x2="20" y2="12" /><line x1="10" y1="18" x2="20" y2="18" /><path d="M4 5h1.5v3M4 8h2.5" /><path d="M4 14.5c0-.6.5-1 1.2-1s1.3.4 1.3 1c0 1-2.5 1.6-2.5 3h2.5" /></>) },
]

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)
}

export function RichTextEditor({
  value,
  onChange,
  placeholder = 'Write your message…',
  smartFields,
  resolveField,
}: {
  value: string
  onChange: (html: string) => void
  placeholder?: string
  // When provided, a toolbar "Insert field" dropdown appears with these options.
  smartFields?: { key: string; label: string }[]
  // Given a field key, returns the project's value for it (or '' if unset). When it returns a
  // value, the field is inserted as plain text; otherwise a visible placeholder chip is dropped
  // in. Omit entirely (e.g. the template builder) to always insert placeholders.
  resolveField?: (key: string) => string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [empty, setEmpty] = useState(true)
  const [fieldMenuOpen, setFieldMenuOpen] = useState(false)
  // The link the caret currently sits in (drives the Open / Edit / Remove bar).
  const [linkBar, setLinkBar] = useState<{ href: string } | null>(null)
  const activeAnchor = useRef<HTMLAnchorElement | null>(null)

  // Push external changes (template insert, draft load) into the DOM without clobbering the
  // caret while the user types (during typing, value already equals innerHTML).
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (value !== el.innerHTML) el.innerHTML = value || ''
    setEmpty(!el.textContent?.trim())
  }, [value])

  // The <a> ancestor of the current selection, if it's inside this editor; else null.
  const anchorAtSelection = (): HTMLAnchorElement | null => {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return null
    let node: Node | null = sel.anchorNode
    const root = ref.current
    if (!node || !root || !root.contains(node)) return null
    while (node && node !== root) {
      if (node instanceof HTMLAnchorElement) return node
      node = node.parentNode
    }
    return null
  }
  const refreshLink = () => {
    const a = anchorAtSelection()
    activeAnchor.current = a
    setLinkBar(a ? { href: a.getAttribute('href') || '' } : null)
  }
  // The selection moving into/out of a link updates the bar.
  useEffect(() => {
    document.addEventListener('selectionchange', refreshLink)
    return () => document.removeEventListener('selectionchange', refreshLink)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const emit = () => {
    const el = ref.current
    if (!el) return
    setEmpty(!el.textContent?.trim())
    onChange(el.innerHTML)
  }

  const run = (cmd: string) => {
    ref.current?.focus()
    document.execCommand(cmd, false)
    emit()
  }
  const addLink = () => {
    const url = window.prompt('Link URL (include https://)')
    if (!url) return
    const u = url.trim()
    ref.current?.focus()
    const sel = window.getSelection()
    if (sel && sel.isCollapsed) {
      // Nothing selected: drop in the URL itself as the linked text.
      document.execCommand('insertHTML', false, `<a href="${escapeHtml(u)}">${escapeHtml(u)}</a>&nbsp;`)
    } else {
      document.execCommand('createLink', false, u)
    }
    emit()
    refreshLink()
  }

  // Insert a smart field: the resolved value (plain text) if the project has it, else a visible
  // placeholder chip that stays until it's filled.
  const insertField = (key: string, label: string) => {
    setFieldMenuOpen(false)
    ref.current?.focus()
    const val = resolveField ? resolveField(key) : ''
    if (val && val.trim()) {
      document.execCommand('insertText', false, val)
    } else {
      document.execCommand(
        'insertHTML',
        false,
        `<span class="merge-field" data-field="${escapeHtml(key)}" contenteditable="false">[${escapeHtml(label)}]</span>&nbsp;`,
      )
    }
    emit()
  }

  const openLink = () => {
    const a = activeAnchor.current
    const href = a?.getAttribute('href') || linkBar?.href
    if (href) window.open(href, '_blank', 'noopener,noreferrer')
  }
  const editLink = () => {
    const a = activeAnchor.current
    if (!a) return
    const next = window.prompt('Link URL (include https://)', a.getAttribute('href') || '')
    if (next == null) return
    a.setAttribute('href', next.trim())
    setLinkBar({ href: next.trim() })
    emit()
  }
  const removeLink = () => {
    const a = activeAnchor.current
    if (!a || !a.parentNode) return
    // Unwrap: move the link's contents out, then drop the <a>. Preserves inner formatting.
    while (a.firstChild) a.parentNode.insertBefore(a.firstChild, a)
    a.parentNode.removeChild(a)
    activeAnchor.current = null
    setLinkBar(null)
    emit()
  }

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface-2 focus-within:border-brass-dim">
      <div className="flex flex-wrap items-center gap-0.5 border-b border-line bg-surface-3/40 px-1.5 py-1">
        {COMMANDS.map((c) => (
          <button
            key={c.key}
            type="button"
            title={c.label}
            aria-label={c.label}
            // Keep the editor selection while clicking a toolbar button.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => run(c.cmd)}
            className="rounded-md p-1.5 text-muted transition-colors hover:bg-surface-3 hover:text-parchment"
          >
            {c.icon}
          </button>
        ))}
        <button
          type="button"
          title="Add link"
          aria-label="Add link"
          onMouseDown={(e) => e.preventDefault()}
          onClick={addLink}
          className="rounded-md p-1.5 text-muted transition-colors hover:bg-surface-3 hover:text-parchment"
        >
          {ICON(<><path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" /><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" /></>)}
        </button>

        {smartFields && smartFields.length > 0 && (
          <div className="relative ml-auto">
            <button
              type="button"
              title="Insert a smart field that fills from the project"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setFieldMenuOpen((o) => !o)}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-[11.5px] font-semibold text-brass-bright transition-colors hover:bg-surface-3"
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 7V5h16v2M9 5v14M7 19h4" /><path d="M14 13h6M14 17h6M14 13l-1 4" />
              </svg>
              Insert field
              <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
            {fieldMenuOpen && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setFieldMenuOpen(false)} aria-hidden />
                <div className="absolute right-0 top-[calc(100%+4px)] z-30 max-h-64 w-56 overflow-y-auto rounded-lg border border-line-strong bg-surface-2 py-1 shadow-[0_20px_50px_-20px_rgba(0,0,0,0.9)]">
                  {smartFields.map((f) => (
                    <button
                      key={f.key}
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => insertField(f.key, f.label)}
                      className="block w-full px-3 py-1.5 text-left text-[12px] text-parchment hover:bg-surface-3"
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Link bar: shows when the caret is inside a link. */}
      {linkBar && (
        <div className="flex items-center gap-2 border-b border-line bg-surface-3/60 px-2.5 py-1.5 text-[11.5px]">
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0 text-faint" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" /><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" />
          </svg>
          <span className="min-w-0 flex-1 truncate text-muted" title={linkBar.href}>
            {linkBar.href || '(no URL)'}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={openLink} className="rounded-md px-2 py-1 font-semibold text-brass-bright transition-colors hover:bg-surface-3">
              Open
            </button>
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={editLink} className="rounded-md px-2 py-1 font-medium text-muted transition-colors hover:bg-surface-3 hover:text-parchment">
              Edit
            </button>
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={removeLink} className="rounded-md px-2 py-1 font-medium text-[#e08a6b] transition-colors hover:bg-surface-3">
              Remove
            </button>
          </div>
        </div>
      )}

      <div className="relative">
        {empty && (
          <span className="pointer-events-none absolute left-3 top-3 text-[13px] text-faint">{placeholder}</span>
        )}
        <div
          ref={ref}
          contentEditable
          suppressContentEditableWarning
          onInput={emit}
          onMouseUp={refreshLink}
          onKeyUp={refreshLink}
          role="textbox"
          aria-multiline="true"
          className="email-rte min-h-[180px] w-full px-3 py-3 text-[13px] leading-relaxed text-parchment outline-none"
        />
      </div>
    </div>
  )
}
