// HOME LIST: the big things Michael is working on, one row per item in `home_list` (Supabase).
//
// Michael, 2026-10-24: "the major elements of my business that I'm working on that still need to be
// done. The things that are hanging over my head." It sits under everything else on Home, on the Mac
// and the phone. No due date, no checkbox, and it is NOT a task.
//
// 2026-10-31 he asked for rename, reorder, and indenting an item under the one above, like a bulleted
// list (Enter for a new bullet, Tab to indent). So each row now has a `position` (the order) and a
// `depth` (the indent level), and the outline rules live in mobile/homelist-core.js, shared with the
// phone. This file only reads and writes rows.
//
// ⚠️ THE PHONE HAS A TWIN OF THIS FILE in mobile/supabase-data.js (the "home list" block). Same row
// shape. Change one, change both.
//
// Read straight from Supabase on every call (like crm-shows.mjs), not through crm-data-core's cache, so
// an item added on the phone is on the Mac at the next refresh. The table carries the data_version
// trigger, which is what tells the phone to reload after a Mac edit.

import { sb } from './crm-store.mjs'

const str = (v) => (v == null ? '' : String(v))

const numOrNull = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

function fromRow(r) {
  return { id: str(r.id), text: str(r.text), createdAt: str(r.created_at), position: numOrNull(r.position), depth: Number(r.depth) || 0 }
}

// In outline order: by position, then by when it was added.
export async function loadHomeList() {
  const { data, error } = await sb()
    .from('home_list')
    .select('*')
    .order('position', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true })
  if (error) throw error
  return (data || []).map(fromRow)
}

// `position` and `depth` place it (an Enter in the middle of the list); without them it goes at the
// bottom, top level (the database default puts it last).
export async function addHomeListItem(text, opts = {}) {
  const t = str(text).trim()
  if (!t) throw new Error('Type the item first.')
  const row = { text: t }
  if (numOrNull(opts.position) != null) row.position = Number(opts.position)
  if (numOrNull(opts.depth) != null) row.depth = Math.max(0, Math.min(3, Math.round(Number(opts.depth))))
  const { data, error } = await sb().from('home_list').insert(row).select('*').single()
  if (error) throw error
  return fromRow(data)
}

export async function renameHomeListItem(id, text) {
  const t = str(text).trim()
  if (!id) throw new Error('Item id is required.')
  if (!t) throw new Error('An item needs some text.')
  const { error } = await sb().from('home_list').update({ text: t }).eq('id', id)
  if (error) throw error
  return { ok: true }
}

// The new order and indents after a move or an indent: [{ id, position, depth }], only the rows that
// changed (homelist-core.layoutChanges).
export async function saveHomeListLayout(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && r.id)
  const results = await Promise.all(
    list.map((r) =>
      sb()
        .from('home_list')
        .update({ position: numOrNull(r.position), depth: Math.max(0, Math.min(3, Math.round(Number(r.depth) || 0))) })
        .eq('id', r.id),
    ),
  )
  const failed = results.find((x) => x.error)
  if (failed) throw failed.error
  return { ok: true, saved: list.length }
}

export async function deleteHomeListItem(id) {
  if (!id) throw new Error('Item id is required.')
  const { error } = await sb().from('home_list').delete().eq('id', id)
  if (error) throw error
  return { ok: true }
}
