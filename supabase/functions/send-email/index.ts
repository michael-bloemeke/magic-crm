// RECOVERED FROM THE DEPLOYED FUNCTION 2026-08-03. This was live on Supabase but its source had
// never been committed, so nobody could edit it without redeploying blind. Pulled back down verbatim
// (get_edge_function) and committed. Do not edit and forget to deploy, or the two drift again.
//
// Sends an email as Michael via Gmail, from the cloud, so the phone can send with the Mac off.
// Auth: custom (verify_jwt=false so we control CORS + preflight). The caller must present a valid
// Supabase user JWT (the logged-in phone session); we verify it with admin.auth.getUser. Gmail creds
// (client_id/secret + refresh_token) live in the service-role-only email_config table.
//
// REBUILT 2026-10-23 so a phone email goes out IDENTICAL to a Mac one. Michael asked for the phone to
// do everything the Mac does, and the phone composer now has the Mac's templates, signature checkbox,
// replies and attachments. This is a port of the Mac's send path (crm-email-render.mjs
// composeOutgoing + crm-gmail.mjs makeRaw), so keep the two in step:
//   - placeholder chips are stripped to plain text (the last line of defense, like the Mac)
//   - spacing is tightened and the Gmail base font applied (tightenEmailHtml / EMAIL_BASE_STYLE)
//   - the Settings signature is appended ONLY when the body does not already carry the composer's
//     signature block (data-crm-signature), so an email never gets two
//   - template GIFs (<img data-crm-gif="slug">) and data: images are EMBEDDED as cid: inline parts,
//     never linked. The phone's composer shows GIFs from the public `email-gifs` bucket; the bytes
//     ride inside the email exactly as they do from the Mac
//   - attachments are files the phone uploaded to the private `crm-files` bucket, by path
//   - threadId replies INTO that Gmail conversation, with In-Reply-To/References headers
//   - emailId completes that one saved draft row. Without it a NEW sent row is written. The old
//     behaviour (update the latest unsent row with the same project and kind) could overwrite a draft
//     the Mac was still writing, because both use kind 'custom'
//   - the Mac's activity-log line, "Sent email to x.", is written to the project
//
// The plain `body` text path is unchanged, so any old caller still works.
//
// GMAIL DRAFTS (2026-11-10). Gmail drafts are now the CRM's one draft store, phone and Mac alike. With
// a `draftId` the draft is brought up to date and sent with Gmail's own drafts.send, so it leaves
// Drafts the way a Gmail send does. `cc`, `bcc`, `quoteHtml` (a Gmail reply's quoted history) and
// `keepGmailAttachments` (files that live in the draft) travel with it. The email-building code now
// lives in ../_shared/mail.ts, shared with the `gmail` function that SAVES the drafts.
//
// NOTE: the booking chain needs to attach a PDF and runs unattended (no user JWT), so it does its own
// Gmail send inside `booking-complete` rather than calling here. Both read the same email_config row.
import { createClient } from 'jsr:@supabase/supabase-js@2'

import {
  EMAIL_BASE_STYLE, textToHtml, stripMergeFields, tightenEmailHtml, signatureFor, extractGifImages, extractInlineImages,
  makeRaw, normalizeAddresses, gmailJson, replyHeaders, keptGmailAttachments, type Part,
} from '../_shared/mail.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
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
  const to = normalizeAddresses(payload.to)
  const cc = normalizeAddresses(payload.cc)
  const bcc = normalizeAddresses(payload.bcc)
  const draftId = String(payload.draftId || '')
  const quoteHtml = String(payload.quoteHtml || '')
  const keepGmail = Array.isArray(payload.keepGmailAttachments) ? payload.keepGmailAttachments : []
  const subject = String(payload.subject || '').trim()
  const bodyText = String(payload.body || '')
  const bodyHtml = String(payload.html || '')
  const projectId = String(payload.projectId || '')
  const kind = String(payload.kind || 'custom')
  const threadId = String(payload.threadId || '')
  const emailId = String(payload.emailId || '')
  // [{ path, name, size?, type? }] in the crm-files bucket (uploaded by the phone).
  const attachIn = (Array.isArray(payload.attachments) ? payload.attachments : []).filter((a: any) => a && a.path)
  if (!to.length && !cc.length && !bcc.length) return json({ ok: false, error: 'Add at least one valid recipient email.' }, 400)
  if (!subject) return json({ ok: false, error: 'Add a subject.' }, 400)
  const bodyHasText = bodyHtml.replace(/<(?!img)[^>]*>/gi, '').replace(/&nbsp;/gi, ' ').trim() || /<img\b/i.test(bodyHtml)
  if (!bodyText.trim() && !bodyHasText && !attachIn.length && !keepGmail.length) return json({ ok: false, error: 'The email body is empty.' }, 400)

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

  // ---- compose (composeOutgoing) ----
  let crmCfg: any = {}
  try {
    const { data: conf } = await admin.from('crm_config').select('data').eq('id', 1).maybeSingle()
    crmCfg = (conf && conf.data) || {}
  } catch { /* a missing config never blocks a send */ }
  // A Gmail reply's quoted history goes after the body, exactly as the Mac sends it.
  const tightened = tightenEmailHtml(stripMergeFields(bodyHtml.trim() ? bodyHtml : textToHtml(bodyText)) + quoteHtml)
  const inner = tightened + signatureFor(tightened, crmCfg)
  const wrapBase = (h: string) => `<div style="${EMAIL_BASE_STYLE}">${h}</div>`
  const gifs = await extractGifImages(admin, inner)
  const inl = extractInlineImages(gifs.html)
  const sendHtml = wrapBase(inl.html)
  const receiptHtml = wrapBase(inner)

  // ---- attachments ----
  const attachments: Part[] = []
  let total = 0
  for (const a of attachIn) {
    const path = String(a.path)
    if (path.includes('..')) return json({ ok: false, error: 'Bad attachment path.' }, 400)
    const { data, error } = await admin.storage.from('crm-files').download(path)
    if (error || !data) return json({ ok: false, error: `Could not read the attachment "${a.name || path}".` }, 400)
    const bytes = new Uint8Array(await data.arrayBuffer())
    total += bytes.length
    attachments.push({ contentType: String(a.type || data.type || 'application/octet-stream'), bytes, filename: String(a.name || path.split('/').pop()) })
  }
  // Files that live in the Gmail draft itself (added in Gmail, or on an earlier save).
  if (draftId && keepGmail.length) {
    try {
      for (const f of await keptGmailAttachments(tok.access_token, draftId, keepGmail)) {
        total += f.bytes.length
        attachments.push(f)
      }
    } catch (e) {
      return json({ ok: false, error: 'Could not read the attachments in the Gmail draft: ' + ((e as Error)?.message || e) }, 502)
    }
  }
  // Gmail's own ceiling is 25 MB for the whole message, and base64 adds a third.
  if (total > 18 * 1024 * 1024) return json({ ok: false, error: 'The attachments are too large to email (18 MB at most).' }, 400)

  // ---- a reply: find the message it answers so the headers thread it properly everywhere ----
  let reply: { inReplyTo: string; references: string } | undefined
  if (threadId) {
    try {
      reply = await replyHeaders(tok.access_token, threadId)
    } catch { /* still sends; Gmail threads it by threadId */ }
  }

  // ---- send ----
  const from = cfg.sender ? `"Michael Bloemeke" <${cfg.sender}>` : 'me'
  const raw = makeRaw({ from, to, cc, bcc, subject, html: sendHtml, inline: [...gifs.images, ...inl.images], attachments, reply })
  const message = threadId ? { raw, threadId } : { raw }
  // deno-lint-ignore no-explicit-any
  let sent: any
  try {
    if (draftId) {
      // Bring the Gmail draft up to date, then send it as Gmail would: it leaves Drafts.
      await gmailJson(tok.access_token, `drafts/${encodeURIComponent(draftId)}`, { method: 'PUT', body: JSON.stringify({ id: draftId, message }) })
      sent = await gmailJson(tok.access_token, 'drafts/send', { method: 'POST', body: JSON.stringify({ id: draftId }) })
    } else {
      sent = await gmailJson(tok.access_token, 'messages/send', { method: 'POST', body: JSON.stringify(message) })
    }
  } catch (e) {
    return json({ ok: false, error: 'Gmail rejected the send: ' + ((e as Error)?.message || e) }, 502)
  }

  // ---- record it ----
  const nowIso = new Date().toISOString()
  const attachRecord = attachIn.map((a: any) => ({ source: 'cloud', name: String(a.name || String(a.path).split('/').pop()), id: String(a.path), size: Number(a.size) || undefined }))
  const row: Record<string, unknown> = {
    project_id: projectId, kind, to: [...to, ...cc], subject, body: receiptHtml, format: 'html', status: 'sent', sent_at: nowIso, updated_at: nowIso,
    thread_id: sent.threadId || '', attachments: attachRecord,
  }
  if (payload.threadSubject) row.thread_subject = String(payload.threadSubject)
  let savedId: string | null = null
  if (projectId) {
    if (emailId) {
      await admin.from('emails').update(row).eq('id', emailId)
      savedId = emailId
    } else {
      const id = crypto.randomUUID()
      await admin.from('emails').insert({ id, created_at: nowIso, ...row })
      savedId = id
    }
    // The Mac's activity-log line for a sent email (crm-emails.mjs: `Sent ${kindLabel(kind)} to ...`).
    try {
      const { data: p } = await admin.from('projects').select('activity_log').eq('id', projectId).maybeSingle()
      if (p) {
        const day = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'long', day: 'numeric', year: 'numeric' })
        await admin.from('projects').update({ activity_log: [`${day}: Sent email to ${[...to, ...cc].join(', ')}.`, ...(p.activity_log || [])], updated_at: nowIso }).eq('id', projectId)
      }
    } catch { /* the send already happened; the log line is best effort */ }
  }
  return json({ ok: true, id: sent.id, threadId: sent.threadId || '', emailId: savedId, sentAt: nowIso })
})
