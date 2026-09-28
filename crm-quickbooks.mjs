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

import {
  CRM_STORE,
  sb,
  getCachedInvoices,
  upsertInvoice as sbUpsertInvoice,
  cacheUpsertInvoice,
} from './crm-store.mjs'

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
// ---------------------------------------------------------------------------
// Where the token lives
// ---------------------------------------------------------------------------
//
// ONE COPY, in Supabase. This is not a preference, it is a correctness requirement: Intuit ROTATES
// the refresh token every time it is used and eventually stops honouring the old one. Two stores
// (a file here, a row in the cloud) means whichever side refreshes last silently invalidates the
// other, and the failure shows up as a dead connection at the worst possible moment.
//
// That is exactly what this code used to do. The Mac read and wrote quickbooks-token.json while the
// `booking-complete` edge function read and wrote quickbooks_config, and nothing synced them. Fixed
// 2026-08-04. The local file is now only a fallback for a non-Supabase store, and is left on disk
// untouched so an older checkout can still be recovered from it.
//
// Only realm_id / refresh_token / access_token / access_expires_at live in the row. The client id
// and secret still come from the local credentials file on this side, because the Mac is where they
// are entered.

async function readToken() {
  if (CRM_STORE === 'supabase') {
    const { data, error } = await sb()
      .from('quickbooks_config')
      .select('realm_id, refresh_token, access_token, access_expires_at')
      .eq('id', 1)
      .maybeSingle()
    if (error || !data) return null
    if (!data.refresh_token || !data.realm_id) return null
    return {
      realmId: data.realm_id,
      refresh_token: data.refresh_token,
      access_token: data.access_token || '',
      // The file format tracked age as obtained_at + expires_in; the row stores the absolute expiry.
      // Convert so freshToken()'s arithmetic stays identical either way.
      expires_in: 3600,
      obtained_at: data.access_expires_at ? new Date(data.access_expires_at).getTime() - 3600 * 1000 : 0,
    }
  }
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'))
  } catch {
    return null
  }
}

async function writeToken(t) {
  if (CRM_STORE === 'supabase') {
    const { error } = await sb()
      .from('quickbooks_config')
      .update({
        realm_id: String(t.realmId || ''),
        refresh_token: String(t.refresh_token || ''),
        access_token: t.access_token || null,
        access_expires_at: new Date(Date.now() + (t.expires_in ?? 3600) * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', 1)
    // Losing this write means losing the connection, so it must not fail quietly.
    if (error) throw new Error(`Could not save the QuickBooks token: ${error.message}`)
    return
  }
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2) + '\n')
}

export function isConfigured() {
  const c = creds()
  return !!(c && c.clientId && !String(c.clientId).startsWith('PASTE') && c.clientSecret && !String(c.clientSecret).startsWith('PASTE'))
}
export async function isConnected() {
  const t = await readToken()
  return !!(t && t.refresh_token && t.realmId)
}
export async function status() {
  return { configured: isConfigured(), connected: await isConnected(), environment: creds()?.environment || 'sandbox' }
}

// --- OAuth2 -----------------------------------------------------------------

// The CSRF nonce for the connect currently in flight. In memory rather than on disk because it is
// meaningful for the seconds between clicking Connect and Intuit redirecting back; a restart in that
// window just means clicking Connect again. Previously a state was generated here and then never
// checked on the way back, which made it decorative.
let PENDING_STATE = ''

export function authUrl() {
  const c = creds()
  if (!isConfigured()) throw new Error('QuickBooks credentials are not set up.')
  PENDING_STATE = crypto.randomBytes(16).toString('hex')
  const params = new URLSearchParams({
    client_id: c.clientId,
    response_type: 'code',
    scope: SCOPE,
    redirect_uri: c.redirectUri,
    state: PENDING_STATE,
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

export async function handleCallback({ code, realmId, state }) {
  const c = creds()
  if (!code || !realmId) throw new Error('Missing code or realmId from QuickBooks.')
  // CSRF: the state we minted in authUrl() has to come back untouched. Without this check anyone
  // could hand Michael a crafted callback URL and attach THEIR QuickBooks company to his CRM, which
  // would quietly send his clients' invoices into someone else's books.
  if (!PENDING_STATE || state !== PENDING_STATE) {
    PENDING_STATE = ''
    throw new Error('That callback did not match the request we started. Click Connect again.')
  }
  PENDING_STATE = ''
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: c.redirectUri })
  await writeToken({ ...t, realmId, obtained_at: Date.now() })
  return { ok: true }
}

export async function disconnect() {
  if (CRM_STORE === 'supabase') {
    // NOT NULL columns, so blank rather than null. Both are treated as disconnected by readToken().
    await sb()
      .from('quickbooks_config')
      .update({ realm_id: '', refresh_token: '', access_token: null, access_expires_at: null, updated_at: new Date().toISOString() })
      .eq('id', 1)
  }
  try {
    fs.unlinkSync(TOKEN_FILE)
  } catch {
    // already gone
  }
  return { ok: true }
}

// Return a valid access token, refreshing if it's near expiry.
//
// The write-back matters more than it looks: Intuit returns a NEW refresh token on every refresh and
// retires the old one, so failing to store it loses the connection. Since the store is now shared
// with the cloud function, both sides pick up the rotation.
async function freshToken() {
  const t = await readToken()
  if (!t || !t.refresh_token) throw new Error('QuickBooks is not connected.')
  const ageMs = Date.now() - (t.obtained_at || 0)
  if (t.access_token && ageMs < ((t.expires_in || 3600) - 120) * 1000) return t
  const nt = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token })
  const merged = { ...t, ...nt, obtained_at: Date.now() }
  await writeToken(merged)
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
    // intuit_tid identifies this exact request in Intuit's own systems. It is the first thing their
    // support asks for, and an error report without it is close to untraceable on their side.
    const tid = res.headers.get('intuit_tid') || ''
    throw new Error(`QuickBooks API ${res.status}: ${msg}${tid ? ` [intuit_tid ${tid}]` : ''}`)
  }
  return data
}

async function query(sql) {
  return qb(`/query?query=${encodeURIComponent(sql)}`)
}

// --- Profit & Loss, for the finance page ------------------------------------
//
// WHY THE CRM READS THIS ITSELF rather than anybody pasting a figure in: an expense total that is
// typed in is wrong the next day. This is one call against the connection the CRM already holds.
//
// CASH BASIS, deliberately. The finance page's question is "what money came in and what money went
// out", not "what did I invoice". Accrual would count an invoice the day it was raised, which is
// not the question being asked and would not line up with the CRM's own payments-received figure.
//
// Returns { expenses, income, cogs, otherExpenses, start, end }. `expenses` is TOTAL business
// spend: operating expenses plus cost of goods sold plus other expenses. All three are money that
// left the business, and leaving one out would flatter the after-expenses number.
function plRowTotal(rows, group) {
  // The P&L is a tree. Each top-level section carries a `group` and a Summary row whose last
  // ColData cell holds its total. Walk rather than index, because the sections present depend on
  // which accounts have activity: a month with no COGS simply has no COGS section.
  const walk = (list) => {
    for (const r of list || []) {
      if (r.group === group && r.Summary?.ColData?.length) {
        const cell = r.Summary.ColData[r.Summary.ColData.length - 1]
        const n = Number(String(cell?.value ?? '').replace(/[$,]/g, ''))
        if (Number.isFinite(n)) return n
      }
      const inner = walk(r.Rows?.Row)
      if (inner != null) return inner
    }
    return null
  }
  return walk(rows) ?? 0
}

export async function profitAndLoss(startDate, endDate) {
  const start = String(startDate)
  const end = String(endDate)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    throw new Error('profitAndLoss needs YYYY-MM-DD dates.')
  }
  const data = await qb(
    `/reports/ProfitAndLoss?start_date=${start}&end_date=${end}&accounting_method=Cash`,
  )
  const rows = data?.Rows?.Row || []
  const expenses = plRowTotal(rows, 'Expenses')
  const cogs = plRowTotal(rows, 'COGS')
  const otherExpenses = plRowTotal(rows, 'OtherExpenses')
  return {
    start,
    end,
    income: plRowTotal(rows, 'Income'),
    expenses: Math.round((expenses + cogs + otherExpenses) * 100) / 100,
    operatingExpenses: expenses,
    cogs,
    otherExpenses,
  }
}

// The same P&L, split into months.
//
// One call rather than twelve. The report's column metadata carries each column's StartDate, which
// is what keys a column to a 'YYYY-MM' month; the column titles cannot be trusted for this because
// the current month comes back as "Sep 1-28, 2026" rather than "Sep 2026".
//
// Returns [{ month, income, expenses }] oldest first, one entry per month in the range.
export async function profitAndLossByMonth(startDate, endDate) {
  const start = String(startDate)
  const end = String(endDate)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    throw new Error('profitAndLossByMonth needs YYYY-MM-DD dates.')
  }
  const data = await qb(
    `/reports/ProfitAndLoss?start_date=${start}&end_date=${end}&accounting_method=Cash&summarize_column_by=Month`,
  )

  // Column 0 is the account name and the last is the Total, so only the ones carrying a StartDate
  // are real months. Their INDEX is what lines up with the cells on each row.
  const months = []
  ;(data?.Columns?.Column || []).forEach((col, i) => {
    const meta = (col.MetaData || []).find((m) => m.Name === 'StartDate')
    if (meta?.Value) months.push({ index: i, month: String(meta.Value).slice(0, 7) })
  })

  // The value a top-level group reports in one column.
  const cellOf = (group, index) => {
    const walk = (list) => {
      for (const r of list || []) {
        if (r.group === group) {
          const cells = r.Summary?.ColData || r.ColData || []
          const n = Number(String(cells[index]?.value ?? '').replace(/[$,]/g, ''))
          return Number.isFinite(n) ? n : 0
        }
        const inner = walk(r.Rows?.Row)
        if (inner != null) return inner
      }
      return null
    }
    return walk(data?.Rows?.Row) ?? 0
  }

  return months.map(({ index, month }) => ({
    month,
    income: cellOf('Income', index),
    // Total business spend, same definition as profitAndLoss(): operating + COGS + other.
    expenses:
      Math.round((cellOf('Expenses', index) + cellOf('COGS', index) + cellOf('OtherExpenses', index)) * 100) / 100,
  }))
}

// The earliest date QuickBooks actually has an expense on.
//
// ⚠️ THIS IS NOT A DETAIL. QuickBooks holds nothing before January 2026 (checked 2026-09-28: every
// month of 2024 and 2025 reports zero), while the CRM has payments back to May 2025. Subtracting
// nine months of expenses from twelve months of income would produce an "after expenses" figure
// that is too high by about three months of spending, and it would look perfectly plausible.
//
// So the finance page asks for this and refuses to net off a period QuickBooks cannot cover.
export async function quickbooksExpensesSince() {
  const r = await query('select * from Purchase order by TxnDate asc maxresults 1')
  const txn = r?.QueryResponse?.Purchase?.[0]
  return txn?.TxnDate || ''
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

// Look up a payment term by name so the invoice's Terms box is filled in rather than blank.
// Resolved at runtime rather than hard-coded, because the Term Id differs between the sandbox and
// the production realm. "Due on receipt" is one of QuickBooks' stock terms and exists in a default
// account. Returns null rather than throwing: a missing term should not stop an invoice being made.
async function findTermByName(name) {
  const safe = String(name || '').replace(/['\\]/g, ' ').trim()
  if (!safe) return null
  try {
    const found = await query(`select * from Term where Name = '${safe}'`)
    return found?.QueryResponse?.Term?.[0] || null
  } catch {
    return null
  }
}

// --- Per-project invoice references (so the project page can show status) ----
// Read the whole { invoices: { [projectId]: ref } } object. Under supabase it is reconstructed from
// the row-per-project jsonb cache; under files it is the JSON file. Lookups in the writers use this.
function readInvoices() {
  if (CRM_STORE === 'supabase') {
    const invoices = {}
    for (const r of getCachedInvoices()) invoices[r.project_id] = r.data
    return { invoices }
  }
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
    shape: 'invoices[projectId] = { invoiceId, docNumber, total, amount, processingFee, dueDate, customer, email, createdAt, sentAt, balance, paidAt }',
  }
  fs.writeFileSync(INVOICES_FILE, JSON.stringify(d, null, 2) + '\n')
}
// Persist ONE project's invoice ref. Supabase: upsert its jsonb row (+ cache). Files: rewrite the
// whole file. `d` is the whole-map object the writer already mutated (used only for the files path).
async function persistInvoice(projectId, ref, d) {
  if (CRM_STORE === 'supabase') {
    const row = { project_id: projectId, data: ref }
    cacheUpsertInvoice(row)
    await sbUpsertInvoice(row)
    return
  }
  writeInvoices(d)
}
export function loadInvoices() {
  return readInvoices().invoices
}

// Re-fetch the live invoice from QuickBooks and update its stored Balance + paid state. A Balance of
// 0 means paid in full. Stamps paidAt once when it first reaches 0. Returns the updated ref (or null
// if the project has no invoice).
export async function refreshInvoiceStatus(projectId) {
  const d = readInvoices()
  const ref = d.invoices[projectId]
  if (!ref || !ref.invoiceId) return null
  const data = await qb(`/invoice/${encodeURIComponent(ref.invoiceId)}`)
  const inv = data?.Invoice
  if (!inv) return ref
  ref.balance = Number(inv.Balance != null ? inv.Balance : ref.balance || 0)
  if (ref.balance === 0 && !ref.paidAt) ref.paidAt = new Date().toISOString()
  d.invoices[projectId] = ref
  await persistInvoice(projectId, ref, d)
  return ref
}

// opts: { amount, dueDate (YYYY-MM-DD), processingFeePercent }. Amount defaults to
// the project's Quote (total fee) when not given, so partial invoices (e.g. a 50%
// deposit) are just a lower amount. A processingFeePercent > 0 adds a separate
// "Card Processing Fee" line so the client covers the card-processing cost.
// The note that prints on every invoice, under "Note to customer". Kept here so it is written once
// and not retyped per invoice. Michael, 2026-09-03.
//
// ⚠️ PAYMENT INSTRUCTIONS ARE NOT HERE, AND CANNOT BE. QuickBooks has no per-invoice payment
// instructions field in its API: it is a company-level sales-form setting. Michael's wording lives
// in QuickBooks under Settings > Sales > Messages, which has the advantage of also covering invoices
// he raises by hand. See the CRM notes if it ever needs changing.
const INVOICE_NOTE_TO_CUSTOMER =
  "Thanks so much for booking, I'm really looking forward to it! Please don't hesitate to reach out if there is anything you need before the event."

export async function createInvoiceForProject(projectId, opts = {}) {
  const project = loadAll().projects.find((p) => p.id === projectId)
  if (!project) throw new Error('Project not found.')
  const quote = project.totalFee == null ? NaN : Number(project.totalFee)
  let amount = opts.amount === undefined || opts.amount === null || opts.amount === '' ? quote : Number(opts.amount)
  if (!amount || Number.isNaN(amount) || amount <= 0) {
    throw new Error('Enter an invoice amount (or set a Quote on the project first).')
  }
  amount = Math.round(amount * 100) / 100
  const email =
    String(opts.email || '').trim() || String(project.contactEmails || '').split(/[,;]/)[0].trim() || ''
  const customerName = String(opts.customerName || '').trim() || project.client
  const customer = await ensureCustomer(customerName, email)
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

  // TERMS: always "Due on receipt" unless a caller overrides it (Michael, 2026-09-03). Payment is
  // due up front to hold the date, so anything else on the invoice contradicts the agreement.
  const termName = String(opts.terms ?? 'Due on receipt').trim()
  if (termName) {
    const term = await findTermByName(termName)
    if (term) body.SalesTermRef = { value: term.Id }
  }
  // A per-invoice memo is only set if a caller explicitly passes one. It used to default to
  // invoiceMemo(), but that text was written as the EMAIL that accompanies an invoice, not as the
  // note printed on the invoice document, and reusing it here made one piece of writing do two jobs
  // nobody chose (removed 2026-08-04). The invoice-facing wording now lives where it belongs, in
  // QuickBooks' own Sales > Messages settings, which also covers invoices Michael raises by hand.
  // NOTE TO CUSTOMER (prints on the invoice). Defaulted so Michael is not retyping it on every
  // invoice; pass opts.memo to override, or opts.memo = '' to leave it blank.
  const memo = String(opts.memo ?? INVOICE_NOTE_TO_CUSTOMER).trim()
  if (memo) body.CustomerMemo = { value: memo.slice(0, 1000) }

  // MEMO ON STATEMENT (hidden from the client). Carries the details that make a payment easy to
  // reconcile months later, which is the only job this field has.
  const privateNote = String(
    opts.privateNote ??
      [project.client, project.eventType, project.eventDate, `CRM: ${projectId}`].filter(Boolean).join(' · '),
  ).trim()
  if (privateNote) body.PrivateNote = privateNote.slice(0, 4000)
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
  await persistInvoice(projectId, ref, d)
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
  await persistInvoice(projectId, ref, d)
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
