// Move QuickBooks PRODUCTION keys from the local credentials file into Supabase, then hand back a
// one-time link that connects the CRM to Michael's real company.
//
// WHY A SCRIPT. The client id and secret are the credentials that let something raise invoices
// against real books. They should not be pasted into a chat window, a commit, or a browser URL bar.
// This reads them from the gitignored local file and writes them straight to the service-role-only
// `quickbooks_config` row, so they travel machine-to-machine and are never seen in between.
//
// USAGE
//   1. Put the PRODUCTION keys in quickbooks-credentials.json (clientId / clientSecret) and set
//      "environment": "production".
//   2. node push-quickbooks-keys.mjs
//   3. Open the link it prints, approve the connection in QuickBooks, done.
//
// The link is single-use and expires in 30 minutes on purpose: it is the one thing that can point
// this CRM at real money, so a stale link left in a browser history should be worthless.
//
// NOTE: `environment` is NOT flipped here. The quickbooks-oauth function sets it to "production"
// only after a real consent screen succeeds, so the CRM can never end up claiming a live connection
// it does not actually have.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const read = (f) => JSON.parse(fs.readFileSync(path.join(HERE, f), 'utf8'))

let qb, sbCreds
try {
  qb = read('quickbooks-credentials.json')
} catch {
  console.error('Could not read quickbooks-credentials.json.')
  process.exit(1)
}
try {
  sbCreds = read('supabase-credentials.json')
} catch {
  console.error('Could not read supabase-credentials.json.')
  process.exit(1)
}

const clientId = String(qb.clientId || '').trim()
const clientSecret = String(qb.clientSecret || '').trim()

if (!clientId || clientId.startsWith('PASTE') || !clientSecret || clientSecret.startsWith('PASTE')) {
  console.error('quickbooks-credentials.json still has placeholder keys. Put the real production keys in first.')
  process.exit(1)
}

// A loud check rather than a silent one. Sandbox keys pushed under the impression they were
// production would produce a connection that looks fine and invoices nobody.
if (String(qb.environment || '').trim() !== 'production') {
  console.error(`environment in quickbooks-credentials.json is "${qb.environment}", not "production".`)
  console.error('Set it to production once you are pasting production keys, so this cannot run by accident.')
  process.exit(1)
}

const sb = createClient(sbCreds.url, sbCreds.secretKey, { auth: { persistSession: false } })

const setupToken = crypto.randomBytes(24).toString('base64url')
const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString()

const { error } = await sb
  .from('quickbooks_config')
  .update({
    client_id: clientId,
    client_secret: clientSecret,
    setup_token: setupToken,
    setup_expires_at: expiresAt,
    oauth_state: null,
    updated_at: new Date().toISOString(),
  })
  .eq('id', 1)

if (error) {
  console.error('Could not write to quickbooks_config:', error.message)
  process.exit(1)
}

const fnUrl = `${sbCreds.url}/functions/v1/quickbooks-oauth`

console.log('')
console.log('Production keys are in Supabase.')
console.log('')
console.log('Check this EXACT string is the Redirect URI on your Intuit app:')
console.log(`  ${fnUrl}`)
console.log('')
console.log('Then open this link and approve the connection (expires in 30 minutes, single use):')
console.log(`  ${fnUrl}?setup=${setupToken}`)
console.log('')
