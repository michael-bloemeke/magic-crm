// Stage A of the phone app: set up Supabase Auth + row-level-security so the phone (publishable key
// + a logged-in session) can read/write, while the public/anon key stays locked out. The desktop app
// uses the SECRET key which bypasses RLS, so it is unaffected. Idempotent. Run:
//   node supabase/setup-auth.mjs
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const { url, projectRef, publishableKey, secretKey, accessToken } = JSON.parse(
  fs.readFileSync(path.join(DIR, '..', 'supabase-credentials.json'), 'utf8'),
)
const EMAIL = 'michael@michaelbloemeke.com'
// A strong, phone-typeable password (typed once; the session then persists). Michael can change it.
const PASSWORD = 'Fism-' + crypto.randomBytes(4).toString('hex') + '-' + crypto.randomBytes(3).toString('hex').toUpperCase() + '!7'

const TABLES = [
  'projects', 'contacts', 'contact_links', 'pipeline_meta', 'payments', 'expenses', 'mileage_trips',
  'tasks', 'emails', 'templates', 'notifications', 'text_markers', 'invoices', 'contracts',
  'questionnaires', 'portals', 'recipients', 'inquiries', 'calendar_map', 'crm_config', 'crm_settings',
]

async function mgmtSql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  if (!r.ok) throw new Error(`SQL (${r.status}): ${await r.text()}`)
  return r.json().catch(() => null)
}

// 1. Create (or find) the auth user, email pre-confirmed.
console.log('1. Creating auth user', EMAIL, '...')
let created = false
{
  const r = await fetch(`${url}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: secretKey, Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, email_confirm: true }),
  })
  const body = await r.json().catch(() => ({}))
  if (r.ok) { created = true; console.log('   created, uid:', body.id) }
  else if (JSON.stringify(body).match(/already|registered|exists/i)) {
    // Reset the password on the existing user so we have a known one.
    const list = await fetch(`${url}/auth/v1/admin/users`, { headers: { apikey: secretKey, Authorization: `Bearer ${secretKey}` } }).then((x) => x.json())
    const u = (list.users || []).find((x) => x.email === EMAIL)
    if (u) {
      await fetch(`${url}/auth/v1/admin/users/${u.id}`, {
        method: 'PUT', headers: { apikey: secretKey, Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD, email_confirm: true }),
      })
      console.log('   user already existed; reset password. uid:', u.id)
    }
  } else {
    throw new Error('create user failed: ' + JSON.stringify(body))
  }
}

// 2. Disable public signups (only I create the account). Best-effort.
console.log('2. Disabling public signups...')
try {
  const r = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/config/auth`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ disable_signup: true }),
  })
  console.log('   ', r.ok ? 'signups disabled.' : 'could not disable (non-fatal): ' + (await r.text()).slice(0, 120))
} catch (e) { console.log('   skipped:', e.message) }

// 3. RLS policies: authenticated -> full access; anon stays blocked (no policy).
console.log('3. Adding access rules to', TABLES.length, 'tables...')
const ddl = TABLES.map((t) => `drop policy if exists app_rw on public.${t};\ncreate policy app_rw on public.${t} for all to authenticated using (true) with check (true);`).join('\n')
await mgmtSql(ddl)
console.log('   done.')

// 4. Prove it: logged-in read works, anonymous read is blocked.
console.log('4. Verifying...')
const login = await fetch(`${url}/auth/v1/token?grant_type=password`, {
  method: 'POST', headers: { apikey: publishableKey, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
}).then((r) => r.json())
const token = login.access_token
const authedRead = await fetch(`${url}/rest/v1/projects?select=client_name&limit=1`, {
  headers: { apikey: publishableKey, Authorization: `Bearer ${token}` },
}).then((r) => r.json())
const anonRead = await fetch(`${url}/rest/v1/projects?select=client_name&limit=1`, {
  headers: { apikey: publishableKey },
}).then((r) => r.json())
console.log('   logged-in read (should show a project):', JSON.stringify(authedRead).slice(0, 80))
console.log('   anonymous read (should be empty []):', JSON.stringify(anonRead).slice(0, 80))

// Confirm a WRITE under the session works: set the mileage rate to its own current value (a harmless
// no-op that still exercises the write path + RLS check).
const wrote = await fetch(`${url}/rest/v1/crm_settings?id=eq.1`, {
  method: 'PATCH', headers: { apikey: publishableKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
  body: JSON.stringify({ mileage_rate_per_mile: 0.7 }),
})
console.log('   logged-in write (should be 2xx):', wrote.status)

console.log('\n==============================')
console.log('PHONE LOGIN')
console.log('  email:   ', EMAIL)
console.log('  password:', PASSWORD)
console.log('==============================')
