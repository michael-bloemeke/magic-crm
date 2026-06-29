// Syncs a read-only snapshot to Vercel Blob for the phone app. The blob holds
// { auth: sha256("mcrm:"+passcode), data: <snapshot> }. The deployed /api/snapshot function fetches
// this blob and only returns `data` when the caller sends the matching passcode, so the full-data
// snapshot is never exposed without the code. The blob path itself is random/unguessable, and its URL
// lives only in the function's env + here (never in the public app), as defense in depth.
//
// Config (gitignored push... mobile-config.json): { passcode, blobPath }. The passcode is editable
// (desktop Settings) and just changes what we upload next, so no redeploy is needed to rotate it.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { put } from '@vercel/blob'
import { buildSnapshot } from './crm-snapshot.mjs'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_FILE = path.join(DIR, 'mobile-config.json')

function readJson(file, fb) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fb
  }
}
// The blob read/write token already used by the portal's serverless functions.
function blobToken() {
  try {
    const txt = fs.readFileSync(path.join(DIR, 'portal', '.env.local'), 'utf8')
    const m = txt.match(/^BLOB_READ_WRITE_TOKEN=(.*)$/m)
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : ''
  } catch {
    return ''
  }
}
function blobBaseUrl() {
  return (readJson(path.join(DIR, 'portal-credentials.json'), {}).blobBaseUrl || '').replace(/\/$/, '')
}

export function passcodeHash(code) {
  return crypto.createHash('sha256').update('mcrm:' + String(code)).digest('hex')
}

// True once mobile has been set up (config exists). Used to gate the background auto-sync so it
// never runs for a user who hasn't connected the phone app.
export function isMobileConfigured() {
  try {
    return fs.existsSync(CONFIG_FILE)
  } catch {
    return false
  }
}

function writeConfig(c) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ passcode: c.passcode, blobPath: c.blobPath, subsPath: c.subsPath }, null, 2) + '\n')
}

// Read config, generating a 6-digit passcode + unguessable blob paths (snapshot + push subs) once.
export function getMobileConfig() {
  const c = readJson(CONFIG_FILE, {})
  let changed = false
  if (!c.passcode) {
    c.passcode = String(Math.floor(100000 + Math.random() * 900000))
    changed = true
  }
  if (!c.blobPath) {
    c.blobPath = 'mobile/snap-' + crypto.randomBytes(12).toString('hex') + '.json'
    changed = true
  }
  if (!c.subsPath) {
    c.subsPath = 'mobile/subs-' + crypto.randomBytes(12).toString('hex') + '.json'
    changed = true
  }
  if (changed) writeConfig(c)
  const base = blobBaseUrl()
  return {
    passcode: c.passcode,
    blobPath: c.blobPath,
    subsPath: c.subsPath,
    snapshotUrl: base ? base + '/' + c.blobPath : '',
    subsUrl: base ? base + '/' + c.subsPath : '',
  }
}

export function setMobilePasscode(code) {
  const c = getMobileConfig()
  writeConfig({ passcode: String(code), blobPath: c.blobPath, subsPath: c.subsPath })
  return getMobileConfig()
}

// Build the snapshot, wrap it with the passcode hash, and upload (overwrite) to the blob.
export async function syncMobileSnapshot() {
  const c = getMobileConfig()
  const token = blobToken()
  if (!token) return { ok: false, error: 'No BLOB_READ_WRITE_TOKEN found in portal/.env.local' }
  const payload = JSON.stringify({ auth: passcodeHash(c.passcode), data: buildSnapshot(), syncedAt: new Date().toISOString() })
  const r = await put(c.blobPath, payload, {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
    token,
  })
  return { ok: true, url: r.url, bytes: payload.length }
}
