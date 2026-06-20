// Business files store for the CRM (slide decks, one-sheets, contracts, any
// document Michael might send a client). Files live in ~/Desktop/Claude/magic-crm/crm-files.
//
// These are CRM-owned working assets, NOT canonical project records, so they sit
// inside the app folder rather than Project Records. When this becomes an
// Electron app the same store moves to the app's user-data directory unchanged.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'crm-files')

function ensureDir() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true })
}

// Reduce any incoming name to a safe basename (no traversal, no separators, no
// leading dots — listFiles hides dotfiles, so a leading-dot upload would vanish).
function safeName(name) {
  const base = path
    .basename(String(name || ''))
    .replace(/[/\\]/g, '')
    .replace(/^\.+/, '')
    .trim()
  if (!base || base === '.' || base === '..') throw new Error('invalid file name')
  return base
}

// Avoid clobbering: if "deck.pdf" exists, the next becomes "deck (2).pdf".
function uniqueName(name) {
  ensureDir()
  if (!fs.existsSync(path.join(DIR, name))) return name
  const ext = path.extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let i = 2; i < 9999; i++) {
    const candidate = `${stem} (${i})${ext}`
    if (!fs.existsSync(path.join(DIR, candidate))) return candidate
  }
  return `${stem}-${Date.now()}${ext}`
}

const CONTENT_TYPES = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json',
  '.key': 'application/octet-stream',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.zip': 'application/zip',
}

export function contentTypeFor(name) {
  return CONTENT_TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream'
}

export function listFiles() {
  ensureDir()
  return fs
    .readdirSync(DIR)
    .filter((n) => !n.startsWith('.'))
    .map((name) => {
      const st = fs.statSync(path.join(DIR, name))
      return { name, size: st.size, modified: st.mtime.toISOString() }
    })
    .sort((a, b) => b.modified.localeCompare(a.modified))
}

export function saveFile(name, buffer) {
  ensureDir()
  const finalName = uniqueName(safeName(name))
  fs.writeFileSync(path.join(DIR, finalName), buffer)
  const st = fs.statSync(path.join(DIR, finalName))
  return { name: finalName, size: st.size, modified: st.mtime.toISOString() }
}

// Returns { buffer, contentType, name } or null if missing.
export function readFile(name) {
  const safe = safeName(name)
  const full = path.join(DIR, safe)
  if (!fs.existsSync(full)) return null
  return { buffer: fs.readFileSync(full), contentType: contentTypeFor(safe), name: safe }
}

export function deleteFile(name) {
  const full = path.join(DIR, safeName(name))
  if (fs.existsSync(full)) fs.unlinkSync(full)
  return { ok: true }
}
