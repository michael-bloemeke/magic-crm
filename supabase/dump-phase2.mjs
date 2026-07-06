// Parity dump for the PHASE-2 read funnels newly wired to Supabase: emails, templates,
// notifications, text markers, invoices, contracts, questionnaires (+ the global questionnaire
// template), portals, recipients, inquiries, config, and the calendar-map. Prints a single
// deterministic JSON object so the SAME read code can be compared across CRM_STORE=files and
// CRM_STORE=supabase. Modeled on supabase/dump-finance-tasks.mjs.
//
// Under supabase we prime the in-memory cache first (one await); every read funnel is synchronous and
// serves from it. Under files nothing to init.
//
// Determinism: arrays sorted by a stable key, object maps' keys sorted, and ALL object keys sorted
// recursively before stringify. Timestamps are collapsed to the JS "...Z" instant so file rows already
// in Postgres offset form (from prior nightly backups) compare equal to the DB's offset form. These
// mirror the SAME normalizations the read funnels apply, so equal CONTENT compares equal.
//
// Run with Node 22:
//   CRM_STORE=files    /path/to/node22 supabase/dump-phase2.mjs
//   CRM_STORE=supabase /path/to/node22 supabase/dump-phase2.mjs

import { CRM_STORE, initStore } from '../crm-store.mjs'
import { loadTemplates } from '../crm-data-core.mjs'
import { loadEmails } from '../crm-emails.mjs'
import { loadNotifications } from '../crm-notifications.mjs'
import { loadTextMarkers } from '../crm-text-markers.mjs'
import { loadInvoices } from '../crm-quickbooks.mjs'
import { loadContracts } from '../crm-contracts.mjs'
import { loadQuestionnaires, loadTemplate as loadQuestionnaireTemplate } from '../crm-questionnaire.mjs'
import { loadPortals } from '../crm-portal.mjs'
import { loadRecipients } from '../crm-recipients.mjs'
import { loadInquiries, listNotifications as listInquiryNotifications } from '../crm-inquiries.mjs'
import { loadConfig } from '../crm-finance.mjs'

if (CRM_STORE === 'supabase') await initStore()

// Collapse any timestamp text to the JS toISOString() "...Z" form so offset/microsecond forms in the
// files compare equal to the DB's offset form. (The read funnels apply this same isoZ.)
function isoZ(v) {
  const s = String(v ?? '').trim()
  if (!s) return ''
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? s : d.toISOString()
}

// ---- per-entity canonicalizers (mirror each read funnel's file-shape record) ----
function canonEmail(e) {
  return {
    id: e.id,
    projectId: e.projectId == null ? '' : String(e.projectId),
    kind: e.kind == null ? '' : String(e.kind),
    to: Array.isArray(e.to) ? e.to.filter(Boolean) : [],
    subject: String(e.subject || ''),
    body: String(e.body || ''),
    format: e.format === 'html' ? 'html' : 'text',
    attachments: Array.isArray(e.attachments) ? e.attachments : [],
    threadId: String(e.threadId || ''),
    threadSubject: String(e.threadSubject || ''),
    status: e.status === 'sent' ? 'sent' : 'draft',
    createdAt: isoZ(e.createdAt),
    updatedAt: isoZ(e.updatedAt),
    sentAt: e.sentAt == null ? '' : String(e.sentAt),
  }
}
function canonTemplate(t) {
  // The files omit `format` on legacy rows (treated as text); canonicalize both sides to an explicit
  // text/html so an absent file format compares equal to the DB's stored one.
  return {
    id: t.id,
    name: String(t.name || ''),
    subject: String(t.subject || ''),
    body: String(t.body || ''),
    format: t.format === 'html' ? 'html' : 'text',
    updatedAt: isoZ(t.updatedAt),
  }
}
function canonNotification(n) {
  return {
    id: n.id,
    projectId: n.projectId == null ? '' : String(n.projectId),
    kind: n.kind == null ? '' : String(n.kind),
    sourceId: n.sourceId == null ? '' : String(n.sourceId),
    createdAt: isoZ(n.createdAt),
    seen: !!n.seen,
  }
}
function canonMarker(m) {
  return {
    projectId: String(m.projectId || ''),
    kind: String(m.kind || ''),
    sent: !!m.sent,
    date: typeof m.date === 'string' ? m.date : '',
    updatedAt: isoZ(m.updatedAt),
  }
}
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') {
    const out = {}
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k])
    return out
  }
  return v
}
const byId = (arr) =>
  arr.slice().sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0))
const byMarker = (arr) =>
  arr.slice().sort((a, b) => {
    const ka = `${a.projectId}|${a.kind}`
    const kb = `${b.projectId}|${b.kind}`
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })

const out = sortKeys({
  emails: byId(loadEmails().map(canonEmail)),
  templates: byId(loadTemplates().map(canonTemplate)),
  notifications: byId(loadNotifications().map(canonNotification)),
  textMarkers: byMarker(loadTextMarkers().map(canonMarker)),
  // Per-project / config blob maps: compared as objects (keys sorted by sortKeys).
  invoices: loadInvoices(),
  contracts: loadContracts(),
  questionnaires: loadQuestionnaires(),
  questionnaireTemplate: loadQuestionnaireTemplate(),
  portals: loadPortals(),
  recipients: loadRecipients(),
  // Full inquiry map (includes dismissed) proves all rows round-trip; the undismissed notifications
  // list is the app's actual read path and proves the dismissed-set filter is preserved.
  inquiries: loadInquiries(),
  inquiryNotifications: listInquiryNotifications(),
  config: loadConfig(),
})

process.stdout.write(JSON.stringify(out))
