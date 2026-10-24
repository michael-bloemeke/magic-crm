import { useMemo, useState } from 'react'
import type { Music } from '../types'
import { useMusic, blankMusic } from './MusicContext'
import { MusicForm } from './MusicForm'

type Props = {
  onBack: () => void
}

type Editing =
  | { kind: 'none' }
  | { kind: 'editing'; music: Music }

export function MusicLibrary({ onBack }: Props) {
  const { music, audioFilesById, playingAudioId, play, stop, saveMusic, deleteMusic } = useMusic()
  const [editing, setEditing] = useState<Editing>({ kind: 'none' })
  const [search, setSearch] = useState('')
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return music
    return music.filter((m) => m.name.toLowerCase().includes(q))
  }, [music, search])

  return (
    <div className="library">
      <header className="library-header">
        <button className="btn-ghost" onClick={onBack}>← Shows</button>
        <h1>Music</h1>
        <div className="library-actions">
          <button
            className="btn-primary"
            onClick={() => setEditing({ kind: 'editing', music: blankMusic() })}
          >
            + New Music
          </button>
        </div>
      </header>

      <main className="library-body">
        <input
          className="text-input library-search"
          placeholder="Search music..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        {music.length === 0 && (
          <div className="empty-state">
            <p>No music yet.</p>
            <p className="muted">Click "+ New Music" to add a track.</p>
          </div>
        )}

        {music.length > 0 && filtered.length === 0 && (
          <p className="muted library-empty-search">No music matches.</p>
        )}

        {filtered.length > 0 && (
          <ul className="library-list">
            {filtered.map((m) => {
              const audio = m.audioFileId ? audioFilesById.get(m.audioFileId) : null
              const isPlaying = !!audio && playingAudioId === audio.id
              return (
                <li key={m.id} className="library-row library-row-music">
                  {audio && (
                    <button
                      type="button"
                      className={`music-play-btn library-play-btn ${isPlaying ? 'music-play-btn-playing' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (isPlaying) stop()
                        else play(audio.id)
                      }}
                      title={isPlaying ? 'Stop' : 'Play'}
                      aria-label={isPlaying ? 'Stop' : 'Play'}
                    >
                      {isPlaying ? '■' : '▶'}
                    </button>
                  )}
                  <button
                    className="library-row-main"
                    onClick={() => setEditing({ kind: 'editing', music: m })}
                  >
                    <div className="library-row-name">{m.name}</div>
                    {audio && (
                      <div className="library-row-desc">♪ {audio.displayName}</div>
                    )}
                    {m.description && (
                      <div className="library-row-desc">{m.description}</div>
                    )}
                  </button>
                  {pendingDelete === m.id ? (
                    <div className="confirm-delete">
                      <span className="muted">Delete?</span>
                      <button
                        className="btn-danger"
                        onClick={async () => {
                          await deleteMusic(m.id)
                          setPendingDelete(null)
                        }}
                      >
                        Yes
                      </button>
                      <button className="btn-secondary" onClick={() => setPendingDelete(null)}>
                        No
                      </button>
                    </div>
                  ) : (
                    <button className="btn-ghost" onClick={() => setPendingDelete(m.id)}>
                      Delete
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </main>

      {editing.kind === 'editing' && (
        <div className="modal-backdrop" onClick={() => setEditing({ kind: 'none' })}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{editing.music.name ? `Edit: ${editing.music.name}` : 'New music'}</h2>
              <button
                className="btn-ghost sidebar-close"
                onClick={() => setEditing({ kind: 'none' })}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <div className="modal-body">
              <MusicForm
                initial={editing.music}
                autoFocusName={!editing.music.name}
                onSave={async (m) => {
                  await saveMusic(m)
                  setEditing({ kind: 'none' })
                }}
                onCancel={() => setEditing({ kind: 'none' })}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
