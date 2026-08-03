import { useEffect, useState, type ReactNode } from 'react'
import { type Project, type PipelineStructure, type CategoryDef } from '../pipeline'
import { loadConfig, loadCustomValues, loadInquiryForm, loadStructure, saveCustomValue, TIP_METHODS, type Contact, type InquiryForm, type Payment, type ProjectLinks, type Task } from '../api'
import { type CustomField } from '../eventFields'
import { to12h } from '../format'
import { TaskRow } from './TaskRow'
import { EditableField } from './EditableField'
import { PaymentsEditor } from './PaymentsEditor'
import { BookingCard } from './BookingCard'
import { ContactCard } from './ContactCard'
import { ProjectNotesPanel } from './ProjectNotesPanel'
import { InitialInquiryModal } from './InitialInquiryModal'
import { CalendarInviteCard } from './CalendarInviteCard'
import { contactsForProject } from '../contacts'
import { evalNumberFormula } from '../calc'

// The working details for a project. Contacts, tasks and the Gmail conversation list sit at the top,
// then three sections: Event details, Booking, Post show.
//
// (A "Communication" section with a per-step sent/unsent timeline lived here briefly and was removed
// 2026-08-02. The Gmail conversation list at the top is now the only record of client contact.)
//
// The fuller description, notes, and activity log live in a side panel on the full
// project view (NotesDrawer); the narrow side pane renders them inline instead.
// Shared by the side pane (ProjectDetail) and the full project view (ProjectView).

type Props = {
  project: Project
  tasks: Task[]
  contacts: Contact[]
  links: ProjectLinks
  onSaveField: (field: string, value: string) => void
  onAddTask: (title: string, dueDate: string, dueTime: string) => void
  onToggleTask: (id: string, done: boolean) => void
  onDeleteTask: (id: string) => void
  onEditTask: (id: string, patch: { title: string; dueDate: string; dueTime: string }) => void
  onPaymentsChange?: (payments: Payment[]) => void
  onOpenContact: (c: Contact) => void
  onUnlinkContact: (c: Contact) => void
  onAddContact: () => void
  // Full project view: use the wider multi-column layout, render content beside
  // Tasks (the "recent conversations" box), and keep the description/notes/activity
  // in the side panel. The narrow side pane leaves this off and shows them inline.
  fullView?: boolean
  tasksAside?: ReactNode
}

export function ProjectDetailsBody({
  project,
  tasks,
  contacts,
  links,
  onSaveField,
  onAddTask,
  onToggleTask,
  onDeleteTask,
  onEditTask,
  onPaymentsChange,
  onOpenContact,
  onUnlinkContact,
  onAddContact,
  fullView,
  tasksAside,
}: Props) {
  const save = (field: string) => (value: string) => onSaveField(field, value)
  const linkedContacts = contactsForProject(project, contacts, links)
  // Event-field label overrides + hidden/deleted fields + custom fields, edited on the Settings page.
  const [eventLabels, setEventLabels] = useState<Record<string, string>>({})
  const [eventHidden, setEventHidden] = useState<Set<string>>(new Set())
  const [eventDeleted, setEventDeleted] = useState<Set<string>>(new Set())
  const [customFields, setCustomFields] = useState<CustomField[]>([])
  // Stage-driven section highlighting: the pipeline structure (to find the project's umbrella) and
  // the umbrella -> section overrides from Settings.
  const [structure, setStructure] = useState<PipelineStructure | null>(null)
  const [sectionHighlights, setSectionHighlights] = useState<Record<string, string>>({})
  useEffect(() => {
    loadConfig()
      .then((c) => {
        setEventLabels(c.eventFieldLabels || {})
        setEventHidden(new Set(c.eventFieldHidden || []))
        setEventDeleted(new Set(c.eventFieldDeleted || []))
        setCustomFields(c.customFields || [])
        setSectionHighlights(c.sectionHighlights || {})
      })
      .catch(() => {})
    loadStructure().then(setStructure).catch(() => {})
  }, [])
  const lbl = (id: string, def: string) => eventLabels[id] || def
  // A field shows unless it's hidden or (for the display-only built-ins) deleted in Settings.
  const shown = (id: string) => !eventHidden.has(id) && !eventDeleted.has(id)

  // Per-project values for the custom fields, loaded once per project and edited inline.
  const [customVals, setCustomVals] = useState<Record<string, string>>({})
  useEffect(() => {
    let live = true
    loadCustomValues(project.id)
      .then((v) => live && setCustomVals(v))
      .catch(() => live && setCustomVals({}))
    return () => {
      live = false
    }
  }, [project.id])
  const saveCustom = (fieldId: string) => (value: string) => {
    setCustomVals((v) => ({ ...v, [fieldId]: value }))
    saveCustomValue(project.id, fieldId, value).catch(() => {})
  }
  // Event details is the reference Michael checks before anything else, so a blank there is treated
  // as a problem: the section goes red and names what's missing until every visible field is filled.
  // "Visible" is the lever. A field that genuinely never applies can be hidden in Settings, or
  // answered in the field itself ("none", "n/a"), which clears the flag.
  const eventValues: Record<string, string> = {
    eventSummary: project.eventSummary,
    eventDate: project.eventDate,
    leadDate: project.leadDate,
    arrivalTime: project.arrivalTime,
    eventStartTime: project.eventStartTime,
    showStartTime: project.showStartTime,
    totalFee: project.totalFee == null ? '' : String(project.totalFee),
    numberOfGuests: project.numberOfGuests,
    ageOfGuests: project.ageOfGuests,
    eventLocation: project.eventLocation,
    venueType: project.venueType,
    indoorsOrOutdoors: project.indoorsOrOutdoors,
    performanceStyle: project.performanceStyle,
    av: project.av,
    vips: project.vips,
    bookingSource: project.bookingSource,
  }
  // Lead date has no Settings toggle, so it always counts.
  const required = (id: string) => id === 'leadDate' || shown(id)
  const miss = (id: string) => required(id) && !(eventValues[id] ?? '').trim()
  const missingLabels = [
    ...Object.keys(eventValues).filter(miss).map((id) => lbl(id, DEFAULT_EVENT_LABELS[id] ?? id)),
    ...customFields.filter((f) => !(customVals[f.id] || '').trim()).map((f) => f.label),
  ]
  const missingCount = missingLabels.length
  const missingNote = missingCount ? `Missing: ${missingLabels.join(', ')}` : ''

  const recipientEmails = Array.from(
    new Set(linkedContacts.flatMap((c) => c.emails || []).map((e) => e.trim()).filter(Boolean)),
  )
  const fieldGrid = fullView ? 'grid grid-cols-2 gap-x-7 gap-y-5 lg:grid-cols-3' : 'grid grid-cols-2 gap-x-5 gap-y-3'
  // Two-up split (primary content left, side cards right) on the wide full view;
  // stacked in the narrow side pane.
  const splitGrid = fullView ? 'grid grid-cols-1 gap-5 lg:grid-cols-2' : 'space-y-5'

  // The original website inquiry form for this project (if it came from the site contact form).
  // Shown in a dialog off the Communication header, together with the client's first message.
  const [inquiryForm, setInquiryForm] = useState<InquiryForm | null>(null)
  const [inquiryOpen, setInquiryOpen] = useState(false)
  const hasInquiry = !!(inquiryForm && inquiryForm.fields.length > 0) || !!project.initialInquiry.trim()
  useEffect(() => {
    let live = true
    loadInquiryForm(project.id)
      .then((f) => live && setInquiryForm(f))
      .catch(() => live && setInquiryForm(null))
    return () => {
      live = false
    }
  }, [project.id])

  // Which workflow section the project's current stage highlights (and auto-expands). The umbrella's
  // built-in default (Inquiry/Post Call/Booked/Post show) is overridable per umbrella in Settings.
  const currentUmbrella: CategoryDef | null = structure
    ? structure.umbrellas.find((u) => (u.stages || []).some((s) => s.id === project.stageId)) || null
    : null
  const defaultSectionFor = (u: CategoryDef | null): string | null => {
    if (!u) return null
    if (u.role === 'first') return 'inquiry'
    if (u.role === 'booked') return 'booked'
    if (u.role === 'postshow') return 'postshow'
    return 'postcall'
  }
  const hlOverride = currentUmbrella ? sectionHighlights[currentUmbrella.id] : undefined
  const highlightedSection = hlOverride === 'none' ? null : hlOverride || defaultSectionFor(currentUmbrella)

  // All collapsible sections start OPEN. Nothing auto-collapses based on the project's stage; the
  // stage instead HIGHLIGHTS the matching group inside Communication, so the timeline shows where
  // the project currently sits. Sections can still be collapsed by hand, and those manual toggles
  // persist until you switch projects.
  const [openSections, setOpenSections] = useState<Set<string>>(() => new Set(['communication', 'postshow']))
  useEffect(() => {
    setOpenSections(new Set(['communication', 'postshow']))
  }, [project.id])
  const toggleSection = (id: string) =>
    setOpenSections((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const isOpen = (id: string) => openSections.has(id)



  return (
    <div className="space-y-6">
      {/* Top: contacts, tasks, conversations — left as-is, no section rule. */}
      <section>
        <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-brass-dim">
          {linkedContacts.length === 1 ? 'Contact' : 'Contacts'}
        </h3>
        {linkedContacts.length > 0 && (
          <div className={fullView ? 'mb-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3' : 'mb-2 flex flex-col gap-1.5'}>
            {linkedContacts.map((c) => (
              <ContactCard key={c.id} contact={c} onOpen={onOpenContact} onRemove={onUnlinkContact} />
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={onAddContact}
          className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-line px-3 py-1.5 text-[12px] font-medium text-muted transition-colors hover:border-brass-dim hover:text-brass-bright"
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          Add contact
        </button>
      </section>

      {tasksAside ? (
        // Full view: Tasks on the left, the conversations box on the right.
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
          <ProjectTasks tasks={tasks} onAdd={onAddTask} onToggle={onToggleTask} onDelete={onDeleteTask} onEdit={onEditTask} />
          {tasksAside}
        </div>
      ) : (
        <ProjectTasks tasks={tasks} onAdd={onAddTask} onToggle={onToggleTask} onDelete={onDeleteTask} onEdit={onEditTask} />
      )}

      {/* Event details: the blurb up top (the most immediate detail), then the structured fields
          grouped when / scope / where / show / source. This is the reference Michael checks before
          anything else, so any blank turns the whole section red until it's filled in.
          The "Initial inquiry" button moved here when the Communication section was removed; it's
          how the client first got in touch, which belongs with the event facts. */}
      <DetailSection title="Event details" alert={missingCount > 0} alertNote={missingNote}>
        <button
          type="button"
          onClick={() => setInquiryOpen(true)}
          title="See the client's first message and their website form"
          className={[
            'mb-4 inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11.5px] font-medium transition-colors',
            hasInquiry
              ? 'border-brass-dim/50 text-brass-bright hover:border-brass'
              : 'border-line text-faint hover:border-line-strong hover:text-parchment',
          ].join(' ')}
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2.5" y="5" width="19" height="14" rx="2" />
            <path d="m3 7 9 6 9-6" />
          </svg>
          Initial inquiry
        </button>
        {shown('eventSummary') && (
          <div className="mb-5">
            <EditableField label={lbl('eventSummary', 'Description')} placeholder="A sentence or two about the event…" value={project.eventSummary} onSave={save('eventSummary')} multiline missing={miss('eventSummary')} />
          </div>
        )}
        <div className={fieldGrid}>
          {shown('eventDate') && <EditableField label={lbl('eventDate', 'Event date')} type="date" value={project.eventDate} onSave={save('eventDate')} missing={miss('eventDate')} />}
          <EditableField label="Lead date" type="date" value={project.leadDate} onSave={save('leadDate')} missing={miss('leadDate')} />
          {shown('arrivalTime') && <EditableField label={lbl('arrivalTime', 'Arrival time')} value={project.arrivalTime} onSave={save('arrivalTime')} format={to12h} missing={miss('arrivalTime')} />}
          {shown('eventStartTime') && <EditableField label={lbl('eventStartTime', 'Event start')} value={project.eventStartTime} onSave={save('eventStartTime')} format={to12h} missing={miss('eventStartTime')} />}
          {shown('showStartTime') && <EditableField label={lbl('showStartTime', 'Show start')} value={project.showStartTime} onSave={save('showStartTime')} format={to12h} missing={miss('showStartTime')} />}
          {shown('totalFee') && <EditableField label={lbl('totalFee', 'Quote')} prefix="$" value={project.totalFee == null ? '' : String(project.totalFee)} onSave={save('totalFee')} missing={miss('totalFee')} />}
          {shown('numberOfGuests') && <EditableField label={lbl('numberOfGuests', 'Guest Count')} multiline value={project.numberOfGuests} onSave={save('numberOfGuests')} missing={miss('numberOfGuests')} />}
          {shown('ageOfGuests') && <EditableField label={lbl('ageOfGuests', 'Guest ages')} multiline value={project.ageOfGuests} onSave={save('ageOfGuests')} missing={miss('ageOfGuests')} />}
          {shown('eventLocation') && <EditableField label={lbl('eventLocation', 'Location')} multiline value={project.eventLocation} onSave={save('eventLocation')} missing={miss('eventLocation')} />}
          {shown('venueType') && <EditableField label={lbl('venueType', 'Venue type')} multiline value={project.venueType} onSave={save('venueType')} missing={miss('venueType')} />}
          {shown('indoorsOrOutdoors') && <EditableField label={lbl('indoorsOrOutdoors', 'Indoors / Outdoors')} multiline value={project.indoorsOrOutdoors} onSave={save('indoorsOrOutdoors')} missing={miss('indoorsOrOutdoors')} />}
          {shown('performanceStyle') && <EditableField label={lbl('performanceStyle', 'Performance')} multiline value={project.performanceStyle} onSave={save('performanceStyle')} missing={miss('performanceStyle')} />}
          {shown('av') && <EditableField label={lbl('av', 'AV')} multiline value={project.av} onSave={save('av')} missing={miss('av')} />}
          {shown('vips') && <EditableField label={lbl('vips', 'VIPs')} multiline value={project.vips} onSave={save('vips')} missing={miss('vips')} />}
          {shown('bookingSource') && <EditableField label={lbl('bookingSource', 'Booking source')} multiline value={project.bookingSource} onSave={save('bookingSource')} missing={miss('bookingSource')} />}
          {/* User-defined custom fields (added in Settings). Values are stored CRM-side per project. */}
          {customFields.map((f) => (
            <EditableField key={f.id} label={f.label} multiline value={customVals[f.id] || ''} onSave={saveCustom(f.id)} missing={!(customVals[f.id] || '').trim()} />
          ))}
        </div>
      </DetailSection>

      {/* Booking: the money and the one sequence that matters. Michael cut this down on 2026-08-02
          from four cards (Recipients / Contract / Questionnaire / Invoice) to one, because at any
          moment only one of them was the next thing to actually do. BookingCard shows that step. */}
      <DetailSection title="Booking">
        <div className={splitGrid}>
          <div className="space-y-2">
            <PaymentsEditor projectId={project.id} onChange={onPaymentsChange} />
          </div>
          <div className="space-y-2">
            <BookingCard project={project} onSaveField={onSaveField} />
            <CalendarInviteCard project={project} recipientEmails={recipientEmails} />
          </div>
        </div>
      </DetailSection>

      {/* Post show: the wrap-up numbers. The thank-you note itself lives in the Communication
          timeline with every other client-facing step. */}
      <DetailSection title="Post Show" collapsible open={isOpen('postshow')} onToggle={() => toggleSection('postshow')} highlight={highlightedSection === 'postshow'}>
        <div className={fieldGrid}>
          <div>
            <EditableField label="Tips" prefix="$" value={project.tips == null ? '' : String(project.tips)} onSave={save('tips')} format={evalNumberFormula} />
            <div className="mt-1 flex items-center gap-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">via</span>
              <select
                value={project.tipsMethod || 'Cash'}
                onChange={(e) => onSaveField('tipsMethod', e.target.value)}
                className="rounded-md border border-line bg-surface-2 px-1.5 py-0.5 text-[12px] text-parchment focus:border-brass-dim focus:outline-none"
              >
                {TIP_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <EditableField label="Mileage (round-trip mi)" value={project.mileage == null ? '' : String(project.mileage)} onSave={save('mileage')} format={evalNumberFormula} />
        </div>
      </DetailSection>

      {/* Narrow side pane: no slide-in panel, so show description/notes/log inline. */}
      {!fullView && <ProjectNotesPanel project={project} onSaveField={onSaveField} />}

      <InitialInquiryModal
        open={inquiryOpen}
        project={project}
        form={inquiryForm}
        onClose={() => setInquiryOpen(false)}
        onSaveField={onSaveField}
      />
    </div>
  )
}

// A defined section: a bordered card with a tinted header band carrying the label. Optionally
// collapsible (clickable header + chevron) and/or highlighted (brass ring + tinted header) when the
// project's current stage maps to it.
function DetailSection({
  title,
  children,
  collapsible = false,
  open = true,
  onToggle,
  highlight = false,
  alert = false,
  alertNote,
}: {
  title: string
  children: ReactNode
  collapsible?: boolean
  open?: boolean
  onToggle?: () => void
  highlight?: boolean
  // Something in this section needs attention (currently: Event details has blanks). Outranks
  // `highlight` so a stage highlight can never mask a gap.
  alert?: boolean
  alertNote?: string
}) {
  const shown = !collapsible || open
  // The header rounds its own top corners rather than the section clipping them, so a popover
  // inside a section (the Communication rows' date pickers) can overhang the card edge.
  const header = (
    <div
      className={[
        'flex items-center justify-between gap-2 px-5 py-2.5',
        // Collapsed, the header IS the card, so it rounds all four corners.
        shown ? 'rounded-t-2xl border-b border-line-strong' : 'rounded-2xl',
        alert ? '' : highlight ? 'bg-brass/12' : 'bg-surface-4/60',
      ].join(' ')}
      style={alert ? { backgroundColor: 'color-mix(in oklab, #ef4444 12%, transparent)' } : undefined}
    >
      <h3
        className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.2em]"
        style={{ color: alert ? '#ef4444' : undefined }}
      >
        <span className="h-3 w-[3px] rounded-full" style={{ backgroundColor: alert ? '#ef4444' : 'var(--color-brass)' }} />
        <span className={alert ? '' : 'text-brass'}>{title}</span>
      </h3>
      <div className="flex items-center gap-2.5">
        {alert && alertNote && (
          <span className="truncate text-[10.5px] font-medium normal-case tracking-normal" style={{ color: '#ef4444' }} title={alertNote}>
            {alertNote}
          </span>
        )}
        {collapsible && (
          <svg
            className={['h-4 w-4 text-muted transition-transform', open ? 'rotate-180' : ''].join(' ')}
            viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        )}
      </div>
    </div>
  )
  return (
    <section
      className={[
        'rounded-2xl border bg-surface-2/70 shadow-[0_4px_16px_-4px_rgba(0,0,0,0.4)] transition-colors',
        alert ? '' : highlight ? 'border-brass-dim ring-1 ring-brass-dim/40' : 'border-line-strong',
      ].join(' ')}
      style={alert ? { borderColor: 'color-mix(in oklab, #ef4444 55%, transparent)', boxShadow: '0 0 0 1px color-mix(in oklab, #ef4444 25%, transparent)' } : undefined}
    >
      {collapsible ? (
        <button type="button" onClick={onToggle} className="block w-full cursor-pointer text-left">
          {header}
        </button>
      ) : (
        header
      )}
      {shown && <div className="p-5">{children}</div>}
    </section>
  )
}

// Built-in labels for the Event details fields, used when naming what's missing. Settings can
// rename any of them, so this is only the fallback.
const DEFAULT_EVENT_LABELS: Record<string, string> = {
  eventSummary: 'Description',
  eventDate: 'Event date',
  leadDate: 'Lead date',
  arrivalTime: 'Arrival time',
  eventStartTime: 'Event start',
  showStartTime: 'Show start',
  totalFee: 'Quote',
  numberOfGuests: 'Guest Count',
  ageOfGuests: 'Guest ages',
  eventLocation: 'Location',
  venueType: 'Venue type',
  indoorsOrOutdoors: 'Indoors / Outdoors',
  performanceStyle: 'Performance',
  av: 'AV',
  vips: 'VIPs',
  bookingSource: 'Booking source',
}

const byDueAsc = (a: Task, b: Task) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999')

function ProjectTasks({
  tasks,
  onAdd,
  onToggle,
  onDelete,
  onEdit,
}: {
  tasks: Task[]
  onAdd: (title: string, dueDate: string, dueTime: string) => void
  onToggle: (id: string, done: boolean) => void
  onDelete: (id: string) => void
  onEdit: (id: string, patch: { title: string; dueDate: string; dueTime: string }) => void
}) {
  const [title, setTitle] = useState('')
  const [due, setDue] = useState('')
  const [time, setTime] = useState('')

  const active = tasks.filter((t) => !t.done).sort(byDueAsc)
  const done = tasks.filter((t) => t.done).sort(byDueAsc)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const t = title.trim()
    if (!t) return
    onAdd(t, due, time)
    setTitle('')
    setDue('')
    setTime('')
  }

  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-brass-dim">Tasks</h3>
        {tasks.length > 0 && (
          <span
            className="inline-flex items-center justify-center rounded-full px-2 py-0.5 text-[11.5px] font-bold tabular-nums text-brass-bright"
            style={{ backgroundColor: 'color-mix(in oklab, var(--color-brass) 18%, transparent)' }}
          >
            {active.length} open
          </span>
        )}
      </div>

      {tasks.length === 0 ? (
        <p className="mb-3 text-[12px] text-faint">No tasks yet. Add one below.</p>
      ) : (
        <div className="board-scroll mb-3 max-h-[18rem] space-y-2 overflow-y-auto pr-1">
          {active.map((t) => (
            <TaskRow key={t.id} task={t} onToggle={(d) => onToggle(t.id, d)} onDelete={() => onDelete(t.id)} onEdit={(patch) => onEdit(t.id, patch)} />
          ))}
          {done.length > 0 && (
            <div className="space-y-2 pt-1 opacity-70">
              {done.map((t) => (
                <TaskRow key={t.id} task={t} onToggle={(d) => onToggle(t.id, d)} onDelete={() => onDelete(t.id)} onEdit={(patch) => onEdit(t.id, patch)} />
              ))}
            </div>
          )}
        </div>
      )}

      <form onSubmit={submit} className="flex items-center gap-2">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="New task…"
          className="min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-3 py-2 text-[13px] text-parchment placeholder:text-faint focus:border-brass-dim focus:outline-none"
        />
        <input
          type="date"
          value={due}
          onChange={(e) => setDue(e.target.value)}
          className="rounded-lg border border-line bg-surface-2 px-2 py-2 text-[12px] text-muted focus:border-brass-dim focus:outline-none"
          style={{ colorScheme: 'dark' }}
        />
        <input
          type="time"
          value={time}
          onChange={(e) => setTime(e.target.value)}
          title="Optional time (leave blank for an all-day task)"
          className="rounded-lg border border-line bg-surface-2 px-2 py-2 text-[12px] text-muted focus:border-brass-dim focus:outline-none"
          style={{ colorScheme: 'dark' }}
        />
        <button
          type="submit"
          disabled={!title.trim()}
          className="shrink-0 rounded-lg border border-brass-dim/60 bg-surface-3 px-3 py-2 text-[13px] font-semibold text-brass-bright transition-colors hover:border-brass disabled:cursor-not-allowed disabled:opacity-40"
        >
          Add
        </button>
      </form>
    </section>
  )
}
