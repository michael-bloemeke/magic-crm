// Parity gate for the READ paths: runs dump-reads.mjs twice as child processes (once
// CRM_STORE=files, once CRM_STORE=supabase) with the Node 22 binary, deep-compares the two
// JSON snapshots, and prints PASS/FAIL for each of the four entities (projects, contacts,
// links, structure) with a concise diff of the first few mismatches.
//
// SAFETY: running the files dump calls loadAll(), which may PERSIST derived stage changes back
// to the real crm-pipeline.json. Before the files dump we copy that file to a temp backup and
// restore it afterward (in a finally), so this test never mutates Michael's real data.
//
// Run with Node 22:  /Users/michaelbloemeke/.local/node22/bin/node supabase/parity-reads.mjs

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const DUMP = path.join(DIR, 'dump-reads.mjs')
const NODE22 = '/Users/michaelbloemeke/.local/node22/bin/node'
const PIPELINE_FILE = path.join(
  os.homedir(),
  'Desktop',
  'Claude',
  'The Award-Winning Magic of Michael Bloemeke',
  'Project Records',
  'crm-pipeline.json',
)

function runDump(store) {
  const stdout = execFileSync(NODE22, [DUMP], {
    env: { ...process.env, CRM_STORE: store },
    maxBuffer: 64 * 1024 * 1024,
  })
  return JSON.parse(stdout.toString('utf8'))
}

// Run the FILES dump with crm-pipeline.json backed up + restored, so a persist during loadAll
// can't mutate the real file.
function runFilesDumpSafely() {
  const backup = fs.existsSync(PIPELINE_FILE) ? fs.readFileSync(PIPELINE_FILE) : null
  try {
    return runDump('files')
  } finally {
    if (backup != null) fs.writeFileSync(PIPELINE_FILE, backup)
  }
}

// Deep-compare two values. Returns an array of { path, a, b } for the first `limit` differences.
function diff(a, b, limit = 6) {
  const diffs = []
  const seen = (p, x, y) => {
    if (diffs.length >= limit) return
    diffs.push({ path: p || '(root)', a: preview(x), b: preview(y) })
  }
  const walk = (x, y, p) => {
    if (diffs.length >= limit) return
    if (x === y) return
    const tx = kind(x)
    const ty = kind(y)
    if (tx !== ty) return seen(p, x, y)
    if (tx === 'array') {
      if (x.length !== y.length) return seen(`${p}.length`, x.length, y.length)
      for (let i = 0; i < x.length && diffs.length < limit; i++) walk(x[i], y[i], `${p}[${i}]`)
      return
    }
    if (tx === 'object') {
      const keys = new Set([...Object.keys(x), ...Object.keys(y)])
      for (const k of [...keys].sort()) {
        if (diffs.length >= limit) break
        if (!(k in x)) seen(`${p}.${k}`, undefined, y[k])
        else if (!(k in y)) seen(`${p}.${k}`, x[k], undefined)
        else walk(x[k], y[k], p ? `${p}.${k}` : k)
      }
      return
    }
    seen(p, x, y)
  }
  walk(a, b, '')
  return diffs
}

function kind(v) {
  if (Array.isArray(v)) return 'array'
  if (v === null) return 'null'
  return typeof v === 'object' ? 'object' : typeof v
}
function preview(v) {
  if (v === undefined) return '(absent)'
  const s = JSON.stringify(v)
  return s == null ? String(v) : s.length > 120 ? s.slice(0, 117) + '...' : s
}

// ---- run ----
console.log('Running files dump (with crm-pipeline.json backup/restore)...')
const files = runFilesDumpSafely()
console.log('Running supabase dump...')
const supa = runDump('supabase')

const entities = ['projects', 'contacts', 'links', 'structure']
let allPass = true
console.log('\nParity results (files vs supabase):')
for (const e of entities) {
  const diffs = diff(files[e], supa[e])
  const pass = diffs.length === 0
  allPass = allPass && pass
  const count = (v) => (Array.isArray(v) ? `${v.length} items` : `${Object.keys(v || {}).length} keys`)
  console.log(`\n  ${pass ? 'PASS' : 'FAIL'}  ${e}  (files: ${count(files[e])}, supabase: ${count(supa[e])})`)
  if (!pass) {
    for (const d of diffs) {
      console.log(`        at ${d.path}`)
      console.log(`          files:    ${d.a}`)
      console.log(`          supabase: ${d.b}`)
    }
  }
}

console.log(`\n${allPass ? 'ALL PASS' : 'FAILED'}`)
process.exit(allPass ? 0 : 1)
