// Copy the phone app into the Website repo, which is what actually serves it.
//
// WHY THIS EXISTS. The phone app used to be its own Vercel deployment, so `git push` on the CRM repo
// did nothing to it and it silently ran stale code. That bit us on 2026-08-03: an event-date fix was
// committed and pushed, and the phone kept the old version live for hours because nobody remembered
// there was a second deploy step. Vercel is gone now and the app is served from
// michaelbloemeke.com/crm/, but the same trap exists in a new shape: two copies of the same files in
// two repos.
//
// So the copy is a SCRIPT, not a habit. Run it, then push the Website repo:
//
//   cd ~/Desktop/claude/magic-crm/mobile && npm run sync
//   cd ~/Desktop/claude/Website && git add -A && git commit -m "..." && git push
//
// `node sync-to-website.mjs --check` copies nothing and exits non-zero if the two are out of step,
// so a test (or a future pre-push hook) can catch drift instead of a client doing it for us.
//
// SOURCE OF TRUTH IS THIS FOLDER. Never hand-edit Website/crm/; it is a build artifact.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEST = join(HERE, '..', '..', 'Website', 'crm')

// Exactly what the browser needs. Everything else here (package.json, this script, .gitignore) is
// tooling and must not be published. An allow-list rather than a deny-list, deliberately: a new
// private file added later should stay private by default rather than ship because nobody excluded it.
const FILES = [
  'index.html',
  'app.js',
  'config.js',
  'supabase-data.js',
  'sw.js',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'damask.webp',
  'email-templates.js',
  'showbuilder-core.js',
  'homelist-core.js',
  // supabase-js and the Node shims it needs, vendored so the app loads no code from another origin.
  'vendor/supabase-js.js',
  'vendor/node-process.js',
  'vendor/node-buffer.js',
  'vendor/node-events.js',
  'vendor/node-tty.js',
  'vendor/node-async_hooks.js',
]

const check = process.argv.includes('--check')

if (!existsSync(join(HERE, '..', '..', 'Website'))) {
  console.error('Cannot find the Website repo at ../../Website. Is it checked out next to magic-crm?')
  process.exit(1)
}

if (!check) mkdirSync(DEST, { recursive: true })

let changed = 0
let same = 0
const drifted = []

for (const name of FILES) {
  const src = join(HERE, name)
  if (!existsSync(src)) {
    console.error(`MISSING source file: ${name}`)
    process.exit(1)
  }
  const from = readFileSync(src)
  const to = join(DEST, name)
  const identical = existsSync(to) && readFileSync(to).equals(from)
  if (identical) {
    same += 1
    continue
  }
  drifted.push(name)
  if (check) continue
  // FILES can contain nested paths (vendor/*), so make sure the folder exists before writing.
  mkdirSync(dirname(to), { recursive: true })
  writeFileSync(to, from)
  changed += 1
}

// Anything in the destination we did not put there is a leftover from an older layout (the dead
// api/ folder, say). Flag it rather than silently serving it.
if (existsSync(DEST)) {
  // Folders that FILES legitimately writes into are not strays.
  const okDirs = new Set(FILES.filter((f) => f.includes('/')).map((f) => f.split('/')[0]))
  for (const name of readdirSync(DEST)) {
    const isDir = statSync(join(DEST, name)).isDirectory()
    if (isDir ? !okDirs.has(name) : !FILES.includes(name)) {
      console.warn(`STRAY in Website/crm: ${name}${isDir ? '/' : ''}  (not part of the app; delete it)`)
    }
  }
}

if (check) {
  if (drifted.length) {
    console.error(`OUT OF SYNC (${drifted.length}): ${drifted.join(', ')}`)
    console.error('Run: cd magic-crm/mobile && npm run sync')
    process.exit(1)
  }
  console.log(`in sync: all ${same} files match Website/crm/`)
} else {
  console.log(`synced ${changed} changed, ${same} already current -> Website/crm/`)
  if (changed) console.log('Now commit + push the Website repo to put it live.')
}
