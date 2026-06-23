import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'

// Confirm who the contract goes to for signature before sending it via SignWell. Prefills
// from the project's contact, but Michael can override (the person he spoke to often isn't
// the one who can sign). This is the minimal signer-confirmation step.

type Props = {
  open: boolean
  defaultName: string
  defaultEmail: string
  testMode: boolean
  busy: boolean
  // Contract fields left blank on this project. Shown as a warning; sending requires a
  // confirmation so a half-filled contract can't go out by accident.
  missingFields?: string[]
  onCancel: () => void
  onSend: (name: string, email: string) => void
}

export function SignerModal({ open, defaultName, defaultEmail, testMode, busy, missingFields = [], onCancel, onSend }: Props) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [ack, setAck] = useState(false)

  useEffect(() => {
    if (open) {
      setName(defaultName)
      setEmail(defaultEmail)
      setAck(false)
    }
  }, [open, defaultName, defaultEmail])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const hasMissing = missingFields.length > 0
  const valid = email.trim().includes('@') && (!hasMissing || ack)

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[70] flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={onCancel} aria-hidden />
          <motion.div
            className="relative w-full max-w-md rounded-2xl border border-line-strong bg-surface shadow-[0_30px_70px_-30px_rgba(0,0,0,0.9)]"
            initial={{ y: 16, opacity: 0.6, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 16, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="border-b border-line px-6 pb-4 pt-5">
              <h2 className="font-display text-[19px] leading-tight text-parchment">Send for signature</h2>
              <p className="mt-1 text-[12.5px] text-muted">
                Confirm who should sign. This is who can't always be the person you spoke to, so double-check the email.
              </p>
            </div>
            <div className="space-y-3 px-6 py-5">
              <label className="block">
                <span className="block text-[10px] font-semibold uppercase tracking-[0.16em] text-faint">Signer name</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="mt-1.5 w-full rounded-lg border border-line bg-surface-2/40 px-3 py-2 text-[13px] text-parchment outline-none focus:border-brass-dim"
                  placeholder="Full name"
                  autoFocus
                />
              </label>
              <label className="block">
                <span className="block text-[10px] font-semibold uppercase tracking-[0.16em] text-faint">Signer email</span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="mt-1.5 w-full rounded-lg border border-line bg-surface-2/40 px-3 py-2 text-[13px] text-parchment outline-none focus:border-brass-dim"
                  placeholder="name@example.com"
                />
              </label>
              {hasMissing && (
                <div className="rounded-lg border border-[#e0a98b]/40 bg-[#e0a98b]/10 px-3 py-2.5">
                  <p className="text-[11.5px] font-semibold text-[#e0a98b]">These contract fields are blank:</p>
                  <ul className="mt-1 list-disc pl-4 text-[11.5px] leading-relaxed text-[#e0a98b]">
                    {missingFields.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
                    Fields you've set as <span className="text-parchment">Client + Required</span> in SignWell will be collected
                    from the client. Any others will simply be blank on the signed contract.
                  </p>
                  <label className="mt-2 flex items-center gap-2 text-[11.5px] text-parchment">
                    <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="accent-brass" />
                    Send anyway
                  </label>
                </div>
              )}
              {testMode && (
                <p className="text-[11px] leading-relaxed text-[#e0a98b]">
                  Test mode: SignWell sends a watermarked, non-binding test document. Flip <span className="text-parchment">testMode</span> to false in signwell-credentials.json for real, binding signatures.
                </p>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-line px-6 py-4">
              <button
                type="button"
                onClick={onCancel}
                className="rounded-lg border border-line px-4 py-2 text-[12.5px] font-medium text-muted transition-colors hover:border-line-strong hover:text-parchment"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!valid || busy}
                onClick={() => onSend(name.trim(), email.trim())}
                className="rounded-lg bg-brass px-4 py-2 text-[12.5px] font-semibold text-[#231a0c] transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? 'Sending…' : 'Send for signature'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
