// Parity gate for the FINANCE + TASKS read paths: runs dump-finance-tasks.mjs twice as child
// processes (once CRM_STORE=files, once CRM_STORE=supabase) with the Node 22 binary, deep-compares
// the two JSON snapshots, and prints PASS/FAIL for each entity (payments, expenses, mileage, tasks)
// with a concise diff of the first few mismatches. Modeled on supabase/parity-reads.mjs.
//
// SAFETY: the files dump only READS the ledgers/tasks (loadPayments/loadExpenses/loadMileage/
// loadTasks never write), but to be certain this test never mutates Michael's real data we snapshot
// + restore every file it could conceivably touch (the finance ledgers, crm-tasks.json, and
// crm-pipeline.json) around the files dump, exactly like parity-reads backs up crm-pipeline.json.
//
// Run with Node 22:  /Users/michaelbloemeke/.local/node22/bin/node supabase/parity-finance-tasks.mjs

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const DUMP = path.join(DIR, 'dump-finance-tasks.mjs')
const NODE22 = '/Users/michaelbloemeke/.local/node22/bin/node'
const RECORDS = path.join(
  os.homedir(),
  'Desktop',
  'Claude',
  'The Award-Winning Magic of Michael Bloemeke',
  'Project Records',
)
// Every file the files dump could conceivably write (defense in depth; the reads don't write).
const GUARDED = ['crm-payments.json', 'crm-expenses.json', 'crm-mileage.json', 'crm-tasks.json', 'crm-pipeline.json'].map(
  (f) => path.join(RECORDS, f),
)

function runDump(store) {
  const stdout = execFileSync(NODE22, [DUMP], {
    env: { ...process.env, CRM_STORE: store },
    maxBuffer: 64 * 1024 * 1024,
  })
  return JSON.parse(stdout.toString('utf8'))
}

// Run the FILES dump with every guarded file backed up + restored, so nothing can mutate the reals.
function runFilesDumpSafely() {
  const backups = GUARDED.map((f) => [f, fs.existsSync(f) ? fs.readFileSync(f) : null])
  try {
    return runDump('files')
  } finally {
    for (const [f, buf] of backups) if (buf != null) fs.writeFileSync(f, buf)
  }
}

// ---- deep diff (same shape as parity-reads.mjs) ----
function diff(a, b, limit = 8) {
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
console.log('Running files dump (with ledger/tasks/pipeline backup+restore)...')
const files = runFilesDumpSafely()
console.log('Running supabase dump...')
const supa = runDump('supabase')

const entities = ['payments', 'expenses', 'mileage', 'tasks']
let allPass = true
console.log('\nFinance + tasks parity results (files vs supabase):')
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
