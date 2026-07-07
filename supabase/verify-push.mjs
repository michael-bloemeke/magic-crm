// Headless end-to-end check of the Supabase-backed web-push wiring (no phone needed). Confirms:
//   1. push_subscriptions table exists + RLS blocks the anon/publishable key (read returns []).
//   2. Signing in with the publishable key + test creds, an authenticated INSERT of a fake subscription
//      row succeeds (the exact write the phone's bell does).
//   3. crm-webpush.mjs's READ path (readSubs, replicated here against the SECRET key) returns that row.
//   4. Cleanup: DELETE the fake row (the way the Mac prunes dead subs on a 410/404).
// Prints PASS/FAIL. Actual push DELIVERY to the phone Michael tests on his device. Run:
//   node supabase/verify-push.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const { url, publishableKey, secretKey } = JSON.parse(
  fs.readFileSync(path.join(DIR, '..', 'supabase-credentials.json'), 'utf8'),
)
const EMAIL = 'michael@michaelbloemeke.com'
const PASSWORD = '123456'

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const fakeEndpoint = 'https://verify-push.example/' + Date.now() + '-' + Math.random().toString(16).slice(2)
const fakeSub = { endpoint: fakeEndpoint, expirationTime: null, keys: { p256dh: 'BFakeP256dhKeyForVerifyOnly', auth: 'FakeAuthSecret' } }

async function main() {
  // 1. Table exists + anon RLS. The anon client (publishable key, no session) should read [] because
  //    the only policy is `to authenticated`. A missing-table error would surface here instead.
  const anon = createClient(url, publishableKey, { auth: { persistSession: false } })
  const { data: anonData, error: anonErr } = await anon.from('push_subscriptions').select('endpoint').limit(5)
  const tableExists = !anonErr || !/relation .*does not exist|not exist|schema cache/i.test(String(anonErr.message || anonErr))
  check('push_subscriptions table exists', tableExists, anonErr ? String(anonErr.message || anonErr).slice(0, 80) : '')
  check('anon read blocked by RLS (returns [])', !anonErr && Array.isArray(anonData) && anonData.length === 0,
    anonErr ? String(anonErr.message || anonErr).slice(0, 80) : `got ${JSON.stringify(anonData)}`)

  // 2. Authenticated INSERT via the publishable key + test creds (the phone's exact path).
  const authed = createClient(url, publishableKey, { auth: { persistSession: false } })
  const { error: signInErr } = await authed.auth.signInWithPassword({ email: EMAIL, password: PASSWORD })
  check('sign in with publishable key + test creds', !signInErr, signInErr ? String(signInErr.message).slice(0, 80) : '')
  if (signInErr) return

  const { error: insErr } = await authed.from('push_subscriptions').upsert(
    { endpoint: fakeEndpoint, subscription: fakeSub, user_agent: 'verify-push.mjs' },
    { onConflict: 'endpoint' },
  )
  check('authenticated INSERT of a fake subscription', !insErr, insErr ? String(insErr.message).slice(0, 80) : '')

  // 3. crm-webpush.mjs's read path returns it. Replicate readSubs() exactly (SECRET key -> raw
  //    `subscription` jsonb, filtered to those with an endpoint), then assert our fake row is present.
  const admin = createClient(url, secretKey, { auth: { persistSession: false } })
  const { data: rows, error: readErr } = await admin.from('push_subscriptions').select('endpoint,subscription')
  const subs = (Array.isArray(rows) ? rows : [])
    .map((r) => (r && r.subscription ? r.subscription : null))
    .filter((s) => s && s.endpoint)
  const found = subs.find((s) => s.endpoint === fakeEndpoint)
  check("crm-webpush read path returns the row", !readErr && !!found,
    readErr ? String(readErr.message).slice(0, 80) : (found ? 'endpoint matches' : 'row not found in read'))
  check('read row carries the full subscription JSON (keys present)',
    !!(found && found.keys && found.keys.p256dh && found.keys.auth),
    found ? '' : 'no row')

  // 4. Cleanup: delete the fake row the way the Mac prunes dead subs.
  const { error: delErr } = await admin.from('push_subscriptions').delete().in('endpoint', [fakeEndpoint])
  check('cleanup: fake row deleted', !delErr, delErr ? String(delErr.message).slice(0, 80) : '')
  const { data: after } = await admin.from('push_subscriptions').select('endpoint').eq('endpoint', fakeEndpoint)
  check('cleanup verified (row gone)', Array.isArray(after) && after.length === 0, `remaining=${JSON.stringify(after)}`)
}

console.log('Verifying Supabase web-push wiring...\n')
main()
  .then(() => {
    const failed = results.filter((r) => !r.ok)
    console.log('\n==============================')
    console.log(failed.length ? `RESULT: FAIL (${failed.length}/${results.length} checks failed)` : `RESULT: PASS (all ${results.length} checks)`)
    console.log('==============================')
    process.exit(failed.length ? 1 : 0)
  })
  .catch((e) => {
    console.error('\nverify-push crashed:', e && e.message ? e.message : e)
    console.log('\n==============================\nRESULT: FAIL (crashed)\n==============================')
    process.exit(1)
  })
