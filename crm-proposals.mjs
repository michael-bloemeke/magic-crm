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
import { loadAll, appendActivityLog } from './crm-data-core.mjs'
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
// when they are glowing. Michael is a devout Catholic with a large Catholic and Christian client
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
export const PHOTO_SETS = {
  wedding: {
    hero: '/assets/photos/homepage-hero.webp',
    format: '/assets/photos/bonsecours-gala-circle.webp',
    portrait: '/assets/photos/michael-portrait-bio.webp',
    gallery: [
      '/assets/photos/lounge-laughing-guest.webp',
      '/assets/photos/tuxedo-guests-laughing.webp',
      '/assets/photos/gala-guest-delight.webp',
      '/assets/photos/guest-shock-reaction.webp',
    ],
  },
  corporate: {
    hero: '/assets/photos/stage-show-audience.webp',
    format: '/assets/photos/corporate-team-magic.webp',
    portrait: '/assets/photos/michael-portrait-bio.webp',
    gallery: [
      '/assets/photos/corporate-team-magic.webp',
      '/assets/photos/mentalism-three-volunteers.webp',
      '/assets/photos/tuxedo-guests-laughing.webp',
      '/assets/photos/guest-shock-reaction.webp',
    ],
  },
  'holiday-party': {
    hero: '/assets/photos/homepage-hero.webp',
    format: '/assets/photos/santa-christmas-magic.webp',
    portrait: '/assets/photos/michael-portrait-bio.webp',
    gallery: [
      '/assets/photos/santa-christmas-magic.webp',
      '/assets/photos/lounge-laughing-guest.webp',
      '/assets/photos/corporate-team-magic.webp',
      '/assets/photos/guest-shock-reaction.webp',
    ],
  },
  bachelorette: {
    hero: '/assets/photos/lounge-laughing-guest.webp',
    format: '/assets/photos/close-up-magic-convention.webp',
    portrait: '/assets/photos/michael-portrait-cards-bw.webp',
    gallery: [
      '/assets/photos/lounge-laughing-guest.webp',
      '/assets/photos/gala-guest-delight.webp',
      '/assets/photos/guest-shock-reaction.webp',
      '/assets/photos/magic-convention-card-spread.webp',
    ],
  },
  private: {
    hero: '/assets/photos/homepage-hero.webp',
    format: '/assets/photos/close-up-magic-convention.webp',
    portrait: '/assets/photos/michael-portrait-bio.webp',
    gallery: [
      '/assets/photos/lounge-laughing-guest.webp',
      '/assets/photos/gala-guest-delight.webp',
      '/assets/photos/stage-show-audience.webp',
      '/assets/photos/guest-shock-reaction.webp',
    ],
  },
}

export const photosFor = (eventType) => PHOTO_SETS[normaliseType(eventType)] || PHOTO_SETS.private

// The promo reel already embedded on the homepage. Swap this once the rebuilt one is filmed.
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
const WRITABLE = ['event_type', 'headline', 'hero_line', 'event_copy', 'recommendation', 'styles', 'styles_note', 'packages', 'reviews', 'photos', 'video_id', 'expires_at']

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
