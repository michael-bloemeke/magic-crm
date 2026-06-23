// Vercel serverless function: catches a client's questionnaire submission and stores it in
// Vercel Blob as responses/<token>.json (latest submission wins). The CRM (local) later polls
// the public blob URL to pull the answers in. The write token (BLOB_READ_WRITE_TOKEN) is set
// automatically when the Blob store is connected to this project; it lives only here, never on
// the client and never in the CRM. Same-origin POST from the portal page, so no CORS needed.

import { put } from '@vercel/blob'

async function readBody(req) {
  if (req.body != null) return typeof req.body === 'string' ? JSON.parse(req.body) : req.body
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }
  try {
    const body = await readBody(req)

    // Honeypot: bots fill hidden fields. Pretend success and discard.
    if (body && body._hp) {
      res.status(200).json({ ok: true })
      return
    }

    const token = String(body?.token || '').trim()
    // The portal token is base64url; reject anything that isn't, and cap the length.
    if (!token || token.length > 100 || /[^A-Za-z0-9_-]/.test(token)) {
      res.status(400).json({ error: 'Invalid link.' })
      return
    }

    const answers = Array.isArray(body?.answers)
      ? body.answers.slice(0, 100).map((a) => ({
          id: String(a?.id || '').slice(0, 200),
          label: String(a?.label || '').slice(0, 500),
          value: String(a?.value == null ? '' : a.value).slice(0, 5000),
        }))
      : []
    if (!answers.length) {
      res.status(400).json({ error: 'No answers were submitted.' })
      return
    }

    const record = { token, answers, submittedAt: new Date().toISOString() }
    await put(`responses/${token}.json`, JSON.stringify(record), {
      access: 'public',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: 'application/json',
    })

    res.status(200).json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) })
  }
}
