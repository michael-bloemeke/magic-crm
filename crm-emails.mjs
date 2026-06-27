// Per-project composed emails (the post-gig thank-you for now; more kinds later).
// Each is a CRM-owned draft Michael writes or generates, saves, and sends to the
// project's client(s). Stored in crm-emails.json. A saved draft lives in the CRM
// (NOT in Gmail drafts); sending goes out through Gmail (the same path as thread
// replies) and flips the record to "sent".

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { RECORDS_DIR, appendActivityLog } from './crm-data-core.mjs'
import { sendEmail } from './crm-comms.mjs'
import { readAttachment, deleteAttachment } from './crm-email-attachments.mjs'
import { readFile as readBusinessFile } from './crm-files.mjs'
import { loadConfig } from './crm-finance.mjs'

// Strip smart-field placeholder chips down to their plain text, server-side. This is the
// last line of defense so a styled <span class="merge-field">[Label]</span> can NEVER ship to
// a client, no matter which front-end path triggered the send (modal Send, the card's Send
// button, or a future caller). Filled fields are already plain text by send time; only unset
// placeholders remain, and they go out as the bare bracketed label.
function stripMergeFields(html) {
  return String(html || '').replace(
    /<span\b[^>]*\bclass="[^"]*\bmerge-field\b[^"]*"[^>]*>([\s\S]*?)<\/span>/gi,
    (_, inner) => inner,
  )
}

// Make an outgoing HTML email render like Gmail, and match the compose box / sent receipt exactly
// (which carry the .email-rte class with these same values in src/index.css). Three jobs:
//   1. tightenEmailHtml: normalize spacing. Our draft HTML (Claude-drafted or typed in the rich
//      editor) uses an empty <p><br></p> for a blank line, and email clients render every <p> with
//      a full 1em top+bottom margin, so stacked a blank line balloons to ~50px. We swap each
//      blank-line paragraph for a short half-height spacer, give real paragraphs a controlled
//      smaller bottom margin, and inline Gmail's blue link color so links match the editor.
//   2. EMAIL_BASE_STYLE: a base font wrapper so the recipient's client doesn't fall back to its own
//      font (Gmail otherwise renders an unstyled message in a serif). Arial / 14px / 1.5 / #222.
//   3. renderEmailHtml: wrap the tightened body in that base style.
// Purely presentational: no text is changed. Only touches <p>/<a> tags with no style of their own.
const PARA_STYLE = 'margin:0 0 12px 0'
const BLANK_SPACER = '<div style="margin:0;line-height:12px;font-size:1px">&nbsp;</div>'
const LINK_STYLE = 'color:#1155cc;text-decoration:underline'
const EMAIL_BASE_STYLE = 'font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222222'
function tightenEmailHtml(html) {
  let s = String(html || '')
  if (!s) return s
  s = s.replace(/>\s+</g, '><') // drop insignificant whitespace the editor/Claude leaves between blocks
  s = s.replace(/<(p|div)\b[^>]*>(?:\s|&nbsp;|<br\s*\/?>)*<\/\1>/gi, BLANK_SPACER) // blank line -> short spacer
  s = s.replace(/<p(?![^>]*\bstyle=)([^>]*)>/gi, `<p$1 style="${PARA_STYLE}">`) // controlled margin on real paragraphs
  s = s.replace(/<a(?![^>]*\bstyle=)([^>]*)>/gi, `<a$1 style="${LINK_STYLE}">`) // Gmail-blue links, matching the editor
  return s
}
// Pull every `data:` image out of HTML into a cid: inline attachment, rewriting the src to cid:.
// Gmail strips data: images from RECEIVED mail, so a signature logo must ride along as an inline
// attachment referenced by Content-ID. Returns the rewritten html plus the images to attach.
function extractInlineImages(html) {
  const images = []
  let n = 0
  const out = String(html || '').replace(
    /(<img\b[^>]*\bsrc=")data:([^;"]+);base64,([^"]+)(")/gi,
    (_m, pre, contentType, contentBase64, post) => {
      const cid = `sig${n++}@magic-crm`
      const ext = (contentType.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '')
      images.push({ cid, contentType, contentBase64, filename: `signature-${n}.${ext}` })
      return `${pre}cid:${cid}${post}`
    },
  )
  return { html: out, images }
}

// Build the signature block (tightened, same styling as the body), or '' if disabled/empty.
function signatureInner() {
  const cfg = loadConfig()
  if (!cfg || !cfg.signatureEnabled) return ''
  const sig = tightenEmailHtml(String(cfg.signatureHtml || ''))
  return sig ? `<div style="margin-top:16px">${sig}</div>` : ''
}

// Turn a composed body into what actually ships and what we store as the receipt. Both are wrapped
// in the Gmail-like base font (so editor, receipt, and delivered email agree) and carry the
// signature. They differ only in images: the receipt keeps data: URIs (so the in-app sent view
// renders the logo), while the send version uses cid: + inlineImages (so the recipient's Gmail does).
function composeOutgoing(bodyHtml) {
  const inner = tightenEmailHtml(String(bodyHtml || '')) + signatureInner()
  const wrap = (h) => (h ? `<div style="${EMAIL_BASE_STYLE}">${h}</div>` : h)
  const { html: cidInner, images } = extractInlineImages(inner)
  return { sendHtml: wrap(cidInner), receiptHtml: wrap(inner), inlineImages: images }
}

const EMAILS_FILE = path.join(RECORDS_DIR, 'crm-emails.json')

function meta() {
  return {
    file: 'crm-emails.json',
    owner: 'Magic CRM app (~/Desktop/Claude/magic-crm)',
    purpose:
      'CRM-owned per-project composed emails (e.g. the post-gig thank-you). A saved draft lives here, NOT in Gmail drafts; sending goes out through Gmail and flips status to sent.',
    cowork_guidance: 'Safe to read. The CRM manages this file. Do NOT delete or overwrite.',
    shape:
      'id, projectId (client_name slug), kind, to[], subject, body, format (html|text), attachments[{source(files|upload),name,id?,size?}], status (draft|sent), createdAt, updatedAt, sentAt (all ISO)',
  }
}

// Keep only well-formed attachment refs. `files` = a Files-page document (read from crm-files
// at send); `upload` = a one-off in the email-attachment store (read by id).
function normalizeAttachments(list) {
  if (!Array.isArray(list)) return []
  return list
    .map((a) => {
      const source = a && a.source === 'upload' ? 'upload' : 'files'
      const ref = { source, name: String(a?.name || '').trim(), size: Number(a?.size) || 0 }
      if (source === 'upload') ref.id = String(a?.id || '')
      return ref
    })
    .filter((a) => a.name && (a.source !== 'upload' || a.id))
}

// Turn stored attachment refs into the bytes the Gmail layer needs. A ref whose file is gone
// (deleted upload, removed Files-page doc) is skipped rather than failing the whole send.
function resolveAttachments(list) {
  const out = []
  for (const a of normalizeAttachments(list)) {
    const f = a.source === 'upload' ? readAttachment(a.id) : readBusinessFile(a.name)
    if (f && f.buffer) {
      out.push({ filename: f.name || a.name, contentType: f.contentType || 'application/octet-stream', contentBase64: f.buffer.toString('base64') })
    }
  }
  return out
}

function readEmailsFile() {
  let data
  try {
    data = JSON.parse(fs.readFileSync(EMAILS_FILE, 'utf8'))
  } catch {
    data = null
  }
  if (!data || !Array.isArray(data.emails)) data = { emails: [] }
  return data
}

function writeEmailsFile(data) {
  try {
    data._meta = meta()
    fs.writeFileSync(EMAILS_FILE, JSON.stringify(data, null, 2) + '\n')
  } catch (e) {
    console.error('[crm-emails] could not write crm-emails.json:', e?.message || e)
  }
}

function clean(e) {
  return {
    id: e.id,
    projectId: e.projectId,
    kind: e.kind || 'thankyou',
    to: Array.isArray(e.to) ? e.to.filter(Boolean) : [],
    subject: String(e.subject || ''),
    body: String(e.body || ''),
    format: e.format === 'html' ? 'html' : 'text',
    attachments: normalizeAttachments(e.attachments),
    status: e.status === 'sent' ? 'sent' : 'draft',
    createdAt: e.createdAt || '',
    updatedAt: e.updatedAt || '',
    sentAt: e.sentAt || '',
  }
}

function normalizeTo(to) {
  return Array.isArray(to) ? to.map((s) => String(s).trim()).filter(Boolean) : []
}

function kindLabel(kind) {
  const k = String(kind || '')
  if (k === 'thankyou') return 'thank-you email'
  if (k === 'postcall') return 'post-call email'
  if (k === 'shark') return 'shark email'
  if (k === 'breakup') return 'break-up email'
  if (/^followup-\d+$/.test(k)) return 'follow-up email'
  if (/^checkin-\d+$/.test(k)) return 'check-in email'
  return 'email'
}

export function loadEmails(projectId) {
  const all = readEmailsFile().emails.map(clean)
  return projectId ? all.filter((e) => e.projectId === projectId) : all
}

// Upsert a draft. With an id, update it; otherwise create a new one. Saving always
// leaves the record as a draft (sending is a separate call). A previously sent email is a
// permanent record: it is returned unchanged (any save is a no-op), never edited or reverted
// to a draft.
export function saveProjectEmail({ id, projectId, kind, to, subject, body, format, attachments } = {}) {
  if (!projectId && !id) throw new Error('projectId is required')
  const data = readEmailsFile()
  const now = new Date().toISOString()
  const toList = normalizeTo(to)

  if (id) {
    const e = data.emails.find((x) => x.id === id)
    if (!e) throw new Error('email not found')
    // A sent email is a permanent record: never edit it or revert it to a draft. Return it
    // unchanged so any stray save is a harmless no-op rather than a status downgrade.
    if (e.status === 'sent') return clean(e)
    if (kind != null) e.kind = String(kind)
    e.to = toList
    e.subject = String(subject ?? e.subject ?? '')
    e.body = String(body ?? e.body ?? '')
    if (format != null) e.format = format === 'html' ? 'html' : 'text'
    if (attachments != null) e.attachments = normalizeAttachments(attachments)
    e.status = 'draft'
    e.sentAt = ''
    e.updatedAt = now
    writeEmailsFile(data)
    return clean(e)
  }

  const e = {
    id: crypto.randomUUID(),
    projectId,
    kind: String(kind || 'thankyou'),
    to: toList,
    subject: String(subject || ''),
    body: String(body || ''),
    format: format === 'html' ? 'html' : 'text',
    attachments: normalizeAttachments(attachments),
    status: 'draft',
    createdAt: now,
    updatedAt: now,
    sentAt: '',
  }
  data.emails.push(e)
  writeEmailsFile(data)
  return clean(e)
}

export function deleteProjectEmail(id) {
  const data = readEmailsFile()
  const e = data.emails.find((x) => x.id === id)
  // Clean up any one-off uploaded attachments this email owned, so they don't orphan on disk.
  if (e) {
    for (const a of normalizeAttachments(e.attachments)) {
      if (a.source === 'upload' && a.id) deleteAttachment(a.id)
    }
  }
  data.emails = data.emails.filter((x) => x.id !== id)
  writeEmailsFile(data)
  return { ok: true }
}

// Send a saved email out through Gmail and flip it to "sent". Returns
// { ok, demo, email }. When Gmail isn't connected the send is a no-op demo and the
// record stays a draft (so nothing reads as sent that wasn't).
export async function sendProjectEmail({ id } = {}) {
  const data = readEmailsFile()
  const e = data.emails.find((x) => x.id === id)
  if (!e) throw new Error('email not found')
  // Already sent? No-op. A sent email is a permanent record; never re-send or re-stamp it.
  // Guards against a double-click race or a stray duplicate POST (the UI never reaches here
  // twice, but the data layer enforces it regardless). Safe for the normal flow: the first
  // send saves the record as a draft, then flips it to sent below, so this never fires then.
  if (e.status === 'sent') return { ok: true, demo: false, email: clean(e) }
  const to = normalizeTo(e.to)
  if (to.length === 0) throw new Error('add at least one recipient before sending')

  // The body that goes OUT has its placeholder chips stripped to plain text; the stored draft
  // keeps its chips until the send actually succeeds (so a demo/failed send loses nothing). For
  // HTML, composeOutgoing wraps it in the Gmail base style, appends the signature, and splits into
  // a send version (cid: logo + inlineImages) and a receipt version (data: logo, renders in-app).
  const isHtml = e.format === 'html'
  const composed = isHtml ? composeOutgoing(stripMergeFields(e.body || '')) : null
  const r = await sendEmail({
    projectId: e.projectId,
    to: to.join(', '),
    subject: e.subject || 'Thank you!',
    body: isHtml ? composed.sendHtml : e.body || '',
    format: isHtml ? 'html' : 'text',
    attachments: resolveAttachments(e.attachments),
    inlineImages: isHtml ? composed.inlineImages : [],
    mode: 'send',
  })

  if (r && r.demo) {
    // Nothing was actually sent; leave the draft (and its chips) exactly as they were.
    return { ok: true, demo: true, email: clean(e) }
  }

  const now = new Date().toISOString()
  // Record what actually went out (chips stripped, signature appended), so the sent receipt matches
  // the email. The receipt keeps data: images so the in-app view still renders the logo.
  e.body = isHtml ? composed.receiptHtml : e.body || ''
  e.status = 'sent'
  e.sentAt = now
  e.updatedAt = now
  writeEmailsFile(data)
  try {
    appendActivityLog(e.projectId, `Sent ${kindLabel(e.kind)} to ${to.join(', ')}.`)
  } catch {
    // activity log is best-effort; the send already succeeded
  }
  return { ok: true, demo: false, email: clean(e) }
}
