// Performance Services Agreement template. The contract is HTML where every auto-filled
// spot is a FIELD SPAN: <span class="cf" data-f="KEY">Label</span>. The editor highlights
// these (filled = subtle, unfilled = warning) and blocks sending until the unfilled ones
// are filled; the PDF ignores the class so it renders clean. The DEFAULT template is built
// from SECTIONS here, but Michael can edit and save his own in Settings (stored in
// crm-config.json -> contractTemplate); buildContractBody (in crm-contracts.mjs) fills the
// spans from a project. Liability + Governing Law omitted. House rule: no em-dashes.

export const BRAND = 'The Award-Winning Magic of Michael Bloemeke'
export const TITLE = 'PERFORMANCE SERVICES AGREEMENT'
export const SIGNATURE_LINES = [
  'Client signature: ______________________________     Date: ____________',
  'Performer signature: ___________________________     Date: ____________',
]
const PERFORMER_LINE = 'Performer: Michael Bloemeke, michael@michaelbloemeke.com, (919) 239-9898'

// Field registry: key -> { label, get(project, todayISO) }. The single source of truth for
// what can be auto-filled and how it reads from a project. Used to fill spans and to build
// the editor's "Insert field" menu.
export const FIELD_DEFS = [
  { key: 'contract_date', label: 'Date', get: (_p, today) => fmtDate(today) },
  { key: 'client_name', label: 'Client name', get: (p) => s(p.client) },
  { key: 'client_email', label: 'Client email', get: (p) => firstEmail(p.contactEmails) },
  { key: 'client_phone', label: 'Client phone', get: (p) => s(p.contactPhones) },
  { key: 'event_date', label: 'Event date', get: (p) => fmtDate(p.eventDate) },
  { key: 'event_location', label: 'Event location', get: (p) => s(p.eventLocation) },
  { key: 'venue_type', label: 'Venue type', get: (p) => s(p.venueType) },
  { key: 'indoors_or_outdoors', label: 'Indoor / outdoor', get: (p) => s(p.indoorsOrOutdoors) },
  { key: 'event_start_time', label: 'Event start time', get: (p) => s(p.eventStartTime) },
  { key: 'show_start_time', label: 'Show start time', get: (p) => s(p.showStartTime) },
  { key: 'services_description', label: 'Performance scope', get: (p) => s(p.performanceStyle) },
  { key: 'booking_fee', label: 'Booking fee', get: (p) => money(p.totalFee) },
]
const FIELD_LABEL = Object.fromEntries(FIELD_DEFS.map((d) => [d.key, d.label]))

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
export function fmtDate(ymd) {
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
function fieldSpan(key) {
  return `<span class="cf" data-f="${key}">${escapeHtml(FIELD_LABEL[key] || key)}</span>`
}
// Convert a body line (with {{token}} markers) to HTML, escaping text and injecting spans.
function lineToHtml(line) {
  let out = ''
  let last = 0
  const re = /\{\{(\w+)\}\}/g
  let m
  while ((m = re.exec(line))) {
    out += escapeHtml(line.slice(last, m.index))
    out += fieldSpan(m[1])
    last = m.index + m[0].length
  }
  return out + escapeHtml(line.slice(last))
}
function bodyToHtml(text) {
  const lines = text.split('\n')
  const out = []
  let bullets = []
  const flush = () => {
    if (bullets.length) {
      out.push(`<ul>${bullets.map((b) => `<li>${lineToHtml(b)}</li>`).join('')}</ul>`)
      bullets = []
    }
  }
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (/^•\s/.test(line)) bullets.push(line.replace(/^•\s+/, ''))
    else {
      flush()
      out.push(`<p>${lineToHtml(line)}</p>`)
    }
  }
  flush()
  return out.join('')
}
function sectionHtml(sec) {
  const heading = `<p data-section data-key="${sec.key}" style="font-weight:bold">${escapeHtml(sec.title)}</p>`
  return heading + bodyToHtml(sec.body)
}

// The built-in default template HTML (used when Michael hasn't saved a custom one). Field
// spans show labels; the Media section is an inline removable block. Headings have NO
// numbers; numbering is applied at build/generate time.
// --- Booking-form variant (added 2026-08-02) --------------------------------
// The agreement that goes out AFTER the client fills in the booking form. Its page 1 is a read-only
// summary of everything they just told us, so the agreement itself does not re-list all of it.
//
// It DOES restate the handful of facts the agreement actually operates on, because a contract has to
// stand up on its own: someone reading only the agreement pages should be able to see what was
// booked. So the Event section carries the date, place and times; the Services clause carries the
// performance scope; and Compensation carries the fee. Everything else (guest count, ages, VIPs, A/V,
// venue notes) stays on the summary page and is bound in by the accuracy line below.
//
// The Booking Fee is Michael's number and is never asked on the form, so it only exists here.
const BOOKING_EVENT_SECTION = {
  key: 'event',
  title: 'Event',
  body: `This Agreement covers the following event:
• Date: {{event_date}}
• Location: {{event_location}}
• Event start time: {{event_start_time}}
• Performance start time: {{show_start_time}}
The remaining event details set out on the previous page are accurate and form part of this Agreement.`,
}

// The agreement VARIANTS Michael can choose between when he sends a booking form.
//
// The reason this exists is a real conversation that happens: he sends the agreement, and the client
// comes back with "wait, we don't want you filming this". Rather than editing a contract by hand, he
// picks the other version and resends. The variant that went out is recorded on the project, so the
// card can say which one the client actually signed.
//
// Adding another is a matter of a new entry here plus whatever it changes about the section list.
// `omit` is the set of section keys left out of that variant.
export const CONTRACT_VARIANTS = [
  {
    id: 'standard',
    label: 'Standard',
    hint: 'Includes the media clause (photos and video for promotion)',
    omit: [],
  },
  {
    id: 'no-media',
    label: 'No media clause',
    hint: 'For clients who do not want the event photographed or filmed',
    omit: ['media'],
  },
]

export function bookingTemplateHtml({ variant = 'standard' } = {}) {
  const def = CONTRACT_VARIANTS.find((v) => v.id === variant) || CONTRACT_VARIANTS[0]
  const omit = new Set(def.omit)
  const parts = [`<p>This Performance Services Agreement (the "Agreement") is entered into as of ${fieldSpan('contract_date')} by and between:</p>`]
  parts.push(`<p>${escapeHtml(PERFORMER_LINE)}</p>`)
  parts.push(`<p>Client: ${fieldSpan('client_name')}, ${fieldSpan('client_email')}</p>`)
  for (const sec of SECTIONS) {
    if (omit.has(sec.key)) continue
    parts.push(sectionHtml(sec.key === 'event' ? BOOKING_EVENT_SECTION : sec))
  }
  parts.push(`<p>${escapeHtml(CLOSING)}</p>`)
  return parts.join('\n')
}

export function defaultTemplateHtml() {
  const parts = []
  parts.push(`<p>This Performance Services Agreement (the "Agreement") is entered into as of ${fieldSpan('contract_date')} by and between:</p>`)
  parts.push(`<p>${escapeHtml(PERFORMER_LINE)}</p>`)
  parts.push(`<p>Client: ${fieldSpan('client_name')}, ${fieldSpan('client_email')}, ${fieldSpan('client_phone')}</p>`)
  for (const sec of SECTIONS) {
    if (sec.optional && sec.key === 'media') parts.push(`<div data-clause="media">${sectionHtml(sec)}</div>`)
    else parts.push(sectionHtml(sec))
  }
  parts.push(`<p>${escapeHtml(CLOSING)}</p>`)
  return parts.join('\n')
}
