import { useEffect, useRef, useState, type CSSProperties } from 'react'

// A tiny always-editable text field used for renaming categories and stages in
// the board's edit mode. Commits on blur or Enter; Escape reverts.
export function InlineRename({
  value,
  onSave,
  className,
  ariaLabel,
  style,
}: {
  value: string
  onSave: (next: string) => void
  className?: string
  ariaLabel?: string
  style?: CSSProperties
}) {
  const [v, setV] = useState(value)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => setV(value), [value])

  const commit = () => {
    const next = v.trim()
    if (next && next !== value) onSave(next)
    else setV(value)
  }

  return (
    <input
      ref={ref}
      value={v}
      aria-label={ariaLabel}
      style={style}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        else if (e.key === 'Escape') {
          setV(value)
          e.currentTarget.blur()
        }
      }}
      className={className}
    />
  )
}
