import type { CommsData, EmailMessage, EmailThread } from '../api'

// The project's conversations box on Details. A fixed-height box about five rows tall; with more
// threads you just scroll inside it. Clicking a thread opens the full-page reader; "Write email"
// composes a new one. Starred conversations are highlighted (and can be starred right here, which
// carries through to Gmail).
//
// DRAFTS ARE GMAIL DRAFTS (2026-11-10). A conversation with a reply waiting carries a "Draft" badge
// and opens with the draft in its reply box. A new email that has not been sent yet (a "thread" that
// holds nothing but a draft) is its own Draft row and opens in the composer. Either one may have been
// started here or in Gmail; they are the same draft.

const ME = 'michael@michaelbloemeke.com'

export function MiniComms({
  data,
  error,
  hiddenDraftIds,
  onOpen,
  onOpenDraft,
  onToggleStar,
  onWrite,
}: {
  data: CommsData | null
  error?: string | null
  // Drafts being discarded (inside their Undo window): already gone as far as this list is concerned.
  hiddenDraftIds?: Set<string>
  onOpen: (threadId: string) => void
  onOpenDraft?: (draftId: string) => void
  onToggleStar?: (threadId: string, starred: boolean) => void
  onWrite?: () => void
}) {
  // One feed, newest first. A thread that holds only drafts is a new email not yet sent.
  type Row = { kind: 'thread'; thread: EmailThread; ts: number } | { kind: 'draft'; thread: EmailThread; draft: EmailMessage; ts: number }
  const hidden = hiddenDraftIds ?? new Set<string>()
  const rows: Row[] = []
  for (const t of data?.threads ?? []) {
    const drafts = t.messages.filter((m) => m.isDraft && !(m.draftId && hidden.has(m.draftId)))
    const sent = t.messages.filter((m) => !m.isDraft)
    if (sent.length > 0) rows.push({ kind: 'thread', thread: { ...t, hasDraft: drafts.length > 0 }, ts: t.lastTs ?? 0 })
    else if (drafts.length > 0) rows.push({ kind: 'draft', thread: t, draft: drafts[drafts.length - 1], ts: drafts[drafts.length - 1].ts ?? 0 })
  }
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
                hasDraft={!!r.thread.hasDraft}
                onOpen={() => onOpen(r.thread.id)}
                onToggleStar={onToggleStar ? () => onToggleStar(r.thread.id, !r.thread.starred) : undefined}
              />
            ) : (
              <DraftRow
                key={r.thread.id}
                thread={r.thread}
                draft={r.draft}
                // Without a draft id (Gmail's draft list could not be read) it can still be read.
                onOpen={() => (r.draft.draftId ? onOpenDraft?.(r.draft.draftId) : onOpen(r.thread.id))}
              />
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
  // Preview the last message that was actually SENT. Quoting an unsent draft here would read as the
  // latest thing the client saw, which is exactly the confusion this row has to avoid.
  const sent = thread.messages.filter((m) => !m.isDraft)
  const last = sent[sent.length - 1]
  const lastWho = last ? (last.from === ME ? 'You' : last.fromName.split(' ')[0]) : ''
  const preview = last ? `${lastWho}: ${last.body.replace(/\s+/g, ' ').trim()}` : 'Nothing sent yet.'

  return (
    <div
      className={[
        'flex w-full items-center gap-1.5 rounded-lg border px-2 py-2 transition-colors',
        starred
          ? 'border-[#ca8a04]/55 bg-[#ca8a04]/10'
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
          className={['shrink-0 rounded p-0.5 transition-colors', starred ? 'text-[#ca8a04]' : 'text-faint hover:text-[#ca8a04]'].join(' ')}
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
              <span className="shrink-0 rounded-full border border-[#a9c2f6]/40 bg-[#ca8a04]/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-[#2563eb]">
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

function DraftRow({ thread, draft, onOpen }: { thread: EmailThread; draft: EmailMessage; onOpen: () => void }) {
  const preview = draft.body.replace(/\s+/g, ' ').trim()
  const to = (draft.to ?? []).join(', ')
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-2.5 rounded-lg border border-dashed border-[#a9c2f6]/40 bg-[#ca8a04]/[0.06] px-3 py-2 text-left transition-colors hover:border-[#a9c2f6]/70"
    >
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0 text-[#2563eb]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
      </svg>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-[12.5px] text-parchment/90">{thread.subject || '(no subject)'}</p>
          <span className="shrink-0 rounded-full border border-[#a9c2f6]/40 bg-[#ca8a04]/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-[#2563eb]">
            Draft
          </span>
        </div>
        <p className="mt-0.5 truncate text-[11px] text-faint">
          {to ? `To ${to}` : 'New email'}
          {preview ? ` · ${preview}` : ''}
        </p>
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
