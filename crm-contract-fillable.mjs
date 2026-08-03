// Fillable-PDF contracts: the no-e-signature-service route.
//
// Instead of paying SignWell to collect a signature, the CRM builds a PDF that has REAL form fields
// in it (an AcroForm, the standard PDF feature). Michael emails it, the client opens it in Preview /
// Acrobat / Chrome, types straight into the boxes, ticks the approval box, types their name at the
// bottom, saves, and emails it back.
//
// Shape of the document:
//   Page 1      "Details we still need" - one text box per event fact the CRM is missing, plus a
//               confirmation of their contact details and the approval checkbox.
//   Page 2..n   The Performance Services Agreement itself, auto-filled from the project, rendered by
//               the SAME pdfmake pipeline the existing contract PDF uses (so Michael's edited
//               template and its formatting carry over untouched).
//   Last page   Typed name + date, in place of a signature.
//
// Why two libraries: pdfmake lays out the rich contract text beautifully but can only make FLAT
// PDFs; it has no concept of form fields. pdf-lib can create form fields but has no HTML/rich-text
// layout. So pdfmake renders the contract, then pdf-lib opens that output, prepends the form page,
// and overlays the interactive fields.
//
// Coordinate note: pdf-lib's origin is the BOTTOM-left of the page and y grows upward, which is the
// opposite of most screen drawing. Everything here is written bottom-up on purpose.

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { buildContractBody } from './crm-contracts.mjs'
import { fmtDate } from './crm-contract-template.mjs'

// LETTER, in PDF points.
const PAGE_W = 612
const PAGE_H = 792
const MARGIN = 66

const INK = rgb(0.13, 0.11, 0.09)
const MUTED = rgb(0.42, 0.39, 0.35)
const RULE = rgb(0.72, 0.68, 0.62)
const FIELD_BG = rgb(0.98, 0.97, 0.94)
const FIELD_EDGE = rgb(0.62, 0.57, 0.49)

// The event facts a CLIENT can actually answer. Deliberately excludes anything internal (the fee,
// the lead date, how the booking was sourced) - never put those in front of a client.
// `key` matches the project field; `ask` is how it's worded to them.
const CLIENT_ANSWERABLE = [
  { key: 'eventLocation', ask: 'Event address (full street address)' },
  { key: 'venueType', ask: 'Type of venue (home, hotel, country club, etc.)' },
  { key: 'indoorsOrOutdoors', ask: 'Indoors or outdoors?' },
  { key: 'eventStartTime', ask: 'What time does the event start?' },
  { key: 'showStartTime', ask: 'What time should the magic start?' },
  { key: 'numberOfGuests', ask: 'About how many guests?' },
  { key: 'ageOfGuests', ask: 'Rough ages of the guests' },
  { key: 'vips', ask: 'Anyone special to know about (guest of honor, birthday, etc.)?' },
  { key: 'av', ask: 'Is there a sound system / microphone available?' },
]

const blank = (v) => !String(v ?? '').trim()

// Which questions to put on page 1: the client-answerable facts this project is still missing.
export function missingClientFacts(project) {
  return CLIENT_ANSWERABLE.filter((f) => blank(project[f.key]))
}

// Strip the contract HTML down to plain paragraphs. Only used for the fallback renderer.
function htmlToLines(html) {
  return String(html || '')
    .replace(/<\/(p|div|h[1-3]|li)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '  - ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

// Greedy word wrap to a pixel width.
function wrap(text, font, size, maxW) {
  const out = []
  for (const para of String(text).split('\n')) {
    let line = ''
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word
      if (font.widthOfTextAtSize(next, size) > maxW && line) {
        out.push(line)
        line = word
      } else {
        line = next
      }
    }
    out.push(line)
  }
  return out
}

// ---------------------------------------------------------------------------
// Page 1: the questions
// ---------------------------------------------------------------------------

function drawFormPage(doc, form, project, facts, fonts) {
  const page = doc.insertPage(0, [PAGE_W, PAGE_H])
  const { bold, reg, italic } = fonts
  const contentW = PAGE_W - MARGIN * 2
  let y = PAGE_H - MARGIN

  // Letterhead
  page.drawText('A FEW DETAILS BEFORE YOUR EVENT', {
    x: MARGIN, y, size: 15, font: bold, color: INK,
  })
  y -= 20
  page.drawText(`Prepared for ${project.client}`, { x: MARGIN, y, size: 10.5, font: reg, color: MUTED })
  y -= 16
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 0.75, color: RULE })
  y -= 22

  const intro = facts.length
    ? 'Please type your answers in the boxes below, then read the agreement on the following pages, tick the box at the bottom, and type your name. Save the file and email it back.'
    : 'Please read the agreement on the following pages, tick the box at the bottom, and type your name. Save the file and email it back.'
  for (const line of wrap(intro, reg, 10, contentW)) {
    page.drawText(line, { x: MARGIN, y, size: 10, font: reg, color: INK })
    y -= 13
  }
  y -= 10

  // One labelled box per missing fact.
  for (const f of facts) {
    page.drawText(f.ask, { x: MARGIN, y, size: 9.5, font: bold, color: INK })
    y -= 17
    const field = form.createTextField(`fact_${f.key}`)
    field.setText('')
    field.addToPage(page, {
      x: MARGIN, y: y - 3, width: contentW, height: 20,
      borderWidth: 0.75, borderColor: FIELD_EDGE, backgroundColor: FIELD_BG,
      font: reg,
    })
    y -= 30
  }

  // Anything else box
  y -= 4
  page.drawText('Anything else I should know?', { x: MARGIN, y, size: 9.5, font: bold, color: INK })
  y -= 17
  const notes = form.createTextField('client_notes')
  notes.setText('')
  notes.enableMultiline()
  notes.addToPage(page, {
    x: MARGIN, y: y - 42, width: contentW, height: 60,
    borderWidth: 0.75, borderColor: FIELD_EDGE, backgroundColor: FIELD_BG,
    font: reg,
  })
  y -= 60

  // Confirm contact details
  y -= 18
  page.drawText('Your contact details (correct these if anything is wrong)', {
    x: MARGIN, y, size: 9.5, font: bold, color: INK,
  })
  y -= 18
  const halfW = (contentW - 12) / 2
  const contact = [
    { name: 'client_name_confirm', label: 'Name', value: project.client || '', x: MARGIN, w: halfW },
    { name: 'client_email_confirm', label: 'Email', value: firstOf(project.contactEmails), x: MARGIN + halfW + 12, w: halfW },
  ]
  for (const c of contact) {
    page.drawText(c.label, { x: c.x, y, size: 8, font: reg, color: MUTED })
  }
  y -= 15
  for (const c of contact) {
    const t = form.createTextField(c.name)
    t.setText(c.value)
    t.addToPage(page, {
      x: c.x, y: y - 3, width: c.w, height: 20,
      borderWidth: 0.75, borderColor: FIELD_EDGE, backgroundColor: FIELD_BG,
      font: reg,
    })
  }
  y -= 26
  page.drawText('Phone', { x: MARGIN, y, size: 8, font: reg, color: MUTED })
  y -= 15
  const phone = form.createTextField('client_phone_confirm')
  phone.setText(String(project.contactPhones || '').split(/[,;]/)[0].trim())
  phone.addToPage(page, {
    x: MARGIN, y: y - 3, width: halfW, height: 20,
    borderWidth: 0.75, borderColor: FIELD_EDGE, backgroundColor: FIELD_BG,
    font: reg,
  })

  // Footer note
  page.drawText('The agreement itself is on the following pages.', {
    x: MARGIN, y: MARGIN - 18, size: 9, font: italic, color: MUTED,
  })
  return page
}

function firstOf(str) {
  return String(str || '').split(/[,;]/)[0].trim()
}

// ---------------------------------------------------------------------------
// Last page: typed name in place of a signature
// ---------------------------------------------------------------------------

function drawSignatureBlock(doc, form, project, fonts) {
  const pages = doc.getPages()
  const page = pages[pages.length - 1]
  const { bold, reg, italic } = fonts
  const contentW = PAGE_W - MARGIN * 2

  // The contract render reserves clear space at the foot of its final page (see
  // FOOT_RESERVE in contractFillablePdf), so this block never lands on top of contract text.
  let y = MARGIN + 118

  page.drawLine({ start: { x: MARGIN, y: y + 16 }, end: { x: PAGE_W - MARGIN, y: y + 16 }, thickness: 0.75, color: RULE })

  // Approval checkbox
  const cb = form.createCheckBox('client_approves')
  cb.addToPage(page, {
    x: MARGIN, y: y - 12, width: 13, height: 13,
    borderWidth: 1, borderColor: FIELD_EDGE, backgroundColor: FIELD_BG,
  })
  const approveText = 'I have read this Agreement and I approve it.'
  page.drawText(approveText, { x: MARGIN + 20, y: y - 9, size: 10, font: bold, color: INK })
  y -= 40

  // Typed name + date, side by side
  const halfW = (contentW - 20) / 2
  page.drawText('Type your full name to sign', { x: MARGIN, y, size: 8.5, font: reg, color: MUTED })
  page.drawText('Date', { x: MARGIN + halfW + 20, y, size: 8.5, font: reg, color: MUTED })
  y -= 20

  const nameField = form.createTextField('client_typed_name')
  nameField.setText('')
  nameField.addToPage(page, {
    x: MARGIN, y: y - 3, width: halfW, height: 22,
    borderWidth: 0.75, borderColor: FIELD_EDGE, backgroundColor: FIELD_BG,
    font: reg,
  })
  const dateField = form.createTextField('client_signed_date')
  dateField.setText('')
  dateField.addToPage(page, {
    x: MARGIN + halfW + 20, y: y - 3, width: halfW, height: 22,
    borderWidth: 0.75, borderColor: FIELD_EDGE, backgroundColor: FIELD_BG,
    font: reg,
  })
  y -= 34

  page.drawText(
    'Typing your name above acts as your signature on this Agreement.',
    { x: MARGIN, y, size: 8.5, font: italic, color: MUTED },
  )
  return page
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

// How much blank space the contract render must leave at the foot of its last page for the
// signature block. Passed through to the pdfmake render as a trailing spacer, so if the contract
// text would run into it, pdfmake pushes the spacer (and therefore the clear space) onto a new page.
export const FOOT_RESERVE = 150

// Build the whole fillable document. `renderContract` is injected so this module doesn't need to
// know about pdfmake; crm-contracts.mjs passes in its own renderer.
export async function assembleFillablePdf({ project, contractPdfBuffer }) {
  const doc = await PDFDocument.load(contractPdfBuffer)
  const fonts = {
    reg: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
  }
  const form = doc.getForm()
  const facts = missingClientFacts(project)

  // Signature block FIRST (it targets the last page of the contract, before we prepend page 1).
  drawSignatureBlock(doc, form, project, fonts)
  drawFormPage(doc, form, project, facts, fonts)

  // Render the field appearances so the boxes are visible in every viewer, not just Acrobat.
  form.updateFieldAppearances(fonts.reg)

  const bytes = await doc.save({ updateFieldAppearances: false })
  return { buffer: Buffer.from(bytes), pageCount: doc.getPageCount(), askedFor: facts.map((f) => f.ask) }
}

// Convenience: the questions this project would ask, for the UI to preview.
export function fillableSummary(projectId, findProject) {
  const project = findProject(projectId)
  const facts = missingClientFacts(project)
  const built = buildContractBody(project)
  return {
    questions: facts.map((f) => f.ask),
    missingContractFields: built.missingFields,
    client: project.client,
    eventDate: project.eventDate ? fmtDate(project.eventDate) : '',
  }
}
