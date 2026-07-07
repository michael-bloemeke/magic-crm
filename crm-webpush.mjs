// Sends Web Push notifications to the phone app (the Magic CRM PWA), so alerts come FROM the app and
// land on the lock screen. The phone subscribes after logging in and UPSERTs its subscription into the
// Supabase `push_subscriptions` table (RLS-gated). Here we read those rows (with the SECRET key, which
// bypasses RLS) and push via VAPID. Self-contained: reads its own config files and creates its own
// Supabase client inline (imports no other crm-* module) to avoid an import cycle with
// crm-notifications/crm-push/crm-snapshot and to stay out of crm-store.mjs.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import webpush from 'web-push'
import { createClient } from '@supabase/supabase-js'

const DIR = path.dirname(fileURLToPath(import.meta.url))
function readJson(f) {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch {
    return null
  }
}
const vapid = () => readJson(path.join(DIR, 'push-vapid.json'))

// Supabase client with the SECRET key (bypasses RLS so we can read every device's subscription and
// prune dead ones). Built lazily + cached; returns null if creds are missing so callers can no-op.
let _sb = null
let _sbTried = false
function sb() {
  if (_sbTried) return _sb
  _sbTried = true
  const c = readJson(path.join(DIR, 'supabase-credentials.json'))
  if (!c || !c.url || !c.secretKey) return null
  try {
    _sb = createClient(c.url, c.secretKey, { auth: { persistSession: false, autoRefreshToken: false } })
  } catch {
    _sb = null
  }
  return _sb
}

let configured = false
function ensure() {
  if (configured) return true
  const v = vapid()
  if (!v || !v.publicKey || !v.privateKey) return false
  webpush.setVapidDetails(v.subject || 'mailto:mchlbloemeke@gmail.com', v.publicKey, v.privateKey)
  configured = true
  return true
}

// Read every subscription row from Supabase. Returns an array of the raw PushSubscription objects
// (the `subscription` jsonb column), each tagged with its endpoint so we can prune dead ones. Never
// throws (best-effort): returns [] on any error.
async function readSubs() {
  const client = sb()
  if (!client) return []
  try {
    const { data, error } = await client.from('push_subscriptions').select('endpoint,subscription')
    if (error || !Array.isArray(data)) return []
    return data
      .map((r) => (r && r.subscription ? r.subscription : null))
      .filter((s) => s && s.endpoint)
  } catch {
    return []
  }
}

// Remove subscriptions the push service reported as gone (410/404), keyed by endpoint. Best-effort.
async function pruneSubs(endpoints) {
  if (!endpoints || !endpoints.length) return
  const client = sb()
  if (!client) return
  try {
    await client.from('push_subscriptions').delete().in('endpoint', endpoints)
  } catch {
    /* best-effort */
  }
}

export function webPushReady() {
  const v = vapid()
  return !!(v && v.privateKey && sb())
}

// Best-effort: push to every subscribed phone; prune subscriptions the push service reports as gone.
export async function sendWebPush(payload) {
  if (!ensure()) return { ok: false, skipped: true }
  const subs = await readSubs()
  if (!subs.length) return { ok: true, sent: 0 }
  const body = JSON.stringify(payload || {})
  const dead = []
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(s, body)
      } catch (e) {
        const code = e && e.statusCode
        if (code === 404 || code === 410) dead.push(s.endpoint)
      }
    }),
  )
  if (dead.length) await pruneSubs(dead)
  return { ok: true, sent: subs.length - dead.length, pruned: dead.length }
}
