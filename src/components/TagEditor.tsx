import { useState } from 'react'

// Tag chips + an add input with reuse suggestions. New tags are reported via
// onNewTag so the parent can add them to the shared tag library (reusable across
// contacts). knownTags powers the click-to-reuse suggestion chips.

type Props = {
  tags: string[]
  knownTags: string[]
  onChange: (tags: string[]) => void
  onNewTag?: (tag: string) => void
}

export function TagEditor({ tags, knownTags, onChange, onNewTag }: Props) {
  const [input, setInput] = useState('')

  const has = (t: string) => tags.some((x) => x.toLowerCase() === t.toLowerCase())

  const add = (raw: string) => {
    const t = raw.trim()
    if (!t) return
    if (!has(t)) {
      onChange([...tags, t])
      if (!knownTags.some((k) => k.toLowerCase() === t.toLowerCase())) onNewTag?.(t)
    }
    setInput('')
  }

  const q = input.trim().toLowerCase()
  const suggestions = knownTags
    .filter((t) => !has(t))
    .filter((t) => (q ? t.toLowerCase().includes(q) : true))
    .slice(0, 12)

  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.map((t) => (
          <span
            key={t}
            className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[11.5px] text-parchment"
          >
            {t}
            <button
              type="button"
              onClick={() => onChange(tags.filter((x) => x !== t))}
              className="text-faint hover:text-[#dc2626]"
              aria-label={`Remove ${t}`}
            >
              <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </span>
        ))}
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add(input)
            }
          }}
          onBlur={() => add(input)}
          placeholder="+ tag"
          className="w-24 rounded-full border border-dashed border-line bg-transparent px-2 py-0.5 text-[11.5px] text-parchment placeholder:text-faint focus:border-brass-dim focus:outline-none"
        />
      </div>

      {suggestions.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-[0.12em] text-faint">Reuse</span>
          {suggestions.map((t) => (
            <button
              key={t}
              type="button"
              onMouseDown={(e) => {
                // mousedown (before the input's blur) so clicking a chip adds it
                e.preventDefault()
                add(t)
              }}
              className="rounded-full border border-line bg-surface-2/60 px-2 py-0.5 text-[11px] text-muted transition-colors hover:border-brass-dim hover:text-brass-bright"
            >
              {t}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
