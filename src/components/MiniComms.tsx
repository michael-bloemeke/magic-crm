import type { CommsData, EmailThread, ProjectEmail } from '../api'

// The project's conversations box on Details. A fixed-height box about five rows tall; with more
// threads you just scroll inside it. Clicking a thread opens the full-page reader; "Write email"
// composes a new one. Starred conversations are highlighted (and can be starred right here, which
// carries through to Gmail). Drafts show inline: a "Draft" badge on a thread you've started a reply
// to, and standalone rows for new emails you've begun but not sent.

const ME = 'michael@michaelbloemeke.com'

// Strip HTML to a short plain-text preview for a draft row.
function htmlPreview(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

export function MiniComms({
  data,
  error,
  replyDrafts = {},
  newThreadDrafts = [],
  onOpen,
  onOpenDraft,
  onToggleStar,
  onWrite,
}: {
  data: CommsData | null
  error?: string | null
  // threadId -> the saved reply draft for that thread (shows a "Draft" badge on the row).
  replyDrafts?: Record<string, ProjectEmail>
  // New-thread drafts (not yet sent), shown as their own rows.
  newThreadDrafts?: ProjectEmail[]
  onOpen: (threadId: string) => void
  onOpenDraft?: (email: ProjectEmail) => void
  onToggleStar?: (threadId: string, starred: boolean) => void
  onWrite?: () => void
}) {
  // Combined, recency-sorted feed of real threads and new-thread drafts.
  type Row =
    | { kind: 'thread'; thread: EmailThread; ts: number }
    | { kind: 'draft'; email: ProjectEmail; ts: number }
  const rows: Row[] = []
  if (data) for (const t of data.threads) rows.push({ kind: 'thread', thread: t, ts: t.lastTs ?? 0 })
  for (const e of newThreadDrafts) rows.push({ kind: 'draft', email: e, ts: Date.parse(e.updatedAt || '') || 0 })
  rows.sort((a, b) => b.ts - a.ts)
  const total = rows.length

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
      ) : total === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-[12px] text-faint">
          No conversations yet.
        </p>
      ) : (
        <div className="board-scroll max-h-[18rem] space-y-1.5 overflow-y-auto pr-1">
          {rows.map((r) =>
            r.kind === 'thread' ? (
              <ThreadRow
                key={r.thread.id}
                thread={r.thread}
                hasDraft={!!replyDrafts[r.thread.id]}
                onOpen={() => onOpen(r.thread.id)}
                onToggleStar={onToggleStar ? () => onToggleStar(r.thread.id, !r.thread.starred) : undefined}
              />
            ) : (
              <DraftRow key={r.email.id} email={r.email} onOpen={() => onOpenDraft?.(r.email)} />
            ),
          )}
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

function ThreadRow({
  thread,
  hasDraft,
  onOpen,
  onToggleStar,
}: {
  thread: EmailThread
  hasDraft: boolean
  onOpen: () => void
  onToggleStar?: () => void
}) {
  const unread = thread.unread ?? 0
  const starred = !!thread.starred
  const last = thread.messages[thread.messages.length - 1]
  const lastWho = last ? (last.from === ME ? 'You' : last.fromName.split(' ')[0]) : ''
  const preview = last ? `${lastWho}: ${last.body.replace(/\s+/g, ' ').trim()}` : ''

  return (
    <div
      className={[
        'flex w-full items-center gap-1.5 rounded-lg border px-2 py-2 transition-colors',
        starred
          ? 'border-[#e0a93a]/55 bg-[#e0a93a]/10'
          : unread > 0
            ? 'border-brass-dim/50 bg-surface-3/40'
            : 'border-line bg-surface-2/50 hover:border-line-strong',
      ].join(' ')}
    >
      {onToggleStar && (
        <button
          type="button"
          onClick={onToggleStar}
          title={starred ? 'Unstar (also unstars in Gmail)' : 'Star (also stars in Gmail)'}
          aria-label={starred ? 'Unstar conversation' : 'Star conversation'}
          aria-pressed={starred}
          className={['shrink-0 rounded p-0.5 transition-colors', starred ? 'text-[#e0a93a]' : 'text-faint hover:text-[#e0a93a]'].join(' ')}
        >
          <StarIcon filled={starred} />
        </button>
      )}
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
        {unread > 0 && <span className="h-2 w-2 shrink-0 rounded-full bg-brass" title={`${unread} unread`} />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className={['truncate text-[12.5px]', unread > 0 ? 'font-semibold text-parchment' : 'text-parchment/90'].join(' ')}>
              {thread.subject}
            </p>
            {hasDraft && (
              <span className="shrink-0 rounded-full border border-[#e0cfa6]/40 bg-[#e0a93a]/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-[#e0b860]">
                Draft
              </span>
            )}
            {unread > 0 && (
              <span className="shrink-0 rounded-full bg-brass px-1.5 py-0.5 text-[9px] font-bold text-canvas">{unread}</span>
            )}
          </div>
          <p className="mt-0.5 truncate text-[11px] text-faint">{preview}</p>
        </div>
        <span className="shrink-0 text-[10.5px] tabular-nums text-faint">{thread.lastDate}</span>
      </button>
    </div>
  )
}

function DraftRow({ email, onOpen }: { email: ProjectEmail; onOpen: () => void }) {
  const preview = htmlPreview(email.body)
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-2.5 rounded-lg border border-dashed border-[#e0cfa6]/40 bg-[#e0a93a]/[0.06] px-3 py-2 text-left transition-colors hover:border-[#e0cfa6]/70"
    >
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0 text-[#e0b860]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
      </svg>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-[12.5px] text-parchment/90">{email.subject || '(no subject)'}</p>
          <span className="shrink-0 rounded-full border border-[#e0cfa6]/40 bg-[#e0a93a]/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-[#e0b860]">
            Draft
          </span>
        </div>
        <p className="mt-0.5 truncate text-[11px] text-faint">{preview || 'New email'}</p>
      </div>
    </button>
  )
}

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l2.7 5.5 6 .9-4.35 4.25 1 6L12 17.8 6.65 19.6l1-6L3.3 9.4l6-.9z" />
    </svg>
  )
}
