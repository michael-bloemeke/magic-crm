// THE FEED BEHIND THE iPHONE HOME-SCREEN WIDGETS (2026-10-24).
//
// Michael asked for three large widgets (tasks, the next 7 days of gigs, unread client email) so his
// CRM is "always at the front of my brain". Widgets run in their own process on the phone, outside
// the app, so they cannot borrow the app's Supabase session: refreshing it from a second process
// would rotate the refresh token underneath the app and sign it out. Instead the SIGNED-IN app asks
// phone-api ("widget-token") to mint a random key, keeps it in the shared App Group, and the widgets
// send it here as `x-widget-token`. Only the key's SHA-256 is stored, in `widget_tokens`.
//
// WHAT A KEY CAN DO: read this feed, and nothing else. No writes, no other tables, no settings.
// Revoke with phone-api "widget-revoke" (Settings on the phone) or by setting revoked = true.
//
// verify_jwt is off (the caller has no JWT); the key check below is the gate and runs first.
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { googleToken, financeQbo } from '../phone-api/logic.ts'
import { buildFeed } from './feed.ts'

const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers })

// QuickBooks figures for the money widgets, kept for ten minutes on a warm instance. Several widgets
// refresh close together and the numbers barely move inside ten minutes; this keeps the QuickBooks
// calls (and its token rotation, shared with the Mac) to a trickle.
let qboCache: { at: number; data: unknown } | null = null
async function cachedQbo(admin: any) {
  if (qboCache && Date.now() - qboCache.at < 10 * 60 * 1000) return qboCache.data
  const data = await financeQbo(admin)
  qboCache = { at: Date.now(), data }
  return data
}

async function sha256(s: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, '0')).join('')
}

Deno.serve(async (req) => {
  if (req.method !== 'GET' && req.method !== 'POST') return json({ ok: false, error: 'GET or POST only' }, 405)
  const key = (req.headers.get('x-widget-token') || '').trim()
  if (!key || key.length < 20 || key.length > 200) return json({ ok: false, error: 'Missing widget key.' }, 401)
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const hash = await sha256(key)
  const { data: row, error } = await admin.from('widget_tokens').select('id,revoked').eq('token_hash', hash).maybeSingle()
  if (error) return json({ ok: false, error: 'Could not check the widget key.' }, 500)
  if (!row || row.revoked) return json({ ok: false, error: 'This widget key is not valid. Open Bloom CRM to reconnect.' }, 401)
  // Best effort: when the widgets last checked in, visible from the database if ever needed.
  admin.from('widget_tokens').update({ last_used_at: new Date().toISOString() }).eq('id', row.id).then(() => {}, () => {})
  try {
    return json(await buildFeed(admin, () => googleToken(admin), () => cachedQbo(admin)))
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500)
  }
})
