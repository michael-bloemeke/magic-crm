import { useState, type KeyboardEvent } from 'react'
import type { TrickProp } from '../types'

type Props = {
  items: TrickProp[]
  onChange: (items: TrickProp[]) => void
}

export function PropsListEditor({ items, onChange }: Props) {
  const [draft, setDraft] = useState('')

  const add = () => {
    const value = draft.trim()
    if (!value) return
    onChange([...items, { name: value, reusable: false }])
    setDraft('')
  }

  const remove = (i: number) => {
    onChange(items.slice(0, i).concat(items.slice(i + 1)))
  }

  const updateName = (i: number, name: string) => {
    const next = items.slice()
    next[i] = { ...next[i], name }
    onChange(next)
  }

  const toggleReusable = (i: number) => {
    const next = items.slice()
    next[i] = { ...next[i], reusable: !next[i].reusable }
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
            <li key={i} className="string-list-row props-row">
              <input
                className="text-input string-list-input"
                value={item.name}
                onChange={(e) => updateName(i, e.target.value)}
                onBlur={(e) => {
                  const value = e.target.value.trim()
                  if (!value) remove(i)
                  else if (value !== item.name) updateName(i, value)
                }}
              />
              <label
                className={`reusable-toggle ${item.reusable ? 'reusable-toggle-on' : ''}`}
                title="Mark as reusable across tricks"
              >
                <input
                  type="checkbox"
                  checked={!!item.reusable}
                  onChange={() => toggleReusable(i)}
                />
                <span>Reusable</span>
              </label>
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
          placeholder="Add a prop and press Enter"
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
