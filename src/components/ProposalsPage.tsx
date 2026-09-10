import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { motion } from 'motion/react'
import {
  loadProposalsOverview,
  type BookingOverviewItem,
  type ProposalOverviewItem,
  type ProposalState,
  type ProposalsOverview,
} from '../api'
import { type PreviewTarget } from './PreviewPage'

// EVERYTHING MICHAEL HAS SENT, in one place.
//
// The per-project ProposalCard answers "what is the state of THIS client's proposal". It cannot
// answer "what have I sent, to whom, and did anyone read it", because reaching it at all means
// already knowing whose project to open. Past ten proposals that stopped working.
//
// THE THREE THINGS THIS PAGE IS FOR:
//
//   1. The samples at the top. The blank proposal and the blank booking form, attached to nobody,
//      so Michael can see what a client actually receives and say "change that" without hunting
//      for a real client's page to read it off.
//   2. Live clients, with the read counts. A proposal opened seven times is a different
//      conversation from one that has never been opened, and that is the whole reason the counter
//      exists.
//   3. The past, below a divider. Every proposal he has ever sent, labelled booked or fell
//      through, and whether the page is still up.
//
// ⚠️ NOTHING ON THIS PAGE COUNTS AS A VIEW. Every link opens through `openUrl`, which the server
// builds with the preview flag already on it (plus Michael's preview key when the page is no longer
// public). The clean link, the one he sends, is `url` and is what Copy puts on the clipboard. If you
// ever add a link here, use `openUrl`, or his own reading starts polluting the only number that
// matters.

// ---------------------------------------------------------------------------

function fmtStamp(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function fmtDay(iso?: string): string {
  if (!iso) return ''
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T12:00:00` : iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function fmtFee(fee: number | string | null): string {
  if (fee == null || fee === '') return ''
  const n = typeof fee === 'number' ? fee : Number(fee)
  if (!Number.isFinite(n)) return ''
  return `$${n.toLocaleString('en-US')}`
}

// The four states, and the one word each of them earns. `expired` and `down` both mean the page is
// dark, and they are kept apart because looking back at a lost deal they mean different things:
// one lapsed on its own, the other was a decision.
const STATE_LABEL: Record<ProposalState, string> = {
  draft: 'Draft',
  live: 'Live',
  expired: 'Expired',
  down: 'Down',
}

function stateStyle(state: ProposalState): { color: string; backgroundColor: string } {
  const token =
    state === 'live'
      ? 'var(--color-umb-booked)'
      : state === 'draft'
        ? 'var(--color-brass)'
        : 'var(--color-muted)'
  return { color: token, backgroundColor: `color-mix(in oklab, ${token} 16%, transparent)` }
}

function Pill({ text, style }: { text: string; style?: CSSProperties }) {
  return (
    <span
      className="shrink-0 rounded-full px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.1em]"
      style={style ?? { color: 'var(--color-muted)', backgroundColor: 'color-mix(in oklab, var(--color-line) 40%, transparent)' }}
    >
      {text}
    </span>
  )
}

// The link, an Open preview button, and Copy.
//
// It used to be an anchor with target="_blank", which is exactly what Michael asked to be rid of:
// "I don't like that it's a new window." The preview now takes over the CRM screen instead.
//
// Copy still hands over the CLEAN url, never the flagged one, so what he pastes into an email is
// never marked as a preview.
function LinkRow({
  url,
  openUrl,
  onOpen,
}: {
  url: string
  openUrl: string
  onOpen?: () => void
}) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    })
  }
  return (
    <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2/40 px-3 py-1.5">
      <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted" title={url}>
        {url.replace(/^https:\/\//, '')}
      </span>
      {openUrl && onOpen && (
        <button
          type="button"
          onClick={onOpen}
          className="shrink-0 rounded-md border border-brass-dim/60 bg-surface-3 px-2.5 py-1 text-[11.5px] font-semibold text-brass-bright transition-colors hover:border-brass"
          title="Opens inside the CRM. Not counted as a view."
        >
          Open preview
        </button>
      )}
      <button
        type="button"
        onClick={copy}
        className="shrink-0 text-[11px] text-faint transition-colors hover:text-parchment"
        title="Copies the clean link, without the preview flag. This is the one to send."
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------

// A plain function that RETURNS elements rather than a component declared in the page body. A
// component defined inside another is a new type on every render, so React rebuilds the subtree and
// every child's local state dies with it. It has cost this codebase two bugs already.
function proposalRow(
  item: ProposalOverviewItem,
  booking: BookingOverviewItem | undefined,
  past: boolean,
  open: (t: PreviewTarget) => void,
) {
  const opened = item.views > 0
  const dead = item.state !== 'live'
  const fee = fmtFee(item.totalFee)
  const day = fmtDay(item.eventDate)

  return (
    <div
      key={item.projectId}
      className="rounded-xl border border-line bg-surface px-4 py-3 shadow-[0_24px_50px_-24px_rgba(4,8,24,0.75),0_6px_16px_-8px_rgba(4,8,24,0.45)] transition-colors hover:border-line-strong"
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <p className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-parchment">{item.projectName}</p>
        <Pill text={STATE_LABEL[item.state]} style={stateStyle(item.state)} />
        {past && (
          <Pill
            text={item.outcomeLabel}
            style={
              item.outcome === 'booked'
                ? { color: 'var(--color-umb-booked)', backgroundColor: 'color-mix(in oklab, var(--color-umb-booked) 16%, transparent)' }
                : undefined
            }
          />
        )}
      </div>

      {/* The facts, one line, in the order he reads them. */}
      <p className="mt-1 text-[11.5px] text-muted">
        {[item.eventType, day, fee].filter(Boolean).join(' · ') || 'No event details yet'}
        {item.outcomeNote ? <span className="text-faint"> · {item.outcomeNote}</span> : null}
      </p>

      <div className="mt-2.5 space-y-2">
        {/* THE PROPOSAL */}
        <div>
          <div className="mb-1 flex items-baseline gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">Proposal</span>
            <span className="text-[11.5px] text-muted">
              {item.state === 'draft'
                ? 'Never published.'
                : opened
                  ? `Opened ${item.views}×, first ${fmtStamp(item.firstViewedAt)}, last ${fmtStamp(item.lastViewedAt)}`
                  : 'Never opened.'}
            </span>
          </div>
          <LinkRow
            url={item.url}
            openUrl={item.openUrl}
            onOpen={() =>
              open({
                src: item.openUrl,
                publicUrl: item.url,
                title: item.projectName,
                subtitle: dead ? `Proposal · ${item.stateReason}` : 'Proposal · live',
                backLabel: 'Proposals',
              })
            }
          />
          {/* Only for a page that WAS up and is not any more. A draft's status line already says
              "Never published", and saying it twice reads as a bug. */}
          {(item.state === 'expired' || item.state === 'down') && (
            <p className="mt-1 text-[11px] text-faint">{item.stateReason}</p>
          )}
        </div>

        {/* THE BOOKING FORM, only when one was actually issued. Most proposals never get this far,
            and an empty row for every one of them would bury the ones that did. */}
        {booking && (
          <div>
            <div className="mb-1 flex items-baseline gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">Booking form</span>
              <span className="text-[11.5px] text-muted">
                {!booking.sentAt
                  ? 'Issued but never sent.'
                  : booking.views > 0
                    ? `Opened ${booking.views}×, first ${fmtStamp(booking.firstViewedAt)}, last ${fmtStamp(booking.lastViewedAt)}`
                    : `Sent ${fmtStamp(booking.sentAt)}. Never opened.`}
              </span>
            </div>
            <LinkRow
              url={booking.openUrl.replace(/&preview=1$/, '')}
              openUrl={booking.openUrl}
              onOpen={() =>
                open({
                  src: booking.openUrl,
                  publicUrl: booking.openUrl.replace(/&preview=1$/, ''),
                  title: booking.projectName,
                  subtitle: 'Booking form',
                  backLabel: 'Proposals',
                })
              }
            />
          </div>
        )}
      </div>
    </div>
  )
}

// A booking form on a project that has no proposal at all. It happens: a repeat client books
// straight off a phone call. Leaving them off would make this page a liar about what has gone out.
function bookingOnlyRow(booking: BookingOverviewItem, past: boolean, open: (t: PreviewTarget) => void) {
  const day = fmtDay(booking.eventDate)
  const fee = fmtFee(booking.totalFee)
  return (
    <div key={booking.projectId} className="rounded-xl border border-line bg-surface px-4 py-3 shadow-[0_24px_50px_-24px_rgba(4,8,24,0.75),0_6px_16px_-8px_rgba(4,8,24,0.45)]">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <p className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-parchment">{booking.projectName}</p>
        <Pill text="Booking form only" />
        {past && (
          <Pill
            text={booking.outcomeLabel}
            style={
              booking.outcome === 'booked'
                ? { color: 'var(--color-umb-booked)', backgroundColor: 'color-mix(in oklab, var(--color-umb-booked) 16%, transparent)' }
                : undefined
            }
          />
        )}
      </div>
      <p className="mt-1 text-[11.5px] text-muted">
        {[booking.eventType, day, fee].filter(Boolean).join(' \u00b7 ') || 'No event details yet'}
      </p>
      <p className="mt-1 text-[11.5px] text-muted">
        {!booking.sentAt
          ? 'Issued but never sent.'
          : booking.views > 0
            ? `Opened ${booking.views}×, first ${fmtStamp(booking.firstViewedAt)}, last ${fmtStamp(booking.lastViewedAt)}`
            : `Sent ${fmtStamp(booking.sentAt)}. Never opened.`}
      </p>
      <div className="mt-2">
        <LinkRow
          url={booking.openUrl.replace(/&preview=1$/, '')}
          openUrl={booking.openUrl}
          onOpen={() =>
            open({
          src: booking.openUrl,
          publicUrl: booking.openUrl.replace(/&preview=1$/, ''),
          title: booking.projectName,
          subtitle: 'Booking form',
          backLabel: 'Proposals',
            })
          }
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

export function ProposalsPage({ onPreview }: { onPreview: (t: PreviewTarget) => void }) {
  const [data, setData] = useState<ProposalsOverview | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    loadProposalsOverview()
      .then((d) => {
        setData(d)
        setError(null)
      })
      .catch((e) => setError(String(e instanceof Error ? e.message : e)))
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const { active, pastRows, bookingOnly, bookingOnlyPast } = useMemo(() => {
    const items = data?.items ?? []

    // The split is the BUCKET, not the date. A proposal for an event two years out is live work; a
    // completed or archived project is history whatever its event date says.
    const isPast = (i: ProposalOverviewItem) => i.bucket !== 'active'

    // Soonest event first up top, because that is the order he has to act in. Most recently sent
    // first below, because that is the order he remembers them in.
    const activeList = items.filter((i) => !isPast(i)).sort((a, b) => (a.eventDate || '9999').localeCompare(b.eventDate || '9999'))
    const pastList = items.filter(isPast).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))

    // A booking form on a project with no proposal at all. It happens: a repeat client books
    // straight off a phone call. Leaving them off would make this page a liar about what has gone
    // out. They get split into the same two sections, on the same rule.
    const withProposal = new Set(items.map((i) => i.projectId))
    const orphans = (data?.bookings ?? []).filter((b) => !withProposal.has(b.projectId))
    const orphansActive = orphans.filter((b) => b.bucket === 'active')
    const orphansPast = orphans.filter((b) => b.bucket !== 'active')

    return { active: activeList, pastRows: pastList, bookingOnly: orphansActive, bookingOnlyPast: orphansPast }
  }, [data])

  const byProject = useMemo(() => new Map((data?.bookings ?? []).map((b) => [b.projectId, b])), [data])

  const sampleBtn =
    'rounded-lg border border-brass-dim/60 bg-surface-3 px-3.5 py-2 text-[12.5px] font-semibold text-brass-bright transition-colors hover:border-brass disabled:cursor-not-allowed disabled:opacity-40'

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.35 }}
      // THE DAMASK. Michael asked for it here, 2026-09-09, and this is the ONLY page in the CRM
      // that carries it. Same ornament as the website, rebuilt as DARK ink because the site's copy
      // is white for a royal-blue surface and would be invisible on the CRM's #eef0f3 canvas.
      //
      // The site's own rule applies: ornament goes where it carries meaning, never everywhere. This
      // page is the one showing what a client actually receives, so it is the one page in the app
      // that gets to look like the brand rather than like a tool. `fixed` keeps the pattern still
      // while the rows scroll over it, so it reads as a wall the cards sit on rather than wallpaper
      // glued to the list.
      className="board-scroll h-full overflow-y-auto px-8 pb-12"
    >
      <div className="mx-auto max-w-3xl">
      {/* THE SAMPLES. Deliberately first: this is the answer to "what does the thing I am sending
          actually look like", which is a question about the template, not about any client. */}
      <div className="rounded-xl border border-line bg-surface px-4 py-4 shadow-[0_24px_50px_-24px_rgba(4,8,24,0.75),0_6px_16px_-8px_rgba(4,8,24,0.45)]">
        <p className="text-[13px] font-semibold text-parchment">What the client sees</p>
        <p className="mt-1 text-[12px] leading-relaxed text-muted">
          The proposal template is the master copy: every new proposal starts from it, and only the
          parts in [brackets] get changed. Both are attached to nobody, nothing you do in them is
          saved, and no client's numbers move.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {/* Buttons, not links, for the same reason every other preview here is: they open as a
              screen in the CRM rather than a new browser window. The samples are ?demo=1, which is
              attached to no client and writes nothing, so there is nothing to count either way. */}
          <button
            type="button"
            className={sampleBtn}
            disabled={!data}
            onClick={() =>
              data &&
              onPreview({
                src: data.samples.proposal,
                publicUrl: data.samples.proposal,
                title: 'Proposal template',
                subtitle: 'The master copy. Every new proposal starts from this.',
                backLabel: 'Proposals',
              })
            }
          >
            Proposal template
          </button>
          <button
            type="button"
            className={sampleBtn}
            disabled={!data}
            onClick={() =>
              data &&
              onPreview({
                src: data.samples.booking,
                publicUrl: data.samples.booking,
                title: 'Sample booking form',
                subtitle: 'The blank template. Nothing you type is saved.',
                backLabel: 'Proposals',
              })
            }
          >
            Sample booking form
          </button>
        </div>
      </div>

      {error && (
        <div className="mt-6 rounded-xl border border-rose-500/40 bg-rose-500/[0.06] px-4 py-3">
          <p className="text-[13px] font-semibold text-rose-300">Couldn't load the proposals</p>
          <p className="mt-1 text-[12.5px] text-muted">{error}</p>
          <button
            type="button"
            onClick={refresh}
            className="mt-2.5 rounded-lg border border-line-strong bg-surface-2 px-3 py-1.5 text-[12px] font-medium text-parchment transition-colors hover:border-brass hover:text-brass"
          >
            Try again
          </button>
        </div>
      )}

      {data == null && !error && (
        <div className="mt-6 space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-28 animate-pulse rounded-xl border border-line bg-surface/40" />
          ))}
        </div>
      )}

      {data && (
        <>
          {/* ACTIVE */}
          <div className="mt-8 flex items-baseline gap-2.5">
            <h2 className="text-[15px] font-semibold text-parchment">Out right now</h2>
            <span className="text-[12px] text-faint">
              {active.length + bookingOnly.length} {active.length + bookingOnly.length === 1 ? 'client' : 'clients'}
            </span>
          </div>
          <p className="mt-1 text-[12px] text-muted">Everyone still in the pipeline, soonest event first.</p>

          <div className="mt-3 space-y-2.5">
            {active.length === 0 && bookingOnly.length === 0 && (
              <p className="rounded-xl border border-dashed border-line-strong px-4 py-6 text-center text-[12.5px] text-muted">
                Nothing out at the moment.
              </p>
            )}
            {active.map((i) => proposalRow(i, byProject.get(i.projectId), false, onPreview))}
            {bookingOnly.map((b) => bookingOnlyRow(b, false, onPreview))}
          </div>

          {/* PAST */}
          <div className="mt-10 border-t border-line pt-8">
            <div className="flex items-baseline gap-2.5">
              <h2 className="text-[15px] font-semibold text-parchment">Everything before</h2>
              <span className="text-[12px] text-faint">
                {pastRows.length + bookingOnlyPast.length} {pastRows.length + bookingOnlyPast.length === 1 ? 'client' : 'clients'}
              </span>
            </div>
            <p className="mt-1 text-[12px] text-muted">
              Completed and archived, newest first. A page marked Down or Expired is no longer on the
              internet; the link here still opens your own copy and is never counted.
            </p>

            <div className="mt-3 space-y-2.5">
              {pastRows.length === 0 && bookingOnlyPast.length === 0 && (
                <p className="rounded-xl border border-dashed border-line-strong px-4 py-6 text-center text-[12.5px] text-muted">
                  Nothing here yet.
                </p>
              )}
              {pastRows.map((i) => proposalRow(i, byProject.get(i.projectId), true, onPreview))}
              {bookingOnlyPast.map((b) => bookingOnlyRow(b, true, onPreview))}
            </div>
          </div>
        </>
      )}
      </div>
    </motion.div>
  )
}
