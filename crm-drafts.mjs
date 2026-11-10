// GMAIL DRAFTS ARE THE CRM'S DRAFTS (2026-11-10).
//
// Michael: "I want to be able to see and edit and send drafts from my CRM that I made in Gmail and
// vice versa." Before this there were two draft stores that never met: the CRM kept its own drafts
// in the `emails` table, and a draft started in Gmail showed up in the CRM as a read-only "Unsent
// draft" box he could look at and do nothing with. Now there is one store, his Gmail Drafts folder:
//
//   - Anything typed in a CRM composer is saved straight into Gmail as a draft (create, then update).
//   - Any draft in Gmail that belongs to a project's conversation opens in the CRM composer, editable.
//   - Sending is Gmail's own drafts.send, so the draft leaves Drafts and lands in Sent, in its thread,
//     exactly as if he had pressed Send in Gmail.
//
// WHAT A DRAFT HOLDS vs WHAT GOES OUT. The draft keeps the email as he WROTE it (the editor's HTML), so
// it reads naturally when he opens it in Gmail. The send runs the same composeOutgoing every other CRM
// email uses (spacing tightened, base font, template GIFs and pictures embedded inline), so a draft
// sent from the CRM looks identical to any other email the CRM has sent.
//
// THINGS A GMAIL DRAFT CAN CARRY THAT THE CRM EDITOR CANNOT HOLD DIRECTLY, and how each survives a
// round trip:
//   - Inline pictures (cid:). Loaded as data: URIs so the editor shows them, turned back into cid:
//     parts on save. Template GIFs keep their data-crm-gif marker and load from the local GIF route.
//   - Gmail's quoted history (the "On ... wrote:" block of a reply). Split off on load, handed back
//     untouched on save, so a reply started in Gmail keeps its quote and the editor stays clean.
//   - Attachments added in Gmail. Listed by name; their bytes are re-read from the current draft on
//     each save (cached) so editing the text in the CRM never silently drops a PDF.
//   - Cc and Bcc. Read and written.

import { gmailApi, mailboxAddress, senderHeader, headerValue, makeRaw, markThreadRead, invalidateDraftIndex, deleteDraft as gmailDeleteDraft } from './crm-gmail.mjs'
import { composeOutgoing, stripMergeFields, extractGifImages, extractInlineImages } from './crm-email-render.mjs'
import { resolveAttachments } from './crm-emails.mjs'
import { invalidateInbox } from './crm-comms.mjs'
import { appendActivityLog } from './crm-data-core.mjs'

// ---- Reading a draft --------------------------------------------------------

function partHeader(part, name) {
  const h = (part?.headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase())
  return h ? String(h.value || '') : ''
}

function walk(part, fn) {
  if (!part) return
  fn(part)
  for (const p of part.parts || []) walk(p, fn)
}

async function partBytes(gmail, messageId, part) {
  if (part.body?.data) return Buffer.from(part.body.data, 'base64url')
  if (part.body?.attachmentId) {
    const r = await gmail.users.messages.attachments.get({ userId: 'me', messageId, id: part.body.attachmentId })
    return Buffer.from(r.data.data || '', 'base64url')
  }
  return Buffer.alloc(0)
}

const cidOf = (part) => partHeader(part, 'Content-ID').replace(/^<|>$/g, '').trim()

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// A plain-text draft (rare: Gmail's plain-text mode) as editor HTML.
function textToHtml(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, '<br>')}</p>`)
    .join('')
}

// Gmail's quoted history in a reply. Everything from the first gmail_quote container onward.
export function splitQuote(html) {
  const s = String(html || '')
  const m = /<div\b[^>]*\bclass="[^"]*\bgmail_quote\b[^"]*"[^>]*>/i.exec(s)
  if (!m) return { body: s, quote: '' }
  return { body: s.slice(0, m.index), quote: s.slice(m.index) }
}

// A full HTML document down to what is inside <body>, so the editor never receives <html>/<head>.
function bodyInner(html) {
  const s = String(html || '')
  const m = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(s)
  return (m ? m[1] : s).replace(/<head\b[\s\S]*?<\/head>/gi, '').replace(/<\/?html\b[^>]*>/gi, '').trim()
}

// Template GIFs carry data-crm-gif="slug". Point them back at the local route so they animate in the
// editor without dragging a megabyte data: URI through every autosave.
function restoreGifSources(html) {
  return String(html || '').replace(/<img\b[^>]*\bdata-crm-gif="([a-z0-9-]+)"[^>]*>/gi, (tag, slug) =>
    /\bsrc="[^"]*"/i.test(tag) ? tag.replace(/\bsrc="[^"]*"/i, `src="/api/email-gif/${slug}"`) : tag,
  )
}

// Everything the composer needs to show and edit a draft.
export async function getDraft(draftId) {
  if (!draftId) throw new Error('draftId required')
  const gmail = gmailApi()
  const r = await gmail.users.drafts.get({ userId: 'me', id: draftId, format: 'full' })
  const msg = r.data.message || {}
  const payload = msg.payload || {}
  const head = (n) => headerValue(payload, n)

  let html = ''
  let text = ''
  const inline = []
  const attachments = []
  walk(payload, (part) => {
    const type = String(part.mimeType || '').toLowerCase()
    const disposition = partHeader(part, 'Content-Disposition').toLowerCase()
    const isAttachment = !!part.filename || disposition.startsWith('attachment')
    if (!isAttachment && type === 'text/html' && !html && part.body?.data) html = Buffer.from(part.body.data, 'base64url').toString('utf8')
    else if (!isAttachment && type === 'text/plain' && !text && part.body?.data) text = Buffer.from(part.body.data, 'base64url').toString('utf8')
    else if (cidOf(part)) inline.push(part)
    else if (isAttachment) attachments.push(part)
  })

  let body = html ? bodyInner(html) : textToHtml(text)
  // Inline pictures: show them in the editor as data: URIs. A Content-ID part that the HTML never
  // references is really an attachment, so it is listed as one instead of vanishing.
  for (const part of inline) {
    const cid = cidOf(part)
    if (!body.includes(`cid:${cid}`)) {
      attachments.push(part)
      continue
    }
    const bytes = await partBytes(gmail, msg.id, part)
    const dataUri = `data:${part.mimeType || 'application/octet-stream'};base64,${bytes.toString('base64')}`
    body = body.split(`cid:${cid}`).join(dataUri)
  }
  body = restoreGifSources(body)
  const { body: editable, quote } = splitQuote(body)

  return {
    draftId: r.data.id,
    messageId: msg.id || '',
    threadId: msg.threadId || '',
    to: head('To'),
    cc: head('Cc'),
    bcc: head('Bcc'),
    subject: head('Subject'),
    html: editable,
    quoteHtml: quote,
    // Attachments that live IN the Gmail draft (added in Gmail, or carried over from an earlier save).
    gmailAttachments: attachments
      .filter((p) => p.filename || cidOf(p))
      .map((p) => ({ name: p.filename || cidOf(p), size: Number(p.body?.size) || 0, contentType: p.mimeType || '' })),
    inReplyTo: head('In-Reply-To'),
    references: head('References'),
  }
}

// ---- Attachments that live in the Gmail draft ------------------------------
//
// Saving rewrites the whole draft, so anything Gmail holds has to be re-sent with it. The bytes are
// read from the CURRENT draft (a save gives the message a new id, and new attachment ids with it),
// and kept here so a burst of autosaves downloads each file once, not once per keystroke.
const ATT_TTL_MS = 30 * 60 * 1000
const attCache = new Map() // `${draftId}|${name}|${size}` -> { at, file }

async function keptGmailAttachments(draftId, keep) {
  const wanted = (Array.isArray(keep) ? keep : []).filter((k) => k && k.name)
  if (!draftId || wanted.length === 0) return []
  const out = []
  const misses = []
  for (const k of wanted) {
    const hit = attCache.get(`${draftId}|${k.name}|${Number(k.size) || 0}`)
    if (hit && Date.now() - hit.at < ATT_TTL_MS) out.push(hit.file)
    else misses.push(k)
  }
  if (misses.length === 0) return out
  const gmail = gmailApi()
  const r = await gmail.users.drafts.get({ userId: 'me', id: draftId, format: 'full' })
  const msg = r.data.message || {}
  const parts = []
  walk(msg.payload, (p) => {
    if (p.filename || (cidOf(p) && partHeader(p, 'Content-Disposition').toLowerCase().startsWith('attachment'))) parts.push(p)
  })
  for (const k of misses) {
    const part = parts.find((p) => (p.filename || cidOf(p)) === k.name)
    if (!part) continue
    const bytes = await partBytes(gmail, msg.id, part)
    const file = { filename: k.name, contentType: part.mimeType || 'application/octet-stream', contentBase64: bytes.toString('base64') }
    attCache.set(`${draftId}|${k.name}|${Number(k.size) || 0}`, { at: Date.now(), file })
    out.push(file)
  }
  return out
}

// ---- Reply headers ------------------------------------------------------------

// In-Reply-To and References for a new message in an existing thread: the last SENT message's
// Message-ID, appended to its References chain.
export async function replyHeaders(threadId) {
  if (!threadId) return { inReplyTo: '', references: '' }
  const r = await gmailApi().users.threads.get({
    userId: 'me',
    id: threadId,
    format: 'metadata',
    metadataHeaders: ['Message-ID', 'Message-Id', 'References'],
  })
  const sent = (r.data.messages || []).filter((m) => !(m.labelIds || []).includes('DRAFT'))
  const last = sent[sent.length - 1]
  if (!last) return { inReplyTo: '', references: '' }
  const mid = headerValue(last.payload, 'Message-ID') || headerValue(last.payload, 'Message-Id')
  const refs = headerValue(last.payload, 'References')
  return { inReplyTo: mid, references: [refs, mid].filter(Boolean).join(' ').trim() }
}

// ---- Saving and sending --------------------------------------------------------

function cleanAddresses(v) {
  return String(Array.isArray(v) ? v.join(', ') : v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .join(', ')
}

async function buildMessage(input, { forSend }) {
  const { draftId, threadId, to, cc, bcc, subject, html, quoteHtml, attachments, keepGmailAttachments } = input
  let { inReplyTo, references } = input
  if (threadId && !inReplyTo) {
    try {
      ;({ inReplyTo, references } = await replyHeaders(threadId))
    } catch {
      // Threading in Gmail still works off threadId + subject; only other clients lose the link.
    }
  }

  let bodyHtml
  let inlineImages
  if (forSend) {
    // What goes OUT: the same pipeline as every other CRM email, quote appended after the body.
    const composed = composeOutgoing(stripMergeFields(html || '') + String(quoteHtml || ''))
    bodyHtml = composed.sendHtml
    inlineImages = composed.inlineImages
  } else {
    // What the DRAFT holds: his words as written. Pictures become cid: parts because Gmail cannot
    // show a data: image or the CRM's local GIF route.
    const gifs = extractGifImages(String(html || '') + String(quoteHtml || ''))
    const pics = extractInlineImages(gifs.html)
    bodyHtml = pics.html
    inlineImages = [...gifs.images, ...pics.images]
  }

  const files = [...resolveAttachments(attachments), ...(await keptGmailAttachments(draftId, keepGmailAttachments))]
  const raw = makeRaw({
    from: await senderHeader(),
    to: cleanAddresses(to),
    cc: cleanAddresses(cc),
    bcc: cleanAddresses(bcc),
    subject: String(subject || '').trim() || '(no subject)',
    html: bodyHtml,
    inlineImages,
    attachments: files,
    inReplyTo,
    references,
  })
  return { message: threadId ? { raw, threadId } : { raw }, inReplyTo: inReplyTo || '', references: references || '' }
}

// Create (no draftId) or update a Gmail draft. Returns the ids the composer keeps for the next save,
// plus the reply headers so they are worked out once per draft rather than on every keystroke.
export async function saveDraft(input = {}) {
  const gmail = gmailApi()
  const { message, inReplyTo, references } = await buildMessage(input, { forSend: false })
  const res = input.draftId
    ? await gmail.users.drafts.update({ userId: 'me', id: input.draftId, requestBody: { id: input.draftId, message } })
    : await gmail.users.drafts.create({ userId: 'me', requestBody: { message } })
  invalidateDraftIndex()
  return {
    ok: true,
    draftId: res.data.id,
    messageId: res.data.message?.id || '',
    threadId: res.data.message?.threadId || input.threadId || '',
    inReplyTo,
    references,
    savedAt: new Date().toISOString(),
  }
}

// Send. With a draftId the draft is brought up to date and then sent with Gmail's own drafts.send,
// which is what moves it out of Drafts. Without one (a reply sent before its first autosave landed)
// it goes out as a plain message.
export async function sendDraft(input = {}) {
  if (!cleanAddresses(input.to) && !cleanAddresses(input.cc) && !cleanAddresses(input.bcc)) {
    throw new Error('Add at least one recipient before sending.')
  }
  const gmail = gmailApi()
  const { message } = await buildMessage(input, { forSend: true })
  let sent
  if (input.draftId) {
    await gmail.users.drafts.update({ userId: 'me', id: input.draftId, requestBody: { id: input.draftId, message } })
    sent = (await gmail.users.drafts.send({ userId: 'me', requestBody: { id: input.draftId } })).data
  } else {
    sent = (await gmail.users.messages.send({ userId: 'me', requestBody: message })).data
  }
  invalidateDraftIndex()
  invalidateInbox()
  // Replying clears the thread's unread flag, as it always has.
  if (input.threadId) {
    try {
      await markThreadRead(input.threadId)
    } catch {
      // the send already succeeded
    }
  }
  // A NEW email gets an activity-log line, as composer sends always have. Replies never did.
  if (input.projectId && !input.threadId) {
    try {
      await appendActivityLog(input.projectId, `Emailed ${cleanAddresses(input.to)}: "${String(input.subject || '').trim()}".`)
    } catch {
      // best-effort
    }
  }
  return { ok: true, id: sent.id || '', threadId: sent.threadId || input.threadId || '', from: await mailboxAddress() }
}

export async function discardDraft(draftId) {
  const r = await gmailDeleteDraft(draftId)
  invalidateDraftIndex()
  invalidateInbox()
  for (const k of attCache.keys()) if (k.startsWith(`${draftId}|`)) attCache.delete(k)
  return r
}
