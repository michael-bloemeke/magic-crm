import { useEffect, useRef, useState } from 'react'

type Props = {
  label?: string
  value: string
  onSave: (value: string) => void
  multiline?: boolean
  type?: 'text' | 'date'
  prefix?: string
  placeholder?: string
  // Optional normalizer applied when the field commits (e.g. phone formatting).
  format?: (value: string) => string
}

// An always-editable field: looks like text, becomes clearly editable on
// hover/focus, and saves on blur (or Enter, for single-line). No edit button.
export function EditableField({ label, value, onSave, multiline, type = 'text', prefix, placeholder = 'Add…', format }: Props) {
  const [val, setVal] = useState(value)
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => setVal(value), [value])

  const grow = () => {
    const el = taRef.current
    if (!el) return
    // Resetting the height to 'auto' to remeasure the content momentarily
    // collapses the textarea, which makes the browser clamp the surrounding
    // scroll container back to the top. Capture and restore the scroll position
    // so typing in a long notes field never yanks the page upward.
    const scroller = el.closest('.board-scroll') as HTMLElement | null
    const top = scroller ? scroller.scrollTop : null
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
    if (scroller && top != null) scroller.scrollTop = top
  }
  useEffect(() => {
    if (multiline) grow()
  }, [val, multiline])

  const commit = () => {
    const next = format ? format(val.trim()) : val.trim()
    if (next !== val) setVal(next) // reflect the formatted value in the field
    if (next !== (value ?? '').trim()) onSave(next)
  }

  const base =
    '-mx-2 w-[calc(100%+1rem)] rounded-md border border-transparent bg-transparent px-2 py-1 text-[14px] leading-normal text-parchment transition-colors placeholder:text-faint/60 hover:bg-surface-2 focus:border-line-strong focus:bg-surface-2 focus:outline-none'

  return (
    <div>
      {label && <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.16em] text-faint">{label}</p>}
      <div className="flex items-start">
        {prefix && <span className="mt-1 mr-0.5 text-[14px] text-muted">{prefix}</span>}
        {multiline ? (
          <textarea
            ref={taRef}
            value={val}
            rows={1}
            onChange={(e) => setVal(e.target.value)}
            onInput={grow}
            onBlur={commit}
            placeholder={placeholder}
            className={`${base} resize-none overflow-hidden`}
          />
        ) : (
          <input
            type={type}
            value={val}
            onChange={(e) => setVal(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                ;(e.target as HTMLInputElement).blur()
              }
            }}
            placeholder={placeholder}
            className={`${base} ${type === 'date' ? '[color-scheme:dark]' : ''}`}
          />
        )}
      </div>
    </div>
  )
}
