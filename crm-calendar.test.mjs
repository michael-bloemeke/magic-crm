// Regression test for singleFlight() in crm-calendar.mjs, the gate every calendar sync goes through.
//
// The bug this guards: the 5-minute timer started a new full sync while the last one was still
// running. On 2026-10-27 the passes piled up, crawled through every event, and new projects never
// reached the calendar until the server was restarted.
//
// Run it:  node crm-calendar.test.mjs      (exits non-zero on failure)
import { singleFlight, taskEventBody } from './crm-calendar.mjs'

let failures = 0
function check(label, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) failures += 1
}

// A fake sync whose runs finish only when the test says so.
function fakeJob() {
  const job = { started: 0, inFlight: 0, maxInFlight: 0, releases: [] }
  job.fn = () => {
    job.started += 1
    job.inFlight += 1
    job.maxInFlight = Math.max(job.maxInFlight, job.inFlight)
    const n = job.started
    return new Promise((resolve) => {
      job.releases.push(() => {
        job.inFlight -= 1
        resolve(n)
      })
    })
  }
  return job
}
const tick = () => new Promise((r) => setTimeout(r, 0))

{
  const job = fakeJob()
  const sync = singleFlight(job.fn)
  const a = sync()
  const b = sync() // arrives mid-run
  const c = sync() // also mid-run: shares b's follow-up
  await tick()
  check('only one run starts while one is in flight', job.started === 1)
  check('later callers share one follow-up', b === c && a !== b)

  job.releases[0]()
  check('the first caller gets the first run', (await a) === 1)
  await tick()
  check('the follow-up starts once the first run ends', job.started === 2)
  check('never two runs at once', job.maxInFlight === 1)

  job.releases[1]()
  check('waiting callers get the follow-up, which saw later changes', (await b) === 2 && (await c) === 2)

  const d = sync()
  await tick()
  check('a call after everything settles starts a fresh run', job.started === 3)
  job.releases[2]()
  check('and gets its own result', (await d) === 3)
}

{
  // A failed run must not wedge the gate: the follow-up still runs, and later calls still work.
  let calls = 0
  const sync = singleFlight(async () => {
    calls += 1
    await tick()
    if (calls === 1) throw new Error('Google said no')
    return calls
  })
  const a = sync()
  const b = sync()
  let threw = false
  try {
    await a
  } catch {
    threw = true
  }
  check('a failed run rejects for its own caller', threw)
  check('the follow-up still runs after a failure', (await b) === 2)
  check('the gate is free again afterwards', (await sync()) === 3)
}

// ---- A task's length and Busy/Free (2026-11-12) ----
{
  const base = { title: 'Call venue', dueDate: '2026-11-20', dueTime: '14:00' }
  const free = taskEventBody({ ...base, durationMin: 15, busy: false }, null)
  check('a free task is transparent (does not block TidyCal)', free.transparency === 'transparent')
  check('a task uses its own length', free.end.dateTime === '2026-11-20T14:15:00')
  const busy = taskEventBody({ ...base, durationMin: 90, busy: true }, null)
  check('a busy task is opaque (blocks TidyCal)', busy.transparency === 'opaque')
  check('a 90-minute task ends 90 minutes later', busy.end.dateTime === '2026-11-20T15:30:00')
  const old = taskEventBody({ ...base }, null)
  check('a task with no length or busy flag is 30 minutes and free', old.end.dateTime === '2026-11-20T14:30:00' && old.transparency === 'transparent')
  const late = taskEventBody({ ...base, dueTime: '23:30', durationMin: 60 }, null)
  check('a late task rolls past midnight', late.end.dateTime === '2026-11-21T00:30:00')
}

if (failures) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll checks passed')
process.exit(0)
