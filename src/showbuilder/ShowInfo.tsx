import { useEffect, useMemo } from 'react'
import type { Node, Edge } from 'reactflow'
import { useTricks } from './tricks/TricksContext'
import { useOthers } from './others/OthersContext'
import { StringListEditor } from './tricks/StringListEditor'
import { getShowOrder, parseDurationMinutes, formatDuration } from './showUtils'

type Props = {
  open: boolean
  onClose: () => void
  showName: string
  showProps: string[]
  onShowPropsChange: (props: string[]) => void
  nodes: Node[]
  edges: Edge[]
}

function normalize(name: string): string {
  return name.trim().toLowerCase()
}

export function ShowInfo({
  open,
  onClose,
  showName,
  showProps,
  onShowPropsChange,
  nodes,
  edges
}: Props) {
  const { tricksById } = useTricks()
  const { othersById } = useOthers()

  // Skip the background page node entirely.
  const realNodes = useMemo(
    () => nodes.filter((n) => n.type !== 'page' && n.id !== '__page__'),
    [nodes]
  )

  const orderedNodes = useMemo(
    () => getShowOrder(realNodes, edges),
    [realNodes, edges]
  )

  // Show flow excludes music nodes (per current product choice).
  const flowNodes = useMemo(
    () => orderedNodes.filter((n) => n.type !== 'music'),
    [orderedNodes]
  )

  const totalMinutes = useMemo(() => {
    return flowNodes.reduce((sum, n) => {
      if (n.type === 'other') {
        const otherId = (n.data as { otherId?: string | null } | undefined)?.otherId
        if (!otherId) return sum
        const other = othersById.get(otherId)
        return sum + parseDurationMinutes(other?.duration)
      }
      // trick
      const trickId = (n.data as { trickId?: string | null } | undefined)?.trickId
      if (!trickId) return sum
      const trick = tricksById.get(trickId)
      return sum + parseDurationMinutes(trick?.duration)
    }, 0)
  }, [flowNodes, tricksById, othersById])

  const unassignedCount = useMemo(
    () =>
      flowNodes.filter((n) => {
        if (n.type === 'other') {
          const id = (n.data as { otherId?: string | null } | undefined)?.otherId
          return !id || !othersById.has(id)
        }
        const id = (n.data as { trickId?: string | null } | undefined)?.trickId
        return !id || !tricksById.has(id)
      }).length,
    [flowNodes, tricksById, othersById]
  )

  // Reusable-prop deduping. Considers both trick and other props together,
  // since a single deck of cards might serve a card trick AND a card-joke
  // "other" item.
  const { reusableSection, hoistedKeys } = useMemo(() => {
    const groups = new Map<string, { displayName: string; count: number }>()
    const consume = (propsList?: { name: string; reusable?: boolean }[]) => {
      if (!propsList) return
      for (const p of propsList) {
        if (!p.reusable) continue
        const key = normalize(p.name)
        if (!key) continue
        const existing = groups.get(key)
        if (existing) existing.count += 1
        else groups.set(key, { displayName: p.name, count: 1 })
      }
    }
    for (const node of flowNodes) {
      if (node.type === 'editable') {
        const trickId = (node.data as { trickId?: string | null } | undefined)?.trickId
        if (!trickId) continue
        consume(tricksById.get(trickId)?.props)
      } else if (node.type === 'other') {
        const otherId = (node.data as { otherId?: string | null } | undefined)?.otherId
        if (!otherId) continue
        consume(othersById.get(otherId)?.props)
      }
    }
    const section = [...groups.entries()]
      .filter(([, g]) => g.count >= 2)
      .map(([, g]) => g.displayName)
      .sort((a, b) => a.localeCompare(b))
    const hoisted = new Set<string>(
      [...groups.entries()]
        .filter(([, g]) => g.count >= 2)
        .map(([key]) => key)
    )
    return { reusableSection: section, hoistedKeys: hoisted }
  }, [flowNodes, tricksById, othersById])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-show-info" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Show Info{showName ? `: ${showName}` : ''}</h2>
          <button
            className="btn-ghost sidebar-close"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="modal-body">
          <section className="info-section">
            <div className="info-stat-row">
              <div className="info-stat">
                <div className="info-stat-label">Total runtime</div>
                <div className="info-stat-value">{formatDuration(totalMinutes)}</div>
              </div>
              <div className="info-stat">
                <div className="info-stat-label">Items</div>
                <div className="info-stat-value">{flowNodes.length}</div>
              </div>
            </div>
            {unassignedCount > 0 && (
              <p className="muted info-warning">
                {unassignedCount} node{unassignedCount === 1 ? '' : 's'} with nothing assigned. Runtime and props are skipped for those.
              </p>
            )}
          </section>

          <section className="info-section">
            <h3 className="info-section-title">Show essentials</h3>
            <p className="muted info-section-hint">
              Things you need for the whole show that aren't part of a specific trick. Tables, totebox, mic, batteries, etc.
            </p>
            <StringListEditor
              items={showProps}
              onChange={onShowPropsChange}
              placeholder="Add an essential and press Enter"
            />
          </section>

          {reusableSection.length > 0 && (
            <section className="info-section">
              <h3 className="info-section-title">Reusable across the show</h3>
              <p className="muted info-section-hint">
                Props flagged reusable that appear in multiple tricks. Pack one of each.
              </p>
              <ul className="info-reusable-list">
                {reusableSection.map((name) => (
                  <li key={name}>{name}</li>
                ))}
              </ul>
            </section>
          )}

          <section className="info-section">
            <h3 className="info-section-title">Show flow</h3>
            <p className="muted info-section-hint">
              In show order (following the arrow connections). Tricks list their unique props; other items show their description.
            </p>

            {flowNodes.length === 0 ? (
              <p className="muted">No nodes in this show yet.</p>
            ) : (
              <div className="info-tricks">
                {flowNodes.map((node, i) => {
                  if (node.type === 'other') {
                    const otherId = (node.data as { otherId?: string | null } | undefined)?.otherId
                    const other = otherId ? othersById.get(otherId) : null
                    const name = other?.name ?? '(unassigned)'
                    const allProps = other?.props ?? []
                    const visibleProps = allProps.filter((p) => {
                      if (!p.reusable) return true
                      return !hoistedKeys.has(normalize(p.name))
                    })
                    return (
                      <div key={node.id} className="info-trick">
                        <div className="info-trick-header">
                          <span className="info-trick-num">{i + 1}.</span>
                          {other?.color && (
                            <span
                              className="info-trick-swatch"
                              style={{ background: other.color }}
                              aria-hidden
                            />
                          )}
                          <span className={`info-trick-name ${other ? '' : 'muted'}`}>
                            {name}
                          </span>
                          {other?.duration && (
                            <span className="info-trick-duration muted">
                              {other.duration}
                            </span>
                          )}
                        </div>
                        {other?.description ? (
                          <p className="info-trick-other-desc">{other.description}</p>
                        ) : null}
                        {visibleProps.length > 0 && (
                          <ul className="info-trick-props">
                            {visibleProps.map((p, j) => (
                              <li key={j}>{p.name}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )
                  }
                  // trick
                  const trickId = (node.data as { trickId?: string | null } | undefined)?.trickId
                  const trick = trickId ? tricksById.get(trickId) : null
                  const name = trick?.name ?? '(unassigned)'
                  const allProps = trick?.props ?? []
                  const visibleProps = allProps.filter((p) => {
                    if (!p.reusable) return true
                    return !hoistedKeys.has(normalize(p.name))
                  })
                  return (
                    <div key={node.id} className="info-trick">
                      <div className="info-trick-header">
                        <span className="info-trick-num">{i + 1}.</span>
                        <span className={`info-trick-name ${trick ? '' : 'muted'}`}>
                          {name}
                        </span>
                        {trick?.duration && (
                          <span className="info-trick-duration muted">
                            {trick.duration}
                          </span>
                        )}
                      </div>
                      {visibleProps.length === 0 ? (
                        <p className="muted info-trick-noprops">
                          {trick ? '(no unique props)' : ''}
                        </p>
                      ) : (
                        <ul className="info-trick-props">
                          {visibleProps.map((p, j) => (
                            <li key={j}>{p.name}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
