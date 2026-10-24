import type { MouseEvent } from 'react'
import type { Tag } from '../types'

type Props = {
  tag: Tag
  onRemove?: () => void
  onClick?: () => void
  active?: boolean
  size?: 'sm' | 'md'
}

export function TagChip({ tag, onRemove, onClick, active, size = 'md' }: Props) {
  const handleRemove = (e: MouseEvent) => {
    e.stopPropagation()
    onRemove?.()
  }
  const clickable = !!onClick
  return (
    <span
      className={`tag-chip tag-chip-${size} ${active ? 'tag-chip-active' : ''} ${clickable ? 'tag-chip-clickable' : ''}`}
      onClick={onClick}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={(e) => {
        if (clickable && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          onClick?.()
        }
      }}
    >
      <span className="tag-chip-name">{tag.name}</span>
      {onRemove && (
        <button
          type="button"
          className="tag-chip-remove"
          onClick={handleRemove}
          aria-label={`Remove ${tag.name}`}
          tabIndex={-1}
        >
          ×
        </button>
      )}
    </span>
  )
}
