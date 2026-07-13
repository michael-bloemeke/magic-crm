import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { motion } from 'motion/react'
import { loadAnalytics, type Analytics } from '../api'

// Website Analytics — two tabs:
//   LIVE FEED (default): real-time + recent visitor/conversion data pulled from GA4 +
//     Search Console. Until the Google API is connected (a one-time service-account
//     setup, see website CLAUDE.md), each panel shows a clearly-labeled "awaiting
//     connection" state. Once a Supabase Edge Function (like the `inquiry` one) is
//     deployed with GA4 Data API + Search Console access, these panels fill with live data.
//   GUIDE: a cheat-sheet of where to check each dashboard yourself.

type Tab = 'live' | 'guide'

export function WebsiteAnalyticsPage() {
  const [tab, setTab] = useState<Tab>('live')
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.35 }}
      className="board-scroll h-full overflow-y-auto px-8 pb-12"
    >
      {/* Tabs */}
      <div className="mb-6 flex w-fit items-center gap-1 rounded-xl border border-line bg-surface/60 p-1">
        {(
          [
            ['live', 'Live Feed'],
            ['guide', 'Guide'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={[
              'rounded-lg px-3.5 py-1.5 text-[13px] font-medium transition-colors',
              tab === id ? 'bg-surface-3 text-parchment' : 'text-muted hover:text-parchment',
            ].join(' ')}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'live' ? <LiveFeedView /> : <GuideView />}
    </motion.div>
  )
}

/* ------------------------------------------------------------------ */
/* LIVE FEED                                                          */
/* ------------------------------------------------------------------ */

// Each panel describes what live data it will hold once GA4/Search Console is wired.
type Panel = {
  title: string
  tag: string
  // What this panel will show once connected (kept for the "awaiting data" preview).
  shows: string[]
  wide?: boolean
}

const PANELS: Panel[] = [
  {
    title: 'Right now',
    tag: 'Real-time (last 30 min)',
    shows: [
      'How many people are on your site this minute',
      'The city each active visitor is in',
      'The exact page they are viewing',
      'Where they came from (Google, Instagram, direct, etc.)',
    ],
  },
  {
    title: 'Visitors',
    tag: 'Last 7 / 28 days',
    shows: [
      'Total visitors and sessions, with the trend',
      'New vs returning',
      'Average time on site and engagement',
      'Busiest days and hours',
    ],
  },
  {
    title: 'Where they came from',
    tag: 'Traffic sources',
    shows: [
      'Channel split: Organic Search, Direct, Social, Referral, Paid',
      'Top specific sources (google, instagram, bark, thebash, gigsalad)',
      'How many came from your Google Ads',
      'AI referrals (ChatGPT, Perplexity) as they grow',
    ],
  },
  {
    title: 'Where they are',
    tag: 'Location',
    shows: [
      'Country, state, and city of every visitor',
      'How much traffic is actually local (Triangle vs elsewhere)',
      'A map view of visitor concentration',
    ],
  },
  {
    title: 'Devices',
    tag: 'How they browse',
    shows: [
      'Mobile vs desktop vs tablet',
      'Browser and operating system',
      'Screen size (helps catch layout issues)',
    ],
  },
  {
    title: 'Top pages',
    tag: 'What they read',
    shows: [
      'Your most-visited pages, ranked',
      'Average time spent on each',
      'Where people enter (landing pages) and drop off',
    ],
  },
  {
    title: 'Conversions & leads',
    tag: 'Who actually reached out',
    wide: true,
    shows: [
      'Contact-form submissions (your leads) and the conversion rate',
      'Which source and page produced each lead',
      'A running count against your traffic, so you see what percent of visitors book',
      'The lead details (name, email, event) land in your CRM Inbox the moment they submit',
    ],
  },
]

function LiveFeedView() {
  const [data, setData] = useState<Analytics | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const d = await loadAnalytics()
      setData(d)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  // Poll once on mount, then every minute while the page is open (realtime is "last 30 min").
  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 60_000)
    return () => clearInterval(t)
  }, [refresh])

  if (loading && !data) return <FeedLoading />
  if (error && !data) return <FeedError message={error} onRetry={refresh} />
  if (!data || !data.connected) return <NotConnected />
  return <RealFeed data={data} />
}

/* ---- states ---- */

function FeedLoading() {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="h-44 animate-pulse rounded-2xl border border-line bg-surface/40" />
      ))}
    </div>
  )
}

function FeedError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="max-w-2xl rounded-xl border border-line bg-surface/50 px-4 py-4">
      <p className="mb-1 text-[13px] font-semibold text-parchment">Couldn't load the live feed</p>
      <p className="mb-3 text-[12.5px] text-muted">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-lg border border-line-strong bg-surface-2 px-3 py-1.5 text-[12px] font-medium text-parchment transition-colors hover:border-brass hover:text-brass"
      >
        Try again
      </button>
    </div>
  )
}

function NotConnected() {
  return (
    <div>
      {/* Not-connected banner */}
      <div className="mb-6 max-w-3xl rounded-xl border border-brass/40 bg-brass/5 px-4 py-3.5">
        <div className="mb-1 flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-brass shadow-[0_0_8px_var(--color-brass)]" />
          <p className="text-[13px] font-semibold text-brass">Live data not connected yet</p>
        </div>
        <p className="text-[12.5px] leading-relaxed text-muted">
          The backend is built and running. One last step turns it on: adding your Google service-account
          key as a secret named GOOGLE_SA_KEY. It takes about two minutes, and only you can do it (the key is
          private, so Claude never handles it). Ask Claude to walk you through it, and every panel below fills
          in on its own and refreshes each minute.
        </p>
      </div>

      {/* Panel grid (preview of the live layout) */}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {PANELS.map((p) => (
          <LivePanel key={p.title} panel={p} />
        ))}
      </div>
    </div>
  )
}

/* ---- the real, connected dashboard ---- */

function RealFeed({ data }: { data: Analytics }) {
  const rt = data.realtime
  const v = data.visitors
  const s = data.sources
  const loc = data.locations
  const dev = data.devices
  const pages = data.pages
  const ads = data.ads
  const search = data.search
  const conv = data.conversions
  const partial = !!data.errors?.length

  return (
    <div>
      {/* Header strip */}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <span className="inline-flex items-center gap-2 rounded-full border border-brass/40 bg-brass/5 px-3 py-1 text-[12px] font-semibold text-brass">
          <span className="h-2 w-2 rounded-full bg-brass shadow-[0_0_8px_var(--color-brass)]" />
          Live
        </span>
        <span className="text-[12px] text-faint">
          Updated {fmtTime(data.generatedAt)} · refreshes every minute
        </span>
        {partial ? (
          <span className="text-[12px] text-muted">Some panels are refilling on the next refresh.</span>
        ) : null}
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {/* Right now */}
        <Card tag="Real-time (last 30 min)" title="Right now">
          {rt ? (
            <>
              <div className="mb-4 flex items-end gap-2">
                <span className="font-display text-[40px] leading-none text-parchment tabular-nums">{fmt(rt.activeUsers)}</span>
                <span className="mb-1 text-[12px] text-muted">
                  {rt.activeUsers === 1 ? 'person on your site' : 'people on your site'}
                </span>
              </div>
              {rt.activeUsers === 0 ? (
                <p className="text-[12.5px] text-faint">
                  No one is on the site this minute. This lights up in real time when they arrive.
                </p>
              ) : (
                <div className="flex flex-col gap-3">
                  <MiniList title="Cities" rows={rt.byCity.map((c) => [c.city, fmt(c.users)])} />
                  <MiniList title="On this page" rows={rt.byPage.map((p) => [p.page, fmt(p.users)])} />
                </div>
              )}
            </>
          ) : (
            <Unavailable />
          )}
        </Card>

        {/* Visitors */}
        <Card tag="Last 7 / 28 days" title="Visitors">
          {v ? (
            <>
              <div className="mb-2 grid grid-cols-2 gap-2">
                <Stat label="Visitors (7d)" value={fmt(v.last7.users)} sub={`${fmt(v.last7.sessions)} sessions`} />
                <Stat label="Visitors (28d)" value={fmt(v.last28.users)} sub={`${fmt(v.last28.sessions)} sessions`} />
              </div>
              <div className="mb-3 grid grid-cols-2 gap-2">
                <Stat label="New (28d)" value={pctOf(v.last28.newUsers, v.last28.users)} />
                <Stat label="Avg time" value={fmtDuration(v.last28.avgSessionDuration)} />
              </div>
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">28-day trend</p>
              <Sparkline points={v.trend.map((t) => t.users)} />
            </>
          ) : (
            <Unavailable />
          )}
        </Card>

        {/* Where they came from */}
        <Card tag="Traffic sources" title="Where they came from">
          {s ? (
            <div className="flex flex-col gap-4">
              <Section label="Channels">
                <Bars items={s.channels.map((c) => ({ label: c.channel, value: c.sessions }))} />
              </Section>
              <Section label="Top sources">
                <Bars items={s.top.map((c) => ({ label: c.source, value: c.sessions }))} />
              </Section>
            </div>
          ) : (
            <Unavailable />
          )}
        </Card>

        {/* Where they are */}
        <Card tag="Location" title="Where they are">
          {loc ? (
            <div className="flex flex-col gap-4">
              <Section label="Countries">
                <Bars items={loc.countries.slice(0, 6).map((c) => ({ label: c.country, value: c.users }))} />
              </Section>
              <Section label="Top cities">
                <MiniList rows={loc.cities.slice(0, 8).map((c) => [cityLabel(c), fmt(c.users)])} />
              </Section>
            </div>
          ) : (
            <Unavailable />
          )}
        </Card>

        {/* Devices */}
        <Card tag="How they browse" title="Devices">
          {dev ? (
            <div className="flex flex-col gap-4">
              <Section label="Type">
                <Bars items={dev.categories.map((d) => ({ label: d.device, value: d.users }))} />
              </Section>
              <Section label="Browser">
                <MiniList rows={dev.browsers.slice(0, 5).map((b) => [b.browser, fmt(b.users)])} />
              </Section>
              <Section label="Operating system">
                <MiniList rows={dev.os.slice(0, 5).map((o) => [o.os, fmt(o.users)])} />
              </Section>
            </div>
          ) : (
            <Unavailable />
          )}
        </Card>

        {/* Top pages */}
        <Card tag="What they read" title="Top pages">
          {pages ? (
            pages.length ? (
              <ol className="flex flex-col gap-1.5">
                {pages.map((p, i) => (
                  <li key={p.path + i} className="flex items-baseline justify-between gap-3 text-[12.5px]">
                    <span className="truncate text-parchment">
                      <span className="mr-1.5 text-faint tabular-nums">{i + 1}</span>
                      {p.path}
                    </span>
                    <span className="shrink-0 tabular-nums text-muted">
                      {fmt(p.views)} views · {fmtDuration(p.avgTime)}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-[12px] text-faint">No page data for this window yet.</p>
            )
          ) : (
            <Unavailable />
          )}
        </Card>

        {/* Google Ads */}
        <Card tag="Your paid campaign" title="Ad spend">
          {ads ? (
            ads.linked ? (
              <>
                <div className="mb-2 grid grid-cols-2 gap-2">
                  <Stat label="Spent (28d)" value={fmtMoney(ads.last28.cost)} sub={`${fmt(ads.last28.clicks)} clicks`} />
                  <Stat label="Cost per click" value={ads.last28.clicks ? fmtMoney(ads.last28.cost / ads.last28.clicks) : '-'} />
                </div>
                <div className="mb-3 grid grid-cols-2 gap-2">
                  <Stat label="Spent (7d)" value={fmtMoney(ads.last7.cost)} />
                  <Stat label="Impressions (28d)" value={fmt(ads.last28.impressions)} />
                </div>
                {ads.campaigns.length ? (
                  <Section label="Campaigns">
                    <MiniList rows={ads.campaigns.map((c) => [c.name, fmtMoney(c.cost)])} />
                  </Section>
                ) : null}
              </>
            ) : (
              <div className="flex flex-1 flex-col justify-center rounded-lg border border-dashed border-line px-3 py-4 text-[12.5px] leading-relaxed text-muted">
                Your Google Ads account isn't linked to Analytics yet, so spend can't show here. It's a one-time
                link. Ask Claude to walk you through it, then this panel fills with what you spend, your cost per
                click, and cost per lead.
              </div>
            )
          ) : (
            <Unavailable />
          )}
        </Card>

        {/* Conversions & leads */}
        <Card tag="Who actually reached out" title="Conversions & leads" wide>
          {conv ? (
            <div className="grid gap-3 sm:grid-cols-3">
              <Stat label="Leads (7d)" value={fmt(conv.leads7)} />
              <Stat label="Leads (28d)" value={fmt(conv.leads28)} />
              <Stat label="Conversion rate (28d)" value={pct(conv.rate28)} sub="leads / visitors" />
            </div>
          ) : (
            <Unavailable />
          )}
          <p className="mt-3 text-[12px] text-muted">
            Every submission's details (name, email, event) land in your CRM Inbox the moment it comes in.
          </p>
        </Card>

        {/* Top search keywords */}
        <Card
          tag={search ? `Google Search · ${search.startDate} to ${search.endDate}` : 'Google Search'}
          title="Top search keywords"
          wide
          note="Search Console data runs about 2-3 days behind. That's a Google limit, not a bug."
        >
          {search ? (
            search.queries.length ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-[12.5px]">
                  <thead>
                    <tr className="border-b border-line text-left text-[11px] uppercase tracking-[0.12em] text-faint">
                      <th className="py-1.5 pr-3 font-semibold">Keyword</th>
                      <th className="py-1.5 px-3 text-right font-semibold">Clicks</th>
                      <th className="py-1.5 px-3 text-right font-semibold">Impressions</th>
                      <th className="py-1.5 px-3 text-right font-semibold">CTR</th>
                      <th className="py-1.5 pl-3 text-right font-semibold">Avg position</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line/60">
                    {search.queries.map((q) => (
                      <tr key={q.query}>
                        <td className="py-1.5 pr-3 text-parchment">{q.query}</td>
                        <td className="py-1.5 px-3 text-right tabular-nums text-muted">{fmt(q.clicks)}</td>
                        <td className="py-1.5 px-3 text-right tabular-nums text-muted">{fmt(q.impressions)}</td>
                        <td className="py-1.5 px-3 text-right tabular-nums text-muted">{pct(q.ctr)}</td>
                        <td className="py-1.5 pl-3 text-right tabular-nums text-muted">{q.position.toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-[12px] text-faint">No search-query data for this window yet.</p>
            )
          ) : (
            <Unavailable />
          )}
        </Card>
      </div>
    </div>
  )
}

/* ---- small building blocks ---- */

function Card({
  tag,
  title,
  wide,
  note,
  children,
}: {
  tag: string
  title: string
  wide?: boolean
  note?: string
  children: ReactNode
}) {
  return (
    <div
      className={[
        'flex flex-col rounded-2xl border border-line bg-surface/50 p-5',
        wide ? 'md:col-span-2 xl:col-span-3' : '',
      ].join(' ')}
    >
      <div className="mb-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-brass">{tag}</p>
        <h3 className="font-display text-[18px] text-parchment">{title}</h3>
      </div>
      {children}
      {note ? <p className="mt-3 text-[11px] leading-relaxed text-faint">{note}</p> : null}
    </div>
  )
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">{label}</p>
      {children}
    </div>
  )
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface-2/40 px-3.5 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">{label}</p>
      <p className="mt-1 font-display text-[22px] leading-none text-parchment tabular-nums">{value}</p>
      {sub ? <p className="mt-1 text-[11px] text-muted">{sub}</p> : null}
    </div>
  )
}

function Bars({ items }: { items: { label: string; value: number }[] }) {
  if (!items.length) return <p className="text-[12px] text-faint">No data yet.</p>
  const max = items.reduce((m, it) => Math.max(m, it.value), 0)
  return (
    <ul className="flex flex-col gap-2">
      {items.map((it, i) => (
        <li key={it.label + i} className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
            <span className="truncate text-parchment">{it.label}</span>
            <span className="shrink-0 tabular-nums text-muted">{fmt(it.value)}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
            <div
              className="h-full rounded-full bg-brass"
              style={{ width: `${max ? Math.max(4, (it.value / max) * 100) : 0}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  )
}

function MiniList({ title, rows }: { title?: string; rows: [string, string][] }) {
  if (!rows.length) return <p className="text-[12px] text-faint">No data yet.</p>
  return (
    <div>
      {title ? (
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">{title}</p>
      ) : null}
      <ul className="flex flex-col gap-1">
        {rows.map(([label, value], i) => (
          <li key={label + i} className="flex items-baseline justify-between gap-3 text-[12.5px]">
            <span className="truncate text-parchment">{label}</span>
            <span className="shrink-0 tabular-nums text-muted">{value}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) return <p className="text-[12px] text-faint">Not enough history yet.</p>
  const w = 260
  const h = 44
  const max = Math.max(...points, 1)
  const step = w / (points.length - 1)
  const line = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(h - (p / max) * (h - 4) - 2).toFixed(1)}`)
    .join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-11 w-full" preserveAspectRatio="none">
      <path d={line} fill="none" stroke="var(--color-brass)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function Unavailable() {
  return <p className="text-[12px] text-faint">Temporarily unavailable. It'll refill on the next refresh.</p>
}

/* ---- formatting helpers ---- */

const nf = new Intl.NumberFormat('en-US')
const fmt = (n: number) => nf.format(Math.round(n || 0))
const pct = (x: number | null | undefined, digits = 1) => (x == null ? '-' : `${(x * 100).toFixed(digits)}%`)
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
const fmtMoney = (n: number) => money.format(n || 0)
const pctOf = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : '-')

function fmtDuration(s: number) {
  s = Math.round(s || 0)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const r = s % 60
  return r ? `${m}m ${r}s` : `${m}m`
}

function fmtTime(iso: string) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'just now'
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function cityLabel(c: { city: string; region: string }) {
  return c.region ? `${c.city}, ${c.region}` : c.city
}

function LivePanel({ panel }: { panel: Panel }) {
  return (
    <div
      className={[
        'flex flex-col rounded-2xl border border-line bg-surface/50 p-5',
        panel.wide ? 'md:col-span-2 xl:col-span-3' : '',
      ].join(' ')}
    >
      <div className="mb-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-brass">{panel.tag}</p>
        <h3 className="font-display text-[18px] text-parchment">{panel.title}</h3>
      </div>
      <ul className="mb-4 flex flex-col gap-1.5">
        {panel.shows.map((s) => (
          <li key={s} className="flex gap-2 text-[12.5px] leading-snug text-muted">
            <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-faint" />
            <span>{s}</span>
          </li>
        ))}
      </ul>
      {/* Awaiting-data placeholder */}
      <div className="mt-auto flex items-center gap-2 rounded-lg border border-dashed border-line px-3 py-2 text-[11.5px] text-faint">
        <span className="h-1.5 w-1.5 rounded-full bg-faint/70" />
        Waiting for data connection
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* GUIDE (cheat-sheet)                                                */
/* ------------------------------------------------------------------ */

type Look = { label: string; where: string }
type Account = 'business' | 'personal'
type Tool = {
  name: string
  tag: string
  blurb: string
  url: string
  looks: Look[]
  account: Account
  note?: string
}

// Which email each tool lives under. Ownership is split on purpose (see the Accounts strip below),
// so this label removes the "wait, which login?" guesswork every time.
const EMAILS: Record<Account, string> = {
  business: 'michael@michaelbloemeke.com',
  personal: 'mchlbloemeke@gmail.com',
}

const TOOLS: Tool[] = [
  {
    name: 'Google Analytics 4',
    tag: 'Traffic & behavior',
    blurb: 'Who visits your site, where they come from, and what they do once they arrive.',
    url: 'https://analytics.google.com/',
    account: 'business',
    looks: [
      { label: 'Who is on the site right now', where: 'Reports  ›  Realtime' },
      { label: 'Where visitors come from (Google, direct, social)', where: 'Reports  ›  Acquisition  ›  Traffic acquisition' },
      { label: 'Your most-visited pages', where: 'Reports  ›  Engagement  ›  Pages and screens' },
      { label: 'How many people submitted the contact form', where: 'Reports  ›  Engagement  ›  Conversions' },
    ],
    note: 'Data is near-live: most reports are fresh within a few hours, and Realtime is the last 30 minutes.',
  },
  {
    name: 'Google Search Console',
    tag: 'How you rank on Google',
    blurb: 'The exact searches that surface your site, how often you get clicked, and where you sit in the results.',
    url: 'https://search.google.com/search-console',
    account: 'personal',
    looks: [
      { label: 'The keywords you rank for, plus clicks', where: 'Performance  ›  Queries tab' },
      { label: 'Your average position for a search', where: 'Performance  ›  turn on "Average position"' },
      { label: 'Which pages Google has indexed', where: 'Indexing  ›  Pages' },
      { label: 'Ask Google to re-crawl a page', where: 'the URL-inspection bar up top' },
    ],
    note: 'Search Console data is always about 2-3 days behind. That is a Google limitation, not a bug.',
  },
  {
    name: 'Google Ads',
    tag: 'Your paid campaign',
    blurb: 'The paid search campaign that puts you at the top of Google for the searches you want. What you spend and what it brings in.',
    url: 'https://ads.google.com/',
    account: 'personal',
    looks: [
      { label: 'Spend against your daily budget', where: 'Campaigns  ›  "Michael’s campaign"' },
      { label: 'Leads and cost per lead', where: 'Campaigns  ›  Conversions column' },
      { label: 'Wasted or out-of-area clicks to block', where: 'Insights  ›  Search terms' },
      { label: 'That the ad is still running and approved', where: 'Campaigns  ›  Status = Eligible' },
    ],
    note: 'A weekly look is plenty. Avoid changing settings daily. The bidding needs a stable runway to learn.',
  },
  {
    name: 'Bing Webmaster Tools',
    tag: 'Bing + ChatGPT',
    blurb: 'The same idea as Search Console, but for Bing. It matters because ChatGPT search leans on the Bing index.',
    url: 'https://www.bing.com/webmasters',
    account: 'business',
    looks: [
      { label: 'Keywords and clicks on Bing', where: 'Search Performance' },
      { label: 'How you show up in AI answers', where: 'AI Performance (Beta)' },
    ],
  },
  {
    name: 'Cloudflare',
    tag: 'Raw traffic & speed',
    blurb: 'The plumbing under your site: total visits, requests, and how fast pages load around the world.',
    url: 'https://dash.cloudflare.com/',
    account: 'business',
    looks: [
      { label: 'Total visits and requests', where: 'Workers & Pages  ›  website  ›  Metrics' },
      { label: 'Traffic and performance overview', where: 'Analytics & Logs  ›  Web Analytics' },
    ],
  },
]

// The full account map (a couple of these have no self-serve dashboard, so they aren't tool cards).
const ACCOUNTS: { service: string; account: Account; detail: string }[] = [
  { service: 'Google Analytics (GA4)', account: 'business', detail: 'property michaelbloemeke.com' },
  { service: 'Google Search Console', account: 'personal', detail: 'sc-domain:michaelbloemeke.com' },
  { service: 'Google Ads', account: 'personal', detail: '"Michael’s campaign"' },
  { service: 'Google Cloud (analytics API)', account: 'personal', detail: 'project wide-ceiling-272318' },
  { service: 'Bing Webmaster Tools', account: 'business', detail: 'Bing + ChatGPT index' },
  { service: 'Cloudflare (hosting)', account: 'business', detail: 'Pages project "website"' },
  { service: 'Google Business Profile', account: 'business', detail: 'the 344 five-star reviews' },
]

const QUICK: { want: string; where: string }[] = [
  { want: 'Is anyone on my site right now?', where: 'Analytics  ›  Realtime' },
  { want: 'What keywords am I ranking for?', where: 'Search Console  ›  Performance' },
  { want: 'Did I get new leads this week?', where: 'Your CRM Inbox (or Analytics  ›  Conversions)' },
  { want: 'Is my site fast and online?', where: 'Cloudflare  ›  Web Analytics' },
  { want: 'Am I showing up in Bing / ChatGPT?', where: 'Bing Webmaster  ›  AI Performance' },
]

function GuideView() {
  return (
    <div>
      <p className="mb-7 max-w-3xl text-[14px] leading-relaxed text-muted">
        Until the Live Feed is connected (and any time you want the source of truth), here is where to check
        each dashboard yourself. Open the ones you care about and bookmark them.
      </p>

      {/* Accounts at a glance */}
      <div className="mb-8 max-w-3xl overflow-hidden rounded-xl border border-line bg-surface/50">
        <div className="flex items-center justify-between gap-4 border-b border-line px-4 py-2.5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-faint">Which login is each one under</p>
          <div className="flex items-center gap-3 text-[11px]">
            <span className="inline-flex items-center gap-1.5 text-muted">
              <span className="h-2 w-2 rounded-full bg-brass" /> Business
            </span>
            <span className="inline-flex items-center gap-1.5 text-muted">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: 'var(--color-umb-postcall)' }} /> Personal
            </span>
          </div>
        </div>
        <ul className="divide-y divide-line/70">
          {ACCOUNTS.map((a) => (
            <li key={a.service} className="flex items-center justify-between gap-4 px-4 py-2.5">
              <div className="min-w-0">
                <span className="text-[13.5px] text-parchment">{a.service}</span>
                <span className="ml-2 text-[12px] text-faint">{a.detail}</span>
              </div>
              <AccountBadge account={a.account} />
            </li>
          ))}
        </ul>
        <p className="border-t border-line px-4 py-2.5 text-[11.5px] leading-relaxed text-muted">
          Split on purpose. Analytics, Bing, Cloudflare, and your Google Business Profile sit under the business
          email. Search Console, Google Ads, and the analytics API project sit under your personal Gmail.
        </p>
      </div>

      {/* Quick lookup */}
      <div className="mb-8 max-w-3xl overflow-hidden rounded-xl border border-line bg-surface/50">
        <p className="border-b border-line px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-faint">
          Quick answers
        </p>
        <ul className="divide-y divide-line/70">
          {QUICK.map((q) => (
            <li key={q.want} className="flex items-center justify-between gap-4 px-4 py-2.5">
              <span className="text-[13.5px] text-parchment">{q.want}</span>
              <span className="shrink-0 text-right text-[12.5px] text-brass">{q.where}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Tool cards */}
      <div className="grid gap-5 md:grid-cols-2">
        {TOOLS.map((t) => (
          <div key={t.name} className="flex flex-col rounded-2xl border border-line bg-surface/50 p-5">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-brass">{t.tag}</p>
                <h3 className="font-display text-[19px] text-parchment">{t.name}</h3>
              </div>
              <a
                href={t.url}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 rounded-lg border border-line-strong bg-surface-2 px-3 py-1.5 text-[12px] font-medium text-parchment transition-colors hover:border-brass hover:text-brass"
              >
                Open ↗
              </a>
            </div>
            <p className="mb-3 text-[13px] leading-relaxed text-muted">{t.blurb}</p>
            <div className="mb-4">
              <AccountBadge account={t.account} withEmail />
            </div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">
              What to look at
            </p>
            <ul className="flex flex-col gap-2">
              {t.looks.map((l) => (
                <li key={l.label} className="flex flex-col gap-0.5">
                  <span className="text-[13px] text-parchment">{l.label}</span>
                  <span className="text-[12px] text-faint">{l.where}</span>
                </li>
              ))}
            </ul>
            {t.note ? (
              <p className="mt-4 rounded-lg border border-line bg-surface-2/50 px-3 py-2 text-[11.5px] leading-relaxed text-muted">
                {t.note}
              </p>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  )
}

// A small pill showing which login a service is under. `withEmail` shows the full address
// (on the tool cards); without it, just the label (in the compact accounts strip).
function AccountBadge({ account, withEmail }: { account: Account; withEmail?: boolean }) {
  const isBusiness = account === 'business'
  const dot = isBusiness ? { className: 'bg-brass' } : { style: { backgroundColor: 'var(--color-umb-postcall)' } }
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface-2/60 px-2.5 py-1 text-[11.5px] text-muted">
      <span className="h-2 w-2 rounded-full" {...dot} />
      {withEmail ? EMAILS[account] : isBusiness ? 'Business' : 'Personal'}
    </span>
  )
}
