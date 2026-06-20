import type { Relationship } from '../api'
import { RELATIONSHIP_OPTIONS } from '../contacts'

// The Active / Yes / Maybe / No relationship toggle. Clicking the active one
// clears it. Shared by the contact drawer and the archive/complete dialogs.

export function RelationshipChips({
  value,
  onChange,
}: {
  value: Relationship
  onChange: (v: Relationship) => void
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {RELATIONSHIP_OPTIONS.map((r) => {
        const active = value === r.v
        return (
          <button
            key={r.v}
            type="button"
            onClick={() => onChange(active ? '' : r.v)}
            className="rounded-full border px-3.5 py-1 text-[12px] font-semibold transition-colors"
            style={
              active
                ? { borderColor: r.color, color: r.color, backgroundColor: `color-mix(in oklab, ${r.color} 16%, transparent)` }
                : { borderColor: 'var(--color-line)', color: 'var(--color-muted)' }
            }
          >
            {r.label}
          </button>
        )
      })}
    </div>
  )
}
