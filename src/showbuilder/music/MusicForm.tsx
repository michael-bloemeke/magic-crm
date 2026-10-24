import { useEffect, useState } from 'react'
import type { Music } from '../types'
import { AudioFilePicker } from './AudioFilePicker'

type Props = {
  initial: Music
  onSave: (m: Music) => void | Promise<void>
  onCancel: () => void
  saveLabel?: string
  autoFocusName?: boolean
}

export function MusicForm({ initial, onSave, onCancel, saveLabel = 'Save', autoFocusName = false }: Props) {
  const [draft, setDraft] = useState<Music>(initial)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setDraft(initial)
  }, [initial])

  const update = (patch: Partial<Music>) => setDraft((d) => ({ ...d, ...patch }))

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
          placeholder="Opening Theme"
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
          placeholder="When this plays, what it sets up, etc."
        />
      </label>

      <div className="field-row">
        <label className="field">
          <span className="field-label">Start cue</span>
          <input
            className="text-input"
            value={draft.startCue ?? ''}
            onChange={(e) => update({ startCue: e.target.value })}
            placeholder="When to hit play"
          />
        </label>
        <label className="field">
          <span className="field-label">Stop cue</span>
          <input
            className="text-input"
            value={draft.stopCue ?? ''}
            onChange={(e) => update({ stopCue: e.target.value })}
            placeholder="When to stop it"
          />
        </label>
      </div>

      <div className="field">
        <span className="field-label">File</span>
        <AudioFilePicker
          value={draft.audioFileId}
          onChange={(id) => update({ audioFileId: id })}
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
