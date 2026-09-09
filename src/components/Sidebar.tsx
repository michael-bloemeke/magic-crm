import { type ReactNode } from 'react'

export type Page =
  | 'home'
  | 'pipeline'
  | 'inbox'
  | 'tasks'
  | 'calendar'
  | 'finance'
  | 'stats'
  | 'website'
  | 'proposals'
  | 'contacts'
  | 'files'
  | 'completed'
  | 'archive'
  | 'deleted'
  | 'settings'

type NavItem = {
  id: Page
  label: string
  icon: ReactNode
  enabled: boolean
  badge?: 'tasks' | 'inbox'
}

type NavGroup = { heading: string; items: NavItem[] }

const icon = (path: ReactNode) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-[18px] w-[18px]"
  >
    {path}
  </svg>
)

const GROUPS: NavGroup[] = [
  {
    heading: 'Workspace',
    items: [
      {
        id: 'home',
        label: 'Home',
        enabled: true,
        icon: icon(
          <>
            <path d="M4 11l8-7 8 7" />
            <path d="M6 10v9a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-9" />
          </>,
        ),
      },
      {
        id: 'pipeline',
        label: 'Pipeline',
        enabled: true,
        icon: icon(
          <>
            <rect x="3" y="4" width="5" height="16" rx="1" />
            <rect x="10" y="4" width="5" height="11" rx="1" />
            <rect x="17" y="4" width="4" height="7" rx="1" />
          </>,
        ),
      },
      {
        id: 'inbox',
        label: 'Inbox',
        enabled: true,
        badge: 'inbox',
        icon: icon(
          <>
            <path d="M3 12h5l2 3h4l2-3h5" />
            <path d="M5 5h14l2 7v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5z" />
          </>,
        ),
      },
      {
        id: 'tasks',
        label: 'Tasks',
        enabled: true,
        badge: 'tasks',
        icon: icon(
          <>
            <path d="M4 6.5h10M4 12h10M4 17.5h6" />
            <path d="M17.5 5.5l1.6 1.6 2.4-3" />
          </>,
        ),
      },
      {
        id: 'calendar',
        label: 'Calendar',
        enabled: true,
        icon: icon(
          <>
            <rect x="3.5" y="5" width="17" height="15" rx="2" />
            <path d="M3.5 9.5h17M8 3.5v3M16 3.5v3" />
          </>,
        ),
      },
      {
        id: 'finance',
        label: 'Finance',
        enabled: true,
        icon: icon(
          <>
            <path d="M3 17l5-5 3 3 7-7" />
            <path d="M16 8h4v4" />
          </>,
        ),
      },
      {
        id: 'stats',
        label: 'Stats',
        enabled: true,
        icon: icon(
          <>
            <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
          </>,
        ),
      },
      {
        // Everything that has gone OUT to a client: the proposal pages and the booking forms, with
        // their read counts. Sits next to Website because that is where those pages actually live.
        id: 'proposals',
        label: 'Proposals',
        enabled: true,
        icon: icon(
          <>
            <path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
            <path d="M14 3v4h4" />
            <path d="M8.5 12.5h7M8.5 16.5h4.5" />
          </>,
        ),
      },
      {
        id: 'website',
        label: 'Website',
        enabled: true,
        icon: icon(
          <>
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18" />
            <path d="M12 3c2.6 2.6 2.6 15.4 0 18M12 3c-2.6 2.6-2.6 15.4 0 18" />
          </>,
        ),
      },
      {
        id: 'contacts',
        label: 'Contacts',
        enabled: true,
        icon: icon(
          <>
            <circle cx="9" cy="8" r="3" />
            <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
            <path d="M16 5.2a3 3 0 0 1 0 5.6M17.5 20a5.5 5.5 0 0 0-2.7-4.7" />
          </>,
        ),
      },
    ],
  },
  {
    heading: 'Library',
    items: [
      {
        id: 'files',
        label: 'Files',
        enabled: true,
        icon: icon(
          <>
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          </>,
        ),
      },
    ],
  },
  {
    heading: 'Records',
    items: [
      {
        id: 'completed',
        label: 'Completed',
        enabled: true,
        icon: icon(
          <>
            <circle cx="12" cy="12" r="8.5" />
            <path d="M8.5 12l2.5 2.5L16 9" />
          </>,
        ),
      },
      {
        id: 'archive',
        label: 'Archive',
        enabled: true,
        icon: icon(
          <>
            <rect x="3" y="4" width="18" height="4" rx="1" />
            <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" />
          </>,
        ),
      },
      {
        id: 'deleted',
        label: 'Deleted',
        enabled: true,
        icon: icon(
          <>
            <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6" />
          </>,
        ),
      },
    ],
  },
  {
    heading: 'System',
    items: [
      {
        id: 'settings',
        label: 'Settings',
        enabled: true,
        icon: icon(
          <>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </>,
        ),
      },
    ],
  },
]

type Props = {
  page: Page
  onNavigate: (page: Page) => void
  taskAlerts: number
  inboxUnread: number
  onOpenSearch: () => void
}

export function Sidebar({ page, onNavigate, taskAlerts, inboxUnread, onOpenSearch }: Props) {
  return (
    <aside className="board-scroll relative z-10 flex w-[236px] shrink-0 flex-col overflow-y-auto border-r border-line bg-surface/40 backdrop-blur-sm">
      <Wordmark />

      {/* Search trigger */}
      <div className="px-3 pb-3">
        <button
          type="button"
          onClick={onOpenSearch}
          className="flex w-full items-center gap-2.5 rounded-lg border border-line bg-surface-2/60 px-3 py-2 text-left text-[13px] text-faint transition-colors hover:border-line-strong hover:text-muted"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
          <span className="flex-1">Search</span>
          <kbd className="rounded border border-line px-1 py-0.5 text-[9.5px] tracking-wide">⌘K</kbd>
        </button>
      </div>

      <div className="mx-5 mb-2 h-px bg-line" />

      {/* Nav */}
      <nav className="flex flex-1 flex-col gap-3 px-3 pb-4">
        {GROUPS.map((group) => (
          <div key={group.heading} className="flex flex-col gap-1">
            <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-faint">
              {group.heading}
            </p>
            {group.items.map((item) => {
              const isActive = item.enabled && page === item.id
              const count = item.badge === 'tasks' ? taskAlerts : item.badge === 'inbox' ? inboxUnread : 0
              const showAlert = item.enabled && count > 0
              return (
                <button
                  key={item.id}
                  type="button"
                  disabled={!item.enabled}
                  onClick={() => item.enabled && onNavigate(item.id as Page)}
                  className={[
                    'group flex items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[13.5px] font-medium transition-colors duration-200',
                    isActive
                      ? 'bg-surface-3 text-parchment'
                      : item.enabled
                        ? 'text-muted hover:bg-surface-2/60 hover:text-parchment'
                        : 'cursor-default text-muted/60',
                  ].join(' ')}
                >
                  <span className={isActive ? 'text-brass' : 'text-faint group-hover:text-muted'}>{item.icon}</span>
                  <span className="flex-1">{item.label}</span>
                  {showAlert ? (
                    <span
                      className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10px] font-bold text-canvas"
                      style={{ backgroundColor: item.badge === 'tasks' ? '#dc2626' : 'var(--color-brass)' }}
                    >
                      {count}
                    </span>
                  ) : isActive ? (
                    <span className="h-1.5 w-1.5 rounded-full bg-brass shadow-[0_0_8px_var(--color-brass)]" />
                  ) : !item.enabled ? (
                    <span className="rounded-full border border-line px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-faint">
                      Soon
                    </span>
                  ) : null}
                </button>
              )
            })}
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="mt-auto px-5 pb-5 pt-4">
        <div className="mb-3 h-px bg-line" />
        <p className="text-[11px] text-faint">Pipeline mirrors your HoneyBook + Notion stages.</p>
      </div>
    </aside>
  )
}

// The wordmark. It used to be a dropdown for picking one of six color schemes; there is only one
// scheme now, so it is just a label.
function Wordmark() {
  return (
    <div className="flex items-center gap-3 px-5 pb-4 pt-5">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-line-strong bg-surface-2">
        <span className="font-display text-[22px] italic leading-none text-brass">M</span>
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-display text-[17px] leading-tight text-parchment">Michael Bloemeke</p>
        <p className="truncate text-[10px] uppercase tracking-[0.18em] text-faint">Award-Winning Magic</p>
      </div>
    </div>
  )

}
