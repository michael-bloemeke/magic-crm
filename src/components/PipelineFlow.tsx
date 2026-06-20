import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { byEventDateAsc, type Project, type Umbrella } from '../pipeline'
import { getFlowLayout, putFlowLayout } from '../api'
import { ProjectRow } from './ProjectRow'

// A non-infinite, screen-sized canvas of draggable, linkable stage nodes.
// Layout + links persist server-side (crm-pipeline.json) so an arrangement
// survives app changes, browsers, and cache clears.

const GRID = 26 // snap step (matches the dot background) so nodes line up tidily
const NODE = GRID * 4 // 104px square — an exact multiple of GRID so boxes tile evenly
// (two boxes can sit flush at NODE apart, or one grid-cell apart, with no half-gaps).

type StageNode = {
  id: string
  name: string
  count: number
  accent: string
  umbrella: string
}

type Pos = { x: number; y: number }
type Edge = { id: string; from: string; to: string }

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))
const snap = (v: number) => Math.round(v / GRID) * GRID

// Snap to the grid, then keep the node inside the canvas. The name now sits inside
// the box, so no extra caption space is reserved below it.
function clampPos(x: number, y: number, w: number, h: number): Pos {
  return {
    x: clamp(snap(x), 8, Math.max(8, w - NODE - 8)),
    y: clamp(snap(y), 8, Math.max(8, h - NODE - 8)),
  }
}

// Default arrangement: one umbrella per row, each row centered horizontally.
function computeDefault(rows: string[][], w: number, h: number): Record<string, Pos> {
  const pad = 36
  const out: Record<string, Pos> = {}
  const usableH = h - 2 * pad - NODE
  rows.forEach((ids, ri) => {
    const y = pad + (rows.length > 1 ? (usableH * ri) / (rows.length - 1) : 0)
    const gap = GRID // one grid-cell between boxes, so the default tiles cleanly
    const totalW = ids.length * NODE + (ids.length - 1) * gap
    const startX = Math.max(pad, (w - totalW) / 2)
    ids.forEach((id, ci) => {
      out[id] = clampPos(startX + ci * (NODE + gap), y, w, h)
    })
  })
  return out
}

type Props = {
  pipeline: Umbrella[]
  onOpenFull: (project: Project) => void
  onOpenSide: (project: Project) => void
  unread: Record<string, number>
  pendingPaymentIds: Set<string>
}

export function PipelineFlow({ pipeline, onOpenFull, onOpenSide, unread, pendingPaymentIds }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [positions, setPositions] = useState<Record<string, Pos>>({})
  const [edges, setEdges] = useState<Edge[]>([])
  const [ready, setReady] = useState(false)
  const [dragId, setDragId] = useState<string | null>(null)
  const [hoverTarget, setHoverTarget] = useState<string | null>(null)
  const [selectedStageId, setSelectedStageId] = useState<string | null>(null)
  const [tempLine, setTempLine] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null)

  const dragRef = useRef<{ id: string; dx: number; dy: number } | null>(null)
  const linkFromRef = useRef<string | null>(null)

  // The stage whose project list is shown below the canvas.
  const selectedStage = useMemo(
    () => pipeline.flatMap((u) => u.stages).find((s) => s.id === selectedStageId) ?? null,
    [pipeline, selectedStageId],
  )

  // Every active project, soonest-first — shown below the canvas when no single
  // stage is selected.
  const allActive = useMemo(
    () => pipeline.flatMap((u) => u.stages.flatMap((s) => s.projects)).slice().sort(byEventDateAsc),
    [pipeline],
  )

  // Stage nodes (with live counts) and default-layout rows, derived from the pipeline.
  const stageNodes = useMemo<StageNode[]>(
    () =>
      pipeline.flatMap((u) =>
        u.stages.map((s) => ({
          id: s.id,
          name: s.name,
          count: s.projects.length,
          accent: u.color,
          umbrella: u.id,
        })),
      ),
    [pipeline],
  )
  const rows = useMemo(() => pipeline.map((u) => u.stages.map((s) => s.id)), [pipeline])
  const rowsRef = useRef(rows)
  rowsRef.current = rows

  // Seed positions from the server layout (or the default), once the canvas has
  // a real size. Retrying on a too-small measurement avoids the nodes collapsing
  // into a corner before the layout has settled.
  useEffect(() => {
    let alive = true
    const seed = async () => {
      const el = containerRef.current
      if (!el) return
      const { width, height } = el.getBoundingClientRect()
      if (width < 80 || height < 80) {
        requestAnimationFrame(seed)
        return
      }
      const def = computeDefault(rowsRef.current, width, height)
      let layout = null
      try {
        layout = await getFlowLayout()
      } catch {
        // ignore; fall back to the default layout
      }
      if (!alive) return
      if (layout?.positions && Object.keys(layout.positions).length) {
        const saved = layout
        const merged: Record<string, Pos> = {}
        stageNodes.forEach((n) => {
          const p = saved.positions[n.id] ?? def[n.id]
          merged[n.id] = clampPos(p.x, p.y, width, height)
        })
        setPositions(merged)
        setEdges(Array.isArray(saved.edges) ? saved.edges : [])
      } else {
        setPositions(def)
        setEdges([])
      }
      setReady(true)
    }
    seed()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Persist layout to the server (debounced so dragging doesn't spam writes).
  useEffect(() => {
    if (!ready) return
    const t = setTimeout(() => {
      putFlowLayout({ positions, edges }).catch(() => {})
    }, 400)
    return () => clearTimeout(t)
  }, [positions, edges, ready])

  // Keep nodes inside the canvas when the window resizes.
  useEffect(() => {
    const el = containerRef.current
    if (!el || !ready) return
    const ro = new ResizeObserver(() => {
      const { width, height } = el.getBoundingClientRect()
      setPositions((prev) => {
        const next: Record<string, Pos> = {}
        for (const id in prev) next[id] = clampPos(prev[id].x, prev[id].y, width, height)
        return next
      })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ready])

  const localPoint = (e: PointerEvent | React.PointerEvent) => {
    const rect = containerRef.current!.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  // ---- Drag to move ----
  const startDrag = useCallback(
    (e: React.PointerEvent, id: string) => {
      e.preventDefault()
      const p = localPoint(e)
      const pos = positions[id]
      dragRef.current = { id, dx: p.x - pos.x, dy: p.y - pos.y }
      setDragId(id)

      const startX = e.clientX
      const startY = e.clientY
      let moved = false

      const move = (ev: PointerEvent) => {
        const d = dragRef.current
        if (!d || !containerRef.current) return
        if (Math.abs(ev.clientX - startX) > 4 || Math.abs(ev.clientY - startY) > 4) moved = true
        const rect = containerRef.current.getBoundingClientRect()
        const np = clampPos(ev.clientX - rect.left - d.dx, ev.clientY - rect.top - d.dy, rect.width, rect.height)
        setPositions((prev) => ({ ...prev, [d.id]: np }))
      }
      const up = () => {
        // A press without movement is a click: select the stage to list below.
        if (!moved) setSelectedStageId(id)
        dragRef.current = null
        setDragId(null)
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [positions],
  )

  // ---- Drag to link ----
  const startLink = useCallback(
    (e: React.PointerEvent, id: string) => {
      e.preventDefault()
      e.stopPropagation()
      linkFromRef.current = id
      const pos = positions[id]
      const start = { x: pos.x + NODE / 2, y: pos.y + NODE / 2 }
      const p = localPoint(e)
      setTempLine({ x1: start.x, y1: start.y, x2: p.x, y2: p.y })

      const move = (ev: PointerEvent) => {
        if (!containerRef.current) return
        const rect = containerRef.current.getBoundingClientRect()
        setTempLine((prev) => (prev ? { ...prev, x2: ev.clientX - rect.left, y2: ev.clientY - rect.top } : prev))
        const el = document.elementFromPoint(ev.clientX, ev.clientY)
        const node = el?.closest('[data-node-id]') as HTMLElement | null
        const toId = node?.getAttribute('data-node-id') ?? null
        setHoverTarget(toId && toId !== linkFromRef.current ? toId : null)
      }
      const up = (ev: PointerEvent) => {
        const from = linkFromRef.current
        const el = document.elementFromPoint(ev.clientX, ev.clientY)
        const node = el?.closest('[data-node-id]') as HTMLElement | null
        const to = node?.getAttribute('data-node-id') ?? null
        if (from && to && to !== from) {
          setEdges((es) =>
            es.some((ed) => ed.from === from && ed.to === to)
              ? es
              : [...es, { id: `${from}__${to}`, from, to }],
          )
        }
        linkFromRef.current = null
        setTempLine(null)
        setHoverTarget(null)
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [positions],
  )

  const removeEdge = (id: string) => setEdges((es) => es.filter((e) => e.id !== id))

  const resetPositions = () => {
    const el = containerRef.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    setPositions(computeDefault(rows, width, height))
  }

  // Build a curved path that leaves and enters along whichever axis dominates,
  // so the arrow points down into a node that sits below, right into one beside, etc.
  const edgePath = (from: Pos, to: Pos) => {
    const half = NODE / 2
    const acx = from.x + half
    const acy = from.y + half
    const bcx = to.x + half
    const bcy = to.y + half
    const dx = bcx - acx
    const dy = bcy - acy
    const gap = 9 // leave the arrow tip just outside the target border

    let sx: number, sy: number, ex: number, ey: number
    let c1x: number, c1y: number, c2x: number, c2y: number

    if (Math.abs(dx) >= Math.abs(dy)) {
      // Horizontal run: exit left/right edge, enter the opposite edge.
      const dir = dx >= 0 ? 1 : -1
      sx = acx + dir * half
      sy = acy
      ex = bcx - dir * (half + gap)
      ey = bcy
      const c = Math.max(40, Math.abs(ex - sx) / 2)
      c1x = sx + dir * c
      c1y = sy
      c2x = ex - dir * c
      c2y = ey
    } else {
      // Vertical run: exit top/bottom edge, enter the opposite edge.
      const dir = dy >= 0 ? 1 : -1
      sx = acx
      sy = acy + dir * half
      ex = bcx
      ey = bcy - dir * (half + gap)
      const c = Math.max(40, Math.abs(ey - sy) / 2)
      c1x = sx
      c1y = sy + dir * c
      c2x = ex
      c2y = ey - dir * c
    }

    return `M ${sx} ${sy} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${ex} ${ey}`
  }

  return (
    <div className="board-scroll h-full overflow-y-auto px-8">
      {/* First screen: the canvas keeps its full size regardless of the list below */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.4 }}
        className="flex h-full flex-col pb-8"
      >
      {/* Toolbar */}
      <div className="mb-3 flex items-center justify-between">
        <p className="text-[12px] text-faint">
          Drag a node to move it. Drag from its dot to link. Click a link to remove it.
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={resetPositions}
            className="rounded-lg border border-line px-3 py-1.5 text-[11.5px] font-medium text-muted transition-colors hover:border-line-strong hover:text-parchment"
          >
            Reset positions
          </button>
          <button
            type="button"
            onClick={() => setEdges([])}
            className="rounded-lg border border-line px-3 py-1.5 text-[11.5px] font-medium text-muted transition-colors hover:border-line-strong hover:text-parchment"
          >
            Clear links
          </button>
        </div>
      </div>

      {/* Canvas */}
      <div
        ref={containerRef}
        onPointerDown={(e) => {
          // Clicking anywhere on the canvas that isn't a node (empty space, the
          // dot grid, or an edge) deselects the current stage.
          if (!(e.target as HTMLElement).closest('[data-node-id]')) setSelectedStageId(null)
        }}
        className="relative flex-1 overflow-hidden rounded-2xl border border-line bg-surface/30"
        style={{
          backgroundImage:
            'radial-gradient(circle, rgba(233,218,192,0.05) 1px, transparent 1px)',
          backgroundSize: '26px 26px',
        }}
      >
        {/* Edges (behind nodes); only the strokes are clickable */}
        <svg className="absolute inset-0 h-full w-full" style={{ pointerEvents: 'none' }}>
          <defs>
            <marker
              id="arrow"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--color-brass)" />
            </marker>
          </defs>
          {ready &&
            edges.map((edge) => {
              const from = positions[edge.from]
              const to = positions[edge.to]
              if (!from || !to) return null
              const d = edgePath(from, to)
              return (
                <g key={edge.id} className="group/edge">
                  <path
                    d={d}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={16}
                    style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                    onClick={() => removeEdge(edge.id)}
                  >
                    <title>Click to remove link</title>
                  </path>
                  <path
                    d={d}
                    fill="none"
                    stroke="var(--color-brass)"
                    strokeWidth={1.75}
                    markerEnd="url(#arrow)"
                    className="opacity-50 transition-opacity group-hover/edge:opacity-100"
                    style={{ pointerEvents: 'none' }}
                  />
                </g>
              )
            })}
        </svg>

        {/* Nodes */}
        {ready &&
          stageNodes.map((node) => {
            const pos = positions[node.id]
            if (!pos) return null
            const isDragging = dragId === node.id
            const isTarget = hoverTarget === node.id
            const isSelected = selectedStageId === node.id
            const hasProjects = node.count > 0
            return (
              <div
                key={node.id}
                data-node-id={node.id}
                onPointerDown={(e) => startDrag(e, node.id)}
                className="absolute select-none touch-none"
                style={{ left: pos.x, top: pos.y, width: NODE, zIndex: isDragging ? 30 : 10 }}
              >
                {/* The square (count + name live inside it). Empty stages are
                    rendered colorless + dim; only populated stages carry the accent. */}
                <div
                  className={[
                    'relative flex flex-col items-center justify-center gap-1 rounded-2xl border px-2 text-center backdrop-blur-sm transition-shadow',
                    hasProjects ? 'bg-surface-2/90' : 'bg-surface-2/55 opacity-80',
                  ].join(' ')}
                  style={{
                    width: NODE,
                    height: NODE,
                    cursor: isDragging ? 'grabbing' : 'grab',
                    borderColor:
                      isTarget || isSelected
                        ? node.accent
                        : hasProjects
                          ? `color-mix(in oklab, ${node.accent} 85%, transparent)`
                          : 'var(--color-line-strong)',
                    boxShadow: isDragging
                      ? `0 14px 34px -10px rgba(0,0,0,0.7), 0 0 0 1px ${node.accent}`
                      : isTarget || isSelected
                        ? `0 0 0 2px ${node.accent}, 0 0 22px -6px ${node.accent}`
                        : hasProjects
                          ? // Glow when the stage holds projects, so it stands out from empty ones.
                            `0 0 18px -3px ${node.accent}, inset 0 0 12px -6px ${node.accent}, inset 0 0 0 1px color-mix(in oklab, ${node.accent} 35%, transparent)`
                          : 'none',
                  }}
                >
                  {/* umbrella tick (colored only when the stage has projects) */}
                  <span
                    className="absolute left-2.5 top-2.5 h-1.5 w-1.5 rounded-full"
                    style={{
                      backgroundColor: hasProjects ? node.accent : 'var(--color-line-strong)',
                      boxShadow: hasProjects ? `0 0 8px ${node.accent}` : 'none',
                    }}
                  />
                  <span
                    className={[
                      'font-display text-[24px] leading-none tabular-nums',
                      hasProjects ? 'text-brass-bright' : 'text-muted',
                    ].join(' ')}
                  >
                    {node.count}
                  </span>
                  <span
                    className={[
                      'line-clamp-2 text-[9.5px] font-medium leading-tight',
                      hasProjects ? 'text-muted' : 'text-faint',
                    ].join(' ')}
                    title={node.name}
                  >
                    {node.name}
                  </span>

                  {/* link handle */}
                  <span
                    onPointerDown={(e) => startLink(e, node.id)}
                    title="Drag to link to another stage"
                    className="absolute -right-1.5 top-1/2 flex h-4 w-4 -translate-y-1/2 cursor-crosshair items-center justify-center rounded-full border border-line-strong bg-surface-3 transition-transform hover:scale-125"
                  >
                    <span className="h-1.5 w-1.5 rounded-full bg-brass" />
                  </span>
                </div>
              </div>
            )
          })}

        {/* Temp link line (on top, non-interactive) */}
        {tempLine && (
          <svg className="absolute inset-0 z-40 h-full w-full" style={{ pointerEvents: 'none' }}>
            <line
              x1={tempLine.x1}
              y1={tempLine.y1}
              x2={tempLine.x2}
              y2={tempLine.y2}
              stroke="var(--color-brass)"
              strokeWidth={1.75}
              strokeDasharray="5 4"
              className="opacity-80"
            />
          </svg>
        )}
      </div>
      </motion.div>

      {/* Project list — scroll down to reach it. Shows the selected stage, or
          every active project (soonest first) when no stage is selected. */}
      <section ref={listRef} className="pb-12 pt-9">
        {(() => {
          const accent = selectedStage
            ? stageNodes.find((n) => n.id === selectedStage.id)?.accent ?? 'var(--color-brass)'
            : 'var(--color-brass)'
          const title = selectedStage ? selectedStage.name : 'All active projects'
          const count = selectedStage ? selectedStage.projects.length : allActive.length
          return (
            <div className="mb-4 flex items-center gap-3">
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: accent, boxShadow: `0 0 10px ${accent}` }}
              />
              <h2 className="font-display text-[22px] leading-none text-parchment">{title}</h2>
              <span className="rounded-full border border-line px-2 py-0.5 text-[11px] font-semibold tabular-nums text-muted">
                {count}
              </span>
              <span
                className="ml-1 h-px flex-1"
                style={{
                  background: `linear-gradient(to right, color-mix(in oklab, ${accent} 40%, transparent), transparent)`,
                }}
              />
              {selectedStage && (
                <button
                  type="button"
                  onClick={() => setSelectedStageId(null)}
                  className="rounded-lg border border-line px-3 py-1.5 text-[11px] font-medium text-muted transition-colors hover:border-line-strong hover:text-parchment"
                >
                  Show all
                </button>
              )}
            </div>
          )
        })()}

        {(() => {
          const list = selectedStage ? selectedStage.projects : allActive
          if (list.length === 0) {
            return (
              <p className="rounded-xl border border-dashed border-line px-4 py-8 text-center text-[12px] text-faint">
                {selectedStage ? 'No projects in this stage.' : 'No active projects yet.'}
              </p>
            )
          }
          return (
            <div className="flex flex-col gap-2">
              {list.map((p) => (
                <ProjectRow
                  key={p.id}
                  project={p}
                  summary
                  unreadCount={unread[p.id] || 0}
                  pendingPayment={pendingPaymentIds.has(p.id)}
                  onOpenFull={onOpenFull}
                  onOpenSide={onOpenSide}
                />
              ))}
            </div>
          )
        })()}
      </section>
    </div>
  )
}
