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

const EMAILS_FILE = path.join(RECORDS_DIR, 'crm-emails.json')

// Reply subject for threading. Gmail only adds a message to an existing thread when the Subject
// matches that thread's subject (we set no In-Reply-To/References headers), so when an email targets
// a thread we force its outgoing subject to the thread's "Re:" subject — no matter what a template or
// edit left in the subject field.
function reSubject(s) {
  const t = String(s || '').trim()
  return /^re:/i.test(t) ? t : `Re: ${t}`
}

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
    // When set, this email is sent as a reply INTO an existing Gmail thread (so e.g. follow-up #2
    // lands in follow-up #1's conversation) rather than starting a new thread. threadSubject is kept
    // for display only. Empty = a new thread (the default).
    threadId: String(e.threadId || ''),
    threadSubject: String(e.threadSubject || ''),
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
  if (k === 'inquiry-response') return 'inquiry response'
  if (k === 'shark' || k === 'inquiry-shark') return 'shark email'
  if (k === 'breakup' || k === 'inquiry-breakup') return 'break-up email'
  if (/^(inquiry-)?followup-\d+$/.test(k)) return 'follow-up email'
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
export function saveProjectEmail({ id, projectId, kind, to, subject, body, format, attachments, threadId, threadSubject } = {}) {
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
    if (threadId !== undefined) e.threadId = String(threadId || '')
    if (threadSubject !== undefined) e.threadSubject = String(threadSubject || '')
    e.status = 'draft'
    e.sentAt = ''
    e.updatedAt = now
    writeEmailsFile(data)
    return clean(e)
  }

  // A reply draft is unique per thread (kind 'reply-<threadId>'). If one already exists for this
  // project+kind as a draft, update it in place rather than minting a second record, so concurrent
  // id-less autosaves (rapid typing before the first save's id comes back) converge to one draft.
  if (projectId && /^reply-/.test(String(kind || ''))) {
    const dup = data.emails.find((x) => x.projectId === projectId && x.kind === kind && x.status === 'draft')
    if (dup) {
      dup.to = toList
      dup.subject = String(subject ?? dup.subject ?? '')
      dup.body = String(body ?? dup.body ?? '')
      if (format != null) dup.format = format === 'html' ? 'html' : 'text'
      if (attachments != null) dup.attachments = normalizeAttachments(attachments)
      dup.updatedAt = now
      writeEmailsFile(data)
      return clean(dup)
    }
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
    threadId: String(threadId || ''),
    threadSubject: String(threadSubject || ''),
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

  // The raw body is handed to sendEmail, which is the SINGLE place that runs composeOutgoing
  // (chips stripped, spacing tightened, signature appended, data: logo -> cid: inline image). We pass
  // the raw body and read back the receipt version so the outgoing email is composed exactly once —
  // composing here too would deliver the signature twice and nest the base-font wrapper.
  const isHtml = e.format === 'html'
  const r = await sendEmail({
    projectId: e.projectId,
    // When threadId is set, the email is added to that existing Gmail conversation instead of
    // starting a new thread. Force the subject to the thread's "Re:" subject so threading can't be
    // broken by a template/edit that changed the subject after the thread was picked.
    threadId: e.threadId || undefined,
    to: to.join(', '),
    subject: e.threadId && e.threadSubject ? reSubject(e.threadSubject) : e.subject || 'Thank you!',
    body: e.body || '',
    format: isHtml ? 'html' : 'text',
    attachments: resolveAttachments(e.attachments),
    mode: 'send',
  })

  if (r && r.demo) {
    // Nothing was actually sent; leave the draft (and its chips) exactly as they were.
    return { ok: true, demo: true, email: clean(e) }
  }

  const now = new Date().toISOString()
  // Record what actually went out (chips stripped, signature appended), so the sent receipt matches
  // the email. The receipt keeps data: images so the in-app view still renders the logo.
  e.body = isHtml ? r.receiptHtml || e.body || '' : e.body || ''
  e.status = 'sent'
  e.sentAt = now
  e.updatedAt = now
  writeEmailsFile(data)
  try {
    await appendActivityLog(e.projectId, `Sent ${kindLabel(e.kind)} to ${to.join(', ')}.`)
  } catch {
    // activity log is best-effort; the send already succeeded
  }
  return { ok: true, demo: false, email: clean(e) }
}
