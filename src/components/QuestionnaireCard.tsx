import { useEffect, useState } from 'react'
import { type Project } from '../pipeline'
import { loadQuestionnaire, setQuestionnaire, pullQuestionnaire, type QuestionnaireState } from '../api'

// The Booking-section "Questionnaire" card. Flip it on to put a ONE-TIME questionnaire GATE on the
// client's portal: until they submit it, the portal link shows only the questionnaire; once they
// submit, their answers auto-fill the event-detail fields and the link opens the portal for good.
// This card is intentionally minimal: a status pill and a single Activate/Deactivate button. The
// answers themselves appear in the Event details section, so they are not duplicated here.

export function QuestionnaireCard({ project, onApplied }: { project: Project; onApplied?: () => void }) {
  const [state, setState] = useState<QuestionnaireState | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const refresh = () => loadQuestionnaire(project.id).then(setState).catch(() => setState(null))

  // Load state, then quietly poll for a submission. A fresh one auto-fills the event-detail fields
  // (and marks the questionnaire submitted here), so reload the project to surface the new values.
  useEffect(() => {
    let alive = true
    loadQuestionnaire(project.id)
      .then((s) => {
        if (!alive) return
        setState(s)
        if (s.questionnaire?.enabled && !s.questionnaire.response) {
          pullQuestionnaire(project.id)
            .then((p) => {
              if (!alive) return
              if (p.ok && p.fresh) {
                refresh()
                onApplied?.()
              }
            })
            .catch(() => {})
        }
      })
      .catch(() => alive && setState(null))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id])

  const toggle = async (enabled: boolean) => {
    setBusy(true)
    setNote(enabled ? 'Activating and publishing to the portal… (this takes ~30s)' : 'Deactivating…')
    try {
      const r = await setQuestionnaire(project.id, { enabled })
      await refresh()
      if (!r.deploy?.ok) setNote(`Saved, but the portal deploy reported a problem: ${r.deploy?.error || 'unknown'}`)
      else setNote(enabled ? 'Live. Copy the link below and send it to the client.' : 'Questionnaire turned off.')
    } catch (e) {
      setNote(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(false)
    }
  }

  const copyLink = async () => {
    if (!state?.portalUrl) return
    try {
      await navigator.clipboard.writeText(state.portalUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      setNote('Could not copy. The link is: ' + state.portalUrl)
    }
  }

  const q = state?.questionnaire
  const enabled = !!q?.enabled
  const submitted = !!q?.response
  const statusLabel = submitted ? 'Submitted' : enabled ? 'Active, not submitted' : 'Not active'
  const pillStyle = submitted
    ? { color: 'var(--color-umb-booked)', backgroundColor: 'color-mix(in oklab, var(--color-umb-booked) 16%, transparent)' }
    : enabled
      ? {
          color: 'var(--color-brass-bright, #d8a843)',
          backgroundColor: 'color-mix(in oklab, var(--color-brass-bright, #d8a843) 16%, transparent)',
        }
      : undefined

  return (
    <div className="rounded-xl border border-line bg-surface-2/30 px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] font-medium text-parchment">Questionnaire</p>
        {state && !submitted && (
          <button
            type="button"
            disabled={busy}
            onClick={() => toggle(!enabled)}
            className={
              enabled
                ? 'rounded-lg border border-line px-2.5 py-1 text-[11.5px] font-semibold text-muted transition-colors hover:text-parchment disabled:opacity-40'
                : 'rounded-lg border border-brass-dim/60 bg-surface-3 px-2.5 py-1 text-[11.5px] font-semibold text-brass-bright transition-colors hover:border-brass disabled:opacity-40'
            }
          >
            {busy ? 'Working…' : enabled ? 'Deactivate' : 'Activate'}
          </button>
        )}
      </div>

      {state == null ? (
        <p className="mt-1 text-[11.5px] text-faint">Loading…</p>
      ) : (
        <div className="mt-2 space-y-2.5">
          {/* Status */}
          <span
            className="inline-block rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em] text-faint"
            style={pillStyle}
          >
            {statusLabel}
          </span>

          {/* What it does, when off and never submitted */}
          {!enabled && !submitted && (
            <p className="text-[11.5px] leading-relaxed text-faint">
              Put a one-time questionnaire on the client's portal. Until they fill it out, the portal link shows only the
              questionnaire; once they submit, their answers auto-fill the event details and the link opens the portal.
              {!state.blobConfigured && ' Note: answer storage isn’t set up yet, so submissions won’t save until it is.'}
            </p>
          )}

          {/* Storage warning while active */}
          {enabled && !submitted && !state.blobConfigured && (
            <p className="rounded-lg border border-[#e08a6b]/40 bg-[#e08a6b]/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-[#e08a6b]">
              Answer storage isn’t set up yet, so client submissions won’t be saved. Finish the Vercel Blob setup to start
              collecting answers.
            </p>
          )}

          {/* The client's gate link, while active and not yet submitted */}
          {enabled && !submitted && state.portalUrl && (
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate rounded-lg border border-line bg-surface-2/60 px-2.5 py-1.5 text-[11px] text-muted">
                {state.portalUrl}
              </span>
              <button
                type="button"
                onClick={copyLink}
                className="shrink-0 rounded-lg border border-line px-2.5 py-1.5 text-[11px] font-semibold text-parchment hover:border-brass"
              >
                {copied ? 'Copied' : 'Copy link'}
              </button>
            </div>
          )}

          {submitted && (
            <p className="text-[11.5px] leading-relaxed text-faint">
              The client completed the questionnaire. Their answers are in the event details above.
            </p>
          )}
        </div>
      )}

      {note && <p className="mt-2 text-[11px] leading-relaxed text-muted">{note}</p>}
    </div>
  )
}
