// EMAIL BUILDING FOR THE CLOUD, shared by `send-email` and `gmail` (2026-11-10).
//
// One copy, because two cloud functions now build email: `send-email` sends it, and `gmail` saves
// Gmail DRAFTS for the phone (Gmail drafts are the CRM's one draft store, on the Mac and the phone
// alike). This is a port of the Mac's Node code, so keep it in step with:
//   - crm-email-render.mjs  (composeOutgoing: chips stripped, spacing tightened, base font, signature)
//   - crm-gmail.mjs         (makeRaw)
//   - crm-drafts.mjs        (reading a draft back: inline pictures, the quoted history, attachments)

export type Part = { cid?: string; contentType: string; bytes: Uint8Array; filename: string }

// ---- composeOutgoing -------------------------------------------------------------------------------
const PARA_STYLE = 'margin:0 0 12px 0'
const BLANK_SPACER = '<div style="margin:0;line-height:12px;font-size:1px">&nbsp;</div>'
const LINK_STYLE = 'color:#1155cc;text-decoration:underline'
export const EMAIL_BASE_STYLE = 'font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222222'

export function escHtml(s: string) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
// Plain text -> simple HTML (blank line = paragraph, single newline = <br>).
export function textToHtml(t: string) {
  return String(t || '')
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((p) => '<p>' + escHtml(p).replace(/\n/g, '<br>') + '</p>')
    .join('')
}
export function stripMergeFields(html: string) {
  return String(html || '').replace(/<span\b[^>]*\bclass="[^"]*\bmerge-field\b[^"]*"[^>]*>([\s\S]*?)<\/span>/gi, (_, inner) => inner)
}
export function tightenEmailHtml(html: string) {
  let s = String(html || '')
  if (!s) return s
  s = s.replace(/>\s+</g, '><')
  s = s.replace(/<(p|div)\b([^>]*)>(?:\s|&nbsp;|<br\s*\/?>)*<\/\1>/gi, (m, _tag, attrs) => (/border|background/i.test(attrs) ? m : BLANK_SPACER))
  s = s.replace(/<p(?![^>]*\bstyle=)([^>]*)>/gi, `<p$1 style="${PARA_STYLE}">`)
  s = s.replace(/<a(?![^>]*\bstyle=)([^>]*)>/gi, `<a$1 style="${LINK_STYLE}">`)
  return s
}
// deno-lint-ignore no-explicit-any
export function signatureFor(tightened: string, cfg: any) {
  if (String(tightened || '').includes('data-crm-signature')) return ''
  // A draft started in Gmail carries Gmail's own signature block. That IS a signature too.
  if (String(tightened || '').includes('gmail_signature')) return ''
  if (!cfg || !cfg.signatureEnabled) return ''
  const sig = tightenEmailHtml(String(cfg.signatureHtml || ''))
  return sig ? `<div style="margin-top:16px">${sig}</div>` : ''
}
export function htmlToText(html: string) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Template GIFs: <img data-crm-gif="slug"> -> cid: inline part with the GIF bytes from `email-gifs`.
// Kept per warm instance, so a burst of draft autosaves does not download the same GIF each time.
const gifCache = new Map<string, Uint8Array>()
// deno-lint-ignore no-explicit-any
export async function extractGifImages(admin: any, html: string) {
  const tags = String(html || '').match(/<img\b[^>]*>/gi) || []
  const images: Part[] = []
  let out = html
  let n = 0
  for (const tag of tags) {
    const m = /\bdata-crm-gif="([^"]+)"/i.exec(tag)
    if (!m || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(m[1])) continue
    let bytes = gifCache.get(m[1])
    if (!bytes) {
      const { data, error } = await admin.storage.from('email-gifs').download(m[1] + '.gif')
      if (error || !data) continue // left as-is rather than shipping a broken cid
      bytes = new Uint8Array(await data.arrayBuffer())
      gifCache.set(m[1], bytes)
    }
    const cid = `gif${n++}@magic-crm`
    images.push({ cid, contentType: 'image/gif', bytes, filename: m[1] + '.gif' })
    const next = /\bsrc="[^"]*"/i.test(tag) ? tag.replace(/\bsrc="[^"]*"/i, `src="cid:${cid}"`) : tag.replace(/^<img\b/i, `<img src="cid:${cid}"`)
    out = out.replace(tag, next)
  }
  return { html: out, images }
}
// data: images (a signature logo, a picture pasted in) -> cid: inline parts, because Gmail strips
// data: images on receipt and cannot show them in a draft either.
export function extractInlineImages(html: string) {
  const images: Part[] = []
  let n = 0
  const out = String(html || '').replace(/(<img\b[^>]*\bsrc=")data:([^;"]+);base64,([^"]+)(")/gi, (_m, pre, contentType, b64s, post) => {
    const cid = `sig${n++}@magic-crm`
    const ext = (String(contentType).split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '')
    images.push({ cid, contentType, bytes: fromB64(b64s), filename: `signature-${n}.${ext}` })
    return `${pre}cid:${cid}${post}`
  })
  return { html: out, images }
}

// ---- makeRaw ---------------------------------------------------------------------------------------
export function bytesB64(bytes: Uint8Array) {
  let bin = ''
  const CH = 0x8000
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode(...bytes.subarray(i, i + CH))
  return btoa(bin)
}
export function fromB64(s: string) {
  const std = String(s || '').replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(atob(std + '==='.slice((std.length + 3) % 4)), (c) => c.charCodeAt(0))
}
const enc = (s: string) => new TextEncoder().encode(s)
const wrap76 = (b64s: string) => b64s.replace(/(.{76})/g, '$1\r\n')
const b64text = (s: string) => wrap76(bytesB64(enc(String(s ?? ''))))
function boundary(tag: string) {
  const r = crypto.getRandomValues(new Uint8Array(12))
  return `=_${tag}_${Array.from(r, (b) => b.toString(16).padStart(2, '0')).join('')}`
}
export function encodeHeader(s: string) {
  return /^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + bytesB64(enc(s)) + '?='
}
function safeName(s: string) {
  return String(s || 'attachment').replace(/["\r\n]/g, '_')
}
export function makeRaw(o: {
  from: string
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  html: string
  inline: Part[]
  attachments: Part[]
  // `references` is the FULL chain, already ending in inReplyTo.
  reply?: { inReplyTo: string; references: string }
}) {
  const headers = [`From: ${o.from}`, `To: ${o.to.join(', ')}`]
  if (o.cc && o.cc.length) headers.push(`Cc: ${o.cc.join(', ')}`)
  // Bcc rides in the raw message; Gmail delivers to it and strips the header from what others see.
  if (o.bcc && o.bcc.length) headers.push(`Bcc: ${o.bcc.join(', ')}`)
  headers.push(`Subject: ${encodeHeader(o.subject)}`)
  // A reply carries In-Reply-To and References so every mail client files it in the same
  // conversation, not just Gmail (which also needs the threadId on the request).
  if (o.reply && o.reply.inReplyTo) {
    headers.push(`In-Reply-To: ${o.reply.inReplyTo.replace(/[\r\n]/g, '')}`, `References: ${(o.reply.references || o.reply.inReplyTo).replace(/[\r\n]/g, ' ')}`)
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

export function normalizeAddresses(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : String(v || '').split(/[,;]/)
  return arr.map((s) => String(s).trim()).filter((s) => /.+@.+\..+/.test(s))
}

// ---- Gmail REST, with an access token ------------------------------------------------------------
export const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me/'
// deno-lint-ignore no-explicit-any
export async function gmailJson(token: string, path: string, init: RequestInit = {}): Promise<any> {
  const r = await fetch(GMAIL + path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers || {}) },
  })
  const text = await r.text()
  // deno-lint-ignore no-explicit-any
  let j: any = {}
  try { j = text ? JSON.parse(text) : {} } catch { /* empty body */ }
  if (!r.ok) throw new Error(j?.error?.message || `Gmail ${r.status}`)
  return j
}

// deno-lint-ignore no-explicit-any
function hdr(payload: any, name: string): string {
  const h = (payload?.headers || []).find((x: { name: string }) => String(x.name).toLowerCase() === name.toLowerCase())
  return h ? String(h.value || '') : ''
}

// In-Reply-To and References for a new message in a thread: the last SENT message's Message-ID,
// appended to its References chain.
export async function replyHeaders(token: string, threadId: string) {
  const th = await gmailJson(token, `threads/${encodeURIComponent(threadId)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=Message-Id&metadataHeaders=References`)
  // deno-lint-ignore no-explicit-any
  const sent = (th.messages || []).filter((m: any) => !(m.labelIds || []).includes('DRAFT'))
  const last = sent[sent.length - 1]
  if (!last) return { inReplyTo: '', references: '' }
  const mid = hdr(last.payload, 'Message-ID') || hdr(last.payload, 'Message-Id')
  return { inReplyTo: mid, references: [hdr(last.payload, 'References'), mid].filter(Boolean).join(' ').trim() }
}

// Draft id for each draft MESSAGE id. A thread fetch shows a draft as a message; editing or sending
// it needs the DRAFT id, and drafts.list is the only map from one to the other.
export async function draftIdsByMessage(token: string) {
  const map = new Map<string, string>()
  let pageToken = ''
  do {
    const r = await gmailJson(token, `drafts?maxResults=500${pageToken ? `&pageToken=${pageToken}` : ''}`)
    for (const d of r.drafts || []) if (d.message?.id) map.set(d.message.id, d.id)
    pageToken = r.nextPageToken || ''
  } while (pageToken)
  return map
}

// ---- reading a draft back -----------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
function walk(part: any, fn: (p: any) => void) {
  if (!part) return
  fn(part)
  for (const p of part.parts || []) walk(p, fn)
}
// deno-lint-ignore no-explicit-any
const cidOf = (part: any) => hdr(part, 'Content-ID').replace(/^<|>$/g, '').trim()
// deno-lint-ignore no-explicit-any
async function partBytes(token: string, messageId: string, part: any): Promise<Uint8Array> {
  if (part.body?.data) return fromB64(part.body.data)
  if (part.body?.attachmentId) {
    const r = await gmailJson(token, `messages/${messageId}/attachments/${part.body.attachmentId}`)
    return fromB64(r.data || '')
  }
  return new Uint8Array()
}
const decodeText = (b64url: string) => new TextDecoder().decode(fromB64(b64url))

// Gmail's quoted history in a reply. Everything from the first gmail_quote container onward.
export function splitQuote(html: string) {
  const s = String(html || '')
  const m = /<div\b[^>]*\bclass="[^"]*\bgmail_quote\b[^"]*"[^>]*>/i.exec(s)
  if (!m) return { body: s, quote: '' }
  return { body: s.slice(0, m.index), quote: s.slice(m.index) }
}

// Everything a composer needs to show and edit a draft. `gifBase` is where THIS device loads template
// GIFs from (the phone uses the public bucket), so they animate in its editor.
export async function readDraft(token: string, draftId: string, gifBase: string) {
  const r = await gmailJson(token, `drafts/${encodeURIComponent(draftId)}?format=full`)
  const msg = r.message || {}
  const payload = msg.payload || {}
  let html = ''
  let text = ''
  // deno-lint-ignore no-explicit-any
  const inline: any[] = []
  // deno-lint-ignore no-explicit-any
  const attachments: any[] = []
  walk(payload, (part) => {
    const type = String(part.mimeType || '').toLowerCase()
    const disposition = hdr(part, 'Content-Disposition').toLowerCase()
    const isAttachment = !!part.filename || disposition.startsWith('attachment')
    if (!isAttachment && type === 'text/html' && !html && part.body?.data) html = decodeText(part.body.data)
    else if (!isAttachment && type === 'text/plain' && !text && part.body?.data) text = decodeText(part.body.data)
    else if (cidOf(part)) inline.push(part)
    else if (isAttachment) attachments.push(part)
  })
  const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)
  let body = html ? (bodyMatch ? bodyMatch[1] : html).replace(/<head\b[\s\S]*?<\/head>/gi, '').replace(/<\/?html\b[^>]*>/gi, '').trim() : textToHtml(text)
  for (const part of inline) {
    const cid = cidOf(part)
    if (!body.includes(`cid:${cid}`)) { attachments.push(part); continue }
    const bytes = await partBytes(token, msg.id, part)
    body = body.split(`cid:${cid}`).join(`data:${part.mimeType || 'application/octet-stream'};base64,${bytesB64(bytes)}`)
  }
  // Template GIFs load from this device's own source rather than a megabyte data: URI.
  body = body.replace(/<img\b[^>]*\bdata-crm-gif="([a-z0-9-]+)"[^>]*>/gi, (tag, slug) =>
    /\bsrc="[^"]*"/i.test(tag) ? tag.replace(/\bsrc="[^"]*"/i, `src="${gifBase}${slug}.gif"`) : tag)
  const { body: editable, quote } = splitQuote(body)
  return {
    draftId: r.id,
    messageId: msg.id || '',
    threadId: msg.threadId || '',
    to: hdr(payload, 'To'),
    cc: hdr(payload, 'Cc'),
    bcc: hdr(payload, 'Bcc'),
    subject: hdr(payload, 'Subject'),
    html: editable,
    quoteHtml: quote,
    gmailAttachments: attachments
      .filter((p) => p.filename || cidOf(p))
      .map((p) => ({ name: p.filename || cidOf(p), size: Number(p.body?.size) || 0, contentType: p.mimeType || '' })),
    inReplyTo: hdr(payload, 'In-Reply-To'),
    references: hdr(payload, 'References'),
  }
}

// The files a Gmail draft already holds, by name, read from its CURRENT version (each save gives the
// draft a new message id, and new attachment ids with it).
export async function keptGmailAttachments(token: string, draftId: string, keep: { name: string }[]): Promise<Part[]> {
  const names = new Set((keep || []).map((k) => k && k.name).filter(Boolean))
  if (!draftId || names.size === 0) return []
  const r = await gmailJson(token, `drafts/${encodeURIComponent(draftId)}?format=full`)
  const msg = r.message || {}
  // deno-lint-ignore no-explicit-any
  const parts: any[] = []
  walk(msg.payload, (p) => {
    if (p.filename && names.has(p.filename)) parts.push(p)
  })
  const out: Part[] = []
  for (const p of parts) {
    out.push({ contentType: p.mimeType || 'application/octet-stream', bytes: await partBytes(token, msg.id, p), filename: p.filename })
  }
  return out
}
