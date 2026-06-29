import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

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

// Normalize a user-entered URL: keep http(s)/mailto/tel as-is, reject other schemes
// (javascript:, data:, …), and prepend https:// to a bare host so "example.com" opens the real
// site instead of navigating relative to the app origin. Returns null for empty/rejected input.
function normalizeUrl(raw: string): string | null {
  const s = (raw || '').trim()
  if (!s) return null
  if (/^(https?:|mailto:|tel:)/i.test(s)) return s
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return null
  return 'https://' + s
}

export function RichTextEditor({
  value,
  onChange,
  placeholder = 'Write your message…',
  smartFields,
  resolveField,
  allowImage = false,
  tone = 'dark',
  minHeight = 180,
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
  // When true, a toolbar "Insert image" button appears (used by the signature editor). The picked
  // file is inlined as a data: <img>; the send layer converts it to an inline cid: image.
  allowImage?: boolean
  // 'dark' = the app's dark modal chrome (default). 'light' = parchment chrome that sits inside the
  // light thread-reply dialog. Only the toolbar/border colors change; the typing surface is always
  // the white .email-rte (so the compose box previews the delivered email either way).
  tone?: 'dark' | 'light'
  // Minimum height of the editable area in px (replies are shorter than the full builder).
  minHeight?: number
}) {
  const light = tone === 'light'
  const ref = useRef<HTMLDivElement>(null)
  const imgInputRef = useRef<HTMLInputElement>(null)
  const [empty, setEmpty] = useState(true)
  const [fieldMenuOpen, setFieldMenuOpen] = useState(false)
  // Screen coords for the (portaled) Insert-field menu, so it can't be clipped by the editor's
  // or the modal's overflow.
  const [fieldMenuPos, setFieldMenuPos] = useState<{ top: number; left: number } | null>(null)
  const fieldBtnRef = useRef<HTMLButtonElement>(null)
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

  // The <a> ancestor of the current selection, if it's inside this editor; else null. Checks the
  // range's common ancestor and both endpoints so it works regardless of selection direction or a
  // selection that straddles a link boundary, not just the drag-start (anchor) node.
  const anchorAtSelection = (): HTMLAnchorElement | null => {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return null
    const root = ref.current
    if (!root) return null
    const range = sel.getRangeAt(0)
    const candidates = [range.commonAncestorContainer, sel.anchorNode, sel.focusNode, range.startContainer, range.endContainer]
    for (const start of candidates) {
      let node: Node | null = start
      if (!node || !root.contains(node)) continue
      while (node && node !== root) {
        if (node instanceof HTMLAnchorElement) return node
        node = node.parentNode
      }
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

  // True when the caret sits inside a list, so Enter should make a new list item (browser default)
  // rather than our plain line break.
  const selectionInList = (): boolean => {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return false
    const root = ref.current
    let node: Node | null = sel.anchorNode
    while (node && node !== root) {
      if (node instanceof HTMLElement && /^(LI|UL|OL)$/.test(node.tagName)) return true
      node = node.parentNode
    }
    return false
  }

  // Make Enter and Shift+Enter identical: both insert a single line break (<br>), the same as a
  // sentence that wraps. Browsers otherwise make plain Enter open a new paragraph/div with extra
  // spacing, so a hard return looked taller than a soft wrap. Lists keep the native Enter (new item).
  const onKeyDown = (e: React.KeyboardEvent) => {
    // nativeEvent.isComposing = mid-IME composition (e.g. accents); let those Enters commit normally.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      if (selectionInList()) return
      e.preventDefault()
      document.execCommand('insertLineBreak')
      emit()
    }
  }
  const addLink = () => {
    const u = normalizeUrl(window.prompt('Link URL (include https://)') || '')
    if (!u) return
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

  // Insert a picked image inlined as a data: URL (sized so it can't blow out the layout). Used for
  // a signature logo; the send layer rewrites data: images to inline cid: attachments.
  const insertImage = (file: File) => {
    if (!file || !file.type.startsWith('image/')) return
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result || '')
      if (!url.startsWith('data:image/')) return
      const raw = window.prompt('Image width in pixels (blank = fit to width, max 600):', '300')
      const widthStyle =
        raw && /^\d+$/.test(raw.trim()) ? `width:${Math.min(600, parseInt(raw.trim(), 10))}px;max-width:100%` : 'max-width:100%'
      ref.current?.focus()
      document.execCommand('insertHTML', false, `<img src="${url}" alt="" style="${widthStyle};height:auto;border:0" />`)
      emit()
    }
    reader.readAsDataURL(file)
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

  // Insert a "write-in" note placeholder: a visible reminder of what to write here. Never
  // autofills; flagged before sending; stripped from the actual email.
  const insertNote = () => {
    setFieldMenuOpen(false)
    const text = window.prompt('What goes here? A short note to yourself (it stays highlighted until you fill it in).')
    if (!text || !text.trim()) return
    ref.current?.focus()
    document.execCommand(
      'insertHTML',
      false,
      `<span class="merge-field" data-note="true" contenteditable="false">[${escapeHtml(text.trim())}]</span>&nbsp;`,
    )
    emit()
  }

  const openLink = () => {
    const a = activeAnchor.current
    if (!a) return
    const href = a.getAttribute('href')
    if (href) window.open(href, '_blank', 'noopener,noreferrer')
  }
  const editLink = () => {
    const a = activeAnchor.current
    if (!a) return
    const u = normalizeUrl(window.prompt('Link URL (include https://)', a.getAttribute('href') || '') || '')
    if (!u) return
    a.setAttribute('href', u)
    setLinkBar({ href: u })
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

  // Toolbar/border colors swap with the tone; the editable surface stays the white .email-rte.
  const wrapCls = light
    ? 'overflow-hidden rounded-lg border border-[#dcd7cc] bg-white focus-within:border-[#cb9b5d]'
    : 'overflow-hidden rounded-lg border border-line bg-surface-2 focus-within:border-brass-dim'
  const barCls = light
    ? 'flex flex-wrap items-center gap-0.5 border-b border-[#ece8e0] bg-[#f4f2ed] px-1.5 py-1'
    : 'flex flex-wrap items-center gap-0.5 border-b border-line bg-surface-3/40 px-1.5 py-1'
  const btnCls = light
    ? 'rounded-md p-1.5 text-[#6f6a60] transition-colors hover:bg-[#efece4] hover:text-[#201c17]'
    : 'rounded-md p-1.5 text-muted transition-colors hover:bg-surface-3 hover:text-parchment'

  return (
    <div className={wrapCls}>
      <div className={barCls}>
        {COMMANDS.map((c) => (
          <button
            key={c.key}
            type="button"
            title={c.label}
            aria-label={c.label}
            // Keep the editor selection while clicking a toolbar button.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => run(c.cmd)}
            className={btnCls}
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
          className={btnCls}
        >
          {ICON(<><path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" /><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" /></>)}
        </button>

        {allowImage && (
          <>
            <input
              ref={imgInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) insertImage(f)
                e.currentTarget.value = ''
              }}
            />
            <button
              type="button"
              title="Insert image"
              aria-label="Insert image"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => imgInputRef.current?.click()}
              className={btnCls}
            >
              {ICON(<><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="M21 15l-5-5L5 21" /></>)}
            </button>
          </>
        )}

        {smartFields && smartFields.length > 0 && (
          <div className="ml-auto">
            <button
              ref={fieldBtnRef}
              type="button"
              title="Insert a smart field that fills from the project"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                if (fieldMenuOpen) {
                  setFieldMenuOpen(false)
                  return
                }
                const r = fieldBtnRef.current?.getBoundingClientRect()
                if (r) setFieldMenuPos({ top: r.bottom + 4, left: Math.min(Math.max(8, r.right - 224), window.innerWidth - 232) })
                setFieldMenuOpen(true)
              }}
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
            {fieldMenuOpen &&
              fieldMenuPos &&
              createPortal(
                <>
                  <div className="fixed inset-0 z-[80]" onClick={() => setFieldMenuOpen(false)} aria-hidden />
                  <div
                    className="fixed z-[81] max-h-64 w-56 overflow-y-auto rounded-lg border border-line-strong bg-surface-2 py-1 shadow-[0_20px_50px_-20px_rgba(0,0,0,0.9)]"
                    style={{ top: fieldMenuPos.top, left: fieldMenuPos.left }}
                  >
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
                    <div className="my-1 border-t border-line" />
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={insertNote}
                      className="block w-full px-3 py-1.5 text-left text-[12px] italic text-[#7aa2e3] hover:bg-surface-3"
                    >
                      Write-in note…
                    </button>
                  </div>
                </>,
                document.body,
              )}
          </div>
        )}
      </div>

      {/* Link bar: shows when the caret is inside a link. */}
      {linkBar && (
        <div className={[
          'flex items-center gap-2 border-b px-2.5 py-1.5 text-[11.5px]',
          light ? 'border-[#ece8e0] bg-[#f4f2ed]' : 'border-line bg-surface-3/60',
        ].join(' ')}>
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0 text-faint" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" /><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" />
          </svg>
          <span className={['min-w-0 flex-1 truncate', light ? 'text-[#6f6a60]' : 'text-muted'].join(' ')} title={linkBar.href}>
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
          <span className="pointer-events-none absolute left-3 top-3 text-[14px] text-[#9aa0a6]">{placeholder}</span>
        )}
        <div
          ref={ref}
          contentEditable
          suppressContentEditableWarning
          onInput={emit}
          onKeyDown={onKeyDown}
          onMouseUp={refreshLink}
          onKeyUp={refreshLink}
          role="textbox"
          aria-multiline="true"
          className="email-rte w-full px-3 py-3 outline-none"
          style={{ minHeight }}
        />
      </div>
    </div>
  )
}
