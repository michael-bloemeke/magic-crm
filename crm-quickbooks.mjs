// QuickBooks Online integration (CRM-owned). Connects via OAuth2 to Michael's
// QuickBooks company, then creates invoices from a project's client + quote and
// (separately) emails them. Credentials live in quickbooks-credentials.json and
// tokens in quickbooks-token.json (both gitignored). Per-project invoice references
// are stored in Project Records/crm-invoices.json so the project page can show
// status. Raw fetch, no SDK. Sandbox by default; flip environment to "production"
// in the credentials file to go live.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { RECORDS_DIR, loadAll } from './crm-data-core.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CRED_FILE = path.join(HERE, 'quickbooks-credentials.json')
const TOKEN_FILE = path.join(HERE, 'quickbooks-token.json')
const INVOICES_FILE = path.join(RECORDS_DIR, 'crm-invoices.json')

const AUTH_BASE = 'https://appcenter.intuit.com/connect/oauth2'
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer'
const SCOPE = 'com.intuit.quickbooks.accounting'
const MINOR_VERSION = '70'

function creds() {
  try {
    return JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'))
  } catch {
    return null
  }
}
function apiBase(env) {
  return env === 'production' ? 'https://quickbooks.api.intuit.com' : 'https://sandbox-quickbooks.api.intuit.com'
}
function readToken() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'))
  } catch {
    return null
  }
}
function writeToken(t) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2) + '\n')
}

export function isConfigured() {
  const c = creds()
  return !!(c && c.clientId && !String(c.clientId).startsWith('PASTE') && c.clientSecret && !String(c.clientSecret).startsWith('PASTE'))
}
export function isConnected() {
  const t = readToken()
  return !!(t && t.refresh_token && t.realmId)
}
export function status() {
  return { configured: isConfigured(), connected: isConnected(), environment: creds()?.environment || 'sandbox' }
}

// --- OAuth2 -----------------------------------------------------------------
export function authUrl() {
  const c = creds()
  if (!isConfigured()) throw new Error('QuickBooks credentials are not set up.')
  const params = new URLSearchParams({
    client_id: c.clientId,
    response_type: 'code',
    scope: SCOPE,
    redirect_uri: c.redirectUri,
    state: crypto.randomBytes(12).toString('hex'),
  })
  return `${AUTH_BASE}?${params.toString()}`
}

async function tokenRequest(bodyParams) {
  const c = creds()
  const basic = Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64')
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams(bodyParams).toString(),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`QuickBooks token request failed (${res.status}): ${text.slice(0, 300)}`)
  return JSON.parse(text)
}

export async function handleCallback({ code, realmId }) {
  const c = creds()
  if (!code || !realmId) throw new Error('Missing code or realmId from QuickBooks.')
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: c.redirectUri })
  writeToken({ ...t, realmId, obtained_at: Date.now() })
  return { ok: true }
}

export function disconnect() {
  try {
    fs.unlinkSync(TOKEN_FILE)
  } catch {
    // already gone
  }
  return { ok: true }
}

// Return a valid access token, refreshing if it's near expiry.
async function freshToken() {
  const t = readToken()
  if (!t || !t.refresh_token) throw new Error('QuickBooks is not connected.')
  const ageMs = Date.now() - (t.obtained_at || 0)
  if (t.access_token && ageMs < ((t.expires_in || 3600) - 120) * 1000) return t
  const nt = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token })
  const merged = { ...t, ...nt, obtained_at: Date.now() }
  writeToken(merged)
  return merged
}

// --- API calls --------------------------------------------------------------
async function qb(pathPart, opts = {}) {
  const c = creds()
  const t = await freshToken()
  const sep = pathPart.includes('?') ? '&' : '?'
  const url = `${apiBase(c.environment)}/v3/company/${t.realmId}${pathPart}${sep}minorversion=${MINOR_VERSION}`
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${t.access_token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
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
    const msg = data?.Fault?.Error?.[0]?.Detail || data?.Fault?.Error?.[0]?.Message || text.slice(0, 300)
    throw new Error(`QuickBooks API ${res.status}: ${msg}`)
  }
  return data
}

async function query(sql) {
  return qb(`/query?query=${encodeURIComponent(sql)}`)
}

// Find a customer by display name, or create one.
async function ensureCustomer(name, email) {
  const safe = String(name || '').replace(/['\\]/g, ' ').trim() || 'Client'
  const found = await query(`select * from Customer where DisplayName = '${safe}'`)
  const existing = found?.QueryResponse?.Customer?.[0]
  if (existing) return existing
  const body = { DisplayName: safe }
  if (email) body.PrimaryEmailAddr = { Address: email }
  const created = await qb('/customer', { method: 'POST', body: JSON.stringify(body) })
  return created.Customer
}

// Find a Service item by name, or create it (attached to the first income account).
// Used for the performance line ("Magic Performance") and the optional card-fee line.
async function ensureServiceItem(name) {
  const safe = String(name || 'Service').replace(/['\\]/g, ' ').trim()
  const found = await query(`select * from Item where Name = '${safe}'`)
  const existing = found?.QueryResponse?.Item?.[0]
  if (existing) return existing
  const accRes = await query(`select * from Account where AccountType = 'Income' maxresults 1`)
  const acc = accRes?.QueryResponse?.Account?.[0]
  if (!acc) throw new Error('No income account found in QuickBooks to attach a service item to.')
  const body = { Name: safe, Type: 'Service', IncomeAccountRef: { value: acc.Id } }
  const created = await qb('/item', { method: 'POST', body: JSON.stringify(body) })
  return created.Item
}

// --- Per-project invoice references (so the project page can show status) ----
function readInvoices() {
  let d
  try {
    d = JSON.parse(fs.readFileSync(INVOICES_FILE, 'utf8'))
  } catch {
    d = null
  }
  if (!d || typeof d.invoices !== 'object' || d.invoices === null) d = { invoices: {} }
  return d
}
function writeInvoices(d) {
  d._meta = {
    file: 'crm-invoices.json',
    owner: 'Magic CRM app (~/Desktop/Claude/magic-crm)',
    purpose:
      'Per-project reference to the QuickBooks invoice generated from the CRM (the invoice itself lives in QuickBooks; this just links projectId -> invoice id/number/total/status so the project page can show it).',
    cowork_guidance: 'Safe to read. CRM-owned, do NOT overwrite.',
    shape: 'invoices[projectId] = { invoiceId, docNumber, total, amount, processingFee, dueDate, customer, email, createdAt, sentAt }',
  }
  fs.writeFileSync(INVOICES_FILE, JSON.stringify(d, null, 2) + '\n')
}
export function loadInvoices() {
  return readInvoices().invoices
}

// opts: { amount, dueDate (YYYY-MM-DD), processingFeePercent }. Amount defaults to
// the project's Quote (total fee) when not given, so partial invoices (e.g. a 50%
// deposit) are just a lower amount. A processingFeePercent > 0 adds a separate
// "Card Processing Fee" line so the client covers the card-processing cost.
export async function createInvoiceForProject(projectId, opts = {}) {
  const project = loadAll().projects.find((p) => p.id === projectId)
  if (!project) throw new Error('Project not found.')
  const quote = project.totalFee == null ? NaN : Number(project.totalFee)
  let amount = opts.amount === undefined || opts.amount === null || opts.amount === '' ? quote : Number(opts.amount)
  if (!amount || Number.isNaN(amount) || amount <= 0) {
    throw new Error('Enter an invoice amount (or set a Quote on the project first).')
  }
  amount = Math.round(amount * 100) / 100
  const email = String(project.contactEmails || '').split(/[,;]/)[0].trim() || ''
  const customer = await ensureCustomer(project.client, email)
  const item = await ensureServiceItem('Magic Performance')
  const description = `${project.eventType || 'Magic performance'}${project.eventDate ? ` on ${project.eventDate}` : ''}`
  const lines = [
    {
      DetailType: 'SalesItemLineDetail',
      Amount: amount,
      Description: description,
      SalesItemLineDetail: { ItemRef: { value: item.Id }, Qty: 1, UnitPrice: amount },
    },
  ]
  const feePct = opts.processingFeePercent == null || opts.processingFeePercent === '' ? 0 : Number(opts.processingFeePercent)
  let processingFee = 0
  if (feePct && !Number.isNaN(feePct) && feePct > 0) {
    processingFee = Math.round(amount * feePct) / 100 // amount * (pct/100), 2 decimals
    const feeItem = await ensureServiceItem('Card Processing Fee')
    lines.push({
      DetailType: 'SalesItemLineDetail',
      Amount: processingFee,
      Description: `Card processing fee (${feePct}%)`,
      SalesItemLineDetail: { ItemRef: { value: feeItem.Id }, Qty: 1, UnitPrice: processingFee },
    })
  }
  const body = { CustomerRef: { value: customer.Id }, Line: lines }
  if (email) body.BillEmail = { Address: email }
  const due = String(opts.dueDate || '').trim()
  if (due) body.DueDate = due // QuickBooks expects YYYY-MM-DD
  const created = await qb('/invoice', { method: 'POST', body: JSON.stringify(body) })
  const inv = created.Invoice
  const ref = {
    invoiceId: inv.Id,
    docNumber: inv.DocNumber || '',
    total: inv.TotalAmt,
    amount,
    processingFee,
    dueDate: inv.DueDate || due || '',
    customer: customer.DisplayName,
    email,
    createdAt: new Date().toISOString(),
    sentAt: '',
  }
  const d = readInvoices()
  d.invoices[projectId] = ref
  writeInvoices(d)
  return ref
}

export async function sendInvoiceForProject(projectId, overrideEmail) {
  const d = readInvoices()
  const ref = d.invoices[projectId]
  if (!ref || !ref.invoiceId) throw new Error('No invoice has been generated for this project yet.')
  const to = String(overrideEmail || ref.email || '').trim()
  if (!to) throw new Error('No client email on file to send the invoice to.')
  // The send endpoint requires Content-Type: application/octet-stream with an empty
  // body. Posting application/json here makes QuickBooks throw a 500 NullPointerException.
  await qb(`/invoice/${ref.invoiceId}/send?sendTo=${encodeURIComponent(to)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
  })
  ref.sentAt = new Date().toISOString()
  ref.email = to
  d.invoices[projectId] = ref
  writeInvoices(d)
  return ref
}

// Fetch the rendered invoice PDF from QuickBooks (for in-app preview, before or
// after sending). Returns the raw PDF bytes as a Buffer plus a name for the file.
// Uses a dedicated fetch because qb() assumes a JSON response, not binary.
export async function invoicePdfForProject(projectId) {
  const d = readInvoices()
  const ref = d.invoices[projectId]
  if (!ref || !ref.invoiceId) throw new Error('No invoice has been generated for this project yet.')
  const c = creds()
  const t = await freshToken()
  const url = `${apiBase(c.environment)}/v3/company/${t.realmId}/invoice/${ref.invoiceId}/pdf?minorversion=${MINOR_VERSION}`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${t.access_token}`, Accept: 'application/pdf' },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`QuickBooks PDF ${res.status}: ${text.slice(0, 200)}`)
  }
  const buffer = Buffer.from(await res.arrayBuffer())
  return { buffer, docNumber: ref.docNumber || ref.invoiceId }
}
