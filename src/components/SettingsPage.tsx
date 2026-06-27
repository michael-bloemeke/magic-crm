import { useEffect, useState } from 'react'
import {
  loadQuestionnaireTemplate,
  saveQuestionnaireTemplate,
  loadConfig,
  saveConfig,
  type Question,
  type QuestionType,
} from '../api'
import { EVENT_FIELDS, MAPPABLE_FIELDS, ESSENTIAL_FIELD_IDS, makeCustomFieldId, type CustomField } from '../eventFields'
import { RichTextEditor } from './RichTextEditor'

// The Settings page. Sections: the global questionnaire editor (the question set every project's
// questionnaire uses), event-field overrides (rename or hide fields in Event details), and the
// email signature appended below the body on every send.

const TYPES: { value: QuestionType; label: string }[] = [
  { value: 'text', label: 'Short text' },
  { value: 'textarea', label: 'Long text' },
  { value: 'date', label: 'Date' },
  { value: 'tel', label: 'Phone' },
  { value: 'number', label: 'Number' },
  { value: 'select', label: 'Dropdown' },
]

const newId = () => 'q' + Math.random().toString(36).slice(2, 9)
const inputCls =
  'w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-[13px] text-parchment placeholder:text-faint focus:border-brass-dim focus:outline-none'

export function SettingsPage() {
  const [intro, setIntro] = useState('')
  const [questions, setQuestions] = useState<Question[]>([])
  const [qBusy, setQBusy] = useState(false)
  const [qNote, setQNote] = useState<string | null>(null)

  const [labels, setLabels] = useState<Record<string, string>>({})
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [deleted, setDeleted] = useState<Set<string>>(new Set())
  const [customFields, setCustomFields] = useState<CustomField[]>([])
  const [newCustomLabel, setNewCustomLabel] = useState('')
  const [fBusy, setFBusy] = useState(false)
  const [fNote, setFNote] = useState<string | null>(null)

  const [sigEnabled, setSigEnabled] = useState(false)
  const [sigHtml, setSigHtml] = useState('')
  const [sigBusy, setSigBusy] = useState(false)
  const [sigNote, setSigNote] = useState<string | null>(null)

  useEffect(() => {
    loadQuestionnaireTemplate()
      .then((t) => {
        setIntro(t.intro || '')
        setQuestions(t.questions || [])
      })
      .catch(() => {})
    loadConfig()
      .then((c) => {
        setLabels(c.eventFieldLabels || {})
        setHidden(new Set(c.eventFieldHidden || []))
        setDeleted(new Set(c.eventFieldDeleted || []))
        setCustomFields(c.customFields || [])
        setSigEnabled(!!c.signatureEnabled)
        setSigHtml(c.signatureHtml || '')
      })
      .catch(() => {})
  }, [])

  // --- Questionnaire editor ---
  const updateQ = (i: number, patch: Partial<Question>) =>
    setQuestions((qs) => qs.map((q, idx) => (idx === i ? { ...q, ...patch } : q)))
  const addQ = () => setQuestions((qs) => [...qs, { id: newId(), label: '', type: 'text', required: false }])
  const removeQ = (i: number) => setQuestions((qs) => qs.filter((_, idx) => idx !== i))
  const moveQ = (i: number, dir: -1 | 1) =>
    setQuestions((qs) => {
      const j = i + dir
      if (j < 0 || j >= qs.length) return qs
      const next = qs.slice()
      const tmp = next[i]
      next[i] = next[j]
      next[j] = tmp
      return next
    })

  const saveQuestionnaire = async () => {
    setQBusy(true)
    setQNote(null)
    try {
      const t = await saveQuestionnaireTemplate({ intro, questions })
      setIntro(t.intro)
      setQuestions(t.questions)
      setQNote('Saved. Every project questionnaire now uses this set.')
    } catch (e) {
      setQNote(String(e instanceof Error ? e.message : e))
    } finally {
      setQBusy(false)
    }
  }

  // --- Event fields ---
  const toggleHidden = (id: string) =>
    setHidden((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  // Delete / restore a display-only built-in (essential ones can't be deleted, enforced in the UI).
  const deleteBuiltin = (id: string) => setDeleted((s) => new Set(s).add(id))
  const restoreBuiltin = (id: string) =>
    setDeleted((s) => {
      const n = new Set(s)
      n.delete(id)
      return n
    })
  // Custom fields.
  const addCustom = () => {
    const label = newCustomLabel.trim()
    if (!label) return
    setCustomFields((cf) => [...cf, { id: makeCustomFieldId(), label }])
    setNewCustomLabel('')
  }
  const renameCustom = (id: string, label: string) => setCustomFields((cf) => cf.map((f) => (f.id === id ? { ...f, label } : f)))
  const removeCustom = (id: string) => setCustomFields((cf) => cf.filter((f) => f.id !== id))

  // Questionnaire field-mapping validity: a question can map to a built-in (minus deleted) or a
  // contact field. If its fieldKey points at something no longer offered, it's a broken link.
  const validMappable = MAPPABLE_FIELDS.filter((f) => !deleted.has(f.id))
  const validKeys = new Set(validMappable.map((f) => f.id))
  const isBrokenKey = (k?: string) => !!k && !validKeys.has(k)

  const saveFields = async () => {
    setFBusy(true)
    setFNote(null)
    try {
      const cleanLabels: Record<string, string> = {}
      for (const [k, v] of Object.entries(labels)) if (String(v).trim()) cleanLabels[k] = String(v).trim()
      const cleanCustom = customFields.filter((f) => f.label.trim()).map((f) => ({ id: f.id, label: f.label.trim() }))
      await saveConfig({
        eventFieldLabels: cleanLabels,
        eventFieldHidden: [...hidden],
        eventFieldDeleted: [...deleted],
        customFields: cleanCustom,
      })
      setLabels(cleanLabels)
      setCustomFields(cleanCustom)
      setFNote('Saved. Open a project to see the changes.')
    } catch (e) {
      setFNote(String(e instanceof Error ? e.message : e))
    } finally {
      setFBusy(false)
    }
  }

  // --- Email signature ---
  const saveSignature = async () => {
    setSigBusy(true)
    setSigNote(null)
    try {
      await saveConfig({ signatureEnabled: sigEnabled, signatureHtml: sigHtml })
      setSigNote(sigEnabled ? 'Saved. Your signature will be added to emails you send.' : 'Saved. Signature is off.')
    } catch (e) {
      setSigNote(String(e instanceof Error ? e.message : e))
    } finally {
      setSigBusy(false)
    }
  }

  return (
    <div className="board-scroll min-h-0 flex-1 overflow-y-auto px-8 pb-20 pt-2">
      <div className="mx-auto max-w-3xl space-y-8">
        {/* Questionnaire editor */}
        <section className="rounded-2xl border border-line bg-surface-2/30 p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-[17px] text-parchment">Client questionnaire</h2>
              <p className="mt-0.5 text-[12px] text-muted">
                The questions every project's questionnaire asks. Map an answer to a field to auto-fill it.
              </p>
            </div>
            <button
              type="button"
              onClick={saveQuestionnaire}
              disabled={qBusy}
              className="shrink-0 rounded-lg bg-brass px-4 py-2 text-[12.5px] font-semibold text-[#231a0c] transition-all hover:brightness-110 disabled:opacity-40"
            >
              {qBusy ? 'Saving…' : 'Save questionnaire'}
            </button>
          </div>

          <label className="mt-4 block">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Intro message</span>
            <textarea value={intro} onChange={(e) => setIntro(e.target.value)} rows={2} className={inputCls + ' resize-y'} />
          </label>

          <div className="mt-4 space-y-3">
            {questions.map((q, i) => (
              <div key={q.id} className="rounded-xl border border-line bg-surface px-3 py-3">
                <div className="flex items-start gap-2">
                  <input
                    value={q.label}
                    onChange={(e) => updateQ(i, { label: e.target.value })}
                    placeholder="Question text"
                    className={inputCls + ' flex-1'}
                  />
                  <div className="flex shrink-0 flex-col items-center">
                    <button type="button" onClick={() => moveQ(i, -1)} disabled={i === 0} className="px-1 text-faint hover:text-parchment disabled:opacity-30" aria-label="Move up">
                      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 15l6-6 6 6" /></svg>
                    </button>
                    <button type="button" onClick={() => moveQ(i, 1)} disabled={i === questions.length - 1} className="px-1 text-faint hover:text-parchment disabled:opacity-30" aria-label="Move down">
                      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
                    </button>
                  </div>
                  <button type="button" onClick={() => removeQ(i)} className="shrink-0 px-1 pt-2 text-faint transition-colors hover:text-[#e08a6b]" aria-label="Remove question">
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6" /></svg>
                  </button>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <select value={q.type} onChange={(e) => updateQ(i, { type: e.target.value as QuestionType })} className="rounded-lg border border-line bg-surface-2 px-2 py-1.5 text-[12px] text-parchment focus:border-brass-dim focus:outline-none">
                    {TYPES.map((t) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                  <select
                    value={isBrokenKey(q.fieldKey) ? '' : q.fieldKey || ''}
                    onChange={(e) => updateQ(i, { fieldKey: e.target.value || undefined })}
                    className="rounded-lg border border-line bg-surface-2 px-2 py-1.5 text-[12px] text-parchment focus:border-brass-dim focus:outline-none"
                    title="Auto-fill this project field with the answer"
                  >
                    <option value="">Fills: nothing</option>
                    {validMappable.map((f) => (
                      <option key={f.id} value={f.id}>Fills: {f.label}</option>
                    ))}
                  </select>
                  <label className="flex items-center gap-1.5 text-[12px] text-muted">
                    <input type="checkbox" checked={!!q.required} onChange={(e) => updateQ(i, { required: e.target.checked })} className="accent-brass" />
                    Required
                  </label>
                  {isBrokenKey(q.fieldKey) && (
                    <span className="flex items-center gap-1.5 text-[11.5px] text-[#e0a06b]">
                      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
                      </svg>
                      Linked to a deleted field.
                      <button type="button" onClick={() => updateQ(i, { fieldKey: undefined })} className="underline hover:text-parchment">
                        Clear
                      </button>
                    </span>
                  )}
                  {q.type === 'select' && (
                    <input
                      value={(q.options || []).join(', ')}
                      onChange={(e) => updateQ(i, { options: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
                      placeholder="Options, comma-separated"
                      className={inputCls + ' min-w-[12rem] flex-1'}
                    />
                  )}
                </div>
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={addQ}
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-dashed border-line px-3 py-1.5 text-[12px] font-medium text-muted transition-colors hover:border-brass-dim hover:text-brass-bright"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
            Add question
          </button>
          {qNote && <p className="mt-3 text-[11.5px] text-muted">{qNote}</p>}
        </section>

        {/* Event fields */}
        <section className="rounded-2xl border border-line bg-surface-2/30 p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-[17px] text-parchment">Event detail fields</h2>
              <p className="mt-0.5 text-[12px] text-muted">Rename, hide, delete, or add fields. Affects every project's Event details.</p>
            </div>
            <button
              type="button"
              onClick={saveFields}
              disabled={fBusy}
              className="shrink-0 rounded-lg bg-brass px-4 py-2 text-[12.5px] font-semibold text-[#231a0c] transition-all hover:brightness-110 disabled:opacity-40"
            >
              {fBusy ? 'Saving…' : 'Save fields'}
            </button>
          </div>

          {/* Built-in fields (deleted display-only ones drop to the Removed list below). */}
          <div className="mt-4 space-y-1.5">
            {EVENT_FIELDS.filter((f) => !deleted.has(f.id)).map((f) => {
              const isShown = !hidden.has(f.id)
              const essential = ESSENTIAL_FIELD_IDS.has(f.id)
              return (
                <div key={f.id} className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2">
                  <input
                    value={labels[f.id] ?? ''}
                    onChange={(e) => setLabels((l) => ({ ...l, [f.id]: e.target.value }))}
                    placeholder={f.label}
                    className={inputCls + ' flex-1'}
                  />
                  <button
                    type="button"
                    onClick={() => toggleHidden(f.id)}
                    className={[
                      'shrink-0 rounded-lg border px-2.5 py-1.5 text-[11.5px] font-semibold transition-colors',
                      isShown
                        ? 'border-brass-dim/60 bg-surface-3 text-brass-bright hover:border-brass'
                        : 'border-line text-faint hover:text-parchment',
                    ].join(' ')}
                  >
                    {isShown ? 'Shown' : 'Hidden'}
                  </button>
                  {essential ? (
                    <span
                      title="Used by contracts, templates, or the inquiry import, so it can't be deleted. Hide it instead."
                      className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-line px-2 py-1.5 text-[11px] text-faint"
                    >
                      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
                      </svg>
                      Core
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => deleteBuiltin(f.id)}
                      title="Delete this field (reversible: it moves to Removed below)"
                      aria-label="Delete field"
                      className="shrink-0 rounded-lg border border-line px-2 py-1.5 text-faint transition-colors hover:border-[#e08a6b]/60 hover:text-[#e08a6b]"
                    >
                      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6" />
                      </svg>
                    </button>
                  )}
                </div>
              )
            })}
          </div>

          {/* Custom fields you add (global, shown in every project's Event details). */}
          <div className="mt-5">
            <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Your custom fields</span>
            <div className="space-y-1.5">
              {customFields.map((f) => (
                <div key={f.id} className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2">
                  <input
                    value={f.label}
                    onChange={(e) => renameCustom(f.id, e.target.value)}
                    placeholder="Field name"
                    className={inputCls + ' flex-1'}
                  />
                  <button
                    type="button"
                    onClick={() => removeCustom(f.id)}
                    title="Delete this custom field"
                    aria-label="Delete custom field"
                    className="shrink-0 rounded-lg border border-line px-2 py-1.5 text-faint transition-colors hover:border-[#e08a6b]/60 hover:text-[#e08a6b]"
                  >
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6" />
                    </svg>
                  </button>
                </div>
              ))}
              {customFields.length === 0 && <p className="text-[11.5px] text-faint">No custom fields yet. Add one below.</p>}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <input
                value={newCustomLabel}
                onChange={(e) => setNewCustomLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addCustom()
                  }
                }}
                placeholder="New field name (e.g. Parking instructions)"
                className={inputCls + ' flex-1'}
              />
              <button
                type="button"
                onClick={addCustom}
                disabled={!newCustomLabel.trim()}
                className="shrink-0 rounded-lg border border-brass-dim/60 bg-surface-3 px-3 py-2 text-[12px] font-semibold text-brass-bright transition-colors hover:border-brass disabled:opacity-40"
              >
                Add field
              </button>
            </div>
          </div>

          {/* Removed built-ins, with one-click restore. */}
          {EVENT_FIELDS.some((f) => deleted.has(f.id)) && (
            <div className="mt-5">
              <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Removed</span>
              <div className="space-y-1.5">
                {EVENT_FIELDS.filter((f) => deleted.has(f.id)).map((f) => (
                  <div key={f.id} className="flex items-center gap-2 rounded-lg border border-dashed border-line bg-surface/50 px-3 py-2">
                    <span className="flex-1 text-[12.5px] text-faint line-through">{labels[f.id] || f.label}</span>
                    <button
                      type="button"
                      onClick={() => restoreBuiltin(f.id)}
                      className="shrink-0 rounded-lg border border-line px-2.5 py-1.5 text-[11.5px] font-medium text-muted transition-colors hover:border-brass-dim hover:text-parchment"
                    >
                      Restore
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <p className="mt-3 text-[11px] leading-relaxed text-faint">
            Rename in the box (blank keeps the default). "Core" fields feed contracts, templates, and imports, so they can be
            hidden but not deleted. Custom fields appear in every project's Event details. Click Save fields to apply.
          </p>
          {fNote && <p className="mt-2 text-[11.5px] text-muted">{fNote}</p>}
        </section>

        {/* Email signature */}
        <section className="rounded-2xl border border-line bg-surface-2/30 p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-[17px] text-parchment">Email signature</h2>
              <p className="mt-0.5 text-[12px] text-muted">
                Added below your message on every email you send from a project. Add text, a logo, or a graphic with your contact info.
              </p>
            </div>
            <button
              type="button"
              onClick={saveSignature}
              disabled={sigBusy}
              className="shrink-0 rounded-lg bg-brass px-4 py-2 text-[12.5px] font-semibold text-[#231a0c] transition-all hover:brightness-110 disabled:opacity-40"
            >
              {sigBusy ? 'Saving…' : 'Save signature'}
            </button>
          </div>

          <label className="mt-4 flex cursor-pointer items-center gap-2.5 text-[13px] text-parchment">
            <input
              type="checkbox"
              checked={sigEnabled}
              onChange={(e) => setSigEnabled(e.target.checked)}
              className="h-4 w-4 accent-[#c79a4b]"
            />
            <span>Append my signature to outgoing emails</span>
          </label>

          <div className="mt-3">
            <RichTextEditor
              value={sigHtml}
              onChange={setSigHtml}
              allowImage
              placeholder="Your name, title, phone, website… and a logo via the image button."
            />
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-faint">
            Use the image button to drop in a logo or a graphic with your contact info. You still type "Thanks!" in each email
            yourself; this block goes underneath. The preview above matches what the recipient sees.
          </p>
          {sigNote && <p className="mt-2 text-[11.5px] text-muted">{sigNote}</p>}
        </section>
      </div>
    </div>
  )
}
