// CRM-owned contract generator. Builds a Performance Services Agreement from a project
// (auto-filling the event facts), lets Michael edit the text, and renders it to a PDF he
// signs/sends outside the app. Multiple VERSIONS are kept per project so he can generate a
// corrected one and archive/delete the old. Definitions in crm-contract-template.mjs;
// per-project versions stored in Project Records/crm-contracts.json. The PDF is rendered
// on demand from the stored text (no binary files to manage).

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import PDFDocument from 'pdfkit'
import { RECORDS_DIR, loadAll } from './crm-data-core.mjs'
import { buildContractBody, BRAND, TITLE, SIGNATURE_LINES } from './crm-contract-template.mjs'
import * as esign from './crm-esign.mjs'

// pdfmake (server build), html-to-pdfmake, and jsdom are CommonJS; the ESM default of
// 'pdfmake' resolves to its browser build, so load all three via createRequire.
const require = createRequire(import.meta.url)
const PdfPrinter = require('pdfmake/src/printer')
const htmlToPdfmake = require('html-to-pdfmake')
const { JSDOM } = require('jsdom')

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
    shape: 'contracts[projectId] = [ { id, version, status (draft|sent), includeMedia, format (html|text), body, createdAt, sentAt, esign? { id, status, signerName, signerEmail, testMode, sentAt, signedAt } } ]',
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

// Assemble a fresh draft (auto-filled, unsaved) for the generate dialog. Returns the
// editable body HTML, the Insert-field list, and any missing fields.
export function draftContract(projectId) {
  const project = findProject(projectId)
  const todayISO = new Date().toISOString().slice(0, 10)
  const built = buildContractBody(project, { todayISO })
  return { ...built, brand: BRAND, title: TITLE, signatureLines: SIGNATURE_LINES }
}

// Save a new version from the (possibly edited) rich HTML body.
export function createContract(projectId, { body, includeMedia = false, format = 'html' }) {
  const html = String(body || '').trim()
  if (!html) throw new Error('The contract is empty.')
  const d = readContracts()
  const list = Array.isArray(d.contracts[projectId]) ? d.contracts[projectId] : []
  const version = list.reduce((m, c) => Math.max(m, c.version || 0), 0) + 1
  const ref = {
    id: crypto.randomBytes(8).toString('hex'),
    version,
    status: 'draft',
    includeMedia: !!includeMedia,
    format: format === 'html' ? 'html' : 'text',
    body: html,
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
const BRONZE = '#9a7536' // tasteful brass that reads on white; matches the editor accent
const INK = '#1f1c17'

// Pick an available serif font family from the system so the PDF matches the serif editor.
// (pdfmake needs real font files; macOS ships Georgia + Times New Roman as plain TTFs.)
function serifFonts() {
  const dir = '/System/Library/Fonts/Supplemental'
  const families = [
    { name: 'Georgia', files: ['Georgia.ttf', 'Georgia Bold.ttf', 'Georgia Italic.ttf', 'Georgia Bold Italic.ttf'] },
    { name: 'Times New Roman', files: ['Times New Roman.ttf', 'Times New Roman Bold.ttf', 'Times New Roman Italic.ttf', 'Times New Roman Bold Italic.ttf'] },
  ]
  for (const f of families) {
    const p = f.files.map((n) => path.join(dir, n))
    if (p.every((x) => fs.existsSync(x))) {
      return { name: f.name, config: { [f.name]: { normal: p[0], bold: p[1], italics: p[2], bolditalics: p[3] } } }
    }
  }
  return null
}

// Render the rich HTML body to a PDF via pdfmake, wrapped in the fixed chrome (centered
// bronze letterhead, title + rule, signature block). Honors the editor's formatting
// (bold/italic/underline/strikethrough/highlight, bullet + numbered lists, alignment).
async function pdfFromHtml(bodyHtml, { forSigning = false } = {}) {
  const serif = serifFonts()
  if (!serif) throw new Error('No serif font available on this machine to render the contract PDF.')
  const printer = new PdfPrinter(serif.config)
  const { window } = new JSDOM('')
  const margins = [66, 56, 66, 56] // left, top, right, bottom
  const contentW = 612 - margins[0] - margins[2] // LETTER width
  const rule = () => ({
    canvas: [{ type: 'line', x1: 0, y1: 0, x2: contentW, y2: 0, lineWidth: 0.75, lineColor: INK }],
    margin: [0, 5, 0, 11],
  })
  const converted = htmlToPdfmake(bodyHtml, {
    window,
    defaultStyles: {
      p: { margin: [0, 0, 0, 6] },
      ul: { margin: [0, 0, 0, 6] },
      ol: { margin: [0, 0, 0, 6] },
      li: { margin: [0, 0, 0, 2] },
      h1: { fontSize: 15, bold: true, margin: [0, 8, 0, 4] },
      h2: { fontSize: 13, bold: true, margin: [0, 7, 0, 3] },
      h3: { fontSize: 11.5, bold: true, margin: [0, 6, 0, 2] },
    },
  })
  const body = Array.isArray(converted) ? converted : [converted]
  // Signature block. For an e-signature send, the client line carries a white (invisible)
  // SignWell text tag so the platform overlays the signature field there; otherwise plain
  // signature lines for printing/manual signing.
  const sigItems = forSigning
    ? [
        { text: ['Client signature: ', { text: '{{signature|1}}', color: '#ffffff' }], margin: [0, 6, 0, 0] },
        { text: 'Performer signature: ___________________________     Date: ____________', margin: [0, 12, 0, 0] },
      ]
    : [
        { text: SIGNATURE_LINES[0], margin: [0, 6, 0, 0] },
        { text: SIGNATURE_LINES[1], margin: [0, 10, 0, 0] },
      ]
  const docDef = {
    pageSize: 'LETTER',
    pageMargins: margins,
    defaultStyle: { font: serif.name, fontSize: 10.5, color: INK, lineHeight: 1.25 },
    content: [
      { text: BRAND, alignment: 'center', color: INK, bold: true, fontSize: 12.5, characterSpacing: 0.5, margin: [0, 0, 0, 6] },
      { text: TITLE, alignment: 'center', bold: true, fontSize: 15, characterSpacing: 1, margin: [0, 0, 0, 2] },
      rule(),
      ...body,
      rule(),
      ...sigItems,
    ],
  }
  const pdfDoc = printer.createPdfKitDocument(docDef)
  const chunks = []
  return new Promise((resolve, reject) => {
    pdfDoc.on('data', (c) => chunks.push(c))
    pdfDoc.on('end', () => resolve(Buffer.concat(chunks)))
    pdfDoc.on('error', reject)
    pdfDoc.end()
  })
}

function pdfFromText(text) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margins: { top: 58, bottom: 58, left: 66, right: 66 } })
    const chunks = []
    doc.on('data', (c) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    const left = doc.page.margins.left
    const right = doc.page.width - doc.page.margins.right
    const contentW = right - left
    const rule = () => {
      doc.moveDown(0.5)
      const y = doc.y
      doc.save().lineWidth(0.75).strokeColor(BRONZE).moveTo(left, y).lineTo(right, y).stroke().restore()
      doc.moveDown(0.7)
    }

    // Letterhead (logo placeholder): centered bronze wordmark.
    doc.font('Times-Bold').fontSize(13).fillColor(BRONZE)
      .text(BRAND, left, doc.y, { width: contentW, align: 'center', characterSpacing: 0.6 })
    doc.moveDown(0.5)

    const lines = String(text).split('\n')
    lines.forEach((raw, idx) => {
      const line = raw.replace(/\s+$/, '')
      if (idx === 0) {
        doc.font('Times-Bold').fontSize(15).fillColor(INK).text(line, left, doc.y, { width: contentW, align: 'center', characterSpacing: 1 })
        rule()
        return
      }
      if (line === '') {
        doc.moveDown(0.4)
        return
      }
      if (/^Client signature:/.test(line)) {
        rule()
        doc.font('Times-Roman').fontSize(10.5).fillColor(INK).text(line, left, doc.y, { width: contentW })
        return
      }
      if (/^\d+\.\s/.test(line)) {
        doc.moveDown(0.25)
        doc.font('Times-Bold').fontSize(11.5).fillColor(INK).text(line, left, doc.y, { width: contentW })
        doc.moveDown(0.1)
        return
      }
      if (/^[•-]\s/.test(line)) {
        const txt = line.replace(/^[•-]\s+/, '')
        const y = doc.y
        doc.font('Times-Roman').fontSize(10.5).fillColor(INK)
        doc.text('•', left + 4, y, { width: 10 })
        doc.text(txt, left + 18, y, { width: contentW - 18 })
        return
      }
      doc.font('Times-Roman').fontSize(10.5).fillColor(INK).text(line, left, doc.y, { width: contentW })
    })
    doc.end()
  })
}

export async function contractPdf(projectId, id, { forSigning = false } = {}) {
  const d = readContracts()
  const ref = (d.contracts[projectId] || []).find((c) => c.id === id)
  if (!ref) throw new Error('Contract version not found.')
  const project = loadAll().projects.find((p) => p.id === projectId)
  const name = (project?.client || 'contract').replace(/[^\w.-]+/g, '-')
  const buffer = ref.format === 'html' ? await pdfFromHtml(ref.body, { forSigning }) : await pdfFromText(ref.body)
  return { buffer, fileName: `Contract - ${name} v${ref.version}.pdf` }
}

// --- E-signature (SignWell) orchestration -----------------------------------
function findVersion(projectId, id) {
  const d = readContracts()
  const ref = (d.contracts[projectId] || []).find((c) => c.id === id)
  if (!ref) throw new Error('Contract version not found.')
  return { d, ref }
}

// Render the signing PDF (with the text tag) and send it to the signer via SignWell.
export async function sendForSignature(projectId, id, { signerName, signerEmail } = {}) {
  if (!esign.isConfigured()) throw new Error('SignWell is not connected.')
  const to = String(signerEmail || '').trim()
  if (!to) throw new Error("Enter the signer's email address.")
  const { d, ref } = findVersion(projectId, id)
  if (ref.format !== 'html') throw new Error('Generate a fresh contract version before sending for e-signature.')
  const project = loadAll().projects.find((p) => p.id === projectId)
  const clientName = String(signerName || project?.client || 'Client').trim()
  const { buffer } = await contractPdf(projectId, id, { forSigning: true })
  const doc = await esign.createDocument({
    name: `Contract - ${project?.client || clientName} v${ref.version}`,
    fileName: `Contract - ${project?.client || clientName}.pdf`,
    fileBase64: buffer.toString('base64'),
    signerName: clientName,
    signerEmail: to,
  })
  ref.esign = {
    id: doc.id || doc.document_id || '',
    status: doc.status || 'sent',
    signerName: clientName,
    signerEmail: to,
    testMode: esign.isTestMode(),
    sentAt: new Date().toISOString(),
    signedAt: '',
  }
  if (ref.status === 'draft') ref.status = 'sent'
  writeContracts(d)
  return ref
}

// Poll SignWell for the latest status; mark signed when complete.
export async function refreshSignature(projectId, id) {
  const { d, ref } = findVersion(projectId, id)
  if (!ref.esign || !ref.esign.id) throw new Error('No signature request on this contract version.')
  const doc = await esign.getDocument(ref.esign.id)
  const st = String(doc.status || '').toLowerCase()
  ref.esign.status = doc.status || ref.esign.status
  const done = st === 'completed' || st === 'signed' || doc.completed === true
  if (done && !ref.esign.signedAt) ref.esign.signedAt = new Date().toISOString()
  writeContracts(d)
  return ref
}

// Fetch the completed signed PDF bytes from SignWell.
export async function signedContractPdf(projectId, id) {
  const { ref } = findVersion(projectId, id)
  if (!ref.esign || !ref.esign.id) throw new Error('No signature request on this contract version.')
  const project = loadAll().projects.find((p) => p.id === projectId)
  const name = (project?.client || 'contract').replace(/[^\w.-]+/g, '-')
  const buffer = await esign.completedPdf(ref.esign.id)
  return { buffer, fileName: `Contract - ${name} v${ref.version} (signed).pdf` }
}
