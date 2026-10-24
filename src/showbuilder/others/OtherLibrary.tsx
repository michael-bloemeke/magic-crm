import { useMemo, useState } from 'react'
import type { Other } from '../types'
import { useOthers, blankOther } from './OthersContext'
import { OtherForm } from './OtherForm'

type Props = {
  onBack: () => void
}

type Editing =
  | { kind: 'none' }
  | { kind: 'editing'; other: Other }

export function OtherLibrary({ onBack }: Props) {
  const { others, saveOther, deleteOther } = useOthers()
  const [editing, setEditing] = useState<Editing>({ kind: 'none' })
  const [search, setSearch] = useState('')
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return others
    return others.filter((o) => o.name.toLowerCase().includes(q))
  }, [others, search])

  return (
    <div className="library">
      <header className="library-header">
        <button className="btn-ghost" onClick={onBack}>← Shows</button>
        <h1>Other</h1>
        <div className="library-actions">
          <button
            className="btn-primary"
            onClick={() => setEditing({ kind: 'editing', other: blankOther() })}
          >
            + New Item
          </button>
        </div>
      </header>

      <main className="library-body">
        <input
          className="text-input library-search"
          placeholder="Search items..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        {others.length === 0 && (
          <div className="empty-state">
            <p>No items yet.</p>
            <p className="muted">Click "+ New Item" to add a joke, story, video cue, or anything that isn't a trick or a music track.</p>
          </div>
        )}

        {others.length > 0 && filtered.length === 0 && (
          <p className="muted library-empty-search">No items match.</p>
        )}

        {filtered.length > 0 && (
          <ul className="library-list">
            {filtered.map((o) => (
              <li key={o.id} className="library-row">
                <button
                  className="library-row-main"
                  onClick={() => setEditing({ kind: 'editing', other: o })}
                >
                  <div className="library-row-name other-picker-name">
                    {o.color && (
                      <span
                        className="other-picker-swatch"
                        style={{ background: o.color }}
                        aria-hidden
                      />
                    )}
                    {o.name}
                  </div>
                  {o.duration && (
                    <div className="library-row-desc">{o.duration}</div>
                  )}
                  {o.description && (
                    <div className="library-row-desc">{o.description}</div>
                  )}
                </button>
                {pendingDelete === o.id ? (
                  <div className="confirm-delete">
                    <span className="muted">Delete?</span>
                    <button
                      className="btn-danger"
                      onClick={async () => {
                        await deleteOther(o.id)
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
                  <button className="btn-ghost" onClick={() => setPendingDelete(o.id)}>
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
              <h2>{editing.other.name ? `Edit: ${editing.other.name}` : 'New item'}</h2>
              <button
                className="btn-ghost sidebar-close"
                onClick={() => setEditing({ kind: 'none' })}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <div className="modal-body">
              <OtherForm
                initial={editing.other}
                autoFocusName={!editing.other.name}
                onSave={async (o) => {
                  await saveOther(o)
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
