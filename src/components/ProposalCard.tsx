import { useEffect, useState } from 'react'
import { type Project } from '../pipeline'
import {
  loadProposalStatus,
  createProposal,
  publishProposal,
  draftProposalEmail,
  retireProposal,
  type ProposalStatus,
} from '../api'

// THE PROPOSAL, the step before the booking sequence.
//
// After a sales call Michael used to send a wall of text plus a 10.6 MB PDF deck. It bounced off
// corporate mail servers, named exactly one price so every proposal read as yes-or-no, forwarded
// badly to the spouse or boss who actually decides, and gave back no signal at all about whether it
// had been opened. This replaces it with one per-client page and a three-sentence email.
//
// SAME DESIGN RULE AS BookingCard, for the same reason. One control, showing whatever the next thing
// to actually do is, plus a status line that moves on its own. No "check if they opened it" button:
// the server already knows, so the card just says. The one exception is Retire, which is deliberately
// tucked away as small text, because it is rare and archiving the project does it automatically.
//
// NOTHING HERE SENDS. Publishing makes the page live and leaves the email as a Gmail DRAFT for
// Michael to read and send himself. That is the standing rule for every client-facing message.

function fmtStamp(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function ProposalCard({ project }: { project: Project }) {
  const [p, setP] = useState<ProposalStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const refresh = () => {
    loadProposalStatus(project.id).then(setP).catch(() => setP(null))
  }
  // Poll while the project is open, so "opened 3 times" appears without Michael doing anything. Two
  // small reads; the same trick BookingCard uses for its progress bar.
  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 30_000)
    return () => clearInterval(t)
  }, [project.id])

  const run = async (fn: () => Promise<unknown>, done: (r: never) => string) => {
    setBusy(true)
    setNote(null)
    try {
      const r = await fn()
      setNote(done(r as never))
      refresh()
    } catch (e) {
      setNote(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(false)
    }
  }

  const live = p?.status === 'live'
  const draft = p?.status === 'draft'
  const retired = p?.status === 'retired'
  const gaps = p?.gaps ?? []
  const opened = (p?.views ?? 0) > 0

  const primary =
    'rounded-lg border border-brass-dim/60 bg-surface-3 px-3 py-1.5 text-[12.5px] font-semibold text-brass-bright transition-colors hover:border-brass disabled:cursor-not-allowed disabled:opacity-40'

  const copy = () => {
    if (!p?.url) return
    navigator.clipboard.writeText(p.url).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    })
  }

  return (
    <div className="rounded-xl border border-line-strong bg-surface-3/60 px-4 py-3 shadow-[0_2px_8px_-3px_rgba(0,0,0,0.10)]">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] font-medium text-parchment">Proposal</p>
        {/* The single fact this card exists to surface. A proposal that has been opened is a
            different conversation from one that has not, and it is worth seeing at a glance. */}
        {live && (
          <span
            className="rounded-full px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.1em]"
            style={
              opened
                ? { color: 'var(--color-umb-booked)', backgroundColor: 'color-mix(in oklab, var(--color-umb-booked) 16%, transparent)' }
                : { color: 'var(--color-muted)', backgroundColor: 'color-mix(in oklab, var(--color-line) 40%, transparent)' }
            }
          >
            {opened ? `Opened ${p?.views}×` : 'Not opened yet'}
          </span>
        )}
        {retired && (
          <span className="rounded-full border border-line px-1.5 py-0.5 text-[9.5px] font-medium text-muted">Retired</span>
        )}
      </div>

      {/* The link. Front and centre once it exists, because the reason to open this card weeks later
          is almost always to find it again. */}
      {p?.url && !retired && (
        <div className="mt-2.5 flex items-center gap-2 rounded-lg border border-line bg-surface-2/40 px-3 py-2">
          {/* Opening it from here adds ?preview=1, which renders the same page but does NOT count
              as a view. Copy hands over the clean URL, so what Michael sends is never flagged.
              Without this his own checking would swamp the one number the card exists to report. */}
          <a
            href={`${p.url}&preview=1`}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 flex-1 truncate text-[11.5px] text-brass-bright underline-offset-2 hover:underline"
            title={`${p.url}\n\nOpens in preview mode, which is not counted as a view.`}
          >
            {p.url.replace(/^https:\/\//, '')}
          </a>
          <button type="button" onClick={copy} className="shrink-0 text-[11px] text-faint transition-colors hover:text-parchment">
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}

      {/* What is still missing, in the words the publish gate uses. A proposal that goes out
          half-built is worse than one that goes out an hour later. */}
      {draft && gaps.length > 0 && (
        <div className="mt-2.5 rounded-lg border border-rose-500/40 bg-rose-500/[0.06] px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-rose-300">Still needs</p>
          <ul className="mt-1 space-y-0.5">
            {gaps.map((g) => (
              <li key={g} className="text-[11.5px] leading-relaxed text-parchment">
                {g}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[11px] leading-relaxed text-faint">
            Ask Claude to write it, or edit the proposal directly. There is no editor in here yet.
          </p>
        </div>
      )}

      <p className="mt-2 text-[11.5px] leading-relaxed text-faint">
        {p == null
          ? 'Loading…'
          : !p.exists
            ? 'No proposal yet. Starting one seeds the photos and reviews from the event type; the write-up and the packages still get written per client.'
            : retired
              ? 'The page is down. Anyone with the link now sees a friendly "this proposal has expired" message rather than a 404.'
              : draft
                ? 'The link is issued but dead until you publish. Nobody can reach it yet.'
                : opened
                  ? `First opened ${fmtStamp(p.firstViewedAt)}, last ${fmtStamp(p.lastViewedAt)}. Every view counts, including whoever they forwarded it to.`
                  : p.emailDraftedAt
                    ? 'Live, and the email is waiting in Gmail. Nobody has opened the page yet.'
                    : 'Live. Nothing has opened it yet.'}
      </p>

      {note && <p className="mt-1.5 text-[11.5px] leading-relaxed text-brass-bright">{note}</p>}

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {!p?.exists && (
          <button
            type="button"
            className={primary}
            disabled={busy || p == null}
            onClick={() => run(() => createProposal(project.id), () => 'Draft started. Fill in the write-up and the packages, then publish.')}
          >
            {busy ? 'Working…' : 'Start a proposal'}
          </button>
        )}

        {draft && (
          <button
            type="button"
            className={primary}
            disabled={busy || gaps.length > 0}
            title={gaps.length ? `Still needs: ${gaps.join(', ')}` : undefined}
            onClick={() =>
              run(
                () => publishProposal(project.id),
                (r: { draft?: { to: string } | null; draftError?: string }) =>
                  r.draftError
                    ? `Page is live, but the email draft failed: ${r.draftError}`
                    : `Live, and a draft is waiting in Gmail for ${r.draft?.to}. Read it before you send.`,
              )
            }
          >
            {busy ? 'Publishing…' : 'Publish and draft the email'}
          </button>
        )}

        {/* Once live, the only thing left is the email, and only if one is not already sitting in
            Gmail. Offering it twice is how Michael ends up with three copies of the same draft. */}
        {live && !p?.emailDraftedAt && (
          <button
            type="button"
            className={primary}
            disabled={busy}
            onClick={() =>
              run(
                () => draftProposalEmail(project.id),
                (r: { draft?: { to: string } }) => `Draft ready in Gmail for ${r.draft?.to}. Nothing has been sent.`,
              )
            }
          >
            {busy ? 'Drafting…' : 'Draft the email'}
          </button>
        )}

        {live && p?.emailDraftedAt && (
          <span className="text-[11px] text-faint">Email drafted {fmtStamp(p.emailDraftedAt)}. Send it from Gmail.</span>
        )}

        {/* Rare, and deliberately not a button. Archiving or deleting the project takes the page
            down on its own, so this is only for "I published the wrong thing". */}
        {live && (
          <button
            type="button"
            className="ml-auto text-[11px] text-faint transition-colors hover:text-rose-300 disabled:opacity-40"
            disabled={busy}
            onClick={() => {
              if (!window.confirm('Take the proposal page down? Anyone with the link will see an "expired" message.')) return
              run(() => retireProposal(project.id), () => 'Page retired.')
            }}
          >
            Take it down
          </button>
        )}
      </div>
    </div>
  )
}
