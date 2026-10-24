import { useEffect, useState } from 'react'
import type { Other } from '../types'
import { DurationInput } from '../tricks/DurationInput'
import { PropsListEditor } from '../tricks/PropsListEditor'

type Props = {
  initial: Other
  onSave: (o: Other) => void | Promise<void>
  onCancel: () => void
  saveLabel?: string
  autoFocusName?: boolean
}

const DEFAULT_COLOR = '#7a8aa0'

export function OtherForm({
  initial,
  onSave,
  onCancel,
  saveLabel = 'Save',
  autoFocusName = false
}: Props) {
  const [draft, setDraft] = useState<Other>(initial)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setDraft(initial)
  }, [initial])

  const update = (patch: Partial<Other>) => setDraft((d) => ({ ...d, ...patch }))

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
      <label className="field">
        <span className="field-label">Name</span>
        <input
          className="text-input"
          value={draft.name}
          onChange={(e) => update({ name: e.target.value })}
          placeholder="Opening story, video reel..."
          autoFocus={autoFocusName}
          required
        />
      </label>

      <label className="field">
        <span className="field-label">Description</span>
        <textarea
          className="text-input"
          rows={5}
          value={draft.description ?? ''}
          onChange={(e) => update({ description: e.target.value })}
          placeholder="What happens here?"
        />
      </label>

      <div className="field-row">
        <div className="field">
          <span className="field-label">Duration</span>
          <DurationInput
            value={draft.duration}
            onChange={(duration) => update({ duration })}
          />
        </div>
        <label className="field">
          <span className="field-label">Color</span>
          <div className="other-color-row">
            <input
              type="color"
              className="color-input"
              value={draft.color ?? DEFAULT_COLOR}
              onChange={(e) => update({ color: e.target.value })}
              aria-label="Node color"
            />
            <span className="muted other-color-hex">{draft.color ?? DEFAULT_COLOR}</span>
          </div>
        </label>
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
