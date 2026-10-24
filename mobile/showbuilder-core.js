// THE SHOW BUILDER'S RULES, in one place, for the phone AND the Mac (2026-10-24).
//
// The CRM's Show Builder is a copy of Michael's standalone Show Builder app, built into the CRM with
// its own data. The standalone app stays a separate project; the two never sync. He asked for "a new
// page called Show Builder ... I can pick a show. I can move nodes around to create the flow of the
// show. I can open up any trick ... and I do want it to work on my phone."
//
// This file is pure logic with no imports, so it runs in the phone app (mobile/app.js), in the Mac's
// server (crm-showbuilder.mjs imports it from here), and in the tests. Everything that decides what a
// show IS lives here: the saved shape of each document, the running order, the runtime, the props
// list, and how the phone rewires the canvas when he reorders a show with his thumb.
//
// The Mac's canvas is the standalone app's React Flow code, copied into src/showbuilder/. Its own
// showUtils.ts keeps the order and duration functions it always had; the copies below are the same
// code. ⚠️ Change getShowOrder or parseDurationMinutes in one, change both.
//
// DATA SHAPE. It started as the JSON the standalone app writes to its files (its spec is in
// show builder/CLAUDE.md as of 2026-10-24), but THIS file defines it for the CRM from now on, since
// the app may change in its own direction. One document per row in the `show_builder` table (`data`
// is the document). In short:
//   show   { id, name, createdAt, updatedAt, showProps: string[], nodes: Node[], edges: Edge[] }
//   trick  { id, name, description, script, source, props: [{name, reusable}], duration, notes,
//            tagIds, preferredWidth?, preferredHeight?, createdAt, updatedAt }
//   music  { id, name, description, startCue, stopCue, audioFileId, ... }
//   other  { id, name, description, duration, color, props, preferredWidth?, preferredHeight?, ... }
//   tag    { id, name, color?, ... }
//   audio  { id, displayName, originalFilename, storedFilename, mimeType, size, ... }
// A node is { id, type: 'editable' | 'music' | 'other', position: {x, y}, data: { trickId | musicId |
// otherId, width?, height? } }. 'editable' is a TRICK node (the standalone app's name for it). An edge is
// React Flow's { id, source, sourceHandle, target, targetHandle, markerEnd }.

export const CANVAS_W = 2400
export const CANVAS_H = 1500
export const KINDS = ['show', 'trick', 'tag', 'music', 'other', 'audio', 'packing']
export const DEFAULT_OTHER_COLOR = '#7a8aa0'

// Default node sizes, from the standalone app's EditableNode.tsx.
const SIZE = { editable: [130, 130], music: [130, 70], other: [130, 130] }

const str = (v) => (v == null ? '' : String(v))
const nowIso = () => new Date().toISOString()

export function newId(prefix) {
  if (!prefix && typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `${prefix || 'id'}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

// ---------------------------------------------------------------------------
// Normalising, so every reader sees the canonical shape (ported from the standalone app's main process)
// ---------------------------------------------------------------------------

// Props: [{ name, reusable }]. Older files held plain strings or one comma/newline string.
export function normProps(raw) {
  if (Array.isArray(raw)) {
    return raw
      .map((p) => {
        if (typeof p === 'string') return p.trim() ? { name: p.trim(), reusable: false } : null
        if (p && typeof p === 'object' && typeof p.name === 'string' && p.name.trim()) return { name: p.name.trim(), reusable: !!p.reusable }
        return null
      })
      .filter(Boolean)
  }
  if (typeof raw === 'string' && raw.trim()) {
    return raw.split(/\r?\n|,/).map((s) => s.trim()).filter(Boolean).map((name) => ({ name, reusable: false }))
  }
  return []
}

// A remembered node size outside 40..800 is junk from the old drag-resizer era; drop it.
function saneDim(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 40 || v > 800) return undefined
  return Math.round(v)
}

function stamps(raw) {
  return { createdAt: str(raw && raw.createdAt) || nowIso(), updatedAt: str(raw && raw.updatedAt) || nowIso() }
}

function dropUndefined(o) {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]
  return o
}

export function cleanShow(raw) {
  raw = raw || {}
  const nodes = (Array.isArray(raw.nodes) ? raw.nodes : [])
    .filter((n) => n && n.id && n.type !== 'page')
    .map((n) => {
      const type = n.type === 'music' || n.type === 'other' ? n.type : 'editable'
      const d = n.data || {}
      const key = type === 'music' ? 'musicId' : type === 'other' ? 'otherId' : 'trickId'
      const data = dropUndefined({ [key]: d[key] ? str(d[key]) : null, width: saneDim(d.width), height: saneDim(d.height) })
      const x = Number(n.position && n.position.x), y = Number(n.position && n.position.y)
      return { id: str(n.id), type, position: { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0 }, data }
    })
  const ids = new Set(nodes.map((n) => n.id))
  const edges = (Array.isArray(raw.edges) ? raw.edges : [])
    .filter((e) => e && ids.has(str(e.source)) && ids.has(str(e.target)))
    .map((e) => dropUndefined({
      id: str(e.id) || edgeId(e.source, e.sourceHandle, e.target, e.targetHandle),
      source: str(e.source),
      sourceHandle: e.sourceHandle == null ? undefined : str(e.sourceHandle),
      target: str(e.target),
      targetHandle: e.targetHandle == null ? undefined : str(e.targetHandle),
      type: e.type ? str(e.type) : undefined,
      markerEnd: e.markerEnd || { type: 'arrowclosed' },
      animated: false,
    }))
  return {
    id: str(raw.id) || newId(),
    name: str(raw.name) || 'Untitled Show',
    ...stamps(raw),
    showProps: (Array.isArray(raw.showProps) ? raw.showProps : []).map((s) => str(s).trim()).filter(Boolean),
    nodes,
    edges,
  }
}

export function normalizeDoc(kind, raw) {
  raw = raw || {}
  const id = str(raw.id) || newId()
  if (kind === 'show') return cleanShow(raw)
  if (kind === 'trick') {
    return dropUndefined({
      id, name: str(raw.name),
      description: str(raw.description), script: str(raw.script), source: str(raw.source),
      duration: str(raw.duration), notes: str(raw.notes),
      props: normProps(raw.props),
      tagIds: Array.isArray(raw.tagIds) ? raw.tagIds.filter((t) => typeof t === 'string') : [],
      preferredWidth: saneDim(raw.preferredWidth), preferredHeight: saneDim(raw.preferredHeight),
      ...stamps(raw),
    })
  }
  if (kind === 'other') {
    const c = str(raw.color).trim()
    return dropUndefined({
      id, name: str(raw.name), description: str(raw.description), duration: str(raw.duration),
      color: /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : undefined,
      props: normProps(raw.props),
      preferredWidth: saneDim(raw.preferredWidth), preferredHeight: saneDim(raw.preferredHeight),
      ...stamps(raw),
    })
  }
  if (kind === 'music') {
    return {
      id, name: str(raw.name), description: str(raw.description),
      startCue: str(raw.startCue), stopCue: str(raw.stopCue),
      audioFileId: raw.audioFileId ? str(raw.audioFileId) : null,
      ...stamps(raw),
    }
  }
  if (kind === 'tag') return dropUndefined({ id, name: str(raw.name), color: raw.color ? str(raw.color) : undefined, ...stamps(raw) })
  if (kind === 'packing') {
    const checked = Array.isArray(raw.checked) ? [...new Set(raw.checked.map(str).filter(Boolean))] : []
    return { id, showId: str(raw.showId) || id.replace(/^packing:/, ''), checked, ...stamps(raw) }
  }
  if (kind === 'audio') {
    return {
      id, displayName: str(raw.displayName) || str(raw.originalFilename), originalFilename: str(raw.originalFilename),
      storedFilename: str(raw.storedFilename), mimeType: str(raw.mimeType) || 'application/octet-stream',
      size: Number(raw.size) || 0, ...stamps(raw),
    }
  }
  throw new Error('Unknown Show Builder kind: ' + kind)
}

// How each library is sorted, as the standalone app does: shows newest first, everything else A to Z.
export function sortDocs(kind, docs) {
  const out = docs.slice()
  if (kind === 'show') out.sort((a, b) => str(b.updatedAt).localeCompare(str(a.updatedAt)))
  else if (kind === 'audio') out.sort((a, b) => str(a.displayName).localeCompare(str(b.displayName)))
  else if (kind === 'packing') out.sort((a, b) => str(a.id).localeCompare(str(b.id)))
  else out.sort((a, b) => str(a.name).localeCompare(str(b.name)))
  return out
}

// ---------------------------------------------------------------------------
// Durations (same as the standalone app's showUtils.ts)
// ---------------------------------------------------------------------------

// Accepts "3:30" (m:ss), "1:02:30", "3 min", "30 sec", "1 hr 5 min", "5" (minutes). Minutes, or 0.
export function parseDurationMinutes(input) {
  if (!input) return 0
  const s = String(input).toLowerCase().trim()
  if (!s) return 0
  const colon = s.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/)
  if (colon) {
    const a = parseInt(colon[1]), b = parseInt(colon[2]), c = colon[3] ? parseInt(colon[3]) : null
    return c !== null ? a * 60 + b + c / 60 : a + b / 60
  }
  let total = 0, matched = false
  const h = s.match(/(\d+(?:\.\d+)?)\s*(hours?|hrs?|h)\b/)
  if (h) { total += parseFloat(h[1]) * 60; matched = true }
  const m = s.match(/(\d+(?:\.\d+)?)\s*(minutes?|mins?|m)\b/)
  if (m) { total += parseFloat(m[1]); matched = true }
  const sec = s.match(/(\d+(?:\.\d+)?)\s*(seconds?|secs?|s)\b/)
  if (sec) { total += parseFloat(sec[1]) / 60; matched = true }
  if (matched) return total
  const bare = s.match(/^(\d+(?:\.\d+)?)$/)
  return bare ? parseFloat(bare[1]) : 0
}

export function formatDuration(minutes) {
  if (minutes <= 0) return '0 min'
  if (minutes < 1) return `${Math.round(minutes * 60)} sec`
  const total = Math.round(minutes)
  if (total < 60) return `${total} min`
  const h = Math.floor(total / 60), mm = total % 60
  return mm === 0 ? `${h} hr` : `${h} hr ${mm} min`
}

// ---------------------------------------------------------------------------
// Running order (same as the standalone app's getShowOrder)
// ---------------------------------------------------------------------------

// Follow the arrows. Ties, and nodes with no arrows at all, go by the order they were added. Nodes in
// a loop come last.
export function getShowOrder(nodes, edges) {
  const inDeg = new Map(), adj = new Map(), byId = new Map(), ins = new Map()
  nodes.forEach((n, i) => { inDeg.set(n.id, 0); adj.set(n.id, []); byId.set(n.id, n); ins.set(n.id, i) })
  for (const e of edges || []) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue
    adj.get(e.source).push(e.target)
    inDeg.set(e.target, (inDeg.get(e.target) || 0) + 1)
  }
  const result = [], avail = []
  for (const [id, d] of inDeg) if (d === 0) avail.push(id)
  while (avail.length) {
    avail.sort((a, b) => (ins.get(a) || 0) - (ins.get(b) || 0))
    const next = avail.shift()
    result.push(byId.get(next))
    for (const s of adj.get(next) || []) {
      const d = (inDeg.get(s) || 0) - 1
      inDeg.set(s, d)
      if (d === 0) avail.push(s)
    }
  }
  const seen = new Set(result.map((n) => n.id))
  for (const n of nodes) if (!seen.has(n.id)) result.push(n)
  return result
}

// ---------------------------------------------------------------------------
// What a node is, and what it points at
// ---------------------------------------------------------------------------

export function nodeKind(n) { return n.type === 'music' ? 'music' : n.type === 'other' ? 'other' : 'trick' }
export function nodeRef(n) {
  const d = (n && n.data) || {}
  const k = nodeKind(n)
  return k === 'music' ? d.musicId || null : k === 'other' ? d.otherId || null : d.trickId || null
}
export function nodeType(kind) { return kind === 'music' ? 'music' : kind === 'other' ? 'other' : 'editable' }
export function refKey(kind) { return kind === 'music' ? 'musicId' : kind === 'other' ? 'otherId' : 'trickId' }

// lib = { tricks: Map, music: Map, others: Map } (id -> doc)
export function nodeItem(n, lib) {
  const id = nodeRef(n)
  if (!id || !lib) return null
  const k = nodeKind(n)
  const m = k === 'music' ? lib.music : k === 'other' ? lib.others : lib.tricks
  return (m && m.get(id)) || null
}

// Effective size on the canvas: this node's own size, else the item's preferred size, else default.
export function nodeSize(n, lib) {
  const d = (n && n.data) || {}
  const item = nodeItem(n, lib)
  const def = SIZE[n.type] || SIZE.editable
  const prefW = n.type === 'music' ? undefined : item && item.preferredWidth
  const prefH = n.type === 'music' ? undefined : item && item.preferredHeight
  return [d.width || prefW || def[0], d.height || prefH || def[1]]
}

function center(n, lib) {
  const [w, h] = nodeSize(n, lib)
  return { x: n.position.x + w / 2, y: n.position.y + h / 2 }
}

function placeAtCenter(n, c, lib) {
  const [w, h] = nodeSize(n, lib)
  return {
    ...n,
    position: {
      x: Math.round(Math.max(0, Math.min(CANVAS_W - w, c.x - w / 2))),
      y: Math.round(Math.max(0, Math.min(CANVAS_H - h, c.y - h / 2))),
    },
  }
}

export function edgeId(s, sh, t, th) { return `reactflow__edge-${s}${sh || ''}-${t}${th || ''}` }

// An arrow from a to b, leaving and entering on the facing sides, the way he draws them by hand.
export function arrow(a, b, lib) {
  const ca = center(a, lib), cb = center(b, lib)
  const dx = cb.x - ca.x, dy = cb.y - ca.y
  let sh, th
  if (Math.abs(dx) >= Math.abs(dy)) { sh = dx >= 0 ? 'right' : 'left'; th = dx >= 0 ? 'left' : 'right' }
  else { sh = dy >= 0 ? 'bottom' : 'top'; th = dy >= 0 ? 'top' : 'bottom' }
  return { id: edgeId(a.id, sh, b.id, th), source: a.id, sourceHandle: sh, target: b.id, targetHandle: th, markerEnd: { type: 'arrowclosed' }, animated: false }
}

// ---------------------------------------------------------------------------
// Show Info: runtime, props, flow (same rules as the standalone app's ShowInfo.tsx)
// ---------------------------------------------------------------------------

const normName = (s) => str(s).trim().toLowerCase()

export function showInfo(show, lib) {
  const order = getShowOrder(show.nodes || [], show.edges || [])
  // Music is a cue, not a slot in the show: it adds no runtime and no props (the standalone app's choice).
  const flow = order.filter((n) => n.type !== 'music')
  let total = 0, unassigned = 0
  const groups = new Map()
  for (const n of flow) {
    const item = nodeItem(n, lib)
    if (!item) { unassigned++; continue }
    total += parseDurationMinutes(item.duration)
    for (const p of item.props || []) {
      if (!p.reusable) continue
      const key = normName(p.name)
      if (!key) continue
      const g = groups.get(key)
      if (g) g.count++
      else groups.set(key, { name: p.name, count: 1 })
    }
  }
  const hoisted = new Set([...groups].filter(([, g]) => g.count >= 2).map(([k]) => k))
  const reusable = [...groups.values()].filter((g) => g.count >= 2).map((g) => g.name).sort((a, b) => a.localeCompare(b))
  const items = flow.map((n) => {
    const item = nodeItem(n, lib)
    const props = ((item && item.props) || []).filter((p) => !p.reusable || !hoisted.has(normName(p.name)))
    return { node: n, kind: nodeKind(n), item, props }
  })
  return { totalMinutes: total, count: flow.length, unassigned, reusable, items, music: order.filter((n) => n.type === 'music') }
}

// ---------------------------------------------------------------------------
// The packing list (the phone's Packing tab, 2026-10-24)
// ---------------------------------------------------------------------------
//
// Michael: "a packing list tab that is the same as the show info tab ... all the props listed out that
// I would need ... checklist style so I can cross them off as I'm packing for my show, or I can clear
// them." So the groups are exactly Show Info's: the show essentials, the reusable props to pack once,
// then each item's own props in show order.
//
// Which boxes are ticked is its OWN document per show (kind 'packing', id 'packing:<showId>', a list of
// line keys), not part of the show, so a tick on the phone can never collide with a canvas edit saved
// from the Mac. A key names the line, so renaming a prop or taking an item out of the show simply
// leaves its old tick behind, unseen.

export function packingId(showId) { return 'packing:' + showId }

export function packingList(show, lib) {
  const info = showInfo(show, lib)
  const sections = []
  const keyed = (prefix, names) => {
    const seen = {}
    return names.map((name) => {
      const k = prefix + normName(name)
      seen[k] = (seen[k] || 0) + 1
      return { key: seen[k] > 1 ? k + '#' + seen[k] : k, name }
    })
  }
  const ess = (show.showProps || []).filter((p) => str(p).trim())
  if (ess.length) sections.push({ title: 'Show essentials', lines: keyed('e:', ess) })
  if (info.reusable.length) sections.push({ title: 'Reusable across the show', hint: 'Pack one of each.', lines: keyed('r:', info.reusable) })
  let n = 0
  for (const x of info.items) {
    n++
    if (!x.item || !x.props.length) continue
    sections.push({ title: n + '. ' + (x.item.name || 'Untitled'), nodeId: x.node.id, lines: keyed('i:' + x.node.id + ':', x.props.map((p) => p.name)) })
  }
  const total = sections.reduce((t, sec) => t + sec.lines.length, 0)
  return { sections, total }
}

// ---------------------------------------------------------------------------
// Editing a show from the PHONE
// ---------------------------------------------------------------------------
//
// On a laptop he drags nodes around a 2400 x 1500 canvas and draws arrows between them. On a phone
// that canvas is a postage stamp, so the phone's main view is the RUNNING ORDER as a list, and every
// change he makes there is written back into the same nodes and arrows the Mac draws:
//
//   - REORDER: the arrows become one chain in the new order, and the nodes trade PLACES. Each spot on
//     the canvas that held the 1st, 2nd, 3rd item now holds the new 1st, 2nd, 3rd. So a show laid out
//     left to right on the Mac still reads left to right, in the new order, and no arrow doubles back.
//   - ADD: the new item goes on the end, one step past the last item (same direction as the last
//     step, wrapping to a new row at the edge of the page), with an arrow from the last item.
//   - REMOVE: the node and its arrows go, and its neighbours are joined so the chain is not broken.
//
// Every function returns a NEW show object; nothing is changed in place.

export function reorderShow(show, orderIds, lib) {
  const old = getShowOrder(show.nodes, show.edges)
  const byId = new Map(show.nodes.map((n) => [n.id, n]))
  const ordered = orderIds.map((id) => byId.get(id)).filter(Boolean)
  // Anything the caller left out keeps its place at the end, so a node can never be lost.
  for (const n of old) if (!orderIds.includes(n.id)) ordered.push(n)
  const slots = old.map((n) => center(n, lib))
  const placed = ordered.map((n, i) => placeAtCenter(n, slots[i], lib))
  const edges = []
  for (let i = 1; i < placed.length; i++) edges.push(arrow(placed[i - 1], placed[i], lib))
  // Keep the nodes array in its original order: it breaks ties for unconnected nodes on the Mac.
  const placedById = new Map(placed.map((n) => [n.id, n]))
  return { ...show, nodes: show.nodes.map((n) => placedById.get(n.id) || n), edges }
}

export function nextSlot(show, lib) {
  const order = getShowOrder(show.nodes, show.edges)
  if (!order.length) return { x: 300, y: 400 }
  const last = center(order[order.length - 1], lib)
  let step = { x: 210, y: 0 }
  if (order.length >= 2) {
    const prev = center(order[order.length - 2], lib)
    const s = { x: last.x - prev.x, y: last.y - prev.y }
    if (Math.hypot(s.x, s.y) >= 80 && Math.hypot(s.x, s.y) <= 600) step = s
  }
  let c = { x: last.x + step.x, y: last.y + step.y }
  // Off the page sideways: start a new row under the current one, at the left margin.
  if (c.x > CANVAS_W - 90 || c.x < 90) c = { x: 170, y: last.y + 220 }
  if (c.y > CANVAS_H - 90) c = { x: c.x, y: CANVAS_H - 90 }
  if (c.y < 90) c = { x: c.x, y: 90 }
  return c
}

export function appendNode(show, kind, refId, lib) {
  const order = getShowOrder(show.nodes, show.edges)
  const last = order[order.length - 1]
  const node = placeAtCenter({ id: newId('node'), type: nodeType(kind), position: { x: 0, y: 0 }, data: { [refKey(kind)]: refId || null } }, nextSlot(show, lib), lib)
  const edges = last ? [...show.edges, arrow(last, node, lib)] : show.edges.slice()
  return { show: { ...show, nodes: [...show.nodes, node], edges }, node }
}

export function removeNode(show, nodeId, lib) {
  const byId = new Map(show.nodes.map((n) => [n.id, n]))
  const ins = show.edges.filter((e) => e.target === nodeId).map((e) => e.source)
  const outs = show.edges.filter((e) => e.source === nodeId).map((e) => e.target)
  const edges = show.edges.filter((e) => e.source !== nodeId && e.target !== nodeId)
  for (const a of ins) for (const b of outs) {
    if (a === b || edges.some((e) => e.source === a && e.target === b)) continue
    if (byId.get(a) && byId.get(b)) edges.push(arrow(byId.get(a), byId.get(b), lib))
  }
  return { ...show, nodes: show.nodes.filter((n) => n.id !== nodeId), edges }
}

export function assignNode(show, nodeId, refId) {
  return {
    ...show,
    nodes: show.nodes.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, [refKey(nodeKind(n))]: refId || null } } : n)),
  }
}

export function moveNode(show, nodeId, pos, lib) {
  return {
    ...show,
    nodes: show.nodes.map((n) => {
      if (n.id !== nodeId) return n
      const [w, h] = nodeSize(n, lib)
      return { ...n, position: { x: Math.round(Math.max(0, Math.min(CANVAS_W - w, pos.x))), y: Math.round(Math.max(0, Math.min(CANVAS_H - h, pos.y))) } }
    }),
  }
}

export function connectNodes(show, a, b, lib) {
  if (a === b || show.edges.some((e) => e.source === a && e.target === b)) return show
  const byId = new Map(show.nodes.map((n) => [n.id, n]))
  if (!byId.get(a) || !byId.get(b)) return show
  return { ...show, edges: [...show.edges, arrow(byId.get(a), byId.get(b), lib)] }
}

export function disconnectNode(show, nodeId) {
  return { ...show, edges: show.edges.filter((e) => e.source !== nodeId && e.target !== nodeId) }
}

// How many items have at least one arrow. The phone says so when some do not, because reordering
// on the phone joins them all into one chain.
export function connectedCount(show) {
  const ids = new Set()
  for (const e of show.edges || []) { ids.add(e.source); ids.add(e.target) }
  return (show.nodes || []).filter((n) => ids.has(n.id)).length
}

// A copy of a show with fresh ids, so the copy and the original never share a node or an arrow.
export function duplicateShow(show, name) {
  const map = new Map(show.nodes.map((n) => [n.id, newId('node')]))
  const nodes = show.nodes.map((n) => ({ ...n, id: map.get(n.id), data: { ...n.data } }))
  const edges = show.edges.map((e) => {
    const s = map.get(e.source), t = map.get(e.target)
    return { ...e, source: s, target: t, id: edgeId(s, e.sourceHandle, t, e.targetHandle) }
  })
  const now = nowIso()
  return { ...show, id: newId(), name: name || `Copy of ${show.name}`, createdAt: now, updatedAt: now, nodes, edges, showProps: (show.showProps || []).slice() }
}
