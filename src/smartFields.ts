import { type Project } from './pipeline'

// Smart fields ("merge fields"): named project data points that can be dropped into a template
// or a project email as a placeholder. In a project context a placeholder autofills to the
// project's value; if the value isn't set, it stays a visible placeholder so it's obvious it
// needs attention. The placeholder is stored in the HTML body as an atomic chip:
//
//   <span class="merge-field" data-field="KEY" contenteditable="false">[Label]</span>
//
// RichTextEditor inserts these chips; the helpers here resolve / detect / strip them. The chip's
// class + data-field attribute are the contract between the editor and these helpers.

export type SmartField = { key: string; label: string }

// The fields offered in the "Insert field" dropdown, in display order.
export const SMART_FIELDS: SmartField[] = [
  { key: 'clientName', label: 'Client name' },
  { key: 'firstName', label: 'Client first name' },
  { key: 'eventType', label: 'Event type' },
  { key: 'eventDate', label: 'Event date' },
  { key: 'eventLocation', label: 'Venue / location' },
  { key: 'venueType', label: 'Venue type' },
  { key: 'eventStartTime', label: 'Event start time' },
  { key: 'showStartTime', label: 'Show start time' },
  { key: 'numberOfGuests', label: 'Guest count' },
  { key: 'ageOfGuests', label: 'Age of guests' },
  { key: 'performanceStyle', label: 'Performance' },
  { key: 'totalFee', label: 'Booking fee' },
  { key: 'contactName', label: 'On-site contact name' },
  { key: 'myName', label: 'My name' },
]

export function smartFieldLabel(key: string): string {
  return SMART_FIELDS.find((f) => f.key === key)?.label || key
}

// Escape plain text and turn newlines into <br>, so a legacy plain-text draft or template
// renders correctly in the rich HTML editor.
export function textToHtml(text: string): string {
  const esc = String(text || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string)
  return esc.replace(/\n/g, '<br>')
}

function fmtEventDate(iso: string): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return ''
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

// The value for a field on a project, or '' if it isn't set. `myName` is always available.
// `custom` maps user-defined custom field ids (e.g. "custom_ab12cd3") to their value for this
// project; those ids never match a built-in case, so checking it first is safe.
export function resolveSmartField(key: string, project: Project, custom?: Record<string, string>): string {
  if (custom && key in custom) return (custom[key] || '').trim()
  switch (key) {
    case 'clientName':
      return (project.client || '').trim()
    case 'firstName':
      return (project.client || '').trim().split(/\s+/)[0] || ''
    case 'eventType':
      return (project.eventType || '').trim()
    case 'eventDate':
      return fmtEventDate(project.eventDate)
    case 'eventLocation':
      return (project.eventLocation || '').trim()
    case 'venueType':
      return (project.venueType || '').trim()
    case 'eventStartTime':
      return (project.eventStartTime || '').trim()
    case 'showStartTime':
      return (project.showStartTime || '').trim()
    case 'numberOfGuests':
      return (project.numberOfGuests || '').trim()
    case 'ageOfGuests':
      return (project.ageOfGuests || '').trim()
    case 'performanceStyle':
      return (project.performanceStyle || '').trim()
    case 'totalFee':
      return project.totalFee != null ? '$' + Math.round(Number(project.totalFee)).toLocaleString('en-US') : ''
    case 'contactName':
      return (project.contactNames || '').split(/[,;]/)[0].trim()
    case 'myName':
      return 'Michael Bloemeke'
    default:
      return ''
  }
}

function parseBody(html: string): Document {
  return new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html')
}

// Fill every placeholder whose project value IS set (replace the chip with the value text);
// leave the rest as chips. `custom` carries this project's custom-field values. Returns the new HTML.
export function resolveMergeFields(html: string, project: Project, custom?: Record<string, string>): string {
  if (!html || html.indexOf('merge-field') === -1) return html
  const doc = parseBody(html)
  doc.querySelectorAll('span.merge-field[data-field]').forEach((el) => {
    const val = resolveSmartField(el.getAttribute('data-field') || '', project, custom)
    if (val && val.trim()) el.replaceWith(doc.createTextNode(val))
  })
  return doc.body.innerHTML
}

// Labels of ALL placeholders still unfilled in the HTML (deduped) — for the pre-send warning.
// Covers both kinds: a data field whose project value is unset, and a write-in note. The label
// is the chip's own bracketed text (so notes read as their instruction).
export function unfilledFields(html: string): string[] {
  if (!html || html.indexOf('merge-field') === -1) return []
  const doc = parseBody(html)
  const labels: string[] = []
  doc.querySelectorAll('span.merge-field').forEach((el) => {
    labels.push((el.textContent || '').replace(/^\s*\[|\]\s*$/g, '').trim())
  })
  return [...new Set(labels.filter(Boolean))]
}

// For sending: drop ALL chip markup (data + note), leaving the bracketed label as plain text, so
// no styled placeholder span ever goes out. (Filled fields are already plain text by this point.)
export function stripForSend(html: string): string {
  if (!html || html.indexOf('merge-field') === -1) return html
  const doc = parseBody(html)
  doc.querySelectorAll('span.merge-field').forEach((el) => {
    el.replaceWith(doc.createTextNode(el.textContent || ''))
  })
  return doc.body.innerHTML
}
