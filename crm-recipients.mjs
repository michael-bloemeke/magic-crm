// Per-project DOCUMENT RECIPIENTS (CRM-owned). Who a project's client-facing documents go to: the
// contract SIGNER and the invoice BILL-TO. The person Michael spoke to often is not the one who can
// sign, and an invoice may need to be addressed to a company rather than a person, so this stores
// those choices per project (defaulting to the project's first contact when unset).
//
// signerId / billToId are contact ids (from crm-contacts.json). billToName is a free-text billing
// display name for the invoice (e.g. a company), used as the QuickBooks customer name; blank means
// "use the bill-to contact's name (or the project name)".

import fs from 'node:fs'
import path from 'node:path'
import { RECORDS_DIR } from './crm-data-core.mjs'

const FILE = path.join(RECORDS_DIR, 'crm-recipients.json')

function meta() {
  return {
    file: 'crm-recipients.json',
    owner: 'Magic CRM app (~/Desktop/Claude/magic-crm)',
    purpose:
      'Per-project document recipients: the contract signer (signerId) and the invoice bill-to (billToId + billToName). Defaults to the project first contact when unset.',
    cowork_guidance: 'Safe to read. CRM-owned, do NOT delete or overwrite.',
    shape: 'recipients[projectId] = { signerId, billToId, billToName }',
  }
}

function read() {
  let d
  try {
    d = JSON.parse(fs.readFileSync(FILE, 'utf8'))
  } catch {
    d = null
  }
  if (!d || typeof d.recipients !== 'object' || d.recipients === null) d = { recipients: {} }
  return d
}
function write(d) {
  d._meta = meta()
  fs.writeFileSync(FILE, JSON.stringify(d, null, 2) + '\n')
}

export function loadRecipients() {
  return read().recipients
}
export function loadRecipient(projectId) {
  return read().recipients[projectId] || null
}
export function saveRecipient(projectId, patch = {}) {
  if (!projectId) throw new Error('projectId is required')
  const d = read()
  const cur = d.recipients[projectId] || { signerId: '', billToId: '', billToName: '' }
  const next = { ...cur }
  if (patch.signerId !== undefined) next.signerId = String(patch.signerId || '')
  if (patch.billToId !== undefined) next.billToId = String(patch.billToId || '')
  if (patch.billToName !== undefined) next.billToName = String(patch.billToName || '')
  d.recipients[projectId] = next
  write(d)
  return next
}
