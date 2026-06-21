// Performance Services Agreement template (the CRM contract generator's source text).
// Structured as ordered sections so they can be toggled/renumbered and, later, edited
// from a Settings page. The Liability section is intentionally OMITTED for now (Michael
// will supply updated wording). Output is plain text: a title line, numbered section
// headings ("1. Event"), and bullet lines, which crm-contracts.mjs styles into a PDF.
// House rule: no em-dashes anywhere in generated output.

const PERFORMER_LINE = 'Performer: Michael Bloemeke, michael@michaelbloemeke.com, (919) 239-9898'

// Numbered sections, in order. `optional: true` ones are included only when toggled on
// at generate time (today: just "Media", the videographer/likeness clause). {{tokens}}
// are filled from the project record. Sections are numbered sequentially AFTER filtering,
// so toggling a section off never leaves a gap.
const SECTIONS = [
  {
    key: 'event',
    title: 'Event',
    body: `This Agreement covers the following event:
- Date: {{event_date}}
- Location: {{event_location}} ({{venue_type}}; {{indoors_or_outdoors}})
- Event start time: {{event_start_time}}
- Performance start time: {{show_start_time}}`,
  },
  {
    key: 'services',
    title: 'Services',
    body: `The Performer will provide the following performance: {{services_description}}. This agreed performance is the full scope of the Performer's obligation under this Agreement. Any performance beyond the agreed scope is at the Performer's sole discretion and is not guaranteed.`,
  },
  {
    key: 'compensation',
    title: 'Compensation',
    body: `- Booking Fee: {{booking_fee}}, due in full upon signing.
- The event date is reserved only once the Booking Fee has been received in full.`,
  },
  {
    key: 'cancellation',
    title: 'Cancellation',
    body: `- By the Client: All payments are non-refundable, including if the event itself is cancelled, postponed, or does not proceed for any reason. The Client acknowledges that the Performer reserves the event date upon booking and may decline other engagements for that date. At the Performer's sole discretion, a reschedule, partial credit, or refund may be offered depending on timing, circumstances, and availability, but none is guaranteed.
- By the Performer: If the Performer is unable to fulfill the engagement due to illness, injury, or unforeseen circumstances, the Performer will refund the Booking Fee in full or, with the Client's approval, arrange a qualified replacement performer.`,
  },
  {
    key: 'forceMajeure',
    title: 'Force Majeure',
    body: `The Performer shall not be liable for any losses, damages, or failure to perform caused by circumstances beyond their reasonable control, including severe weather, venue closure, public emergency, acts of God, or other force majeure events. Cancellation of the event for any reason, including force majeure, is governed by the Cancellation terms above; any reschedule, credit, or refund in such cases is at the Performer's sole discretion.`,
  },
  {
    key: 'performanceConditions',
    title: 'Performance Conditions',
    body: `- The Client will provide a safe and suitable environment for the performance, including adequate lighting, reasonable audience access, and any audio/visual equipment agreed upon for a stage show.
- For performances exceeding 3 hours, the Performer may take brief breaks.
- The Performer may pause or end the performance if the environment becomes unsafe; doing so does not affect the Booking Fee.`,
  },
  {
    key: 'media',
    title: 'Media',
    optional: true,
    body: `The Performer may photograph and/or video record portions of the event, and the Client grants the Performer permission to use those photos and recordings for the Performer's promotional and marketing purposes.`,
  },
  // NOTE: Liability section intentionally omitted (2026-06-21) pending updated wording.
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
    key: 'governingLaw',
    title: 'Governing Law',
    body: `This Agreement is governed by the laws of the State of North Carolina.`,
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

// Resolve the {{tokens}} for a project. Missing values become an obvious [placeholder]
// so nothing goes out blank, and they're reported back as missingFields.
function resolveTokens(project, todayISO) {
  const missing = []
  const need = (val, placeholder) => {
    const t = s(val)
    if (t) return t
    missing.push(placeholder)
    return `[${placeholder}]`
  }
  const tokens = {
    contract_date: fmtDate(todayISO) || s(todayISO),
    client_name: need(project.client, 'client name'),
    client_email: need(firstEmail(project.contactEmails), 'client email'),
    client_phone: need(project.contactPhones, 'client phone'),
    event_date: fmtDate(project.eventDate) || `[${pushReturn(missing, 'event date')}]`,
    event_location: need(project.eventLocation, 'event location'),
    venue_type: need(project.venueType, 'venue type'),
    indoors_or_outdoors: need(project.indoorsOrOutdoors, 'indoor or outdoor'),
    event_start_time: need(project.eventStartTime, 'event start time'),
    show_start_time: need(project.showStartTime, 'show start time'),
    services_description: need(project.performanceStyle, 'performance scope, e.g. 1 hour of strolling close-up magic'),
    booking_fee: money(project.totalFee) || `[${pushReturn(missing, 'booking fee')}]`,
  }
  return { tokens, missing }
}
function pushReturn(arr, v) {
  arr.push(v)
  return v
}

function fill(text, tokens) {
  return text.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in tokens ? tokens[k] : `{{${k}}}`))
}

// Build the full contract text for a project. Returns { body, missingFields }.
export function buildContractText(project, { includeMedia = false, todayISO } = {}) {
  const { tokens, missing } = resolveTokens(project, todayISO)
  const lines = []
  lines.push('PERFORMANCE SERVICES AGREEMENT')
  lines.push('')
  lines.push(`This Performance Services Agreement (the "Agreement") is entered into as of ${tokens.contract_date} by and between:`)
  lines.push('')
  lines.push(PERFORMER_LINE)
  lines.push(`Client: ${tokens.client_name}, ${tokens.client_email}, ${tokens.client_phone}`)
  lines.push('')
  const sections = SECTIONS.filter((sec) => !sec.optional || (sec.key === 'media' && includeMedia))
  sections.forEach((sec, i) => {
    lines.push(`${i + 1}. ${sec.title}`)
    lines.push(fill(sec.body, tokens))
    lines.push('')
  })
  lines.push(CLOSING)
  lines.push('')
  lines.push('Client signature: ______________________________     Date: ____________')
  lines.push('')
  lines.push('Performer signature: ___________________________     Date: ____________')
  return { body: lines.join('\n'), missingFields: missing }
}
