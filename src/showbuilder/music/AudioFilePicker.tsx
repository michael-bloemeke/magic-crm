import { useState } from 'react'
import { useMusic } from './MusicContext'

type Props = {
  value: string | null | undefined
  onChange: (audioFileId: string | null) => void
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function AudioFilePicker({ value, onChange }: Props) {
  const { audioFiles, audioFilesById, uploadAudio } = useMusic()
  const [uploading, setUploading] = useState(false)

  const selected = value ? audioFilesById.get(value) ?? null : null

  const handleUpload = async () => {
    setUploading(true)
    try {
      const result = await uploadAudio()
      if (result) {
        onChange(result.id)
      }
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="audio-picker">
      <div className="audio-picker-row">
        <select
          className="text-input audio-picker-select"
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value || null)}
        >
          <option value="">— No file —</option>
          {audioFiles.map((a) => (
            <option key={a.id} value={a.id}>
              {a.displayName}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn-secondary"
          onClick={handleUpload}
          disabled={uploading}
        >
          {uploading ? 'Uploading...' : 'Upload'}
        </button>
      </div>
      {selected && (
        <div className="audio-picker-info muted">
          {selected.originalFilename}
          {' · '}
          {formatSize(selected.size)}
        </div>
      )}
      {!selected && value && (
        <div className="audio-picker-info audio-picker-warning">
          File no longer available.
        </div>
      )}
    </div>
  )
}
