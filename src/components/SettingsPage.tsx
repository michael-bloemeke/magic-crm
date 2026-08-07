import { useEffect, useState } from 'react'
import {
  loadConfig,
  saveConfig,
  loadStructure,
  loadPush,
  savePush,
  testPush,
  loadCalendarStatus,
  syncCalendar,
  type CalendarStatus,
  type PushConfig,
} from '../api'
import { EVENT_FIELDS, ESSENTIAL_FIELD_IDS, makeCustomFieldId, type CustomField } from '../eventFields'
import { type CategoryDef } from '../pipeline'
import { RichTextEditor } from './RichTextEditor'

// The phases of the project page's Communication timeline that a pipeline stage can highlight.
// (Post Show also highlights the Post Show section, which holds the tips and mileage figures.)
const SECTION_OPTIONS = [
  { id: 'inquiry', label: 'Inquiry' },
  { id: 'postcall', label: 'Post Call' },
  { id: 'booked', label: 'Booked' },
  { id: 'postshow', label: 'Post Show' },
  { id: 'none', label: 'No highlight' },
]
function defaultSectionFor(u: CategoryDef): string {
  if (u.role === 'first') return 'inquiry'
  if (u.role === 'booked') return 'booked'
  if (u.role === 'postshow') return 'postshow'
  return 'postcall'
}

// One "is this calendar present in the account?" row in the Google Calendar settings.
function CalRow({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-parchment">{label}</span>
      {ok ? (
        <span className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-[#7fc795]">
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6L9 17l-5-5" />
          </svg>
          Found
        </span>
      ) : (
        <span className="text-[11.5px] font-semibold text-[#2563eb]">Not found</span>
      )}
    </div>
  )
}

// The Settings page. Tabs: event fields (rename or hide fields in Event details), stage
// highlighting, the email signature, Google Calendar, and phone notifications.
//
// (The client-questionnaire editor lived here until 2026-08-03; the questionnaire was removed along
// with the client portal, replaced by the booking form.)

const inputCls =
  'w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-[13px] text-parchment placeholder:text-faint focus:border-brass-dim focus:outline-none'

// Settings tabs, so the page isn't one long scroll. Each maps to one section below.
const SETTINGS_TABS = [
  { id: 'fields', label: 'Event fields' },
  { id: 'highlighting', label: 'Highlighting' },
  { id: 'email', label: 'Email' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'notifications', label: 'Notifications' },
] as const
type SettingsTab = (typeof SETTINGS_TABS)[number]['id']

export function SettingsPage() {
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

  const [push, setPush] = useState<PushConfig | null>(null)
  const [pushBusy, setPushBusy] = useState(false)
  const [pushNote, setPushNote] = useState<string | null>(null)

  const [cal, setCal] = useState<CalendarStatus | null>(null)
  const [calBusy, setCalBusy] = useState(false)
  const [calNote, setCalNote] = useState<string | null>(null)

  const [umbrellas, setUmbrellas] = useState<CategoryDef[]>([])
  const [highlights, setHighlights] = useState<Record<string, string>>({})
  const [hlBusy, setHlBusy] = useState(false)
  const [hlNote, setHlNote] = useState<string | null>(null)

  const [tab, setTab] = useState<SettingsTab>('fields')
  // A section stays mounted (so unsaved edits survive a tab switch) but hides when its tab is off.
  const sectionCls = (id: SettingsTab) => 'rounded-2xl border border-line bg-surface-2/30 p-5' + (tab === id ? '' : ' hidden')

  useEffect(() => {
    loadConfig()
      .then((c) => {
        setLabels(c.eventFieldLabels || {})
        setHidden(new Set(c.eventFieldHidden || []))
        setDeleted(new Set(c.eventFieldDeleted || []))
        setCustomFields(c.customFields || [])
        setSigEnabled(!!c.signatureEnabled)
        setSigHtml(c.signatureHtml || '')
        setHighlights(c.sectionHighlights || {})
      })
      .catch(() => {})
    loadStructure()
      .then((s) => setUmbrellas(s.umbrellas || []))
      .catch(() => {})
    loadPush()
      .then(setPush)
      .catch(() => {})
    loadCalendarStatus()
      .then(setCal)
      .catch(() => {})
  }, [])

  // --- Google Calendar ---
  const runCalendarSync = async () => {
    setCalBusy(true)
    setCalNote('Syncing…')
    try {
      const r = await syncCalendar()
      if (r.ok) {
        const g = r.projects ?? 0
        const t = r.tasks ?? 0
        setCalNote(
          `Synced ${g} gig${g === 1 ? '' : 's'} and ${t} task${t === 1 ? '' : 's'}.` +
            (r.errors && r.errors.length ? ` Issues: ${r.errors.join('; ')}` : ''),
        )
      } else {
        setCalNote(r.error || 'Sync failed.')
      }
      loadCalendarStatus().then(setCal).catch(() => {})
    } catch (e) {
      setCalNote(String(e instanceof Error ? e.message : e))
    } finally {
      setCalBusy(false)
    }
  }

  // --- Phone notifications (ntfy push) ---
  const togglePush = async (enabled: boolean) => {
    setPushBusy(true)
    setPushNote(null)
    try {
      setPush(await savePush({ enabled }))
      setPushNote(enabled ? 'On. New alerts will go to your phone.' : 'Off.')
    } catch (e) {
      setPushNote(String(e instanceof Error ? e.message : e))
    } finally {
      setPushBusy(false)
    }
  }
  const sendTestPush = async () => {
    setPushBusy(true)
    setPushNote('Sending…')
    try {
      const r = await testPush()
      setPushNote(r.ok ? 'Test sent. Check your phone (it may take a few seconds).' : `Could not send: ${r.error || 'unknown error'}`)
    } catch (e) {
      setPushNote(String(e instanceof Error ? e.message : e))
    } finally {
      setPushBusy(false)
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

  // Questionnaire field-mapping validity: a question can map to a built-in (minus deleted), a
  // contact field, or a custom field. If its fieldKey points at something no longer offered (a
  // deleted built-in or a removed custom field), it's a broken link.
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

  // --- Stage-driven section highlighting ---
  const setHighlight = (umbrellaId: string, sectionId: string) => setHighlights((h) => ({ ...h, [umbrellaId]: sectionId }))
  const saveHighlights = async () => {
    setHlBusy(true)
    setHlNote(null)
    try {
      await saveConfig({ sectionHighlights: highlights })
      setHlNote('Saved. Open a project to see the highlighting.')
    } catch (e) {
      setHlNote(String(e instanceof Error ? e.message : e))
    } finally {
      setHlBusy(false)
    }
  }

  return (
    <div className="board-scroll min-h-0 flex-1 overflow-y-auto px-8 pb-20 pt-2">
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="flex flex-wrap gap-1.5">
          {SETTINGS_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={[
                'rounded-lg px-3.5 py-1.5 text-[12.5px] font-medium transition-colors',
                tab === t.id ? 'bg-brass text-[#ffffff]' : 'border border-line text-muted hover:border-line-strong hover:text-parchment',
              ].join(' ')}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Event fields */}
        <section className={sectionCls('fields')}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-[17px] text-parchment">Event detail fields</h2>
              <p className="mt-0.5 text-[12px] text-muted">Rename, hide, delete, or add fields. Affects every project's Event details.</p>
            </div>
            <button
              type="button"
              onClick={saveFields}
              disabled={fBusy}
              className="shrink-0 rounded-lg bg-brass px-4 py-2 text-[12.5px] font-semibold text-[#ffffff] transition-all hover:brightness-110 disabled:opacity-40"
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
                      className="shrink-0 rounded-lg border border-line px-2 py-1.5 text-faint transition-colors hover:border-[#dc2626]/60 hover:text-[#dc2626]"
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
                    className="shrink-0 rounded-lg border border-line px-2 py-1.5 text-faint transition-colors hover:border-[#dc2626]/60 hover:text-[#dc2626]"
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
        <section className={sectionCls('email')}>
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
              className="shrink-0 rounded-lg bg-brass px-4 py-2 text-[12.5px] font-semibold text-[#ffffff] transition-all hover:brightness-110 disabled:opacity-40"
            >
              {sigBusy ? 'Saving…' : 'Save signature'}
            </button>
          </div>

          <label className="mt-4 flex cursor-pointer items-center gap-2.5 text-[13px] text-parchment">
            <input
              type="checkbox"
              checked={sigEnabled}
              onChange={(e) => setSigEnabled(e.target.checked)}
              className="h-4 w-4 accent-[#1a4fd0]"
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

        {/* Phone notifications (ntfy lock-screen push) */}
        <section className={sectionCls('notifications')}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-[17px] text-parchment">Phone notifications</h2>
              <p className="mt-0.5 text-[12px] text-muted">
                Get a lock-screen alert on your iPhone when a contract is viewed or signed, an invoice is paid, or a task is due.
              </p>
            </div>
            <label className="flex shrink-0 cursor-pointer items-center gap-2.5 text-[13px] text-parchment">
              <input
                type="checkbox"
                checked={!!push?.enabled}
                disabled={pushBusy || !push}
                onChange={(e) => togglePush(e.target.checked)}
                className="h-4 w-4 accent-[#1a4fd0]"
              />
              <span>{push?.enabled ? 'On' : 'Off'}</span>
            </label>
          </div>

          <div className="mt-4 space-y-3 text-[12.5px] text-muted">
            <div>
              <p className="font-semibold text-parchment">One-time setup on your iPhone:</p>
              <ol className="mt-1.5 list-decimal space-y-1 pl-5">
                <li>Install the free <span className="text-parchment">ntfy</span> app from the App Store.</li>
                <li>In ntfy, tap + to subscribe to a topic, and paste the topic below.</li>
                <li>Allow notifications when prompted, then flip this toggle On.</li>
              </ol>
            </div>
            {push && (
              <div className="rounded-lg border border-line bg-surface px-3 py-2">
                <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Your private topic</p>
                <p className="mt-1 break-all font-mono text-[12px] text-parchment">{push.topic}</p>
                <p className="mt-1 break-all text-[11px] text-faint">Subscribe link: {push.subscribeUrl}</p>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={sendTestPush}
                disabled={pushBusy || !push}
                className="rounded-lg border border-brass-dim/60 bg-surface-3 px-3 py-1.5 text-[12px] font-semibold text-brass-bright transition-colors hover:border-brass disabled:opacity-40"
              >
                Send test alert
              </button>
              {pushNote && <span className="text-[11.5px] text-muted">{pushNote}</span>}
            </div>
            <p className="text-[11px] leading-relaxed text-faint">
              Keep this topic private: anyone who knows it can read your alerts. Alerts include client names but never dollar
              amounts. Your Mac must be running to send live "something happened" alerts; due-task alerts fire while the app is open.
            </p>
          </div>
        </section>

        {/* Google Calendar: gigs -> "Gigs", tasks -> "Work", auto + manual sync. */}
        <section className={sectionCls('calendar')}>
          <div>
            <h2 className="font-display text-[17px] text-parchment">Google Calendar</h2>
            <p className="mt-0.5 text-[12px] text-muted">
              Put your gigs on your <span className="text-parchment">Gigs</span> calendar and your tasks on your{' '}
              <span className="text-parchment">Work</span> calendar, automatically. Uses the same Google connection as your email.
            </p>
          </div>

          <div className="mt-4 space-y-3 text-[12.5px] text-muted">
            {!cal ? (
              <p className="text-faint">Checking connection…</p>
            ) : !cal.connected ? (
              <>
                <p>Not connected to Google yet.</p>
                <a
                  href="/api/gmail/auth"
                  className="inline-block rounded-lg bg-brass px-3.5 py-2 text-[12.5px] font-semibold text-[#ffffff] transition-all hover:brightness-110"
                >
                  Connect Google (Gmail + Calendar)
                </a>
              </>
            ) : !cal.hasScope ? (
              <>
                <p>
                  Your Google account is connected for email, but hasn’t granted calendar access yet. Reconnect once to allow
                  calendar syncing.
                </p>
                <a
                  href="/api/gmail/auth"
                  className="inline-block rounded-lg bg-brass px-3.5 py-2 text-[12.5px] font-semibold text-[#ffffff] transition-all hover:brightness-110"
                >
                  Reconnect to grant calendar access
                </a>
              </>
            ) : (
              <>
                <div className="space-y-1.5 rounded-lg border border-line bg-surface px-3 py-2.5">
                  <CalRow label={`"${cal.gigsName}" calendar (gigs)`} ok={cal.gigsCalendar} />
                  <CalRow label={`"${cal.workName}" calendar (tasks)`} ok={cal.workCalendar} />
                </div>
                {(!cal.gigsCalendar || !cal.workCalendar) && (
                  <p className="text-[11.5px] text-[#2563eb]">
                    Create the missing calendar in Google Calendar named exactly “{!cal.gigsCalendar ? cal.gigsName : cal.workName}”,
                    then Sync.
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={runCalendarSync}
                    disabled={calBusy}
                    className="rounded-lg border border-brass-dim/60 bg-surface-3 px-3 py-1.5 text-[12px] font-semibold text-brass-bright transition-colors hover:border-brass disabled:opacity-40"
                  >
                    {calBusy ? 'Syncing…' : 'Sync now'}
                  </button>
                  {calNote && <span className="text-[11.5px] text-muted">{calNote}</span>}
                </div>
                <p className="text-[11px] leading-relaxed text-faint">
                  Gigs and tasks also sync automatically as you add or edit them. A gig that isn’t booked yet shows as “Inquiry: …”.
                  Tasks with a time get 10-minute and at-time reminders; tasks with no time are all-day. Your in-app due reminders
                  stay based on the date either way.
                </p>
              </>
            )}
            {cal?.error && <p className="text-[11.5px] text-[#dc2626]">{cal.error}</p>}
          </div>
        </section>

        {/* Stage highlighting: which phase of the Communication timeline lights up per category */}
        <section className={sectionCls('highlighting')}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-[17px] text-parchment">Stage highlighting</h2>
              <p className="mt-0.5 text-[12px] text-muted">
                For each pipeline category, pick which phase of the project page's Communication timeline is highlighted
                while a project sits in it.
              </p>
            </div>
            <button
              type="button"
              onClick={saveHighlights}
              disabled={hlBusy}
              className="shrink-0 rounded-lg bg-brass px-4 py-2 text-[12.5px] font-semibold text-[#ffffff] transition-all hover:brightness-110 disabled:opacity-40"
            >
              {hlBusy ? 'Saving…' : 'Save highlights'}
            </button>
          </div>

          <div className="mt-4 space-y-1.5">
            {umbrellas.map((u) => (
              <div key={u.id} className="flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2">
                <span className="flex-1 text-[13px] text-parchment">{u.label}</span>
                <select
                  value={highlights[u.id] ?? defaultSectionFor(u)}
                  onChange={(e) => setHighlight(u.id, e.target.value)}
                  className="rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 text-[12.5px] text-parchment focus:border-brass-dim focus:outline-none"
                >
                  {SECTION_OPTIONS.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
            ))}
            {umbrellas.length === 0 && <p className="text-[11.5px] text-faint">Loading pipeline categories…</p>}
          </div>
          {hlNote && <p className="mt-2 text-[11.5px] text-muted">{hlNote}</p>}
        </section>
      </div>
    </div>
  )
}
