// Client portal data layer (CRM-owned). Holds per-project portal SETTINGS in
// crm-portal.json and builds the CURATED, client-safe bundle that gets published to
// the public host. The portal is the first public, client-facing surface, so the
// guardrail here is a HARD WHITELIST: only the fields in SHAREABLE_FIELDS can ever
// leave the Mac. Pricing, notes, activity log, mileage, tips, contact internals,
// and anything in the other crm-*.json files are structurally impossible to publish
// because the bundle only ever copies whitelisted fields, never the raw record.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { RECORDS_DIR, loadAll } from './crm-data-core.mjs'
import { questionnaireForBundle } from './crm-questionnaire.mjs'
import { readFile as readBusinessFile } from './crm-files.mjs'

const PORTAL_FILE = path.join(RECORDS_DIR, 'crm-portal.json')

// The static portal site that gets deployed (magic-crm/portal/). Curated bundles
// are written into its data/ dir, one per token, then the folder is pushed to
// Vercel. The production alias is stable across deploys, so client links never change.
const PORTAL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'portal')
const PORTAL_DATA_DIR = path.join(PORTAL_DIR, 'data')
// Selected business files are copied here per token so the static portal can serve them at
// /files/<token>/<name> (behind the secret link; robots.txt disallows the whole site).
const PORTAL_FILES_DIR = path.join(PORTAL_DIR, 'files')
export const PORTAL_BASE_URL = 'https://portal-liard-phi.vercel.app'

// The ONLY project fields a portal may expose. `id` matches the normalized Project
// field; `label` is what the client sees. Adding a field here is the deliberate way
// to make it shareable; nothing else can be.
export const SHAREABLE_FIELDS = [
  { id: 'eventSummary', label: 'About the event' },
  { id: 'eventType', label: 'Event type' },
  { id: 'eventDate', label: 'Event date' },
  { id: 'eventStartTime', label: 'Event start' },
  { id: 'showStartTime', label: 'Show start' },
  { id: 'eventLocation', label: 'Location' },
  { id: 'venueType', label: 'Venue' },
  { id: 'indoorsOrOutdoors', label: 'Indoors / Outdoors' },
  { id: 'performanceStyle', label: 'Performance' },
  { id: 'numberOfGuests', label: 'Guest count' },
  { id: 'ageOfGuests', label: 'Guest ages' },
  { id: 'av', label: 'A/V notes' },
  { id: 'vips', label: 'VIPs / guests of honor' },
  { id: 'eventDescription', label: 'Event description' },
  { id: 'bookingSource', label: 'Booking source' },
]
const SHAREABLE_IDS = new Set(SHAREABLE_FIELDS.map((f) => f.id))

function meta() {
  return {
    file: 'crm-portal.json',
    owner: 'Magic CRM app (~/Desktop/Claude/magic-crm)',
    purpose:
      'CRM-owned client-portal SETTINGS per project (token, what is shared, the intro message). The published portal only ever contains the curated whitelist of client-safe fields, never the raw record.',
    cowork_guidance: 'Safe to read. The CRM manages this file. Do NOT delete or overwrite.',
    shape:
      'portals[projectId] = { token, published, sharedFields[], assetIds[], links{video,reviews,...}, message, accessCode?, expiresAt?, lastPublishedAt }',
  }
}

function readPortalFile() {
  let data
  try {
    data = JSON.parse(fs.readFileSync(PORTAL_FILE, 'utf8'))
  } catch {
    data = null
  }
  if (!data || typeof data.portals !== 'object' || data.portals === null) data = { portals: {} }
  return data
}
function writePortalFile(data) {
  try {
    data._meta = meta()
    fs.writeFileSync(PORTAL_FILE, JSON.stringify(data, null, 2) + '\n')
  } catch (e) {
    console.error('[crm-portal] could not write crm-portal.json:', e?.message || e)
  }
}

// A long, unguessable, URL-safe token. ~24 chars from 18 random bytes (base64url).
function genToken() {
  return crypto.randomBytes(18).toString('base64url')
}

function defaults() {
  return { token: genToken(), published: false, sharedFields: [], assetIds: [], links: {}, message: '', lastPublishedAt: '' }
}

export function loadPortals() {
  return readPortalFile().portals
}
export function loadPortal(projectId) {
  return readPortalFile().portals[projectId] || null
}

// Upsert settings for a project. A token is generated once and never changes (so a
// shared link stays valid). Only whitelisted field ids are accepted into sharedFields.
export function savePortal({ projectId, patch = {} } = {}) {
  if (!projectId) throw new Error('projectId is required')
  const data = readPortalFile()
  const cur = data.portals[projectId] || defaults()
  const next = { ...cur }
  if (Array.isArray(patch.sharedFields)) next.sharedFields = patch.sharedFields.filter((id) => SHAREABLE_IDS.has(id))
  if (Array.isArray(patch.assetIds)) next.assetIds = patch.assetIds.map(String)
  if (patch.links && typeof patch.links === 'object') next.links = patch.links
  if (patch.message != null) next.message = String(patch.message)
  if (patch.accessCode != null) next.accessCode = String(patch.accessCode)
  if (patch.expiresAt !== undefined) next.expiresAt = patch.expiresAt || ''
  if (typeof patch.published === 'boolean') {
    next.published = patch.published
    if (patch.published) next.lastPublishedAt = new Date().toISOString()
  }
  if (!next.token) next.token = genToken()
  data.portals[projectId] = next
  writePortalFile(data)
  return next
}

export function publishPortal(projectId) {
  return savePortal({ projectId, patch: { published: true } })
}
export function unpublishPortal(projectId) {
  return savePortal({ projectId, patch: { published: false } })
}

// The curated, client-safe bundle for one project. This is the ONLY thing that ever
// gets published. Returns null if not published, expired, or missing. By
// construction it copies only whitelisted fields the project actually has AND that
// Michael has toggled on, plus his message and any link fields. The access code is
// intentionally NOT included (it would defeat the purpose to ship it client-side).
export function buildBundle(projectId) {
  const settings = loadPortal(projectId)
  if (!settings || !settings.published) return null
  if (settings.expiresAt && Date.parse(settings.expiresAt) && Date.now() > Date.parse(settings.expiresAt)) return null
  const project = loadAll().projects.find((p) => p.id === projectId)
  if (!project) return null

  const shared = new Set((settings.sharedFields || []).filter((id) => SHAREABLE_IDS.has(id)))
  const fields = []
  for (const f of SHAREABLE_FIELDS) {
    if (!shared.has(f.id)) continue
    const v = project[f.id]
    if (v == null || String(v).trim() === '') continue
    fields.push({ label: f.label, value: String(v) })
  }

  // Files Michael chose to share (from the Files page). The actual bytes are copied into the
  // deploy by writeBundleFile; here we just list name + the URL the portal will fetch.
  const assetNames = Array.isArray(settings.assetIds) ? settings.assetIds.map(String) : []
  const files = assetNames.map((name) => ({ name, url: `/files/${settings.token}/${encodeURIComponent(name)}` }))

  return {
    token: settings.token,
    projectName: String(project.client || ''),
    eventType: String(project.eventType || ''),
    message: String(settings.message || ''),
    fields,
    files,
    links: settings.links && typeof settings.links === 'object' ? settings.links : {},
    // Optional client questionnaire (just the questions + intro; never any answers). Null
    // when Michael hasn't turned it on for this project.
    questionnaire: questionnaireForBundle(projectId),
    expiresAt: settings.expiresAt || null,
    publishedAt: settings.lastPublishedAt || null,
  }
}

// Resolve a bundle by its public token (what the portal host will call). No index,
// no enumeration: a token maps to exactly one project's published bundle or nothing.
export function bundleForToken(token) {
  if (!token) return null
  const portals = loadPortals()
  for (const [projectId, s] of Object.entries(portals)) {
    if (s && s.token === token) return buildBundle(projectId)
  }
  return null
}

// Write (or remove) the curated bundle file the static portal serves. Published ->
// write portal/data/<token>.json; not published/expired -> delete it so the link 404s.
export function writeBundleFile(projectId) {
  const settings = loadPortal(projectId)
  if (!settings) return { ok: false, error: 'no portal settings' }
  const file = path.join(PORTAL_DATA_DIR, `${settings.token}.json`)
  const filesDir = path.join(PORTAL_FILES_DIR, settings.token)
  const bundle = buildBundle(projectId)
  try {
    fs.mkdirSync(PORTAL_DATA_DIR, { recursive: true })
    // Rewrite this token's shared files from scratch each publish (so removed ones go away).
    fs.rmSync(filesDir, { recursive: true, force: true })
    if (bundle) {
      fs.writeFileSync(file, JSON.stringify(bundle, null, 2) + '\n')
      if (Array.isArray(bundle.files) && bundle.files.length) {
        fs.mkdirSync(filesDir, { recursive: true })
        for (const f of bundle.files) {
          const src = readBusinessFile(f.name)
          if (src && src.buffer) fs.writeFileSync(path.join(filesDir, src.name), src.buffer)
        }
      }
    } else if (fs.existsSync(file)) {
      fs.unlinkSync(file)
    }
    return { ok: true, token: settings.token, live: !!bundle }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
}

// Push the static portal folder to Vercel production (so the latest bundles go
// live). The production alias is stable, so we just confirm success. ~20-40s.
export function deployPortal() {
  return new Promise((resolve) => {
    execFile('vercel', ['--cwd', PORTAL_DIR, 'deploy', '--prod', '--yes'], { timeout: 180000 }, (err, stdout, stderr) => {
      const out = `${stdout || ''}\n${stderr || ''}`
      const m = out.match(/https:\/\/[a-z0-9-]+\.vercel\.app/i)
      if (err && !m) {
        resolve({ ok: false, error: String(stderr || err.message || 'deploy failed').trim().slice(-400) })
      } else {
        resolve({ ok: true, url: PORTAL_BASE_URL })
      }
    })
  })
}
