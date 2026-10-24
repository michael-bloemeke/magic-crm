// THE PHONE'S SERVER-SIDE HALF. Built 2026-10-23, when Michael asked for the phone app to have
// everything the Mac app has: "I want to be able to make it so that I'm very comfortable doing
// everything just from my phone."
//
// WHY ONE FUNCTION WITH ACTIONS. The Mac does all of this inside its local Node plugin
// (crm-data-plugin.mjs), with credentials that only exist on the MacBook. The phone can read and write
// most CRM tables itself through RLS, but a few things need a secret it must never hold:
//   - QuickBooks (quickbooks_config, service-role only)       -> finance-qbo
//   - Google Calendar (email_config's Google token)            -> calendar-events, calendar-invite
//   - calendar_alert_state (service-role only by design)       -> alert-state
//   - widget_tokens (service-role only)                        -> widget-token, widget-revoke
// Each action mirrors one Mac endpoint and returns the same shape, so the phone's screens can be
// straight ports of the Mac's. New phone-only server needs go here as new actions rather than as new
// functions, so there is one auth check and one place to look.
//
// AUTH: verify_jwt is off so CORS preflight works (same as `gmail` and `send-email`); the caller must
// present the signed-in phone session, checked with admin.auth.getUser before anything else runs.
//
// ⚠️ THE MAC IS NOT CHANGED BY ANY OF THIS. It keeps its own paths. Where both touch the same row
// (the QuickBooks token), this function follows the same rules as booking-complete: reuse a live access
// token, and write a rotated refresh token straight back.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { financeQbo, calendarEvents, calendarInvite, googleToken } from './logic.ts'
import { proposalStatus, proposalStart, proposalPublish, proposalDraftEmail, proposalRetire, proposalResetViews } from './proposals.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
}


// ---------------------------------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405)
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
  if (!jwt) return json({ ok: false, error: 'Not signed in.' }, 401)
  const { data: userData, error: userErr } = await admin.auth.getUser(jwt)
  if (userErr || !userData?.user) return json({ ok: false, error: 'Invalid session.' }, 401)

  let b: any
  try { b = await req.json() } catch { return json({ ok: false, error: 'Bad JSON.' }, 400) }
  const action = String(b.action || '')
  try {
    switch (action) {
      case 'finance-qbo':
        // Never fail the Finance page over QuickBooks: it degrades to the CRM's own figures.
        try { return json(await financeQbo(admin)) } catch (e) { return json({ ok: false, connected: false, reason: String((e as Error)?.message || e) }) }
      case 'calendar-events':
        return json(await calendarEvents(admin, String(b.from || ''), String(b.to || '')))
      case 'calendar-invite':
        return json(await calendarInvite(admin, b))
      case 'alert-state': {
        const { data } = await admin.from('calendar_alert_state').select('*').eq('id', 1).maybeSingle()
        return json({ ok: true, state: data || null })
      }
      // Proposals (the Mac's ProposalCard). `proposals` is service-role only, hence here.
      case 'proposal-status': return json(await proposalStatus(admin, String(b.projectId || '')))
      case 'proposal-start': return json(await proposalStart(admin, String(b.projectId || '')))
      case 'proposal-publish': return json(await proposalPublish(admin, String(b.projectId || ''), () => googleToken(admin)))
      case 'proposal-email': return json(await proposalDraftEmail(admin, String(b.projectId || ''), () => googleToken(admin)))
      case 'proposal-retire': return json(await proposalRetire(admin, String(b.projectId || '')))
      case 'proposal-reset': return json(await proposalResetViews(admin, String(b.projectId || '')))
      // Home-screen widgets (2026-10-24). The signed-in app mints a read-only widget key and hands it
      // to the widget extension; only its SHA-256 is stored. See widget-feed and widget_tokens.
      case 'widget-token': {
        const bytes = crypto.getRandomValues(new Uint8Array(32))
        const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))), (x) => x.toString(16).padStart(2, '0')).join('')
        const { error } = await admin.from('widget_tokens').insert({ token_hash: hash, label: String(b.label || 'iPhone widgets').slice(0, 80) })
        if (error) throw error
        return json({ ok: true, token })
      }
      case 'widget-revoke': {
        const { error } = await admin.from('widget_tokens').update({ revoked: true }).eq('revoked', false)
        if (error) throw error
        return json({ ok: true })
      }
      default:
        return json({ ok: false, error: `Unknown action "${action}".` }, 400)
    }
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500)
  }
})
