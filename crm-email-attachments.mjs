// One-off email attachment store (CRM-owned). Files UPLOADED while composing an email land
// here, kept SEPARATE from the Files page so that library stays curated. Attachments PICKED
// from the Files page are referenced in place (read from crm-files at send time) and never
// copied here; only uploads live here. Each upload gets its own id directory so the exact
// original filename is preserved without collisions. Lives in magic-crm/crm-email-attachments/
// (gitignored working data; moves to the app's user-data dir when this becomes Electron).

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { contentTypeFor } from './crm-files.mjs'

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'crm-email-attachments')

function ensureDir() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true })
}

function safeName(name) {
  const base = path
    .basename(String(name || ''))
    .replace(/[/\\]/g, '')
    .replace(/^\.+/, '')
    .trim()
  return base && base !== '.' && base !== '..' ? base : 'attachment.bin'
}
function safeId(id) {
  const s = String(id || '')
  if (!/^[a-f0-9]{8,}$/.test(s)) throw new Error('invalid attachment id')
  return s
}

export function saveAttachment(name, buffer) {
  ensureDir()
  const id = crypto.randomBytes(12).toString('hex')
  const fname = safeName(name)
  fs.mkdirSync(path.join(DIR, id), { recursive: true })
  fs.writeFileSync(path.join(DIR, id, fname), buffer)
  return { id, name: fname, size: buffer.length }
}

// Returns { buffer, name, contentType } or null if the id is gone.
export function readAttachment(id) {
  let dir
  try {
    dir = path.join(DIR, safeId(id))
  } catch {
    return null
  }
  if (!fs.existsSync(dir)) return null
  const files = fs.readdirSync(dir).filter((n) => !n.startsWith('.'))
  if (!files.length) return null
  const name = files[0]
  return { buffer: fs.readFileSync(path.join(dir, name)), name, contentType: contentTypeFor(name) }
}

export function deleteAttachment(id) {
  let dir
  try {
    dir = path.join(DIR, safeId(id))
  } catch {
    return { ok: true }
  }
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
  return { ok: true }
}
