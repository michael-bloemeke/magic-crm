// Claude integration for the CRM. The CRM shells out to the locally-installed Claude Code CLI in
// headless print mode, run inside the business folder, so drafting uses Michael's existing Claude
// Code login (his subscription, no separate API key) and can READ his files (CLAUDE.md, voice.md,
// the templates, Project Records, and the Plaud recordings) to write on-voice, fully-customized
// emails. Tools are limited to read-only (Read/Glob/Grep) so it can never edit or run anything.

import { execFile } from 'node:child_process'
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

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    // Flag order matters: each variadic flag (--add-dir, --allowedTools) is followed by another
    // "--" flag, and the positional prompt comes after the single-value --append-system-prompt, so
    // nothing swallows the prompt.
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
      'Read',
      'Glob',
      'Grep',
      '--append-system-prompt',
      SYSTEM_PROMPT,
      prompt,
    ]
    execFile(
      CLAUDE_BIN,
      args,
      { cwd: BUSINESS_DIR, timeout: 180000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(String(stderr || err.message || 'Claude Code failed').trim().slice(0, 600)))
        const out = cleanup(stdout)
        if (!out) return reject(new Error('Claude returned an empty draft.'))
        resolve(out)
      },
    )
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
