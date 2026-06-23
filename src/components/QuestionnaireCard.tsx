import { useEffect, useState } from 'react'
import { type Project } from '../pipeline'
import {
  loadQuestionnaire,
  setQuestionnaire,
  pullQuestionnaire,
  type QuestionnaireState,
} from '../api'

// The Booking-section "Questionnaire" card. An optional portal add-on: flip it on to publish a
// styled form to the client's portal page; when they fill it, the answers auto-fill the mapped
// event-detail fields and the full Q&A shows here. Polls for answers on open.

function fmtDate(iso: string) {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function QuestionnaireCard({ project, onApplied }: { project: Project; onApplied?: () => void }) {
  const [state, setState] = useState<QuestionnaireState | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const refresh = () => loadQuestionnaire(project.id).then(setState).catch(() => setState(null))

  // Load state, then quietly poll for answers. A fresh submission auto-fills fields, so reload
  // the project to surface them. (The card is keyed by project id, so it mounts fresh per
  // project and starts from the null "Loading…" state without a synchronous reset here.)
  useEffect(() => {
    let alive = true
    loadQuestionnaire(project.id)
      .then((s) => {
        if (!alive) return
        setState(s)
        if (s.questionnaire?.enabled) {
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
    setNote(enabled ? 'Publishing the questionnaire to the portal… (this takes ~30s)' : 'Updating the portal…')
    try {
      const r = await setQuestionnaire(project.id, { enabled })
      await refresh()
      if (!r.deploy?.ok) setNote(`Saved, but the portal deploy reported a problem: ${r.deploy?.error || 'unknown'}`)
      else setNote(enabled ? 'Live. Send the client their portal link below.' : 'Questionnaire turned off.')
    } catch (e) {
      setNote(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(false)
    }
  }

  const checkAnswers = async () => {
    setBusy(true)
    setNote(null)
    try {
      const p = await pullQuestionnaire(project.id)
      if (!p.ok) {
        setNote(p.error || 'Could not check for answers.')
      } else if (p.response) {
        await refresh()
        if (p.fresh) {
          onApplied?.()
          setNote(p.filledFields?.length ? `Answers are in. Auto-filled: ${p.filledFields.join(', ')}.` : 'Answers are in.')
        } else {
          setNote('No new answers since last check.')
        }
      } else {
        setNote('No answers yet.')
      }
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
      setNote('Could not copy. The link is shown above.')
    }
  }

  const q = state?.questionnaire
  const enabled = !!q?.enabled
  const response = q?.response || null

  return (
    <div className="rounded-xl border border-line bg-surface-2/30 px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] font-medium text-parchment">Questionnaire</p>
        {state && (
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
            {busy ? 'Working…' : enabled ? 'Turn off' : 'Turn on'}
          </button>
        )}
      </div>

      {state == null ? (
        <p className="mt-1 text-[11.5px] text-faint">Loading…</p>
      ) : !enabled ? (
        <p className="mt-1 text-[11.5px] leading-relaxed text-faint">
          Send the client a short form (12 questions) on their portal page. Their answers auto-fill the event details here.
          {!state.blobConfigured && ' Note: answer storage isn’t set up yet, so submissions won’t save until it is.'}
        </p>
      ) : (
        <div className="mt-2 space-y-2.5">
          {!state.blobConfigured && (
            <p className="rounded-lg border border-[#e08a6b]/40 bg-[#e08a6b]/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-[#e08a6b]">
              Answer storage isn’t set up yet, so client submissions won’t be saved. Finish the Vercel Blob setup to start
              collecting answers.
            </p>
          )}

          {/* The client's link */}
          {state.portalUrl && (
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

          {/* Status + answers */}
          {response ? (
            <div className="rounded-lg border border-line bg-surface-2/40 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span
                  className="rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em]"
                  style={{ color: 'var(--color-umb-booked)', backgroundColor: 'color-mix(in oklab, var(--color-umb-booked) 16%, transparent)' }}
                >
                  Answered
                </span>
                <span className="text-[10.5px] text-faint">{fmtDate(response.submittedAt)}</span>
              </div>
              {response.appliedFields?.length > 0 && (
                <p className="mt-1.5 text-[10.5px] text-faint">Auto-filled: {response.appliedFields.join(', ')}.</p>
              )}
              <dl className="mt-2 space-y-1.5">
                {response.answers.map((a) => (
                  <div key={a.id}>
                    <dt className="text-[10.5px] text-faint">{a.label}</dt>
                    <dd className="text-[12px] text-parchment whitespace-pre-line">{a.value || '—'}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-faint">Awaiting the client’s answers.</span>
              <button
                type="button"
                disabled={busy}
                onClick={checkAnswers}
                className="text-[11px] text-muted hover:text-parchment disabled:opacity-40"
              >
                Check for answers
              </button>
            </div>
          )}
        </div>
      )}

      {note && <p className="mt-2 text-[11px] leading-relaxed text-muted">{note}</p>}
    </div>
  )
}
