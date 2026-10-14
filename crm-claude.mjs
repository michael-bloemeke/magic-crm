// Claude integration for the CRM. The CRM shells out to the locally-installed Claude Code CLI in
// headless print mode, run inside the business folder, so drafting uses Michael's existing Claude
// Code login (his subscription, no separate API key) and can READ his files (CLAUDE.md, voice.md,
// the templates, Project Records, and the Plaud recordings) to write on-voice, fully-customized
// emails, and to answer questions about a project. Tools are limited to read-only (Read/Glob/Grep)
// so it can never edit or run anything, the project chat included.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RECORDS_DIR, loadAll, loadTasks } from './crm-data-core.mjs'
import { loadPayments } from './crm-finance.mjs'
import { contactsForProject } from './crm-links.mjs'
import { loadThreads } from './crm-comms.mjs'
import { CRM_STORE, sb } from './crm-store.mjs'

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
  const { systemPrompt = SYSTEM_PROMPT } = opts
  // READ-ONLY, always. Every caller only reads. The project chat used to be given Edit/Write so it
  // could "update the activity log", but the CRM's data lives in Supabase, not in these files, so any
  // edit it made landed in a nightly backup and was thrown away at 3 AM. Michael, 2026-10-14: the
  // chat is for answering questions; changes are made in the Claude app, not from inside the CRM.
  const tools = ['Read', 'Glob', 'Grep']
  return new Promise((resolve, reject) => {
    // The prompt is delivered via STDIN (the reliable headless path). Passing it as a positional
    // argument makes Claude Code wait on stdin and warn "no stdin data received", so we pipe it.
    const args = [
      '--print',
      '--output-format',
      'text',
      '--permission-mode',
      'default',
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
  "You are Claude, answering Michael Bloemeke's questions about ONE project in his magic-business CRM (given below), and about his business generally when he asks. You are READ-ONLY: you cannot change anything, so never offer to, and never claim to have edited, logged or updated anything. If he asks for a change, tell him in one sentence to make it in the Claude app on his laptop. The project record, tasks, payments, contacts, booking-form answers and email threads below are LIVE from the CRM and outrank the backup files in 'Project Records', which can be a day old. For anything else, read the files in this folder: CLAUDE.md and the other business .md files, the 'Plaud recordings' folder (call transcripts, matched by the client's name in the filename), templates, and the memory folder. Plaud transcripts mishear words and can drop a 'not', so say when an answer rests on a transcript. Say plainly when you could not find something rather than guessing. NEVER use em-dashes or en-dashes. Reply in plain text only: no markdown, no asterisks, no headings. Keep it short."

// Everything the CRM knows about a project, as text, for the read-only chat. Pulled LIVE from the
// in-memory cache (and Gmail), so the chat never answers from a stale nightly backup.
//
// Every section is best-effort: a Gmail hiccup or a missing table should cost that section, not
// the whole answer.
const SKIP_KEYS = new Set(['agreementHtml', 'bookingToken', 'salesCallGuide', 'salesCallGuideAt', '_storedStage'])
function clip(v, n = 4000) {
  const t = String(v ?? '').trim()
  return t.length > n ? t.slice(0, n) + ' [...]' : t
}
async function fullProjectContext(projectId) {
  const p = loadAll().projects.find((x) => x.id === projectId)
  if (!p) throw new Error('Project not found.')
  const out = []

  out.push('PROJECT RECORD (live from the CRM):')
  for (const [k, v] of Object.entries(p)) {
    if (SKIP_KEYS.has(k) || v == null || v === '') continue
    if (Array.isArray(v) && !v.length) continue
    const shown = typeof v === 'object' ? JSON.stringify(v) : String(v)
    if (!shown.trim()) continue
    out.push(`- ${k}: ${clip(shown)}`)
  }

  try {
    const contacts = contactsForProject(projectId) || []
    if (contacts.length) {
      out.push('', 'CONTACTS ON THIS PROJECT:')
      for (const c of contacts) {
        const bits = [c.name, (c.emails || []).join(', '), (c.phones || []).join(', '), c.relationship, c.notes]
        out.push(`- ${bits.filter((b) => String(b || '').trim()).join(' | ')}`)
      }
    }
  } catch { /* contacts are optional context */ }

  try {
    const tasks = loadTasks().filter((t) => t.projectId === projectId)
    if (tasks.length) {
      out.push('', 'TASKS:')
      for (const t of tasks) out.push(`- [${t.done ? 'done' : 'open'}] ${t.title}${t.dueDate ? ` (due ${t.dueDate}${t.dueTime ? ' ' + t.dueTime : ''})` : ''}`)
    }
  } catch { /* tasks are optional context */ }

  try {
    const pays = loadPayments().filter((x) => x.projectId === projectId)
    if (pays.length) {
      out.push('', 'PAYMENTS LOGGED IN THE CRM (the quoted amounts; QuickBooks holds the exact deposits):')
      for (const x of pays) out.push(`- $${x.amount} on ${x.dateReceived || 'date not set'}${x.method ? ` via ${x.method}` : ''}`)
    }
  } catch { /* payments are optional context */ }

  if (CRM_STORE === 'supabase') {
    try {
      const { data } = await sb()
        .from('booking_submissions')
        .select('answers, submitted_at, signed_name, signed_at')
        .eq('project_id', projectId)
        .maybeSingle()
      if (data) {
        out.push('', `BOOKING FORM (submitted ${data.submitted_at || 'not yet'}${data.signed_at ? `, agreement signed by ${data.signed_name} at ${data.signed_at}` : ', not signed'}):`)
        for (const a of Array.isArray(data.answers) ? data.answers : []) out.push(`- ${a.id}: ${clip(a.value, 1000)}`)
      }
    } catch { /* booking answers are optional context */ }
  }

  try {
    const { threads = [] } = (await loadThreads(projectId)) || {}
    if (threads.length) {
      out.push('', 'EMAIL THREADS WITH THIS CLIENT (newest first, live from Gmail):')
      let budget = 24000
      for (const t of threads.slice(0, 8)) {
        out.push('', `Thread: ${t.subject}`)
        for (const m of t.messages || []) {
          const line = `[${m.isDraft ? 'UNSENT DRAFT' : m.date}] ${m.fromName}: ${clip(m.body, 2500)}`
          if (budget - line.length < 0) break
          budget -= line.length
          out.push(line)
        }
      }
    }
  } catch { /* email is optional context */ }

  return { text: out.join('\n'), client: String(p.client || '') }
}

// A per-project chat that ANSWERS QUESTIONS and nothing else. History is passed in for continuity
// since each call is a fresh headless run.
export async function chat({ projectId, message, history }) {
  const { text, client } = await fullProjectContext(projectId)
  const convo = Array.isArray(history)
    ? history
        .slice(-12)
        .map((m) => `${m.role === 'assistant' ? 'Claude' : 'Michael'}: ${m.text}`)
        .join('\n')
    : ''
  const prompt = [
    'Answer my question about THIS project (default scope unless I say otherwise).',
    '',
    text,
    '',
    `Also check the "Plaud recordings" folder (all subfolders) for any transcript or summary whose filename matches the client "${client}", and read it if the question could depend on what was said on a call.`,
    convo ? `\nConversation so far:\n${convo}\n` : '',
    `Michael: ${String(message || '')}`,
  ].join('\n')
  const reply = await runClaude(prompt, { systemPrompt: CHAT_SYSTEM_PROMPT })
  return plainReply(reply)
}

// The chat panel shows text exactly as returned (whitespace-pre-line), so markdown arrives as literal
// asterisks, and a dash slipped past the prompt is still a dash. Michael's no-dash rule is absolute,
// so this is a backstop, not a style choice.
function plainReply(text) {
  return String(text || '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(^|\s)\*(\S.*?\S|\S)\*(?=\s|$|[.,!?])/g, '$1$2')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(\d)\s*[\u2014\u2013]\s*(\d)/g, '$1 to $2')
    .replace(/\s*[\u2014\u2013]\s*/g, ', ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
