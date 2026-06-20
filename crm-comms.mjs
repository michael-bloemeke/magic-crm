// Communications layer for the CRM.
//
// When Gmail is connected (token present), this reads + sends real email via
// crm-gmail.mjs. Until then it serves DEMO data so the tab is usable. Claude
// drafting is still a built-in voice template until an Anthropic key is added.

import { loadAll } from './crm-data-core.mjs'
import {
  resolveProjectEmails,
  emailsForProject,
  contactsForProject as linkedContactsForProject,
} from './crm-links.mjs'
import {
  isConnected as gmailConnected,
  credentialsPresent,
  searchThreads,
  inboxSearch,
  sendMessage,
  createDraft,
  markThreadRead,
  hasModifyScope,
} from './crm-gmail.mjs'

export function isGmailConnected() {
  return gmailConnected()
}
export function isClaudeConnected() {
  return false // flip true once an Anthropic API key is configured
}

const MICHAEL = 'michael@michaelbloemeke.com'

function firstName(s) {
  const n = String(s || '').trim().split(/\s+/)[0] || ''
  return n.replace(/[^A-Za-z'-].*$/, '') || 'there'
}
function dateOf(entry) {
  const m = String(entry || '').match(/^([A-Za-z]+ \d{1,2}, \d{4})/)
  return m ? m[1] : ''
}
function fmtDate(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return ''
  const [y, m, d] = iso.split('-').map(Number)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${months[m - 1]} ${d}, ${y}`
}
function getProject(projectId) {
  return loadAll().projects.find((p) => p.id === projectId) || null
}

// emails + the lead contact's name come from the project's LINKED contacts now,
// not the project's contact_* strings, so what shows here follows whoever is
// attached to the project (the Gmail-style model).
function demoThreads(p, emails, leadName) {
  const email = emails[0] || '(no email on file)'
  const name = (leadName || '').trim() || email
  const fname = firstName(leadName)
  const logDates = (p.activityLog || []).map(dateOf).filter(Boolean)
  const d1 = logDates[logDates.length - 1] || fmtDate(p.eventDate) || 'Earlier'
  const d2 = logDates[0] || fmtDate(p.eventDate) || 'Recently'
  return [
    {
      id: `${p.id}-t1`,
      subject: `Magic for our ${p.eventType.toLowerCase()} event`,
      participants: [email, MICHAEL],
      lastDate: d2,
      messages: [
        {
          from: email,
          fromName: name,
          date: d1,
          body: `Hi Michael,\n\nWe'd love to have you for our event. Can you share availability and what the experience would look like?\n\nThanks,\n${fname}`,
        },
        {
          from: MICHAEL,
          fromName: 'Michael Bloemeke',
          date: d2,
          body: `Hi ${fname},\n\nThank you for reaching out! I'd love to be a part of it. I'll send over a few details and we can find a time to chat.\n\nThanks!`,
        },
      ],
    },
    {
      id: `${p.id}-t2`,
      subject: `Re: ${p.client} - planning details`,
      participants: [email, MICHAEL],
      lastDate: d2,
      messages: [
        {
          from: email,
          fromName: name,
          date: d2,
          body: `Quick question on timing and what you need from us the day of. Let me know!`,
        },
      ],
    },
  ]
}

export async function loadThreads(projectId) {
  const p = getProject(projectId)
  if (!p)
    return { connected: false, hasCredentials: credentialsPresent(), demo: true, contacts: [], threads: [], noEmail: true }

  const emails = emailsForProject(p.id) // real addresses of the project's linked contacts
  const leadName = (linkedContactsForProject(p.id)[0]?.name || '').trim()

  if (gmailConnected()) {
    if (emails.length === 0) {
      return { connected: true, hasCredentials: true, demo: false, contacts: [], threads: [], noEmail: true }
    }
    try {
      const threads = await searchThreads(emails)
      return { connected: true, hasCredentials: true, demo: false, canMarkRead: hasModifyScope(), contacts: emails, threads }
    } catch (e) {
      return {
        connected: true,
        hasCredentials: true,
        demo: false,
        contacts: emails,
        threads: [],
        error: String(e?.message || e),
      }
    }
  }

  return {
    connected: false,
    hasCredentials: credentialsPresent(),
    demo: true,
    contacts: emails,
    threads: demoThreads(p, emails, leadName),
    noEmail: emails.length === 0,
  }
}

// Inbox: every thread touching a contact on any ACTIVE project, newest first,
// each tagged with the project it belongs to. Mail unrelated to the pipeline is
// filtered out because we only search the active projects' contact addresses.
//
// A successful connected result is cached briefly: building it fetches many
// Gmail threads, and the page re-requests on every mount, so without a cache a
// quick nav-away-and-back would re-run the whole fetch.
let _inboxCache = null
let _inboxCacheTs = 0
const INBOX_TTL_MS = 30000

export async function loadInbox() {
  if (gmailConnected() && _inboxCache && Date.now() - _inboxCacheTs < INBOX_TTL_MS) {
    return _inboxCache
  }
  const active = loadAll().projects.filter((p) => p.bucket === 'active')

  // email (lowercased) -> { id, client }, resolved from each project's linked contacts
  const idx = resolveProjectEmails()
  const emailToProject = {}
  for (const p of active) {
    for (const e of idx[p.id] || []) {
      if (!emailToProject[e]) emailToProject[e] = { id: p.id, client: p.client }
    }
  }
  const emails = Object.keys(emailToProject)

  if (!gmailConnected()) {
    // Demo inbox: a few sample threads so the page is not empty before connecting.
    const demo = active.slice(0, 4).flatMap((p) =>
      demoThreads(p, idx[p.id] || [], linkedContactsForProject(p.id)[0]?.name || '')
        .slice(0, 1)
        .map((t) => ({ ...t, project: { id: p.id, client: p.client } })),
    )
    return { connected: false, hasCredentials: credentialsPresent(), demo: true, count: demo.length, threads: demo }
  }

  if (emails.length === 0) {
    return { connected: true, hasCredentials: true, demo: false, count: 0, threads: [] }
  }

  try {
    const threads = await inboxSearch(emails)
    const tagged = threads.map((t) => {
      const hit = (t.participants || []).map((e) => String(e).toLowerCase()).find((e) => emailToProject[e])
      return { ...t, project: hit ? emailToProject[hit] : null }
    })
    // searchThreads already sorts newest-first; keep that order.
    const result = { connected: true, hasCredentials: true, demo: false, canMarkRead: hasModifyScope(), count: tagged.length, threads: tagged }
    _inboxCache = result
    _inboxCacheTs = Date.now()
    return result
  } catch (e) {
    return { connected: true, hasCredentials: true, demo: false, count: 0, threads: [], error: String(e?.message || e) }
  }
}

// Demo draft in Michael's voice (real Claude drafting comes with the Anthropic key).
export function draftReply({ projectId }) {
  const fname = firstName(linkedContactsForProject(projectId)[0]?.name || '')
  const draft = `Hi ${fname},\n\nThanks for the note! Everything's on track on my end. I'll get the next details over to you shortly, and let me know if any questions come up in the meantime.\n\nThanks!\nMichael`
  return { draft, demo: !isClaudeConnected() }
}

function invalidateInbox() {
  _inboxCacheTs = 0
}

// Mark a thread read in Gmail. Returns {ok:false, needsReconnect} if the token
// lacks the modify scope (so the UI can offer a one-time reconnect).
export async function markRead({ threadId }) {
  if (!gmailConnected()) return { ok: true, demo: true }
  try {
    await markThreadRead(threadId)
    invalidateInbox()
    return { ok: true }
  } catch (e) {
    const msg = String(e?.message || e)
    return { ok: false, error: msg, needsReconnect: /insufficient|scope|permission/i.test(msg) }
  }
}

export async function sendEmail({ projectId, threadId, to, subject, body, mode }) {
  if (gmailConnected()) {
    const p = getProject(projectId)
    let subj = subject || `Re: ${p?.client || 'your event'}`
    if (!/^re:/i.test(subj)) subj = subj // leave caller's subject as-is
    if (mode === 'draft') {
      const r = await createDraft({ to, subject: subj, body, threadId })
      return { ok: true, demo: false, mode: 'draft', id: r.id }
    }
    const r = await sendMessage({ to, subject: subj, body, threadId })
    // Replying clears the unread flag (best-effort; needs the modify scope).
    if (threadId) {
      try {
        await markThreadRead(threadId)
      } catch {
        // ignore; the send still succeeded
      }
      invalidateInbox()
    }
    return { ok: true, demo: false, mode: 'send', id: r.id }
  }
  return { ok: true, demo: true, mode: mode || 'send' }
}
