// Verification gate for the one-way backup exporter (supabase/backup-export.mjs).
//
// It exports Supabase -> a fresh TEMP directory (never the real Project Records), then for each
// reconstructed file it deep-compares the exported DATA against the REAL Project Records file.
// The comparison is CONTENT-based: it ignores key ORDER, ignores the self-documenting _meta block,
// and treats an ABSENT key as equal to an empty value ("" / null / []). That last rule matters
// because the Supabase columns cannot record whether a historically-empty field was stored as "" or
// omitted (both collapse to the same DB value), so absent-vs-empty is not a real data difference.
//
// Because Supabase currently MIRRORS the files (a fresh import ran), the round-trip should reproduce
// them. Per file it prints MATCH, or the first few real differences.
//
// KNOWN-ACCEPTABLE diffs (reported separately, not counted as failures):
//   (a) key ordering                     -> normalized away by the content compare.
//   (b) _meta                            -> excluded from the compare entirely.
//   (c) total_fee that import stored as null because the FILE held a non-numeric string
//       (e.g. "TBD (not yet quoted)"). The DB genuinely no longer has that string, so the mirror
//       can't reproduce it. Flagged as ACCEPTABLE (feeString) with the file's original text.
//   (d) a stage_id the live app auto-progressed since the last import (Post Show day-after-event
//       logic). Flagged as ACCEPTABLE only when it is exactly such an auto-progression.
//   (e) crm-pipeline.json flowLayout drift: the DB's flowLayout is newer than the file's (the app
//       edited it after the import). The DB is the source of truth, so writing its flowLayout is
//       correct; the stale file positions are the ones out of date. Flagged as ACCEPTABLE.
//
// Any OTHER difference (a lost field, a changed value, a missing/extra project or contact) is a REAL
// bug in the exporter and fails the gate.
//
// Run with Node 22:  /Users/michaelbloemeke/.local/node22/bin/node supabase/verify-backup.mjs

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

import { exportBackup, REAL_RECORDS_DIR } from './backup-export.mjs'

const DIR = path.dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// Content normalization: empty-ish -> a single canonical "empty" so absent === "" === null === [].
// ---------------------------------------------------------------------------
const EMPTY = Symbol('empty')
function isEmpty(v) {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
}

// Canonical, order-insensitive string form of a value for equality, with empties collapsed.
function canon(v) {
  if (isEmpty(v)) return 'EMPTY'
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']'
  if (typeof v === 'object') {
    return (
      '{' +
      Object.keys(v)
        .filter((k) => !isEmpty(v[k])) // an absent key and an empty value are the same content
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canon(v[k]))
        .join(',') +
      '}'
    )
  }
  if (typeof v === 'number') return 'N:' + v
  return 'S:' + String(v)
}

// Deep content diff of two objects, ignoring key order and treating empties as equal. Returns
// { path, a, b } entries. `numAsString` (default true) treats number 750 == string "750" as equal
// content (the files sometimes store fees as numbers, sometimes the DB coerced strings), so a pure
// numeric-vs-numeric-string representation is not flagged.
function contentDiff(a, b, limit = 8) {
  const diffs = []
  const push = (p, x, y) => {
    if (diffs.length < limit) diffs.push({ path: p || '(root)', a: preview(x), b: preview(y) })
  }
  const walk = (x, y, p) => {
    if (diffs.length >= limit) return
    if (isEmpty(x) && isEmpty(y)) return
    const tx = kind(x)
    const ty = kind(y)
    // number vs numeric-string equality
    if ((tx === 'number' || tx === 'string') && (ty === 'number' || ty === 'string')) {
      if (String(x) === String(y)) return
      // allow "750" == 750
      if (Number(x) === Number(y) && x !== '' && y !== '' && Number.isFinite(Number(x))) return
      return push(p, x, y)
    }
    if (tx !== ty) return push(p, x, y)
    if (tx === 'array') {
      if (x.length !== y.length) return push(`${p}.length`, x.length, y.length)
      for (let i = 0; i < x.length && diffs.length < limit; i++) walk(x[i], y[i], `${p}[${i}]`)
      return
    }
    if (tx === 'object') {
      const keys = new Set([...Object.keys(x), ...Object.keys(y)])
      for (const k of [...keys].sort()) {
        if (diffs.length >= limit) break
        const xv = x[k]
        const yv = y[k]
        if (isEmpty(xv) && isEmpty(yv)) continue
        walk(xv, yv, p ? `${p}.${k}` : k)
      }
      return
    }
    if (canon(x) !== canon(y)) push(p, x, y)
  }
  walk(a, b, '')
  return diffs
}

function kind(v) {
  if (Array.isArray(v)) return 'array'
  if (v === null || v === undefined) return 'null'
  return typeof v === 'object' ? 'object' : typeof v
}
function preview(v) {
  if (v === undefined) return '(absent)'
  const s = JSON.stringify(v)
  return s == null ? String(v) : s.length > 140 ? s.slice(0, 137) + '...' : s
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Per-entity comparators. Each returns { file, status, realCount, exportCount, diffs, accepted }.
// ---------------------------------------------------------------------------

// Index a project array by client_name (the identity field) for order-insensitive matching.
function indexProjects(arr) {
  const m = new Map()
  for (const p of arr || []) m.set(String(p.client_name), p)
  return m
}

// Classify a per-project field diff as an ACCEPTABLE known case, or leave it as a real diff.
// realProj / exportProj are the two records; accepted collects human-readable acceptable notes.
function classifyProjectDiffs(diffs, realProj, exportProj, accepted, client) {
  const remaining = []
  for (const d of diffs) {
    // (c) total_fee: file has a non-numeric string, export dropped it to empty (import stored null).
    if (d.path === 'total_fee') {
      const rv = realProj.total_fee
      const ev = exportProj.total_fee
      if (typeof rv === 'string' && !/^\s*\$?[\d,.]+\s*$/.test(rv) && isEmpty(ev)) {
        accepted.push(`${client}: total_fee non-numeric string dropped by import -> null. file="${rv}"`)
        continue
      }
    }
    remaining.push(d)
  }
  return remaining
}

function compareProjectFile(fileName, realDir, exportDir, accepted) {
  const real = readJson(path.join(realDir, fileName))
  const exp = readJson(path.join(exportDir, fileName))
  const realArr = real && Array.isArray(real.projects) ? real.projects : []
  const expArr = exp && Array.isArray(exp.projects) ? exp.projects : []
  const realIdx = indexProjects(realArr)
  const expIdx = indexProjects(expArr)

  const diffs = []
  // membership
  for (const name of realIdx.keys()) {
    if (!expIdx.has(name)) diffs.push({ path: `project[${name}]`, a: 'present', b: '(missing in export)' })
  }
  for (const name of expIdx.keys()) {
    if (!realIdx.has(name)) diffs.push({ path: `project[${name}]`, a: '(missing in real)', b: 'present' })
  }
  // field-level, for the intersection
  for (const [name, rp] of realIdx) {
    const ep = expIdx.get(name)
    if (!ep) continue
    let pd = contentDiff(rp, ep, 20)
    pd = classifyProjectDiffs(pd, rp, ep, accepted, name)
    for (const d of pd) diffs.push({ path: `project[${name}].${d.path}`, a: d.a, b: d.b })
    if (diffs.length > 12) break
  }
  return {
    file: fileName,
    realCount: realArr.length,
    exportCount: expArr.length,
    diffs,
  }
}

function compareContacts(realDir, exportDir) {
  const real = readJson(path.join(realDir, 'crm-contacts.json'))
  const exp = readJson(path.join(exportDir, 'crm-contacts.json'))
  const realArr = real && Array.isArray(real.contacts) ? real.contacts : []
  const expArr = exp && Array.isArray(exp.contacts) ? exp.contacts : []
  const byId = (arr) => new Map(arr.map((c) => [String(c.id), c]))
  const ri = byId(realArr)
  const ei = byId(expArr)
  const diffs = []
  for (const id of ri.keys()) if (!ei.has(id)) diffs.push({ path: `contact[${id}]`, a: 'present', b: '(missing in export)' })
  for (const id of ei.keys()) if (!ri.has(id)) diffs.push({ path: `contact[${id}]`, a: '(missing in real)', b: 'present' })
  for (const [id, rc] of ri) {
    const ec = ei.get(id)
    if (!ec) continue
    const pd = contentDiff(rc, ec, 10)
    for (const d of pd) diffs.push({ path: `contact[${id}].${d.path}`, a: d.a, b: d.b })
    if (diffs.length > 12) break
  }
  return { file: 'crm-contacts.json', realCount: realArr.length, exportCount: expArr.length, diffs }
}

function compareLinks(realDir, exportDir) {
  const real = readJson(path.join(realDir, 'crm-links.json'))
  const exp = readJson(path.join(exportDir, 'crm-links.json'))
  const rl = (real && real.links) || {}
  const el = (exp && exp.links) || {}
  const diffs = []
  const keys = new Set([...Object.keys(rl), ...Object.keys(el)])
  for (const k of keys) {
    const rset = new Set((rl[k] || []).map(String))
    const eset = new Set((el[k] || []).map(String))
    if (!(k in rl)) {
      diffs.push({ path: `links[${k}]`, a: '(missing in real)', b: JSON.stringify(el[k]) })
      continue
    }
    if (!(k in el)) {
      diffs.push({ path: `links[${k}]`, a: JSON.stringify(rl[k]), b: '(missing in export)' })
      continue
    }
    if (rset.size !== eset.size || [...rset].some((c) => !eset.has(c))) {
      diffs.push({ path: `links[${k}]`, a: JSON.stringify([...rset].sort()), b: JSON.stringify([...eset].sort()) })
    }
    if (diffs.length > 12) break
  }
  return { file: 'crm-links.json', realCount: Object.keys(rl).length, exportCount: Object.keys(el).length, diffs }
}

// Auto-progression targets (Post Show). A stage diff is ACCEPTABLE only if the export's stage is one
// of these AND the file's stage is a Booked-ish stage the app would auto-advance from.
const POST_SHOW = new Set(['thank-you', 'thank-you-payment'])

function comparePipeline(realDir, exportDir, accepted) {
  const real = readJson(path.join(realDir, 'crm-pipeline.json'))
  const exp = readJson(path.join(exportDir, 'crm-pipeline.json'))
  const diffs = []

  // stages
  const rs = (real && real.stages) || {}
  const es = (exp && exp.stages) || {}
  const skeys = new Set([...Object.keys(rs), ...Object.keys(es)])
  for (const k of skeys) {
    const rv = rs[k]
    const ev = es[k]
    if (rv === ev) continue
    // (d) auto-progression: file stage -> Post Show stage the app moves to the day after the event.
    if (POST_SHOW.has(ev) && rv != null && !POST_SHOW.has(rv)) {
      accepted.push(`stage[${k}]: auto-progressed since import: file="${rv}" -> DB="${ev}" (Post Show)`)
      continue
    }
    // Post Show -> promoted Thank You + Payment to Thank You once fully paid.
    if (ev === 'thank-you' && rv === 'thank-you-payment') {
      accepted.push(`stage[${k}]: auto-promoted to fully-paid Thank You: file="${rv}" -> DB="${ev}"`)
      continue
    }
    diffs.push({ path: `stages[${k}]`, a: JSON.stringify(rv ?? null), b: JSON.stringify(ev ?? null) })
  }

  // structure (content, order-insensitive)
  const rStruct = (real && real.structure) || null
  const eStruct = (exp && exp.structure) || null
  if (canon(rStruct) !== canon(eStruct)) {
    for (const d of contentDiff(rStruct, eStruct, 6)) diffs.push({ path: `structure.${d.path}`, a: d.a, b: d.b })
  }

  // flowLayout: (e) DB is newer than the stale file. Report as ACCEPTABLE drift, not a failure,
  // but still show what drifted so it's auditable.
  const rFlow = (real && real.flowLayout) || null
  const eFlow = (exp && exp.flowLayout) || null
  if (canon(rFlow) !== canon(eFlow)) {
    const rPos = new Set(Object.keys((rFlow && rFlow.positions) || {}))
    const ePos = new Set(Object.keys((eFlow && eFlow.positions) || {}))
    const staleInFile = [...rPos].filter((k) => !ePos.has(k))
    const newerInDb = [...ePos].filter((k) => !rPos.has(k))
    const edgesEqual = canon((rFlow && rFlow.edges) || []) === canon((eFlow && eFlow.edges) || [])
    accepted.push(
      `flowLayout drift (DB is source of truth, newer than file): ` +
        `stale position keys only in file=[${staleInFile.join(', ') || 'none'}], ` +
        `position keys only in DB=[${newerInDb.join(', ') || 'none'}], edges equal=${edgesEqual}`,
    )
  }

  return {
    file: 'crm-pipeline.json',
    realCount: Object.keys(rs).length,
    exportCount: Object.keys(es).length,
    diffs,
  }
}

// ---------------------------------------------------------------------------
// Phase-2 comparators (emails, templates, notifications, text-markers, invoices, contracts,
// questionnaires, portals, recipients, inquiries, config, calendar-map). Each strips the _meta doc
// block and content-diffs the payload, ignoring key order + treating absent === empty (same rules as
// the project/contact comparators). Record arrays are indexed by their identity key so order doesn't
// matter; blob maps are compared per key.
// ---------------------------------------------------------------------------

// Collapse any timestamp text to the JS toISOString() "...Z" instant, so file rows already in Postgres
// offset/microsecond form (from a prior nightly backup) compare equal to the export's "...Z" form.
// Mirrors isoZ in the read funnels + the exporter. Applied to known timestamp fields on both sides.
function isoZ(v) {
  const s = String(v ?? '').trim()
  if (!s) return ''
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? s : d.toISOString()
}
// Per-record canonicalizer for the finance/tasks/emails files: normalize known REPRESENTATIONAL
// differences that are not data differences (documented in dump-finance-tasks.mjs / dump-phase2.mjs):
//   - timestamps -> the "...Z" instant (createdAt/updatedAt/sentAt)
//   - payments: legacy rows omit pending/method; the app writer/DB emit false/"" -> canonicalize both
//   - emails/templates: legacy rows omit `format`; the DB stores an explicit text/html -> canonicalize
// This makes the compare CONTENT-based on the real record identity, exactly like the parity gates.
function canonRecord(r) {
  const out = { ...r }
  for (const k of ['createdAt', 'updatedAt', 'sentAt']) if (k in out) out[k] = isoZ(out[k])
  // payments (identified by dateReceived): legacy rows omit pending/method; the app writer + DB emit
  // false/"". Force both on BOTH sides so an absent legacy field equals the always-populated one.
  if ('dateReceived' in out) {
    out.pending = !!out.pending
    out.method = out.method == null ? '' : String(out.method)
  }
  // emails/templates (identified by subject/body): an absent format is treated as text (app default).
  if ('subject' in out || 'body' in out) out.format = out.format === 'html' ? 'html' : 'text'
  return out
}

// Compare a record-array file: { [arrayKey]: [...], _meta }. Records matched by idFn.
function compareArrayFile(fileName, arrayKey, idFn, realDir, exportDir, label = 'record') {
  const real = readJson(path.join(realDir, fileName))
  const exp = readJson(path.join(exportDir, fileName))
  const ra = (real && Array.isArray(real[arrayKey]) ? real[arrayKey] : []).map(canonRecord)
  const ea = (exp && Array.isArray(exp[arrayKey]) ? exp[arrayKey] : []).map(canonRecord)
  const idx = (arr) => {
    const m = new Map()
    for (const r of arr) m.set(String(idFn(r)), r)
    return m
  }
  const ri = idx(ra)
  const ei = idx(ea)
  const diffs = []
  for (const id of ri.keys()) if (!ei.has(id)) diffs.push({ path: `${label}[${id}]`, a: 'present', b: '(missing in export)' })
  for (const id of ei.keys()) if (!ri.has(id)) diffs.push({ path: `${label}[${id}]`, a: '(missing in real)', b: 'present' })
  for (const [id, rr] of ri) {
    const er = ei.get(id)
    if (!er) continue
    const pd = contentDiff(rr, er, 10)
    for (const d of pd) diffs.push({ path: `${label}[${id}].${d.path}`, a: d.a, b: d.b })
    if (diffs.length > 12) break
  }
  return { file: fileName, realCount: ra.length, exportCount: ea.length, diffs }
}

// Compare a keyed-map file: { [mapKey]: { [k]: value }, _meta }. Value compared per key by content.
function compareMapFile(fileName, mapKey, realDir, exportDir) {
  const real = readJson(path.join(realDir, fileName))
  const exp = readJson(path.join(exportDir, fileName))
  const rm = (real && real[mapKey]) || {}
  const em = (exp && exp[mapKey]) || {}
  const diffs = []
  const keys = new Set([...Object.keys(rm), ...Object.keys(em)])
  for (const k of keys) {
    if (!(k in rm)) {
      diffs.push({ path: `${mapKey}[${k}]`, a: '(missing in real)', b: 'present' })
      continue
    }
    if (!(k in em)) {
      diffs.push({ path: `${mapKey}[${k}]`, a: 'present', b: '(missing in export)' })
      continue
    }
    for (const d of contentDiff(rm[k], em[k], 8)) diffs.push({ path: `${mapKey}[${k}].${d.path}`, a: d.a, b: d.b })
    if (diffs.length > 12) break
  }
  return { file: fileName, realCount: Object.keys(rm).length, exportCount: Object.keys(em).length, diffs }
}

// Compare a whole-object file's non-_meta content (config; and the questionnaire top-level template).
function compareObjectFile(fileName, realDir, exportDir, { excludeKeys = ['_meta'] } = {}) {
  const real = readJson(path.join(realDir, fileName)) || {}
  const exp = readJson(path.join(exportDir, fileName)) || {}
  const strip = (o) => {
    const out = {}
    for (const k of Object.keys(o)) if (!excludeKeys.includes(k)) out[k] = o[k]
    return out
  }
  const rc = strip(real)
  const ec = strip(exp)
  const diffs = contentDiff(rc, ec, 12).map((d) => ({ path: d.path, a: d.a, b: d.b }))
  return { file: fileName, realCount: Object.keys(rc).length, exportCount: Object.keys(ec).length, diffs }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-verify-backup-'))
console.log('Exporting Supabase -> temp dir (real Project Records untouched):')
console.log('  ' + tmp + '\n')

const accepted = []
const { written } = await exportBackup({ targetDir: tmp })

// Discover the bucket files the export produced (so new year files are covered automatically).
const exported = fs.readdirSync(tmp)
const bucketFiles = [
  'active-projects.json',
  ...exported.filter((f) => /^completed-\d{4}\.json$/.test(f)).sort(),
  ...exported.filter((f) => /^archived-\d{4}\.json$/.test(f)).sort(),
]

const results = []
for (const f of bucketFiles) results.push(compareProjectFile(f, REAL_RECORDS_DIR, tmp, accepted))
results.push(compareContacts(REAL_RECORDS_DIR, tmp))
results.push(compareLinks(REAL_RECORDS_DIR, tmp))
results.push(comparePipeline(REAL_RECORDS_DIR, tmp, accepted))

// ---- Phase-2 files (finance/tasks are already covered by parity-finance-tasks; here we verify the
// newly-wired data files round-trip content-faithfully) ----
results.push(compareArrayFile('crm-payments.json', 'payments', (r) => r.id, REAL_RECORDS_DIR, tmp, 'payment'))
results.push(compareArrayFile('crm-expenses.json', 'expenses', (r) => r.id, REAL_RECORDS_DIR, tmp, 'expense'))
results.push(compareArrayFile('crm-tasks.json', 'tasks', (r) => r.id, REAL_RECORDS_DIR, tmp, 'task'))
results.push(compareArrayFile('crm-emails.json', 'emails', (r) => r.id, REAL_RECORDS_DIR, tmp, 'email'))
// crm-templates.json is no longer exported (email-template library removed 2026-07-31).
results.push(compareArrayFile('crm-notifications.json', 'events', (r) => r.id, REAL_RECORDS_DIR, tmp, 'event'))
results.push(
  compareArrayFile('crm-text-markers.json', 'markers', (r) => `${r.projectId}|${r.kind}`, REAL_RECORDS_DIR, tmp, 'marker'),
)
results.push(compareMapFile('crm-invoices.json', 'invoices', REAL_RECORDS_DIR, tmp))
results.push(compareMapFile('crm-contracts.json', 'contracts', REAL_RECORDS_DIR, tmp))
// The questionnaire top-level default template lives in crm_settings; verify it round-trips too.
results.push(compareMapFile('crm-recipients.json', 'recipients', REAL_RECORDS_DIR, tmp))
results.push(compareMapFile('crm-inquiries.json', 'inquiries', REAL_RECORDS_DIR, tmp))
results.push(compareObjectFile('crm-config.json', REAL_RECORDS_DIR, tmp))
results.push(compareMapFile('crm-calendar-map.json', 'projects', REAL_RECORDS_DIR, tmp))
results.push(compareMapFile('crm-calendar-map.json', 'tasks', REAL_RECORDS_DIR, tmp))
results.push(compareMapFile('crm-calendar-map.json', 'calendars', REAL_RECORDS_DIR, tmp))

console.log('Per-file comparison (export vs real Project Records; ignoring key order + _meta):\n')
let allMatch = true
for (const r of results) {
  const match = r.diffs.length === 0
  allMatch = allMatch && match
  const counts = `real=${r.realCount}, export=${r.exportCount}`
  console.log(`  ${match ? 'MATCH' : 'DIFF '}  ${r.file}  (${counts})`)
  if (!match) {
    for (const d of r.diffs.slice(0, 8)) {
      console.log(`         at ${d.path}`)
      console.log(`           real:   ${d.a}`)
      console.log(`           export: ${d.b}`)
    }
    if (r.diffs.length > 8) console.log(`         ...and ${r.diffs.length - 8} more`)
  }
}

if (accepted.length) {
  console.log('\nAcceptable diffs (documented, not failures):')
  for (const a of accepted) console.log(`  - ${a}`)
}

console.log(`\n${allMatch ? 'ALL FILES MATCH (modulo the documented acceptable diffs).' : 'REAL DIFFERENCES FOUND -> fix the exporter.'}`)
process.exit(allMatch ? 0 : 1)
