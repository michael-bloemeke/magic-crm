// Headless proof that the phone app's WRITE path (Stage C) works AND that the client-side business
// rules the phone replicates behave correctly. It does what mobile/supabase-data.js does, but from
// Node using plain fetch against the same endpoints, with ONLY the publishable key + the test creds
// (never the secret key), exactly like the phone.
//
//   /Users/michaelbloemeke/.local/node22/bin/node supabase/verify-phone-write.mjs
//
// It exercises each write through PostgREST and cleans up after itself so ZERO test rows remain:
//   1. tasks:    add a throwaway 'zz-test' task -> toggle done -> delete it (count returns to baseline)
//   2. notes:    prepend a dated note to a real test project's activity_log -> then remove that note
//   3. payments: log a throwaway payment -> confirm it reads back -> delete it (count -> baseline)
//   4. stage gate (the rules the phone replicates from crm-data-core.setStage):
//        a. BLOCK a Booked-stage move when the project has no received payment (gate returns block)
//        b. BLOCK any manual move into a Post Show stage (auto-only)
//        c. ALLOW + actually perform a Booked-stage move once a received payment exists, then restore
//   5. contacts: patch a contact's relationship/tags/notes -> restore; assert phone normalization
//   Prints PASS/FAIL per step and a final summary. Any FAIL exits non-zero.

const BASE = 'https://yfmacqvcmkogvkcxfjkr.supabase.co'
const PUBLISHABLE = 'sb_publishable_QxnnWa1SGJrCaS2XEQY3wA_Klw0HlHF'
const EMAIL = 'michael@michaelbloemeke.com'
const PASSWORD = '123456'

let TOKEN = ''
const H = () => ({ apikey: PUBLISHABLE, Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' })

// Thin PostgREST helpers.
async function rest(path, opts = {}) {
  const r = await fetch(`${BASE}/rest/v1/${path}`, { ...opts, headers: { ...H(), ...(opts.headers || {}) } })
  const text = await r.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { ok: r.ok, status: r.status, body }
}
const select = (path) => rest(path, { method: 'GET' })
const insert = (table, row) => rest(table, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) })
const patch = (path, row) => rest(path, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) })
const del = (path) => rest(path, { method: 'DELETE' })

// ---- the gate logic the phone replicates (copied 1:1 from mobile/supabase-data.js setStage) ----
function num(v) { const n = Number(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : 0 }
function stageIdsForRole(structure, role) {
  const u = (structure.umbrellas || []).find((x) => x.role === role)
  return new Set(u ? (u.stages || []).map((s) => s.id) : [])
}
function hasReceivedPayment(payments, projectId) {
  return (payments || []).some(
    (pm) => pm.project_id === projectId && !pm.pending && num(pm.amount != null ? pm.amount : pm.amount_text) > 0 && String(pm.date_received || '').trim() !== '',
  )
}
// Returns null if the move is allowed by the gate, or the block reason string if blocked.
function gateBlockReason(structure, payments, projectId, stageId) {
  if (stageIdsForRole(structure, 'postshow').has(stageId)) return 'postshow-auto-only'
  if (stageIdsForRole(structure, 'booked').has(stageId) && !hasReceivedPayment(payments, projectId)) return 'booked-needs-payment'
  return null
}

function uuid() { return crypto.randomUUID() }
function logDate() {
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  const d = new Date()
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`
}

const results = []
function step(name, pass, detail) {
  results.push({ name, pass })
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

async function main() {
  console.log('== Magic CRM phone WRITE verification ==\n')

  // Sign in (publishable key + test creds) -> session token.
  const login = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: PUBLISHABLE, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  }).then((r) => r.json())
  TOKEN = login.access_token
  if (!TOKEN) { console.error('LOGIN FAILED:', JSON.stringify(login).slice(0, 200)); process.exit(1) }
  console.log('Signed in as', login.user?.email, '(publishable key + password)\n')

  // Load the pipeline structure once (the gate reads it).
  const structRow = (await select('pipeline_meta?select=structure&limit=1')).body?.[0]
  const structure = structRow?.structure || { umbrellas: [] }

  // Pick a real active project to attach test rows to. Prefer one with NO received payment so the
  // gate test is meaningful; restore everything at the end.
  const TEST_PROJECT = 'ann-kaiyala'
  const projRow = (await select(`projects?select=id,stage_id,activity_log&id=eq.${TEST_PROJECT}&limit=1`)).body?.[0]
  if (!projRow) { console.error('Test project not found:', TEST_PROJECT); process.exit(1) }
  const originalStage = projRow.stage_id
  const originalLog = Array.isArray(projRow.activity_log) ? projRow.activity_log : []
  console.log('Test project:', TEST_PROJECT, '| original stage:', originalStage, '| log entries:', originalLog.length, '\n')

  // ---------------- 1. TASKS ----------------
  console.log('1. Tasks (add -> toggle -> delete):')
  const taskBaseline = (await select('tasks?select=id')).body?.length ?? -1
  const taskId = uuid()
  const addT = await insert('tasks', {
    id: taskId, project_id: TEST_PROJECT, title: 'zz-test task (verify-phone-write)',
    due_date: '2026-07-06', due_time: '', done: false, created_at: new Date().toISOString(),
  })
  step('add task', addT.ok && addT.body?.[0]?.id === taskId, `status ${addT.status}`)
  const tog = await patch(`tasks?id=eq.${taskId}`, { done: true })
  step('toggle task done', tog.ok && tog.body?.[0]?.done === true, `done=${tog.body?.[0]?.done}`)
  const delT = await del(`tasks?id=eq.${taskId}`)
  const taskAfter = (await select('tasks?select=id')).body?.length ?? -2
  step('delete task', delT.ok && taskAfter === taskBaseline, `baseline ${taskBaseline} -> after ${taskAfter}`)

  // ---------------- 2. NOTES (activity_log) ----------------
  console.log('\n2. Project note (prepend dated line -> remove it):')
  const noteEntry = `${logDate()}: zz-test note (verify-phone-write)`
  const newLog = [noteEntry, ...originalLog.map(String)]
  const addN = await patch(`projects?id=eq.${TEST_PROJECT}`, { activity_log: newLog })
  const afterAddLog = addN.body?.[0]?.activity_log || []
  step('add note (newest first)', addN.ok && afterAddLog[0] === noteEntry && afterAddLog.length === originalLog.length + 1,
    `log ${originalLog.length} -> ${afterAddLog.length}, head matches=${afterAddLog[0] === noteEntry}`)
  const restoreN = await patch(`projects?id=eq.${TEST_PROJECT}`, { activity_log: originalLog })
  const afterRestoreLog = restoreN.body?.[0]?.activity_log || []
  step('remove note (log back to baseline)', restoreN.ok && afterRestoreLog.length === originalLog.length,
    `restored to ${afterRestoreLog.length}`)

  // ---------------- 3. PAYMENTS ----------------
  console.log('\n3. Payment (log -> read back -> delete):')
  const payBaseline = (await select('payments?select=id')).body?.length ?? -1
  const payId = uuid()
  const addP = await insert('payments', {
    id: payId, project_id: TEST_PROJECT, amount: 1, amount_text: null,
    date_received: '2026-07-06', pending: false, type: 'deposit', method: 'Check',
    note: 'zz-test payment (verify-phone-write)', created_at: new Date().toISOString(),
  })
  step('add payment', addP.ok && addP.body?.[0]?.id === payId, `status ${addP.status}`)
  const readP = await select(`payments?select=id,amount,date_received,pending&id=eq.${payId}`)
  step('payment reads back', readP.ok && readP.body?.[0]?.amount == 1 && readP.body?.[0]?.date_received === '2026-07-06',
    `amount=${readP.body?.[0]?.amount}, date=${readP.body?.[0]?.date_received}`)
  const delP = await del(`payments?id=eq.${payId}`)
  const payAfter = (await select('payments?select=id')).body?.length ?? -2
  step('delete payment', delP.ok && payAfter === payBaseline, `baseline ${payBaseline} -> after ${payAfter}`)

  // ---------------- 4. STAGE GATE ----------------
  console.log('\n4. Stage-move gate (the rules the phone replicates client-side):')
  const bookedStageId = [...stageIdsForRole(structure, 'booked')][0]
  const postshowStageId = [...stageIdsForRole(structure, 'postshow')][0]

  // 4a. No received payment -> booked move must be BLOCKED by the gate (no DB write attempted).
  let paysNow = (await select(`payments?select=project_id,amount,amount_text,date_received,pending&project_id=eq.${TEST_PROJECT}`)).body || []
  const blockA = gateBlockReason(structure, paysNow, TEST_PROJECT, bookedStageId)
  step('gate BLOCKS booked move with no received payment', blockA === 'booked-needs-payment',
    `reason=${blockA} (target stage ${bookedStageId})`)

  // 4b. Post Show move must always be BLOCKED (auto-only).
  const blockB = gateBlockReason(structure, paysNow, TEST_PROJECT, postshowStageId)
  step('gate BLOCKS manual move into Post Show', blockB === 'postshow-auto-only',
    `reason=${blockB} (target stage ${postshowStageId})`)

  // 4c. With a received payment on file, the gate ALLOWS the booked move -> actually perform it via
  //     PostgREST, confirm it wrote, then restore the original stage. Clean up the throwaway payment.
  const gatePayId = uuid()
  await insert('payments', {
    id: gatePayId, project_id: TEST_PROJECT, amount: 1, amount_text: null,
    date_received: '2026-07-06', pending: false, type: 'deposit', method: 'Check',
    note: 'zz-test gate payment', created_at: new Date().toISOString(),
  })
  paysNow = (await select(`payments?select=project_id,amount,amount_text,date_received,pending&project_id=eq.${TEST_PROJECT}`)).body || []
  const blockC = gateBlockReason(structure, paysNow, TEST_PROJECT, bookedStageId)
  let moveOk = false, restoredOk = false
  if (blockC === null) {
    const mv = await patch(`projects?id=eq.${TEST_PROJECT}`, { stage_id: bookedStageId })
    moveOk = mv.ok && mv.body?.[0]?.stage_id === bookedStageId
    const rs = await patch(`projects?id=eq.${TEST_PROJECT}`, { stage_id: originalStage })
    restoredOk = rs.ok && rs.body?.[0]?.stage_id === originalStage
  }
  step('gate ALLOWS + move succeeds once a received payment exists', blockC === null && moveOk,
    `gate=${blockC === null ? 'allow' : blockC}, moved=${moveOk}`)
  step('project stage restored to original', restoredOk, `stage back to ${originalStage}`)
  const delGateP = await del(`payments?id=eq.${gatePayId}`)
  step('cleanup gate payment', delGateP.ok)

  // ---------------- 5. CONTACT edit (relationship/tags/notes/phones) + phone normalization ----------------
  console.log('\n5. Contact edit (patch relationship/tags/notes/phones -> restore) + phone format:')
  // Phone normalization must match crm-phone.mjs: 10 digits -> (XXX) XXX-XXXX.
  const fmtDigits = (d) => (d.length === 10 ? `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}` : d.length === 11 ? `+${d[0]} (${d.slice(1,4)}) ${d.slice(4,7)}-${d.slice(7)}` : null)
  const formatPhoneField = (raw) => { const s = String(raw||'').trim(); return s ? s.replace(/\+?\(?\d[\d\s().\-]{7,}\d/g, (run) => fmtDigits(run.replace(/\D/g,'')) || run) : '' }
  step('phone normalizes 9195551234 -> (919) 555-1234', formatPhoneField('9195551234') === '(919) 555-1234', formatPhoneField('9195551234'))
  step('phone leaves a date 8/19/2026 untouched', formatPhoneField('8/19/2026') === '8/19/2026', formatPhoneField('8/19/2026'))

  const contactRow = (await select('contacts?select=id,name,relationship,tags,notes,phones,updated_at&limit=1')).body?.[0]
  if (contactRow) {
    const orig = { name: contactRow.name, relationship: contactRow.relationship, tags: contactRow.tags || [], notes: contactRow.notes, phones: contactRow.phones || [] }
    const upd = await patch(`contacts?id=eq.${contactRow.id}`, {
      relationship: 'maybe', tags: ['zz-test'], notes: 'zz-test note', updated_at: new Date().toISOString(),
    })
    const after = upd.body?.[0]
    step('contact patch (relationship/tags/notes)', upd.ok && after?.relationship === 'maybe' && (after?.tags || []).includes('zz-test') && after?.notes === 'zz-test note',
      `relationship=${after?.relationship}, tags=${JSON.stringify(after?.tags)}`)
    const rs = await patch(`contacts?id=eq.${contactRow.id}`, {
      relationship: orig.relationship, tags: orig.tags, notes: orig.notes, updated_at: contactRow.updated_at,
    })
    const back = rs.body?.[0]
    step('contact restored to original', rs.ok && back?.relationship === orig.relationship && back?.notes === orig.notes,
      `relationship=${back?.relationship}`)
  } else {
    step('contact patch (relationship/tags/notes)', false, 'no contact row found')
  }

  // ---------------- final cleanup + baseline re-check ----------------
  console.log('\n6. Zero-residue check (all counts back to baseline):')
  const tFinal = (await select('tasks?select=id')).body?.length
  const pFinal = (await select('payments?select=id')).body?.length
  const logFinal = ((await select(`projects?select=activity_log&id=eq.${TEST_PROJECT}`)).body?.[0]?.activity_log || []).length
  const stageFinal = (await select(`projects?select=stage_id&id=eq.${TEST_PROJECT}`)).body?.[0]?.stage_id
  step('tasks count at baseline', tFinal === taskBaseline, `${tFinal} (baseline ${taskBaseline})`)
  step('payments count at baseline', pFinal === payBaseline, `${pFinal} (baseline ${payBaseline})`)
  step('activity_log at baseline', logFinal === originalLog.length, `${logFinal} (baseline ${originalLog.length})`)
  step('stage restored', stageFinal === originalStage, `${stageFinal}`)

  const failed = results.filter((r) => !r.pass)
  console.log('\n== RESULT ==')
  if (failed.length === 0) {
    console.log(`PASS: all ${results.length} write + gate checks passed; zero test rows left behind.`)
    process.exit(0)
  } else {
    console.log(`FAIL: ${failed.length}/${results.length} checks failed -> ${failed.map((f) => f.name).join('; ')}`)
    process.exit(1)
  }
}

main().catch((e) => { console.error('ERROR:', e); process.exit(1) })
