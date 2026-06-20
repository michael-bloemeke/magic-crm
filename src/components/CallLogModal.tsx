import { useEffect, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { Project } from '../pipeline'

// "Made a call" flow: a couple of quick taps log the call (with today's date) to the
// project's activity log. Did they answer? -> if no, did you leave a voicemail? ->
// if yes, an optional note about what you talked about (skippable, since Plaud
// recordings get filled in later by Claude).

export type CallLog = { answered: boolean; voicemail?: boolean; note?: string }
type Step = 'answered' | 'voicemail' | 'note'

export function CallLogModal({
  project,
  onClose,
  onSubmit,
}: {
  project: Project | null
  onClose: () => void
  onSubmit: (payload: CallLog) => void
}) {
  const [step, setStep] = useState<Step>('answered')
  const [note, setNote] = useState('')

  useEffect(() => {
    if (project) {
      setStep('answered')
      setNote('')
    }
  }, [project])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    if (project) window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [project, onClose])

  const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })

  return (
    <AnimatePresence>
      {project && (
        <motion.div
          className="fixed inset-0 z-[70] flex items-start justify-center p-4 pt-[14vh]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
          <motion.div
            className="relative w-full max-w-md overflow-hidden rounded-2xl border border-line-strong bg-surface shadow-[0_30px_70px_-30px_rgba(0,0,0,0.9)]"
            initial={{ y: 16, opacity: 0.6, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 16, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="border-b border-line px-6 pb-4 pt-5">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-faint">
                <PhoneIcon />
                Log a call
              </div>
              <h2 className="mt-1.5 font-display text-[19px] leading-tight text-parchment">{project.client}</h2>
              <p className="mt-0.5 text-[12px] text-muted">Logging for today, {today}.</p>
            </div>

            <div className="px-6 py-5">
              {step === 'answered' && (
                <>
                  <p className="mb-3 text-[14px] font-medium text-parchment">Did they answer?</p>
                  <div className="flex gap-2">
                    <Choice primary onClick={() => setStep('note')}>
                      Yes, they answered
                    </Choice>
                    <Choice onClick={() => setStep('voicemail')}>No answer</Choice>
                  </div>
                </>
              )}

              {step === 'voicemail' && (
                <>
                  <p className="mb-3 text-[14px] font-medium text-parchment">Did you leave a voicemail?</p>
                  <div className="flex gap-2">
                    <Choice primary onClick={() => onSubmit({ answered: false, voicemail: true })}>
                      Yes, left a voicemail
                    </Choice>
                    <Choice onClick={() => onSubmit({ answered: false, voicemail: false })}>No voicemail</Choice>
                  </div>
                </>
              )}

              {step === 'note' && (
                <>
                  <p className="mb-1.5 text-[14px] font-medium text-parchment">What did you talk about?</p>
                  <p className="mb-2.5 text-[12px] text-faint">
                    Optional. If you recorded with Plaud, skip this and Claude will fill in the details later.
                  </p>
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    rows={4}
                    autoFocus
                    placeholder="A quick note about the call…"
                    className="input w-full resize-y"
                  />
                  <div className="mt-3 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => onSubmit({ answered: true, note: '' })}
                      className="rounded-lg border border-line px-4 py-2 text-[12.5px] font-medium text-muted transition-colors hover:border-line-strong hover:text-parchment"
                    >
                      Skip
                    </button>
                    <button
                      type="button"
                      onClick={() => onSubmit({ answered: true, note: note.trim() })}
                      className="rounded-lg border border-brass-dim/60 bg-gradient-to-b from-surface-3 to-surface px-4 py-2 text-[12.5px] font-semibold text-brass-bright transition-all hover:border-brass"
                    >
                      Save note
                    </button>
                  </div>
                </>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function Choice({ children, onClick, primary }: { children: ReactNode; onClick: () => void; primary?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'flex-1 rounded-lg border px-4 py-2.5 text-[13px] font-semibold transition-all',
        primary
          ? 'border-brass-dim/60 bg-gradient-to-b from-surface-3 to-surface text-brass-bright hover:border-brass'
          : 'border-line text-muted hover:border-line-strong hover:text-parchment',
      ].join(' ')}
    >
      {children}
    </button>
  )
}

function PhoneIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  )
}
