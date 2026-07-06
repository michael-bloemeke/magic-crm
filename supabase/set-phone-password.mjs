// Reset the phone-app login password. Usage: node supabase/set-phone-password.mjs <newPassword>
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const DIR = path.dirname(fileURLToPath(import.meta.url))
const { url, publishableKey, secretKey } = JSON.parse(fs.readFileSync(path.join(DIR, '..', 'supabase-credentials.json'), 'utf8'))
const EMAIL = 'michael@michaelbloemeke.com'
const NEW = process.argv[2]
if (!NEW) { console.error('usage: node supabase/set-phone-password.mjs <newPassword>'); process.exit(1) }

const admin = { apikey: secretKey, Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' }
const list = await fetch(`${url}/auth/v1/admin/users`, { headers: admin }).then((r) => r.json())
const u = (list.users || []).find((x) => x.email === EMAIL)
if (!u) { console.error('user not found:', EMAIL); process.exit(1) }
const r = await fetch(`${url}/auth/v1/admin/users/${u.id}`, { method: 'PUT', headers: admin, body: JSON.stringify({ password: NEW, email_confirm: true }) })
console.log(r.ok ? 'password updated.' : 'FAILED: ' + (await r.text()))

const login = await fetch(`${url}/auth/v1/token?grant_type=password`, {
  method: 'POST', headers: { apikey: publishableKey, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: NEW }),
}).then((x) => x.json())
console.log('sign-in test with new password:', login.access_token ? 'OK' : JSON.stringify(login).slice(0, 160))
