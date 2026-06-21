// CRM-owned contract generator. Builds a Performance Services Agreement from a project
// (auto-filling the event facts), lets Michael edit the text, and renders it to a PDF he
// signs/sends outside the app. Multiple VERSIONS are kept per project so he can generate a
// corrected one and archive/delete the old. Definitions in crm-contract-template.mjs;
// per-project versions stored in Project Records/crm-contracts.json. The PDF is rendered
// on demand from the stored text (no binary files to manage).

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import PDFDocument from 'pdfkit'
import { RECORDS_DIR, loadAll } from './crm-data-core.mjs'
import { buildContractText } from './crm-contract-template.mjs'

const CONTRACTS_FILE = path.join(RECORDS_DIR, 'crm-contracts.json')

function readContracts() {
  let d
  try {
    d = JSON.parse(fs.readFileSync(CONTRACTS_FILE, 'utf8'))
  } catch {
    d = null
  }
  if (!d || typeof d.contracts !== 'object' || d.contracts === null) d = { contracts: {} }
  return d
}
function writeContracts(d) {
  d._meta = {
    file: 'crm-contracts.json',
    owner: 'Magic CRM app (~/Desktop/Claude/magic-crm)',
    purpose:
      'Per-project Performance Services Agreement versions generated in the CRM. Each version stores the final (edited) contract TEXT; the PDF is rendered on demand from it. Michael signs/sends the PDF outside the app.',
    cowork_guidance: 'Safe to read. CRM-owned, do NOT overwrite.',
    shape: 'contracts[projectId] = [ { id, version, status (draft|sent), includeMedia, body, createdAt, sentAt } ]',
  }
  fs.writeFileSync(CONTRACTS_FILE, JSON.stringify(d, null, 2) + '\n')
}

export function loadContracts() {
  return readContracts().contracts
}

function findProject(projectId) {
  const project = loadAll().projects.find((p) => p.id === projectId)
  if (!project) throw new Error('Project not found.')
  return project
}

// Assemble a fresh draft (auto-filled, unsaved) for the generate dialog.
export function draftContract(projectId, { includeMedia = false } = {}) {
  const project = findProject(projectId)
  const todayISO = new Date().toISOString().slice(0, 10)
  return buildContractText(project, { includeMedia, todayISO })
}

// Save a new version from the (possibly edited) text.
export function createContract(projectId, { body, includeMedia = false }) {
  const text = String(body || '').trim()
  if (!text) throw new Error('The contract is empty.')
  const d = readContracts()
  const list = Array.isArray(d.contracts[projectId]) ? d.contracts[projectId] : []
  const version = list.reduce((m, c) => Math.max(m, c.version || 0), 0) + 1
  const ref = {
    id: crypto.randomBytes(8).toString('hex'),
    version,
    status: 'draft',
    includeMedia: !!includeMedia,
    body: text,
    createdAt: new Date().toISOString(),
    sentAt: '',
  }
  d.contracts[projectId] = [...list, ref]
  writeContracts(d)
  return ref
}

export function setContractStatus(projectId, id, status) {
  const allowed = ['draft', 'sent']
  if (!allowed.includes(status)) throw new Error('Invalid status.')
  const d = readContracts()
  const list = d.contracts[projectId] || []
  const ref = list.find((c) => c.id === id)
  if (!ref) throw new Error('Contract version not found.')
  ref.status = status
  ref.sentAt = status === 'sent' ? ref.sentAt || new Date().toISOString() : ref.sentAt
  writeContracts(d)
  return ref
}

export function deleteContract(projectId, id) {
  const d = readContracts()
  const list = d.contracts[projectId] || []
  d.contracts[projectId] = list.filter((c) => c.id !== id)
  if (d.contracts[projectId].length === 0) delete d.contracts[projectId]
  writeContracts(d)
  return { ok: true }
}

// --- PDF rendering (on demand, from the stored text) ------------------------
function pdfFromText(text) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margins: { top: 64, bottom: 64, left: 64, right: 64 } })
    const chunks = []
    doc.on('data', (c) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    const lines = String(text).split('\n')
    lines.forEach((raw, idx) => {
      const line = raw.replace(/\s+$/, '')
      if (idx === 0) {
        doc.font('Helvetica-Bold').fontSize(15).text(line, { align: 'center' })
        doc.moveDown(0.8)
        return
      }
      if (line === '') {
        doc.moveDown(0.45)
        return
      }
      if (/^\d+\.\s/.test(line)) {
        doc.moveDown(0.15)
        doc.font('Helvetica-Bold').fontSize(11.5).text(line)
        doc.moveDown(0.1)
        return
      }
      doc.font('Helvetica').fontSize(10.5).text(line, { align: 'left' })
    })
    doc.end()
  })
}

export async function contractPdf(projectId, id) {
  const d = readContracts()
  const ref = (d.contracts[projectId] || []).find((c) => c.id === id)
  if (!ref) throw new Error('Contract version not found.')
  const project = loadAll().projects.find((p) => p.id === projectId)
  const name = (project?.client || 'contract').replace(/[^\w.-]+/g, '-')
  const buffer = await pdfFromText(ref.body)
  return { buffer, fileName: `Contract - ${name} v${ref.version}.pdf` }
}
