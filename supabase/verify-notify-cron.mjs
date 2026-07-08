// Headless end-to-end check of the deployed notify-cron edge function (run AFTER the main agent
// deploys the function + runs notify-cron-setup.sql). No phone needed.
//
// It:
//   1. Picks a real active-bucket project.
//   2. Seeds a test task on it with an alarm ~1 minute in the PAST and notified_at NULL.
//   3. POSTs the deployed function URL with the x-cron-secret header (same call the cron job makes).
//   4. Asserts: a `task-due` notification now exists for that task, and its notified_at got stamped.
//   5. Prints the function's JSON summary ({ tasksFired, inquiriesFired, pushed, pruned }).
//   6. Cleans up: deletes the test task + its notification.
//
// It does NOT verify real phone delivery (Michael confirms that on his device); `pushed` just reports
// how many subscription endpoints the function attempted. Run:
//   /Users/michaelbloemeke/.local/node22/bin/node supabase/verify-notify-cron.mjs
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const { url, secretKey } = JSON.parse(fs.readFileSync(path.join(DIR, '..', 'supabase-credentials.json'), 'utf8'))
const FN_URL = `${url.replace(/\/$/, '')}/functions/v1/notify-cron`

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`)
}

const sb = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } })

// Build a due_date/due_time in America/New_York that is ~1 minute in the past, so the alarm instant
// has just passed. We format "now minus 90s" in the New_York zone via Intl, so it's DST-correct and
// matches exactly how the edge function interprets due_date/due_time.
function nyPastAlarm(msAgo = 90 * 1000) {
  const when = new Date(Date.now() - msAgo)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(when)
  const get = (t) => parts.find((p) => p.type === t)?.value
  let hh = get('hour')
  if (hh === '24') hh = '00'
  return { dueDate: `${get('year')}-${get('month')}-${get('day')}`, dueTime: `${hh}:${get('minute')}` }
}

async function main() {
  // 1. A real active project to hang the test task on.
  const { data: projs, error: pErr } = await sb
    .from('projects').select('id,client_name,project_name').eq('bucket', 'active').limit(1)
  if (pErr || !projs || !projs.length) {
    check('found an active project to test on', false, pErr ? pErr.message : 'no active projects')
    return
  }
  const proj = projs[0]
  check('found an active project to test on', true, `${proj.id}`)

  // 2. Seed the test task (alarm ~1 min in the past, not done, not yet notified).
  const taskId = crypto.randomUUID()
  const { dueDate, dueTime } = nyPastAlarm()
  const title = `__notify-cron self-test ${Date.now()}`
  const { error: insErr } = await sb.from('tasks').insert({
    id: taskId, project_id: proj.id, title, due_date: dueDate, due_time: dueTime,
    done: false, notified_at: null, created_at: new Date().toISOString(),
  })
  check('seeded test task (alarm ~1 min in the past)', !insErr, insErr ? insErr.message : `${dueDate} ${dueTime} NY`)
  if (insErr) return

  let summary = null
  try {
    // 3. Invoke the deployed function exactly as the cron job does (shared-secret header).
    const cronSecret = process.env.CRON_SECRET || 'ZFZBYcg4Lk-vH-2HV1-NoDKsXB-iHC4SOhloN09P8-g'
    const res = await fetch(FN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-cron-secret': cronSecret },
      body: '{}',
    })
    const text = await res.text()
    try { summary = JSON.parse(text) } catch { summary = null }
    check('function responded 200', res.status === 200, `status ${res.status}${summary ? '' : ' body=' + text.slice(0, 160)}`)
    console.log('  function summary:', JSON.stringify(summary))
    check('summary reports at least our task fired', !!summary && summary.tasksFired >= 1,
      summary ? `tasksFired=${summary.tasksFired}` : 'no summary')

    // 4a. A task-due notification now exists for our task.
    const { data: notifs } = await sb
      .from('notifications').select('id,kind,source_id,project_id').eq('kind', 'task-due').eq('source_id', taskId)
    check('task-due notification created for the test task', Array.isArray(notifs) && notifs.length === 1,
      `found ${notifs ? notifs.length : 0}`)

    // 4b. notified_at got stamped on the task.
    const { data: after } = await sb.from('tasks').select('notified_at').eq('id', taskId).single()
    check('task notified_at was set', !!(after && after.notified_at), after ? String(after.notified_at) : 'row gone')
  } finally {
    // 6. Cleanup: remove the test notification + task no matter what.
    await sb.from('notifications').delete().eq('kind', 'task-due').eq('source_id', taskId)
    await sb.from('tasks').delete().eq('id', taskId)
    const { data: t2 } = await sb.from('tasks').select('id').eq('id', taskId)
    const { data: n2 } = await sb.from('notifications').select('id').eq('source_id', taskId)
    check('cleanup: test task + notification removed',
      (!t2 || t2.length === 0) && (!n2 || n2.length === 0),
      `task=${t2 ? t2.length : 0} notif=${n2 ? n2.length : 0}`)
  }
}

console.log(`Verifying deployed notify-cron at ${FN_URL} ...\n`)
main()
  .then(() => {
    const failed = results.filter((r) => !r.ok)
    console.log('\n==============================')
    console.log(failed.length ? `RESULT: FAIL (${failed.length}/${results.length} checks failed)` : `RESULT: PASS (all ${results.length} checks)`)
    console.log('Note: real phone delivery is not asserted here; Michael confirms that on his device.')
    console.log('==============================')
    process.exit(failed.length ? 1 : 0)
  })
  .catch((e) => {
    console.error('\nverify-notify-cron crashed:', e && e.message ? e.message : e)
    console.log('\n==============================\nRESULT: FAIL (crashed)\n==============================')
    process.exit(1)
  })
