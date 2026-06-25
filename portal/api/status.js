// Vercel serverless function: reports whether a portal token has ALREADY submitted its
// questionnaire. The portal page calls this to decide whether to show the one-time questionnaire
// gate or the portal itself. "Submitted" is durable because /api/submit stores the answers in
// Vercel Blob as responses/<token>.json; here we just check whether that blob exists. Same-origin
// GET from the portal page, so no CORS needed. The blob token (BLOB_READ_WRITE_TOKEN) is set
// automatically when the Blob store is connected; it lives only here.

import { list } from '@vercel/blob'

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }
  try {
    let token = ''
    try {
      token = String(new URL(req.url, 'http://x').searchParams.get('token') || '').trim()
    } catch {
      token = ''
    }
    // The portal token is base64url; reject anything that isn't, and cap the length.
    if (!token || token.length > 100 || /[^A-Za-z0-9_-]/.test(token)) {
      res.status(400).json({ error: 'Invalid link.' })
      return
    }

    const pathname = `responses/${token}.json`
    const { blobs } = await list({ prefix: pathname, limit: 1 })
    const submitted = Array.isArray(blobs) && blobs.some((b) => b.pathname === pathname)

    res.setHeader('Cache-Control', 'no-store')
    res.status(200).json({ submitted })
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) })
  }
}
