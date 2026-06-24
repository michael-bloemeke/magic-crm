// Vercel serverless function: receives a submission from the website contact form and appends it
// to a single public Blob file (inquiries.json) that the local CRM polls. The write token
// (BLOB_READ_WRITE_TOKEN) is set on this project's env; the CRM only ever reads the public file.
//
// CORS is open (it's a public contact form) and a honeypot field drops bots. The marketing site
// can be hosted anywhere (Vercel, Cloudflare, ...) and just POSTs JSON here.

import { put } from '@vercel/blob'

// This store's fixed public base (same Blob store as the questionnaire). Used to read the current
// list before appending.
const BLOB_BASE = 'https://mtrjlkb3ogplcpdc.public.blob.vercel-storage.com'
const FILE = 'inquiries.json'
const MAX_KEEP = 500 // cap the relay file; the CRM imports within minutes, so old entries can roll off

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

async function readBody(req) {
  if (req.body != null) return typeof req.body === 'string' ? JSON.parse(req.body) : req.body
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

const str = (v, max = 4000) => String(v == null ? '' : v).slice(0, max).trim()

export default async function handler(req, res) {
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v)
  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }
  try {
    const b = await readBody(req)
    if (b && b._hp) {
      res.status(200).json({ ok: true }) // honeypot: pretend success, discard
      return
    }
    const inquiry = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
      submittedAt: new Date().toISOString(),
      name: str(b?.name, 200),
      email: str(b?.email, 200),
      phone: str(b?.phone, 60),
      eventDate: str(b?.eventDate, 60),
      eventTime: str(b?.eventTime, 120),
      guests: str(b?.guests, 120),
      ages: str(b?.ages, 120),
      source: str(b?.source, 120),
      venue: str(b?.venue, 400),
      showTypes: Array.isArray(b?.showTypes) ? b.showTypes.map((x) => str(x, 80)).filter(Boolean).join(', ') : str(b?.showTypes, 300),
      message: str(b?.message, 5000),
    }
    if (!inquiry.email && !inquiry.name) {
      res.status(400).json({ error: 'Please include at least a name or email.' })
      return
    }

    // Append to the existing list (read fresh; the file is written with no CDN cache).
    let list = []
    try {
      const cur = await fetch(`${BLOB_BASE}/${FILE}`, { cache: 'no-store' })
      if (cur.ok) {
        const d = await cur.json()
        if (Array.isArray(d)) list = d
      }
    } catch {
      // start fresh if it can't be read
    }
    list.push(inquiry)
    if (list.length > MAX_KEEP) list = list.slice(-MAX_KEEP)

    await put(FILE, JSON.stringify(list), {
      access: 'public',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: 'application/json',
      cacheControlMaxAge: 0, // so the CRM (and the next append) always read the latest
    })

    res.status(200).json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) })
  }
}
