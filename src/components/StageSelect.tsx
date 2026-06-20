import type { CategoryDef } from '../pipeline'

// Stage dropdown (grouped by category). Changing it restages the project,
// which the parent persists to crm-pipeline.json. Reused by the side pane
// and the full project view. Options come from the live (editable) structure.
export function StageSelect({
  value,
  onChange,
  categories,
}: {
  value: string
  onChange: (stageId: string) => void
  categories: CategoryDef[]
}) {
  return (
    <div className="relative inline-flex items-center">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        title="Change pipeline stage"
        className="cursor-pointer appearance-none rounded-full border border-line bg-surface-2 py-0.5 pl-2.5 pr-7 text-[10px] font-semibold uppercase tracking-[0.12em] text-brass-bright transition-colors hover:border-brass-dim focus:border-brass focus:outline-none"
      >
        {categories.map((u) => (
          <optgroup key={u.id} label={u.label}>
            {u.stages.map((s) => (
              // Post Show stages are auto-only: shown (so a project there reads
              // correctly) but disabled, so they can't be picked as a manual target.
              <option key={s.id} value={s.id} disabled={u.role === 'postshow'}>
                {s.name}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <svg
        viewBox="0 0 24 24"
        className="pointer-events-none absolute right-2 h-3 w-3 text-brass-dim"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M6 9l6 6 6-6" />
      </svg>
    </div>
  )
}
