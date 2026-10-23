// SHOWS: set lists and packing lists, one row per show in `shows` (Supabase).
//
// Michael, 2026-10-23: "a page to help me organize my packing list and my show structures." A show
// has a name and two lists:
//   set_list      [{ id, text }]                                     the running order, top to bottom
//   packing_list  [{ id, type: 'item' | 'header' | 'blank', text, done }]
// Only an 'item' has a checkbox. A 'header' is a bold label for a group, a 'blank' is an empty line
// to separate groups. The checkmarks live in the row, so packing on the phone shows on the Mac.
//
// It deliberately does not touch projects or anything else yet. The separate show-builder app
// (`show builder/`) may be folded in later; this is the simple version he asked for first.
//
// ⚠️ THE PHONE HAS A TWIN OF THIS FILE in mobile/supabase-data.js (the "shows" block). Same row
// shape, same normalising. Change one, change both.
//
// Checking a box and "Uncheck all" re-read the row before writing, so a tick on one device never
// rolls back an edit saved on the other a moment earlier.

import { randomUUID } from 'node:crypto'
import { sb } from './crm-store.mjs'

const str = (v) => (v == null ? '' : String(v))
const TYPES = ['item', 'header', 'blank']

function cleanSetList(list) {
  return (Array.isArray(list) ? list : [])
    .map((x) => ({ id: str(x && x.id) || randomUUID(), text: str(x && x.text).trim() }))
    .filter((x) => x.text)
}
function cleanPackingList(list) {
  return (Array.isArray(list) ? list : [])
    .map((x) => {
      const type = TYPES.includes(x && x.type) ? x.type : 'item'
      return {
        id: str(x && x.id) || randomUUID(),
        type,
        text: type === 'blank' ? '' : str(x && x.text).trim(),
        done: type === 'item' ? !!(x && x.done) : false,
      }
    })
    .filter((x) => x.type === 'blank' || x.text)
}
function fromRow(r) {
  return {
    id: str(r.id),
    name: str(r.name),
    setList: cleanSetList(r.set_list),
    packingList: cleanPackingList(r.packing_list),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  }
}

export async function loadShows() {
  const { data, error } = await sb().from('shows').select('*').order('created_at', { ascending: true })
  if (error) throw error
  return (data || []).map(fromRow)
}

export async function createShow(name) {
  const n = str(name).trim()
  if (!n) throw new Error('Give the show a name.')
  const { data, error } = await sb().from('shows').insert({ name: n }).select('*').single()
  if (error) throw error
  return fromRow(data)
}

// patch: { name?, setList?, packingList? }. Lists are replaced whole (that is what Done does).
export async function updateShow(id, patch = {}) {
  if (!id) throw new Error('Show id is required.')
  const row = { updated_at: new Date().toISOString() }
  if (patch.name != null) {
    const n = str(patch.name).trim()
    if (!n) throw new Error('Give the show a name.')
    row.name = n
  }
  if (patch.setList != null) row.set_list = cleanSetList(patch.setList)
  if (patch.packingList != null) row.packing_list = cleanPackingList(patch.packingList)
  const { data, error } = await sb().from('shows').update(row).eq('id', id).select('*').single()
  if (error) throw error
  return fromRow(data)
}

// One checkbox, against the CURRENT row.
export async function setPacked(id, itemId, done) {
  const { data: cur, error: e1 } = await sb().from('shows').select('packing_list').eq('id', id).maybeSingle()
  if (e1) throw e1
  if (!cur) throw new Error('Show not found.')
  const list = cleanPackingList(cur.packing_list).map((x) => (x.id === itemId && x.type === 'item' ? { ...x, done: !!done } : x))
  return updateShow(id, { packingList: list })
}

// "Uncheck all": every box back to empty, the list itself untouched.
export async function uncheckAll(id) {
  const { data: cur, error: e1 } = await sb().from('shows').select('packing_list').eq('id', id).maybeSingle()
  if (e1) throw e1
  if (!cur) throw new Error('Show not found.')
  return updateShow(id, { packingList: cleanPackingList(cur.packing_list).map((x) => ({ ...x, done: false })) })
}

// An exact copy, named "Copy of <name>" (Michael's wording, 2026-10-23): the same set list and the
// same packing list, checkmarks and all. Every line gets a fresh id so the two never share one.
export async function duplicateShow(id) {
  const { data: cur, error: e1 } = await sb().from('shows').select('*').eq('id', id).maybeSingle()
  if (e1) throw e1
  if (!cur) throw new Error('Show not found.')
  const row = {
    name: `Copy of ${str(cur.name).trim()}`,
    set_list: cleanSetList(cur.set_list).map((x) => ({ ...x, id: randomUUID() })),
    packing_list: cleanPackingList(cur.packing_list).map((x) => ({ ...x, id: randomUUID() })),
  }
  const { data, error } = await sb().from('shows').insert(row).select('*').single()
  if (error) throw error
  return fromRow(data)
}

export async function deleteShow(id) {
  if (!id) throw new Error('Show id is required.')
  const { error } = await sb().from('shows').delete().eq('id', id)
  if (error) throw error
  return { ok: true, id }
}
