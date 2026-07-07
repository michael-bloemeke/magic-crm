// Headless proof that the DESKTOP app's server-side cache auto-refreshes from Supabase WITHOUT a
// restart. This is the server half of "make the desktop app auto-reflect external data changes":
// crm-data-plugin.mjs primes an in-memory cache once at startup and then re-primes it every ~15s via
// initStore({ force: true }). This test proves an edit made DIRECTLY in Supabase (as the phone / Cowork
// / Claude Code would) shows up on /api/projects within that window, with the server never restarted.
//
//   /Users/michaelbloemeke/.local/node22/bin/node supabase/verify-live-refresh.mjs
//
// Steps:
//   1. Boot the Vite dev server on a spare port with CRM_STORE=supabase; wait until it responds.
//   2. GET /api/projects; note a real project's current projectNotes (the baseline the cache holds).
//   3. PATCH that same project's project_notes DIRECTLY in Supabase via PostgREST (secret key), to a
//      unique sentinel value the running server has never seen.
//   4. Poll GET /api/projects for up to ~25s WITHOUT restarting; PASS when the sentinel appears (the
//      cache auto-refreshed). FAIL if it never does.
//   5. Restore the original project_notes in Supabase and kill the server. Print PASS/FAIL.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(DIR) // magic-crm/
const NODE = '/Users/michaelbloemeke/.local/node22/bin/node'
const PORT = 5213
const BASE = `http://localhost:${PORT}`

const creds = JSON.parse(fs.readFileSync(path.join(ROOT, 'supabase-credentials.json'), 'utf8'))
const SB = creds.url
const SECRET = creds.secretKey
const restH = () => ({ apikey: SECRET, Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// --- direct-to-Supabase helpers (secret key; mimics an external editor) ---
async function sbSelect(query) {
  const r = await fetch(`${SB}/rest/v1/${query}`, { headers: restH() })
  return r.ok ? r.json() : []
}
async function sbPatch(query, row) {
  const r = await fetch(`${SB}/rest/v1/${query}`, {
    method: 'PATCH',
    headers: { ...restH(), Prefer: 'return=representation' },
    body: JSON.stringify(row),
  })
  return { ok: r.ok, status: r.status, body: r.ok ? await r.json() : await r.text() }
}

// --- server API ---
async function apiProjectNotes(id) {
  const r = await fetch(`${BASE}/api/projects`)
  if (!r.ok) throw new Error(`GET /api/projects -> ${r.status}`)
  const data = await r.json()
  const proj = (data.projects || []).find((p) => p.id === id)
  return proj ? proj.projectNotes : undefined
}

async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/projects`)
      if (r.ok) return true
    } catch {
      /* not up yet */
    }
    await sleep(500)
  }
  return false
}

let server = null
function killServer() {
  if (server && !server.killed) {
    try {
      process.kill(-server.pid, 'SIGTERM') // kill the whole process group (vite + children)
    } catch {
      try { server.kill('SIGTERM') } catch { /* already gone */ }
    }
  }
}

async function main() {
  console.log('== Magic CRM desktop live-refresh verification (server-side cache) ==\n')

  // 1. Boot the dev server on a spare port with the Supabase store.
  console.log(`1. Booting dev server on :${PORT} with CRM_STORE=supabase ...`)
  server = spawn(NODE, ['node_modules/vite/bin/vite.js', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    env: { ...process.env, CRM_STORE: 'supabase' },
    detached: true, // own process group so we can kill vite + its children on exit
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stdout.on('data', () => {})
  server.stderr.on('data', (d) => {
    const s = String(d)
    if (/error|EADDRINUSE/i.test(s)) console.error('  [server]', s.trim().slice(0, 200))
  })

  const up = await waitForServer(40_000)
  if (!up) {
    console.error('FAIL: dev server did not come up on :' + PORT)
    killServer()
    process.exit(1)
  }
  console.log('   server is up.\n')

  let restored = false
  let projectId = null
  let original = null

  try {
    // 2. Pick a real project and note the value the cache is currently serving.
    const rows = await sbSelect('projects?select=id,project_notes&order=id.asc&limit=1')
    if (!rows.length) throw new Error('no projects found in Supabase')
    projectId = rows[0].id
    original = rows[0].project_notes ?? ''
    const apiBefore = await apiProjectNotes(projectId)
    console.log(`2. Test project: ${projectId}`)
    console.log(`   Supabase project_notes (baseline): ${JSON.stringify(String(original).slice(0, 60))}...`)
    console.log(`   /api/projects projectNotes (baseline): ${JSON.stringify(String(apiBefore).slice(0, 60))}...\n`)

    // 3. Change it DIRECTLY in Supabase (as the phone / Cowork / Claude Code would), to a sentinel.
    const sentinel = `zz-live-refresh sentinel ${new Date().toISOString()} :: ${original}`
    console.log('3. Patching project_notes DIRECTLY in Supabase (external edit) ...')
    const upd = await sbPatch(`projects?id=eq.${projectId}`, { project_notes: sentinel })
    if (!upd.ok) throw new Error(`Supabase PATCH failed (${upd.status}): ${String(upd.body).slice(0, 200)}`)
    console.log('   patched.\n')

    // 4. Poll the API (server NOT restarted) until the sentinel appears, up to ~25s (refresh is ~15s).
    console.log('4. Polling /api/projects (server NOT restarted) for the new value ...')
    const deadline = Date.now() + 25_000
    let appeared = false
    let sawValue = apiBefore
    while (Date.now() < deadline) {
      await sleep(1500)
      sawValue = await apiProjectNotes(projectId)
      const secs = Math.round((Date.now() - (deadline - 25_000)) / 1000)
      if (sawValue === sentinel) {
        console.log(`   sentinel appeared after ~${secs}s (cache auto-refreshed).\n`)
        appeared = true
        break
      }
      console.log(`   ...${secs}s: still baseline`)
    }

    // 5. Restore the original value in Supabase.
    console.log('5. Restoring original project_notes in Supabase ...')
    const rst = await sbPatch(`projects?id=eq.${projectId}`, { project_notes: original })
    restored = rst.ok
    console.log(`   ${restored ? 'restored.' : 'WARNING: restore failed (' + rst.status + ')'}\n`)

    console.log('== RESULT ==')
    if (appeared) {
      console.log('PASS: an external Supabase edit appeared on /api/projects WITHOUT restarting the server')
      console.log('      (the desktop app cache auto-refreshes on its ~15s timer).')
      killServer()
      process.exit(0)
    } else {
      console.log('FAIL: the external edit never appeared within the poll window; the cache did NOT refresh.')
      console.log(`      last value seen: ${JSON.stringify(String(sawValue).slice(0, 80))}`)
      killServer()
      process.exit(1)
    }
  } catch (e) {
    console.error('\nERROR:', e?.message || e)
    // Best-effort restore so we never leave the sentinel in the DB.
    if (!restored && projectId != null && original != null) {
      try {
        await sbPatch(`projects?id=eq.${projectId}`, { project_notes: original })
        console.error('(restored original project_notes after error)')
      } catch {
        console.error('(WARNING: could not restore original project_notes; value was:', JSON.stringify(original).slice(0, 120), ')')
      }
    }
    killServer()
    process.exit(1)
  }
}

// Make sure a stray Ctrl-C / crash still tears down the server.
process.on('SIGINT', () => { killServer(); process.exit(130) })
process.on('SIGTERM', () => { killServer(); process.exit(143) })

main().catch((e) => { console.error('FATAL:', e); killServer(); process.exit(1) })
