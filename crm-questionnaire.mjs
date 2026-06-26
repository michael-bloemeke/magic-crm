// Client questionnaire (CRM-owned). An OPTIONAL portal add-on: Michael flips it on for a
// project, the client fills a styled form on their portal page, the answers are stored in
// Vercel Blob, and the CRM pulls them in and AUTO-FILLS the mapped event-detail fields.
// Nothing in the booking system depends on this; it's a bonus that saves data entry.
//
// Return path: the portal is a static site on Vercel and the CRM is local, so answers can't
// be pushed to the Mac. Instead the portal's /api/submit function writes one JSON blob per
// portal token (responses/<token>.json, latest submission wins) and the CRM POLLS for it by
// fetching the public, unguessable blob URL. The write token lives only in the Vercel
// function's env; reads need no secret. The blob store's base URL is captured once in the
// gitignored portal-credentials.json.
//
// Definitions + per-project state live in Project Records/crm-questionnaire.json. The
// question text (not the answers) is published into the portal bundle so the form can render.

import fs from 'node:fs'
import path from 'node:path'
import { RECORDS_DIR, updateProjectField, appendActivityLog } from './crm-data-core.mjs'

const QUESTIONNAIRE_FILE = path.join(RECORDS_DIR, 'crm-questionnaire.json')
const PORTAL_FILE = path.join(RECORDS_DIR, 'crm-portal.json')
const HERE = path.dirname(new URL(import.meta.url).pathname)
const CRED_FILE = path.join(HERE, 'portal-credentials.json')

// The default question set. `fieldKey` is the Project field the answer auto-fills (must be a
// key in crm-data-core's EDITABLE_FIELDS); omit it to make a question informational-only
// (it still shows in the answers view, it just won't touch a field). `type` drives the form
// control on the portal: text | textarea | date | tel | number | select (needs `options`).
export const DEFAULT_QUESTIONS = [
  { id: 'event_date', label: 'What date is your event?', type: 'date', required: true, fieldKey: 'eventDate' },
  { id: 'venue_name', label: 'Where is the event being held? (venue name & address)', type: 'textarea', required: true, fieldKey: 'eventLocation' },
  { id: 'venue_type', label: 'What kind of venue is it? (home, ballroom, restaurant, country club…)', type: 'text', required: false, fieldKey: 'venueType' },
  { id: 'indoor_outdoor', label: 'Will the performance be indoors or outdoors?', type: 'select', options: ['Indoors', 'Outdoors', 'Both / not sure'], required: false, fieldKey: 'indoorsOrOutdoors' },
  { id: 'event_start', label: 'What time does the event start?', type: 'text', required: false, fieldKey: 'eventStartTime' },
  { id: 'show_start', label: 'What time would you like the magic to begin?', type: 'text', required: false, fieldKey: 'showStartTime' },
  { id: 'guest_count', label: 'About how many guests are you expecting?', type: 'text', required: false, fieldKey: 'numberOfGuests' },
  { id: 'guest_ages', label: 'What is the age range of the guests?', type: 'text', required: false, fieldKey: 'ageOfGuests' },
  { id: 'onsite_name', label: 'Who is the best on-site contact the day of the event? (name)', type: 'text', required: false, fieldKey: 'contactNames' },
  { id: 'onsite_phone', label: 'Best cell number to reach them that day', type: 'tel', required: false, fieldKey: 'contactPhones' },
  { id: 'vips', label: 'Are there any guests of honor or VIPs I should make feel special?', type: 'textarea', required: false, fieldKey: 'vips' },
  { id: 'anything_else', label: 'Anything else I should know to make the event perfect?', type: 'textarea', required: false, fieldKey: 'eventDescription' },
]

const DEFAULT_INTRO =
  "I can't wait for your event! A few quick details will help me tailor the perfect performance. This only takes a couple of minutes, and there are no wrong answers."

function meta() {
  return {
    file: 'crm-questionnaire.json',
    owner: 'Magic CRM app (~/Desktop/Claude/magic-crm)',
    purpose:
      'Per-project client questionnaire: the question set, whether it is turned on, and the latest submitted answers. Answers auto-fill mapped event-detail fields. Optional portal add-on; nothing depends on it.',
    cowork_guidance: 'Safe to read. CRM-owned, do NOT overwrite.',
    shape:
      'questionnaires[projectId] = { enabled, response?: { answers[{id,label,value}], submittedAt, pulledAt, appliedFields[], seen } }. Plus a GLOBAL template = { intro, questions[ {id,label,type,required,options?,fieldKey?} ] } edited on the Settings page and used by every project.',
  }
}

function readFile() {
  let d
  try {
    d = JSON.parse(fs.readFileSync(QUESTIONNAIRE_FILE, 'utf8'))
  } catch {
    d = null
  }
  if (!d || typeof d.questionnaires !== 'object' || d.questionnaires === null) d = { questionnaires: {} }
  return d
}
function writeFile(d) {
  d._meta = meta()
  fs.writeFileSync(QUESTIONNAIRE_FILE, JSON.stringify(d, null, 2) + '\n')
}

const QUESTION_TYPES = ['text', 'textarea', 'date', 'tel', 'number', 'select']

// The GLOBAL questionnaire template (intro + questions), edited on the Settings page and used by
// EVERY project's questionnaire. Seeds from the built-in defaults until Michael customizes it.
export function loadTemplate() {
  const d = readFile()
  const t = d.template && typeof d.template === 'object' ? d.template : null
  const intro = t && typeof t.intro === 'string' ? t.intro : DEFAULT_INTRO
  const questions =
    t && Array.isArray(t.questions) && t.questions.length ? t.questions : DEFAULT_QUESTIONS.map((x) => ({ ...x }))
  return { intro, questions }
}
export function saveTemplate({ intro, questions } = {}) {
  const d = readFile()
  const clean = Array.isArray(questions)
    ? questions
        .filter((q) => q && String(q.id || '').trim() && String(q.label || '').trim())
        .map((q) => ({
          id: String(q.id).trim(),
          label: String(q.label).trim(),
          type: QUESTION_TYPES.includes(q.type) ? q.type : 'text',
          required: !!q.required,
          ...(Array.isArray(q.options) && q.options.length ? { options: q.options.map((o) => String(o)).filter(Boolean) } : {}),
          ...(q.fieldKey ? { fieldKey: String(q.fieldKey) } : {}),
        }))
    : []
  d.template = {
    intro: intro != null ? String(intro) : DEFAULT_INTRO,
    questions: clean.length ? clean : DEFAULT_QUESTIONS.map((x) => ({ ...x })),
  }
  writeFile(d)
  return loadTemplate()
}

// The portal token for a project (read directly to avoid a circular import with crm-portal).
function portalToken(projectId) {
  try {
    const d = JSON.parse(fs.readFileSync(PORTAL_FILE, 'utf8'))
    return d?.portals?.[projectId]?.token || ''
  } catch {
    return ''
  }
}

// Base URL of the connected Vercel Blob store, e.g. https://<id>.public.blob.vercel-storage.com
function blobBaseUrl() {
  try {
    return String(JSON.parse(fs.readFileSync(CRED_FILE, 'utf8')).blobBaseUrl || '').replace(/\/+$/, '')
  } catch {
    return ''
  }
}
export function isBlobConfigured() {
  return !!blobBaseUrl()
}

export function loadQuestionnaires() {
  return readFile().questionnaires
}
export function loadQuestionnaire(projectId) {
  return readFile().questionnaires[projectId] || null
}

// Ensure a project has a questionnaire record, seeding the default questions on first touch.
function ensure(d, projectId) {
  let q = d.questionnaires[projectId]
  if (!q) {
    q = { enabled: false, intro: DEFAULT_INTRO, questions: DEFAULT_QUESTIONS.map((x) => ({ ...x })), response: null }
    d.questionnaires[projectId] = q
  }
  if (!Array.isArray(q.questions) || q.questions.length === 0) q.questions = DEFAULT_QUESTIONS.map((x) => ({ ...x }))
  if (typeof q.intro !== 'string') q.intro = DEFAULT_INTRO
  return q
}

// Turn the questionnaire on/off and edit its intro. (Question editing can come later; the
// default set is good out of the box.) Returns the saved record.
export function setQuestionnaire(projectId, { enabled, intro } = {}) {
  if (!projectId) throw new Error('projectId is required')
  const d = readFile()
  const q = ensure(d, projectId)
  if (typeof enabled === 'boolean') q.enabled = enabled
  if (intro != null) q.intro = String(intro)
  writeFile(d)
  return q
}

// The client-safe slice published into the portal bundle: just the questions to render and
// the intro. No answers, no field mappings (the portal doesn't need to know them).
export function questionnaireForBundle(projectId) {
  const q = loadQuestionnaire(projectId)
  if (!q || !q.enabled) return null
  const t = loadTemplate()
  return {
    enabled: true,
    intro: String(t.intro || ''),
    questions: (t.questions || []).map((x) => ({
      id: x.id,
      label: x.label,
      type: x.type || 'text',
      required: !!x.required,
      ...(Array.isArray(x.options) ? { options: x.options } : {}),
    })),
  }
}

// Write each mapped answer into its project field. Returns the labels of the fields filled.
function applyAnswers(projectId, questions, answers) {
  const valueById = Object.fromEntries((answers || []).map((a) => [a.id, a.value]))
  const filled = []
  for (const q of questions || []) {
    if (!q.fieldKey) continue
    const v = valueById[q.id]
    if (v == null || String(v).trim() === '') continue
    try {
      updateProjectField({ id: projectId, field: q.fieldKey, value: String(v) })
      filled.push(q.label)
    } catch {
      // A field that isn't editable (or a project not found) just gets skipped; the raw
      // answer is still stored and visible, so nothing is lost.
    }
  }
  return filled
}

// Poll the blob store for this project's submission. If a NEW one is found (a submittedAt we
// haven't applied yet) it is stored and its mapped answers are auto-filled into the project.
// Re-polling an already-applied submission is a no-op, so it never clobbers Michael's later
// manual edits. Returns { ok, response, filledFields, fresh }.
export async function pullResponse(projectId) {
  const token = portalToken(projectId)
  if (!token) return { ok: false, error: 'This project has no portal yet, so there are no answers to pull.' }
  const base = blobBaseUrl()
  if (!base) return { ok: false, error: 'Answer storage isn\'t set up yet (missing blobBaseUrl in portal-credentials.json).' }

  const url = `${base}/responses/${encodeURIComponent(token)}.json`
  let res
  try {
    res = await fetch(url, { cache: 'no-store' })
  } catch (e) {
    return { ok: false, error: `Couldn't reach answer storage: ${String(e?.message || e)}` }
  }
  if (res.status === 404) {
    const q = loadQuestionnaire(projectId)
    return { ok: true, response: q?.response || null, filledFields: [], fresh: false }
  }
  if (!res.ok) return { ok: false, error: `Answer storage returned ${res.status}.` }

  let payload
  try {
    payload = await res.json()
  } catch {
    return { ok: false, error: 'The stored answers were unreadable.' }
  }
  const incoming = {
    answers: Array.isArray(payload?.answers) ? payload.answers : [],
    submittedAt: String(payload?.submittedAt || ''),
  }

  const d = readFile()
  const q = ensure(d, projectId)
  const already = q.response && q.response.submittedAt && q.response.submittedAt === incoming.submittedAt
  if (already) {
    return { ok: true, response: q.response, filledFields: [], fresh: false }
  }

  const filled = applyAnswers(projectId, loadTemplate().questions, incoming.answers)
  q.response = {
    answers: incoming.answers,
    submittedAt: incoming.submittedAt,
    pulledAt: new Date().toISOString(),
    appliedFields: filled,
    seen: false,
  }
  writeFile(d)
  if (filled.length) appendActivityLog(projectId, `Client filled the questionnaire. Auto-filled: ${filled.join(', ')}.`)
  else appendActivityLog(projectId, 'Client filled the questionnaire.')
  return { ok: true, response: q.response, filledFields: filled, fresh: true }
}

// Submissions the client has sent that Michael hasn't acknowledged yet. Only responses recorded as
// fresh going forward carry `seen: false`; older ones (no flag) are ignored, so enabling this never
// resurfaces historical/test submissions. Each entry is { projectId, submittedAt }.
export function loadUnseenSubmissions() {
  const qs = readFile().questionnaires
  const out = []
  for (const [projectId, q] of Object.entries(qs)) {
    if (q && q.response && q.response.seen === false) {
      out.push({ projectId, submittedAt: q.response.submittedAt || '' })
    }
  }
  return out
}

// Mark a project's submission as acknowledged (clears its notification). Returns the remaining
// unseen submissions.
export function markSubmissionSeen(projectId) {
  const d = readFile()
  const q = d.questionnaires[projectId]
  if (q && q.response && q.response.seen === false) {
    q.response.seen = true
    writeFile(d)
  }
  return loadUnseenSubmissions()
}
