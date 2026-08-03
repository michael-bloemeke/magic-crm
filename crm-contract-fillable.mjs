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

// Draw a small label with a form box under it, and return the new y cursor.
// Centralised because getting this wrong overlaps the box on top of its own label: pdf-lib places a
// field by its BOTTOM-left corner, so the box top is (y + height) and must clear the label baseline.
const LABEL_GAP = 7 // clearance between the label baseline and the top of its box
function labelledField(page, form, fonts, opts) {
  const { name, label, x, w, h = 20, y, value = '', multiline = false, labelSize = 9.5, labelFont = 'bold' } = opts
  page.drawText(label, { x, y, size: labelSize, font: fonts[labelFont], color: labelFont === 'bold' ? INK : MUTED })
  const boxTop = y - LABEL_GAP
  const boxBottom = boxTop - h
  const field = form.createTextField(name)
  field.setText(value)
  if (multiline) field.enableMultiline()
  field.addToPage(page, {
    x, y: boxBottom, width: w, height: h,
    borderWidth: 0.75, borderColor: FIELD_EDGE, backgroundColor: FIELD_BG,
    font: fonts.reg,
  })
  return boxBottom
}

// Page 1 of the booking agreement: a READ-ONLY summary of what the client submitted on the booking
// form. Deliberately NOT input fields. They already answered these; this page exists so the facts
// they gave are stated on the document they are signing, and so the agreement itself can just say
// "the details on the previous page are accurate" instead of re-listing everything.
function drawSummaryPage(doc, project, rows, fonts) {
  const { bold, reg, italic } = fonts
  const contentW = PAGE_W - MARGIN * 2
  const FOOT = MARGIN + 26

  let idx = 0
  let page = doc.insertPage(idx, [PAGE_W, PAGE_H])
  let y = PAGE_H - MARGIN
  const ensure = (h) => {
    if (y - h >= FOOT) return
    idx += 1
    page = doc.insertPage(idx, [PAGE_W, PAGE_H])
    y = PAGE_H - MARGIN
  }

  page.drawText('YOUR EVENT DETAILS', { x: MARGIN, y, size: 15, font: bold, color: INK })
  y -= 20
  page.drawText(`Prepared for ${project.client}`, { x: MARGIN, y, size: 10.5, font: reg, color: MUTED })
  y -= 16
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 0.75, color: RULE })
  y -= 22

  for (const line of wrap(
    'These are the details you gave me. Please check them over. They form part of the agreement on the following pages, so if anything here is wrong, tell me before you sign.',
    reg, 10, contentW,
  )) {
    page.drawText(line, { x: MARGIN, y, size: 10, font: reg, color: INK })
    y -= 13
  }
  y -= 12

  // Label above, value below, so long answers (an address, a note) can wrap freely.
  const labelW = contentW
  for (const row of rows) {
    const valueLines = wrap(row.value, reg, 10.5, labelW)
    ensure(16 + valueLines.length * 13 + 10)
    page.drawText(row.label, { x: MARGIN, y, size: 8.5, font: bold, color: MUTED })
    y -= 14
    for (const line of valueLines) {
      page.drawText(line, { x: MARGIN, y, size: 10.5, font: reg, color: INK })
      y -= 13
    }
    y -= 8
  }

  if (!rows.length) {
    page.drawText('No booking form has been submitted for this project yet.', {
      x: MARGIN, y, size: 10, font: italic, color: MUTED,
    })
  }

  page.drawText('The agreement follows on the next page.', {
    x: MARGIN, y: MARGIN - 18, size: 9, font: italic, color: MUTED,
  })
  return idx + 1
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

  // Typed name + date, side by side. Same label/box helper as page 1 so the spacing matches.
  const halfW = (contentW - 20) / 2
  const afterName = labelledField(page, form, fonts, {
    name: 'client_typed_name', label: 'Type your full name to sign', x: MARGIN, w: halfW, h: 22, y,
    labelSize: 8.5, labelFont: 'reg',
  })
  labelledField(page, form, fonts, {
    name: 'client_signed_date', label: 'Date', x: MARGIN + halfW + 20, w: halfW, h: 22, y,
    labelSize: 8.5, labelFont: 'reg',
  })
  y = afterName - 16

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
export async function assembleFillablePdf({ project, contractPdfBuffer, summaryRows = [] }) {
  const doc = await PDFDocument.load(contractPdfBuffer)
  const fonts = {
    reg: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
  }
  const form = doc.getForm()

  // Signature block FIRST: it targets the LAST page of the contract, and prepending the summary
  // pages afterwards would shift the indices out from under it.
  drawSignatureBlock(doc, form, project, fonts)
  drawSummaryPage(doc, project, summaryRows, fonts)

  // Render the field appearances so the boxes are visible in every viewer, not just Acrobat.
  form.updateFieldAppearances(fonts.reg)

  const bytes = await doc.save({ updateFieldAppearances: false })
  return { buffer: Buffer.from(bytes), pageCount: doc.getPageCount() }
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
