// Vercel serverless function: reports whether a booking-form token has ALREADY been submitted, so
// the form page can show "got it, thank you" instead of letting the client fill it in twice.
// "Submitted" is durable because /api/book-submit stores the answers in Vercel Blob as
// bookings/<token>.json; here we just check whether that blob exists.
//
// Same-origin GET from the booking page, so no CORS needed. The blob token
// (BLOB_READ_WRITE_TOKEN) is set automatically when the Blob store is connected; it lives only here.
// Note this deliberately returns only a boolean: the answers themselves are never served back out.

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
    if (!token || token.length > 100 || /[^A-Za-z0-9_-]/.test(token)) {
      res.status(400).json({ error: 'Invalid link.' })
      return
    }

    const pathname = `bookings/${token}.json`
    const { blobs } = await list({ prefix: pathname, limit: 1 })
    const submitted = Array.isArray(blobs) && blobs.some((b) => b.pathname === pathname)

    res.setHeader('Cache-Control', 'no-store')
    res.status(200).json({ submitted })
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) })
  }
}
