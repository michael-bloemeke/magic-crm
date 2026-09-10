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
  // calendar = read + write events + list calendars, so the CRM can put gigs on the "Gigs" calendar
  // and tasks on "Work". One Google connection covers both; granting it needs a one-time reconnect.
  'https://www.googleapis.com/auth/calendar',
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

export function authedClient() {
  const tokens = readJson(TOKEN_FILE)
  if (!tokens || !tokens.refresh_token) throw new Error('Google not connected')
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
//
// UNSENT DRAFTS: a Gmail draft carries a To header and lives in the mailbox with the DRAFT label, so
// a `to:`/`from:` thread search returns it exactly like real mail. Left alone it renders as a message
// Michael sent, which is the worst kind of wrong on the pane he uses to check what a client has
// actually received. We keep drafts (knowing an unsent draft is waiting is useful) but flag each one
// so the UI can mark it, and we keep them out of every "when did this thread last move" signal.
//
// We deliberately do NOT filter with `-in:draft` at the query level: Gmail thread search matches a
// thread if ANY message matches, so negating drops whole threads that contain both sent mail and a
// draft reply, hiding real messages. Filtering per message is the only safe place.
// Exported so the draft-handling rules above can be tested against a fixture without a live mailbox
// (drafts come and go, so there is not always a real one to check against).
export function buildThread(full, me) {
  const msgs = full.data.messages || []
  if (msgs.length === 0) return null
  const subject = header(msgs[0].payload, 'Subject') || '(no subject)'
  const messages = msgs.map((m) => {
    const from = header(m.payload, 'From')
    const labels = Array.isArray(m.labelIds) ? m.labelIds : []
    const isDraft = labels.includes('DRAFT')
    return {
      id: m.id,
      from: emailFromAddr(from),
      fromName: nameFromAddr(from) || emailFromAddr(from),
      // A draft's internalDate is when it was last SAVED, not sent. Keep it for ordering but never
      // present it as a send date; the UI shows "Unsent draft" instead.
      date: isDraft ? '' : fmt(m.internalDate),
      ts: Number(m.internalDate) || 0,
      body: trimQuoted(plainText(m.payload)) || (m.snippet || ''),
      unread: !isDraft && labels.includes('UNREAD'),
      starred: labels.includes('STARRED'),
      isDraft,
    }
  })
  // Every thread-level "last activity" signal comes from REAL messages, so an unsent draft can't
  // bump a thread up the list or stamp it with a date nothing was sent on. A thread that is nothing
  // but drafts falls back to the drafts so it still appears.
  const real = messages.filter((m) => !m.isDraft)
  const forRecency = real.length ? real : messages
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
    lastDate: forRecency[forRecency.length - 1].date,
    lastTs: Math.max(...forRecency.map((m) => m.ts), 0),
    unread: messages.filter((m) => m.unread).length,
    starred: messages.some((m) => m.starred),
    // True when an unsent draft is sitting in this thread, so the list can flag it without
    // having to walk every message.
    hasDraft: messages.some((m) => m.isDraft),
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
// multipart/alternative (plain + html); if `inlineImages` are present (e.g. a signature logo the
// html references via cid:) the alternative is wrapped in a multipart/related; if `attachments`
// are present everything is wrapped in a multipart/mixed.
//   attachments:  [{ filename, contentType, contentBase64 }]
//   inlineImages: [{ cid, contentType, contentBase64, filename? }]  (cid referenced as src="cid:..")
export function makeRaw({ from, to, subject, body, html, attachments, inlineImages, replyTo, date }) {
  const atts = (Array.isArray(attachments) ? attachments : []).filter((a) => a && a.contentBase64)
  const inlines = (Array.isArray(inlineImages) ? inlineImages : []).filter((a) => a && a.contentBase64 && a.cid)
  const hasHtml = !!(html && String(html).trim())
  const plain = body != null && body !== '' ? String(body) : hasHtml ? htmlToText(String(html)) : ''
  const headers = [`From: ${from}`, `To: ${to}`]
  if (replyTo) headers.push(`Reply-To: ${replyTo}`)
  headers.push(`Subject: ${subject}`, 'MIME-Version: 1.0')
  if (date) headers.push(`Date: ${date}`)

  // The core content: a single text/plain part, or a multipart/alternative (plain + html).
  // Tracked as { header, body } so it can be nested inside related/mixed wrappers below.
  let content
  if (hasHtml) {
    const alt = boundary('alt')
    content = {
      header: `Content-Type: multipart/alternative; boundary="${alt}"`,
      body: [
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
      ].join('\r\n'),
    }
  } else {
    content = {
      header: 'Content-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64',
      body: encodeText(plain),
    }
  }

  // Inline images (referenced by the html as src="cid:..") wrap the content in multipart/related.
  if (inlines.length > 0 && hasHtml) {
    const rel = boundary('rel')
    const imgParts = inlines.map((a) => {
      const fn = String(a.filename || a.cid || 'image').replace(/["\r\n]/g, '_')
      return [
        `Content-Type: ${a.contentType || 'application/octet-stream'}; name="${fn}"`,
        'Content-Transfer-Encoding: base64',
        `Content-ID: <${a.cid}>`,
        `Content-Disposition: inline; filename="${fn}"`,
        '',
        b64wrap(Buffer.from(String(a.contentBase64), 'base64')),
      ].join('\r\n')
    })
    const relBody =
      [`--${rel}\r\n${content.header}\r\n\r\n${content.body}`, ...imgParts.map((p) => `--${rel}\r\n${p}`)].join('\r\n') +
      `\r\n--${rel}--`
    content = { header: `Content-Type: multipart/related; boundary="${rel}"`, body: relBody }
  }

  let msg
  if (atts.length === 0) {
    msg = [...headers, content.header, '', content.body].join('\r\n')
  } else {
    const mixed = boundary('mix')
    const parts = [`${content.header}\r\n\r\n${content.body}`]
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

export async function sendMessage({ to, subject, body, html, attachments, inlineImages, threadId }) {
  const from = await fromHeader()
  const raw = makeRaw({ from, to, subject: subject || '(no subject)', body, html, attachments, inlineImages })
  const res = await api().users.messages.send({
    userId: 'me',
    requestBody: threadId ? { raw, threadId } : { raw },
  })
  return { ok: true, id: res.data.id }
}

// Drop a message straight into the mailbox (like IMAP APPEND) WITHOUT sending it. The key difference
// from sendMessage: Gmail only rewrites/validates the From header on SEND, so an INSERTED message can
// carry any From it likes. We use this for the website-inquiry alert: a normal self-addressed send
// (michael -> michael) always shows as "me" in the inbox list because Gmail ignores the display name
// on your own send-as address. Inserting with a non-account From (e.g. "Form Fill: Jane" <inquiries@…>)
// makes the inbox show that sender name instead. Lands as unread in the inbox. Requires the
// gmail.insert or gmail.modify scope; the token already holds gmail.modify, so no reconnect is needed.
export async function insertInboxMessage({ from, to, subject, body, html, replyTo, date }) {
  const recipient = to || (await myEmail())
  const raw = makeRaw({ from, to: recipient, subject: subject || '(no subject)', body, html, replyTo, date })
  const res = await api().users.messages.insert({
    userId: 'me',
    internalDateSource: 'dateHeader', // sort by the Date header we set, not the moment of insert
    requestBody: { raw, labelIds: ['INBOX', 'UNREAD'] },
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
  // The badge is served from a 60s cache, so without this it would keep showing mail Michael has
  // just read, which reads as the app being broken rather than as a stale cache.
  invalidateUnreadCache()
  return { ok: true, threadId }
}

// Star / unstar a whole thread: toggles the STARRED label on every message in it. This is what the
// star click in the CRM conversations list does, and it shows up as a star in Gmail too. Needs the
// gmail.modify scope (same as marking read).
export async function starThread(threadId, starred) {
  if (!threadId) throw new Error('threadId required')
  await api().users.threads.modify({
    userId: 'me',
    id: threadId,
    requestBody: starred ? { addLabelIds: ['STARRED'] } : { removeLabelIds: ['STARRED'] },
  })
  return { ok: true, threadId, starred: !!starred }
}

// Star / unstar a single message (the per-message star inside the thread reader). Round-trips to
// Gmail the same way.
export async function starMessage(messageId, starred) {
  if (!messageId) throw new Error('messageId required')
  await api().users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: starred ? { addLabelIds: ['STARRED'] } : { removeLabelIds: ['STARRED'] },
  })
  return { ok: true, messageId, starred: !!starred }
}

// True only if the stored token was granted the modify scope (so we can mark
// read without a failed round-trip). The token response includes `scope`.
export function hasModifyScope() {
  const t = readJson(TOKEN_FILE)
  return !!(t && typeof t.scope === 'string' && t.scope.includes('gmail.modify'))
}

// True only if the stored Google token was granted the calendar scope (older Gmail-only tokens were
// not; they need a one-time reconnect). Lets the calendar UI prompt a reconnect without a failed call.
export function hasCalendarScope() {
  const t = readJson(TOKEN_FILE)
  return !!(t && typeof t.scope === 'string' && t.scope.includes('auth/calendar'))
}

export async function createDraft({ to, subject, body, html, attachments, inlineImages, threadId }) {
  const from = await fromHeader()
  const raw = makeRaw({ from, to, subject: subject || '(no subject)', body, html, attachments, inlineImages })
  const res = await api().users.drafts.create({
    userId: 'me',
    requestBody: { message: threadId ? { raw, threadId } : { raw } },
  })
  // Return the THREAD as well as the draft. Sending a draft keeps its thread, so this id is what
  // later emails reply into, which is how the contract ends up in the same conversation as the
  // booking form rather than starting a new one.
  return { ok: true, id: res.data.id, threadId: res.data.message?.threadId || '' }
}

// One pass over unread mail, tallied per project (by matching the sender to a
// project's contact email). Used for the unread badges in the flow view.
// Unread counts per active project, for the flow-view badges and the bell.
//
// ⚠️ THIS IS THE MOST QUOTA-EXPENSIVE THING IN THE APP, AND IT RUNS ON A TIMER. Read the arithmetic
// before changing it.
//
// The original shape was: list ALL unread (`is:unread`, up to 60), then `messages.get` every one of
// them to read its From header and see whether it belonged to a client. That is 1 + 60 requests and
// 5 + 60x5 = 305 quota units PER CALL, fired back to back. Gmail's ceiling is 250 units per user per
// SECOND, so one call could exceed it on its own, and App.tsx's backgroundRefresh calls this every
// 20 seconds plus on every window focus, per open window. On 2026-09-09 it was returning
// "Quota exceeded ... Units per minute per user" and the bell's unread count was simply broken.
//
// THE FIX IS THE SHAPE OF THE QUERY, not the timer. Nearly all of Michael's unread mail is
// newsletters and noise; only a handful is ever from a client. So instead of fetching every unread
// message to find out who sent it, ASK GMAIL for the intersection: `is:unread from:(the client
// addresses)`. Gmail does the filtering server side and hands back only messages that already
// matter, so the expensive per-message GETs run over a few messages rather than sixty.
//
// Typical cost is now ~10-30 units against the old 305, and a handful of requests against 61.
const UNREAD_CHUNK = 10 // addresses per query; keeps each `from:(...)` well inside Gmail's limit

// Short server-side cache. backgroundRefresh fires on a 20s timer AND on every focus and
// visibility change, so without this a click back into the window costs a full round of quota for a
// badge that cannot meaningfully have changed. Unread is derived live from Gmail and is not stored,
// so a slightly stale count self-corrects on the next pass; that is already how the bell behaves.
const UNREAD_TTL_MS = 60_000
let unreadCache = { at: 0, counts: null }

export async function unreadByProject({ force = false } = {}) {
  if (!force && unreadCache.counts && Date.now() - unreadCache.at < UNREAD_TTL_MS) {
    return unreadCache.counts
  }

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

  const addresses = Object.keys(emailToId)
  console.log('[unread-probe] activeProjects=%d idxKeys=%d addresses=%d', projects.length, Object.keys(idx).length, addresses.length)
  if (addresses.length === 0) {
    unreadCache = { at: Date.now(), counts: {} }
    return {}
  }

  const gmail = api()

  // 1) Cheap pass: ask Gmail which unread messages are from a client at all. One list per chunk of
  //    addresses (5 units each), and the result is already the shortlist.
  const ids = []
  const seen = new Set()
  for (let i = 0; i < addresses.length; i += UNREAD_CHUNK) {
    const chunk = addresses.slice(i, i + UNREAD_CHUNK)
    const q = `is:unread from:{${chunk.join(' ')}}`
    try {
      const list = await gmail.users.messages.list({ userId: 'me', q, maxResults: 60 })
      for (const m of list.data.messages || []) {
        if (!seen.has(m.id)) {
          seen.add(m.id)
          ids.push(m.id)
        }
      }
    } catch (e) {
      // A chunk that fails must not take the whole badge down. The rest still count, and the next
      // pass retries; a partially-low badge beats a 500 and an empty bell.
      console.warn('[crm-gmail] unread chunk failed:', e?.message || e)
    }
  }

  // 2) Attribute each one to its project. Still a GET per message, because only the From header
  //    says WHICH client it came from and a chunked query cannot tell us. But this now runs over
  //    the few that are actually from clients rather than over everything unread.
  const counts = {}
  for (const id of ids) {
    try {
      const full = await gmail.users.messages.get({
        userId: 'me',
        id,
        format: 'metadata',
        metadataHeaders: ['From'],
      })
      const from = emailFromAddr(header(full.data.payload, 'From'))
      const pid = emailToId[from]
      if (pid) counts[pid] = (counts[pid] || 0) + 1
    } catch (e) {
      console.warn('[crm-gmail] unread attribute failed:', e?.message || e)
    }
  }

  unreadCache = { at: Date.now(), counts }
  return counts
}

// Marking a thread read has to invalidate the cache, or the badge sits there for up to a minute
// after Michael has just cleared it, which reads as the app being broken.
export function invalidateUnreadCache() {
  unreadCache = { at: 0, counts: null }
}
