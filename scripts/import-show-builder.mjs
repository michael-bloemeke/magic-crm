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
// It only READS the local folder and never changes or deletes anything in it.
//
// ⚠️ ALREADY RUN, ONCE, ON 2026-10-24. DO NOT RUN IT AGAIN. Since then the CRM's Show Builder and the
// standalone app are two SEPARATE things that each go their own way (Michael, 2026-10-24: "I want
// these to be two different things ... I want everything to just be self-contained within the CRM").
// Every write here is an upsert by the SAME ids, so a second run would copy the app's versions back
// over whatever he has since changed in the CRM. It refuses to write without --force for that reason.
//
// Run from magic-crm/:  ~/.local/node22/bin/node scripts/import-show-builder.mjs --dry

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { sb } from '../crm-store.mjs'
import { normalizeDoc, cleanShow } from '../crm-showbuilder.mjs'

const ROOT = path.join(os.homedir(), 'Documents', 'Show Builder')
const DRY = process.argv.includes('--dry')
if (!DRY && !process.argv.includes('--force')) {
  console.error('This import already ran on 2026-10-24. Running it again would overwrite CRM edits with the standalone app\'s copies.')
  console.error('Use --dry to look, or --force only if Michael has asked for the app\'s data to be copied in again.')
  process.exit(1)
}

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
