import { useEffect, useRef, useState } from 'react'
import { type Project } from '../pipeline'
import { loadQuestionnaire, setQuestionnaire, pullQuestionnaire, type ProjectEmail, type QuestionnaireState } from '../api'
import { EmailBuilderCard } from './EmailBuilderCard'

// A short invite email whose body carries a real button (not just a link) to the questionnaire.
const questionnaireInviteBody = (url: string) =>
  '<p>Hi there,</p>' +
  '<p>I am looking forward to your event. When you get a chance, please share a few quick details so I can tailor the perfect performance.</p>' +
  '<p><a href="' + url + '" style="display:inline-block;background:#c79a4b;color:#1a1407;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;font-family:Arial,Helvetica,sans-serif">Fill out your event details</a></p>' +
  '<p>Thanks!<br>Michael</p>'

// The Booking-section "Questionnaire" card. Flip it on to put a ONE-TIME questionnaire GATE on the
// client's portal: until they submit it, the portal link shows only the questionnaire; once they
// submit, their answers auto-fill the event-detail fields and the link opens the portal for good.
// This card is intentionally minimal: a status pill and a single Activate/Deactivate button. The
// answers themselves appear in the Event details section, so they are not duplicated here. While a
// questionnaire is active, the card polls for the client's submission (and a fresh one auto-fills
// the fields here and republishes the portal so it shows the new details).

export function QuestionnaireCard({
  project,
  onApplied,
  recipientEmails,
  inviteEmail,
  onEmailSaved,
  onEmailDiscard,
}: {
  project: Project
  onApplied?: () => void
  recipientEmails?: string[]
  inviteEmail?: ProjectEmail | null
  onEmailSaved?: (email: ProjectEmail) => void
  onEmailDiscard?: (id: string) => void
}) {
  const [state, setState] = useState<QuestionnaireState | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [showAnswers, setShowAnswers] = useState(false)
  const polling = useRef(false)

  const enabled = !!state?.questionnaire?.enabled
  const submitted = !!state?.questionnaire?.response
  const response = state?.questionnaire?.response || null

  const refresh = () => loadQuestionnaire(project.id).then(setState).catch(() => setState(null))

  // Check the blob for the client's submission. A fresh one auto-fills the event-detail fields and
  // (server-side) republishes the portal, so reload local state + the project to surface it. The
  // `polling` guard prevents the interval from stacking calls while a slow one (a deploy) runs.
  const poll = async (manual = false) => {
    if (polling.current) return
    polling.current = true
    if (manual) {
      setBusy(true)
      setNote(null)
    }
    try {
      const p = await pullQuestionnaire(project.id)
      if (p.ok && p.fresh) {
        await refresh()
        onApplied?.()
        if (manual) {
          if (p.deploy && p.deploy.ok === false)
            setNote('Answers are in. The portal refresh hit a problem; you can re-publish it from the Portal panel.')
          else setNote('Answers are in and the portal was updated.')
        }
      } else if (manual) {
        setNote(p.ok ? (p.response ? 'No new answers since last check.' : 'No answers yet.') : p.error || 'Could not check for answers.')
      }
    } catch (e) {
      if (manual) setNote(String(e instanceof Error ? e.message : e))
    } finally {
      polling.current = false
      if (manual) setBusy(false)
    }
  }

  // Load state on open, then pull once if it's active and not yet submitted.
  useEffect(() => {
    let alive = true
    loadQuestionnaire(project.id)
      .then((s) => {
        if (!alive) return
        setState(s)
        if (s.questionnaire?.enabled && !s.questionnaire.response) poll()
      })
      .catch(() => alive && setState(null))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id])

  // While active and waiting, keep checking so a submission lands without reopening the project.
  useEffect(() => {
    if (!enabled || submitted) return
    const t = setInterval(() => poll(), 15000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, submitted, project.id])

  const toggle = async (next: boolean) => {
    setBusy(true)
    setNote(next ? 'Activating and publishing to the portal… (this takes ~30s)' : 'Deactivating…')
    try {
      const r = await setQuestionnaire(project.id, { enabled: next })
      await refresh()
      if (!r.deploy?.ok) setNote(`Saved, but the portal deploy reported a problem: ${r.deploy?.error || 'unknown'}`)
      else setNote(next ? 'Live. Copy the link below and send it to the client.' : 'Questionnaire turned off.')
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

          {/* The client's gate link + manual check, while active and not yet submitted */}
          {enabled && !submitted && (
            <>
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
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-faint">Waiting for the client to submit. Checks automatically.</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => poll(true)}
                  className="text-[11px] text-muted hover:text-parchment disabled:opacity-40"
                >
                  {busy ? 'Checking…' : 'Check now'}
                </button>
              </div>
              {/* Invite email: composes a message with a button straight to the questionnaire. */}
              {state.portalUrl && onEmailSaved && (
                <EmailBuilderCard
                  project={project}
                  recipientEmails={recipientEmails || []}
                  kind="questionnaire-invite"
                  title="Invite email"
                  defaultSubject="A few details for your event"
                  defaultBody={questionnaireInviteBody(state.portalUrl)}
                  email={inviteEmail || null}
                  onSaved={onEmailSaved}
                  onDiscard={onEmailDiscard}
                />
              )}
            </>
          )}

          {submitted && (
            <div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11.5px] leading-relaxed text-faint">
                  Completed. Answers are in the event details above.
                </span>
                <button
                  type="button"
                  onClick={() => setShowAnswers((v) => !v)}
                  className="shrink-0 text-[11px] text-muted transition-colors hover:text-parchment"
                >
                  {showAnswers ? 'Hide answers' : 'Show answers'}
                </button>
              </div>
              {showAnswers && (
                <dl className="mt-2 space-y-1.5 rounded-lg border border-line bg-surface-2/40 px-3 py-2">
                  {(response?.answers ?? []).map((a) => (
                    <div key={a.id}>
                      <dt className="text-[10.5px] text-faint">{a.label}</dt>
                      <dd className="whitespace-pre-line text-[12px] text-parchment">{a.value || '(blank)'}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          )}
        </div>
      )}

      {note && <p className="mt-2 text-[11px] leading-relaxed text-muted">{note}</p>}
    </div>
  )
}
