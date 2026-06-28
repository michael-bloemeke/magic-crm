import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import {
  deleteTemplate as apiDelete,
  loadConfig,
  loadTemplates,
  saveTemplate as apiSave,
  type Template,
} from '../api'
import { RichTextEditor } from './RichTextEditor'
import { SMART_FIELDS, textToHtml } from '../smartFields'

// Define reusable email templates. They can later be dropped into the reply
// composer in a project's Communications tab.

export function TemplatesPage() {
  const [templates, setTemplates] = useState<Template[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  // Custom event fields are insertable as merge-field placeholders too (resolved when the template
  // is used in a project email).
  const [customFields, setCustomFields] = useState<{ id: string; label: string }[]>([])
  const smartFieldList = [...SMART_FIELDS, ...customFields.map((f) => ({ key: f.id, label: f.label }))]

  useEffect(() => {
    loadTemplates()
      .then((t) => setTemplates(t))
      .catch(() => setTemplates([]))
    loadConfig()
      .then((c) => setCustomFields(c.customFields || []))
      .catch(() => {})
  }, [])

  const selected = templates?.find((t) => t.id === selectedId) ?? null

  const pick = (t: Template) => {
    setSelectedId(t.id)
    setName(t.name)
    setSubject(t.subject)
    // Legacy text templates are converted so they render in the rich editor; new ones are HTML.
    setBody(t.format === 'html' ? t.body : textToHtml(t.body))
    setStatus(null)
  }

  const startNew = () => {
    setSelectedId(null)
    setName('')
    setSubject('')
    setBody('')
    setStatus(null)
  }

  const save = async () => {
    if (!name.trim()) {
      setStatus('Give the template a name first.')
      return
    }
    setStatus('Saving…')
    try {
      const saved = await apiSave({ id: selectedId ?? undefined, name: name.trim(), subject, body, format: 'html' })
      setTemplates((prev) => {
        const list = prev ?? []
        const exists = list.some((t) => t.id === saved.id)
        return exists ? list.map((t) => (t.id === saved.id ? saved : t)) : [...list, saved]
      })
      setSelectedId(saved.id)
      setStatus('Saved.')
    } catch {
      setStatus('Could not save.')
    }
  }

  const remove = async () => {
    if (!selectedId) {
      startNew()
      return
    }
    const id = selectedId
    setTemplates((prev) => (prev ?? []).filter((t) => t.id !== id))
    startNew()
    apiDelete(id).catch(() => {
      setStatus('Could not delete that template.')
      loadTemplates().then(setTemplates).catch(() => {}) // restore the real list
    })
  }

  if (!templates) {
    return <p className="animate-pulse px-8 pt-8 text-[13px] text-faint">Loading templates…</p>
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.35 }}
      className="grid min-h-0 flex-1 grid-cols-[300px_1fr] gap-6 px-8 pb-10"
    >
      {/* List */}
      <div className="board-scroll min-h-0 overflow-y-auto pr-1">
        <button
          type="button"
          onClick={startNew}
          className="mb-3 flex w-full items-center justify-center gap-1.5 rounded-lg border border-brass-dim/60 bg-surface-3/60 py-2.5 text-[12.5px] font-semibold text-brass-bright transition-colors hover:border-brass"
        >
          <span className="text-base leading-none">+</span> New template
        </button>

        {templates.length === 0 ? (
          <p className="px-1 text-[12.5px] text-faint">No templates yet. Create your first one.</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {templates.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => pick(t)}
                className={[
                  'rounded-lg border px-3 py-2.5 text-left transition-colors',
                  selectedId === t.id
                    ? 'border-brass-dim bg-surface-3'
                    : 'border-line bg-surface-2/60 hover:border-line-strong hover:bg-surface-3/70',
                ].join(' ')}
              >
                <p className="truncate text-[13.5px] font-medium text-parchment">{t.name}</p>
                <p className="mt-0.5 truncate text-[11.5px] text-faint">{t.subject || 'No subject'}</p>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Editor */}
      <div className="board-scroll min-h-0 overflow-y-auto">
        <div className="max-w-2xl space-y-4">
          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.16em] text-faint">
              Template name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                setStatus(null)
              }}
              placeholder="e.g. Inquiry reply, Post-call follow-up…"
              className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-[14px] text-parchment placeholder:text-faint focus:border-brass-dim focus:outline-none"
            />
          </div>

          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.16em] text-faint">
              Subject
            </label>
            <input
              type="text"
              value={subject}
              onChange={(e) => {
                setSubject(e.target.value)
                setStatus(null)
              }}
              placeholder="Email subject line"
              className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-[13.5px] text-parchment placeholder:text-faint focus:border-brass-dim focus:outline-none"
            />
          </div>

          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.16em] text-faint">
              Body
            </label>
            <RichTextEditor
              value={body}
              onChange={(html) => {
                setBody(html)
                setStatus(null)
              }}
              smartFields={smartFieldList}
              placeholder="Write the template. Use Insert field to drop in smart fields…"
            />
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-faint">
              Use <span className="font-semibold text-brass-bright">Insert field</span> to add a smart field. It shows as a{' '}
              <span className="merge-field">[highlighted placeholder]</span> here; when you use this template on a project, it
              fills in from that project automatically.
            </p>
          </div>

          <div className="flex items-center justify-between gap-3">
            <span className="text-[12px] text-muted">{status}</span>
            <div className="flex items-center gap-2">
              {selected && (
                <button
                  type="button"
                  onClick={remove}
                  className="rounded-lg border border-line px-3 py-2 text-[12.5px] font-medium text-muted transition-colors hover:border-[#e08a6b]/60 hover:text-[#e08a6b]"
                >
                  Delete
                </button>
              )}
              <button
                type="button"
                onClick={save}
                className="rounded-lg border border-brass-dim/60 bg-gradient-to-b from-surface-3 to-surface px-4 py-2 text-[12.5px] font-semibold text-brass-bright transition-all hover:border-brass"
              >
                {selected ? 'Save changes' : 'Save template'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  )
}
