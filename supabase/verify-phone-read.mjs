// Headless proof that the phone app's login + live-read path works.
//
// It does EXACTLY what mobile/supabase-data.js does, but from Node using plain fetch against the same
// endpoints: sign in with the PUBLISHABLE key + the test creds to get a session token, then read
// projects / pipeline structure / tasks / notifications / payments+config the way each tab does, and
// print counts + a sample. Then it confirms an ANONYMOUS read (publishable key, no token) returns []
// because row-level security blocks it. Run with Node 22:
//   /Users/michaelbloemeke/.local/node22/bin/node supabase/verify-phone-read.mjs
//
// This uses ONLY the publishable key (never the secret key), matching the phone exactly.

const URL = 'https://yfmacqvcmkogvkcxfjkr.supabase.co'
const PUBLISHABLE = 'sb_publishable_QxnnWa1SGJrCaS2XEQY3wA_Klw0HlHF'
const EMAIL = 'michael@michaelbloemeke.com'
const PASSWORD = 'Fism-b6a79a8d-C0B767!7'

const rest = (path, token) =>
  fetch(`${URL}/rest/v1/${path}`, {
    headers: token ? { apikey: PUBLISHABLE, Authorization: `Bearer ${token}` } : { apikey: PUBLISHABLE },
  }).then(async (r) => ({ ok: r.ok, status: r.status, body: await r.json().catch(() => null) }))

function num(v) {
  const n = Number(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''))
  return Number.isFinite(n) ? n : 0
}
function amountOf(r) {
  if (r.amount_text != null && r.amount_text !== '') return r.amount_text
  const n = Number(r.amount)
  return Number.isFinite(n) ? n : 0
}
function money(n) { return '$' + Math.round(Number(n) || 0).toLocaleString('en-US') }

// The same finance math as computeFinance() in mobile/supabase-data.js (payments-based).
function computeFinance(projects, payments) {
  const now = new Date()
  const year = now.getFullYear()
  const mKey = (iso) => (iso && /^\d{4}-\d{2}/.test(iso) ? iso.slice(0, 7) : '')
  const byId = new Map(projects.map((p) => [p.id, p]))
  const eventMonthOf = (pm) => mKey(byId.get(pm.project_id)?.event_date || '')
  const real = payments.filter((pm) => !pm.pending && num(amountOf(pm)) > 0)
  const curKey = `${year}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const sum = (arr) => arr.reduce((s, pm) => s + num(amountOf(pm)), 0)
  const received = sum(real.filter((pm) => mKey(pm.date_received) === curKey))
  const earned = sum(real.filter((pm) => eventMonthOf(pm) === curKey))
  const receivedByProject = {}
  for (const pm of real) {
    if (!pm.date_received) continue
    receivedByProject[pm.project_id] = (receivedByProject[pm.project_id] || 0) + num(amountOf(pm))
  }
  const expectedRemaining = projects
    .filter((p) => p.bucket === 'active')
    .reduce((s, p) => s + Math.max(0, (typeof p.total_fee === 'number' ? p.total_fee : num(p.total_fee)) - (receivedByProject[p.id] || 0)), 0)
  return { thisMonthReceived: received, thisMonthEarned: earned, expectedRemaining }
}

async function main() {
  console.log('== Magic CRM phone read verification ==\n')

  // 1) Sign in with the publishable key (the phone's login path).
  console.log('1. Signing in as', EMAIL, 'with the PUBLISHABLE key...')
  const login = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: PUBLISHABLE, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  }).then((r) => r.json())
  const token = login.access_token
  if (!token) {
    console.error('   LOGIN FAILED:', JSON.stringify(login).slice(0, 200))
    process.exit(1)
  }
  console.log('   OK. Session token acquired (user:', login.user?.email, ')\n')

  // 2) The same reads each tab does, with the session token.
  const projectCols = 'id,client_name,project_name,bucket,stage_id,event_type,event_date,total_fee,total_fee_text,tips,contact_names'
  const [projects, structure, tasks, notifs, payments, config] = await Promise.all([
    rest(`projects?select=${projectCols}`, token),
    rest('pipeline_meta?select=structure&limit=1', token),
    rest('tasks?select=id,project_id,title,due_date,due_time,done', token),
    rest('notifications?select=id,project_id,kind,seen,created_at&seen=eq.false', token),
    rest('payments?select=id,project_id,amount,amount_text,date_received,pending,type', token),
    rest('crm_config?select=data&limit=1', token),
  ])

  const fail = [projects, structure, tasks, notifs, payments, config].find((x) => !x.ok)
  if (fail) {
    console.error('   A logged-in read FAILED:', fail.status, JSON.stringify(fail.body).slice(0, 200))
    process.exit(1)
  }

  const projRows = projects.body || []
  const activeRows = projRows.filter((p) => p.bucket === 'active')
  const umbrellas = structure.body?.[0]?.structure?.umbrellas || []
  const openTasks = (tasks.body || []).filter((t) => !t.done)
  const fin = computeFinance(projRows, payments.body || [])

  console.log('2. Logged-in reads (RLS lets the authenticated user read everything):')
  console.log('   projects:      ', projRows.length, 'total,', activeRows.length, 'active (Pipeline board)')
  console.log('   pipeline meta: ', umbrellas.length, 'umbrellas ->', umbrellas.map((u) => u.label).join(', '))
  console.log('   tasks:         ', (tasks.body || []).length, 'total,', openTasks.length, 'open')
  console.log('   notifications: ', (notifs.body || []).length, 'unseen (Alerts)')
  console.log('   payments:      ', (payments.body || []).length, 'rows (Money is computed from these)')
  console.log('   crm_config:    ', config.body?.[0]?.data ? 'loaded (monthlyGoal=' + (config.body[0].data.monthlyGoal ?? 'default') + ')' : 'MISSING')

  const sample = activeRows[0] || projRows[0]
  if (sample) {
    console.log('\n   Sample project:')
    console.log('     client:', sample.project_name || sample.client_name)
    console.log('     bucket:', sample.bucket, '| stage_id:', sample.stage_id, '| eventDate:', sample.event_date || '(none)')
    console.log('     quote:', sample.total_fee != null ? money(sample.total_fee) : (sample.total_fee_text || '(none)'))
  }
  const st = openTasks[0]
  if (st) console.log('   Sample open task:', JSON.stringify({ title: st.title, dueDate: st.due_date, done: st.done }))
  const sn = (notifs.body || [])[0]
  if (sn) console.log('   Sample alert:', JSON.stringify({ kind: sn.kind, projectId: sn.project_id, seen: sn.seen }))

  console.log('\n   Money tab (computed from payments + projects, matching computeFinance):')
  console.log('     Received this month: ', money(fin.thisMonthReceived))
  console.log('     Booked this month:   ', money(fin.thisMonthEarned))
  console.log('     Expected rest of yr: ', money(fin.expectedRemaining))

  // 3) Anonymous read (publishable key, NO token) must be blocked by RLS -> [].
  console.log('\n3. Anonymous read (publishable key, NO session) - RLS should block it:')
  const anonProjects = await rest(`projects?select=${projectCols}&limit=5`)
  const anonTasks = await rest('tasks?select=id&limit=5')
  const anonPayments = await rest('payments?select=id&limit=5')
  const emptyArr = (x) => Array.isArray(x.body) && x.body.length === 0
  const allEmpty = emptyArr(anonProjects) && emptyArr(anonTasks) && emptyArr(anonPayments)
  console.log('   projects (anon):', JSON.stringify(anonProjects.body))
  console.log('   tasks (anon):   ', JSON.stringify(anonTasks.body))
  console.log('   payments (anon):', JSON.stringify(anonPayments.body))
  console.log('   ->', allEmpty ? 'BLOCKED (empty). RLS is protecting the data.' : 'WARNING: anon read returned data!')

  console.log('\n== RESULT ==')
  const readsWorked = projRows.length > 0 && umbrellas.length > 0 && (payments.body || []).length > 0
  if (readsWorked && allEmpty) {
    console.log('PASS: logged-in publishable-key reads return real data; anonymous reads are blocked.')
    process.exit(0)
  } else {
    console.log('FAIL: readsWorked=' + readsWorked + ', anonBlocked=' + allEmpty)
    process.exit(1)
  }
}

main().catch((e) => { console.error('ERROR:', e); process.exit(1) })
