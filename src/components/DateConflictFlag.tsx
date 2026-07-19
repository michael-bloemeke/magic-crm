// A loud "Potential date conflict" flag, shown on any project whose event date collides with another
// still-relevant project (a possible double-booking). `badge` is the compact pill for cards/rows;
// `banner` is the larger, more prominent version for the project-view headers.

const RED = '#ef4444'

function WarnIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  )
}

export function DateConflictFlag({ variant = 'badge' }: { variant?: 'badge' | 'banner' }) {
  const banner = variant === 'banner'
  return (
    <span
      title="Another project shares this event date. Check for a double-booking."
      className={[
        'inline-flex items-center font-bold uppercase',
        banner ? 'gap-1.5 rounded-lg px-2.5 py-1 text-[12px] tracking-[0.06em]' : 'gap-1 rounded-full px-1.5 py-0.5 text-[9.5px] tracking-[0.06em]',
      ].join(' ')}
      style={{
        color: RED,
        backgroundColor: `color-mix(in oklab, ${RED} 18%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${RED} ${banner ? 55 : 45}%, transparent)`,
      }}
    >
      <WarnIcon className={banner ? 'h-3.5 w-3.5' : 'h-2.5 w-2.5'} />
      Potential date conflict
    </span>
  )
}
