// Stores a phone's Web Push subscription so the Mac can send it notifications. Passcode-gated (same
// hash check as /api/snapshot). Subscriptions live in a blob the Mac reads. Deduped by endpoint.

import crypto from 'node:crypto'
import { put } from '@vercel/blob'

function passcodeHash(code) {
  return crypto.createHash('sha256').update('mcrm:' + String(code)).digest('hex')
}

export default async function handler(req, res) {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow')
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' })
    return
  }
  try {
    const snapUrl = process.env.SNAP_BLOB_URL
    const subsUrl = process.env.SUBS_BLOB_URL
    const subsPath = process.env.SUBS_BLOB_PATH
    const token = process.env.BLOB_READ_WRITE_TOKEN
    if (!snapUrl || !subsPath || !token) {
      res.status(503).json({ error: 'Not configured.' })
      return
    }
    const body = req.body && typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}')
    const code = String(body.code || '')
    const sub = body.subscription
    if (!sub || !sub.endpoint) {
      res.status(400).json({ error: 'No subscription.' })
      return
    }
    // Authorize with the passcode (compared to the snapshot blob's stored hash).
    const sr = await fetch(snapUrl, { cache: 'no-store' })
    if (!sr.ok) {
      res.status(502).json({ error: 'Auth check failed.' })
      return
    }
    const snap = await sr.json()
    if (!code || passcodeHash(code) !== snap.auth) {
      res.status(401).json({ error: 'Wrong passcode.' })
      return
    }
    // Read current subs, dedup by endpoint, append, write back.
    let subs = []
    if (subsUrl) {
      try {
        const er = await fetch(subsUrl, { cache: 'no-store' })
        if (er.ok) {
          const d = await er.json()
          if (Array.isArray(d)) subs = d
        }
      } catch {
        subs = []
      }
    }
    subs = subs.filter((s) => s && s.endpoint !== sub.endpoint)
    subs.push(sub)
    await put(subsPath, JSON.stringify(subs), { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json', token })
    res.status(200).json({ ok: true, count: subs.length })
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) })
  }
}
