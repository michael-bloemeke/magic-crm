// GMAIL, FROM THE CLOUD. The read half of what `send-email` already does for sending.
//
// WHY THIS EXISTS. Michael, 2026-09-21: "I want to read and send emails... I want to be able to see
// notifications when I have unread emails." Sending already worked from the phone, because
// `send-email` runs on Supabase. Reading did not, because every read path in this CRM lives in
// `crm-gmail.mjs`, which is a Node module loaded by the Vite dev plugin. That code only runs while
// the MacBook is awake with `npm run dev` going. A phone app that can only read email when the
// laptop is open is not a phone app.
//
// CREDENTIALS. The same `email_config` row `send-email` reads: one OAuth client plus one refresh
// token, service-role only. Verified 2026-09-21 that this is byte-for-byte the token the Mac uses
// (sha256 of both matched) and that it carries `gmail.modify`, so read and mark-read both work
// without Michael reconnecting anything.
//
// AUTH. Identical to `send-email`: verify_jwt is off so we control CORS, and the caller must
// present a valid logged-in Supabase user JWT, which we check with admin.auth.getUser. An
// unauthenticated caller gets 401 before a single Gmail byte is fetched.
//
// WHAT IT DELIBERATELY DOES NOT DO: decide which project an email belongs to. The phone already
// holds every contact and every project-contact link in memory, so matching a From address to a
// project is free there and would be a second, drifting copy of that logic here. This function is
// a thin, honest Gmail proxy and nothing more.
import { createClient } from 'jsr:@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
}

// Gmail returns base64url with no padding, and the payload is UTF-8 bytes. atob gives us a binary
// string, so it has to go back through TextDecoder or every non-ASCII character (a curly quote in a
// client's signature, an accented name) comes out as mojibake.
function decodeB64Url(data: string): string {
  const b64 = String(data || '').replace(/-/g, '+').replace(/_/g, '/')
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
  try {
    const bin = atob(b64 + pad)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new TextDecoder('utf-8').decode(bytes)
  } catch {
    return ''
  }
}

function stripHtml(html: string): string {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // A marketing email is a table layout, and stripping its tags leaves the indentation that held
    // it together: the first real one tested came back as 8,320 characters of which almost none
    // were words. Trim every line, then collapse the blank ones, so what lands on the phone is the
    // text a human wrote rather than the shape of the HTML it arrived in.
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Walk a MIME tree for the readable body. text/plain wins when it exists, because it is what the
// sender's client generated for exactly this purpose; text/html is stripped only as a fallback.
// Attachments are skipped (they have a filename and no inline data worth reading).
function bodyOf(payload: any): string {
  let plain = ''
  let html = ''
  const walk = (part: any) => {
    if (!part) return
    const mime = String(part.mimeType || '')
    const data = part.body?.data
    if (data && !part.filename) {
      if (mime === 'text/plain' && !plain) plain = decodeB64Url(data)
      else if (mime === 'text/html' && !html) html = decodeB64Url(data)
    }
    ;(part.parts || []).forEach(walk)
  }
  walk(payload)
  const text = plain ? plain.replace(/\r\n/g, '\n') : stripHtml(html)
  // Trim the quoted chain. Everything below "On <date>, <person> wrote:" is a message he has
  // already read, and on a phone it is the difference between a screen and ten screens.
  return text
    .replace(/\n*On .{10,120}wrote:[\s\S]*$/, '')
    .replace(/\n*-{2,}\s*Forwarded message\s*-{2,}[\s\S]*$/i, '')
    .trim()
}

function header(headers: any[], name: string): string {
  const h = (headers || []).find((x) => String(x.name || '').toLowerCase() === name.toLowerCase())
  return h ? String(h.value || '') : ''
}

// "Jane Doe <jane@x.com>" -> { name: 'Jane Doe', email: 'jane@x.com' }. A bare address gets the
// address as its own name, so the UI never has to render an empty line.
function parseAddr(raw: string): { name: string; email: string } {
  const s = String(raw || '').trim()
  const m = /^(.*?)\s*<([^>]+)>$/.exec(s)
  if (m) return { name: m[1].replace(/^"|"$/g, '').trim() || m[2].trim(), email: m[2].trim().toLowerCase() }
  return { name: s, email: s.toLowerCase() }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405)

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
  if (!jwt) return json({ ok: false, error: 'Not signed in.' }, 401)
  const { data: userData, error: userErr } = await admin.auth.getUser(jwt)
  if (userErr || !userData?.user) return json({ ok: false, error: 'Invalid session.' }, 401)

  let payload: any
  try { payload = await req.json() } catch { return json({ ok: false, error: 'Bad JSON.' }, 400) }
  const action = String(payload.action || 'list')

  const { data: cfg, error: cfgErr } = await admin.from('email_config').select('*').eq('id', 1).single()
  if (cfgErr || !cfg) return json({ ok: false, error: 'Email is not configured.' }, 500)

  const tokRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.client_id,
      client_secret: cfg.client_secret,
      refresh_token: cfg.refresh_token,
      grant_type: 'refresh_token',
    }),
  })
  const tok = await tokRes.json()
  if (!tokRes.ok || !tok.access_token) return json({ ok: false, error: 'Gmail auth failed.' }, 502)
  const auth = { Authorization: `Bearer ${tok.access_token}` }
  const api = (path: string) => `https://gmail.googleapis.com/gmail/v1/users/me/${path}`

  try {
    // ---- list: thread summaries for a Gmail search ----
    //
    // `q` is a Gmail query, passed through. The phone sends `is:unread in:inbox` for the badge and
    // `from:<client> OR to:<client>` for a project's correspondence, so one endpoint serves both
    // the inbox page and the per-project thread list.
    if (action === 'list') {
      // `q` may be ONE query or SEVERAL. Several, because the phone's inbox is scoped to the email
      // addresses of the contacts on his ACTIVE projects, and that address list does not fit in a
      // single Gmail query: Gmail caps a query at about 2k characters and thirty-odd addresses
      // written twice (from: and to:) blows straight past it. The caller chunks the addresses and
      // sends one query per chunk; they are run in parallel and merged here, so the phone still
      // makes a single round trip and still gets one ordered list back.
      const rawQ = payload.q
      const queries: string[] = (Array.isArray(rawQ) ? rawQ : [rawQ || 'in:inbox'])
        .map((x: unknown) => String(x || '').slice(0, 2000))
        .filter(Boolean)
        .slice(0, 12)
      if (!queries.length) return json({ ok: true, threads: [], resultSize: 0 })
      const max = Math.min(Math.max(Number(payload.max) || 25, 1), 50)

      const lists = await Promise.all(queries.map(async (q) => {
        const r = await fetch(api(`messages?q=${encodeURIComponent(q)}&maxResults=${max}`), { headers: auth })
        if (!r.ok) {
          // One bad chunk must not take the whole inbox down. The rest still render, and the next
          // refresh retries; a short list beats an error page.
          console.warn('[gmail] list chunk failed:', q.slice(0, 120), r.status)
          return { messages: [], resultSizeEstimate: 0 }
        }
        return await r.json()
      }))

      const ids: string[] = []
      const seenIds = new Set<string>()
      let estimate = 0
      for (const list of lists) {
        estimate += Number(list.resultSizeEstimate) || 0
        for (const m of list.messages || []) {
          if (seenIds.has(m.id)) continue // a message can match more than one chunk
          seenIds.add(m.id)
          ids.push(m.id)
        }
      }
      if (!ids.length) return json({ ok: true, threads: [], resultSize: 0 })

      // Metadata only: From / To / Subject / Date plus Gmail's own snippet. That is everything a
      // list row shows, at a fifth of the payload of a full fetch, and it means opening the inbox
      // never downloads message bodies nobody asked to read.
      const metas = await Promise.all(ids.map(async (id) => {
        const r = await fetch(
          api(`messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`),
          { headers: auth },
        )
        return r.ok ? await r.json() : null
      }))

      // Collapse to one row per THREAD, keeping the newest message in each. Gmail's message list is
      // per-message, so a five-reply exchange would otherwise fill the whole screen with one
      // conversation.
      const byThread = new Map<string, any>()
      for (const m of metas) {
        if (!m) continue
        const hs = m.payload?.headers || []
        const from = parseAddr(header(hs, 'From'))
        const row = {
          id: m.id,
          threadId: m.threadId,
          from: from.name,
          fromEmail: from.email,
          to: (header(hs, 'To') || '').split(',').map((x) => parseAddr(x).email).filter(Boolean),
          subject: header(hs, 'Subject') || '(no subject)',
          date: header(hs, 'Date'),
          ts: Number(m.internalDate) || 0,
          snippet: String(m.snippet || '').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&'),
          unread: (m.labelIds || []).includes('UNREAD'),
          labels: m.labelIds || [],
        }
        const prev = byThread.get(row.threadId)
        if (!prev || row.ts > prev.ts) byThread.set(row.threadId, { ...row, unread: row.unread || !!prev?.unread })
        else if (row.unread) prev.unread = true
      }
      const threads = [...byThread.values()].sort((a, b) => b.ts - a.ts)
      // The count is the number of THREADS actually resolved, not Gmail's estimate. Across several
      // chunked queries the estimates overlap and cannot be added up honestly, and the caller uses
      // this number for a badge. Capped-out results are signalled by `capped` instead of guessed at.
      return json({
        ok: true,
        threads,
        resultSize: threads.length,
        estimate,
        capped: ids.length >= max * queries.length,
      })
    }

    // ---- thread: every message in one conversation, with bodies ----
    if (action === 'thread') {
      const threadId = String(payload.threadId || '')
      if (!threadId) return json({ ok: false, error: 'threadId is required.' }, 400)
      const r = await fetch(api(`threads/${threadId}?format=full`), { headers: auth })
      const t = await r.json()
      if (!r.ok) return json({ ok: false, error: t?.error?.message || 'Gmail thread failed.' }, 502)
      const messages = (t.messages || []).map((m: any) => {
        const hs = m.payload?.headers || []
        const from = parseAddr(header(hs, 'From'))
        return {
          id: m.id,
          from: from.name,
          fromEmail: from.email,
          to: (header(hs, 'To') || '').split(',').map((x) => parseAddr(x).email).filter(Boolean),
          subject: header(hs, 'Subject'),
          date: header(hs, 'Date'),
          ts: Number(m.internalDate) || 0,
          unread: (m.labelIds || []).includes('UNREAD'),
          body: bodyOf(m.payload),
        }
      })
      const subject = messages.length ? messages[0].subject || '(no subject)' : '(no subject)'
      return json({ ok: true, threadId, subject, messages })
    }

    // ---- markRead: drop the UNREAD label from a whole thread ----
    //
    // Thread-level, not message-level: he opened the conversation, so the conversation is read.
    // Marking only the newest message would leave the thread bold in Gmail on his laptop, and the
    // two views would disagree about what he has seen.
    if (action === 'markRead') {
      const threadId = String(payload.threadId || '')
      if (!threadId) return json({ ok: false, error: 'threadId is required.' }, 400)
      const r = await fetch(api(`threads/${threadId}/modify`), {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
      })
      if (!r.ok) {
        const e = await r.json().catch(() => ({}))
        return json({ ok: false, error: e?.error?.message || 'Could not mark read.' }, 502)
      }
      return json({ ok: true })
    }

    return json({ ok: false, error: `Unknown action: ${action}` }, 400)
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message ?? e) }, 500)
  }
})
