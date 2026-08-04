// Lock-screen push to Michael's iPhone via ntfy (https://ntfy.sh). The Mac publishes a short
// message to a PRIVATE, unguessable topic; the ntfy iOS app (subscribed to that topic) shows it on
// the lock screen, independently of the Mac once sent. Same privacy model as the client portal: a
// random token makes the topic effectively private. Best-effort: a failed push never breaks a save.
//
// Setup: Settings > Phone notifications shows the topic + subscribe link; install the ntfy app,
// subscribe to the topic, flip the toggle on. Config lives in push-config.json (gitignored).

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { loadAll, loadTasks } from './crm-data-core.mjs'
import { sendWebPush } from './crm-webpush.mjs'

// The deployed phone app, used as the tap target for web-push notifications. Moved off Vercel to
// michaelbloemeke.com/crm/ on 2026-08-03. The cloud sender reads the same value from
// push_config.app_url; keep the two in step or a tapped notification opens the wrong place.
const APP_URL = 'https://michaelbloemeke.com/crm/'

const CONFIG_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'push-config.json')
const DEFAULT_SERVER = 'https://ntfy.sh'

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  } catch {
    return null
  }
}
function writeConfig(c) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2) + '\n')
  } catch (e) {
    console.error('[crm-push] could not write push-config.json:', e?.message || e)
  }
}

// Read config, generating a random private topic on first use. Stays DISABLED until turned on in
// Settings, so nothing is published before the phone is subscribed.
export function getPushConfig() {
  const c = readConfig() || {}
  let changed = false
  if (!c.topic) {
    c.topic = 'magiccrm-' + crypto.randomBytes(18).toString('base64url')
    changed = true
  }
  if (typeof c.enabled !== 'boolean') {
    c.enabled = false
    changed = true
  }
  if (!c.server) {
    c.server = DEFAULT_SERVER
    changed = true
  }
  if (changed) writeConfig(c)
  return c
}

export function setPushConfig(patch = {}) {
  const c = getPushConfig()
  if (typeof patch.enabled === 'boolean') c.enabled = patch.enabled
  if (patch.server) c.server = String(patch.server)
  // Topic is regenerated, not hand-edited, to keep it unguessable.
  if (patch.regenerateTopic) c.topic = 'magiccrm-' + crypto.randomBytes(18).toString('base64url')
  writeConfig(c)
  return c
}

// The public ntfy URL someone subscribes to (also where the web app could deep-link later).
export function subscribeUrl(c = getPushConfig()) {
  return `${String(c.server || DEFAULT_SERVER).replace(/\/$/, '')}/${c.topic}`
}

// Low-level publish to ntfy's JSON API (handles unicode in titles/messages). Never throws.
export async function sendPush({ title, message, priority, tags, click } = {}, { force = false } = {}) {
  const c = getPushConfig()
  if ((!c.enabled && !force) || !c.topic) return { ok: false, skipped: true }
  try {
    const body = { topic: c.topic, message: String(message || '') }
    if (title) body.title = String(title)
    if (priority) body.priority = Number(priority)
    if (tags) body.tags = Array.isArray(tags) ? tags : [String(tags)]
    if (click) body.click = String(click)
    const res = await fetch(String(c.server || DEFAULT_SERVER).replace(/\/$/, ''), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { ok: res.ok, status: res.status }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
}

// Map a notification event to a lock-screen alert and publish it (fire-and-forget from callers).
// Client names are included (the topic is private); dollar amounts are intentionally left out.
export async function pushNotification(ev, count) {
  if (!ev || !ev.kind) return { ok: false, skipped: true }
  let who = 'a client'
  try {
    const p = loadAll().projects.find((x) => x.id === ev.projectId)
    if (p && p.client) who = p.client
  } catch {
    /* fall back to generic */
  }
  // A brand-new website inquiry carries the lead's name on the event itself (the project's client
  // name may not be set yet at push time); prefer that, then fall back to the project client lookup.
  const lead = (ev && ev.name && String(ev.name).trim()) || (who !== 'a client' ? who : '')
  let title = 'Magic CRM'
  let message = `Update for ${who}`
  let tags
  let priority = 3
  switch (ev.kind) {
    case 'new-inquiry':
      title = 'New inquiry!'
      message = lead ? `New website inquiry from ${lead}.` : 'A new inquiry just came in through the website.'
      // sparkles + party grab attention; max priority so it breaks through on the lock screen.
      tags = ['sparkles', 'tada']
      priority = 5
      break
    case 'contract-signed':
      title = 'Contract signed'
      message = `${who} signed their contract.`
      tags = ['inbox_tray']
      priority = 4
      break
    case 'contract-viewed':
      title = 'Contract viewed'
      message = `${who} viewed their contract.`
      tags = ['eyes']
      break
    case 'invoice-paid':
      title = 'Invoice paid'
      message = `${who} paid their invoice.`
      tags = ['moneybag']
      priority = 4
      break
    case 'task-due': {
      let t = null
      try {
        t = loadTasks().find((x) => x.id === ev.sourceId)
      } catch {
        /* ignore */
      }
      title = 'Task due'
      message = t ? `${t.title} — ${who}` : `Something is due for ${who}`
      tags = ['hourglass']
      break
    }
    default:
      break
  }
  // Push from the CRM app itself (web push to the phone), and to ntfy if it's still enabled.
  sendWebPush({ title, body: message, url: APP_URL, tag: ev.kind, count: typeof count === 'number' ? count : undefined }).catch(() => {})
  return sendPush({ title, message, tags, priority })
}
