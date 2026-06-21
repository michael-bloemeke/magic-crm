// Performance Services Agreement template (the CRM contract generator's source).
// Emits the EDITABLE BODY as semantic HTML (headings, real <ul> bullets, paragraphs) so
// the rich-text editor and the pdfmake PDF render it consistently. The fixed chrome
// (letterhead, title + rule, signature block) is added around this body by both the editor
// and the PDF renderer, so it's always present and not accidentally editable. Liability and
// Governing Law sections are intentionally omitted. House rule: no em-dashes.

export const BRAND = 'The Award-Winning Magic of Michael Bloemeke'
export const TITLE = 'PERFORMANCE SERVICES AGREEMENT'
export const SIGNATURE_LINES = [
  'Client signature: ______________________________     Date: ____________',
  'Performer signature: ___________________________     Date: ____________',
]
const PERFORMER_LINE = 'Performer: Michael Bloemeke, michael@michaelbloemeke.com, (919) 239-9898'

// Numbered sections, in order. `optional: true` ones are included only when toggled on
// (today: just "Media"). {{tokens}} fill from the project. Bodies use "• " for bullet
// lines (converted to <ul><li> in HTML).
const SECTIONS = [
  {
    key: 'event',
    title: 'Event',
    body: `This Agreement covers the following event:
• Date: {{event_date}}
• Location: {{event_location}} ({{venue_type}}; {{indoors_or_outdoors}})
• Event start time: {{event_start_time}}
• Performance start time: {{show_start_time}}`,
  },
  {
    key: 'services',
    title: 'Services',
    body: `The Performer will provide the following performance: {{services_description}}. This agreed performance is the full scope of the Performer's obligation under this Agreement. Any performance beyond the agreed scope is at the Performer's sole discretion and is not guaranteed.`,
  },
  {
    key: 'compensation',
    title: 'Compensation',
    body: `• Booking Fee: {{booking_fee}}, due in full upon signing.
• The event date is reserved only once the Booking Fee has been received in full.`,
  },
  {
    key: 'cancellation',
    title: 'Cancellation',
    body: `• By the Client: All payments are non-refundable, including if the event itself is cancelled, postponed, or does not proceed for any reason. The Client acknowledges that the Performer reserves the event date upon booking and may decline other engagements for that date. At the Performer's sole discretion, a reschedule, partial credit, or refund may be offered depending on timing, circumstances, and availability, but none is guaranteed.
• By the Performer: If the Performer is unable to fulfill the engagement due to illness, injury, or unforeseen circumstances, the Performer will refund the Booking Fee in full or, with the Client's approval, arrange a qualified replacement performer.`,
  },
  {
    key: 'forceMajeure',
    title: 'Force Majeure',
    body: `The Performer shall not be liable for any losses, damages, or failure to perform caused by circumstances beyond their reasonable control, including severe weather, venue closure, public emergency, acts of God, or other force majeure events. Cancellation of the event for any reason, including force majeure, is governed by the Cancellation terms above; any reschedule, credit, or refund in such cases is at the Performer's sole discretion.`,
  },
  {
    key: 'performanceConditions',
    title: 'Performance Conditions',
    body: `• The Client will provide a safe and suitable environment for the performance, including adequate lighting, reasonable audience access, and any audio/visual equipment agreed upon for a stage show.
• For performances exceeding 3 hours, the Performer may take brief breaks.
• The Performer may pause or end the performance if the environment becomes unsafe; doing so does not affect the Booking Fee.`,
  },
  {
    key: 'media',
    title: 'Media',
    optional: true,
    body: `The Performer may photograph and/or video record portions of the event, and the Client grants the Performer permission to use those photos and recordings for the Performer's promotional and marketing purposes.`,
  },
  {
    key: 'independentContractor',
    title: 'Independent Contractor',
    body: `The Performer is an independent contractor and not an employee, agent, or partner of the Client.`,
  },
  {
    key: 'entireAgreement',
    title: 'Entire Agreement and Amendments',
    body: `This Agreement is the entire agreement between the parties regarding the performance and supersedes any prior discussions or understandings. Any changes must be made in writing and signed by both parties.`,
  },
  {
    key: 'acceptance',
    title: 'Acceptance',
    body: `By signing below, both the Client and the Performer acknowledge their understanding and acceptance of these terms.`,
  },
]

const CLOSING = `Instructions for the Client: Please review this Agreement carefully and sign where indicated. Your booking is confirmed once the Agreement is signed and the Booking Fee is received. If you have any questions, contact Michael Bloemeke at michael@michaelbloemeke.com or 919-239-9898.`

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

function s(v) {
  return v == null ? '' : String(v).trim()
}
function fmtDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s(ymd))
  if (!m) return s(ymd)
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (Number.isNaN(d.getTime())) return s(ymd)
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`
}
function money(n) {
  const v = Number(n)
  if (!v || Number.isNaN(v)) return ''
  return '$' + Math.round(v).toLocaleString('en-US')
}
function firstEmail(str) {
  return s(str).split(/[,;]/)[0].trim()
}
function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Resolve {{tokens}} for a project. Missing values become an obvious [placeholder] and are
// reported in missingFields. Also returns a labeled `fields` list for the Insert-field menu.
function resolveTokens(project, todayISO) {
  const missing = []
  const need = (val, placeholder) => {
    const t = s(val)
    if (t) return t
    missing.push(placeholder)
    return `[${placeholder}]`
  }
  const eventDate = fmtDate(project.eventDate)
  if (!eventDate) missing.push('event date')
  const fee = money(project.totalFee)
  if (!fee) missing.push('booking fee')
  const tokens = {
    contract_date: fmtDate(todayISO) || s(todayISO),
    client_name: need(project.client, 'client name'),
    client_email: need(firstEmail(project.contactEmails), 'client email'),
    client_phone: need(project.contactPhones, 'client phone'),
    event_date: eventDate || '[event date]',
    event_location: need(project.eventLocation, 'event location'),
    venue_type: need(project.venueType, 'venue type'),
    indoors_or_outdoors: need(project.indoorsOrOutdoors, 'indoor or outdoor'),
    event_start_time: need(project.eventStartTime, 'event start time'),
    show_start_time: need(project.showStartTime, 'show start time'),
    services_description: need(project.performanceStyle, 'performance scope, e.g. 1 hour of strolling close-up magic'),
    booking_fee: fee || '[booking fee]',
  }
  // Insert-field menu: label -> the value to drop in at the cursor.
  const fields = [
    { label: 'Client name', value: tokens.client_name },
    { label: 'Client email', value: tokens.client_email },
    { label: 'Client phone', value: tokens.client_phone },
    { label: 'Event date', value: tokens.event_date },
    { label: 'Event location', value: tokens.event_location },
    { label: 'Venue type', value: tokens.venue_type },
    { label: 'Indoor / outdoor', value: tokens.indoors_or_outdoors },
    { label: 'Event start time', value: tokens.event_start_time },
    { label: 'Show start time', value: tokens.show_start_time },
    { label: 'Performance scope', value: tokens.services_description },
    { label: 'Booking fee', value: tokens.booking_fee },
    { label: "Today's date", value: tokens.contract_date },
  ]
  return { tokens, fields, missing }
}

function fill(text, tokens) {
  return text.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in tokens ? tokens[k] : `{{${k}}}`))
}

// One section body (already token-filled text) -> HTML. Runs of "• " lines become a single
// <ul>; other lines become <p>.
function bodyTextToHtml(text) {
  const lines = text.split('\n')
  const out = []
  let bullets = []
  const flush = () => {
    if (bullets.length) {
      out.push(`<ul>${bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>`)
      bullets = []
    }
  }
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (/^•\s/.test(line)) {
      bullets.push(line.replace(/^•\s+/, ''))
    } else {
      flush()
      out.push(`<p>${escapeHtml(line)}</p>`)
    }
  }
  flush()
  return out.join('')
}

// Build the EDITABLE BODY HTML for a project (preamble + numbered sections + closing).
// The letterhead, title, and signature block are chrome added by the editor and PDF.
// The optional Media section is returned SEPARATELY as `mediaHtml` (a removable block) so
// the editor can toggle it in/out in place without rebuilding the body or losing edits.
// Section headings carry data-section/data-key so the editor can renumber them.
export function buildContractBody(project, { todayISO } = {}) {
  const { tokens, fields, missing } = resolveTokens(project, todayISO)
  const parts = []
  parts.push(`<p>This Performance Services Agreement (the "Agreement") is entered into as of ${escapeHtml(tokens.contract_date)} by and between:</p>`)
  parts.push(`<p>${escapeHtml(PERFORMER_LINE)}</p>`)
  parts.push(`<p>Client: ${escapeHtml(tokens.client_name)}, ${escapeHtml(tokens.client_email)}, ${escapeHtml(tokens.client_phone)}</p>`)
  const sections = SECTIONS.filter((sec) => !sec.optional) // Media handled separately
  sections.forEach((sec, i) => {
    parts.push(`<p data-section data-key="${sec.key}" style="font-weight:bold">${i + 1}. ${escapeHtml(sec.title)}</p>`)
    parts.push(bodyTextToHtml(fill(sec.body, tokens)))
  })
  parts.push(`<p>${escapeHtml(CLOSING)}</p>`)
  const mediaSec = SECTIONS.find((s) => s.key === 'media')
  const mediaHtml = `<div data-clause="media"><p data-section data-key="media" style="font-weight:bold">Media</p>${bodyTextToHtml(fill(mediaSec.body, tokens))}</div>`
  return { html: parts.join('\n'), mediaHtml, fields, missingFields: missing }
}
