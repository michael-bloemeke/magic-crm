// Live website analytics: proxies the `website-analytics` Supabase Edge Function (which holds the
// Google service-account credential and talks to GA4 + Search Console), caching the result briefly so
// the CRM's Website page can poll without hammering Google's quota. Server-side only.
//
// The edge function is where the credential lives (Supabase secret GOOGLE_SA_KEY); this module never
// sees it. Until that secret is set the function returns { connected: false }, which flows straight
// through to the UI as a clean "not connected yet" state.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const creds = JSON.parse(fs.readFileSync(path.join(DIR, 'supabase-credentials.json'), 'utf8'))
const FN_URL = `${creds.url}/functions/v1/website-analytics`

// GA4 realtime is "last 30 min" and the day-level reports move slowly, so a short cache is plenty
// and keeps quota usage to ~1 upstream call/min even while the page polls.
const CACHE_MS = 60_000
let cache = { at: 0, data: null }

export async function loadAnalytics() {
  if (cache.data && Date.now() - cache.at < CACHE_MS) return cache.data
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
      ok: false,
      connected: false,
      error: String(e?.message || e),
      generatedAt: new Date().toISOString(),
    }
  }
}
