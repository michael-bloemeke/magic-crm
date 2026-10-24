import { useEffect, useMemo, useState } from 'react'
import type { Music } from '../types'
import { useMusic, blankMusic } from './MusicContext'
import { MusicForm } from './MusicForm'

type Mode =
  | { kind: 'picker' }
  | { kind: 'details' }
  | { kind: 'edit'; music: Music }

type Props = {
  open: boolean
  assignedMusicId: string | null
  onClose: () => void
  onAssign: (musicId: string) => void
}

export function MusicSidebar({ open, assignedMusicId, onClose, onAssign }: Props) {
  const { music, musicById, audioFilesById, saveMusic } = useMusic()
  const [mode, setMode] = useState<Mode>({ kind: 'picker' })
  const [search, setSearch] = useState('')

  useEffect(() => {
    if (!open) return
    if (assignedMusicId && musicById.has(assignedMusicId)) {
      setMode({ kind: 'details' })
    } else {
      setMode({ kind: 'picker' })
    }
    setSearch('')
  }, [open, assignedMusicId, musicById])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const filteredMusic = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return music
    return music.filter((m) => m.name.toLowerCase().includes(q))
  }, [music, search])

  const assigned = assignedMusicId ? musicById.get(assignedMusicId) ?? null : null
  const assignedAudio = assigned?.audioFileId
    ? audioFilesById.get(assigned.audioFileId) ?? null
    : null

  return (
    <aside className={`sidebar sidebar-music ${open ? 'sidebar-open' : ''}`} aria-hidden={!open}>
      <div className="sidebar-header sidebar-header-music">
        <h2 className="sidebar-title">
          {mode.kind === 'picker' && 'Assign music'}
          {mode.kind === 'details' && (assigned?.name ?? 'Music')}
          {mode.kind === 'edit' && (mode.music.name ? `Edit: ${mode.music.name}` : 'New music')}
        </h2>
        <button className="btn-ghost sidebar-close" onClick={onClose} aria-label="Close sidebar">
          ✕
        </button>
      </div>

      <div className="sidebar-body">
        {mode.kind === 'picker' && (
          <div className="picker">
            <button
              className="picker-add picker-add-music"
              onClick={() => setMode({ kind: 'edit', music: blankMusic() })}
            >
              <span className="picker-add-plus">+</span>
              <span>Add new music</span>
            </button>

            <input
              className="text-input picker-search"
              placeholder="Search music..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />

            {filteredMusic.length === 0 ? (
              <p className="muted picker-empty">
                {music.length === 0
                  ? 'No music in your library yet.'
                  : 'No music matches.'}
              </p>
            ) : (
              <ul className="picker-list">
                {filteredMusic.map((m) => {
                  const audio = m.audioFileId ? audioFilesById.get(m.audioFileId) : null
                  return (
                    <li key={m.id}>
                      <button className="picker-item" onClick={() => onAssign(m.id)}>
                        <span className="picker-item-name">{m.name}</span>
                        {audio && (
                          <span className="picker-item-desc">♪ {audio.displayName}</span>
                        )}
                        {m.description && (
                          <span className="picker-item-desc">{m.description}</span>
                        )}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )}

        {mode.kind === 'details' && assigned && (
          <div className="details">
            <DetailField label="Description" value={assigned.description} />
            <DetailField label="Start cue" value={assigned.startCue} />
            <DetailField label="Stop cue" value={assigned.stopCue} />
            <div className="detail-field">
              <div className="detail-label">File</div>
              <div className="detail-value">
                {assignedAudio ? (
                  <>
                    <span>♪ {assignedAudio.displayName}</span>
                    <div className="muted detail-file-meta">
                      {assignedAudio.originalFilename}
                    </div>
                  </>
                ) : (
                  <span className="muted">No file assigned.</span>
                )}
              </div>
            </div>

            <div className="details-actions">
              <button
                className="btn-secondary"
                onClick={() => setMode({ kind: 'edit', music: assigned })}
              >
                Edit Music
              </button>
              <button
                className="btn-primary"
                onClick={() => setMode({ kind: 'picker' })}
              >
                Change Music
              </button>
            </div>
          </div>
        )}

        {mode.kind === 'details' && !assigned && (
          <p className="muted">This node's assigned music was removed. Pick another.</p>
        )}

        {mode.kind === 'edit' && (
          <MusicForm
            initial={mode.music}
            autoFocusName={!mode.music.name}
            saveLabel="Save & Assign"
            onSave={async (m) => {
              const saved = await saveMusic(m)
              onAssign(saved.id)
            }}
            onCancel={() => {
              if (assignedMusicId && musicById.has(assignedMusicId)) {
                setMode({ kind: 'details' })
              } else {
                setMode({ kind: 'picker' })
              }
            }}
          />
        )}
      </div>
    </aside>
  )
}

function DetailField({ label, value }: { label: string; value?: string }) {
  if (!value || !value.trim()) return null
  return (
    <div className="detail-field">
      <div className="detail-label">{label}</div>
      <div className="detail-value detail-value-pre">{value}</div>
    </div>
  )
}
