import type { Node, Edge } from 'reactflow'

// Best-effort parser for free-form duration strings.
// Accepts forms like: "3 min", "30 sec", "1 hr 5 min", "1:30" (m:s), "5", "0.5h".
// Returns minutes as a number (or 0 if nothing parseable).
export function parseDurationMinutes(input: string | undefined): number {
  if (!input) return 0
  const s = input.toLowerCase().trim()
  if (!s) return 0

  // H:MM:SS or M:SS
  const colon = s.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/)
  if (colon) {
    const a = parseInt(colon[1])
    const b = parseInt(colon[2])
    const c = colon[3] ? parseInt(colon[3]) : null
    if (c !== null) {
      // H:MM:SS
      return a * 60 + b + c / 60
    }
    // Ambiguous M:SS vs H:MM. For magic tricks, M:SS is far more common.
    return a + b / 60
  }

  let total = 0
  let matched = false
  const hMatch = s.match(/(\d+(?:\.\d+)?)\s*(hours?|hrs?|h)\b/)
  if (hMatch) {
    total += parseFloat(hMatch[1]) * 60
    matched = true
  }
  const mMatch = s.match(/(\d+(?:\.\d+)?)\s*(minutes?|mins?|m)\b/)
  if (mMatch) {
    total += parseFloat(mMatch[1])
    matched = true
  }
  const sMatch = s.match(/(\d+(?:\.\d+)?)\s*(seconds?|secs?|s)\b/)
  if (sMatch) {
    total += parseFloat(sMatch[1]) / 60
    matched = true
  }
  if (matched) return total

  // Bare number -> minutes.
  const bare = s.match(/^(\d+(?:\.\d+)?)$/)
  if (bare) return parseFloat(bare[1])

  return 0
}

// Format a number of minutes as a human string.
export function formatDuration(minutes: number): string {
  if (minutes <= 0) return '0 min'
  if (minutes < 1) {
    const secs = Math.round(minutes * 60)
    return `${secs} sec`
  }
  const totalMinutes = Math.round(minutes)
  if (totalMinutes < 60) return `${totalMinutes} min`
  const h = Math.floor(totalMinutes / 60)
  const m = totalMinutes % 60
  if (m === 0) return `${h} hr`
  return `${h} hr ${m} min`
}

// Topological sort of nodes following edges. Ties are broken by the node's
// position in the input array (insertion order). Nodes in cycles or otherwise
// unreachable are appended at the end.
export function getShowOrder<T extends Node = Node>(nodes: T[], edges: Edge[]): T[] {
  const inDegree = new Map<string, number>()
  const adj = new Map<string, string[]>()
  const nodeMap = new Map<string, T>()
  const insertionOrder = new Map<string, number>()

  nodes.forEach((n, i) => {
    inDegree.set(n.id, 0)
    adj.set(n.id, [])
    nodeMap.set(n.id, n)
    insertionOrder.set(n.id, i)
  })

  for (const e of edges) {
    if (!nodeMap.has(e.source) || !nodeMap.has(e.target)) continue
    adj.get(e.source)!.push(e.target)
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1)
  }

  const result: T[] = []
  const available: string[] = []
  for (const [id, deg] of inDegree) {
    if (deg === 0) available.push(id)
  }

  while (available.length > 0) {
    available.sort(
      (a, b) => (insertionOrder.get(a) ?? 0) - (insertionOrder.get(b) ?? 0)
    )
    const nextId = available.shift()!
    result.push(nodeMap.get(nextId)!)
    for (const successor of adj.get(nextId) ?? []) {
      const newDeg = (inDegree.get(successor) ?? 0) - 1
      inDegree.set(successor, newDeg)
      if (newDeg === 0) available.push(successor)
    }
  }

  // Append any nodes left out (e.g. cycles).
  const seen = new Set(result.map((n) => n.id))
  for (const n of nodes) {
    if (!seen.has(n.id)) result.push(n)
  }

  return result
}
