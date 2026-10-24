// SHOW BUILDER: the Mac's data layer (2026-10-24).
//
// Michael's standalone Show Builder app (`show builder/`, Electron) keeps one JSON file per show,
// trick, tag, music cue, "other" item and audio file in ~/Documents/Show Builder/. On 2026-10-24 he
// had a copy built into the CRM so it works on his phone too, starting from that app's data. The CRM's
// copy lives entirely in Supabase:
//
//   table  show_builder (id, kind, data jsonb, created_at, updated_at)   `data` = one app JSON file
//   bucket show-builder  audio/<storedFilename>                          the uploaded audio
//
// The Mac page (src/showbuilder/) is the standalone app's own React code; where it used to call Electron
// (window.showBuilder.saveTrick ...) it now calls /api/show-builder/*, which lands here. The phone
// talks to the same table directly (mobile/supabase-data.js, the "show builder" block).
//
// The shape of every document, and the rules (order, runtime, props), are in
// mobile/showbuilder-core.js, shared with the phone so the two can never disagree.
//
// ⚠️ TWO SEPARATE THINGS. The standalone app carries on as its own project and may go its own way;
// nothing here reads or writes ~/Documents/Show Builder/, and nothing there reaches the CRM. Michael,
// 2026-10-24: "I want everything to just be self-contained within the CRM."
//
// Cascades kept from the standalone app: deleting a TAG removes it from every trick; deleting an AUDIO file
// removes the file and clears it from any music cue that used it. Deleting a trick, music cue or
// other item leaves any node that pointed at it empty ("Click to assign"), exactly as before.

import { randomUUID } from 'node:crypto'
import { sb } from './crm-store.mjs'
import { KINDS, normalizeDoc, sortDocs, packingId } from './mobile/showbuilder-core.js'

export { normalizeDoc }
export { cleanShow } from './mobile/showbuilder-core.js'

const BUCKET = 'show-builder'

function checkKind(kind) {
  if (!KINDS.includes(kind)) throw new Error('Unknown Show Builder kind: ' + kind)
}

export async function listDocs(kind) {
  checkKind(kind)
  const { data, error } = await sb().from('show_builder').select('data').eq('kind', kind)
  if (error) throw error
  const docs = (data || []).map((r) => normalizeDoc(kind, r.data))
  if (kind === 'show') {
    // The home list only needs the name and dates; the canvas loads the full show when opened.
    return sortDocs(kind, docs).map((s) => ({ id: s.id, name: s.name, createdAt: s.createdAt, updatedAt: s.updatedAt, count: s.nodes.length }))
  }
  return sortDocs(kind, docs)
}

export async function getDoc(kind, id) {
  checkKind(kind)
  const { data, error } = await sb().from('show_builder').select('data').eq('kind', kind).eq('id', String(id)).maybeSingle()
  if (error) throw error
  return data ? normalizeDoc(kind, data.data) : null
}

export async function saveDoc(kind, doc) {
  checkKind(kind)
  const clean = normalizeDoc(kind, { ...doc, updatedAt: new Date().toISOString() })
  const { error } = await sb().from('show_builder').upsert({
    id: clean.id, kind, data: clean, created_at: clean.createdAt, updated_at: clean.updatedAt,
  })
  if (error) throw error
  return clean
}

export async function deleteDoc(kind, id) {
  checkKind(kind)
  id = String(id)
  if (kind === 'audio') {
    const meta = await getDoc('audio', id)
    if (meta && meta.storedFilename) await sb().storage.from(BUCKET).remove([`audio/${meta.storedFilename}`])
    for (const m of await listDocs('music')) {
      if (m.audioFileId === id) await saveDoc('music', { ...m, audioFileId: null })
    }
  }
  if (kind === 'tag') {
    for (const t of await listDocs('trick')) {
      if ((t.tagIds || []).includes(id)) await saveDoc('trick', { ...t, tagIds: t.tagIds.filter((x) => x !== id) })
    }
  }
  // A show's packing ticks (the phone's Packing tab) go with it.
  if (kind === 'show') await sb().from('show_builder').delete().eq('kind', 'packing').eq('id', packingId(id))
  const { error } = await sb().from('show_builder').delete().eq('kind', kind).eq('id', id)
  if (error) throw error
  return { ok: true }
}

// ---- audio ----
//
// Upload is two steps so a 30 MB WAV goes straight from the page to storage instead of through this
// server: (1) audioUploadStart hands back a signed upload URL, the page PUTs the file to it, then
// (2) audioUploadFinish records the metadata, the standalone app's <id>.audio.json.

const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac']
function guessMime(ext) {
  return { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac' }[ext] || 'application/octet-stream'
}

export async function audioUploadStart({ filename }) {
  const name = String(filename || '').trim()
  const ext = (name.match(/\.([a-z0-9]+)$/i) || ['', ''])[1].toLowerCase()
  if (!AUDIO_EXT.includes(ext)) throw new Error('Pick an audio file (mp3, wav, m4a, ogg, flac or aac).')
  const id = randomUUID()
  const storedFilename = `${id}.${ext}`
  const { data, error } = await sb().storage.from(BUCKET).createSignedUploadUrl(`audio/${storedFilename}`)
  if (error) throw error
  return { id, storedFilename, mimeType: guessMime(ext), signedUrl: data.signedUrl }
}

export async function audioUploadFinish({ id, storedFilename, originalFilename, mimeType, size }) {
  const now = new Date().toISOString()
  const base = String(originalFilename || '').replace(/\.[^.]+$/, '') || String(originalFilename || '')
  return saveDoc('audio', { id, displayName: base, originalFilename, storedFilename, mimeType, size, createdAt: now, updatedAt: now })
}

export async function audioRename(id, displayName) {
  const meta = await getDoc('audio', id)
  if (!meta) return null
  return saveDoc('audio', { ...meta, displayName: String(displayName || '').trim() || meta.displayName })
}

// A short-lived link the <audio> element can play. The page asks /api/show-builder/audio/<id>, which
// redirects here, so a link never goes stale inside a page that stays open for hours.
export async function audioPlayUrl(id) {
  const meta = await getDoc('audio', id)
  if (!meta) throw new Error('No such audio file.')
  const { data, error } = await sb().storage.from(BUCKET).createSignedUrl(`audio/${meta.storedFilename}`, 60 * 60)
  if (error) throw error
  return data.signedUrl
}
