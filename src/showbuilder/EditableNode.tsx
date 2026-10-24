import type { MouseEvent } from 'react'
import { Handle, Position, type NodeProps } from 'reactflow'
import { useTricks } from './tricks/TricksContext'
import { useMusic } from './music/MusicContext'
import { useOthers, hexToRgba, tintedBg } from './others/OthersContext'

export const NODE_SIZE = 130

export const MUSIC_NODE_WIDTH = 130
export const MUSIC_NODE_HEIGHT = 70

export const OTHER_NODE_WIDTH = 130
export const OTHER_NODE_HEIGHT = 130

export const TRICK_MIN_SIZE = 80
export const MUSIC_MIN_WIDTH = 90
export const MUSIC_MIN_HEIGHT = 50

export type EditableNodeData = {
  trickId?: string | null
  width?: number
  height?: number
}

export type PageNodeData = { width: number; height: number }

export function PageNode({ data }: NodeProps<PageNodeData>) {
  return (
    <div
      className="canvas-page"
      style={{ width: data.width, height: data.height }}
    />
  )
}

export function EditableNode({ data, selected }: NodeProps<EditableNodeData>) {
  const { tricksById } = useTricks()
  const trick = data.trickId ? tricksById.get(data.trickId) : null
  const assigned = !!trick

  // Effective size: per-node override > trick preferred > global default.
  const width = data.width ?? trick?.preferredWidth ?? NODE_SIZE
  const height = data.height ?? trick?.preferredHeight ?? NODE_SIZE

  return (
    <div
      className={`node-card ${selected ? 'node-card-selected' : ''} ${assigned ? '' : 'node-card-empty'}`}
      style={{ width, height }}
    >
      {/* In ConnectionMode.Loose, source handles also accept connections,
          so one handle per side covers both directions. */}
      <Handle id="top" type="source" position={Position.Top} className="node-handle" />
      <Handle id="right" type="source" position={Position.Right} className="node-handle" />
      <Handle id="bottom" type="source" position={Position.Bottom} className="node-handle" />
      <Handle id="left" type="source" position={Position.Left} className="node-handle" />

      {assigned ? (
        <div className="node-label">{trick!.name}</div>
      ) : (
        <div className="node-label node-label-empty">Click to assign</div>
      )}
    </div>
  )
}

export type MusicNodeData = {
  musicId?: string | null
  width?: number
  height?: number
}

export function MusicNode({ data, selected }: NodeProps<MusicNodeData>) {
  const { musicById, playingAudioId, play, stop } = useMusic()
  const music = data.musicId ? musicById.get(data.musicId) : null
  const assigned = !!music
  const audioId = music?.audioFileId ?? null
  const isPlaying = !!audioId && playingAudioId === audioId

  const width = data.width ?? MUSIC_NODE_WIDTH
  const height = data.height ?? MUSIC_NODE_HEIGHT

  const onPlayClick = (e: MouseEvent) => {
    e.stopPropagation()
    if (!audioId) return
    if (isPlaying) stop()
    else play(audioId)
  }

  return (
    <div
      className={`music-node ${selected ? 'music-node-selected' : ''} ${assigned ? '' : 'music-node-empty'}`}
      style={{ width, height }}
    >
      <Handle id="top" type="source" position={Position.Top} className="node-handle music-handle" />
      <Handle id="right" type="source" position={Position.Right} className="node-handle music-handle" />
      <Handle id="bottom" type="source" position={Position.Bottom} className="node-handle music-handle" />
      <Handle id="left" type="source" position={Position.Left} className="node-handle music-handle" />
      <span className="music-node-icon" aria-hidden>♪</span>
      <div className={`music-node-label ${assigned ? '' : 'music-node-label-empty'}`}>
        {assigned ? music!.name : 'Click to assign'}
      </div>
      {audioId && (
        <button
          type="button"
          className={`music-play-btn ${isPlaying ? 'music-play-btn-playing' : ''}`}
          onClick={onPlayClick}
          onMouseDown={(e) => e.stopPropagation()}
          title={isPlaying ? 'Stop' : 'Play'}
          aria-label={isPlaying ? 'Stop' : 'Play'}
        >
          {isPlaying ? '■' : '▶'}
        </button>
      )}
    </div>
  )
}

export type OtherNodeData = {
  otherId?: string | null
  width?: number
  height?: number
}

export function OtherNode({ data, selected }: NodeProps<OtherNodeData>) {
  const { othersById } = useOthers()
  const other = data.otherId ? othersById.get(data.otherId) : null
  const assigned = !!other

  const width = data.width ?? other?.preferredWidth ?? OTHER_NODE_WIDTH
  const height = data.height ?? other?.preferredHeight ?? OTHER_NODE_HEIGHT
  const color = other?.color ?? '#7a8aa0'
  const bg = tintedBg(color, 0.18)

  // Empty (no item assigned) -> neutral dashed look, like trick/music empty.
  // Assigned -> opaque tinted background (color mixed with dark base) plus
  // a colored border.
  const cardStyle = assigned
    ? {
        width,
        height,
        background: bg,
        borderColor: color,
        boxShadow: selected
          ? `0 0 0 1px ${color}, 0 4px 14px ${hexToRgba(color, 0.3)}`
          : undefined
      }
    : { width, height }

  return (
    <div
      className={`other-node ${selected ? 'other-node-selected' : ''} ${assigned ? '' : 'other-node-empty'}`}
      style={cardStyle}
    >
      <Handle id="top" type="source" position={Position.Top} className="node-handle other-handle"
        style={assigned ? { background: color } : undefined} />
      <Handle id="right" type="source" position={Position.Right} className="node-handle other-handle"
        style={assigned ? { background: color } : undefined} />
      <Handle id="bottom" type="source" position={Position.Bottom} className="node-handle other-handle"
        style={assigned ? { background: color } : undefined} />
      <Handle id="left" type="source" position={Position.Left} className="node-handle other-handle"
        style={assigned ? { background: color } : undefined} />

      {assigned ? (
        <div className="other-node-label">{other!.name}</div>
      ) : (
        <div className="other-node-label other-node-label-empty">Click to assign</div>
      )}
    </div>
  )
}
