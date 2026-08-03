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

import zlib from 'node:zlib'
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

// Does the contract's LAST page carry any actual text?
//
// It often doesn't. The foot-of-page reserve flows like any other block, so on a contract that
// already fills its final page the reserve is pushed onto a fresh one, and that page arrives holding
// nothing but the invisible spacer rectangle. Drawing the signature at the foot of a page like that
// leaves the client looking at a sheet that is blank down to its last two inches.
//
// So we ask. pdfmake writes each page under a `1 0 0 -1 0 792 cm` flip, and its streams come out in
// page order, so the last flipped stream is the last contract page. If it shows no text-drawing
// operator, the page is the spacer's own and the signature goes at the TOP of it instead.
function lastContractPageHasText(buffer) {
  const s = buffer.toString('latin1')
  const re = /(?<!end)stream\r?\n/g
  let m
  let lastPage = null
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length
    const end = s.indexOf('endstream', start)
    if (end < 0) continue
    let text
    try {
      text = zlib.inflateSync(Buffer.from(s.slice(start, end), 'latin1')).toString('latin1')
    } catch {
      continue // a font or image stream, not page content
    }
    if (text.includes('1 0 0 -1 0 792 cm')) lastPage = text
  }
  // Unreadable for any reason: assume there IS text, which keeps the old foot placement. That is the
  // safe direction to be wrong in, because the reserve guarantees the foot is clear either way.
  if (lastPage == null) return true
  return /\bTj\b|\bTJ\b/.test(lastPage)
}

// ---------------------------------------------------------------------------
// Last page: typed name in place of a signature
// ---------------------------------------------------------------------------

// Written-out timestamp for the audit line, in Michael's timezone. House rule is 12-hour times and
// dates spelled out, and this is a line a client (or one day a lawyer) reads.
function stampET(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  }) + ' ET'
}

// The foot of the last page.
//
// TWO MODES, and which one you get says what the document IS:
//
//   signature == null  ->  blank AcroForm fields. The old route: Michael emails this and the client
//                          types into the PDF itself. Still supported, still works.
//   signature != null  ->  the name is DRAWN, not a field, alongside when it was signed and from
//                          where. The client already signed on michaelbloemeke.com and the database
//                          row is the actual record; this PDF is the receipt of that. Drawing it as
//                          text (rather than a pre-filled field) matters, because a form field can
//                          be retyped by whoever opens it, and a receipt that can be edited is not
//                          a receipt.
function drawSignatureBlock(doc, form, project, fonts, signature, onOwnPage = false) {
  const pages = doc.getPages()
  const page = pages[pages.length - 1]
  const { bold, reg, italic } = fonts
  const contentW = PAGE_W - MARGIN * 2

  // The contract render reserves clear space at the foot of its final page (see FOOT_RESERVE), so
  // this block never lands on top of contract text. Where it sits depends on what else is there:
  // at the foot of the closing text, or near the top when the reserve spilled onto a page of its own.
  let y = onOwnPage ? PAGE_H - MARGIN - 52 : MARGIN + 118

  if (onOwnPage) {
    page.drawText('SIGNATURE', { x: MARGIN, y: y + 74, size: 13, font: bold, color: INK })
    for (const [i, line] of wrap(
      'This page belongs with the Agreement on the preceding pages.',
      reg, 9.5, contentW,
    ).entries()) {
      page.drawText(line, { x: MARGIN, y: y + 56 - i * 12, size: 9.5, font: reg, color: MUTED })
    }
  }

  page.drawLine({ start: { x: MARGIN, y: y + 16 }, end: { x: PAGE_W - MARGIN, y: y + 16 }, thickness: 0.75, color: RULE })

  const approveText = 'I have read this Agreement and I approve it.'
  const halfW = (contentW - 20) / 2

  if (signature) {
    // Ticked box, drawn rather than a real checkbox for the same reason as the name.
    page.drawRectangle({
      x: MARGIN, y: y - 12, width: 13, height: 13,
      borderWidth: 1, borderColor: FIELD_EDGE, color: FIELD_BG,
    })
    page.drawLine({ start: { x: MARGIN + 2.5, y: y - 5.5 }, end: { x: MARGIN + 5.5, y: y - 9 }, thickness: 1.4, color: INK })
    page.drawLine({ start: { x: MARGIN + 5.5, y: y - 9 }, end: { x: MARGIN + 10.5, y: y - 1 }, thickness: 1.4, color: INK })
    page.drawText(approveText, { x: MARGIN + 20, y: y - 9, size: 10, font: bold, color: INK })
    y -= 44

    // Name and date sitting on ruled lines, the way a signed page reads.
    const name = String(signature.name || '').trim()
    const date = String(signature.date || '').trim()
    page.drawText(name, { x: MARGIN, y, size: 15, font: italic, color: INK })
    page.drawText(date, { x: MARGIN + halfW + 20, y, size: 11, font: reg, color: INK })
    y -= 6
    page.drawLine({ start: { x: MARGIN, y }, end: { x: MARGIN + halfW, y }, thickness: 0.75, color: RULE })
    page.drawLine({ start: { x: MARGIN + halfW + 20, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 0.75, color: RULE })
    y -= 12
    page.drawText('Signed by (typed name)', { x: MARGIN, y, size: 8, font: reg, color: MUTED })
    page.drawText('Date', { x: MARGIN + halfW + 20, y, size: 8, font: reg, color: MUTED })
    y -= 16

    // The audit trail. This is what makes a typed name defensible: not the picture of a signature,
    // but a contemporaneous record of who submitted what, when, and from where.
    const stamp = stampET(signature.signedAt)
    const lines = [
      `Signed electronically on michaelbloemeke.com${stamp ? ` on ${stamp}` : ''}.`,
      signature.ip ? `Confirmed from IP address ${signature.ip}.` : '',
      'Typing a name in place of a signature was accepted by both parties as binding.',
    ].filter(Boolean)
    for (const line of lines) {
      page.drawText(line, { x: MARGIN, y, size: 8, font: italic, color: MUTED })
      y -= 10
    }
    return page
  }

  // Unsigned: real form fields for the fillable-PDF route.
  const cb = form.createCheckBox('client_approves')
  cb.addToPage(page, {
    x: MARGIN, y: y - 12, width: 13, height: 13,
    borderWidth: 1, borderColor: FIELD_EDGE, backgroundColor: FIELD_BG,
  })
  page.drawText(approveText, { x: MARGIN + 20, y: y - 9, size: 10, font: bold, color: INK })
  y -= 40

  // Typed name + date, side by side. Same label/box helper as page 1 so the spacing matches.
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
//
// The number is derived, not guessed. drawSignatureBlock starts at y = MARGIN + 118 = 184 and draws
// its top rule at y + 16 = 200, so 200pt from the page bottom is the highest ink it puts down.
// pdfmake's own content stops at its bottom page margin, 56. So the band that must be kept clear is
// 200 - 56 = 144pt, and this carries a deliberate ~24pt of slack on top of that.
//
// If you move anything in drawSignatureBlock, re-derive this. The signed variant draws MORE than the
// unsigned one (an audit trail under the name), but it grows DOWNWARD from the same top rule, so the
// figure above is what governs both.
export const FOOT_RESERVE = 168

// Build the whole fillable document. `renderContract` is injected so this module doesn't need to
// know about pdfmake; crm-contracts.mjs passes in its own renderer.
// `signature` (optional) = { name, date, signedAt, ip, agent } as captured by the website's signing
// step. Passing it produces the SIGNED receipt (name drawn as text, audit line, no editable fields);
// omitting it produces the blank fillable PDF.
export async function assembleFillablePdf({ project, contractPdfBuffer, summaryRows = [], signature = null }) {
  const doc = await PDFDocument.load(contractPdfBuffer)
  const fonts = {
    reg: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
  }
  const form = doc.getForm()

  // Signature block FIRST: it targets the LAST page of the contract, and prepending the summary
  // pages afterwards would shift the indices out from under it. Ask the ORIGINAL contract buffer
  // whether that page carries text, before the summary pages join the document and change what
  // "last page" would mean.
  drawSignatureBlock(doc, form, project, fonts, signature, !lastContractPageHasText(contractPdfBuffer))
  drawSummaryPage(doc, project, summaryRows, fonts)

  // Render the field appearances so the boxes are visible in every viewer, not just Acrobat.
  form.updateFieldAppearances(fonts.reg)

  // A signed copy must not be editable. `flatten` bakes anything remaining into page content and
  // drops the AcroForm, so no viewer offers a cursor on this document.
  if (signature) {
    try {
      form.flatten()
    } catch {
      /* nothing to flatten (no fields were created in signed mode); that is the expected case */
    }
  }

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
