import { useTricks } from './TricksContext'
import { TagChip } from './TagChip'

type Props = {
  selectedTagIds: string[]
  onChange: (tagIds: string[]) => void
  // Optional: limit to tags that are actually used by at least one trick.
  onlyInUse?: boolean
}

export function TagFilter({ selectedTagIds, onChange, onlyInUse }: Props) {
  const { tags, tricks } = useTricks()

  const visibleTags = onlyInUse
    ? tags.filter((t) => tricks.some((tr) => tr.tagIds?.includes(t.id)))
    : tags

  if (visibleTags.length === 0) return null

  const toggle = (id: string) => {
    if (selectedTagIds.includes(id)) {
      onChange(selectedTagIds.filter((t) => t !== id))
    } else {
      onChange([...selectedTagIds, id])
    }
  }

  return (
    <div className="tag-filter">
      <span className="tag-filter-label">Filter:</span>
      <div className="tag-filter-chips">
        {visibleTags.map((t) => (
          <TagChip
            key={t.id}
            tag={t}
            size="sm"
            active={selectedTagIds.includes(t.id)}
            onClick={() => toggle(t.id)}
          />
        ))}
        {selectedTagIds.length > 0 && (
          <button
            type="button"
            className="tag-filter-clear"
            onClick={() => onChange([])}
          >
            Clear
          </button>
        )}
      </div>
    </div>
  )
}
