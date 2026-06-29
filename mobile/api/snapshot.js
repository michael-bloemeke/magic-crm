// Returns the read-only CRM snapshot ONLY when the caller sends the right passcode. The snapshot
// lives in Vercel Blob (uploaded by the Mac) at an unguessable URL kept in SNAP_BLOB_URL (never in
// the public app). We fetch it, check sha256("mcrm:"+code) against the stored hash, and return the
// data or 401. Rotating the passcode just changes what the Mac uploads; no redeploy needed.

import crypto from 'node:crypto'

function passcodeHash(code) {
  return crypto.createHash('sha256').update('mcrm:' + String(code)).digest('hex')
}

export default async function handler(req, res) {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow')
  res.setHeader('Cache-Control', 'no-store')
  try {
    const url = process.env.SNAP_BLOB_URL
    if (!url) {
      res.status(503).json({ error: 'Snapshot not configured yet.' })
      return
    }
    const code = String((req.query && req.query.code) || '')
    const r = await fetch(url, { cache: 'no-store' })
    if (!r.ok) {
      res.status(502).json({ error: 'Snapshot unavailable.' })
      return
    }
    const blob = await r.json()
    if (!code || passcodeHash(code) !== blob.auth) {
      res.status(401).json({ error: 'Wrong passcode.' })
      return
    }
    res.status(200).json(blob.data)
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) })
  }
}
