import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactFlow, {
  Background,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  MarkerType,
  ConnectionMode,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type EdgeChange,
  type NodeMouseHandler,
  type ReactFlowInstance,
  type XYPosition
} from 'reactflow'
import {
  EditableNode,
  MusicNode,
  OtherNode,
  PageNode,
  type EditableNodeData,
  type MusicNodeData,
  type OtherNodeData,
  NODE_SIZE,
  MUSIC_NODE_WIDTH,
  MUSIC_NODE_HEIGHT,
  OTHER_NODE_WIDTH,
  OTHER_NODE_HEIGHT
} from './EditableNode'
import { TrickSidebar } from './tricks/TrickSidebar'
import { MusicSidebar } from './music/MusicSidebar'
import { OtherSidebar } from './others/OtherSidebar'
import { useMusic } from './music/MusicContext'
import { ShowInfo } from './ShowInfo'
import type { Show } from './types'
import { sbApi } from './sbApi'

type Props = {
  showId: string
  onBack: () => void
}

// Fixed canvas size. Bump these later if Michael wants more room.
const CANVAS_WIDTH = 2400
const CANVAS_HEIGHT = 1500

const nodeTypes = {
  editable: EditableNode,
  music: MusicNode,
  other: OtherNode,
  page: PageNode
}

type NodeKind = 'trick' | 'music' | 'other'

const PAGE_NODE_ID = '__page__'

const pageNode: Node = {
  id: PAGE_NODE_ID,
  type: 'page',
  position: { x: 0, y: 0 },
  data: { width: CANVAS_WIDTH, height: CANVAS_HEIGHT },
  draggable: false,
  selectable: false,
  deletable: false,
  focusable: false,
  zIndex: -1
}

function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function clampPosition(pos: XYPosition, width = NODE_SIZE, height = NODE_SIZE): XYPosition {
  return {
    x: Math.max(0, Math.min(CANVAS_WIDTH - width, pos.x)),
    y: Math.max(0, Math.min(CANVAS_HEIGHT - height, pos.y))
  }
}

function nodeWidthFor(type: string | undefined): number {
  if (type === 'music') return MUSIC_NODE_WIDTH
  if (type === 'other') return OTHER_NODE_WIDTH
  return NODE_SIZE
}

function nodeHeightFor(type: string | undefined): number {
  if (type === 'music') return MUSIC_NODE_HEIGHT
  if (type === 'other') return OTHER_NODE_HEIGHT
  return NODE_SIZE
}

// Clamp/validate a stored size value. Drops anything wildly out of range
// (e.g. a legacy giant value left by the removed drag-resizer).
const MIN_NODE_DIM = 40
const MAX_NODE_DIM = 800

function sanitizeDim(v: unknown): number | undefined {
  if (typeof v !== 'number') return undefined
  if (!Number.isFinite(v)) return undefined
  if (v < MIN_NODE_DIM || v > MAX_NODE_DIM) return undefined
  return Math.round(v)
}

type AnyNodeData = EditableNodeData | MusicNodeData | OtherNodeData

export function ShowCanvas({ showId, onBack }: Props) {
  const { stop: stopMusic } = useMusic()
  const [nodes, setNodes, onNodesChangeRaw] = useNodesState<AnyNodeData>([])
  const [edges, setEdges, onEdgesChangeRaw] = useEdgesState([])
  const [showName, setShowName] = useState('Untitled Show')
  const [showProps, setShowProps] = useState<string[]>([])
  const [createdAt, setCreatedAt] = useState<string>(new Date().toISOString())
  const [loaded, setLoaded] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const addMenuRef = useRef<HTMLDivElement>(null)
  const flowRef = useRef<ReactFlowInstance | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Refs hold the latest values for use in unmount cleanup, where state
  // captured in closures would be stale.
  const dataRef = useRef({ nodes, edges, showName, showProps, createdAt, showId })
  const dirtyRef = useRef(false)

  useEffect(() => {
    dataRef.current = { nodes, edges, showName, showProps, createdAt, showId }
  }, [nodes, edges, showName, showProps, createdAt, showId])

  useEffect(() => {
    dirtyRef.current = dirty
  }, [dirty])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const loadedShow = await sbApi.loadShow(showId)
      if (cancelled || !loadedShow) {
        setLoaded(true)
        return
      }
      setShowName(loadedShow.name)
      setCreatedAt(loadedShow.createdAt)
      setShowProps(Array.isArray((loadedShow as Show).showProps) ? (loadedShow as Show).showProps! : [])
      const hydratedNodes = (loadedShow.nodes as Node[]).map((n) => {
        const type = n.type ?? 'editable'
        const dRaw = (n.data ?? {}) as {
          trickId?: string | null
          musicId?: string | null
          otherId?: string | null
          width?: unknown
          height?: unknown
        }
        const safeWidth = sanitizeDim(dRaw.width)
        const safeHeight = sanitizeDim(dRaw.height)
        const w = safeWidth ?? nodeWidthFor(type)
        const h = safeHeight ?? nodeHeightFor(type)
        const position = clampPosition(n.position, w, h)
        const { width: _topW, height: _topH, ...nNoSize } = n as Node & {
          width?: unknown
          height?: unknown
        }
        if (type === 'music') {
          return {
            ...nNoSize,
            type: 'music',
            position,
            data: {
              musicId: dRaw.musicId ?? null,
              width: safeWidth,
              height: safeHeight
            }
          }
        }
        if (type === 'other') {
          return {
            ...nNoSize,
            type: 'other',
            position,
            data: {
              otherId: dRaw.otherId ?? null,
              width: safeWidth,
              height: safeHeight
            }
          }
        }
        return {
          ...nNoSize,
          type: 'editable',
          position,
          data: {
            trickId: dRaw.trickId ?? null,
            width: safeWidth,
            height: safeHeight
          }
        }
      })
      setNodes(hydratedNodes)
      setEdges(loadedShow.edges as Edge[])
      setLoaded(true)
    })()
    return () => {
      cancelled = true
    }
  }, [showId, setNodes, setEdges])

  // Strip node data down to the persisted shape. Drops any transient fields
  // and any legacy top-level width/height that the old NodeResizer may have
  // written outside `data`.
  const stripNode = (n: Node): Node => {
    const d = (n.data ?? {}) as {
      trickId?: string | null
      musicId?: string | null
      otherId?: string | null
      width?: number
      height?: number
    }
    const sized: { width?: number; height?: number } = {}
    if (typeof d.width === 'number') sized.width = d.width
    if (typeof d.height === 'number') sized.height = d.height
    const { width: _topW, height: _topH, ...nNoSize } = n as Node & {
      width?: unknown
      height?: unknown
    }
    if (n.type === 'music') {
      return { ...nNoSize, data: { musicId: d.musicId ?? null, ...sized } }
    }
    if (n.type === 'other') {
      return { ...nNoSize, data: { otherId: d.otherId ?? null, ...sized } }
    }
    return { ...nNoSize, data: { trickId: d.trickId ?? null, ...sized } }
  }

  // Build the current show object from the latest data in refs.
  const buildShow = useCallback((): Show => {
    const d = dataRef.current
    return {
      id: d.showId,
      name: d.showName,
      createdAt: d.createdAt,
      updatedAt: new Date().toISOString(),
      nodes: d.nodes.map(stripNode),
      edges: d.edges,
      showProps: d.showProps
    }
  }, [])

  const saveNow = useCallback(async () => {
    if (!loaded) return
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    const show = buildShow()
    setSaving(true)
    try {
      await sbApi.saveShow(show)
      setSavedAt(show.updatedAt)
      setDirty(false)
    } finally {
      setSaving(false)
    }
  }, [loaded, buildShow])

  // Mark dirty + schedule debounced auto-save whenever the show data changes
  // after the initial load.
  useEffect(() => {
    if (!loaded) return
    setDirty(true)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => { saveNow() }, 400)
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [nodes, edges, showName, showProps, loaded, saveNow])

  // On unmount: flush any pending changes. Fire-and-forget the IPC since
  // we cannot await during cleanup; the main process still writes the file.
  useEffect(() => {
    return () => {
      // Stop any music playing in this show before navigating away.
      stopMusic()
      if (saveTimer.current) clearTimeout(saveTimer.current)
      if (!dirtyRef.current) return
      const d = dataRef.current
      const show: Show = {
        id: d.showId,
        name: d.showName,
        createdAt: d.createdAt,
        updatedAt: new Date().toISOString(),
        nodes: d.nodes.map(stripNode),
        edges: d.edges,
        showProps: d.showProps
      }
      sbApi.saveShow(show)
    }
    // stripNode is defined inline above and is closure-captured here. Empty
    // deps because we only want this on real unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Back navigation flushes any pending save before exiting the canvas.
  const handleBack = useCallback(async () => {
    if (dirty || saveTimer.current) {
      try {
        await saveNow()
      } catch {
        // Even if save fails, still let the user navigate.
      }
    }
    onBack()
  }, [dirty, saveNow, onBack])

  // Cmd+S / Ctrl+S to save.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        saveNow()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [saveNow])

  // Click outside the Add Node menu closes it. Uses Element.closest to avoid
  // a naming collision with reactflow's Node type.
  useEffect(() => {
    if (!addMenuOpen) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Element | null
      if (target && !target.closest('.add-menu-wrapper')) {
        setAddMenuOpen(false)
      }
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [addMenuOpen])

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => onNodesChangeRaw(changes),
    [onNodesChangeRaw]
  )
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => onEdgesChangeRaw(changes),
    [onEdgesChangeRaw]
  )

  const onConnect = useCallback(
    (params: Connection) => {
      setEdges((eds) =>
        addEdge(
          { ...params, markerEnd: { type: MarkerType.ArrowClosed }, animated: false },
          eds
        )
      )
    },
    [setEdges]
  )

  const onNodeClick = useCallback<NodeMouseHandler>((_event, node) => {
    if (node.id === PAGE_NODE_ID) return
    if (node.type === 'page') return
    setActiveNodeId(node.id)
    setSidebarOpen(true)
  }, [])

  const closeSidebar = useCallback(() => {
    setSidebarOpen(false)
  }, [])

  const assignTrick = useCallback((trickId: string) => {
    if (!activeNodeId) return
    setNodes((current) =>
      current.map((n) =>
        n.id === activeNodeId && n.type !== 'music'
          ? { ...n, data: { trickId } as EditableNodeData }
          : n
      )
    )
  }, [activeNodeId, setNodes])

  const assignMusic = useCallback((musicId: string) => {
    if (!activeNodeId) return
    setNodes((current) =>
      current.map((n) =>
        n.id === activeNodeId && n.type === 'music'
          ? { ...n, data: { musicId } as MusicNodeData }
          : n
      )
    )
  }, [activeNodeId, setNodes])

  const assignOther = useCallback((otherId: string) => {
    if (!activeNodeId) return
    setNodes((current) =>
      current.map((n) =>
        n.id === activeNodeId && n.type === 'other'
          ? { ...n, data: { otherId } as OtherNodeData }
          : n
      )
    )
  }, [activeNodeId, setNodes])

  // Set or clear the per-node size override on the active node. Passing
  // undefined for both width and height clears the override; otherwise the
  // value writes through to data.width / data.height.
  const setActiveNodeSize = useCallback(
    (width: number | undefined, height: number | undefined) => {
      if (!activeNodeId) return
      setNodes((current) =>
        current.map((n) => {
          if (n.id !== activeNodeId) return n
          const d = (n.data ?? {}) as Record<string, unknown>
          const next: Record<string, unknown> = { ...d }
          if (width === undefined) delete next.width
          else next.width = width
          if (height === undefined) delete next.height
          else next.height = height
          return { ...n, data: next } as typeof n
        })
      )
    },
    [activeNodeId, setNodes]
  )

  const addNode = useCallback((kind: NodeKind) => {
    const instance = flowRef.current
    const bounds = document.querySelector('.canvas-flow')?.getBoundingClientRect()
    const w = nodeWidthFor(kind === 'trick' ? 'editable' : kind)
    const h = nodeHeightFor(kind === 'trick' ? 'editable' : kind)
    let position: XYPosition = {
      x: CANVAS_WIDTH / 2 - w / 2,
      y: CANVAS_HEIGHT / 2 - h / 2
    }
    if (instance && bounds) {
      const screenCenter = {
        x: bounds.left + bounds.width / 2,
        y: bounds.top + bounds.height / 2
      }
      const flowCenter = instance.screenToFlowPosition(screenCenter)
      position = clampPosition(
        { x: flowCenter.x - w / 2, y: flowCenter.y - h / 2 },
        w,
        h
      )
    }
    const id = makeId('node')
    let newNode: Node
    if (kind === 'music') {
      newNode = { id, type: 'music', position, data: { musicId: null } as MusicNodeData }
    } else if (kind === 'other') {
      newNode = { id, type: 'other', position, data: { otherId: null } as OtherNodeData }
    } else {
      newNode = { id, type: 'editable', position, data: { trickId: null } as EditableNodeData }
    }
    setNodes((current) => current.concat(newNode))
  }, [setNodes])

  const deleteSelected = useCallback(() => {
    setNodes((current) => current.filter((n) => !n.selected))
    setEdges((current) => current.filter((e) => !e.selected))
  }, [setNodes, setEdges])

  const hasSelection = useMemo(
    () => nodes.some((n) => n.selected) || edges.some((e) => e.selected),
    [nodes, edges]
  )

  // Inject the page background as a non-interactive node so it lives in flow
  // coordinates and pans/zooms with the canvas. Filtered out of saves.
  const renderedNodes = useMemo(() => [pageNode, ...nodes], [nodes])

  const activeNode = useMemo(
    () => nodes.find((n) => n.id === activeNodeId) ?? null,
    [activeNodeId, nodes]
  )
  const activeKind: NodeKind | null = activeNode
    ? activeNode.type === 'music'
      ? 'music'
      : activeNode.type === 'other'
      ? 'other'
      : 'trick'
    : null
  const activeTrickId =
    activeKind === 'trick'
      ? ((activeNode!.data as EditableNodeData)?.trickId ?? null)
      : null
  const activeMusicId =
    activeKind === 'music'
      ? ((activeNode!.data as MusicNodeData)?.musicId ?? null)
      : null
  const activeOtherId =
    activeKind === 'other'
      ? ((activeNode!.data as OtherNodeData)?.otherId ?? null)
      : null

  const zoomIn = () => flowRef.current?.zoomIn({ duration: 150 })
  const zoomOut = () => flowRef.current?.zoomOut({ duration: 150 })
  const fitPage = () => {
    flowRef.current?.fitBounds(
      { x: 0, y: 0, width: CANVAS_WIDTH, height: CANVAS_HEIGHT },
      { padding: 0.08, duration: 200 }
    )
  }

  return (
    <div className="canvas">
      <header className="canvas-header">
        <button className="btn-ghost" onClick={handleBack}>← Shows</button>
        <input
          className="show-name-input"
          value={showName}
          onChange={(e) => setShowName(e.target.value)}
          placeholder="Untitled Show"
        />
        <div className="canvas-actions">
          <span className={`save-indicator ${dirty ? 'save-indicator-dirty' : 'save-indicator-clean'}`}>
            {saving
              ? 'Saving...'
              : dirty
              ? 'Unsaved'
              : savedAt
              ? `Saved ${new Date(savedAt).toLocaleTimeString()}`
              : ''}
          </span>
          <button
            className="btn-secondary"
            onClick={saveNow}
            disabled={saving || (!dirty && !!savedAt)}
            title="Save now (Cmd+S)"
          >
            Save
          </button>
          <button
            className="btn-secondary"
            onClick={() => setInfoOpen(true)}
            title="Show runtime and prop list"
          >
            Show Info
          </button>
          <div className="zoom-group" role="group" aria-label="Zoom">
            <button
              className="btn-secondary zoom-btn"
              onClick={zoomOut}
              title="Zoom out"
              aria-label="Zoom out"
            >
              −
            </button>
            <button
              className="btn-secondary zoom-btn zoom-fit"
              onClick={fitPage}
              title="Fit page"
              aria-label="Fit page"
            >
              Fit
            </button>
            <button
              className="btn-secondary zoom-btn"
              onClick={zoomIn}
              title="Zoom in"
              aria-label="Zoom in"
            >
              +
            </button>
          </div>
          <button className="btn-secondary" onClick={deleteSelected} disabled={!hasSelection}>
            Delete Selected
          </button>
          <div className="add-menu-wrapper" ref={addMenuRef}>
            <button
              className="btn-primary add-menu-trigger"
              onClick={() => setAddMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={addMenuOpen}
            >
              + Add Node <span className="add-menu-caret" aria-hidden>▾</span>
            </button>
            {addMenuOpen && (
              <div className="add-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  className="add-menu-item"
                  onClick={() => {
                    addNode('trick')
                    setAddMenuOpen(false)
                  }}
                >
                  <span className="add-menu-swatch add-menu-swatch-trick" />
                  <span>Trick</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="add-menu-item"
                  onClick={() => {
                    addNode('music')
                    setAddMenuOpen(false)
                  }}
                >
                  <span className="add-menu-swatch add-menu-swatch-music" />
                  <span>Music</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="add-menu-item"
                  onClick={() => {
                    addNode('other')
                    setAddMenuOpen(false)
                  }}
                >
                  <span className="add-menu-swatch add-menu-swatch-other" />
                  <span>Other</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </header>
      <div className="canvas-flow">
        <ReactFlow
          nodes={renderedNodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={onNodeClick}
          onPaneClick={closeSidebar}
          onInit={(instance) => {
            flowRef.current = instance
            instance.setCenter(CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2, { zoom: 1 })
          }}
          nodeTypes={nodeTypes}
          deleteKeyCode={['Backspace', 'Delete']}
          defaultEdgeOptions={{ markerEnd: { type: MarkerType.ArrowClosed } }}
          connectionMode={ConnectionMode.Loose}
          panOnScroll
          panOnScrollSpeed={0.8}
          zoomOnScroll={false}
          zoomActivationKeyCode="Space"
          zoomOnPinch
          zoomOnDoubleClick={false}
          translateExtent={[
            [0, 0],
            [CANVAS_WIDTH, CANVAS_HEIGHT]
          ]}
          nodeExtent={[
            [0, 0],
            [CANVAS_WIDTH, CANVAS_HEIGHT]
          ]}
          minZoom={0.3}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={20} size={1} color="rgba(0,0,0,0)" />
          <MiniMap pannable zoomable maskColor="rgba(0,0,0,0.4)" />
        </ReactFlow>
      </div>
      <TrickSidebar
        open={sidebarOpen && activeKind === 'trick'}
        assignedTrickId={activeTrickId}
        onClose={closeSidebar}
        onAssign={(trickId) => {
          assignTrick(trickId)
        }}
        nodeOverrideWidth={
          activeKind === 'trick'
            ? (activeNode?.data as EditableNodeData)?.width
            : undefined
        }
        nodeOverrideHeight={
          activeKind === 'trick'
            ? (activeNode?.data as EditableNodeData)?.height
            : undefined
        }
        onSetNodeSize={setActiveNodeSize}
      />
      <MusicSidebar
        open={sidebarOpen && activeKind === 'music'}
        assignedMusicId={activeMusicId}
        onClose={closeSidebar}
        onAssign={(musicId) => {
          assignMusic(musicId)
        }}
      />
      <OtherSidebar
        open={sidebarOpen && activeKind === 'other'}
        assignedOtherId={activeOtherId}
        onClose={closeSidebar}
        onAssign={(otherId) => {
          assignOther(otherId)
        }}
        nodeOverrideWidth={
          activeKind === 'other'
            ? (activeNode?.data as OtherNodeData)?.width
            : undefined
        }
        nodeOverrideHeight={
          activeKind === 'other'
            ? (activeNode?.data as OtherNodeData)?.height
            : undefined
        }
        onSetNodeSize={setActiveNodeSize}
      />
      <ShowInfo
        open={infoOpen}
        onClose={() => setInfoOpen(false)}
        showName={showName}
        showProps={showProps}
        onShowPropsChange={setShowProps}
        nodes={nodes}
        edges={edges}
      />
    </div>
  )
}
