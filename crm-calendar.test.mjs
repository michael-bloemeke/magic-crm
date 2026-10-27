// Regression test for singleFlight() in crm-calendar.mjs, the gate every calendar sync goes through.
//
// The bug this guards: the 5-minute timer started a new full sync while the last one was still
// running. On 2026-10-27 the passes piled up, crawled through every event, and new projects never
// reached the calendar until the server was restarted.
//
// Run it:  node crm-calendar.test.mjs      (exits non-zero on failure)
import { singleFlight } from './crm-calendar.mjs'

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

if (failures) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll checks passed')
process.exit(0)
