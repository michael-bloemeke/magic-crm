// HOME LIST: the big things Michael is working on, one row per item in `home_list` (Supabase).
//
// Michael, 2026-10-24: "the major elements of my business that I'm working on that still need to be
// done. The things that are hanging over my head." It sits under everything else on Home, on the Mac
// and the phone. He asked for exactly two actions: add an item (just its name) and delete it. No due
// date, no checkbox, no rename, and it is NOT a task. Keep it that way unless he asks.
//
// ⚠️ THE PHONE HAS A TWIN OF THIS FILE in mobile/supabase-data.js (the "home list" block). Same row
// shape. Change one, change both.
//
// Read straight from Supabase on every call (like crm-shows.mjs), not through crm-data-core's cache, so
// an item added on the phone is on the Mac at the next refresh. The table carries the data_version
// trigger, which is what tells the phone to reload after a Mac edit.

import { sb } from './crm-store.mjs'

const str = (v) => (v == null ? '' : String(v))

function fromRow(r) {
  return { id: str(r.id), text: str(r.text), createdAt: str(r.created_at) }
}

// Oldest first: a new item goes to the bottom, the way you write a list.
export async function loadHomeList() {
  const { data, error } = await sb().from('home_list').select('*').order('created_at', { ascending: true })
  if (error) throw error
  return (data || []).map(fromRow)
}

export async function addHomeListItem(text) {
  const t = str(text).trim()
  if (!t) throw new Error('Type the item first.')
  const { data, error } = await sb().from('home_list').insert({ text: t }).select('*').single()
  if (error) throw error
  return fromRow(data)
}

export async function deleteHomeListItem(id) {
  if (!id) throw new Error('Item id is required.')
  const { error } = await sb().from('home_list').delete().eq('id', id)
  if (error) throw error
  return { ok: true }
}
