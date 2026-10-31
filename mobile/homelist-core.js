// "ON MY PLATE" AS AN OUTLINE: the shared rules (2026-10-31).
//
// Michael: "make it so that I can rename or reorder any item in the list... and a feature to be able
// to make an item a sort of subset of another item... kind of like how in a bulleted list, if I press
// the enter key, it'll make a new line with a new bullet. But if I press the tab key, it would indent
// that bullet, so it's kind of like a component of the previous bullet point."
//
// The list is FLAT in the database (`home_list`: position + depth), drawn as an outline. An item's
// children are the items right after it with a greater depth, so moving or indenting an item carries
// its children with it, the way an outliner behaves.
//
// ONE FILE, THREE READERS: the phone app (app.js), the Mac (src/components/HomePage.tsx, typed by
// homelist-core.d.ts) and the phone tests. Every function is pure: it takes the list and returns a
// new one, so the caller decides what to save. Change a rule here and both apps follow.

export const MAX_DEPTH = 3
const STEP = 1000

const num = (v, d) => (v == null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v))

// The order the list is drawn in: by position, then (for rows an older app build added without one)
// by when they were added.
export function sortItems(items) {
  return (items || []).slice().sort((a, b) => {
    const pa = num(a.position, Infinity), pb = num(b.position, Infinity)
    if (pa !== pb) return pa < pb ? -1 : 1
    return String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
  })
}

// Every depth made legal: the first item is top level, and nothing sits more than one level deeper
// than the item above it (a child needs a parent). Run after every change.
export function normalize(items) {
  let prev = -1
  return (items || []).map((x) => {
    let d = Math.round(num(x.depth, 0))
    d = Math.max(0, Math.min(MAX_DEPTH, d, prev + 1))
    prev = d
    return d === x.depth ? x : { ...x, depth: d }
  })
}

const at = (items, id) => items.findIndex((x) => x.id === id)

// One past the last of the item's children (the end of its "block").
export function blockEnd(items, i) {
  let j = i + 1
  while (j < items.length && items[j].depth > items[i].depth) j++
  return j
}

function shiftBlock(items, i, by) {
  const end = blockEnd(items, i)
  return items.map((x, k) => (k >= i && k < end ? { ...x, depth: x.depth + by } : x))
}

// Tab: becomes a child of the item above. Not possible for the first item, for an item already a
// child of the one above, or when a grandchild would go past MAX_DEPTH.
export function canIndent(items, id) {
  const i = at(items, id)
  if (i <= 0) return false
  if (items[i].depth > items[i - 1].depth) return false
  const end = blockEnd(items, i)
  for (let k = i; k < end; k++) if (items[k].depth + 1 > MAX_DEPTH) return false
  return true
}
export function indent(items, id) {
  return canIndent(items, id) ? normalize(shiftBlock(items, at(items, id), 1)) : items
}

// Shift+Tab: one level out, children and all.
export function canOutdent(items, id) {
  const i = at(items, id)
  return i >= 0 && items[i].depth > 0
}
export function outdent(items, id) {
  return canOutdent(items, id) ? normalize(shiftBlock(items, at(items, id), -1)) : items
}

// The previous item at the same level under the same parent, or -1.
function prevSibling(items, i) {
  for (let k = i - 1; k >= 0; k--) {
    if (items[k].depth < items[i].depth) return -1
    if (items[k].depth === items[i].depth) return k
  }
  return -1
}

// Up and down swap an item (with its children) past its neighbour at the same level. An item never
// leaves its parent this way; outdent it first to do that.
export function canMoveUp(items, id) {
  const i = at(items, id)
  return i >= 0 && prevSibling(items, i) >= 0
}
export function moveUp(items, id) {
  const i = at(items, id)
  const k = i >= 0 ? prevSibling(items, i) : -1
  if (k < 0) return items
  const end = blockEnd(items, i)
  return [...items.slice(0, k), ...items.slice(i, end), ...items.slice(k, i), ...items.slice(end)]
}
export function canMoveDown(items, id) {
  const i = at(items, id)
  if (i < 0) return false
  const end = blockEnd(items, i)
  return end < items.length && items[end].depth === items[i].depth
}
export function moveDown(items, id) {
  if (!canMoveDown(items, id)) return items
  const i = at(items, id)
  const end = blockEnd(items, i)
  const end2 = blockEnd(items, end)
  return [...items.slice(0, i), ...items.slice(end, end2), ...items.slice(i, end), ...items.slice(end2)]
}

// Enter: a new item right after this one's block, at the same level. With no id it goes at the
// bottom, top level (the "Add an item" box).
export function insertAfter(items, id, item) {
  const i = id ? at(items, id) : -1
  if (i < 0) return normalize([...items, { ...item, depth: 0 }])
  const end = blockEnd(items, i)
  return normalize([...items.slice(0, end), { ...item, depth: items[i].depth }, ...items.slice(end)])
}

// Deleting an item leaves its children in place; normalize pulls them out a level if they lost
// their parent.
export function removeItem(items, id) {
  return normalize(items.filter((x) => x.id !== id))
}

export function rename(items, id, text) {
  return items.map((x) => (x.id === id ? { ...x, text } : x))
}

// Positions 1000, 2000, 3000... in the order shown. Renumbering every time keeps them clean.
export function withPositions(items) {
  return items.map((x, k) => (x.position === (k + 1) * STEP ? x : { ...x, position: (k + 1) * STEP }))
}

// What actually has to be written after a change: only the rows whose position or depth moved.
export function layoutChanges(before, after) {
  const was = new Map((before || []).map((x) => [x.id, x]))
  return (after || [])
    .filter((x) => {
      const w = was.get(x.id)
      return !w || w.position !== x.position || w.depth !== x.depth
    })
    .map((x) => ({ id: x.id, position: x.position, depth: x.depth }))
}
