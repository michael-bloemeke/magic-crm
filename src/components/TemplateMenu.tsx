import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { TEMPLATE_GROUPS, findTemplate } from '../emailTemplates'

// The template picker, as a menu with folders rather than one long list: the top level is
// "No template" plus the three libraries, and hovering a library slides its templates out beside it.
// A native <select> cannot do this (an <optgroup> only indents, it never cascades), so this is a
// button plus a popover.
//
// Used by BOTH email boxes. The composer opens downward with room to spare; the reply box sits at
// the bottom of a scrolling page, so it opens upward — hence `direction`. The flyout picks its own
// side and vertical offset from the actual viewport, so neither can end up off screen.

export function TemplateMenu({
  value,
  onPick,
  tone = 'dark',
  direction = 'down',
}: {
  value: string
  onPick: (id: string) => void
  tone?: 'dark' | 'light'
  /** Which way the panel opens from the button. */
  direction?: 'down' | 'up'
}) {
  const [open, setOpen] = useState(false)
  const [openGroup, setOpenGroup] = useState<string | null>(null)
  // Where the flyout sits relative to its folder row, measured once it is on screen.
  const [flyout, setFlyout] = useState<{ side: 'left' | 'right'; top: number }>({ side: 'right', top: 0 })
  const rootRef = useRef<HTMLDivElement>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const flyRef = useRef<HTMLDivElement>(null)
  const light = tone === 'light'

  const current = value ? findTemplate(value) : undefined
  const label = current ? current.name : 'No template'

  // Close on an outside click or Escape, like any menu.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false)
        setOpenGroup(null)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        setOpenGroup(null)
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Place the flyout: to the right unless that would run off screen, and nudged up so its bottom
  // stays on screen. Measured rather than assumed, because the two hosts open in opposite directions
  // and the lists are different lengths.
  useLayoutEffect(() => {
    if (!openGroup) return
    const row = rowRef.current?.getBoundingClientRect()
    const fly = flyRef.current?.getBoundingClientRect()
    if (!row || !fly) return
    const side: 'left' | 'right' = row.right + fly.width + 8 > window.innerWidth ? 'left' : 'right'
    const overflow = row.top + fly.height + 8 - window.innerHeight
    setFlyout({ side, top: overflow > 0 ? -Math.min(overflow, row.top - 8) : 0 })
  }, [openGroup])

  const pick = (id: string) => {
    setOpen(false)
    setOpenGroup(null)
    onPick(id)
  }

  const btnCls = light
    ? 'flex items-center gap-1.5 rounded-lg border border-[#d8dde3] bg-white py-1 pl-2.5 pr-2 text-[11.5px] text-[#14171b] transition-colors hover:border-[#2563eb] focus:border-[#2563eb] focus:outline-none'
    : 'flex w-full items-center justify-between gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2 text-[13px] text-parchment transition-colors hover:border-brass-dim focus:border-brass-dim focus:outline-none'
  const panelCls = light
    ? 'absolute z-30 min-w-[15rem] rounded-lg border border-[#d8dde3] bg-white py-1 shadow-[0_20px_50px_-20px_rgba(0,0,0,0.25)]'
    : 'absolute z-30 min-w-[15rem] rounded-lg border border-line-strong bg-surface-2 py-1 shadow-[0_20px_50px_-20px_rgba(0,0,0,0.18)]'
  const itemCls = light
    ? 'flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-[12px] text-[#14171b] hover:bg-[#f5f7f9]'
    : 'flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-[12.5px] text-parchment hover:bg-surface-3'
  const activeCls = light ? 'bg-[#f5f7f9]' : 'bg-surface-3'
  const faint = light ? 'text-[#858d97]' : 'text-faint'

  return (
    <div ref={rootRef} className={light ? 'relative' : 'relative w-full'}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={btnCls}
      >
        <span className="truncate">{label}</span>
        <svg viewBox="0 0 24 24" className={`h-3 w-3 shrink-0 ${faint}`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div
          className={`${panelCls} ${direction === 'up' ? 'bottom-[calc(100%+4px)]' : 'top-[calc(100%+4px)]'} left-0`}
          role="menu"
        >
          <button type="button" onClick={() => pick('')} onMouseEnter={() => setOpenGroup(null)} className={itemCls} role="menuitem">
            <span>No template</span>
            {!value && <Tick className={faint} />}
          </button>

          <div className={`my-1 border-t ${light ? 'border-[#eaedf1]' : 'border-line'}`} />

          {TEMPLATE_GROUPS.map((g) => {
            const isOpen = openGroup === g.id
            return (
              <div
                key={g.id}
                ref={isOpen ? rowRef : undefined}
                className="relative"
                onMouseEnter={() => setOpenGroup(g.id)}
              >
                <button
                  type="button"
                  onFocus={() => setOpenGroup(g.id)}
                  onClick={() => setOpenGroup((cur) => (cur === g.id ? null : g.id))}
                  className={`${itemCls} ${isOpen ? activeCls : ''}`}
                  aria-haspopup="menu"
                  aria-expanded={isOpen}
                  role="menuitem"
                >
                  <span className="font-medium">{g.name}</span>
                  <span className={`flex shrink-0 items-center gap-1.5 ${faint}`}>
                    <span className="text-[10px] tabular-nums">{g.templates.length}</span>
                    <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9 6l6 6-6 6" />
                    </svg>
                  </span>
                </button>

                {isOpen && (
                  <div
                    ref={flyRef}
                    style={{ top: flyout.top }}
                    className={[
                      panelCls,
                      'board-scroll max-h-[min(22rem,60vh)] w-64 overflow-y-auto',
                      flyout.side === 'right' ? 'left-[calc(100%+2px)]' : 'right-[calc(100%+2px)]',
                    ].join(' ')}
                    role="menu"
                  >
                    {g.templates.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => pick(t.id)}
                        className={`${itemCls} ${value === t.id ? activeCls : ''}`}
                        role="menuitem"
                      >
                        <span className="min-w-0 truncate">{t.name}</span>
                        {value === t.id && <Tick className={faint} />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function Tick({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={`h-3.5 w-3.5 shrink-0 ${className}`} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 13l4 4L19 7" />
    </svg>
  )
}
