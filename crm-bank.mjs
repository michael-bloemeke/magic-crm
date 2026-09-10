// Bank balances: proxies the `bank-balances` Supabase Edge Function (which holds the YNAB token and
// talks to YNAB, which holds the read-only Plaid link to Coastal Federal Credit Union). Server-side
// only, so the token never reaches the browser.
//
// Read-only by design and by intent. Nothing in this path can move, deposit or withdraw money; the
// only thing it fetches is a balance per account. See the header of
// supabase/functions/bank-balances/index.ts for the full chain and the security reasoning.
//
// Until the YNAB_TOKEN secret is set the function returns { connected: false }, which flows straight
// through to the Finance page as a clean "not connected yet" card.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const creds = JSON.parse(fs.readFileSync(path.join(DIR, 'supabase-credentials.json'), 'utf8'))
const FN_URL = `${creds.url}/functions/v1/bank-balances`

// Balances only move when YNAB syncs the bank, which is a few times a day, and Michael explicitly
// said day-level freshness is fine. YNAB also caps a token at 200 requests an hour, so a long cache
// keeps the CRM well clear of that no matter how often the Finance page is opened.
const CACHE_MS = 15 * 60_000
let cache = { at: 0, data: null }

export async function loadBankBalances({ force = false } = {}) {
  if (!force && cache.data && Date.now() - cache.at < CACHE_MS) return cache.data
  try {
    const res = await fetch(FN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: creds.publishableKey,
        Authorization: `Bearer ${creds.publishableKey}`,
      },
      body: '{}',
      signal: AbortSignal.timeout(30_000),
    })
    const data = await res.json()
    cache = { at: Date.now(), data }
    return data
  } catch (e) {
    // Never throw to the UI; return a shape it already knows how to render.
    return {
      ok: true,
      connected: false,
      accounts: [],
      reason: String(e?.message || e),
      generatedAt: new Date().toISOString(),
    }
  }
}
