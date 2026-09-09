// CLIENT PROPOSAL PAGES: the thing Michael sends after a sales call.
//
// It replaces a post-call email that was a wall of text plus a 10.6 MB PDF deck. That deck bounced
// off corporate mail servers, named exactly one price so every proposal read as yes-or-no, forwarded
// badly to the spouse or boss who actually decides, and gave back no signal at all about whether it
// had been opened. A URL has no file size, forwards perfectly, shows two or three options side by
// side, and tells him it was read.
//
// WHERE IT LIVES. The page is static HTML on michaelbloemeke.com (Website/proposal/index.html) and
// the content comes from the `proposal` Supabase edge function, keyed on the token in the URL.
// Publishing is a DATABASE WRITE, not a deploy. That is deliberate: the old client portal shelled
// out to `vercel deploy`, so a portal could not go live unless Michael's Mac was running. A client
// who is ready to book at 10 PM gets their link at 10 PM.
//
// WHAT IS AND IS NOT IN HERE. Everything a client reads that is the SAME for every client (the bio,
// the three booking steps, the payment line) is baked into the page. Everything that differs per
// client lives in the `proposals` row: the recommendation narrative, the packages, the chosen
// reviews, the chosen photos. Every event fact (date, venue, guest count) comes off the project
// itself, so the proposal never becomes a second, drifting copy of the truth.
//
// ONE TEMPLATE. A wedding proposal and a corporate proposal differ only in which photos load, which
// reviews load, which packages show, and the narrative copy. That is data. Adding an event type
// later is a config change here, not another page.

import { randomBytes } from 'node:crypto'
import { sb } from './crm-store.mjs'
import { loadAll, appendActivityLog, slugify } from './crm-data-core.mjs'
import { proposalEmail } from './crm-booking-emails.mjs'
import { clientEmailFor } from './crm-booking-form.mjs'

const SITE = 'https://michaelbloemeke.com'

// Unguessable, and never derived from the client's name: /proposal/john-smith would be a directory
// listing anyone could walk. Stable once issued, so re-sending a link never breaks an open page.
const newToken = () => randomBytes(18).toString('base64url')

// Roughly three months past the event. A proposal that simply goes stale should stop being a live
// page on the domain rather than sitting there forever. Passing a date explicitly overrides it.
function defaultExpiry(eventDate) {
  const base = /^\d{4}-\d{2}-\d{2}$/.test(String(eventDate || '')) ? new Date(eventDate + 'T12:00:00') : new Date()
  if (Number.isNaN(base.getTime())) return null
  base.setDate(base.getDate() + 90)
  return base.toISOString()
}

// ---------------------------------------------------------------------------
// The review bank
// ---------------------------------------------------------------------------
//
// Real Google reviews, verbatim, already published on michaelbloemeke.com. Sorted by the kind of
// event they speak to, so a wedding proposal shows wedding proof and a corporate proposal does not
// show a bachelorette quote.
//
// Two standing rules, both brand-critical: nothing here is ever written for the occasion, and
// reviews that lean into wizard or occult framing are left out even when they are jokes and even
// when they are glowing. ⚠️ LEAN INTO, not merely mention: a strong review with one such clause in
// it is used with the clause ellipsed out. Michael corrected this reading on 2026-08-19 after I
// wrongly binned Sarah and Jake Appelbaum's wedding review over a single line. See the playbook. Michael is a devout Catholic with a large Catholic and Christian client
// base. (This is why Gustavo Bora's "dark wizard" review is excluded from the website too.)
//
// TO REPLACE: Michael has a curated bank in Google Drive sorted the same way. When it lands, swap
// these arrays for it. The shape is all this module cares about.
export const REVIEW_BANK = {
  wedding: [
    { name: 'Deegan M.', text: 'This was the best night of my life and I got married last year. Came unsure of what to think, left with my mind blown and two souvenirs. 10/10 would come again.' },
    { name: 'Dasha B.', text: 'WOW. This man is hilarious, charismatic, and ridiculously talented. Best magic show I have ever seen.' },
    { name: 'Christian D.', text: 'Absolutely phenomenal. Best magician ever in all of history.' },
  ],
  corporate: [
    { name: 'Luis H.', text: "Michael blew my team's mind! His close up magic and mentalism kept us all guessing! We plan on having him back for more events! Highly recommend him!" },
    { name: 'Paige P.', text: 'Michael was a huge hit at our company event! He spent time moving from table to table, interacting with guests and creating a fun, personalized experience for everyone. We received so many positive comments, he truly made the event memorable!' },
    { name: 'Michelle B.', text: 'This was an amazing and entertaining event! Thank you for the laughs, smiles, and memories.' },
  ],
  'holiday-party': [
    { name: 'Brooke T.', text: "We had the absolute pleasure of having Michael Bloemeke perform at our holiday party, and he was phenomenal! His magic was not only impressive but also engaging and fun for all ages. If you're looking for a magician who is professional, personable, and guaranteed to wow your guests, Michael is the one!" },
    { name: 'Paige P.', text: 'Michael was a huge hit at our company event! He spent time moving from table to table, interacting with guests and creating a fun, personalized experience for everyone. We received so many positive comments, he truly made the event memorable!' },
    { name: 'Christian D.', text: 'Absolutely phenomenal. Best magician ever in all of history.' },
  ],
  bachelorette: [
    { name: 'Samantha H.', text: 'The best close up magic I have ever seen. The absolute perfect idea for any type of party. We had Michael for our Bachelorette party and I would recommend him to everyone I know.' },
    { name: 'Dasha B.', text: 'WOW. This man is hilarious, charismatic, and ridiculously talented. Best magic show I have ever seen.' },
    { name: 'Deegan M.', text: 'This was the best night of my life and I got married last year. Came unsure of what to think, left with my mind blown and two souvenirs. 10/10 would come again.' },
  ],
  private: [
    { name: 'Christian D.', text: 'Absolutely phenomenal. Best magician ever in all of history.' },
    { name: 'Michelle B.', text: 'This was an amazing and entertaining event! Thank you for the laughs, smiles, and memories.' },
    { name: 'Dasha B.', text: 'WOW. This man is hilarious, charismatic, and ridiculously talented. Best magic show I have ever seen.' },
  ],
}

// The event types the page has content for. An unrecognised type falls back to `private`, which is
// the most generic set, rather than showing nothing.
export const EVENT_TYPES = Object.keys(REVIEW_BANK)

const normaliseType = (t) => {
  const k = String(t || '').toLowerCase().trim().replace(/\s+/g, '-')
  if (REVIEW_BANK[k]) return k
  if (/wedding/.test(k)) return 'wedding'
  if (/holiday|christmas/.test(k)) return 'holiday-party'
  if (/bachelor/.test(k)) return 'bachelorette'
  if (/corporate|company|business|gala|fundrais/.test(k)) return 'corporate'
  return 'private'
}

export const reviewsFor = (eventType) => REVIEW_BANK[normaliseType(eventType)] || REVIEW_BANK.private

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------
//
// Site-relative paths under /assets/photos/ only. The edge function drops anything else, so an
// absolute URL here would silently render nothing rather than pointing a client's browser at some
// other host.
//
// ⚠️ These are the site's EXISTING photos, standing in until Michael's proposal shoot. They are the
// right shape but they are not the right pictures: the hero in particular wants a wide frame with an
// uncluttered centre, because text sits over it. The shot list is in
// `The Award-Winning Magic of Michael Bloemeke/proposal-shot-list.md`, and the live template preview
// at /proposal/?demo=1 shows every slot with its aspect ratio.
// ⚠️ THE PORTRAIT IS THE SAME PICTURE ON EVERY SET, ON PURPOSE (Michael, 2026-09-01).
// It is `michael-portrait-hero-dark.webp`: Michael seated at the table looking off to his right,
// hands on the cards, with the whole left of the frame dark and empty. That empty left side is
// load-bearing, because the Who Is Michael text sits on top of it. Every proposal he has ever
// approved uses it.
//
// These sets used to seed michael-portrait-bio.webp (and cards-bw for bachelorette), which meant
// every NEW proposal quietly shipped a different, badly cropped portrait than the ten before it.
// It reached Austin Gragson's page. His words: "I thought the other picture was fine. You did not
// need to change that picture." Do not vary the portrait by event type. If a genuinely better
// portrait arrives from the proposal shoot, change it here in all five sets at once.
export const PHOTO_SETS = {
  // ⚠️ EIGHT gallery photos per set, always. Michael set that as the standard on 2026-09-09: the
  // strip renders as two rows of four on a full-screen page, and four photos left it looking thin.
  // The edge function caps the gallery at 8, so eight is both the standard and the ceiling.
  wedding: {
    hero: '/assets/photos/homepage-hero.webp',
    format: '/assets/photos/bonsecours-gala-circle.webp',
    portrait: '/assets/photos/michael-portrait-hero-dark.webp',
    gallery: [
      '/assets/photos/wedding-couple-laughing.webp',
      '/assets/photos/wedding-garden-mingling.webp',
      '/assets/photos/lounge-laughing-guest.webp',
      '/assets/photos/tuxedo-guests-laughing.webp',
      '/assets/photos/gala-guest-delight.webp',
      '/assets/photos/cocktail-hour-guest-reaction.webp',
      '/assets/photos/guest-shock-reaction.webp',
      '/assets/photos/party-guests-astonished.webp',
    ],
  },
  corporate: {
    hero: '/assets/photos/stage-show-audience.webp',
    format: '/assets/photos/corporate-team-magic.webp',
    portrait: '/assets/photos/michael-portrait-hero-dark.webp',
    gallery: [
      '/assets/photos/corporate-team-magic.webp',
      '/assets/photos/corporate-gala-strolling-crowd.webp',
      '/assets/photos/mentalism-three-volunteers.webp',
      '/assets/photos/corporate-guests-laughing.webp',
      '/assets/photos/tuxedo-guests-laughing.webp',
      '/assets/photos/gala-guest-astonished.webp',
      '/assets/photos/guest-shock-reaction.webp',
      '/assets/photos/stage-show-adult-volunteer.webp',
    ],
  },
  'holiday-party': {
    hero: '/assets/photos/homepage-hero.webp',
    format: '/assets/photos/santa-christmas-magic.webp',
    portrait: '/assets/photos/michael-portrait-hero-dark.webp',
    gallery: [
      '/assets/photos/santa-christmas-magic.webp',
      '/assets/photos/corporate-guests-laughing.webp',
      '/assets/photos/lounge-laughing-guest.webp',
      '/assets/photos/corporate-team-magic.webp',
      '/assets/photos/tuxedo-guests-laughing.webp',
      '/assets/photos/gala-guest-delight.webp',
      '/assets/photos/guest-shock-reaction.webp',
      '/assets/photos/mentalism-three-volunteers.webp',
    ],
  },
  bachelorette: {
    hero: '/assets/photos/lounge-laughing-guest.webp',
    format: '/assets/photos/close-up-magic-convention.webp',
    portrait: '/assets/photos/michael-portrait-hero-dark.webp',
    gallery: [
      '/assets/photos/lounge-laughing-guest.webp',
      '/assets/photos/party-guests-astonished.webp',
      '/assets/photos/gala-guest-delight.webp',
      '/assets/photos/cocktail-hour-guest-reaction.webp',
      '/assets/photos/guest-shock-reaction.webp',
      '/assets/photos/magic-convention-card-spread.webp',
      '/assets/photos/gala-guest-astonished.webp',
      '/assets/photos/tuxedo-guests-laughing.webp',
    ],
  },
  private: {
    hero: '/assets/photos/homepage-hero.webp',
    format: '/assets/photos/close-up-magic-convention.webp',
    portrait: '/assets/photos/michael-portrait-hero-dark.webp',
    gallery: [
      '/assets/photos/cocktail-hour-guest-reaction.webp',
      '/assets/photos/lounge-laughing-guest.webp',
      '/assets/photos/party-guests-astonished.webp',
      '/assets/photos/gala-guest-delight.webp',
      '/assets/photos/tuxedo-guests-laughing.webp',
      '/assets/photos/gala-guest-astonished.webp',
      '/assets/photos/corporate-guests-laughing.webp',
      '/assets/photos/mentalism-three-volunteers.webp',
    ],
  },
}

export const photosFor = (eventType) => PHOTO_SETS[normaliseType(eventType)] || PHOTO_SETS.private

// The promo reel already embedded on the homepage. Swap this once the rebuilt one is filmed.
// THE LOGO WALL IS FIXED FURNITURE. Michael, 2026-08-19 and again 2026-08-22: it is the same 32
// logos on EVERY proposal, private events and weddings included, and it is never trimmed to balance
// the page against the quote column. It is not an argument that he does corporate work, it is an
// argument that serious organisations vetted and hired him, and that lands on a private host too.
// Seeded here rather than left to whoever writes the page, because twice now a proposal shipped
// with an empty wall because nobody remembered to set it. Fidelity Investments is permanently
// excluded under standing rule 14 (the employer was inferred from a reviewer's email domain), which
// is why this is 32 and not the 33 logo files on disk.
export const CLIENT_LOGOS = [
  { logo: 'raleigh-country-club', name: "Raleigh Country Club" },
  { logo: 'renaissance-hotels', name: "Renaissance Hotels" },
  { logo: 'duke-university', name: "Duke University" },
  { logo: 'nc-state', name: "NC State University" },
  { logo: 'sas', name: "SAS" },
  { logo: 'bull-city-ciderworks', name: "Bull City Ciderworks" },
  { logo: 'primland-resort', name: "Primland Resort" },
  { logo: 'park-hotels-resorts', name: "Park Hotels & Resorts" },
  { logo: 'the-cw', name: "The CW" },
  { logo: 'wcnc-charlotte', name: "WCNC Charlotte" },
  { logo: 'merrill-lynch', name: "Merrill Lynch" },
  { logo: 'clayton-homes', name: "Clayton Homes" },
  { logo: 'bon-secours', name: "Bon Secours" },
  { logo: 'cdata', name: "CData Software" },
  { logo: 'glen-raven', name: "Glen Raven" },
  { logo: 'iqor', name: "iQor" },
  { logo: 'hawx-pest-control', name: "Hawx Pest Control" },
  { logo: 'radeas', name: "Radeas" },
  { logo: 'carolina-commercial-systems', name: "Carolina Commercial Systems" },
  { logo: 'legacy-wealth-strategies', name: "Legacy Wealth Strategies" },
  { logo: 'wells-global', name: "Wells Global" },
  { logo: 'protego', name: "Protego" },
  { logo: 'terrahawk', name: "Terrahawk" },
  { logo: 'golden-ticket-cinemas', name: "Golden Ticket Cinemas" },
  { logo: 'catholic-diocese-of-raleigh', name: "Catholic Diocese of Raleigh" },
  { logo: 'cardinal-gibbons', name: "Cardinal Gibbons" },
  { logo: 'our-lady-of-lourdes', name: "Our Lady of Lourdes" },
  { logo: 'ryans-place', name: "Ryan's Place" },
  { logo: 'chapel-hill-high', name: "Chapel Hill High School" },
  { logo: 'watermelon-festival', name: "Watermelon Festival" },
  { logo: 'magicians-table', name: "The Magician's Table" },
  { logo: 'we-plant-it-forward', name: "We Plant It Forward" },
]

export const DEFAULT_VIDEO_ID = 'uTaXL4lPcHQ'

// ---------------------------------------------------------------------------
// Reading and writing
// ---------------------------------------------------------------------------

export async function loadProposal(projectId) {
  const { data, error } = await sb().from('proposals').select('*').eq('project_id', projectId).maybeSingle()
  if (error) throw new Error(`crm-proposals.loadProposal: ${error.message}`)
  return data || null
}

export const proposalUrl = (token) => `${SITE}/proposal/?t=${token}`

// Create the row if it isn't there yet, seeded from the project's event type, and hand back the link.
// Issuing a link does NOT publish it: status stays 'draft' until publishProposal, so Michael can
// write the recommendation and set the packages without any risk of a half-finished page being live.
export async function ensureProposal(projectId) {
  const existing = await loadProposal(projectId)
  if (existing) return existing

  const project = loadAll().projects.find((p) => p.id === projectId)
  if (!project) throw new Error(`crm-proposals: no project "${projectId}"`)

  const type = normaliseType(project.eventType)
  const row = {
    project_id: projectId,
    token: newToken(),
    status: 'draft',
    event_type: type,
    hero_line: '',
    recommendation: '',
    packages: [],
    reviews: reviewsFor(type),
    clients: CLIENT_LOGOS,
    photos: photosFor(type),
    video_id: DEFAULT_VIDEO_ID,
    expires_at: defaultExpiry(project.eventDate),
  }
  const { data, error } = await sb().from('proposals').insert(row).select().single()
  if (error) throw new Error(`crm-proposals.ensureProposal: ${error.message}`)
  return data
}

// Patch keys map straight onto the columns: hero_line, recommendation, packages, reviews, photos,
// video_id, event_type, expires_at. Anything else is ignored rather than thrown, so a caller can
// hand over a whole object without filtering it first.
const WRITABLE = ['event_type', 'headline', 'hero_line', 'event_copy', 'recommendation', 'styles', 'styles_note', 'packages', 'reviews', 'clients', 'photos', 'video_id', 'followup', 'expires_at']

export async function saveProposal(projectId, patch) {
  const update = { updated_at: new Date().toISOString() }
  for (const k of WRITABLE) if (k in patch) update[k] = patch[k]
  const { data, error } = await sb().from('proposals').update(update).eq('project_id', projectId).select().single()
  if (error) throw new Error(`crm-proposals.saveProposal: ${error.message}`)
  return data
}

// "6:00" could be morning or evening. The page will not guess (printing "6:00 AM" on a proposal for
// a 6 PM wedding would have it stating something untrue), so an ambiguous time is caught here and
// Michael writes "6:00 PM" or "18:00" on the project instead. 13:00 and up, and anything that
// already carries AM or PM, are unambiguous and pass.
function ambiguousTime(v) {
  const raw = String(v || '').trim()
  const bare = /^(\d{1,2}):(\d{2})$/.exec(raw)
  if (!bare) return false
  const h = Number(bare[1])
  return h >= 1 && h <= 11
}

// Refuses to publish an empty page. Everything checked here is something a client would notice
// missing or would read as wrong, and a proposal that goes out half-built is worse than one that
// goes out an hour later. `project` is optional; pass it to also check the event facts.
export function proposalGaps(row, project) {
  const gaps = []
  if (!String(row.recommendation || '').trim()) gaps.push('the recommendation narrative')
  if (!Array.isArray(row.packages) || !row.packages.length) gaps.push('at least one package')
  if (Array.isArray(row.packages) && row.packages.some((p) => !p.name || !p.price)) gaps.push('a name and price on every package')
  if (!Array.isArray(row.reviews) || !row.reviews.length) gaps.push('at least one review')
  if (!Array.isArray(row.clients) || !row.clients.length) gaps.push('the client logo wall (it goes on every proposal, see CLIENT_LOGOS)')
  if (project) {
    if (ambiguousTime(project.eventStartTime)) gaps.push(`AM or PM on the event start time ("${project.eventStartTime}")`)
    if (ambiguousTime(project.showStartTime)) gaps.push(`AM or PM on the show start time ("${project.showStartTime}")`)
  }
  return gaps
}

export async function publishProposal(projectId) {
  const row = await ensureProposal(projectId)
  const project = loadAll().projects.find((p) => p.id === projectId)
  const gaps = proposalGaps(row, project)
  if (gaps.length) throw new Error(`Not ready to publish. Still needs: ${gaps.join(', ')}.`)

  const { data, error } = await sb()
    .from('proposals')
    .update({ status: 'live', updated_at: new Date().toISOString() })
    .eq('project_id', projectId)
    .select()
    .single()
  if (error) throw new Error(`crm-proposals.publishProposal: ${error.message}`)

  await appendActivityLog(projectId, 'Proposal page published.')
  return { ...data, url: proposalUrl(data.token) }
}

// Takes the page down by hand. Note that the edge function ALSO refuses any proposal whose project
// has left the active or completed buckets, so archiving or deleting a project retires its page on
// its own with no sweep to run and nothing to remember.
//
// Deliberately NOT automatic on a won deal. The handoff has the proposal retiring once a booking is
// confirmed, on the basis that the post-booking confirmation page takes over. That page is phase 2
// and does not exist yet, so killing the link the moment someone books would leave a client who has
// just paid with nothing to look at. Retire won proposals by hand until the confirmation page ships.
export async function retireProposal(projectId) {
  const { error } = await sb()
    .from('proposals')
    .update({ status: 'retired', updated_at: new Date().toISOString() })
    .eq('project_id', projectId)
  if (error) throw new Error(`crm-proposals.retireProposal: ${error.message}`)
  await appendActivityLog(projectId, 'Proposal page retired.')
}

// Put the counter back to zero so the next view is known to be the client's.
//
// WHY THIS EXISTS (Michael, 2026-08-17). Michael and Claude open a proposal repeatedly while
// writing and proofreading it, and every one of those opens counts. Farrell's page read "opened 2x"
// before it had been sent to anyone. A number that mixes his own proofreading with the client's
// reading is worse than no number, because he cannot tell which is which.
//
// The rejected alternative was to stop counting CRM previews and count only real browser opens.
// Michael's call, and he is right: he still opens the live link in his own browser to check it, so
// that would not have produced a clean number either. An explicit reset he presses the moment he
// sends is the only version he can trust. The intended habit is: proofread it as many times as you
// like, send it, hit reset, and from then on every view is somebody else.
//
// ⚠️ first_viewed_at MUST be nulled, not just the count. The edge function decides whether to fire
// the first-view bell and phone push with `!prop.first_viewed_at`. Leave it set and the reset gives
// a zero counter that can never alert him again, which is the exact failure the reset is meant to
// prevent.
//
// Any unseen proposal-viewed notification is cleared too, since it refers to a view that has just
// been declared not to count.
export async function resetProposalViews(projectId) {
  const { error } = await sb()
    .from('proposals')
    .update({
      view_count: 0,
      first_viewed_at: null,
      last_viewed_at: null,
      // The not-opened nudge fires once per proposal and is stamped so it cannot nag daily. A reset
      // declares every view so far to be his own, so the clock starts again and the nudge must be
      // allowed to fire again too.
      nudge_task_created_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('project_id', projectId)
  if (error) throw new Error(`crm-proposals.resetProposalViews: ${error.message}`)

  // Best-effort. A stale bell is not worth failing the reset over.
  try {
    await sb()
      .from('notifications')
      .delete()
      .eq('kind', 'proposal-viewed')
      .eq('project_id', projectId)
      .eq('seen', false)
  } catch (e) {
    console.warn('[proposals] could not clear the proposal-viewed notification:', e?.message || e)
  }

  // Deliberately NOT written to the activity log. Michael resets this every time he sends, so
  // logging it would add a line per proposal that says nothing about the client.
}

// ⚠️ IF YOU ARE CHECKING A PROPOSAL FROM A SCRIPT OR A TERMINAL, PASS preview=1. The edge function
// counts every GET that is not flagged as a preview, so a plain
// `curl .../functions/v1/proposal?token=X` to verify a change silently inflates the number Michael
// relies on. Use `?token=X&preview=1`. This is how Farrell's page reached "opened 2x" before it had
// been sent to anyone.
//
// Did they read it? A view is counted every time, not once per person: the forwarded view, from the
// spouse or the boss who was not on the call, is the one that decides the booking.
export async function proposalStats(projectId) {
  const row = await loadProposal(projectId)
  if (!row) return null
  return {
    status: row.status,
    url: proposalUrl(row.token),
    views: row.view_count ?? 0,
    firstViewedAt: row.first_viewed_at || '',
    lastViewedAt: row.last_viewed_at || '',
    expiresAt: row.expires_at || '',
  }
}

// Everything the project card needs in one read: whether a proposal exists, whether it is live,
// what is still missing, the link, and whether anybody has opened it.
export async function proposalStatus(projectId) {
  const row = await loadProposal(projectId)
  if (!row) return { exists: false, status: 'none', gaps: [], views: 0 }
  const project = loadAll().projects.find((p) => p.id === projectId)
  return {
    exists: true,
    status: row.status,
    url: proposalUrl(row.token),
    headline: row.headline || '',
    gaps: proposalGaps(row, project),
    views: row.view_count ?? 0,
    firstViewedAt: row.first_viewed_at || '',
    lastViewedAt: row.last_viewed_at || '',
    expiresAt: row.expires_at || '',
    emailDraftedAt: row.email_drafted_at || '',
    packageCount: Array.isArray(row.packages) ? row.packages.length : 0,
  }
}

// Leave a ready-to-send draft in Gmail. NEVER sends: Michael reads every client email before it
// goes, and this one carries a price.
//
// Publishing happens first, in the caller, so the link in the draft can never be dead by the time he
// presses send.
export async function draftProposalEmail(projectId, { createDraft }) {
  const project = loadAll().projects.find((p) => p.id === projectId)
  if (!project) throw new Error(`crm-proposals: no project "${projectId}"`)

  const row = await loadProposal(projectId)
  if (!row) throw new Error('No proposal for this project yet.')
  if (row.status !== 'live') throw new Error('Publish the proposal before drafting the email, or the link in it will be dead.')

  const to = clientEmailFor(project)
  if (!to) {
    throw new Error('No client email on this project. Add one in the Contact section, or on the linked contact record.')
  }

  const url = proposalUrl(row.token)
  const { subject, text, html } = proposalEmail({ project, url })
  const draft = await createDraft({ to, subject, body: text, html })

  await sb()
    .from('proposals')
    .update({ email_drafted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('project_id', projectId)
  await appendActivityLog(projectId, 'Proposal email drafted in Gmail. Not sent.')

  return { ok: true, to, url, threadId: draft?.threadId || '' }
}

// ---------------------------------------------------------------------------
// The Proposals page
// ---------------------------------------------------------------------------
//
// One read that answers the question the per-project ProposalCard cannot: what have I sent, to
// whom, and did anybody look at it. Before this page the only way to see a proposal was to remember
// whose project it was on, which stopped working somewhere around the tenth one.
//
// ⚠️ THE POINT OF THIS FUNCTION IS THAT "live" IS COMPUTED, NOT READ.
//
// `proposals.status` says `live` for three proposals right now whose pages are actually dark,
// because the edge function refuses to serve any proposal whose project has left the active or
// completed buckets. There are THREE independent gates and the status column is only one of them:
//
//   1. status must be 'live'
//   2. expires_at must be in the future (default: event date + 90 days)
//   3. the project must be in the active or completed bucket
//
// Showing the raw column would tell Michael a page is up when it is not. So `state` below runs the
// same three checks the edge function runs, in the same order, and `reason` says which one closed
// it. If the edge function's gates ever change, change these with them.

const PREVIEW_KEY_ID = 1

// Michael's own key, which lets him open a proposal the public can no longer reach. Cached for the
// life of the process: it is one row that never changes, and this is read once per page load.
let previewKeyCache = null
async function previewKey() {
  if (previewKeyCache !== null) return previewKeyCache
  const { data, error } = await sb().from('push_config').select('preview_key').eq('id', PREVIEW_KEY_ID).maybeSingle()
  if (error) {
    console.warn('[proposals] could not read the preview key:', error.message)
    return ''
  }
  previewKeyCache = data?.preview_key || ''
  return previewKeyCache
}

// The four states a proposal can be in, from Michael's point of view rather than the database's.
//
//   draft    written but never published. Nobody can reach it and nobody ever could.
//   live     up right now. The link in the client's inbox works.
//   expired  it was live and the clock ran out. Nothing was decided; it simply aged out.
//   down     taken down on purpose, or taken down BY the project leaving the pipeline.
//
// `expired` and `down` are kept apart because they mean different things when Michael is looking
// back at a lost deal: one is "I retired this", the other is "this quietly lapsed".
function proposalState(row, project) {
  if (row.status === 'draft') return { state: 'draft', reason: 'Never published.' }
  if (row.status === 'retired') return { state: 'down', reason: 'Taken down by hand.' }

  const bucket = project?.bucket
  if (bucket !== 'active' && bucket !== 'completed') {
    return {
      state: 'down',
      reason: bucket === 'archived' ? 'Down because the project was archived.' : 'Down because the project left the pipeline.',
    }
  }

  const expires = row.expires_at ? Date.parse(row.expires_at) : NaN
  if (!Number.isNaN(expires) && expires < Date.now()) {
    return { state: 'expired', reason: 'Past its expiry date.' }
  }

  return { state: 'live', reason: 'Up now. The link works.' }
}

// Booked, lost, or still in play. Read off the project, never off the proposal: the proposal has no
// idea whether the deal closed, and inferring it from `retired` would call every tidied-up page a
// loss. `completed` is the only thing in this system that means the gig actually happened.
function outcomeOf(project) {
  if (!project) return { outcome: 'unknown', label: 'No project' }
  if (project.bucket === 'completed') return { outcome: 'booked', label: 'Booked' }
  if (project.bucket === 'archived') {
    return { outcome: 'lost', label: 'Fell through', note: project.archiveReason || project.whyArchived || '' }
  }
  if (project.deletedAt) return { outcome: 'lost', label: 'Deleted' }
  // Still in the pipeline. Money already taken is worth saying out loud, because a deposit-paid
  // project in the active list is a won deal that simply has not happened yet.
  if (project.stageId === 'deposit-paid' || project.stageId === 'paid-in-full') {
    return { outcome: 'booked', label: 'Booked' }
  }
  return { outcome: 'open', label: 'In play' }
}

export async function proposalsOverview() {
  const [{ data: rows, error }, key] = await Promise.all([
    sb().from('proposals').select('*'),
    previewKey(),
  ])
  if (error) throw new Error(`crm-proposals.proposalsOverview: ${error.message}`)

  // Deleted projects are excluded everywhere else in the CRM (Finance, Stats, tasks, the phone
  // snapshot), so they are excluded here too rather than becoming the one screen that resurrects
  // them. loadAll() already drops them.
  const projects = loadAll().projects
  const byId = new Map(projects.map((p) => [p.id, p]))

  const items = (rows || []).map((row) => {
    const project = byId.get(row.project_id) || null
    const { state, reason } = proposalState(row, project)
    const { outcome, label, note } = outcomeOf(project)

    // Michael's link ALWAYS carries a flag, so his own checking can never be mistaken for the
    // client's reading. Which flag depends on whether the page is still public:
    //   live      preview=1, the flag that already existed. Renders, does not count.
    //   anything  the admin key as well, which is the only thing that gets past the three gates.
    // The clean URL, the one he actually sends, is `url` and carries neither.
    const url = proposalUrl(row.token)
    const openUrl = state === 'live' ? `${url}&preview=1` : key ? `${url}&preview=1&k=${encodeURIComponent(key)}` : ''

    return {
      projectId: row.project_id,
      projectName: project?.client || row.project_id,
      contactNames: project?.contactNames || '',
      eventType: project?.eventType || '',
      eventDate: project?.eventDate || '',
      totalFee: project?.totalFee ?? '',
      bucket: project?.bucket || 'missing',
      stageId: project?.stageId || '',

      state,
      stateReason: reason,
      outcome,
      outcomeLabel: label,
      outcomeNote: note || '',

      url,
      openUrl,
      views: row.view_count ?? 0,
      firstViewedAt: row.first_viewed_at || '',
      lastViewedAt: row.last_viewed_at || '',
      expiresAt: row.expires_at || '',
      emailDraftedAt: row.email_drafted_at || '',
      createdAt: row.created_at || '',
    }
  })

  // Booking forms are a SEPARATE list keyed the same way, not a column on the proposal. A project
  // can have one without the other in both directions: a repeat client books with no proposal, and
  // most proposals never get as far as a form.
  const { data: bookingRows, error: bookingErr } = await sb()
    .from('projects')
    .select('id, client_name, booking_token, booking_sent_at, booking_viewed_at, booking_view_count, booking_last_viewed_at, agreement_variant')
    .not('booking_token', 'is', null)
  if (bookingErr) throw new Error(`crm-proposals.proposalsOverview (bookings): ${bookingErr.message}`)

  // Keyed by the SLUG, which is what loadAll() uses as a project id, not by projects.id. They are
  // usually the same string and occasionally are not, and matching on the raw column would silently
  // drop the ones that differ.
  const bookings = (bookingRows || [])
    .map((b) => {
      const id = slugify(b.client_name)
      if (!byId.has(id)) return null // deleted, and deleted projects are excluded everywhere else
      const project = byId.get(id)
      const { outcome, label, note } = outcomeOf(project)
      return {
        projectId: id,
        projectName: project.client || id,
        // The same active/past split the proposals use, for the same reason: a booking form on a
        // completed project belongs in the history, not in the list of what is out right now.
        bucket: project.bucket || 'missing',
        outcome,
        outcomeLabel: label,
        outcomeNote: note || '',
        eventType: project.eventType || '',
        eventDate: project.eventDate || '',
        totalFee: project.totalFee ?? '',
        sentAt: b.booking_sent_at || '',
        // Same flag as the proposal, same reason: opening it from the CRM must not count.
        openUrl: b.booking_token ? `${SITE}/book/?t=${b.booking_token}&preview=1` : '',
        views: b.booking_view_count ?? 0,
        firstViewedAt: b.booking_viewed_at || '',
        lastViewedAt: b.booking_last_viewed_at || '',
        variant: b.agreement_variant || '',
      }
    })
    .filter(Boolean)

  return {
    items,
    bookings,
    samples: {
      proposal: `${SITE}/proposal/?demo=1`,
      booking: `${SITE}/book/?demo=1`,
    },
  }
}
