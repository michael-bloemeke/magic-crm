import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { Tag } from '../types'
import { useTricks } from './TricksContext'
import { TagChip } from './TagChip'

type Props = {
  selectedTagIds: string[]
  onChange: (tagIds: string[]) => void
}

export function TagPicker({ selectedTagIds, onChange }: Props) {
  const { tags, tagsById, createTag } = useTricks()
  const [input, setInput] = useState('')
  const [open, setOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const selectedTags = useMemo(
    () => selectedTagIds.map((id) => tagsById.get(id)).filter((t): t is Tag => !!t),
    [selectedTagIds, tagsById]
  )

  const suggestions = useMemo(() => {
    const q = input.trim().toLowerCase()
    return tags.filter((t) => {
      if (selectedTagIds.includes(t.id)) return false
      if (!q) return true
      return t.name.toLowerCase().includes(q)
    })
  }, [tags, input, selectedTagIds])

  const exactMatch = useMemo(() => {
    const q = input.trim().toLowerCase()
    if (!q) return null
    return tags.find((t) => t.name.toLowerCase() === q) ?? null
  }, [tags, input])

  const addTag = (id: string) => {
    if (selectedTagIds.includes(id)) return
    onChange([...selectedTagIds, id])
    setInput('')
    inputRef.current?.focus()
  }

  const removeTag = (id: string) => {
    onChange(selectedTagIds.filter((t) => t !== id))
  }

  const createAndAdd = async () => {
    const name = input.trim()
    if (!name) return
    // If exact match exists, just add it.
    if (exactMatch) {
      addTag(exactMatch.id)
      return
    }
    const newTag = await createTag(name)
    addTag(newTag.id)
  }

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (suggestions.length > 0 && !exactMatch) {
        addTag(suggestions[0].id)
      } else {
        createAndAdd()
      }
    } else if (e.key === 'Backspace' && input === '' && selectedTagIds.length > 0) {
      removeTag(selectedTagIds[selectedTagIds.length - 1])
    } else if (e.key === 'Escape') {
      setOpen(false)
      inputRef.current?.blur()
    }
  }

  return (
    <div className="tag-picker">
      <div
        className="tag-picker-input-row"
        onClick={() => inputRef.current?.focus()}
      >
        {selectedTags.map((t) => (
          <TagChip key={t.id} tag={t} size="sm" onRemove={() => removeTag(t.id)} />
        ))}
        <input
          ref={inputRef}
          className="tag-picker-input"
          placeholder={selectedTags.length === 0 ? 'Add tags...' : ''}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          onFocus={() => {
            if (blurTimer.current) clearTimeout(blurTimer.current)
            setOpen(true)
          }}
          onBlur={() => {
            // Delay close so suggestion clicks register first.
            blurTimer.current = setTimeout(() => setOpen(false), 120)
          }}
        />
      </div>

      {open && (suggestions.length > 0 || (input.trim() && !exactMatch)) && (
        <div className="tag-picker-dropdown">
          {input.trim() && !exactMatch && (
            <button
              type="button"
              className="tag-picker-create"
              onMouseDown={(e) => e.preventDefault()}
              onClick={createAndAdd}
            >
              + Create &ldquo;{input.trim()}&rdquo;
            </button>
          )}
          {suggestions.slice(0, 20).map((t) => (
            <button
              type="button"
              key={t.id}
              className="tag-picker-suggestion"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => addTag(t.id)}
            >
              {t.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
