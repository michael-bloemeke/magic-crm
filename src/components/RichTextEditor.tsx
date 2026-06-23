import { useEffect, useRef, useState } from 'react'

// A lightweight rich-text editor: a contentEditable surface plus a small Gmail-style toolbar
// (bold, italic, underline, bullet/numbered lists, link). Emits HTML via onChange. No editor
// dependency; uses document.execCommand, which every browser still supports for these basics.
//
// Semi-controlled: we only write `value` back into the DOM when it differs from what's already
// there (e.g. a template was inserted), so typing never resets the caret.

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

export function RichTextEditor({
  value,
  onChange,
  placeholder = 'Write your message…',
}: {
  value: string
  onChange: (html: string) => void
  placeholder?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [empty, setEmpty] = useState(true)

  // Push external changes (template insert, draft load) into the DOM without clobbering the
  // caret while the user types (during typing, value already equals innerHTML).
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (value !== el.innerHTML) el.innerHTML = value || ''
    setEmpty(!el.textContent?.trim())
  }, [value])

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
    ref.current?.focus()
    document.execCommand('createLink', false, url.trim())
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
      </div>
      <div className="relative">
        {empty && (
          <span className="pointer-events-none absolute left-3 top-3 text-[13px] text-faint">{placeholder}</span>
        )}
        <div
          ref={ref}
          contentEditable
          suppressContentEditableWarning
          onInput={emit}
          role="textbox"
          aria-multiline="true"
          className="email-rte min-h-[180px] w-full px-3 py-3 text-[13px] leading-relaxed text-parchment outline-none"
        />
      </div>
    </div>
  )
}
