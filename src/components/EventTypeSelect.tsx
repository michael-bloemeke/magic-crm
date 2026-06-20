import { EVENT_TYPE_ACCENT, type EventType } from '../pipeline'

// The event-type chip, but as a dropdown so it can be changed in place.
const TYPES = Object.keys(EVENT_TYPE_ACCENT) as EventType[]

export function EventTypeSelect({ value, onChange }: { value: EventType; onChange: (v: string) => void }) {
  const color = EVENT_TYPE_ACCENT[value] ?? 'var(--color-faint)'
  return (
    <div className="relative inline-flex items-center">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        title="Change event type"
        className="cursor-pointer appearance-none rounded-full border py-0.5 pl-2.5 pr-7 text-[10px] font-semibold uppercase tracking-[0.12em] focus:outline-none"
        style={{
          color,
          backgroundColor: `color-mix(in oklab, ${color} 14%, transparent)`,
          borderColor: `color-mix(in oklab, ${color} 35%, transparent)`,
        }}
      >
        {TYPES.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      <svg
        viewBox="0 0 24 24"
        className="pointer-events-none absolute right-2 h-3 w-3"
        style={{ color }}
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
