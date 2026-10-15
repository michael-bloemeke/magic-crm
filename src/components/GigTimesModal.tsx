import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { type Project } from '../pipeline'
import { to12h } from '../format'

// Moving a project into a Booked stage needs the two PRIVATE door-to-door times first (Michael,
// 2026-10-15): when he leaves home and when he expects to be back. They become the busy block on his
// calendar, which is what stops a client booking a call over a gig he is driving to. Same shape as the
// payment gate (DepositPaidModal), and it runs BEFORE it: times first, then the payment if one is
// still missing.

type Props = {
  project: Project | null
  onCancel: () => void
  onConfirm: (leaveHomeTime: string, backHomeTime: string) => void
}

export function GigTimesModal({ project, onCancel, onConfirm }: Props) {
  const [leave, setLeave] = useState('')
  const [back, setBack] = useState('')

  useEffect(() => {
    setLeave(project?.leaveHomeTime || '')
    setBack(project?.backHomeTime || '')
  }, [project])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const ready = !!leave.trim() && !!back.trim()
  const input =
    'w-full rounded-lg border border-line bg-surface-2/40 px-3 py-2 text-[14px] text-parchment placeholder:text-faint/60 focus:border-line-strong focus:outline-none'

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
              <h2 className="font-display text-[20px] leading-tight text-parchment">When are you out the door?</h2>
              <p className="mt-1 text-[12.5px] text-muted">
                <span className="text-parchment">{project.client}</span> goes on your calendar as a busy block from
                when you leave home to when you're back, so nobody can book a call over the gig. Include the drive,
                setup and a traffic buffer. Only you see these.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3 px-6 py-5">
              <label className="block">
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.16em] text-faint">Leave home</span>
                <input
                  className={input}
                  value={leave}
                  placeholder="e.g. 3:45 PM"
                  onChange={(e) => setLeave(e.target.value)}
                  onBlur={() => setLeave((v) => to12h(v.trim()))}
                  autoFocus
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.16em] text-faint">Back home</span>
                <input
                  className={input}
                  value={back}
                  placeholder="e.g. 7:00 PM"
                  onChange={(e) => setBack(e.target.value)}
                  onBlur={() => setBack((v) => to12h(v.trim()))}
                />
              </label>
            </div>

            <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-line bg-surface/95 px-6 py-4 backdrop-blur">
              <button
                type="button"
                onClick={onCancel}
                className="rounded-lg border border-line px-4 py-2 text-[12.5px] font-medium text-muted transition-colors hover:border-line-strong hover:text-parchment"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!ready}
                onClick={() => onConfirm(to12h(leave.trim()), to12h(back.trim()))}
                className="rounded-lg border border-brass/70 bg-brass/10 px-4 py-2 text-[12.5px] font-semibold text-brass-bright transition-colors hover:bg-brass/20 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Save and continue
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
