// RECOVERED FROM THE DEPLOYED FUNCTION 2026-08-03. This was live on Supabase but its source had
// never been committed, so nobody could edit it without redeploying blind. Pulled back down verbatim
// (get_edge_function) and committed. Do not edit and forget to deploy, or the two drift again.
//
// Sends an email as Michael via Gmail, from the cloud, so the phone can send with the Mac off.
// Auth: custom (verify_jwt=false so we control CORS + preflight). The caller must present a valid
// Supabase user JWT (the logged-in phone session); we verify it with admin.auth.getUser. Gmail creds
// (client_id/secret + refresh_token) live in the service-role-only email_config table. On success we
// flip the matching draft in `emails` to sent (or insert a sent row).
//
// NOTE: this one sends PLAIN text-to-HTML with no attachments. The booking chain needs to attach a
// PDF and runs unattended (no user JWT), so it does its own Gmail send inside `booking-complete`
// rather than calling here. Both read the same email_config row.
import { createClient } from 'jsr:@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
}

function escHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
// Plain text -> simple, clean HTML email (blank line = paragraph, single newline = <br>).
function textToHtml(t: string) {
  const paras = String(t || '')
    .split(/\n{2,}/)
    .map((p) => '<p style="margin:0 0 12px">' + escHtml(p).replace(/\n/g, '<br>') + '</p>')
    .join('')
  return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222">' + paras + '</div>'
}
function b64(str: string) {
  const bytes = new TextEncoder().encode(str)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}
function b64url(str: string) {
  return b64(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function buildRaw(from: string, to: string[], subject: string, html: string) {
  const bodyB64 = b64(html).replace(/(.{76})/g, '$1\r\n')
  const msg =
    'From: ' + from + '\r\n' +
    'To: ' + to.join(', ') + '\r\n' +
    'Subject: =?UTF-8?B?' + b64(subject) + '?=\r\n' +
    'MIME-Version: 1.0\r\n' +
    'Content-Type: text/html; charset="UTF-8"\r\n' +
    'Content-Transfer-Encoding: base64\r\n' +
    '\r\n' +
    bodyB64
  return b64url(msg)
}
function normalizeTo(to: unknown): string[] {
  const arr = Array.isArray(to) ? to : String(to || '').split(/[,;]/)
  return arr.map((s) => String(s).trim()).filter((s) => /.+@.+\..+/.test(s))
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405)

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  // ---- auth: require a valid logged-in Supabase user ----
  const authHeader = req.headers.get('Authorization') || ''
  const jwt = authHeader.replace(/^Bearer\s+/i, '')
  if (!jwt) return json({ ok: false, error: 'Not signed in.' }, 401)
  const { data: userData, error: userErr } = await admin.auth.getUser(jwt)
  if (userErr || !userData?.user) return json({ ok: false, error: 'Invalid session.' }, 401)

  // ---- input ----
  let payload: any
  try { payload = await req.json() } catch { return json({ ok: false, error: 'Bad JSON.' }, 400) }
  const to = normalizeTo(payload.to)
  const subject = String(payload.subject || '').trim()
  const bodyText = String(payload.body || '')
  const projectId = String(payload.projectId || '')
  const kind = String(payload.kind || 'custom')
  if (!to.length) return json({ ok: false, error: 'Add at least one valid recipient email.' }, 400)
  if (!subject) return json({ ok: false, error: 'Add a subject.' }, 400)
  if (!bodyText.trim()) return json({ ok: false, error: 'The email body is empty.' }, 400)

  // ---- Gmail creds ----
  const { data: cfg, error: cfgErr } = await admin.from('email_config').select('*').eq('id', 1).single()
  if (cfgErr || !cfg) return json({ ok: false, error: 'Email is not configured.' }, 500)

  // ---- refresh token -> access token ----
  const tokRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.client_id,
      client_secret: cfg.client_secret,
      refresh_token: cfg.refresh_token,
      grant_type: 'refresh_token',
    }),
  })
  const tok = await tokRes.json()
  if (!tokRes.ok || !tok.access_token) return json({ ok: false, error: 'Gmail auth failed.' }, 502)

  // ---- build + send ----
  const from = cfg.sender || 'me'
  const html = textToHtml(bodyText)
  const raw = buildRaw(from, to, subject, html)
  const sendRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  })
  const sent = await sendRes.json()
  if (!sendRes.ok) return json({ ok: false, error: 'Gmail rejected the send: ' + (sent?.error?.message || sendRes.status) }, 502)

  // ---- record it: flip the latest matching draft to sent, else insert a sent row ----
  const nowIso = new Date().toISOString()
  const row = { project_id: projectId, kind, to, subject, body: html, format: 'html', status: 'sent', sent_at: nowIso, updated_at: nowIso, thread_id: sent.threadId || '' }
  let emailId: string | null = null
  if (projectId) {
    const { data: existing } = await admin
      .from('emails').select('id').eq('project_id', projectId).eq('kind', kind).neq('status', 'sent')
      .order('updated_at', { ascending: false }).limit(1)
    if (existing && existing.length) {
      await admin.from('emails').update(row).eq('id', existing[0].id)
      emailId = existing[0].id
    } else {
      const id = crypto.randomUUID()
      await admin.from('emails').insert({ id, created_at: nowIso, ...row })
      emailId = id
    }
  }
  return json({ ok: true, id: sent.id, emailId, sentAt: nowIso })
})
