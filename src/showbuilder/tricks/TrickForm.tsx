import { useEffect, useState } from 'react'
import type { Trick } from '../types'
import { TagPicker } from './TagPicker'
import { PropsListEditor } from './PropsListEditor'
import { DurationInput } from './DurationInput'

type Props = {
  initial: Trick
  onSave: (trick: Trick) => void | Promise<void>
  onCancel: () => void
  saveLabel?: string
  autoFocusName?: boolean
}

export function TrickForm({ initial, onSave, onCancel, saveLabel = 'Save', autoFocusName = false }: Props) {
  const [draft, setDraft] = useState<Trick>(initial)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setDraft(initial)
  }, [initial])

  const update = (patch: Partial<Trick>) => setDraft((d) => ({ ...d, ...patch }))

  const submit = async () => {
    if (!draft.name.trim()) return
    setSaving(true)
    try {
      await onSave({ ...draft, name: draft.name.trim() })
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      className="trick-form"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <div className="field">
        <span className="field-label">Tags</span>
        <TagPicker
          selectedTagIds={draft.tagIds ?? []}
          onChange={(tagIds) => update({ tagIds })}
        />
      </div>

      <label className="field">
        <span className="field-label">Name</span>
        <input
          className="text-input"
          value={draft.name}
          onChange={(e) => update({ name: e.target.value })}
          placeholder="Cups and Balls"
          autoFocus={autoFocusName}
          required
        />
      </label>

      <label className="field">
        <span className="field-label">Description</span>
        <textarea
          className="text-input"
          rows={2}
          value={draft.description ?? ''}
          onChange={(e) => update({ description: e.target.value })}
          placeholder="Short summary."
        />
      </label>

      <div className="field-row">
        <label className="field">
          <span className="field-label">Source</span>
          <input
            className="text-input"
            value={draft.source ?? ''}
            onChange={(e) => update({ source: e.target.value })}
            placeholder="Book, video, person..."
          />
        </label>
        <div className="field">
          <span className="field-label">Duration</span>
          <DurationInput
            value={draft.duration}
            onChange={(duration) => update({ duration })}
          />
        </div>
      </div>

      <div className="field-row">
        <label className="field">
          <span className="field-label">Node width</span>
          <input
            type="number"
            min={40}
            max={800}
            inputMode="numeric"
            className="text-input"
            placeholder="130"
            value={draft.preferredWidth ?? ''}
            onChange={(e) => {
              const v = e.target.value
              if (v === '') {
                update({ preferredWidth: undefined })
                return
              }
              const n = parseInt(v)
              if (Number.isFinite(n)) update({ preferredWidth: n })
            }}
            onBlur={(e) => {
              const v = e.target.value
              if (v === '') return
              const n = parseInt(v) || 0
              update({ preferredWidth: Math.max(40, Math.min(800, n)) })
            }}
          />
        </label>
        <label className="field">
          <span className="field-label">Node height</span>
          <input
            type="number"
            min={40}
            max={800}
            inputMode="numeric"
            className="text-input"
            placeholder="130"
            value={draft.preferredHeight ?? ''}
            onChange={(e) => {
              const v = e.target.value
              if (v === '') {
                update({ preferredHeight: undefined })
                return
              }
              const n = parseInt(v)
              if (Number.isFinite(n)) update({ preferredHeight: n })
            }}
            onBlur={(e) => {
              const v = e.target.value
              if (v === '') return
              const n = parseInt(v) || 0
              update({ preferredHeight: Math.max(40, Math.min(800, n)) })
            }}
          />
        </label>
      </div>

      <div className="field">
        <span className="field-label">Props</span>
        <PropsListEditor
          items={draft.props ?? []}
          onChange={(props) => update({ props })}
        />
      </div>

      <label className="field">
        <span className="field-label">Script</span>
        <textarea
          className="text-input"
          rows={6}
          value={draft.script ?? ''}
          onChange={(e) => update({ script: e.target.value })}
          placeholder="Patter and lines."
        />
      </label>

      <label className="field">
        <span className="field-label">Notes</span>
        <textarea
          className="text-input"
          rows={3}
          value={draft.notes ?? ''}
          onChange={(e) => update({ notes: e.target.value })}
          placeholder="Anything else."
        />
      </label>

      <div className="form-actions">
        <button type="button" className="btn-secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="submit" className="btn-primary" disabled={saving || !draft.name.trim()}>
          {saving ? 'Saving...' : saveLabel}
        </button>
      </div>
    </form>
  )
}
