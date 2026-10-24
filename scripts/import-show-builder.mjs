// ONE-TIME IMPORT: the standalone Show Builder app's files -> the CRM (2026-10-24).
//
// Michael folded the Show Builder app into the CRM and asked for everything to come with it: "all my
// existing shows ... any files that I've uploaded ... I already added a bunch of tricks and
// everything that I don't want to have to retype."
//
// Reads ~/Documents/Show Builder/ (shows, tricks/, tags/, music/, others/, audio/) and writes one
// `show_builder` row per file, keeping each file's id and JSON exactly. Audio files go to the private
// `show-builder` storage bucket at audio/<storedFilename>.
//
// SAFE TO RE-RUN: every write is an upsert by id. It only READS the local folder and never changes or
// deletes anything in it. That folder stays as it was, a frozen copy of the app's last state.
//
// Run from magic-crm/:  ~/.local/node22/bin/node scripts/import-show-builder.mjs
// Add --dry to print what would be written without writing it.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { sb } from '../crm-store.mjs'
import { normalizeDoc, cleanShow } from '../crm-showbuilder.mjs'

const ROOT = path.join(os.homedir(), 'Documents', 'Show Builder')
const DRY = process.argv.includes('--dry')

function readJsonFiles(dir, suffix) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(suffix))
    .map((f) => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } catch { console.warn('  skipped unreadable', f); return null }
    })
    .filter(Boolean)
}

const sets = [
  ['show', readJsonFiles(ROOT, '.show.json').map(cleanShow)],
  ['trick', readJsonFiles(path.join(ROOT, 'tricks'), '.trick.json')],
  ['tag', readJsonFiles(path.join(ROOT, 'tags'), '.tag.json')],
  ['music', readJsonFiles(path.join(ROOT, 'music'), '.music.json')],
  ['other', readJsonFiles(path.join(ROOT, 'others'), '.other.json')],
  ['audio', readJsonFiles(path.join(ROOT, 'audio'), '.audio.json')],
]

let rows = 0
for (const [kind, docs] of sets) {
  for (const raw of docs) {
    const doc = normalizeDoc(kind, raw)
    if (kind === 'audio') {
      const file = path.join(ROOT, 'audio', doc.storedFilename)
      if (!fs.existsSync(file)) { console.warn(`  audio file missing on disk, metadata only: ${doc.storedFilename}`); }
      else if (!DRY) {
        const { error } = await sb().storage.from('show-builder').upload(`audio/${doc.storedFilename}`, fs.readFileSync(file), { contentType: doc.mimeType, upsert: true })
        if (error) throw new Error(`upload ${doc.storedFilename}: ${error.message}`)
      }
    }
    const row = { id: doc.id, kind, data: doc, created_at: doc.createdAt, updated_at: doc.updatedAt }
    if (!DRY) {
      const { error } = await sb().from('show_builder').upsert(row)
      if (error) throw new Error(`${kind} ${doc.id}: ${error.message}`)
    }
    rows++
    console.log(`  ${DRY ? 'would write' : 'wrote'} ${kind.padEnd(5)} ${doc.name || doc.displayName}`)
  }
}
console.log(`${DRY ? 'Dry run: ' : ''}${rows} documents from ${ROOT}`)
process.exit(0)
