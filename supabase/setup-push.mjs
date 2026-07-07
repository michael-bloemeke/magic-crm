// Web-push for the phone app, Supabase edition. Creates the `push_subscriptions` table (where the
// phone stores its Web Push subscription after the user taps the bell) and locks it down with RLS so
// only a logged-in user can read/write it; the anon/publishable key alone sees nothing. The Mac reads
// this table (with the SECRET key, which bypasses RLS) to send push. Mirrors setup-auth.mjs: DDL via
// the Management API, then a publishable/secret-key check to prove RLS works. Idempotent. Run:
//   node supabase/setup-push.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const { url, projectRef, publishableKey, secretKey, accessToken } = JSON.parse(
  fs.readFileSync(path.join(DIR, '..', 'supabase-credentials.json'), 'utf8'),
)
// The phone signs in with these to prove the authenticated path can write and the anon path can't.
const EMAIL = 'michael@michaelbloemeke.com'
const PASSWORD = '123456'

async function mgmtSql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  if (!r.ok) throw new Error(`SQL (${r.status}): ${await r.text()}`)
  return r.json().catch(() => null)
}

// 1. Create the table + RLS. All idempotent (if not exists / drop policy if exists).
console.log('1. Creating push_subscriptions table + RLS...')
await mgmtSql(`
  create table if not exists public.push_subscriptions (
    id uuid default gen_random_uuid() primary key,
    endpoint text unique not null,
    subscription jsonb not null,
    user_agent text,
    created_at timestamptz default now()
  );
  alter table public.push_subscriptions enable row level security;
  drop policy if exists app_rw on public.push_subscriptions;
  create policy app_rw on public.push_subscriptions for all to authenticated using (true) with check (true);
`)
// Nudge PostgREST to reload its schema cache so the REST API sees the new table immediately (avoids a
// first-run 404 on the verify step below when the table was just created).
await mgmtSql(`notify pgrst, 'reload schema';`).catch(() => {})
await new Promise((r) => setTimeout(r, 1500))
console.log('   done.')

// 2. Prove RLS: log in with the publishable key, then confirm the authenticated session can write and
//    read its own rows, while the anonymous (publishable-key-only) read returns [].
console.log('2. Verifying RLS...')
const login = await fetch(`${url}/auth/v1/token?grant_type=password`, {
  method: 'POST', headers: { apikey: publishableKey, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
}).then((r) => r.json())
const token = login.access_token
if (!token) throw new Error('Could not sign in test user: ' + JSON.stringify(login).slice(0, 160))

const fakeEndpoint = 'https://example.com/setup-push-selftest/' + Date.now()
const insert = await fetch(`${url}/rest/v1/push_subscriptions`, {
  method: 'POST',
  headers: { apikey: publishableKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
  body: JSON.stringify({ endpoint: fakeEndpoint, subscription: { endpoint: fakeEndpoint, keys: { p256dh: 'x', auth: 'y' } }, user_agent: 'setup-push.mjs' }),
})
console.log('   authenticated insert (should be 2xx):', insert.status)

const authedRead = await fetch(`${url}/rest/v1/push_subscriptions?select=endpoint&limit=5`, {
  headers: { apikey: publishableKey, Authorization: `Bearer ${token}` },
}).then((r) => r.json())
const anonRead = await fetch(`${url}/rest/v1/push_subscriptions?select=endpoint&limit=5`, {
  headers: { apikey: publishableKey },
}).then((r) => r.json())
console.log('   authenticated read (should list the row):', JSON.stringify(authedRead).slice(0, 120))
console.log('   anonymous read   (should be empty []):   ', JSON.stringify(anonRead).slice(0, 80))

// 3. Clean up the self-test row (via the SECRET key, the way the Mac deletes dead subs).
await fetch(`${url}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(fakeEndpoint)}`, {
  method: 'DELETE', headers: { apikey: secretKey, Authorization: `Bearer ${secretKey}` },
})
console.log('   cleaned up self-test row.')

console.log('\n==============================')
console.log('push_subscriptions table ready. Phone can now subscribe after logging in.')
console.log('==============================')
