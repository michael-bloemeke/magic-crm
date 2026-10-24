// The Show Builder's data calls, inside the CRM (2026-10-24).
//
// In the standalone app these were `window.showBuilder.*`, Electron IPC into a main process that
// read and wrote JSON files in ~/Documents/Show Builder/. Inside the CRM the same methods, with the
// same names and the same shapes, go to /api/show-builder/* (crm-data-plugin.mjs ->
// crm-showbuilder.mjs -> Supabase), which is what lets the phone see and edit the same shows.
//
// Kept deliberately as a drop-in: every screen in this folder is the old app's own code with
// `window.showBuilder` swapped for `sbApi`. Nothing else about them changed.

import { useEffect } from 'react'
import type { Show, ShowSummary, Trick, Tag, AudioFile, Music, Other } from './types'

async function call<T>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`/api/show-builder/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok || json.error) throw new Error(json.error || `Show Builder ${action} failed (${res.status}).`)
  return json as T
}

const list = <T,>(kind: string) => call<{ docs: T[] }>('list', { kind }).then((r) => r.docs)
const get = <T,>(kind: string, id: string) => call<{ doc: T | null }>('get', { kind, id }).then((r) => r.doc)
const save = <T,>(kind: string, doc: T) => call<{ doc: T }>('save', { kind, doc }).then((r) => r.doc)
const del = (kind: string, id: string) => call<{ ok: boolean }>('delete', { kind, id }).then(() => undefined)

// The old app opened a native macOS picker from the main process. Here it is a hidden file input,
// clicked synchronously so it still counts as the click that asked for it.
function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.style.display = 'none'
    document.body.appendChild(input)
    const done = (f: File | null) => { input.remove(); resolve(f) }
    input.addEventListener('change', () => done(input.files && input.files[0] ? input.files[0] : null))
    input.addEventListener('cancel', () => done(null))
    input.click()
  })
}

async function uploadAudioFile(): Promise<AudioFile | null> {
  const file = await pickFile('audio/*,.mp3,.wav,.m4a,.ogg,.flac,.aac')
  if (!file) return null
  const start = await call<{ id: string; storedFilename: string; mimeType: string; signedUrl: string }>('audio-upload', { filename: file.name })
  // Straight to storage: a 30 MB WAV never passes through the local server.
  const put = await fetch(start.signedUrl, {
    method: 'PUT',
    headers: { 'content-type': file.type || start.mimeType, 'x-upsert': 'false' },
    body: file,
  })
  if (!put.ok) throw new Error(`Uploading ${file.name} failed (${put.status}).`)
  return call<{ doc: AudioFile }>('audio-finish', {
    id: start.id,
    storedFilename: start.storedFilename,
    originalFilename: file.name,
    mimeType: file.type || start.mimeType,
    size: file.size,
  }).then((r) => r.doc)
}

export const sbApi = {
  // Shows
  listShows: () => list<ShowSummary>('show'),
  loadShow: (id: string) => get<Show>('show', id),
  // Returns the saved show as the server stored it, so the canvas can tell later whether the copy in
  // the cloud has moved on (an edit from the phone) since it last saved.
  saveShow: (show: Show) => save<Show>('show', show),
  deleteShow: (id: string) => del('show', id),

  // Tricks
  listTricks: () => list<Trick>('trick'),
  loadTrick: (id: string) => get<Trick>('trick', id),
  saveTrick: (trick: Trick) => save<Trick>('trick', trick),
  deleteTrick: (id: string) => del('trick', id),

  // Tags
  listTags: () => list<Tag>('tag'),
  saveTag: (tag: Tag) => save<Tag>('tag', tag),
  deleteTag: (id: string) => del('tag', id),

  // Audio files
  listAudioFiles: () => list<AudioFile>('audio'),
  uploadAudioFile,
  renameAudioFile: (id: string, displayName: string) => call<{ doc: AudioFile | null }>('audio-rename', { id, displayName }).then((r) => r.doc),
  deleteAudioFile: (id: string) => del('audio', id),
  // What an <audio> element plays. The server answers with a short-lived signed link to storage.
  audioUrl: (id: string) => `/api/show-builder/audio/${encodeURIComponent(id)}`,

  // Music
  listMusic: () => list<Music>('music'),
  loadMusic: (id: string) => get<Music>('music', id),
  saveMusic: (music: Music) => save<Music>('music', music),
  deleteMusic: (id: string) => del('music', id),

  // Others
  listOthers: () => list<Other>('other'),
  loadOther: (id: string) => get<Other>('other', id),
  saveOther: (other: Other) => save<Other>('other', other),
  deleteOther: (id: string) => del('other', id),
}

// Re-read when the CRM window comes back to the front. The phone edits the same documents, and the
// Mac's lists (and an open canvas) would otherwise keep showing what they loaded at first.
export function useOnFocus(fn: () => void) {
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible') fn() }
    window.addEventListener('focus', fn)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.removeEventListener('focus', fn)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [fn])
}
