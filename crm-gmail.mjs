// Real Gmail integration for the CRM (read threads + send / save drafts).
//
// Uses the OAuth "Web application" credential in gmail-credentials.json and
// stores the resulting token in gmail-token.json (both gitignored). The user
// connects once via /api/gmail/auth; after that the refresh token keeps it
// working (Internal app, so no weekly expiry).

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { google } from 'googleapis'
import { loadAll } from './crm-data-core.mjs'
import { resolveProjectEmails } from './crm-links.mjs'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const CREDS_FILE = path.join(DIR, 'gmail-credentials.json')
const TOKEN_FILE = path.join(DIR, 'gmail-token.json')

const SCOPES = [
  // gmail.modify = read + label changes (so the CRM can mark threads read).
  // It supersedes gmail.readonly; reading still works. Adding it requires a
  // one-time reconnect to grant the new permission.
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.send',
]

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function loadCreds() {
  const raw = readJson(CREDS_FILE)
  if (!raw) throw new Error('gmail-credentials.json not found')
  const o = raw.web || raw.installed
  if (!o) throw new Error('unexpected credentials shape')
  const redirect = (o.redirect_uris && o.redirect_uris[0]) || 'http://localhost:5199/api/gmail/callback'
  return { clientId: o.client_id, clientSecret: o.client_secret, redirect }
}

function makeClient() {
  const { clientId, clientSecret, redirect } = loadCreds()
  return new google.auth.OAuth2(clientId, clientSecret, redirect)
}

export function credentialsPresent() {
  return fs.existsSync(CREDS_FILE)
}

export function isConnected() {
  const t = readJson(TOKEN_FILE)
  return !!(t && t.refresh_token)
}

export function getAuthUrl() {
  const client = makeClient()
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  })
}

export async function exchangeCode(code) {
  const client = makeClient()
  const { tokens } = await client.getToken(code)
  // Preserve an existing refresh_token if Google omits it on re-consent.
  const prev = readJson(TOKEN_FILE) || {}
  const merged = { ...prev, ...tokens }
  if (!merged.refresh_token && prev.refresh_token) merged.refresh_token = prev.refresh_token
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(merged, null, 2))
  return { ok: true }
}

function authedClient() {
  const tokens = readJson(TOKEN_FILE)
  if (!tokens || !tokens.refresh_token) throw new Error('Gmail not connected')
  const client = makeClient()
  client.setCredentials(tokens)
  // Persist refreshed tokens.
  client.on('tokens', (t) => {
    const cur = readJson(TOKEN_FILE) || {}
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ ...cur, ...t }, null, 2))
  })
  return client
}

function api() {
  return google.gmail({ version: 'v1', auth: authedClient() })
}

let cachedEmail = null
async function myEmail() {
  if (cachedEmail) return cachedEmail
  const res = await api().users.getProfile({ userId: 'me' })
  cachedEmail = res.data.emailAddress || 'michael@michaelbloemeke.com'
  return cachedEmail
}

// ---- Reading ----------------------------------------------------------------

function header(payload, name) {
  const h = (payload.headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase())
  return h ? h.value : ''
}

function decodeB64(data) {
  try {
    return Buffer.from(data, 'base64url').toString('utf8')
  } catch {
    return ''
  }
}

function htmlToText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ') // drop CSS blocks (the @font-face / @media junk)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|tr|table|h[1-6]|li|ul|ol)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ') // remaining tags
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&(?:#39|apos);/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCodePoint(Number(n))
      } catch {
        return ''
      }
    })
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Drop quoted reply history (the thread already shows prior messages separately).
function trimQuoted(text) {
  text = text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
  const markers = [
    /\nOn [\s\S]{0,300}?wrote:/, // "On <date>, <name> wrote:" even when it wraps lines
    /\n>{1,}\s/, // first quoted line (> ...)
    /\n_{5,}/,
    /\n-{3,}\s*Original Message/i,
    /\n-{2,} Forwarded message/i,
    /\nFrom:\s.+\nSent:\s/i,
  ]
  let cut = text.length
  for (const re of markers) {
    const m = text.match(re)
    if (m && m.index != null && m.index < cut) cut = m.index
  }
  let out = text.slice(0, cut).trim()
  if (out.length > 6000) out = out.slice(0, 6000).trim() + '\n…'
  return out
}

function plainText(payload) {
  if (!payload) return ''
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    const t = decodeB64(payload.body.data).trim()
    if (t) return t
  }
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    const t = htmlToText(decodeB64(payload.body.data))
    if (t) return t
  }
  if (payload.parts) {
    for (const p of payload.parts) {
      const t = plainText(p)
      if (t) return t
    }
  }
  return ''
}

function nameFromAddr(addr) {
  const m = String(addr).match(/^\s*"?([^"<]+?)"?\s*</)
  if (m) return m[1].trim()
  return String(addr).replace(/[<>]/g, '').trim()
}
function emailFromAddr(addr) {
  const m = String(addr).match(/<([^>]+)>/)
  return (m ? m[1] : String(addr)).trim().toLowerCase()
}
// A To/Cc header may list several recipients; pull every address out.
function emailsFromHeader(val) {
  return String(val || '')
    .split(',')
    .map((s) => emailFromAddr(s))
    .filter((e) => e.includes('@'))
}
function fmt(internalDate) {
  const d = new Date(Number(internalDate))
  if (isNaN(d.getTime())) return ''
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`
}

// Build a normalized thread object from a full threads.get response.
function buildThread(full, me) {
  const msgs = full.data.messages || []
  if (msgs.length === 0) return null
  const subject = header(msgs[0].payload, 'Subject') || '(no subject)'
  const messages = msgs.map((m) => {
    const from = header(m.payload, 'From')
    return {
      from: emailFromAddr(from),
      fromName: nameFromAddr(from) || emailFromAddr(from),
      date: fmt(m.internalDate),
      ts: Number(m.internalDate) || 0,
      body: trimQuoted(plainText(m.payload)) || (m.snippet || ''),
      unread: Array.isArray(m.labelIds) && m.labelIds.includes('UNREAD'),
    }
  })
  // Participants = everyone on From/To/Cc across the thread (minus Michael),
  // so a contact who only RECEIVED mail still tags the thread to their project.
  const partSet = new Set()
  for (const m of msgs) {
    for (const h of ['From', 'To', 'Cc']) {
      for (const e of emailsFromHeader(header(m.payload, h))) {
        if (e && e !== me) partSet.add(e)
      }
    }
  }
  const participants = Array.from(partSet)
  participants.push(me)
  return {
    id: full.data.id,
    subject,
    participants,
    lastDate: messages[messages.length - 1].date,
    lastTs: Math.max(...messages.map((m) => m.ts), 0),
    unread: messages.filter((m) => m.unread).length,
    messages,
  }
}

export async function searchThreads(contactEmails, max = 10) {
  const emails = (contactEmails || []).filter(Boolean)
  if (emails.length === 0) return []
  const me = (await myEmail()).toLowerCase()
  const q = emails.map((e) => `from:${e} OR to:${e}`).join(' OR ')
  const gmail = api()
  const list = await gmail.users.threads.list({ userId: 'me', q, maxResults: max })
  const threads = list.data.threads || []
  const out = []
  for (const t of threads) {
    const full = await gmail.users.threads.get({ userId: 'me', id: t.id, format: 'full' })
    const thread = buildThread(full, me)
    if (thread) out.push(thread)
  }
  // Most-recent thread first (used by the project tab and the Inbox).
  out.sort((a, b) => b.lastTs - a.lastTs)
  return out
}

// Run async fn over items with bounded concurrency (keeps Gmail fan-out fast
// without firing all requests at once and tripping rate limits).
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

// Inbox search across MANY contacts. Two costs to control: (1) Gmail silently
// returns nothing for very long `q` strings, so addresses are batched into small
// chunks; (2) a full thread fetch downloads every message body, so we first
// collect candidate thread IDs cheaply (threads.list, no bodies), dedup them,
// then fetch full bodies for a bounded number of unique threads with bounded
// concurrency. The connected result is cached briefly by the comms layer.
const INBOX_FETCH_CAP = 120 // hard ceiling on full-thread GETs per load (bounds quota)
const INBOX_CONCURRENCY = 8

export async function inboxSearch(contactEmails, cap = 100) {
  const emails = Array.from(new Set((contactEmails || []).filter(Boolean)))
  if (emails.length === 0) return []
  const me = (await myEmail()).toLowerCase()
  const gmail = api()
  const CHUNK = 6 // ~6 addresses keeps each query well under Gmail's limit

  // 1) Cheap pass: gather unique candidate thread IDs (threads.list returns no bodies).
  const ids = []
  const seen = new Set()
  for (let i = 0; i < emails.length; i += CHUNK) {
    const chunk = emails.slice(i, i + CHUNK)
    const q = chunk.map((e) => `from:${e} OR to:${e}`).join(' OR ')
    try {
      const list = await gmail.users.threads.list({ userId: 'me', q, maxResults: 50 })
      for (const t of list.data.threads || []) {
        if (!seen.has(t.id)) {
          seen.add(t.id)
          ids.push(t.id)
        }
      }
    } catch {
      // skip a chunk that errors; the rest still load
    }
  }
  if (ids.length > INBOX_FETCH_CAP) {
    console.warn(`[crm-gmail] inbox: ${ids.length} candidate threads, fetching the most recent ${INBOX_FETCH_CAP}`)
  }

  // 2) Expensive pass: fetch full bodies for the (bounded, deduped) candidates,
  //    in parallel with a concurrency cap.
  const fetched = await mapLimit(ids.slice(0, INBOX_FETCH_CAP), INBOX_CONCURRENCY, async (id) => {
    try {
      const full = await gmail.users.threads.get({ userId: 'me', id, format: 'full' })
      return buildThread(full, me)
    } catch {
      return null
    }
  })
  return fetched
    .filter(Boolean)
    .sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0))
    .slice(0, cap)
}

// ---- Sending ----------------------------------------------------------------

// A unique MIME boundary string.
function boundary(tag) {
  return `=_${tag}_${crypto.randomBytes(12).toString('hex')}`
}
// base64, wrapped at 76 chars per line (RFC 2045) so long bodies/attachments are valid.
function b64wrap(buf) {
  return (Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8')).toString('base64').replace(/(.{76})/g, '$1\r\n')
}
function encodeText(s) {
  return b64wrap(Buffer.from(String(s ?? ''), 'utf8'))
}

// Build a raw RFC-822 message. Plain text by default; if `html` is given it goes out as a
// multipart/alternative (plain + html); if `attachments` are present everything is wrapped in
// a multipart/mixed. attachments: [{ filename, contentType, contentBase64 }].
function makeRaw({ from, to, subject, body, html, attachments }) {
  const atts = (Array.isArray(attachments) ? attachments : []).filter((a) => a && a.contentBase64)
  const hasHtml = !!(html && String(html).trim())
  const plain = body != null && body !== '' ? String(body) : hasHtml ? htmlToText(String(html)) : ''
  const headers = [`From: ${from}`, `To: ${to}`, `Subject: ${subject}`, 'MIME-Version: 1.0']

  // The message content: a single text/plain part, or a multipart/alternative (plain + html).
  let contentHeader
  let contentBody
  if (hasHtml) {
    const alt = boundary('alt')
    contentHeader = `Content-Type: multipart/alternative; boundary="${alt}"`
    contentBody = [
      `--${alt}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      encodeText(plain),
      '',
      `--${alt}`,
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      encodeText(String(html)),
      '',
      `--${alt}--`,
    ].join('\r\n')
  } else {
    contentHeader = 'Content-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64'
    contentBody = encodeText(plain)
  }

  let msg
  if (atts.length === 0) {
    msg = [...headers, contentHeader, '', contentBody].join('\r\n')
  } else {
    const mixed = boundary('mix')
    const parts = [`${contentHeader}\r\n\r\n${contentBody}`]
    for (const a of atts) {
      const fn = String(a.filename || 'attachment').replace(/["\r\n]/g, '_')
      parts.push(
        [
          `Content-Type: ${a.contentType || 'application/octet-stream'}; name="${fn}"`,
          'Content-Transfer-Encoding: base64',
          `Content-Disposition: attachment; filename="${fn}"`,
          '',
          b64wrap(Buffer.from(String(a.contentBase64), 'base64')),
        ].join('\r\n'),
      )
    }
    const mixedBody = parts.map((p) => `--${mixed}\r\n${p}`).join('\r\n') + `\r\n--${mixed}--`
    msg = [...headers, `Content-Type: multipart/mixed; boundary="${mixed}"`, '', mixedBody].join('\r\n')
  }
  return Buffer.from(msg, 'utf8').toString('base64url')
}

// Recipients see this display name on outgoing mail. The API send sets the From header explicitly,
// which overrides the Gmail account's send-as name, and a bare-address From makes clients show just
// the local-part (e.g. "michael"). So we always send a proper "Name <email>" From.
const SENDER_NAME = 'Michael Bloemeke'
async function fromHeader() {
  return `"${SENDER_NAME}" <${await myEmail()}>`
}

export async function sendMessage({ to, subject, body, html, attachments, threadId }) {
  const from = await fromHeader()
  const raw = makeRaw({ from, to, subject: subject || '(no subject)', body, html, attachments })
  const res = await api().users.messages.send({
    userId: 'me',
    requestBody: threadId ? { raw, threadId } : { raw },
  })
  return { ok: true, id: res.data.id }
}

// Mark a whole thread read (remove the UNREAD label). Needs the gmail.modify
// scope; throws with an insufficient-scope error if the token predates it.
export async function markThreadRead(threadId) {
  if (!threadId) throw new Error('threadId required')
  await api().users.threads.modify({
    userId: 'me',
    id: threadId,
    requestBody: { removeLabelIds: ['UNREAD'] },
  })
  return { ok: true, threadId }
}

// True only if the stored token was granted the modify scope (so we can mark
// read without a failed round-trip). The token response includes `scope`.
export function hasModifyScope() {
  const t = readJson(TOKEN_FILE)
  return !!(t && typeof t.scope === 'string' && t.scope.includes('gmail.modify'))
}

export async function createDraft({ to, subject, body, html, attachments, threadId }) {
  const from = await fromHeader()
  const raw = makeRaw({ from, to, subject: subject || '(no subject)', body, html, attachments })
  const res = await api().users.drafts.create({
    userId: 'me',
    requestBody: { message: threadId ? { raw, threadId } : { raw } },
  })
  return { ok: true, id: res.data.id }
}

// One pass over unread mail, tallied per project (by matching the sender to a
// project's contact email). Used for the unread badges in the flow view.
export async function unreadByProject() {
  // Only active projects get badges; first-wins so a contact shared with an
  // archived/completed project can't steal an active project's unread count.
  const projects = loadAll().projects.filter((p) => p.bucket === 'active')
  const idx = resolveProjectEmails() // projectId -> linked contacts' emails
  const emailToId = {}
  for (const p of projects) {
    for (const e of idx[p.id] || []) {
      if (!emailToId[e]) emailToId[e] = p.id
    }
  }
  const gmail = api()
  const res = await gmail.users.messages.list({ userId: 'me', q: 'is:unread', maxResults: 60 })
  const msgs = res.data.messages || []
  const counts = {}
  for (const m of msgs) {
    const full = await gmail.users.messages.get({
      userId: 'me',
      id: m.id,
      format: 'metadata',
      metadataHeaders: ['From'],
    })
    const from = emailFromAddr(header(full.data.payload, 'From'))
    const pid = emailToId[from]
    if (pid) counts[pid] = (counts[pid] || 0) + 1
  }
  return counts
}
