// Claude integration for the CRM. The CRM shells out to the locally-installed Claude Code CLI in
// headless print mode, run inside the business folder, so drafting uses Michael's existing Claude
// Code login (his subscription, no separate API key) and can READ his files (CLAUDE.md, voice.md,
// the templates, Project Records, and the Plaud recordings) to write on-voice, fully-customized
// emails. Tools are limited to read-only (Read/Glob/Grep) so it can never edit or run anything.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RECORDS_DIR, loadAll } from './crm-data-core.mjs'

const CLAUDE_BIN = path.join(os.homedir(), '.local', 'bin', 'claude')
// RECORDS_DIR is ".../The Award-Winning Magic of Michael Bloemeke/Project Records"; its parent is
// the business folder, which holds CLAUDE.md, voice.md, templates/, and "Plaud recordings/".
const BUSINESS_DIR = path.dirname(RECORDS_DIR)
const MEMORY_DIR = path.join(os.homedir(), '.claude', 'projects', '-Users-michaelbloemeke', 'memory')

export function isClaudeAvailable() {
  try {
    return fs.existsSync(CLAUDE_BIN)
  } catch {
    return false
  }
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
    const child = spawn(CLAUDE_BIN, args, { cwd: BUSINESS_DIR })
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
      if (cleaned) finish(() => resolve(cleaned))
      else finish(() => reject(new Error(String(errOut || `Claude exited with code ${code} and no output.`).trim().slice(0, 600))))
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

// Fill a template's smart fields + bracketed instructions for this specific client.
export async function completeTemplate({ projectId, body }) {
  const { text, client } = projectContext(projectId)
  const prompt = [
    "Complete this email TEMPLATE for the specific client below. Fill in every placeholder, follow any bracketed instructions, and keep the template's structure and Michael's voice. Return the finished email body.",
    '',
    text,
    '',
    readHint(client),
    '',
    'TEMPLATE (HTML):',
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
