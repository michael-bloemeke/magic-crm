import { useEffect, useRef, useState } from 'react'

type Props = {
  value: string
  onSave: (value: string) => void
  className?: string
}

// Inline-editable project name. Looks like the heading, becomes clearly editable
// on hover/focus, saves on blur or Enter. Refuses to save an empty name (reverts
// to the current one) so a project is never left untitled. Escape cancels the
// edit; both keys stopPropagation so editing the title can't also close the pane.
export function EditableTitle({ value, onSave, className = '' }: Props) {
  const [val, setVal] = useState(value)
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => setVal(value), [value])

  const commit = () => {
    const next = val.trim()
    if (!next) {
      setVal(value)
      return
    }
    if (next !== value.trim()) onSave(next)
  }

  return (
    <input
      ref={ref}
      value={val}
      onChange={(e) => setVal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          e.stopPropagation()
          ;(e.target as HTMLInputElement).blur()
        } else if (e.key === 'Escape') {
          e.stopPropagation()
          setVal(value)
          ;(e.target as HTMLInputElement).blur()
        }
      }}
      title="Click to rename this project"
      aria-label="Project name"
      className={`-mx-2 w-[calc(100%+1rem)] rounded-lg border border-transparent bg-transparent px-2 py-0.5 transition-colors hover:bg-surface-2/70 focus:border-line-strong focus:bg-surface-2 focus:outline-none ${className}`}
    />
  )
}
