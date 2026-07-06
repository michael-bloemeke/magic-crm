// WRITE-path round-trip for representative PHASE-2 Supabase funnels: one record-array entity (emails)
// and two blob entities (portals + config). Each mutation is followed by initStore({force:true}) so
// the assertion reads FROM SUPABASE (a fresh cache snapshot), proving the value was persisted to the
// DB, not merely left in the in-memory cache.
//
// Flow:
//   emails   -> saveProjectEmail (create) -> read back -> saveProjectEmail (edit) -> deleteProjectEmail
//   portals  -> savePortal (create) -> read back -> savePortal (edit) -> row deleted directly (cleanup)
//   config   -> saveConfig sets a throwaway key -> read back -> restore original config exactly
//
// SAFETY: emails/portals operate ONLY on throwaway rows whose ids/project_ids are prefixed
// "zz-test-". A finally block purges every zz-test- email + portal row and asserts none remain. The
// config row (id=1) is the REAL config, so we snapshot its exact data first and RESTORE it byte-for-
// byte at the end (asserting the restore round-trips), leaving the live config untouched.
//
// Run with Node 22:
//   CRM_STORE=supabase /Users/michaelbloemeke/.local/node22/bin/node supabase/write-roundtrip-phase2.mjs

import { CRM_STORE, initStore, sb, getCachedCrmConfig } from '../crm-store.mjs'
import { loadEmails, saveProjectEmail, deleteProjectEmail } from '../crm-emails.mjs'
import { loadPortals, loadPortal, savePortal } from '../crm-portal.mjs'
import { loadConfig, saveConfig } from '../crm-finance.mjs'

if (CRM_STORE !== 'supabase') {
  console.error('This test must run under CRM_STORE=supabase. Aborting to protect the files backend.')
  process.exit(1)
}

const STAMP = Date.now()
const PROJ = `zz-test-p2-${STAMP}` // throwaway project id prefix
let EMAILID = null

let pass = 0
let fail = 0
function ok(step, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`  PASS  ${step}${detail ? `  (${detail})` : ''}`)
  } else {
    fail++
    console.log(`  FAIL  ${step}${detail ? `  (${detail})` : ''}`)
  }
}
async function refresh() {
  await initStore({ force: true })
}

async function purgeTestRows() {
  const { data: em } = await sb().from('emails').select('id').like('project_id', 'zz-test-%')
  for (const e of em || []) await sb().from('emails').delete().eq('id', e.id)
  const { data: po } = await sb().from('portals').select('project_id').like('project_id', 'zz-test-%')
  for (const p of po || []) await sb().from('portals').delete().eq('project_id', p.project_id)
}

async function main() {
  await initStore()
  console.log(`\nPhase-2 write round-trip (CRM_STORE=supabase). Stamp: ${STAMP}\n`)

  // ---- Emails (record-array entity) ----
  const created = await saveProjectEmail({
    projectId: PROJ,
    kind: 'thankyou',
    to: ['zz-test@example.com'],
    subject: 'zz-test-subject',
    body: 'zz-test-body',
    format: 'text',
  })
  EMAILID = created.id
  await refresh()
  {
    const e = loadEmails().find((x) => x.id === EMAILID)
    ok(
      '1. saveProjectEmail persisted + reads back',
      !!e && e.projectId === PROJ && e.subject === 'zz-test-subject' && e.status === 'draft',
      e ? `subject=${e.subject} status=${e.status}` : 'not found',
    )
  }

  await saveProjectEmail({ id: EMAILID, subject: 'zz-test-subject-edited', body: 'zz-test-body-2' })
  await refresh()
  {
    const e = loadEmails().find((x) => x.id === EMAILID)
    ok('2. saveProjectEmail edit persisted', !!e && e.subject === 'zz-test-subject-edited' && e.body === 'zz-test-body-2', e ? `subject=${e.subject}` : 'not found')
  }

  await deleteProjectEmail(EMAILID)
  await refresh()
  ok('3. deleteProjectEmail gone', !loadEmails().some((x) => x.id === EMAILID))
  EMAILID = null

  // ---- Portals (per-project jsonb blob entity) ----
  const p1 = await savePortal({ projectId: PROJ, patch: { message: 'zz-test-message', published: false } })
  await refresh()
  {
    const p = loadPortal(PROJ)
    ok(
      '4. savePortal persisted + reads back',
      !!p && p.message === 'zz-test-message' && !!p.token && p.published === false,
      p ? `message=${p.message} published=${p.published}` : 'not found',
    )
  }
  const tokenAfterCreate = p1.token

  await savePortal({ projectId: PROJ, patch: { message: 'zz-test-message-edited' } })
  await refresh()
  {
    const p = loadPortal(PROJ)
    ok(
      '5. savePortal edit persisted (token stable)',
      !!p && p.message === 'zz-test-message-edited' && p.token === tokenAfterCreate,
      p ? `message=${p.message} tokenStable=${p.token === tokenAfterCreate}` : 'not found',
    )
    ok('5b. portal appears in loadPortals map', !!loadPortals()[PROJ])
  }

  // ---- Config (single id=1 blob; REAL row -> snapshot + restore) ----
  const beforeConfigData = JSON.parse(JSON.stringify(getCachedCrmConfig() || {}))
  const beforeLoad = JSON.parse(JSON.stringify(loadConfig()))
  const marker = `zz-test-${STAMP}`
  await saveConfig({ contractTemplate: marker })
  await refresh()
  {
    const c = loadConfig()
    ok('6. saveConfig persisted', c.contractTemplate === marker, `contractTemplate=${String(c.contractTemplate).slice(0, 24)}`)
  }
  // Restore the config data payload EXACTLY as it was (writes id=1 back to the original jsonb).
  await sb().from('crm_config').upsert({ id: 1, data: beforeConfigData }, { onConflict: 'id' })
  await refresh()
  {
    const after = loadConfig()
    ok(
      '7. config restored byte-for-byte',
      JSON.stringify(after) === JSON.stringify(beforeLoad),
      `contractTemplate=${String(after.contractTemplate).slice(0, 24)}`,
    )
  }
}

let exitCode = 0
try {
  await main()
} catch (e) {
  console.error('\nUNEXPECTED ERROR (test aborted):', e?.message || e)
  fail++
} finally {
  try {
    await purgeTestRows()
  } catch (e) {
    console.error('cleanup failed:', e?.message || e)
  }
  const { data: rem } = await sb().from('emails').select('id').like('project_id', 'zz-test-%')
  const { data: rpo } = await sb().from('portals').select('project_id').like('project_id', 'zz-test-%')
  const clean = (rem || []).length === 0 && (rpo || []).length === 0
  ok('8. no zz-test- rows remain (emails/portals)', clean, `emails=${(rem || []).length} portals=${(rpo || []).length}`)

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}  (${pass} passed, ${fail} failed)`)
  exitCode = fail === 0 ? 0 : 1
}
process.exit(exitCode)
