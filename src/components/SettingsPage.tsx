import { useEffect, useState } from 'react'
import {
  loadQuestionnaireTemplate,
  saveQuestionnaireTemplate,
  loadConfig,
  saveConfig,
  type Question,
  type QuestionType,
} from '../api'
import { EVENT_FIELDS, MAPPABLE_FIELDS } from '../eventFields'

// The Settings page. Two sections for now: the global questionnaire editor (the question set every
// project's questionnaire uses) and event-field overrides (rename or hide fields in Event details).

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
  const [fBusy, setFBusy] = useState(false)
  const [fNote, setFNote] = useState<string | null>(null)

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
  const saveFields = async () => {
    setFBusy(true)
    setFNote(null)
    try {
      const cleanLabels: Record<string, string> = {}
      for (const [k, v] of Object.entries(labels)) if (String(v).trim()) cleanLabels[k] = String(v).trim()
      await saveConfig({ eventFieldLabels: cleanLabels, eventFieldHidden: [...hidden] })
      setLabels(cleanLabels)
      setFNote('Saved. Open a project to see the changes.')
    } catch (e) {
      setFNote(String(e instanceof Error ? e.message : e))
    } finally {
      setFBusy(false)
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
                    value={q.fieldKey || ''}
                    onChange={(e) => updateQ(i, { fieldKey: e.target.value || undefined })}
                    className="rounded-lg border border-line bg-surface-2 px-2 py-1.5 text-[12px] text-parchment focus:border-brass-dim focus:outline-none"
                    title="Auto-fill this project field with the answer"
                  >
                    <option value="">Fills: nothing</option>
                    {MAPPABLE_FIELDS.map((f) => (
                      <option key={f.id} value={f.id}>Fills: {f.label}</option>
                    ))}
                  </select>
                  <label className="flex items-center gap-1.5 text-[12px] text-muted">
                    <input type="checkbox" checked={!!q.required} onChange={(e) => updateQ(i, { required: e.target.checked })} className="accent-brass" />
                    Required
                  </label>
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
              <p className="mt-0.5 text-[12px] text-muted">Rename a field or hide one you do not use. Affects every project's Event details.</p>
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

          <div className="mt-4 space-y-1.5">
            {EVENT_FIELDS.map((f) => {
              const isShown = !hidden.has(f.id)
              return (
                <div key={f.id} className="flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2">
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
                </div>
              )
            })}
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-faint">
            The label box shows the default as a placeholder. Type to rename, or leave it blank to keep the default.
          </p>
          {fNote && <p className="mt-2 text-[11.5px] text-muted">{fNote}</p>}
        </section>
      </div>
    </div>
  )
}
