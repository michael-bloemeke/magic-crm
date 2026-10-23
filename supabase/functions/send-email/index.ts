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
// NOTE: the booking chain needs to attach a PDF and runs unattended (no user JWT), so it does its own
// Gmail send inside `booking-complete` rather than calling here. Both read the same email_config row.
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
// Plain text -> simple HTML (blank line = paragraph, single newline = <br>). The old phone path.
function textToHtml(t: string) {
  return String(t || '')
    .split(/\n{2,}/)
    .map((p) => '<p>' + escHtml(p).replace(/\n/g, '<br>') + '</p>')
    .join('')
}

// ---- crm-email-render.mjs, ported --------------------------------------------------------------
const PARA_STYLE = 'margin:0 0 12px 0'
const BLANK_SPACER = '<div style="margin:0;line-height:12px;font-size:1px">&nbsp;</div>'
const LINK_STYLE = 'color:#1155cc;text-decoration:underline'
const EMAIL_BASE_STYLE = 'font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222222'

function stripMergeFields(html: string) {
  return String(html || '').replace(/<span\b[^>]*\bclass="[^"]*\bmerge-field\b[^"]*"[^>]*>([\s\S]*?)<\/span>/gi, (_, inner) => inner)
}
function tightenEmailHtml(html: string) {
  let s = String(html || '')
  if (!s) return s
  s = s.replace(/>\s+</g, '><')
  s = s.replace(/<(p|div)\b([^>]*)>(?:\s|&nbsp;|<br\s*\/?>)*<\/\1>/gi, (m, _tag, attrs) => (/border|background/i.test(attrs) ? m : BLANK_SPACER))
  s = s.replace(/<p(?![^>]*\bstyle=)([^>]*)>/gi, `<p$1 style="${PARA_STYLE}">`)
  s = s.replace(/<a(?![^>]*\bstyle=)([^>]*)>/gi, `<a$1 style="${LINK_STYLE}">`)
  return s
}
function signatureFor(tightened: string, cfg: any) {
  if (String(tightened || '').includes('data-crm-signature')) return ''
  if (!cfg || !cfg.signatureEnabled) return ''
  const sig = tightenEmailHtml(String(cfg.signatureHtml || ''))
  return sig ? `<div style="margin-top:16px">${sig}</div>` : ''
}
function htmlToText(html: string) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

type Part = { cid?: string; contentType: string; bytes: Uint8Array; filename: string }

// Template GIFs: <img data-crm-gif="slug"> -> cid: inline part with the GIF bytes from `email-gifs`.
async function extractGifImages(admin: any, html: string) {
  const tags = String(html || '').match(/<img\b[^>]*>/gi) || []
  const images: Part[] = []
  let out = html
  let n = 0
  for (const tag of tags) {
    const m = /\bdata-crm-gif="([^"]+)"/i.exec(tag)
    if (!m || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(m[1])) continue
    const { data, error } = await admin.storage.from('email-gifs').download(m[1] + '.gif')
    if (error || !data) continue // left as-is rather than shipping a broken cid
    const cid = `gif${n++}@magic-crm`
    images.push({ cid, contentType: 'image/gif', bytes: new Uint8Array(await data.arrayBuffer()), filename: m[1] + '.gif' })
    const next = /\bsrc="[^"]*"/i.test(tag) ? tag.replace(/\bsrc="[^"]*"/i, `src="cid:${cid}"`) : tag.replace(/^<img\b/i, `<img src="cid:${cid}"`)
    out = out.replace(tag, next)
  }
  return { html: out, images }
}
// data: images (a signature logo) -> cid: inline parts, because Gmail strips data: images on receipt.
function extractInlineImages(html: string) {
  const images: Part[] = []
  let n = 0
  const out = String(html || '').replace(/(<img\b[^>]*\bsrc=")data:([^;"]+);base64,([^"]+)(")/gi, (_m, pre, contentType, b64s, post) => {
    const cid = `sig${n++}@magic-crm`
    const ext = (String(contentType).split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '')
    images.push({ cid, contentType, bytes: Uint8Array.from(atob(b64s), (c) => c.charCodeAt(0)), filename: `signature-${n}.${ext}` })
    return `${pre}cid:${cid}${post}`
  })
  return { html: out, images }
}

// ---- crm-gmail.mjs makeRaw, ported ---------------------------------------------------------------
function bytesB64(bytes: Uint8Array) {
  let bin = ''
  const CH = 0x8000
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode(...bytes.subarray(i, i + CH))
  return btoa(bin)
}
const enc = (s: string) => new TextEncoder().encode(s)
const wrap76 = (b64s: string) => b64s.replace(/(.{76})/g, '$1\r\n')
const b64text = (s: string) => wrap76(bytesB64(enc(String(s ?? ''))))
function boundary(tag: string) {
  const r = crypto.getRandomValues(new Uint8Array(12))
  return `=_${tag}_${Array.from(r, (b) => b.toString(16).padStart(2, '0')).join('')}`
}
function encodeHeader(s: string) {
  return /^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + bytesB64(enc(s)) + '?='
}
function safeName(s: string) {
  return String(s || 'attachment').replace(/["\r\n]/g, '_')
}
function makeRaw(o: { from: string; to: string[]; subject: string; html: string; inline: Part[]; attachments: Part[]; reply?: { inReplyTo: string; references: string } }) {
  const headers = [`From: ${o.from}`, `To: ${o.to.join(', ')}`, `Subject: ${encodeHeader(o.subject)}`]
  // A reply carries In-Reply-To and References so every mail client files it in the same
  // conversation, not just Gmail (which also needs the threadId on the send request).
  if (o.reply && o.reply.inReplyTo) {
    headers.push(`In-Reply-To: ${o.reply.inReplyTo}`, `References: ${o.reply.references ? o.reply.references + ' ' : ''}${o.reply.inReplyTo}`)
  }
  headers.push('MIME-Version: 1.0')
  const alt = boundary('alt')
  let content = {
    header: `Content-Type: multipart/alternative; boundary="${alt}"`,
    body: [
      `--${alt}`, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', b64text(htmlToText(o.html)), '',
      `--${alt}`, 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', b64text(o.html), '',
      `--${alt}--`,
    ].join('\r\n'),
  }
  if (o.inline.length) {
    const rel = boundary('rel')
    const parts = o.inline.map((a) => [
      `Content-Type: ${a.contentType}; name="${safeName(a.filename)}"`, 'Content-Transfer-Encoding: base64',
      `Content-ID: <${a.cid}>`, `Content-Disposition: inline; filename="${safeName(a.filename)}"`, '', wrap76(bytesB64(a.bytes)),
    ].join('\r\n'))
    content = {
      header: `Content-Type: multipart/related; boundary="${rel}"`,
      body: [`--${rel}\r\n${content.header}\r\n\r\n${content.body}`, ...parts.map((p) => `--${rel}\r\n${p}`)].join('\r\n') + `\r\n--${rel}--`,
    }
  }
  let msg: string
  if (!o.attachments.length) {
    msg = [...headers, content.header, '', content.body].join('\r\n')
  } else {
    const mixed = boundary('mix')
    const parts = [`${content.header}\r\n\r\n${content.body}`]
    for (const a of o.attachments) {
      parts.push([
        `Content-Type: ${a.contentType || 'application/octet-stream'}; name="${safeName(a.filename)}"`, 'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${safeName(a.filename)}"`, '', wrap76(bytesB64(a.bytes)),
      ].join('\r\n'))
    }
    msg = [...headers, `Content-Type: multipart/mixed; boundary="${mixed}"`, '', parts.map((p) => `--${mixed}\r\n${p}`).join('\r\n') + `\r\n--${mixed}--`].join('\r\n')
  }
  return bytesB64(enc(msg)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
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
  const bodyHtml = String(payload.html || '')
  const projectId = String(payload.projectId || '')
  const kind = String(payload.kind || 'custom')
  const threadId = String(payload.threadId || '')
  const emailId = String(payload.emailId || '')
  // [{ path, name, size?, type? }] in the crm-files bucket (uploaded by the phone).
  const attachIn = (Array.isArray(payload.attachments) ? payload.attachments : []).filter((a: any) => a && a.path)
  if (!to.length) return json({ ok: false, error: 'Add at least one valid recipient email.' }, 400)
  if (!subject) return json({ ok: false, error: 'Add a subject.' }, 400)
  const bodyHasText = bodyHtml.replace(/<(?!img)[^>]*>/gi, '').replace(/&nbsp;/gi, ' ').trim() || /<img\b/i.test(bodyHtml)
  if (!bodyText.trim() && !bodyHasText) return json({ ok: false, error: 'The email body is empty.' }, 400)

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
  const tightened = tightenEmailHtml(stripMergeFields(bodyHtml.trim() ? bodyHtml : textToHtml(bodyText)))
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
  // Gmail's own ceiling is 25 MB for the whole message, and base64 adds a third.
  if (total > 18 * 1024 * 1024) return json({ ok: false, error: 'The attachments are too large to email (18 MB at most).' }, 400)

  // ---- a reply: find the message it answers so the headers thread it properly everywhere ----
  let reply: { inReplyTo: string; references: string } | undefined
  if (threadId) {
    try {
      const tr = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/threads/' + encodeURIComponent(threadId) + '?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References', {
        headers: { Authorization: `Bearer ${tok.access_token}` },
      })
      const th = await tr.json()
      const msgs = (th && th.messages) || []
      const last = msgs.filter((m: any) => !(m.labelIds || []).includes('DRAFT')).pop() || msgs[msgs.length - 1]
      const hdr = (n: string) => ((last && last.payload && last.payload.headers) || []).find((h: any) => String(h.name).toLowerCase() === n.toLowerCase())?.value || ''
      if (last) reply = { inReplyTo: hdr('Message-ID'), references: hdr('References') }
    } catch { /* still sends; Gmail threads it by threadId */ }
  }

  // ---- send ----
  const from = cfg.sender ? `"Michael Bloemeke" <${cfg.sender}>` : 'me'
  const raw = makeRaw({ from, to, subject, html: sendHtml, inline: [...gifs.images, ...inl.images], attachments, reply })
  const sendRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(threadId ? { raw, threadId } : { raw }),
  })
  const sent = await sendRes.json()
  if (!sendRes.ok) return json({ ok: false, error: 'Gmail rejected the send: ' + (sent?.error?.message || sendRes.status) }, 502)

  // ---- record it ----
  const nowIso = new Date().toISOString()
  const attachRecord = attachIn.map((a: any) => ({ source: 'cloud', name: String(a.name || String(a.path).split('/').pop()), id: String(a.path), size: Number(a.size) || undefined }))
  const row: Record<string, unknown> = {
    project_id: projectId, kind, to, subject, body: receiptHtml, format: 'html', status: 'sent', sent_at: nowIso, updated_at: nowIso,
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
        await admin.from('projects').update({ activity_log: [`${day}: Sent email to ${to.join(', ')}.`, ...(p.activity_log || [])], updated_at: nowIso }).eq('id', projectId)
      }
    } catch { /* the send already happened; the log line is best effort */ }
  }
  return json({ ok: true, id: sent.id, threadId: sent.threadId || '', emailId: savedId, sentAt: nowIso })
})
