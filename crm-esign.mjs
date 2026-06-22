// SignWell e-signature client (CRM-owned). Thin wrapper over the SignWell REST API:
// create/send a document for signing, check its status, and fetch the completed PDF.
// Credentials in signwell-credentials.json (gitignored, never backed up). The CRM is
// local, so we POLL for status (GET document) rather than running a webhook endpoint.
// Signature fields are placed via TEXT TAGS embedded in the PDF (see crm-contracts.mjs),
// which is robust to variable-length contracts. Raw fetch, no SDK.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CRED_FILE = path.join(HERE, 'signwell-credentials.json')
const BASE = 'https://www.signwell.com'

function creds() {
  try {
    return JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'))
  } catch {
    return null
  }
}
export function isConfigured() {
  const c = creds()
  return !!(c && c.apiKey && !String(c.apiKey).startsWith('PASTE'))
}
export function isTestMode() {
  const c = creds()
  return c ? c.testMode !== false : true
}
export function status() {
  return { configured: isConfigured(), testMode: isTestMode() }
}

async function sw(pathPart, opts = {}) {
  const c = creds()
  if (!isConfigured()) throw new Error('SignWell is not set up (missing API key).')
  const res = await fetch(`${BASE}${pathPart}`, {
    ...opts,
    headers: {
      'X-Api-Key': c.apiKey,
      Accept: 'application/json',
      ...(opts.headers || {}),
    },
  })
  const text = await res.text()
  let data
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = { raw: text }
  }
  if (!res.ok) {
    const msg = data?.errors ? JSON.stringify(data.errors) : data?.error || text.slice(0, 300)
    throw new Error(`SignWell API ${res.status}: ${msg}`)
  }
  return data
}

// Create + send a document for signature. The PDF carries the text tags that place the
// signer's signature field, so no coordinates/fields are passed. Returns the SignWell doc.
export async function createDocument({ name, fileName, fileBase64, signerName, signerEmail, subject, message }) {
  const body = {
    test_mode: isTestMode(),
    draft: false,
    text_tags: true,
    name,
    subject: subject || 'Please sign your performance agreement',
    message: message || `Hi ${signerName || 'there'}, please review and sign the performance agreement. Thanks!`,
    files: [{ name: fileName || 'contract.pdf', file_base64: fileBase64 }],
    recipients: [{ id: '1', name: signerName || 'Client', email: signerEmail }],
  }
  return sw('/api/v1/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

export async function getDocument(id) {
  return sw(`/api/v1/documents/${encodeURIComponent(id)}`)
}

// Fetch the completed (signed) PDF bytes. Includes SignWell's audit page by default.
export async function completedPdf(id) {
  const c = creds()
  const res = await fetch(`${BASE}/api/v1/documents/${encodeURIComponent(id)}/completed_pdf`, {
    headers: { 'X-Api-Key': c.apiKey, Accept: 'application/pdf' },
  })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`SignWell completed PDF ${res.status}: ${t.slice(0, 200)}`)
  }
  return Buffer.from(await res.arrayBuffer())
}
