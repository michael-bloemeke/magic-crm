import { useMemo, useState } from 'react'
import type { Trick } from '../types'
import { useTricks, blankTrick } from './TricksContext'
import { TrickForm } from './TrickForm'
import { TagChip } from './TagChip'
import { TagFilter } from './TagFilter'

type Props = {
  onBack: () => void
}

type Editing =
  | { kind: 'none' }
  | { kind: 'editing'; trick: Trick }

export function TricksLibrary({ onBack }: Props) {
  const { tricks, tagsById, saveTrick, deleteTrick } = useTricks()
  const [editing, setEditing] = useState<Editing>({ kind: 'none' })
  const [search, setSearch] = useState('')
  const [filterTagIds, setFilterTagIds] = useState<string[]>([])
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return tricks.filter((t) => {
      if (q && !t.name.toLowerCase().includes(q)) return false
      if (filterTagIds.length > 0) {
        for (const id of filterTagIds) {
          if (!t.tagIds?.includes(id)) return false
        }
      }
      return true
    })
  }, [tricks, search, filterTagIds])

  return (
    <div className="library">
      <header className="library-header">
        <button className="btn-ghost" onClick={onBack}>← Shows</button>
        <h1>Tricks</h1>
        <div className="library-actions">
          <button
            className="btn-primary"
            onClick={() => setEditing({ kind: 'editing', trick: blankTrick() })}
          >
            + New Trick
          </button>
        </div>
      </header>

      <main className="library-body">
        <input
          className="text-input library-search"
          placeholder="Search tricks..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <TagFilter
          selectedTagIds={filterTagIds}
          onChange={setFilterTagIds}
          onlyInUse
        />

        {tricks.length === 0 && (
          <div className="empty-state">
            <p>No tricks yet.</p>
            <p className="muted">Click "+ New Trick" to start your library.</p>
          </div>
        )}

        {tricks.length > 0 && filtered.length === 0 && (
          <p className="muted library-empty-search">No tricks match that search.</p>
        )}

        {filtered.length > 0 && (
          <ul className="library-list">
            {filtered.map((t) => (
              <li key={t.id} className="library-row">
                <button
                  className="library-row-main"
                  onClick={() => setEditing({ kind: 'editing', trick: t })}
                >
                  <div className="library-row-name">{t.name}</div>
                  {(t.tagIds?.length ?? 0) > 0 && (
                    <div className="library-row-tags">
                      {(t.tagIds ?? []).map((id) => {
                        const tag = tagsById.get(id)
                        if (!tag) return null
                        return <TagChip key={id} tag={tag} size="sm" />
                      })}
                    </div>
                  )}
                  {t.description && (
                    <div className="library-row-desc">{t.description}</div>
                  )}
                </button>
                {pendingDelete === t.id ? (
                  <div className="confirm-delete">
                    <span className="muted">Delete?</span>
                    <button
                      className="btn-danger"
                      onClick={async () => {
                        await deleteTrick(t.id)
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
                  <button className="btn-ghost" onClick={() => setPendingDelete(t.id)}>
                    Delete
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </main>

      {editing.kind === 'editing' && (
        <div className="modal-backdrop" onClick={() => setEditing({ kind: 'none' })}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{editing.trick.name ? `Edit: ${editing.trick.name}` : 'New trick'}</h2>
              <button
                className="btn-ghost sidebar-close"
                onClick={() => setEditing({ kind: 'none' })}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <div className="modal-body">
              <TrickForm
                initial={editing.trick}
                autoFocusName={!editing.trick.name}
                onSave={async (trick) => {
                  await saveTrick(trick)
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
