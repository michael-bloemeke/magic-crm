import { useRef, useState } from 'react'
import { loadFiles, uploadEmailAttachment, deleteEmailAttachment, type EmailAttachment, type FileItem } from '../api'
import { attachKey, fmtSize } from '../attachments'

// The Attach control shared by BOTH email boxes: the full composer (EmailBuilderModal) and the
// thread reply (ThreadReader). Extracted so the two can never drift — a fix to upload handling or
// orphan cleanup lands in one place. `tone` matches RichTextEditor's: 'light' for the white paper
// surface of the thread reader, 'dark' for the app-surface composer.
//
// Attachments are stored as REFERENCES ({source, name, id}), never as bytes in the browser: a
// 'files' item is read from the Files page at send time, an 'upload' item from the one-off
// attachment store. The server resolves them when the mail actually goes out.

export function EmailAttachments({
  attachments,
  onChange,
  tone = 'dark',
  label = true,
  onStatus,
  // Ids of uploads made during this editing session, so a cancelled compose can delete them rather
  // than orphaning files on disk. The caller owns the set; this component only records into it.
  sessionUploads,
}: {
  attachments: EmailAttachment[]
  onChange: (next: EmailAttachment[]) => void
  tone?: 'dark' | 'light'
  /** Show the "Attachments" caption above the row. The reply box is tighter and hides it. */
  label?: boolean
  onStatus?: (msg: string | null) => void
  sessionUploads?: React.RefObject<Set<string>>
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [files, setFiles] = useState<FileItem[] | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const light = tone === 'light'

  const openPicker = async () => {
    setMenuOpen(true)
    if (files == null) {
      try {
        setFiles(await loadFiles())
      } catch {
        setFiles([])
      }
    }
  }
  const addFromFiles = (f: FileItem) => {
    setMenuOpen(false)
    if (attachments.some((a) => a.source === 'files' && a.name === f.name)) return
    onChange([...attachments, { source: 'files', name: f.name, size: f.size }])
  }
  const onUploadChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files || [])
    e.target.value = '' // allow re-selecting the same file later
    setMenuOpen(false)
    let next = attachments
    for (const file of list) {
      onStatus?.(`Uploading ${file.name}…`)
      try {
        const att = await uploadEmailAttachment(file)
        if (att.id) sessionUploads?.current?.add(att.id)
        next = [...next, att]
        onChange(next)
        onStatus?.(null)
      } catch (err) {
        onStatus?.(String(err instanceof Error ? err.message : err))
      }
    }
  }
  const remove = (a: EmailAttachment) => {
    onChange(attachments.filter((x) => attachKey(x) !== attachKey(a)))
    if (a.source === 'upload' && a.id) {
      sessionUploads?.current?.delete(a.id)
      deleteEmailAttachment(a.id).catch(() => {})
    }
  }

  const chipCls = light
    ? 'inline-flex items-center gap-1.5 rounded-lg border border-[#d8dde3] bg-[#f5f7f9] py-1 pl-2.5 pr-1.5 text-[11.5px] text-[#14171b]'
    : 'inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface-2 py-1 pl-2.5 pr-1.5 text-[11.5px] text-parchment'
  const faintCls = light ? 'text-[#858d97]' : 'text-faint'
  const btnCls = light
    ? 'inline-flex items-center gap-1.5 rounded-lg border border-[#d8dde3] bg-white px-2.5 py-1 text-[11.5px] font-medium text-[#545b64] transition-colors hover:border-[#2563eb] hover:text-[#14171b]'
    : 'inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-[12px] font-medium text-muted transition-colors hover:border-brass-dim hover:text-parchment'
  const menuCls = light
    ? 'absolute left-0 z-20 w-72 overflow-hidden rounded-lg border border-[#d8dde3] bg-white shadow-[0_20px_50px_-20px_rgba(0,0,0,0.25)]'
    : 'absolute left-0 z-20 w-72 overflow-hidden rounded-lg border border-line-strong bg-surface-2 shadow-[0_20px_50px_-20px_rgba(0,0,0,0.18)]'
  const itemCls = light
    ? 'flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-[#14171b] hover:bg-[#f5f7f9]'
    : 'flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-parchment hover:bg-surface-3'
  // The reply box sits at the very bottom of a scrolling page, so its menu opens UPWARD; the modal's
  // has room below.
  const menuPos = light ? 'bottom-[calc(100%+4px)]' : 'top-[calc(100%+4px)]'

  return (
    <div className="block">
      {label && (
        <span className={`mb-1.5 block text-[10px] font-semibold uppercase tracking-[0.14em] ${faintCls}`}>
          Attachments
        </span>
      )}
      {attachments.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-1.5">
          {attachments.map((a) => (
            <li key={attachKey(a)} className={chipCls}>
              <svg viewBox="0 0 24 24" className={`h-3.5 w-3.5 shrink-0 ${faintCls}`} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21.4 11.05 12.25 20.2a5 5 0 0 1-7.07-7.07l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
              <span className="max-w-[14rem] truncate">{a.name}</span>
              {a.size ? <span className={faintCls}>{fmtSize(a.size)}</span> : null}
              {a.source === 'upload' && <span className={`text-[9px] uppercase tracking-wide ${faintCls}`}>uploaded</span>}
              <button
                type="button"
                onClick={() => remove(a)}
                aria-label={`Remove ${a.name}`}
                className={`rounded p-0.5 transition-colors hover:text-[#dc2626] ${faintCls}`}
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="relative inline-block">
        <button type="button" onClick={() => (menuOpen ? setMenuOpen(false) : openPicker())} className={btnCls}>
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21.4 11.05 12.25 20.2a5 5 0 0 1-7.07-7.07l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
          Attach
        </button>
        {menuOpen && (
          <div className={`${menuCls} ${menuPos}`}>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className={`${itemCls} border-b ${light ? 'border-[#eaedf1]' : 'border-line'}`}
            >
              <svg viewBox="0 0 24 24" className={`h-4 w-4 ${faintCls}`} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 16V4M7 9l5-5 5 5M5 20h14" />
              </svg>
              Upload from this computer…
            </button>
            <div className={`px-3 pb-1 pt-2 text-[9.5px] font-semibold uppercase tracking-[0.14em] ${faintCls}`}>From your Files</div>
            <div className="board-scroll max-h-56 overflow-y-auto pb-1">
              {files == null ? (
                <p className={`px-3 py-2 text-[11.5px] ${faintCls}`}>Loading…</p>
              ) : files.length === 0 ? (
                <p className={`px-3 py-2 text-[11.5px] ${faintCls}`}>No files yet. Add some on the Files page.</p>
              ) : (
                files.map((f) => (
                  <button
                    key={f.name}
                    type="button"
                    onClick={() => addFromFiles(f)}
                    className={`${itemCls} justify-between`}
                  >
                    <span className="min-w-0 truncate">{f.name}</span>
                    <span className={`shrink-0 text-[10.5px] ${faintCls}`}>{fmtSize(f.size)}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}
        <input ref={fileInputRef} type="file" multiple className="hidden" onChange={onUploadChosen} />
      </div>
    </div>
  )
}
