// THE PROPOSALS LIST, FOR THE PHONE.
//
// The desktop builds this in `crm-proposals.mjs` -> proposalsOverview(), which runs inside the Vite
// dev plugin with the service role. The phone cannot call that (it is Node, on the MacBook) and
// cannot do it itself, because RLS denies `authenticated` on both tables it needs:
//   - `proposals`   has RLS on and no policy for authenticated.
//   - `push_config` holds `preview_key`, the admin key that opens a proposal the public can no
//     longer reach. That one is deliberately not readable by the app, and it should stay that way:
//     the key never needs to be ON the device, only in the link the device is handed.
//
// So the computation moves here, behind the same JWT check the other functions use, and what comes
// back is already-decided: a state, an outcome, and a URL that is safe to open.
//
// ⚠️ THE VIEW COUNT IS SACRED. Michael, 2026-09-09: "I don't want me viewing it in my CRM to
// increase the count of the number of times it's been viewed... That is important data." Every URL
// this function hands back for HIS use carries `preview=1`, and the admin key as well when the page
// is no longer public, because preview=1 alone does not get past the status, expiry or bucket
// gates in the `proposal` function. The clean link, the one he SENDS, is returned separately as
// `url` and carries neither flag. The two are never the same string.
//
// This mirrors proposalState / outcomeOf / previewUrlFor in crm-proposals.mjs. If those change,
// change these. They are kept in step by hand because the two runtimes cannot share a module.
import { createClient } from 'jsr:@supabase/supabase-js@2'

const SITE = 'https://michaelbloemeke.com'
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

const proposalUrl = (token: string) => `${SITE}/proposal/?t=${token}`

// Mirrors slugify() in crm-data-core.mjs: the project id is the slug of client_name, and the
// booking rows have to be matched on that rather than on projects.id, which is usually the same
// string and occasionally is not.
function slugify(name: string): string {
  return String(name || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

type State = { state: 'draft' | 'live' | 'expired' | 'down'; reason: string }
function proposalState(row: any, project: any): State {
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
  if (!Number.isNaN(expires) && expires < Date.now()) return { state: 'expired', reason: 'Past its expiry date.' }
  return { state: 'live', reason: 'Up now. The link works.' }
}

// Read off the PROJECT, never off the proposal: a proposal has no idea whether the deal closed, and
// reading `retired` as a loss would call every tidied-up page a lost deal.
function outcomeOf(project: any) {
  if (!project) return { outcome: 'unknown', label: 'No project', note: '' }
  if (project.bucket === 'completed') return { outcome: 'booked', label: 'Booked', note: '' }
  if (project.bucket === 'archived') return { outcome: 'lost', label: 'Fell through', note: String(project.archive_reason || '') }
  if (project.deleted_at) return { outcome: 'lost', label: 'Deleted', note: '' }
  if (project.stage_id === 'deposit-paid' || project.stage_id === 'paid-in-full') {
    return { outcome: 'booked', label: 'Booked', note: '' }
  }
  return { outcome: 'open', label: 'In play', note: '' }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405)

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
  if (!jwt) return json({ ok: false, error: 'Not signed in.' }, 401)
  const { data: userData, error: userErr } = await admin.auth.getUser(jwt)
  if (userErr || !userData?.user) return json({ ok: false, error: 'Invalid session.' }, 401)

  const [{ data: rows, error: rErr }, { data: projects, error: pErr }, { data: cfg }] = await Promise.all([
    admin.from('proposals').select('*'),
    admin.from('projects')
      .select('id, client_name, project_name, bucket, stage_id, event_type, event_date, total_fee, total_fee_text, archive_reason, deleted_at, booking_token, booking_sent_at, booking_viewed_at, booking_view_count, booking_last_viewed_at, agreement_variant')
      .is('deleted_at', null),
    admin.from('push_config').select('preview_key').eq('id', 1).maybeSingle(),
  ])
  if (rErr) return json({ ok: false, error: rErr.message }, 500)
  if (pErr) return json({ ok: false, error: pErr.message }, 500)

  const key = String(cfg?.preview_key || '')
  // Deleted projects are excluded here exactly as they are in Finance, Stats and the phone
  // snapshot, rather than this becoming the one screen that resurrects them.
  const byId = new Map((projects || []).filter((p: any) => p.bucket !== 'deleted').map((p: any) => [String(p.id), p]))
  const fee = (p: any) => (p?.total_fee != null ? p.total_fee : p?.total_fee_text || '')
  const name = (p: any, fallback: string) => String(p?.project_name || p?.client_name || fallback)

  const items = (rows || []).map((row: any) => {
    const project = byId.get(String(row.project_id)) || null
    const { state, reason } = proposalState(row, project)
    const { outcome, label, note } = outcomeOf(project)
    const url = proposalUrl(row.token)
    // live -> preview=1 is enough. Anything else also needs the admin key, which is the only thing
    // that gets past the three gates in the `proposal` function.
    const openUrl = state === 'live'
      ? `${url}&preview=1`
      : key ? `${url}&preview=1&k=${encodeURIComponent(key)}` : ''
    return {
      projectId: String(row.project_id),
      projectName: name(project, String(row.project_id)),
      eventType: String(project?.event_type || row.event_type || ''),
      eventDate: String(project?.event_date || ''),
      totalFee: fee(project),
      bucket: String(project?.bucket || 'missing'),
      headline: String(row.headline || row.hero_line || ''),
      state, stateReason: reason,
      outcome, outcomeLabel: label, outcomeNote: note,
      url, openUrl,
      views: row.view_count ?? 0,
      firstViewedAt: row.first_viewed_at || '',
      lastViewedAt: row.last_viewed_at || '',
      expiresAt: row.expires_at || '',
      createdAt: row.created_at || '',
    }
  })

  // Booking forms are a SEPARATE list keyed the same way, not a column on the proposal: a repeat
  // client books with no proposal, and most proposals never get as far as a form.
  const bookings = (projects || [])
    .filter((b: any) => b.booking_token)
    .map((b: any) => {
      const id = slugify(String(b.client_name || ''))
      const project = byId.get(id) || byId.get(String(b.id)) || null
      if (!project) return null
      const { outcome, label, note } = outcomeOf(project)
      return {
        projectId: String(project.id),
        projectName: name(project, id),
        bucket: String(project.bucket || 'missing'),
        outcome, outcomeLabel: label, outcomeNote: note,
        eventType: String(project.event_type || ''),
        eventDate: String(project.event_date || ''),
        totalFee: fee(project),
        sentAt: b.booking_sent_at || '',
        openUrl: `${SITE}/book/?t=${b.booking_token}&preview=1`,
        url: `${SITE}/book/?t=${b.booking_token}`,
        views: b.booking_view_count ?? 0,
        firstViewedAt: b.booking_viewed_at || '',
        lastViewedAt: b.booking_last_viewed_at || '',
        variant: String(b.agreement_variant || ''),
      }
    })
    .filter(Boolean)

  return json({
    ok: true,
    items,
    bookings,
    // The two templates, so the phone can show him what a client sees without picking a real
    // client's page to do it with. ?demo=1 is the master copy of the proposal (2026-09-11).
    samples: {
      proposal: `${SITE}/proposal/?demo=1`,
      booking: `${SITE}/book/?demo=1`,
    },
  })
})
