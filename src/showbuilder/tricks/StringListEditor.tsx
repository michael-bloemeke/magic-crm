import { useState, type KeyboardEvent } from 'react'

type Props = {
  items: string[]
  onChange: (items: string[]) => void
  placeholder?: string
}

export function StringListEditor({ items, onChange, placeholder }: Props) {
  const [draft, setDraft] = useState('')

  const add = () => {
    const value = draft.trim()
    if (!value) return
    onChange([...items, value])
    setDraft('')
  }

  const remove = (i: number) => {
    onChange(items.slice(0, i).concat(items.slice(i + 1)))
  }

  const update = (i: number, value: string) => {
    const next = items.slice()
    next[i] = value
    onChange(next)
  }

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      add()
    }
  }

  return (
    <div className="string-list">
      {items.length > 0 && (
        <ul className="string-list-items">
          {items.map((item, i) => (
            <li key={i} className="string-list-row">
              <input
                className="text-input string-list-input"
                value={item}
                onChange={(e) => update(i, e.target.value)}
                onBlur={(e) => {
                  // Trim and drop empty rows on blur.
                  const value = e.target.value.trim()
                  if (!value) remove(i)
                  else if (value !== item) update(i, value)
                }}
              />
              <button
                type="button"
                className="btn-ghost string-list-remove"
                onClick={() => remove(i)}
                aria-label="Remove"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="string-list-add-row">
        <input
          className="text-input"
          placeholder={placeholder ?? 'Add an item and press Enter'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
        />
        <button
          type="button"
          className="btn-secondary"
          onClick={add}
          disabled={!draft.trim()}
        >
          Add
        </button>
      </div>
    </div>
  )
}
