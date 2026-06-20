import type { CommsData, EmailThread } from '../api'

// The project's conversations box on Details. A fixed-height box about five rows
// tall; with more threads you just scroll inside it. Clicking a thread opens the
// full-page reader; "Write email" composes a new one. (Replaced the old
// Communications tab, then the expand/collapse "View all" toggle.)

const ME = 'michael@michaelbloemeke.com'

export function MiniComms({
  data,
  error,
  onOpen,
  onWrite,
}: {
  data: CommsData | null
  error?: string | null
  onOpen: (threadId: string) => void
  onWrite?: () => void
}) {
  const total = data?.threads.length ?? 0
  const sorted = data
    ? [...data.threads].sort(
        (a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0) || (b.lastDate || '').localeCompare(a.lastDate || ''),
      )
    : []

  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-brass-dim">Conversations</h3>
        {total > 0 && (
          <span
            className="inline-flex items-center justify-center rounded-full px-2 py-0.5 text-[11.5px] font-bold tabular-nums text-brass-bright"
            style={{ backgroundColor: 'color-mix(in oklab, var(--color-brass) 18%, transparent)' }}
          >
            {total}
          </span>
        )}
        {onWrite && (
          <button
            type="button"
            onClick={onWrite}
            title="Write a new email"
            className="ml-auto inline-flex items-center gap-1 text-[11.5px] font-semibold text-brass-bright transition-colors hover:text-brass"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
            Write email
          </button>
        )}
      </div>

      {error ? (
        <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-[12px] text-faint">{error}</p>
      ) : !data ? (
        <p className="animate-pulse rounded-xl border border-dashed border-line px-4 py-6 text-center text-[12px] text-faint">
          Loading…
        </p>
      ) : sorted.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-[12px] text-faint">
          No conversations yet.
        </p>
      ) : (
        <div className="board-scroll max-h-[18rem] space-y-1.5 overflow-y-auto pr-1">
          {sorted.map((t) => (
            <MiniRow key={t.id} thread={t} onOpen={() => onOpen(t.id)} />
          ))}
        </div>
      )}

      {data && !data.connected && (
        <a
          href="/api/gmail/auth"
          className="mt-2 inline-block text-[11px] font-medium text-brass-dim transition-colors hover:text-brass"
        >
          Showing sample emails. Connect Gmail →
        </a>
      )}
    </section>
  )
}

function MiniRow({ thread, onOpen }: { thread: EmailThread; onOpen: () => void }) {
  const unread = thread.unread ?? 0
  const last = thread.messages[thread.messages.length - 1]
  const lastWho = last ? (last.from === ME ? 'You' : last.fromName.split(' ')[0]) : ''
  const preview = last ? `${lastWho}: ${last.body.replace(/\s+/g, ' ').trim()}` : ''

  return (
    <button
      type="button"
      onClick={onOpen}
      className={[
        'flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors',
        unread > 0 ? 'border-brass-dim/50 bg-surface-3/40' : 'border-line bg-surface-2/50 hover:border-line-strong',
      ].join(' ')}
    >
      {unread > 0 && <span className="h-2 w-2 shrink-0 rounded-full bg-brass" title={`${unread} unread`} />}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className={['truncate text-[12.5px]', unread > 0 ? 'font-semibold text-parchment' : 'text-parchment/90'].join(' ')}>
            {thread.subject}
          </p>
          {unread > 0 && (
            <span className="shrink-0 rounded-full bg-brass px-1.5 py-0.5 text-[9px] font-bold text-canvas">{unread}</span>
          )}
        </div>
        <p className="mt-0.5 truncate text-[11px] text-faint">{preview}</p>
      </div>
      <span className="shrink-0 text-[10.5px] tabular-nums text-faint">{thread.lastDate}</span>
    </button>
  )
}
