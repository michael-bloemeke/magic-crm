// Claude integration for the CRM. The CRM shells out to the locally-installed Claude Code CLI in
// headless print mode, run inside the business folder, so drafting uses Michael's existing Claude
// Code login (his subscription, no separate API key) and can READ his files (CLAUDE.md, voice.md,
// the templates, Project Records, and the Plaud recordings) to write on-voice, fully-customized
// emails. Tools are limited to read-only (Read/Glob/Grep) so it can never edit or run anything.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RECORDS_DIR, loadAll, updateProjectField } from './crm-data-core.mjs'

const CLAUDE_BIN = path.join(os.homedir(), '.local', 'bin', 'claude')
// RECORDS_DIR is ".../The Award-Winning Magic of Michael Bloemeke/Project Records"; its parent is
// the business folder, which holds CLAUDE.md, voice.md, templates/, and "Plaud recordings/".
const BUSINESS_DIR = path.dirname(RECORDS_DIR)
const MEMORY_DIR = path.join(os.homedir(), '.claude', 'projects', '-Users-michaelbloemeke', 'memory')
// The standalone CLI is not signed in the way the app/IDE is, so headless calls need an explicit
// long-lived token. Michael runs `claude setup-token` once (uses his subscription) and pastes it
// here. Gitignored, not backed up. Env var wins if set.
const CRED_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'claude-credentials.json')
function authToken() {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return String(process.env.CLAUDE_CODE_OAUTH_TOKEN).trim()
  try {
    const c = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'))
    return String(c.oauthToken || c.token || '').trim()
  } catch {
    return ''
  }
}

export function isClaudeAvailable() {
  try {
    return fs.existsSync(CLAUDE_BIN)
  } catch {
    return false
  }
}
// Usable = the CLI is present AND a token is configured (env var or claude-credentials.json).
export function isClaudeConfigured() {
  return isClaudeAvailable() && !!authToken()
}

const SYSTEM_PROMPT =
  "You are drafting a client email for Michael Bloemeke's magic business. Use his voice and follow every rule in CLAUDE.md and voice.md in this folder (if present). NEVER use em-dashes or en-dashes. Output ONLY the finished email body as clean, simple HTML using <p> tags for paragraphs (and <br> where needed). Do NOT include a subject line, an <html> or <head> wrapper, markdown code fences, or any preamble or explanation. Just the email body."

// Strip stray code fences if the model wrapped its output despite instructions.
function cleanup(text) {
  let t = String(text || '').trim()
  const fence = t.match(/^```[a-z]*\s*\n([\s\S]*?)\n```$/i)
  if (fence) t = fence[1].trim()
  return t
}

function runClaude(prompt, opts = {}) {
  const { systemPrompt = SYSTEM_PROMPT, allowWrite = false } = opts
  // Read-only by default. The project chat passes allowWrite so it can edit data (e.g. activity log).
  const tools = allowWrite ? ['Read', 'Glob', 'Grep', 'Edit', 'Write'] : ['Read', 'Glob', 'Grep']
  return new Promise((resolve, reject) => {
    // The prompt is delivered via STDIN (the reliable headless path). Passing it as a positional
    // argument makes Claude Code wait on stdin and warn "no stdin data received", so we pipe it.
    const args = [
      '--print',
      '--output-format',
      'text',
      '--permission-mode',
      allowWrite ? 'acceptEdits' : 'default',
      '--no-session-persistence',
      '--add-dir',
      MEMORY_DIR,
      '--allowedTools',
      ...tools,
      '--append-system-prompt',
      systemPrompt,
    ]
    let out = ''
    let errOut = ''
    let done = false
    const token = authToken()
    const env = token ? { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token } : process.env
    const child = spawn(CLAUDE_BIN, args, { cwd: BUSINESS_DIR, env })
    const timer = setTimeout(() => {
      if (done) return
      done = true
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      reject(new Error('Claude timed out after 180 seconds.'))
    }, 180000)
    const finish = (fn) => {
      if (done) return
      done = true
      clearTimeout(timer)
      fn()
    }
    child.stdout.on('data', (d) => {
      out += d.toString()
    })
    child.stderr.on('data', (d) => {
      errOut += d.toString()
    })
    child.on('error', (e) => finish(() => reject(new Error(String(e?.message || e)))))
    child.on('close', (code) => {
      const cleaned = cleanup(out)
      // A "Not logged in" message comes back on STDOUT, so guard against resolving it as a reply.
      const authErr = /not logged in|please run \/login|setup-token|unauthorized|invalid api key|\b401\b/i
      if (cleaned && !authErr.test(cleaned)) {
        finish(() => resolve(cleaned))
      } else if (authErr.test(cleaned) || authErr.test(errOut)) {
        finish(() =>
          reject(
            new Error(
              'Claude is not authenticated for the app. In Terminal run "claude setup-token" (it uses your subscription), then paste the token into magic-crm/claude-credentials.json as {"oauthToken":"..."} and restart the CRM.',
            ),
          ),
        )
      } else {
        finish(() => reject(new Error(String(errOut || `Claude exited with code ${code} and no output.`).trim().slice(0, 600))))
      }
    })
    try {
      child.stdin.write(prompt)
      child.stdin.end()
    } catch (e) {
      finish(() => reject(new Error(String(e?.message || e))))
    }
  })
}

function projectContext(projectId) {
  const p = loadAll().projects.find((x) => x.id === projectId)
  if (!p) throw new Error('Project not found.')
  const firstEmail = String(p.contactEmails || '').split(/[,;]/)[0].trim()
  const lines = [
    `Project / client: ${p.client || ''}`,
    p.eventType ? `Event type: ${p.eventType}` : '',
    p.eventDate ? `Event date: ${p.eventDate}` : '',
    p.eventLocation ? `Location: ${p.eventLocation}` : '',
    p.totalFee != null && p.totalFee !== '' ? `Quote / fee: $${p.totalFee}` : '',
    p.eventSummary ? `Summary: ${p.eventSummary}` : '',
    p.eventDescription ? `Description: ${p.eventDescription}` : '',
    p.projectNotes ? `Notes: ${p.projectNotes}` : '',
    p.contactNames ? `Client contact: ${p.contactNames}${firstEmail ? ` <${firstEmail}>` : ''}` : '',
  ].filter(Boolean)
  return { text: lines.join('\n'), client: String(p.client || '') }
}

const readHint = (client) =>
  `Read voice.md and CLAUDE.md in this folder for Michael's voice and rules. Also check the "Plaud recordings" folder for any recording or summary file whose name matches the client "${client}", and weave in relevant personal details (names, anecdotes) if you find any. You may look at the "templates" folder for structure.`

// Draft a fresh email from an instruction ("the Draft button on an empty email box").
export async function draftEmail({ projectId, label, instruction }) {
  const { text, client } = projectContext(projectId)
  const what = String(instruction || '').trim()
  const prompt = [
    `Write ${label ? `a "${label}"` : 'an'} email to the client for this project, in Michael's voice.`,
    '',
    text,
    '',
    what ? `What this email needs to do: ${what}` : `Use your judgment for ${label || 'this email'}.`,
    '',
    readHint(client),
  ].join('\n')
  return runClaude(prompt)
}

// Finish a rough draft already in the composer for this specific client: fill in any placeholders,
// follow any bracketed instructions, keep the structure and Michael's voice.
export async function completeDraft({ projectId, body }) {
  const { text, client } = projectContext(projectId)
  const prompt = [
    'Complete this draft email for the specific client below. Fill in every placeholder, follow any bracketed instructions, and keep the draft\'s structure and Michael\'s voice. Return the finished email body.',
    '',
    text,
    '',
    readHint(client),
    '',
    'DRAFT (HTML):',
    String(body || ''),
  ].join('\n')
  return runClaude(prompt)
}

const REPLY_SYSTEM_PROMPT =
  "You are drafting Michael Bloemeke's reply to a client email for his magic business. Use his voice and follow every rule in CLAUDE.md and voice.md in this folder. NEVER use em-dashes or en-dashes. Output ONLY the reply body as PLAIN TEXT (no HTML, no subject line, no preamble). Address what the client actually said and close the way Michael would."

// Draft a reply to a specific email thread (used by the thread reader). Plain text, thread-aware.
export async function draftReply({ projectId, threadText }) {
  const { text, client } = projectContext(projectId)
  const prompt = [
    "Draft Michael's reply to the most recent message in this client email thread. Reply in his voice, address what they said, and keep it concise.",
    '',
    text,
    '',
    readHint(client),
    '',
    'EMAIL THREAD (oldest first):',
    String(threadText || '').slice(0, 12000),
  ].join('\n')
  return runClaude(prompt, { systemPrompt: REPLY_SYSTEM_PROMPT })
}

const CHAT_SYSTEM_PROMPT =
  "You are Claude, working inside Michael Bloemeke's magic-business CRM to help with ONE specific project (given below) unless he says otherwise. You can read AND edit his files in this folder. Follow the data conventions and rules in CLAUDE.md and magic-crm.md, especially the activity_log line format ('Month Day, Year: what happened', newest on top) and which files are safe to edit. NEVER use em-dashes or en-dashes. When you change a file, do it carefully and tell him in one short sentence what you changed (note he may need to refresh the CRM to see it). Reply in plain text, concise."

// A per-project chat with read + write access (so it can do real work like appending to the
// activity log). History is passed in for continuity since each call is a fresh headless run.
export async function chat({ projectId, message, history }) {
  const { text, client } = projectContext(projectId)
  const convo = Array.isArray(history)
    ? history
        .slice(-12)
        .map((m) => `${m.role === 'assistant' ? 'Claude' : 'Michael'}: ${m.text}`)
        .join('\n')
    : ''
  const prompt = [
    'You are helping with THIS project (default scope unless I say otherwise):',
    '',
    text,
    '',
    readHint(client),
    convo ? `\nConversation so far:\n${convo}\n` : '',
    `Michael: ${String(message || '')}`,
    '',
    'Do what I asked. If it changes data (like the activity log), follow the conventions in CLAUDE.md / magic-crm.md and edit the right file. Then reply with a short plain-text message about what you did or found.',
  ].join('\n')
  return runClaude(prompt, { systemPrompt: CHAT_SYSTEM_PROMPT, allowWrite: true })
}


// ---------------------------------------------------------------------------
// Sales call guide
// ---------------------------------------------------------------------------
// Michael's ask, from the 08-31 Kelvin's Corner recording: "as soon as I get an inquiry ... I want
// Claude to automatically -- I don't want to initiate this, I want this to happen automatically --
// a sales call guide is generated ... and put that in the project page in my CRM. So on the project
// page, there'll be a button that I can click near the top."
//
// The guide is written by the headless Claude CLI so it can read the real sources: the template
// spine in templates/sales-call-guide/, CLAUDE.md, the playbook, and any Plaud recording or email
// history for a repeat client. It is stored as markdown on projects.sales_call_guide and rendered
// by SalesCallGuideModal.

const GUIDE_SYSTEM_PROMPT = [
  "You are writing a SALES CALL GUIDE for Michael Bloemeke, a professional magician, to have open in front of him during a live phone call with a prospective client.",
  "He is on the phone. He is scanning, not reading. Every line has to be usable at a glance.",
  "Output ONLY GitHub-flavored markdown. No preamble, no sign-off, no code fences, no HTML.",
  "Use '## ' for the phase headings and '### ' for sub-sections. Use '- ' bullets. Use **bold** for the words he should not miss. Use '> ' blockquote for a line he can read out loud almost verbatim.",
  "NEVER use em-dashes or en-dashes. Regular hyphens only.",
  "Never write 'World Champion'. Award-winning or FISM medalist instead.",
  "Be specific to THIS event. A line that could appear on any guide is wasted space. If you do not know something, make it a question for him to ask rather than an assumption.",
  "Keep it under about 900 words. A guide he will not finish reading is worse than a short one.",
].join(' ')

// Which per-type template file backs this project. Falls back to private, which is the broadest.
function guideTypeFor(eventType) {
  const t = String(eventType || '').toLowerCase()
  if (/wedding|bride|groom|engagement|rehearsal/.test(t)) return 'wedding'
  if (/corporate|company|business|conference|gala|holiday party|banquet|association|chamber|team/.test(t)) return 'corporate'
  return 'private'
}

// Everything on file about the project, wider than projectContext() because the guide is written
// before the sales call and the inquiry form is often the only thing there is.
function guideContext(projectId) {
  const p = loadAll().projects.find((x) => x.id === projectId)
  if (!p) throw new Error('Project not found.')
  const lines = [
    `Project id: ${p.id}`,
    `Client: ${p.client || ''}`,
    p.eventType ? `Event type: ${p.eventType}` : '',
    p.eventDate ? `Event date: ${p.eventDate}` : '',
    p.eventLocation ? `Location / venue: ${p.eventLocation}` : '',
    p.venueType ? `Venue type: ${p.venueType}` : '',
    p.eventStartTime ? `Event start: ${p.eventStartTime}` : '',
    p.numberOfGuests ? `Guests: ${p.numberOfGuests}` : '',
    p.ageOfGuests ? `Guest ages: ${p.ageOfGuests}` : '',
    p.performanceStyle ? `Performance style asked for: ${p.performanceStyle}` : '',
    p.totalFee != null && p.totalFee !== '' ? `Fee already on file: $${p.totalFee}` : '',
    p.bookingSource ? `Found Michael via: ${p.bookingSource}` : '',
    p.contactNames ? `Contact: ${p.contactNames}` : '',
    p.contactEmails ? `Email: ${p.contactEmails}` : '',
    p.contactPhones ? `Phone: ${p.contactPhones}` : '',
    p.eventSummary ? `Summary: ${p.eventSummary}` : '',
    p.eventDescription ? `Description: ${p.eventDescription}` : '',
    p.initialInquiry ? `\nINITIAL INQUIRY / FORM FILL:\n${p.initialInquiry}` : '',
    p.projectNotes ? `\nPROJECT NOTES:\n${p.projectNotes}` : '',
  ].filter(Boolean)
  return { project: p, text: lines.join('\n'), client: String(p.client || '') }
}

export async function generateSalesCallGuide({ projectId }) {
  const { project, text, client } = guideContext(projectId)
  const type = guideTypeFor(project.eventType)
  const prompt = [
    `Write the sales call guide for this inquiry. Event type bucket: ${type.toUpperCase()}.`,
    '',
    'READ THESE FIRST, in this order:',
    '1. templates/sales-call-guide/_shared.md  (the call structure, the tone rule, the close, the standing questions)',
    `2. templates/sales-call-guide/${type}.md  (what is different about this kind of call)`,
    '3. CLAUDE.md  (voice, the banned-phrases list, the standing rules)',
    '4. pricing.md  (so any price you mention is one Michael actually charges)',
    `5. The "Plaud recordings" folder, ONLY if a recording filename matches the client "${client}". A repeat or returning client may have history worth surfacing. If nothing matches, skip it and do not guess.`,
    '',
    'THE EVENT:',
    text,
    '',
    'STRUCTURE THE GUIDE EXACTLY LIKE THIS:',
    '',
    '## The event, in one look',
    'Three to five bullets of what is already known from the inquiry, so he does not have to ask for anything he was already told. Then, as its own bolded line, the single biggest unknown going into the call.',
    '',
    '## 1. Information gathering (stay NEUTRAL)',
    'One short line reminding him this stage is flat and curious, a six out of ten. Then the specific questions for THIS event, as bullets, ordered the way he should ask them. Include the standing questions from the shared file only where they actually apply here. Mark the must-asks in bold.',
    '',
    '## 2. What Michael does (now go UP)',
    'One short line reminding him the neutral tone stops here. Then what to pitch for this specific event and in what order, written as benefit-then-description the way Jonah does it, feeding back what the client said they wanted in their own words. Name the format he should lead with and say why in one clause.',
    '',
    '## 3. Pricing',
    'What to quote and how to say it, based on pricing.md and anything already on file. If the right number depends on an answer he has not got yet, say which answer decides it.',
    '',
    '## 4. Close',
    'The decision-maker question, the scale of one to five, when will you know by, and booking the BAMFAM off that answer. Include the name-of-the-boss ask if this event type has one.',
    '',
    '## Do not forget',
    'Three to six bullets, maximum. Only things that are genuinely easy to forget on THIS call. The venue name if it is missing, a date conflict, a detail from the form he should reference so they know he read it, and the reminder to take a photo at the event if it gets booked.',
  ].join('\n')
  const guide = await runClaude(prompt, { systemPrompt: GUIDE_SYSTEM_PROMPT })
  await updateProjectField({ id: projectId, field: 'salesCallGuide', value: guide })
  await updateProjectField({ id: projectId, field: 'salesCallGuideAt', value: new Date().toISOString() })
  return { guide, generatedAt: new Date().toISOString(), type }
}

// Read what is already stored, without generating.
export function salesCallGuideFor(projectId) {
  const p = loadAll().projects.find((x) => x.id === projectId)
  if (!p) throw new Error('Project not found.')
  return {
    guide: String(p.salesCallGuide || ''),
    generatedAt: String(p.salesCallGuideAt || ''),
    type: guideTypeFor(p.eventType),
  }
}

// --- The automatic part -----------------------------------------------------
// Michael does not want to press a button for this. The sweep looks for early-stage active
// projects that have no guide yet and fills them in, one at a time so several fresh inquiries
// cannot fan out into parallel CLI runs. It is called on a timer by the dev-server plugin.
const GUIDE_STAGES = new Set(['inquiry', 'inquiry-followup-1', 'answered-inquiry', 'in-communication'])
let sweeping = false
const sweepFailures = new Map() // projectId -> attempts, so a broken project cannot loop forever

export async function sweepSalesCallGuides() {
  if (sweeping) return { ok: true, generated: [], skipped: 'already running' }
  if (!isClaudeConfigured()) return { ok: false, generated: [], skipped: 'claude not configured' }
  sweeping = true
  const generated = []
  try {
    const due = loadAll()
      .projects.filter(
        (p) =>
          p.bucket === 'active' &&
          !p.deletedAt &&
          GUIDE_STAGES.has(String(p.stageId || '')) &&
          !String(p.salesCallGuide || '').trim() &&
          (sweepFailures.get(p.id) || 0) < 3,
      )
      // Newest lead first: a guide is only useful before the call happens.
      .sort((a, b) => String(b.leadDate || '').localeCompare(String(a.leadDate || '')))
      .slice(0, 3)
    for (const p of due) {
      try {
        await generateSalesCallGuide({ projectId: p.id })
        generated.push(p.id)
        sweepFailures.delete(p.id)
      } catch (e) {
        sweepFailures.set(p.id, (sweepFailures.get(p.id) || 0) + 1)
        console.warn('[crm-claude] sales call guide failed for', p.id, e?.message || e)
      }
    }
  } finally {
    sweeping = false
  }
  return { ok: true, generated }
}
