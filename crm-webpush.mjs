// Sends Web Push notifications to the phone app (the Magic CRM PWA), so alerts come FROM the app and
// land on the lock screen. Subscriptions are collected by the deployed /api/subscribe function into a
// blob; here we read them and push via VAPID. Self-contained (reads its own config files, imports no
// other crm-* modules) to avoid an import cycle with crm-notifications/crm-push/crm-snapshot.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import webpush from 'web-push'
import { put } from '@vercel/blob'

const DIR = path.dirname(fileURLToPath(import.meta.url))
function readJson(f) {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch {
    return null
  }
}
const vapid = () => readJson(path.join(DIR, 'push-vapid.json'))
const mobileConfig = () => readJson(path.join(DIR, 'mobile-config.json')) || {}
function blobBase() {
  const c = readJson(path.join(DIR, 'portal-credentials.json')) || {}
  return (c.blobBaseUrl || '').replace(/\/$/, '')
}
function blobToken() {
  try {
    const t = fs.readFileSync(path.join(DIR, 'portal', '.env.local'), 'utf8')
    const m = t.match(/^BLOB_READ_WRITE_TOKEN=(.*)$/m)
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : ''
  } catch {
    return ''
  }
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
function subsUrl() {
  const c = mobileConfig()
  const b = blobBase()
  return c.subsPath && b ? b + '/' + c.subsPath : ''
}
async function readSubs() {
  const u = subsUrl()
  if (!u) return []
  try {
    const r = await fetch(u, { cache: 'no-store' })
    if (!r.ok) return []
    const d = await r.json()
    return Array.isArray(d) ? d : []
  } catch {
    return []
  }
}
async function writeSubs(subs) {
  const c = mobileConfig()
  const token = blobToken()
  if (!c.subsPath || !token) return
  try {
    await put(c.subsPath, JSON.stringify(subs), { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json', token })
  } catch {
    /* best-effort */
  }
}

export function webPushReady() {
  const v = vapid()
  const c = mobileConfig()
  return !!(v && v.privateKey && c.subsPath)
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
  if (dead.length) await writeSubs(subs.filter((s) => dead.indexOf(s.endpoint) < 0))
  return { ok: true, sent: subs.length - dead.length, pruned: dead.length }
}
