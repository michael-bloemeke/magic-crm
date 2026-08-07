import { useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { deleteFile as apiDelete, fileRawUrl, loadFiles, uploadFile, type FileItem } from '../api'

// A shelf for business documents Michael sends clients: slide decks, one-sheets,
// contracts, photos. Upload, open/download, and remove. Files are stored locally
// by the app (see crm-files.mjs).

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function extLabel(name: string): string {
  const m = name.match(/\.([a-z0-9]+)$/i)
  return m ? m[1].toUpperCase() : 'FILE'
}

export function FilesPage() {
  const [files, setFiles] = useState<FileItem[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    loadFiles()
      .then((f) => setFiles(f))
      .catch(() => setFiles([]))
  }, [])

  const upload = async (list: FileList | null) => {
    if (!list || list.length === 0) return
    setBusy(true)
    setError(null)
    try {
      for (const file of Array.from(list)) {
        const saved = await uploadFile(file)
        setFiles((prev) => [saved, ...(prev ?? []).filter((f) => f.name !== saved.name)])
      }
    } catch (e) {
      setError(String((e as Error)?.message || e))
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  const remove = (name: string) => {
    setFiles((prev) => (prev ?? []).filter((f) => f.name !== name))
    apiDelete(name).catch(() => {
      setError('Could not delete that file.')
      loadFiles().then(setFiles).catch(() => {}) // restore the real list
    })
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.35 }}
      className="board-scroll h-full overflow-y-auto px-8 pb-12"
    >
      {/* Drop zone / upload */}
      <div
        onDragOver={(e) => {
          e.preventDefault()
          if (!dragging) setDragging(true)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false)
        }}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          upload(e.dataTransfer.files)
        }}
        className={[
          'mb-6 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors',
          dragging ? 'border-brass bg-surface-2/60' : 'border-line bg-surface/40',
        ].join(' ')}
      >
        <svg viewBox="0 0 24 24" className="h-7 w-7 text-brass-dim" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 16V4M12 4l-4 4M12 4l4 4" />
          <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
        </svg>
        <p className="text-[13.5px] text-muted">
          Drag files here, or{' '}
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="font-semibold text-brass-bright underline-offset-2 hover:underline"
          >
            browse
          </button>
        </p>
        <p className="text-[11.5px] text-faint">{busy ? 'Uploading…' : 'Slide decks, PDFs, images, contracts'}</p>
        <input ref={inputRef} type="file" multiple className="hidden" onChange={(e) => upload(e.target.files)} />
      </div>

      {error && <p className="mb-4 text-[12.5px] text-[#dc2626]">{error}</p>}

      {!files ? (
        <p className="animate-pulse text-[13px] text-faint">Loading files…</p>
      ) : files.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-4 py-12 text-center text-[13px] text-faint">
          No files yet. Upload your first document above.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {files.map((f) => (
            <div
              key={f.name}
              className="group flex items-center gap-3 rounded-xl border border-line bg-surface-2/60 p-3 transition-colors hover:border-line-strong hover:bg-surface-3/70"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-line-strong bg-surface-3 text-[9px] font-bold tracking-wide text-brass">
                {extLabel(f.name)}
              </span>
              <div className="min-w-0 flex-1">
                <a
                  href={fileRawUrl(f.name)}
                  target="_blank"
                  rel="noreferrer"
                  className="block truncate text-[13px] font-medium text-parchment hover:text-brass-bright"
                  title={f.name}
                >
                  {f.name}
                </a>
                <p className="mt-0.5 text-[11px] text-faint">
                  {formatSize(f.size)} · {formatDate(f.modified)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                <a
                  href={fileRawUrl(f.name)}
                  target="_blank"
                  rel="noreferrer"
                  title="Open"
                  className="rounded-md border border-line p-1.5 text-muted transition-colors hover:border-line-strong hover:text-brass"
                >
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 4h6v6M20 4l-8 8M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
                  </svg>
                </a>
                <button
                  type="button"
                  onClick={() => remove(f.name)}
                  title="Delete"
                  className="rounded-md border border-line p-1.5 text-muted transition-colors hover:border-[#dc2626]/60 hover:text-[#dc2626]"
                >
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </motion.div>
  )
}
