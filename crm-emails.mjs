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

const EMAILS_FILE = path.join(RECORDS_DIR, 'crm-emails.json')

function meta() {
  return {
    file: 'crm-emails.json',
    owner: 'Magic CRM app (~/Desktop/Claude/magic-crm)',
    purpose:
      'CRM-owned per-project composed emails (e.g. the post-gig thank-you). A saved draft lives here, NOT in Gmail drafts; sending goes out through Gmail and flips status to sent.',
    cowork_guidance: 'Safe to read. The CRM manages this file. Do NOT delete or overwrite.',
    shape: 'id, projectId (client_name slug), kind, to[], subject, body, status (draft|sent), createdAt, updatedAt, sentAt (all ISO)',
  }
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
// leaves the record as a draft (sending is a separate call). A previously sent email
// edited and re-saved drops back to draft so it can be re-sent intentionally.
export function saveProjectEmail({ id, projectId, kind, to, subject, body } = {}) {
  if (!projectId && !id) throw new Error('projectId is required')
  const data = readEmailsFile()
  const now = new Date().toISOString()
  const toList = normalizeTo(to)

  if (id) {
    const e = data.emails.find((x) => x.id === id)
    if (!e) throw new Error('email not found')
    if (kind != null) e.kind = String(kind)
    e.to = toList
    e.subject = String(subject ?? e.subject ?? '')
    e.body = String(body ?? e.body ?? '')
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
  const to = normalizeTo(e.to)
  if (to.length === 0) throw new Error('add at least one recipient before sending')

  const r = await sendEmail({
    projectId: e.projectId,
    to: to.join(', '),
    subject: e.subject || 'Thank you!',
    body: e.body || '',
    mode: 'send',
  })

  if (r && r.demo) {
    return { ok: true, demo: true, email: clean(e) }
  }

  const now = new Date().toISOString()
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
