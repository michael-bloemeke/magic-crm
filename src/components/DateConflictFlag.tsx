import { Fragment, useContext } from 'react'
import { DateConflictContext } from '../dateConflicts'

// A loud "Potential date conflict" flag, shown on any project whose event date collides with another
// still-relevant project (a possible double-booking). `badge` is the compact one for cards/rows;
// `banner` is the larger, more prominent version for the project-view headers.
//
// ⚠️ IT NAMES THE OTHER PROJECT, IN PLAIN SIGHT, AND THE NAME IS A LINK (2026-11-11). Michael: "I
// don't want to have to hover. I want it to just automatically show it." and "if I click on the
// project name of whatever the conflict is, it'll take me to that project."
//   - Never move the names back into a `title` tooltip, and never truncate them: a clipped name
//     would need the hover again. A long list wraps instead.
//   - Several clashes read "with A and B and C", his wording. Every one is listed.
//   - A name that is a CRM project opens that project. A Google "Gigs" calendar entry is plain text.
//   - The flag sits inside cards that are themselves clickable, so a click (or Enter / Space) on a
//     name must NOT reach the card, or it would open the card's own project instead.
//
// The names and the opener come from DateConflictContext by `projectId`.

const RED = '#ef4444'

function WarnIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  )
}

export function DateConflictFlag({ variant = 'badge', projectId }: { variant?: 'badge' | 'banner'; projectId: string }) {
  const { info, open } = useContext(DateConflictContext)
  const partners = info.get(projectId) || []
  const banner = variant === 'banner'
  return (
    <span
      className={[
        'inline-flex max-w-full flex-wrap items-center text-left',
        banner ? 'gap-x-2 gap-y-0.5 rounded-lg px-2.5 py-1' : 'gap-x-1.5 gap-y-0.5 rounded-md px-1.5 py-0.5',
      ].join(' ')}
      style={{
        backgroundColor: `color-mix(in oklab, ${RED} 18%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${RED} ${banner ? 55 : 45}%, transparent)`,
      }}
    >
      <span
        className={['inline-flex shrink-0 items-center font-bold uppercase tracking-[0.06em]', banner ? 'gap-1.5 text-[12px]' : 'gap-1 text-[9.5px]'].join(' ')}
        style={{ color: RED }}
      >
        <WarnIcon className={banner ? 'h-3.5 w-3.5' : 'h-2.5 w-2.5'} />
        Potential date conflict
      </span>
      {partners.length > 0 && (
        <span className={['min-w-0 font-semibold leading-snug text-parchment', banner ? 'text-[13px]' : 'text-[11px]'].join(' ')}>
          with{' '}
          {partners.map((c, i) => (
            <Fragment key={(c.projectId || 'gig') + i}>
              {i > 0 && ' and '}
              {c.projectId ? (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    open(c.projectId!)
                  }}
                  onKeyDown={(e) => e.stopPropagation()}
                  className="cursor-pointer rounded-sm text-left font-semibold underline decoration-1 underline-offset-2 hover:decoration-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1"
                  style={{ textDecorationColor: `color-mix(in oklab, ${RED} 70%, transparent)`, outlineColor: RED }}
                >
                  {c.name}
                </button>
              ) : (
                c.name
              )}
            </Fragment>
          ))}
        </span>
      )}
    </span>
  )
}
