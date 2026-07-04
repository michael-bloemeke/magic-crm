// WRITE-path round-trip test for the Supabase backend. Exercises every write funnel end to end
// (create -> edit -> stage -> gates -> contacts/links -> archive -> delete) and asserts each outcome
// by reading it back FROM SUPABASE (initStore({force:true}) between mutation and assert, so a passing
// step proves the value was persisted to the DB, not merely left in the in-memory cache).
//
// SAFETY: operates ONLY on throwaway records whose ids/names are prefixed "zz-test-". It never
// touches the 120 real projects or 119 real contacts. A finally block purges every zz-test- row from
// projects/contacts/contact_links at the end, and the last check asserts none remain.
//
// Run with Node 22:  CRM_STORE=supabase /Users/michaelbloemeke/.local/node22/bin/node supabase/write-roundtrip.mjs

import { CRM_STORE, initStore, sb } from '../crm-store.mjs'
import {
  createProject,
  updateProjectField,
  setStage,
  completeProject,
  archiveProject,
  deleteProject,
  loadAll,
} from '../crm-data-core.mjs'
import { addContact, deleteContact, loadContacts } from '../crm-contacts.mjs'
import { linkContact, unlinkContact, setProjectContacts, loadLinks } from '../crm-links.mjs'

if (CRM_STORE !== 'supabase') {
  console.error('This test must run under CRM_STORE=supabase. Aborting to protect the files backend.')
  process.exit(1)
}

const STAMP = Date.now()
const PNAME = `zz-test-roundtrip ${STAMP}` // slug -> zz-test-roundtrip-<stamp>
const CNAME = `zz-test-contact ${STAMP}`
let PID = null // filled after create
let CID = null // filled after addContact

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
// Re-pull the cache from Supabase, then read the app's funnels (they serve from that fresh snapshot).
async function refresh() {
  await initStore({ force: true })
}
function findProject(id) {
  return loadAll().projects.find((p) => p.id === id)
}
async function expectThrows(step, fn, matchSubstr) {
  try {
    await fn()
    ok(step, false, 'did NOT throw')
  } catch (e) {
    const msg = String(e?.message || e)
    ok(step, matchSubstr ? msg.includes(matchSubstr) : true, matchSubstr ? `threw: "${msg.slice(0, 70)}..."` : msg.slice(0, 70))
  }
}

async function purgeTestRows() {
  // Delete every zz-test- project (contact_links cascade) and every zz-test- contact.
  const { data: projs } = await sb().from('projects').select('id').like('id', 'zz-test-%')
  for (const p of projs || []) await sb().from('projects').delete().eq('id', p.id)
  const { data: cons } = await sb().from('contacts').select('id, name').ilike('name', 'zz-test-%')
  for (const c of cons || []) await sb().from('contacts').delete().eq('id', c.id)
}

async function main() {
  await initStore()
  console.log(`\nWrite round-trip (CRM_STORE=supabase). Test stamp: ${STAMP}`)
  console.log(`Test project name: "${PNAME}"  |  test contact name: "${CNAME}"\n`)

  // 1. createProject -> appears in loadAll at stage 'inquiry'.
  const created = await createProject({ clientName: PNAME })
  PID = created.id
  ok('1. createProject id is zz-test-', PID.startsWith('zz-test-'), PID)
  await refresh()
  {
    const p = findProject(PID)
    ok('1. createProject persisted + stage=inquiry', !!p && p.stageId === 'inquiry' && p.bucket === 'active', p ? `stage=${p.stageId}` : 'not found')
  }

  // 2. updateProjectField -> persists + reflected.
  await updateProjectField({ id: PID, field: 'eventLocation', value: 'zz-test-venue' })
  await refresh()
  {
    const p = findProject(PID)
    ok('2. updateProjectField persisted', !!p && p.eventLocation === 'zz-test-venue', p ? `eventLocation=${p.eventLocation}` : 'not found')
  }

  // 3. setStage to a non-gated middle stage -> persists.
  await setStage(PID, 'in-communication')
  await refresh()
  {
    const p = findProject(PID)
    ok('3. setStage (middle, non-gated) persisted', !!p && p.stageId === 'in-communication', p ? `stage=${p.stageId}` : 'not found')
  }

  // 4a. setStage into a Booked stage WITHOUT a payment -> THROWS (payment gate).
  await expectThrows('4a. setStage Booked w/o payment throws', () => setStage(PID, 'deposit-sent'), 'received payment')
  // 4b. setStage into a Post Show stage -> THROWS (auto-only).
  await expectThrows('4b. setStage Post Show throws (auto-only)', () => setStage(PID, 'thank-you'), 'automatically')
  await refresh()
  {
    // Neither gated move should have taken effect.
    const p = findProject(PID)
    ok('4c. stage unchanged after gated attempts', !!p && p.stageId === 'in-communication', p ? `stage=${p.stageId}` : 'not found')
  }

  // 5. completeProject with a fee set but no payments -> THROWS (not paid in full).
  await updateProjectField({ id: PID, field: 'totalFee', value: '500' })
  await refresh()
  await expectThrows('5. completeProject unpaid throws', () => completeProject({ id: PID }), 'outstanding')

  // 6. Contacts + links.
  const contact = await addContact({ name: CNAME, emails: ['zz-test@example.com'], type: 'client', relationship: 'active' })
  CID = contact.id
  await refresh()
  ok('6a. addContact persisted', loadContacts().some((c) => c.id === CID && c.name === CNAME))

  await linkContact(PID, CID)
  await refresh()
  ok('6b. linkContact reflected in loadLinks', (loadLinks()[PID] || []).includes(CID))

  await unlinkContact(PID, CID)
  await refresh()
  ok('6c. unlinkContact reflected in loadLinks', !(loadLinks()[PID] || []).includes(CID))

  await setProjectContacts(PID, [CID])
  await refresh()
  {
    const arr = loadLinks()[PID] || []
    ok('6d. setProjectContacts replaces set', arr.length === 1 && arr[0] === CID, `links=[${arr.join(',')}]`)
  }

  // 7. archiveProject -> bucket=archived, activity_log entry added, stage cleared.
  await archiveProject({ id: PID, reason: 'zz-test-reason' })
  await refresh()
  {
    const p = findProject(PID)
    const hasEntry = !!p && p.activityLog.some((e) => e.includes('archived') && e.includes('zz-test-reason'))
    ok('7. archiveProject: bucket=archived, log entry, stage cleared', !!p && p.bucket === 'archived' && p.stageId === '' && hasEntry, p ? `bucket=${p.bucket} stage="${p.stageId}" logEntry=${hasEntry}` : 'not found')
  }

  // 8a. deleteProject -> gone from loadAll; its contact_links gone (cascade).
  await deleteProject({ id: PID })
  await refresh()
  {
    const gone = !findProject(PID)
    const noLinks = !(PID in loadLinks())
    // Verify the cascade directly against the DB too.
    const { data: leftoverLinks } = await sb().from('contact_links').select('project_id').eq('project_id', PID)
    ok('8a. deleteProject gone + contact_links cascaded', gone && noLinks && (leftoverLinks || []).length === 0, `gone=${gone} noLinks=${noLinks} dbLinks=${(leftoverLinks || []).length}`)
  }

  // 8b. deleteContact -> gone.
  await deleteContact(CID)
  await refresh()
  ok('8b. deleteContact gone', !loadContacts().some((c) => c.id === CID))
}

let exitCode = 0
try {
  await main()
} catch (e) {
  console.error('\nUNEXPECTED ERROR (test aborted):', e?.message || e)
  fail++
} finally {
  // Always clean up, whatever happened above.
  try {
    await purgeTestRows()
  } catch (e) {
    console.error('cleanup failed:', e?.message || e)
  }
  // Final safety assertion: no zz-test- rows remain anywhere.
  const { data: rp } = await sb().from('projects').select('id').like('id', 'zz-test-%')
  const { data: rc } = await sb().from('contacts').select('id').ilike('name', 'zz-test-%')
  const { data: rl } = await sb().from('contact_links').select('project_id').like('project_id', 'zz-test-%')
  const clean = (rp || []).length === 0 && (rc || []).length === 0 && (rl || []).length === 0
  ok('9. no zz-test- rows remain (projects/contacts/contact_links)', clean, `projects=${(rp || []).length} contacts=${(rc || []).length} links=${(rl || []).length}`)

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}  (${pass} passed, ${fail} failed)`)
  exitCode = fail === 0 ? 0 : 1
}
process.exit(exitCode)
