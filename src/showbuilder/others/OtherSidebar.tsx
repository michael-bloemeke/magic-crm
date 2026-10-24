import { useEffect, useMemo, useState } from 'react'
import type { Other } from '../types'
import { useOthers, blankOther } from './OthersContext'
import { OtherForm } from './OtherForm'

type Mode =
  | { kind: 'picker' }
  | { kind: 'details' }
  | { kind: 'edit'; other: Other }

type Props = {
  open: boolean
  assignedOtherId: string | null
  onClose: () => void
  onAssign: (otherId: string) => void
  nodeOverrideWidth?: number
  nodeOverrideHeight?: number
  onSetNodeSize?: (width: number | undefined, height: number | undefined) => void
}

export function OtherSidebar({
  open,
  assignedOtherId,
  onClose,
  onAssign,
  nodeOverrideWidth,
  nodeOverrideHeight,
  onSetNodeSize
}: Props) {
  const { others, othersById, saveOther } = useOthers()
  const [mode, setMode] = useState<Mode>({ kind: 'picker' })
  const [search, setSearch] = useState('')

  useEffect(() => {
    if (!open) return
    if (assignedOtherId && othersById.has(assignedOtherId)) {
      setMode({ kind: 'details' })
    } else {
      setMode({ kind: 'picker' })
    }
    setSearch('')
  }, [open, assignedOtherId, othersById])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return others
    return others.filter((o) => o.name.toLowerCase().includes(q))
  }, [others, search])

  const assigned = assignedOtherId ? othersById.get(assignedOtherId) ?? null : null

  return (
    <aside className={`sidebar ${open ? 'sidebar-open' : ''}`} aria-hidden={!open}>
      <div className="sidebar-header">
        <h2 className="sidebar-title">
          {mode.kind === 'picker' && 'Assign an item'}
          {mode.kind === 'details' && (assigned?.name ?? 'Item')}
          {mode.kind === 'edit' && (mode.other.name ? `Edit: ${mode.other.name}` : 'New item')}
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
              onClick={() => setMode({ kind: 'edit', other: blankOther() })}
            >
              <span className="picker-add-plus">+</span>
              <span>Add new item</span>
            </button>

            <input
              className="text-input picker-search"
              placeholder="Search items..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />

            {filtered.length === 0 ? (
              <p className="muted picker-empty">
                {others.length === 0
                  ? 'No items in your library yet.'
                  : 'No items match.'}
              </p>
            ) : (
              <ul className="picker-list">
                {filtered.map((o) => (
                  <li key={o.id}>
                    <button className="picker-item" onClick={() => onAssign(o.id)}>
                      <span className="picker-item-name other-picker-name">
                        {o.color && (
                          <span
                            className="other-picker-swatch"
                            style={{ background: o.color }}
                            aria-hidden
                          />
                        )}
                        {o.name}
                      </span>
                      {o.duration && (
                        <span className="picker-item-desc">{o.duration}</span>
                      )}
                      {o.description && (
                        <span className="picker-item-desc">{o.description}</span>
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
            {assigned.color && (
              <div className="detail-field detail-field-inline">
                <div className="detail-label">Color</div>
                <div className="detail-value other-detail-color">
                  <span
                    className="other-color-swatch"
                    style={{ background: assigned.color }}
                    aria-hidden
                  />
                  <span className="muted">{assigned.color}</span>
                </div>
              </div>
            )}
            <DetailField label="Duration" value={assigned.duration} inline />
            <DetailField label="Description" value={assigned.description} preformatted />
            <DetailPropsField label="Props" items={assigned.props} />

            <NodeSizeOverride
              defaultWidth={assigned.preferredWidth}
              defaultHeight={assigned.preferredHeight}
              overrideWidth={nodeOverrideWidth}
              overrideHeight={nodeOverrideHeight}
              onChange={onSetNodeSize}
            />

            <div className="details-actions">
              <button
                className="btn-secondary"
                onClick={() => setMode({ kind: 'edit', other: assigned })}
              >
                Edit Item
              </button>
              <button
                className="btn-primary"
                onClick={() => setMode({ kind: 'picker' })}
              >
                Change Item
              </button>
            </div>
          </div>
        )}

        {mode.kind === 'details' && !assigned && (
          <p className="muted">This node's assigned item was removed. Pick another.</p>
        )}

        {mode.kind === 'edit' && (
          <OtherForm
            initial={mode.other}
            autoFocusName={!mode.other.name}
            saveLabel="Save & Assign"
            onSave={async (o) => {
              const saved = await saveOther(o)
              onAssign(saved.id)
            }}
            onCancel={() => {
              if (assignedOtherId && othersById.has(assignedOtherId)) {
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
  defaultWidth,
  defaultHeight,
  overrideWidth,
  overrideHeight,
  onChange
}: {
  defaultWidth?: number
  defaultHeight?: number
  overrideWidth?: number
  overrideHeight?: number
  onChange?: (width: number | undefined, height: number | undefined) => void
}) {
  if (!onChange) return null

  const hasOverride = overrideWidth !== undefined || overrideHeight !== undefined
  const defaultHint = `${defaultWidth ?? 130} × ${defaultHeight ?? 130}`

  const parseLoose = (raw: string): number | undefined => {
    if (raw === '') return undefined
    const n = parseInt(raw)
    if (!Number.isFinite(n)) return undefined
    return n
  }
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
            title="Use item default"
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
          placeholder={String(defaultWidth ?? 130)}
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
          placeholder={String(defaultHeight ?? 130)}
          value={overrideHeight ?? ''}
          onChange={(e) => onChange(overrideWidth, parseLoose(e.target.value))}
          onBlur={() => onChange(overrideWidth, clamp(overrideHeight))}
          aria-label="Height"
        />
      </div>
      <p className="muted size-controls-hint">
        Empty = use item default ({defaultHint}).
      </p>
    </div>
  )
}
