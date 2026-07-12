import { useState } from 'react'
import { motion } from 'motion/react'

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
  return (
    <div>
      {/* Not-connected banner */}
      <div className="mb-6 max-w-3xl rounded-xl border border-brass/40 bg-brass/5 px-4 py-3.5">
        <div className="mb-1 flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-brass shadow-[0_0_8px_var(--color-brass)]" />
          <p className="text-[13px] font-semibold text-brass">Live data not connected yet</p>
        </div>
        <p className="text-[12.5px] leading-relaxed text-muted">
          The panels below are your live dashboard, waiting on one thing: turning on Google's Analytics API.
          It is a one-time setup, about 15 minutes, and Claude drives most of it. Once it is connected, every
          panel here fills in automatically and refreshes on its own. Ask Claude to set it up whenever you are
          ready.
        </p>
      </div>

      {/* Panel grid (skeleton preview of the live layout) */}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {PANELS.map((p) => (
          <LivePanel key={p.title} panel={p} />
        ))}
      </div>
    </div>
  )
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
type Tool = {
  name: string
  tag: string
  blurb: string
  url: string
  looks: Look[]
  note?: string
}

const TOOLS: Tool[] = [
  {
    name: 'Google Analytics 4',
    tag: 'Traffic & behavior',
    blurb: 'Who visits your site, where they come from, and what they do once they arrive.',
    url: 'https://analytics.google.com/',
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
    looks: [
      { label: 'The keywords you rank for, plus clicks', where: 'Performance  ›  Queries tab' },
      { label: 'Your average position for a search', where: 'Performance  ›  turn on "Average position"' },
      { label: 'Which pages Google has indexed', where: 'Indexing  ›  Pages' },
      { label: 'Ask Google to re-crawl a page', where: 'the URL-inspection bar up top' },
    ],
    note: 'Search Console data is always about 2-3 days behind. That is a Google limitation, not a bug.',
  },
  {
    name: 'Bing Webmaster Tools',
    tag: 'Bing + ChatGPT',
    blurb: 'The same idea as Search Console, but for Bing. It matters because ChatGPT search leans on the Bing index.',
    url: 'https://www.bing.com/webmasters',
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
    looks: [
      { label: 'Total visits and requests', where: 'Workers & Pages  ›  website  ›  Metrics' },
      { label: 'Traffic and performance overview', where: 'Analytics & Logs  ›  Web Analytics' },
    ],
  },
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
            <p className="mb-4 text-[13px] leading-relaxed text-muted">{t.blurb}</p>
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
