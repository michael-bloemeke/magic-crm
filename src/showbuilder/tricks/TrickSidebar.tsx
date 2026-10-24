import { useEffect, useMemo, useState } from 'react'
import type { Trick } from '../types'
import { useTricks, blankTrick } from './TricksContext'
import { TrickForm } from './TrickForm'
import { TagChip } from './TagChip'
import { TagFilter } from './TagFilter'

type Mode =
  | { kind: 'picker' }
  | { kind: 'details' }
  | { kind: 'edit'; trick: Trick }

type Props = {
  open: boolean
  assignedTrickId: string | null
  onClose: () => void
  onAssign: (trickId: string) => void
  // Per-node size override (only relevant when a node is selected).
  nodeOverrideWidth?: number
  nodeOverrideHeight?: number
  onSetNodeSize?: (width: number | undefined, height: number | undefined) => void
}

export function TrickSidebar({
  open,
  assignedTrickId,
  onClose,
  onAssign,
  nodeOverrideWidth,
  nodeOverrideHeight,
  onSetNodeSize
}: Props) {
  const { tricks, tricksById, tagsById, saveTrick } = useTricks()
  const [mode, setMode] = useState<Mode>({ kind: 'picker' })
  const [search, setSearch] = useState('')
  const [filterTagIds, setFilterTagIds] = useState<string[]>([])

  // Reset mode based on whether there's an assigned trick whenever the sidebar
  // opens or the assigned trick changes.
  useEffect(() => {
    if (!open) return
    if (assignedTrickId && tricksById.has(assignedTrickId)) {
      setMode({ kind: 'details' })
    } else {
      setMode({ kind: 'picker' })
    }
    setSearch('')
    setFilterTagIds([])
  }, [open, assignedTrickId, tricksById])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const filteredTricks = useMemo(() => {
    const q = search.trim().toLowerCase()
    return tricks.filter((t) => {
      if (q && !t.name.toLowerCase().includes(q)) return false
      if (filterTagIds.length > 0) {
        // AND: trick must have every selected tag
        for (const id of filterTagIds) {
          if (!t.tagIds?.includes(id)) return false
        }
      }
      return true
    })
  }, [tricks, search, filterTagIds])

  const assigned = assignedTrickId ? tricksById.get(assignedTrickId) ?? null : null
  const assignedTags = useMemo(
    () => (assigned?.tagIds ?? []).map((id) => tagsById.get(id)).filter(Boolean),
    [assigned, tagsById]
  )

  return (
    <aside className={`sidebar ${open ? 'sidebar-open' : ''}`} aria-hidden={!open}>
      <div className="sidebar-header">
        <h2 className="sidebar-title">
          {mode.kind === 'picker' && 'Assign a trick'}
          {mode.kind === 'details' && (assigned?.name ?? 'Trick')}
          {mode.kind === 'edit' && (mode.trick.name ? `Edit: ${mode.trick.name}` : 'New trick')}
        </h2>
        <button className="btn-ghost sidebar-close" onClick={onClose} aria-label="Close sidebar">
          ✕
        </button>
      </div>

      <div className="sidebar-body">
        {mode.kind === 'picker' && (
          <div className="picker">
            <button
              className="picker-add"
              onClick={() => setMode({ kind: 'edit', trick: blankTrick() })}
            >
              <span className="picker-add-plus">+</span>
              <span>Add new trick</span>
            </button>

            <input
              className="text-input picker-search"
              placeholder="Search tricks..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />

            <TagFilter
              selectedTagIds={filterTagIds}
              onChange={setFilterTagIds}
              onlyInUse
            />

            {filteredTricks.length === 0 ? (
              <p className="muted picker-empty">
                {tricks.length === 0
                  ? 'No tricks in your library yet.'
                  : 'No tricks match.'}
              </p>
            ) : (
              <ul className="picker-list">
                {filteredTricks.map((t) => (
                  <li key={t.id}>
                    <button className="picker-item" onClick={() => onAssign(t.id)}>
                      <span className="picker-item-name">{t.name}</span>
                      {(t.tagIds?.length ?? 0) > 0 && (
                        <span className="picker-item-tags">
                          {(t.tagIds ?? []).map((id) => {
                            const tag = tagsById.get(id)
                            if (!tag) return null
                            return <TagChip key={id} tag={tag} size="sm" />
                          })}
                        </span>
                      )}
                      {t.description && (
                        <span className="picker-item-desc">{t.description}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {mode.kind === 'details' && assigned && (
          <div className="details">
            {assignedTags.length > 0 && (
              <div className="detail-tags">
                {assignedTags.map((tag) => tag && <TagChip key={tag.id} tag={tag} size="sm" />)}
              </div>
            )}
            <DetailField label="Description" value={assigned.description} />
            <DetailField label="Source" value={assigned.source} inline />
            <DetailField label="Duration" value={assigned.duration} inline />
            <DetailPropsField label="Props" items={assigned.props} />
            <DetailField label="Script" value={assigned.script} preformatted />
            <DetailField label="Notes" value={assigned.notes} preformatted />

            <NodeSizeOverride
              trickWidth={assigned.preferredWidth}
              trickHeight={assigned.preferredHeight}
              overrideWidth={nodeOverrideWidth}
              overrideHeight={nodeOverrideHeight}
              onChange={onSetNodeSize}
            />

            <div className="details-actions">
              <button
                className="btn-secondary"
                onClick={() => setMode({ kind: 'edit', trick: assigned })}
              >
                Edit Trick
              </button>
              <button
                className="btn-primary"
                onClick={() => setMode({ kind: 'picker' })}
              >
                Change Trick
              </button>
            </div>
          </div>
        )}

        {mode.kind === 'details' && !assigned && (
          <p className="muted">This node's assigned trick was removed. Pick another.</p>
        )}

        {mode.kind === 'edit' && (
          <TrickForm
            initial={mode.trick}
            autoFocusName={!mode.trick.name}
            saveLabel="Save & Assign"
            onSave={async (trick) => {
              const saved = await saveTrick(trick)
              onAssign(saved.id)
            }}
            onCancel={() => {
              if (assignedTrickId && tricksById.has(assignedTrickId)) {
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

function DetailField({
  label,
  value,
  inline,
  preformatted
}: {
  label: string
  value?: string
  inline?: boolean
  preformatted?: boolean
}) {
  if (!value || !value.trim()) return null
  return (
    <div className={`detail-field ${inline ? 'detail-field-inline' : ''}`}>
      <div className="detail-label">{label}</div>
      <div className={`detail-value ${preformatted ? 'detail-value-pre' : ''}`}>{value}</div>
    </div>
  )
}

function DetailPropsField({
  label,
  items
}: {
  label: string
  items?: { name: string; reusable?: boolean }[]
}) {
  if (!items || items.length === 0) return null
  return (
    <div className="detail-field">
      <div className="detail-label">{label}</div>
      <ul className="detail-list">
        {items.map((item, i) => (
          <li key={i}>
            {item.name}
            {item.reusable && <span className="detail-prop-reusable"> · reusable</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}

function NodeSizeOverride({
  trickWidth,
  trickHeight,
  overrideWidth,
  overrideHeight,
  onChange
}: {
  trickWidth?: number
  trickHeight?: number
  overrideWidth?: number
  overrideHeight?: number
  onChange?: (width: number | undefined, height: number | undefined) => void
}) {
  if (!onChange) return null

  const hasOverride = overrideWidth !== undefined || overrideHeight !== undefined
  const defaultHint = `${trickWidth ?? 130} × ${trickHeight ?? 130}`

  // Parse on every keystroke, no clamping. Lets the user type "100" without
  // an intermediate "1" getting jumped to 80.
  const parseLoose = (raw: string): number | undefined => {
    if (raw === '') return undefined
    const n = parseInt(raw)
    if (!Number.isFinite(n)) return undefined
    return n
  }
  // On blur, snap the current value into the valid [80, 800] range.
  const clamp = (n: number | undefined): number | undefined => {
    if (n === undefined) return undefined
    return Math.max(40, Math.min(800, n))
  }

  return (
    <div className="size-controls">
      <div className="size-controls-header">
        <div className="detail-label">Node size override</div>
        {hasOverride && (
          <button
            type="button"
            className="btn-ghost size-reset"
            onClick={() => onChange(undefined, undefined)}
            title="Use trick default"
          >
            Reset
          </button>
        )}
      </div>
      <div className="size-controls-fields">
        <input
          type="number"
          min={40}
          max={800}
          inputMode="numeric"
          className="text-input"
          placeholder={String(trickWidth ?? 130)}
          value={overrideWidth ?? ''}
          onChange={(e) => onChange(parseLoose(e.target.value), overrideHeight)}
          onBlur={() => onChange(clamp(overrideWidth), overrideHeight)}
          aria-label="Width"
        />
        <span className="size-controls-sep">×</span>
        <input
          type="number"
          min={40}
          max={800}
          inputMode="numeric"
          className="text-input"
          placeholder={String(trickHeight ?? 130)}
          value={overrideHeight ?? ''}
          onChange={(e) => onChange(overrideWidth, parseLoose(e.target.value))}
          onBlur={() => onChange(overrideWidth, clamp(overrideHeight))}
          aria-label="Height"
        />
      </div>
      <p className="muted size-controls-hint">
        Empty = use trick default ({defaultHint}).
      </p>
    </div>
  )
}
