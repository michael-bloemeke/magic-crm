import { useEffect, useState, useCallback } from 'react'
import type { ShowSummary, Show } from './types'
import { useTricks } from './tricks/TricksContext'
import { TagChip } from './tricks/TagChip'
import { sbApi } from './sbApi'

type Props = {
  onOpenShow: (id: string) => void
  onOpenTricks: () => void
  onOpenMusic: () => void
  onOpenOthers: () => void
}

function newShowId(): string {
  return (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? crypto.randomUUID()
    : `show-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

export function HomeScreen({ onOpenShow, onOpenTricks, onOpenMusic, onOpenOthers }: Props) {
  const { tags, deleteTag } = useTricks()
  const [shows, setShows] = useState<ShowSummary[] | null>(null)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [pendingTagDelete, setPendingTagDelete] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const list = await sbApi.listShows()
    setShows(list)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const createNewShow = async () => {
    const now = new Date().toISOString()
    const show: Show = {
      id: newShowId(),
      name: 'Untitled Show',
      createdAt: now,
      updatedAt: now,
      nodes: [],
      edges: []
    }
    await sbApi.saveShow(show)
    onOpenShow(show.id)
  }

  const confirmDelete = async (id: string) => {
    await sbApi.deleteShow(id)
    setPendingDelete(null)
    refresh()
  }

  return (
    <div className="home">
      <header className="home-header">
        <h1>Shows</h1>
        <div className="home-actions">
          <button className="btn-secondary" onClick={onOpenTricks}>
            Tricks
          </button>
          <button className="btn-secondary" onClick={onOpenMusic}>
            Music
          </button>
          <button className="btn-secondary" onClick={onOpenOthers}>
            Other
          </button>
          <button className="btn-primary" onClick={createNewShow}>
            + New Show
          </button>
        </div>
      </header>

      <main className="home-list">
        {shows === null && <p className="muted">Loading...</p>}
        {shows && shows.length === 0 && (
          <div className="empty-state">
            <p>No shows yet.</p>
            <p className="muted">Click "+ New Show" to build your first one.</p>
          </div>
        )}
        {shows && shows.length > 0 && (
          <ul className="show-list">
            {shows.map((s) => (
              <li key={s.id} className="show-row">
                <button className="show-row-main" onClick={() => onOpenShow(s.id)}>
                  <div className="show-name">{s.name}</div>
                  <div className="show-meta">Updated {formatDate(s.updatedAt)}</div>
                </button>
                {pendingDelete === s.id ? (
                  <div className="confirm-delete">
                    <span className="muted">Delete?</span>
                    <button className="btn-danger" onClick={() => confirmDelete(s.id)}>Yes</button>
                    <button className="btn-secondary" onClick={() => setPendingDelete(null)}>No</button>
                  </div>
                ) : (
                  <button className="btn-ghost" onClick={() => setPendingDelete(s.id)}>
                    Delete
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        {tags.length > 0 && (
          <section className="home-tags">
            <h2 className="home-tags-title">Tags</h2>
            <div className="home-tags-list">
              {tags.map((t) =>
                pendingTagDelete === t.id ? (
                  <div key={t.id} className="confirm-delete confirm-delete-tag">
                    <span className="muted">Delete &ldquo;{t.name}&rdquo;?</span>
                    <button
                      className="btn-danger"
                      onClick={async () => {
                        await deleteTag(t.id)
                        setPendingTagDelete(null)
                      }}
                    >
                      Yes
                    </button>
                    <button
                      className="btn-secondary"
                      onClick={() => setPendingTagDelete(null)}
                    >
                      No
                    </button>
                  </div>
                ) : (
                  <TagChip
                    key={t.id}
                    tag={t}
                    size="md"
                    onRemove={() => setPendingTagDelete(t.id)}
                  />
                )
              )}
            </div>
            <p className="muted home-tags-hint">
              Removing a tag here removes it from every trick that uses it.
            </p>
          </section>
        )}
      </main>
    </div>
  )
}
