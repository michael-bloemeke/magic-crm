import { useEffect, useRef, useState } from 'react'

type Props = {
  label?: string
  value: string
  onSave: (value: string) => void
  multiline?: boolean
  type?: 'text' | 'date'
  prefix?: string
  placeholder?: string
  // When present the field becomes a dropdown of these choices instead of free text. Used where the
  // CRM has to agree with a fixed list the client also sees (Indoors / Outdoors / Both on the
  // booking form): free text on one side and a picker on the other guarantees they drift.
  options?: string[]
  // Optional normalizer applied when the field commits (e.g. phone formatting).
  format?: (value: string) => string
  // Flags this field as a blank that matters (Event details, where a gap is a problem). Tints the
  // label red and outlines the empty input, so the specific hole is obvious and not just the section.
  missing?: boolean
}

// An always-editable field: looks like text, becomes clearly editable on
// hover/focus, and saves on blur (or Enter, for single-line). No edit button.
export function EditableField({ label, value, onSave, multiline, type = 'text', prefix, placeholder = 'Add…', format, missing, options }: Props) {
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

  // A missing field keeps its normal behaviour and only changes colour, and the outline drops the
  // moment anything is typed, so filling the gap gives immediate feedback.
  const flag = !!missing && !val.trim()
  const base = [
    '-mx-2 w-[calc(100%+1rem)] rounded-md border bg-transparent px-2 py-1 text-[14px] leading-normal text-parchment transition-colors placeholder:text-faint/60 hover:bg-surface-2 focus:bg-surface-2 focus:outline-none',
    flag ? 'border-dashed border-[#ef4444]/45 focus:border-[#ef4444]' : 'border-transparent focus:border-line-strong',
  ].join(' ')

  return (
    <div>
      {label && (
        <p
          className={[
            'mb-1 text-[10.5px] font-semibold uppercase tracking-[0.16em]',
            flag ? 'text-[#ef4444]/80' : 'text-faint',
          ].join(' ')}
        >
          {label}
        </p>
      )}
      <div className="flex items-start">
        {prefix && <span className="mt-1 mr-0.5 text-[14px] text-muted">{prefix}</span>}
        {options ? (
          // Saves on change, not on blur: a dropdown has no "still typing" state to wait out.
          <select
            value={val}
            onChange={(e) => {
              setVal(e.target.value)
              if (e.target.value !== (value ?? '').trim()) onSave(e.target.value)
            }}
            className={`${base} cursor-pointer`}
          >
            <option value="">{placeholder}</option>
            {options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
            {/* An older free-text value that is not one of the choices still shows, rather than the
                field looking empty and quietly discarding what was there. */}
            {!!val.trim() && !options.includes(val) && <option value={val}>{val}</option>}
          </select>
        ) : multiline ? (
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
            className={base}
          />
        )}
      </div>
    </div>
  )
}
