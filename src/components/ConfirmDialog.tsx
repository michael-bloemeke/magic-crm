import { useEffect } from 'react'
import { AnimatePresence, motion } from 'motion/react'

// Generic confirm dialog for destructive, no-undo actions (e.g. deleting a
// project). Centered modal; Esc or backdrop cancels.

type Props = {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
}: Props) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onCancel])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[60] flex items-center justify-center p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={onCancel} aria-hidden />
          <motion.div
            role="alertdialog"
            aria-modal="true"
            className="relative w-full max-w-[400px] rounded-2xl border border-line-strong bg-surface p-6 shadow-[0_40px_80px_-30px_rgba(0,0,0,0.18)]"
            initial={{ scale: 0.96, y: 8, opacity: 0.6 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={{ scale: 0.97, y: 6, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          >
            <h2 className="font-display text-[20px] leading-tight text-parchment">{title}</h2>
            <p className="mt-2 text-[13px] leading-relaxed text-muted">{message}</p>
            <div className="mt-6 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onCancel}
                className="rounded-lg border border-line px-3.5 py-2 text-[12.5px] font-semibold text-muted transition-colors hover:border-line-strong hover:text-parchment"
              >
                {cancelLabel}
              </button>
              <button
                type="button"
                onClick={onConfirm}
                className="rounded-lg border px-3.5 py-2 text-[12.5px] font-semibold transition-colors"
                style={{
                  borderColor: 'color-mix(in oklab, #dc2626 55%, transparent)',
                  color: '#ef4444',
                  backgroundColor: 'color-mix(in oklab, #dc2626 14%, transparent)',
                }}
              >
                {confirmLabel}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
