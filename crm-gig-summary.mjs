// THE GIG SUMMARY (Michael, 2026-11-14). One button on every project, on the Mac and the phone, that has
// Claude write "everything I need to know about the gig, as if I were leaving for it today": when to
// leave, where it is, what the venue is like, what he is performing, who to call on site, and anything
// that changes what he packs or how he sets up (no AV, outdoors, a stage or no stage). Not every detail
// of the project, and none of the sales-call colour.
//
// HOW IT RUNS. Exactly like the daily report's notes (crm-daily-report.mjs): one headless run of the
// local Claude Code CLI on his subscription (no API bill), no tools, a JSON answer checked against
// SCHEMA by the CLI itself. Saved to `gig_summaries`, one row per project, so the phone shows the same
// summary. The phone cannot run Claude, so it ASKS: it sets the row to `requested`, and this Mac picks
// it up (serveSummaryRequests, called whenever the data changes and at boot).
//
// A SUMMARY IS KEPT until he asks for a new one. Opening it again just shows it, with the date and
// time it was written at the top, and a Regenerate button. While a new one is being written the old
// one stays in the row, so there is always something to read.
//
// ⚠️ ADVICE, NEVER ACTION. The writer is given no tools; everything it knows is in the prompt.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadAll } from './crm-data-core.mjs'
import { CRM_STORE, sb } from './crm-store.mjs'
import { fullProjectContext } from './crm-claude.mjs'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const CLAUDE_BIN = path.join(os.homedir(), '.local', 'bin', 'claude')
// Same model as the daily report: the newest one his installed Claude Code CLI accepts.
const MODEL = 'claude-sonnet-5-5'
const WRITE_TIMEOUT_MS = 5 * 60 * 1000
const TIMEZONE = 'America/New_York'
const str = (v) => (v == null ? '' : String(v))
const clip = (v, n) => { const t = str(v).trim(); return t.length > n ? t.slice(0, n) + '...' : t }
const inflight = new Map() // projectId -> the write in progress

// ---------------------------------------------------------------------------------------------
// What Claude is told
// ---------------------------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  "You write a day-of gig briefing for Michael Bloemeke, a professional magician. He reads it on the day of the event, the way a pilot reads a checklist, to get ready and leave on time. You are given his CRM record of ONE gig: the project fields, contacts, tasks, payments, the client's booking form, and recent email threads.",
  '',
  'Include ONLY what he needs to show up and perform well:',
  '- When: the date, when to leave home, when to arrive, when guests arrive, when he performs and for how long, when the event ends, when he is back home. Use the record\'s "Leave home" and "Back home" fields (leaveHomeTime, backHomeTime).',
  '- Where: the venue name, the full street address exactly as recorded, and what the venue is like (indoor or outdoor, the room or space, a stage or not).',
  '- The performance: what he is doing (mingling magic, the formal show, a private set for the couple, and so on), how long, the audience (guest count, ages, who they are), and what the client asked for.',
  '- Things that change how he packs or sets up: AV or no AV, microphone, power, a table, lighting, outdoor weather, space limits, parking and load-in, where to stash his bag, dress code.',
  '- People to know: the on-site contact and planner with phone numbers, the honorees, VIPs, and names he should use.',
  '- Money to collect at the event, ONLY if the record shows a balance due at the event. Otherwise leave "collect" empty.',
  '',
  'Leave out: how the sales call went, opinions about people, price negotiation, his internal process, marketing notes, and anything about other projects.',
  '',
  'Rules:',
  '- Facts only, from the record. Never invent or guess an address, a time, a name, or a phone number. When sources disagree, use the most recent one and say so in "notes".',
  '- "missing" lists only ESSENTIAL details that are not in the record and that he would need for the day: for example no leave-home time, no venue address, no performance start time, no on-site contact. Not every detail that could exist. Leave it empty when nothing essential is missing.',
  '- "schedule" is in time order, one line per moment, with the time in 12-hour form (5:30 PM). Use a range when the record gives one.',
  '- Write dates out in words (Saturday, November 14). Times are always 12-hour with AM or PM.',
  '- Short, plain sentences. Each bullet is one thing. No headers, no markdown, no emoji.',
  '- NEVER use an em dash or an en dash. Use a comma, a colon, or a new sentence.',
  '- "headline" is the date and the event, for example "Saturday, November 14: Prashant Patel\'s wedding".',
  '- "overview" is one or two sentences: what the gig is, at a glance.',
  '- "location.address" is ONLY a street address copied from the record. If there is none, it is an empty string and the gap goes in "missing". The same for a contact\'s "phone": the number, or an empty string.',
].join('\n')

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'overview', 'schedule', 'location', 'performance', 'notes', 'contacts', 'collect', 'missing'],
  properties: {
    headline: { type: 'string' },
    overview: { type: 'string' },
    schedule: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['time', 'what'], properties: { time: { type: 'string' }, what: { type: 'string' } } },
    },
    location: {
      type: 'object',
      additionalProperties: false,
      required: ['venue', 'address', 'details'],
      properties: { venue: { type: 'string' }, address: { type: 'string' }, details: { type: 'array', items: { type: 'string' } } },
    },
    performance: { type: 'array', items: { type: 'string' } },
    notes: { type: 'array', items: { type: 'string' } },
    contacts: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['name', 'role', 'phone'], properties: { name: { type: 'string' }, role: { type: 'string' }, phone: { type: 'string' } } },
    },
    collect: { type: 'string' },
    missing: { type: 'array', items: { type: 'string' } },
  },
}

function longToday() {
  return new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date())
}

async function buildPrompt(projectId) {
  const { text } = await fullProjectContext(projectId)
  return [
    `Today is ${longToday()}.`,
    'Write the gig briefing for this project. If the gig is not today, still write it as if he were preparing for it now, and list in "missing" any essential detail that has not been settled yet.',
    '',
    text,
  ].join('\n')
}

// A dash-free, trimmed copy of whatever came back, so a stray dash can never reach the page.
const tidy = (v) => str(v).replace(/\s*[–—]\s*/g, ', ').replace(/\s+/g, ' ').trim()
function clean(a) {
  const list = (x) => (Array.isArray(x) ? x.map(tidy).filter(Boolean) : [])
  return {
    headline: tidy(a.headline),
    overview: tidy(a.overview),
    schedule: (Array.isArray(a.schedule) ? a.schedule : []).map((s) => ({ time: tidy(s.time), what: tidy(s.what) })).filter((s) => s.time || s.what),
    // An "address" that is really a sentence about there being no address would become a broken map
    // link, so anything saying "not recorded" is dropped (the prompt asks for an empty string).
    location: { venue: tidy(a.location?.venue), address: /not (in|recorded|known|given)|no (street )?address|unknown/i.test(str(a.location?.address)) ? '' : tidy(a.location?.address), details: list(a.location?.details) },
    performance: list(a.performance),
    notes: list(a.notes),
    contacts: (Array.isArray(a.contacts) ? a.contacts : []).map((c) => ({ name: tidy(c.name), role: tidy(c.role), phone: /\d{3}/.test(str(c.phone)) ? tidy(c.phone) : '' })).filter((c) => c.name || c.phone),
    collect: tidy(a.collect),
    missing: list(a.missing),
  }
}

// ---------------------------------------------------------------------------------------------
// One headless run of the Claude Code CLI (the daily report's arrangement)
// ---------------------------------------------------------------------------------------------

function authToken() {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return str(process.env.CLAUDE_CODE_OAUTH_TOKEN).trim()
  try {
    const c = JSON.parse(fs.readFileSync(path.join(DIR, 'claude-credentials.json'), 'utf8'))
    return str(c.oauthToken || c.token).trim()
  } catch {
    return ''
  }
}

function askClaude(prompt) {
  return new Promise((resolve, reject) => {
    const token = authToken()
    if (!fs.existsSync(CLAUDE_BIN) || !token) {
      reject(new Error('Claude is not set up on this Mac. In Terminal run "claude setup-token", then put the token in magic-crm/claude-credentials.json.'))
      return
    }
    const args = [
      '--print', '--output-format', 'json', '--no-session-persistence',
      '--tools', '',
      '--model', MODEL,
      '--system-prompt', SYSTEM_PROMPT,
      '--json-schema', JSON.stringify(SCHEMA),
    ]
    const child = spawn(CLAUDE_BIN, args, { cwd: os.tmpdir(), env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token } })
    let out = ''
    let err = ''
    let done = false
    const finish = (fn) => {
      if (done) return
      done = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => finish(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      reject(new Error('Claude took too long and was stopped. Try again.'))
    }), WRITE_TIMEOUT_MS)
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => finish(() => reject(new Error(str(e?.message || e)))))
    child.on('close', () => finish(() => {
      let j = null
      try { j = JSON.parse(out) } catch { /* handled below */ }
      if (j && !j.is_error && j.structured_output) {
        resolve({ answer: j.structured_output, model: Object.keys(j.modelUsage || {})[0] || MODEL })
        return
      }
      const said = str(j?.result || out || err).trim()
      if (/not logged in|setup-token|unauthorized|invalid api key|\b401\b/i.test(said)) {
        reject(new Error('Claude is not signed in for the CRM. In Terminal run "claude setup-token" and put the new token in magic-crm/claude-credentials.json.'))
      } else {
        reject(new Error(clip(said || 'Claude returned nothing.', 300)))
      }
    }))
    try {
      child.stdin.write(prompt)
      child.stdin.end()
    } catch (e) {
      finish(() => reject(new Error(str(e?.message || e))))
    }
  })
}

// ---------------------------------------------------------------------------------------------
// Writing, reading, and the phone's requests
// ---------------------------------------------------------------------------------------------

// Write (or rewrite) one project's summary. Returns the write already running when there is one, so two
// clicks, or the Mac and the phone together, never start two.
export function writeSummary(projectId, { by = 'mac' } = {}) {
  const id = str(projectId).trim()
  if (!id) return Promise.resolve({ ok: false, error: 'No project.' })
  if (inflight.has(id)) return inflight.get(id)
  const job = (async () => {
    if (CRM_STORE !== 'supabase') return { ok: false, error: 'The gig summary needs the Supabase store.' }
    if (!loadAll().projects.some((p) => p.id === id)) return { ok: false, error: 'Project not found.' }
    const { error: upErr } = await sb().from('gig_summaries').upsert({ project_id: id, status: 'writing', requested_by: by, requested_at: new Date().toISOString(), error: null }, { onConflict: 'project_id' })
    if (upErr) return { ok: false, error: `gig_summaries: ${upErr.message}` }
    try {
      const prompt = await buildPrompt(id)
      const { answer, model } = await askClaude(prompt)
      const summary = clean(answer)
      const { error } = await sb().from('gig_summaries').update({ status: 'ready', summary, model, generated_at: new Date().toISOString(), error: null }).eq('project_id', id)
      if (error) throw new Error(`gig_summaries: ${error.message}`)
      return { ok: true }
    } catch (e) {
      const message = clip(e?.message || e, 300)
      await sb().from('gig_summaries').update({ status: 'error', error: message }).eq('project_id', id)
      console.error('[gig-summary] could not write the summary:', message)
      return { ok: false, error: message }
    }
  })().finally(() => inflight.delete(id))
  inflight.set(id, job)
  return job
}

export async function loadSummary(projectId) {
  const id = str(projectId).trim()
  if (!id || CRM_STORE !== 'supabase') return { row: null, writing: false }
  const { data, error } = await sb().from('gig_summaries').select('*').eq('project_id', id).maybeSingle()
  if (error) throw new Error(`gig_summaries: ${error.message}`)
  return { row: data || null, writing: inflight.has(id) }
}

// The phone asked (it set a row to `requested`). Claim each request with a conditional update so it is
// written once even if this runs twice, then write it. Also restarts a write that a server restart cut
// off: only this process writes summaries, so "writing" with nothing in flight here means nobody is.
export async function serveSummaryRequests() {
  if (CRM_STORE !== 'supabase') return
  try {
    const { data } = await sb().from('gig_summaries').select('project_id').eq('status', 'requested').limit(5)
    for (const r of data || []) {
      const { data: claimed } = await sb().from('gig_summaries').update({ status: 'writing', requested_at: new Date().toISOString() }).eq('project_id', r.project_id).eq('status', 'requested').select('project_id')
      if (claimed && claimed.length) void writeSummary(r.project_id, { by: 'phone' })
    }
    const { data: stuck } = await sb().from('gig_summaries').select('project_id').eq('status', 'writing').limit(5)
    for (const r of stuck || []) {
      if (!inflight.has(r.project_id)) void writeSummary(r.project_id, { by: 'mac' })
    }
  } catch (e) {
    console.warn('[gig-summary] could not check for requests:', e?.message || e)
  }
}
