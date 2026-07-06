// WRITE-path round-trip for the FINANCE (payments) + TASKS Supabase funnels, plus proof the payment
// gate reads payments from the store cache after payments moved off crm-payments.json.
//
// Flow: create a throwaway project -> a Booked-stage move THROWS (no payment) -> add a throwaway
// payment for it -> refresh -> the Booked-stage move now SUCCEEDS (gate reads the new payment from the
// cache) -> add/update/delete a throwaway task -> delete the payment + project. Every assertion reads
// back FROM SUPABASE (initStore({force:true}) between mutation and check), so a passing step proves
// the value was persisted to the DB, not merely left in the in-memory cache.
//
// SAFETY: operates ONLY on throwaway rows whose ids/names are prefixed "zz-test-". A finally block
// purges every zz-test- row from projects/payments/tasks (and any test contact_links cascade), and
// the last check asserts none remain.
//
// Run with Node 22:
//   CRM_STORE=supabase /Users/michaelbloemeke/.local/node22/bin/node supabase/write-roundtrip-finance-tasks.mjs

import { CRM_STORE, initStore, sb } from '../crm-store.mjs'
import {
  createProject,
  updateProjectField,
  setStage,
  deleteProject,
  loadAll,
  loadTasks,
  addTask,
  updateTask,
  deleteTask,
} from '../crm-data-core.mjs'
import { loadPayments, addPayment, updatePayment, deletePayment } from '../crm-finance.mjs'

if (CRM_STORE !== 'supabase') {
  console.error('This test must run under CRM_STORE=supabase. Aborting to protect the files backend.')
  process.exit(1)
}

const STAMP = Date.now()
const PNAME = `zz-test-fin ${STAMP}` // slug -> zz-test-fin-<stamp>
let PID = null
let PAYID = null
let TASKID = null

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
function findProject(id) {
  return loadAll().projects.find((p) => p.id === id)
}
async function expectThrows(step, fn, matchSubstr) {
  try {
    await fn()
    ok(step, false, 'did NOT throw')
  } catch (e) {
    const msg = String(e?.message || e)
    ok(step, matchSubstr ? msg.includes(matchSubstr) : true, `threw: "${msg.slice(0, 70)}..."`)
  }
}

async function purgeTestRows() {
  const { data: pays } = await sb().from('payments').select('id').like('project_id', 'zz-test-%')
  for (const p of pays || []) await sb().from('payments').delete().eq('id', p.id)
  const { data: tks } = await sb().from('tasks').select('id').like('project_id', 'zz-test-%')
  for (const t of tks || []) await sb().from('tasks').delete().eq('id', t.id)
  const { data: projs } = await sb().from('projects').select('id').like('id', 'zz-test-%')
  for (const p of projs || []) await sb().from('projects').delete().eq('id', p.id)
}

async function main() {
  await initStore()
  console.log(`\nFinance + tasks write round-trip (CRM_STORE=supabase). Stamp: ${STAMP}`)
  console.log(`Test project: "${PNAME}"\n`)

  // 0. Throwaway project with a fee, at a non-gated stage.
  const created = await createProject({ clientName: PNAME })
  PID = created.id
  ok('0. createProject id is zz-test-', PID.startsWith('zz-test-'), PID)
  await updateProjectField({ id: PID, field: 'totalFee', value: '500' })
  await setStage(PID, 'in-communication')
  await refresh()
  ok('0. project staged in-communication', findProject(PID)?.stageId === 'in-communication')

  // 1. Payment gate BEFORE any payment: a Booked-stage move must THROW.
  await expectThrows('1. Booked move throws with no payment', () => setStage(PID, 'deposit-sent'), 'received payment')

  // 2. addPayment -> persists to Supabase + reads back via loadPayments.
  const payment = await addPayment({ projectId: PID, amount: 250, dateReceived: '2026-07-01', type: 'deposit', method: 'Cash' })
  PAYID = payment.id
  await refresh()
  {
    const p = loadPayments().find((x) => x.id === PAYID)
    ok('2. addPayment persisted + reads back', !!p && p.projectId === PID && p.amount === 250 && p.dateReceived === '2026-07-01', p ? `amount=${p.amount} date=${p.dateReceived} method=${p.method}` : 'not found')
  }

  // 3. PAYMENT GATE now FIRES POSITIVELY: with a received payment on file, the Booked move SUCCEEDS.
  //    This proves the gate reads payments from the store cache (not the stale crm-payments.json).
  await setStage(PID, 'deposit-sent')
  await refresh()
  ok('3. Booked move succeeds after received payment (gate reads cache)', findProject(PID)?.stageId === 'deposit-sent', `stage=${findProject(PID)?.stageId}`)

  // 4. updatePayment -> change persists.
  await updatePayment({ id: PAYID, amount: 300, note: 'zz-test-note' })
  await refresh()
  {
    const p = loadPayments().find((x) => x.id === PAYID)
    ok('4. updatePayment persisted', !!p && p.amount === 300 && p.note === 'zz-test-note', p ? `amount=${p.amount} note=${p.note}` : 'not found')
  }

  // 5. addTask -> persists + reads back via loadTasks.
  const task = await addTask({ projectId: PID, title: 'zz-test-task', dueDate: '2026-07-10', dueTime: '15:00' })
  TASKID = task.id
  await refresh()
  {
    const t = loadTasks().find((x) => x.id === TASKID)
    ok('5. addTask persisted + reads back', !!t && t.title === 'zz-test-task' && t.dueDate === '2026-07-10' && t.dueTime === '15:00' && t.done === false, t ? `title=${t.title} due=${t.dueDate} time=${t.dueTime} done=${t.done}` : 'not found')
  }

  // 6. updateTask -> mark done + retitle persists.
  await updateTask({ id: TASKID, done: true, title: 'zz-test-task-done' })
  await refresh()
  {
    const t = loadTasks().find((x) => x.id === TASKID)
    ok('6. updateTask persisted', !!t && t.done === true && t.title === 'zz-test-task-done', t ? `done=${t.done} title=${t.title}` : 'not found')
  }

  // 7. deleteTask -> gone.
  await deleteTask(TASKID)
  await refresh()
  ok('7. deleteTask gone', !loadTasks().some((x) => x.id === TASKID))
  TASKID = null

  // 8. deletePayment -> gone.
  await deletePayment(PAYID)
  await refresh()
  ok('8. deletePayment gone', !loadPayments().some((x) => x.id === PAYID))
  PAYID = null

  // 9. deleteProject -> gone (its tasks/payments already removed; also proves purge paths run clean).
  await deleteProject({ id: PID })
  await refresh()
  ok('9. deleteProject gone', !findProject(PID))
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
  const { data: rp } = await sb().from('projects').select('id').like('id', 'zz-test-%')
  const { data: rpay } = await sb().from('payments').select('id').like('project_id', 'zz-test-%')
  const { data: rt } = await sb().from('tasks').select('id').like('project_id', 'zz-test-%')
  const clean = (rp || []).length === 0 && (rpay || []).length === 0 && (rt || []).length === 0
  ok('10. no zz-test- rows remain (projects/payments/tasks)', clean, `projects=${(rp || []).length} payments=${(rpay || []).length} tasks=${(rt || []).length}`)

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}  (${pass} passed, ${fail} failed)`)
  exitCode = fail === 0 ? 0 : 1
}
process.exit(exitCode)
