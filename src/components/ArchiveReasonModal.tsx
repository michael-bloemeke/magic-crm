import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ARCHIVE_REASONS, type Project } from '../pipeline'
import { ContactTagger } from './ContactTagger'

// Asks for a reason before archiving. The reason list is editable (stored in
// crm-config.json, passed in via `reasons`); choosing "Other" reveals a
// free-text field, and "Edit list" lets Michael manage the options inline.

type Props = {
  project: Project | null
  reasons: string[]
  onReasonsChange: (reasons: string[]) => void
  onCancel: () => void
  onConfirm: (reason: string) => void
}

export function ArchiveReasonModal({ project, reasons, onReasonsChange, onCancel, onConfirm }: Props) {
  const list = reasons.length ? reasons : ARCHIVE_REASONS
  const withOther = list.includes('Other') ? list : [...list, 'Other']
  const [reason, setReason] = useState(withOther[0] ?? '')
  const [custom, setCustom] = useState('')
  const [managing, setManaging] = useState(false)
  const [draft, setDraft] = useState<string[]>([])

  useEffect(() => {
    if (project) {
      setReason(withOther[0] ?? '')
      setCustom('')
      setManaging(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const isOther = reason === 'Other'
  const finalReason = isOther ? custom.trim() : reason
  const canConfirm = !!finalReason

  const startManage = () => {
    setDraft(list.filter((r) => r !== 'Other'))
    setManaging(true)
  }
  const saveManage = () => {
    const cleaned = draft.map((r) => r.trim()).filter(Boolean)
    onReasonsChange([...cleaned, 'Other'])
    setManaging(false)
    setReason((cleaned[0] ?? 'Other'))
  }

  return (
    <AnimatePresence>
      {project && (
        <motion.div
          className="fixed inset-0 z-[60] flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={onCancel} aria-hidden />

          <motion.div
            className="board-scroll relative max-h-[88vh] w-full max-w-md overflow-y-auto rounded-2xl border border-line-strong bg-surface shadow-[0_30px_70px_-30px_rgba(0,0,0,0.18)]"
            initial={{ y: 16, opacity: 0.6, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 16, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="border-b border-line px-6 pb-4 pt-5">
              <h2 className="font-display text-[20px] leading-tight text-parchment">Archive project</h2>
              <p className="mt-1 text-[12.5px] text-muted">
                <span className="text-parchment">{project.client}</span> will move out of the active pipeline into
                Archive. Why is it being archived?
              </p>
            </div>

            {managing ? (
              <div className="space-y-2 px-6 py-5">
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">Edit reasons</p>
                {draft.map((r, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      value={r}
                      onChange={(e) => setDraft((d) => d.map((x, j) => (j === i ? e.target.value : x)))}
                      className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-[13px] text-parchment focus:border-brass focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => setDraft((d) => d.filter((_, j) => j !== i))}
                      className="shrink-0 text-faint transition-colors hover:text-[#dc2626]"
                      title="Remove"
                    >
                      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M6 6l12 12M18 6L6 18" />
                      </svg>
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setDraft((d) => [...d, ''])}
                  className="text-[12px] font-medium text-brass-dim transition-colors hover:text-brass"
                >
                  + Add reason
                </button>
                <p className="pt-1 text-[11px] text-faint">"Other" (free text) is always available.</p>
              </div>
            ) : (
              <div className="space-y-3 px-6 py-5">
                <div className="relative">
                  <select
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    className="w-full cursor-pointer appearance-none rounded-lg border border-line bg-surface-2 py-2.5 pl-3 pr-9 text-[13px] text-parchment transition-colors hover:border-brass-dim focus:border-brass focus:outline-none"
                  >
                    {withOther.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                  <svg viewBox="0 0 24 24" className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-brass-dim" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </div>

                {isOther && (
                  <input
                    type="text"
                    autoFocus
                    value={custom}
                    onChange={(e) => setCustom(e.target.value)}
                    placeholder="Enter a reason…"
                    className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-[13px] text-parchment placeholder:text-faint focus:border-brass focus:outline-none"
                  />
                )}

                <button
                  type="button"
                  onClick={startManage}
                  className="text-[11.5px] font-medium text-faint transition-colors hover:text-brass"
                >
                  Edit list
                </button>

                <div className="border-t border-line pt-4">
                  <ContactTagger project={project} />
                </div>
              </div>
            )}

            <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-line bg-surface/95 px-6 py-4 backdrop-blur">
              {managing ? (
                <>
                  <button
                    type="button"
                    onClick={() => setManaging(false)}
                    className="rounded-lg border border-line px-4 py-2 text-[12.5px] font-medium text-muted transition-colors hover:border-line-strong hover:text-parchment"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={saveManage}
                    className="rounded-lg border border-brass-dim/60 bg-surface-3 px-4 py-2 text-[12.5px] font-semibold text-brass-bright transition-all hover:border-brass"
                  >
                    Save list
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={onCancel}
                    className="rounded-lg border border-line px-4 py-2 text-[12.5px] font-medium text-muted transition-colors hover:border-line-strong hover:text-parchment"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={!canConfirm}
                    onClick={() => canConfirm && onConfirm(finalReason)}
                    className="rounded-lg border border-brass-dim/60 bg-gradient-to-b from-surface-3 to-surface px-4 py-2 text-[12.5px] font-semibold text-brass-bright transition-all hover:border-brass disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Archive project
                  </button>
                </>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
