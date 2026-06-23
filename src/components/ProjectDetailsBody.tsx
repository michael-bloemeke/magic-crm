import { useEffect, useState, type ReactNode } from 'react'
import { type Project } from '../pipeline'
import { deleteProjectEmail, loadProjectEmails, TIP_METHODS, type Contact, type Payment, type ProjectEmail, type ProjectLinks, type Task } from '../api'
import { TaskRow } from './TaskRow'
import { EditableField } from './EditableField'
import { PaymentsEditor } from './PaymentsEditor'
import { ContactCard } from './ContactCard'
import { ProjectNotesPanel } from './ProjectNotesPanel'
import { EmailBuilderCard } from './EmailBuilderCard'
import { InvoiceCard } from './InvoiceCard'
import { ContractCard } from './ContractCard'
import { QuestionnaireCard } from './QuestionnaireCard'
import { contactsForProject } from '../contacts'
import { evalNumberFormula } from '../calc'

// The working details for a project, grouped into stages: the contacts/tasks/
// conversations sit at the top, then Event details, Booking, Booked, and Post show.
// The fuller description, notes, and activity log live in a side panel on the full
// project view (NotesDrawer); the narrow side pane renders them inline instead.
// Shared by the side pane (ProjectDetail) and the full project view (ProjectView).

type Props = {
  project: Project
  tasks: Task[]
  contacts: Contact[]
  links: ProjectLinks
  onSaveField: (field: string, value: string) => void
  onAddTask: (title: string, dueDate: string) => void
  onToggleTask: (id: string, done: boolean) => void
  onDeleteTask: (id: string) => void
  onPaymentsChange?: (payments: Payment[]) => void
  // Called after the questionnaire auto-fills project fields, so the view reloads to show them.
  onProjectChanged?: () => void
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
  onPaymentsChange,
  onProjectChanged,
  onOpenContact,
  onUnlinkContact,
  onAddContact,
  fullView,
  tasksAside,
}: Props) {
  const save = (field: string) => (value: string) => onSaveField(field, value)
  const linkedContacts = contactsForProject(project, contacts, links)
  const recipientEmails = Array.from(
    new Set(linkedContacts.flatMap((c) => c.emails || []).map((e) => e.trim()).filter(Boolean)),
  )
  const fieldGrid = fullView ? 'grid grid-cols-2 gap-x-7 gap-y-5 lg:grid-cols-3' : 'grid grid-cols-2 gap-x-5 gap-y-3'
  const cardGrid = fullView ? 'grid grid-cols-1 gap-2 sm:grid-cols-2' : 'grid grid-cols-1 gap-2'
  // Two-up split (primary content left, side cards right) on the wide full view;
  // stacked in the narrow side pane.
  const splitGrid = fullView ? 'grid grid-cols-1 gap-5 lg:grid-cols-2' : 'space-y-5'

  // Per-project emails (post-call, follow-ups, shark, break-up, check-ins,
  // thank-you) are loaded once here and handed to each builder card by kind. The
  // follow-up / check-in slots are explicit index lists so any added one can be
  // removed (the slot index is the storage key; titles render by position).
  const [emails, setEmails] = useState<ProjectEmail[]>([])
  const [followupSlots, setFollowupSlots] = useState<number[]>([1])
  const [checkinSlots, setCheckinSlots] = useState<number[]>([1])

  useEffect(() => {
    let live = true
    loadProjectEmails()
      .then((all) => {
        if (!live) return
        const mine = all.filter((e) => e.projectId === project.id)
        setEmails(mine)
        setFollowupSlots(buildSlots(mine, 'followup'))
        setCheckinSlots(buildSlots(mine, 'checkin'))
      })
      .catch(() => {
        if (live) setEmails([])
      })
    return () => {
      live = false
    }
  }, [project.id])

  const emailFor = (kind: string) => emails.find((e) => e.kind === kind) ?? null
  const upsertEmail = (e: ProjectEmail) => setEmails((prev) => [...prev.filter((x) => x.id !== e.id), e])

  const addSlot = (setSlots: React.Dispatch<React.SetStateAction<number[]>>) =>
    setSlots((s) => [...s, (s.length ? Math.max(...s) : 0) + 1])

  const removeSlot = (prefix: string, n: number, setSlots: React.Dispatch<React.SetStateAction<number[]>>) => {
    const e = emailFor(`${prefix}-${n}`)
    if (e) {
      deleteProjectEmail(e.id).catch(() => {})
      setEmails((prev) => prev.filter((x) => x.id !== e.id))
    }
    setSlots((s) => s.filter((x) => x !== n))
  }

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
          <ProjectTasks tasks={tasks} onAdd={onAddTask} onToggle={onToggleTask} onDelete={onDeleteTask} />
          {tasksAside}
        </div>
      ) : (
        <ProjectTasks tasks={tasks} onAdd={onAddTask} onToggle={onToggleTask} onDelete={onDeleteTask} />
      )}

      {/* Event details: the blurb up top (the most immediate detail), then the
          structured fields grouped when / scope / where / show / source. */}
      <DetailSection title="Event details">
        <div className="mb-5">
          <EditableField label="Description" placeholder="A sentence or two about the event…" value={project.eventSummary} onSave={save('eventSummary')} multiline />
        </div>
        <div className={fieldGrid}>
          <EditableField label="Event date" type="date" value={project.eventDate} onSave={save('eventDate')} />
          <EditableField label="Event start" value={project.eventStartTime} onSave={save('eventStartTime')} />
          <EditableField label="Show start" value={project.showStartTime} onSave={save('showStartTime')} />
          <EditableField label="Quote" prefix="$" value={project.totalFee == null ? '' : String(project.totalFee)} onSave={save('totalFee')} />
          <EditableField label="Guest Count" multiline value={project.numberOfGuests} onSave={save('numberOfGuests')} />
          <EditableField label="Guest ages" multiline value={project.ageOfGuests} onSave={save('ageOfGuests')} />
          <EditableField label="Location" multiline value={project.eventLocation} onSave={save('eventLocation')} />
          <EditableField label="Venue type" multiline value={project.venueType} onSave={save('venueType')} />
          <EditableField label="Indoors / Outdoors" multiline value={project.indoorsOrOutdoors} onSave={save('indoorsOrOutdoors')} />
          <EditableField label="Performance" multiline value={project.performanceStyle} onSave={save('performanceStyle')} />
          <EditableField label="AV" multiline value={project.av} onSave={save('av')} />
          <EditableField label="VIPs" multiline value={project.vips} onSave={save('vips')} />
          <EditableField label="Booking source" multiline value={project.bookingSource} onSave={save('bookingSource')} />
        </div>
      </DetailSection>

      {/* Post Call: the nurture sequence after the sales call. */}
      <DetailSection title="Post Call">
        <div className={cardGrid}>
          <EmailBuilderCard
            project={project} recipientEmails={recipientEmails} onSaved={upsertEmail}
            kind="postcall" title="Post-call email" defaultSubject="Magician Information - Please Reply"
            templateHint={/post-call/i} email={emailFor('postcall')}
          />
          {followupSlots.map((n, i) => (
            <EmailBuilderCard
              key={`followup-${n}`}
              project={project} recipientEmails={recipientEmails} onSaved={upsertEmail}
              kind={`followup-${n}`} title={`Follow-up #${i + 1}`} defaultSubject="Checking In"
              templateHint={/follow-up/i} email={emailFor(`followup-${n}`)}
              onDelete={followupSlots.length > 1 ? () => removeSlot('followup', n, setFollowupSlots) : undefined}
            />
          ))}
          <EmailBuilderCard
            project={project} recipientEmails={recipientEmails} onSaved={upsertEmail}
            kind="shark" title="Shark email" defaultSubject="Checking In" email={emailFor('shark')}
          />
          <EmailBuilderCard
            project={project} recipientEmails={recipientEmails} onSaved={upsertEmail}
            kind="breakup" title="Break-up email" defaultSubject="Following Up" email={emailFor('breakup')}
          />
        </div>
        <AddEmailButton label="Add follow-up" onClick={() => addSlot(setFollowupSlots)} />
      </DetailSection>

      {/* Booking: the money in (kept to a column), plus the paperwork generators. */}
      <DetailSection title="Booking">
        <div className={splitGrid}>
          <PaymentsEditor projectId={project.id} onChange={onPaymentsChange} />
          <div className="space-y-2">
            <InvoiceCard project={project} />
            <ContractCard project={project} />
            <QuestionnaireCard key={project.id} project={project} onApplied={onProjectChanged} />
          </div>
        </div>
      </DetailSection>

      {/* Booked: the show paperwork once it's locked in, plus the check-in emails. */}
      <DetailSection title="Booked">
        <div className={cardGrid}>
          <ComingSoon title="Rider" desc="Generate or attach the technical / hospitality rider." />
          <ComingSoon title="Intro" desc="Generate or attach the emcee introduction." />
          {checkinSlots.map((n, i) => (
            <EmailBuilderCard
              key={`checkin-${n}`}
              project={project} recipientEmails={recipientEmails} onSaved={upsertEmail}
              kind={`checkin-${n}`} title={`Check-in #${i + 1}`} defaultSubject="Checking In"
              templateHint={/check-in/i} email={emailFor(`checkin-${n}`)}
              onDelete={checkinSlots.length > 1 ? () => removeSlot('checkin', n, setCheckinSlots) : undefined}
            />
          ))}
        </div>
        <AddEmailButton label="Add check-in" onClick={() => addSlot(setCheckinSlots)} />
      </DetailSection>

      {/* Post show: the wrap-up numbers and the thank-you note. */}
      <DetailSection title="Post show">
        <div className={splitGrid}>
          <div className="grid grid-cols-2 gap-x-7 gap-y-5">
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
          <EmailBuilderCard
            project={project} recipientEmails={recipientEmails} onSaved={upsertEmail}
            kind="thankyou" title="Thank-you email" defaultSubject="Thank you!"
            templateHint={/thank/i} email={emailFor('thankyou')}
          />
        </div>
      </DetailSection>

      {/* Narrow side pane: no slide-in panel, so show description/notes/log inline. */}
      {!fullView && <ProjectNotesPanel project={project} onSaveField={onSaveField} />}
    </div>
  )
}

// A defined section: a bordered card with a tinted header band carrying the label,
// so the groups read as distinct, organized blocks (not just a faint divider).
function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-line-strong bg-surface-2/30 shadow-[0_1px_2px_rgba(0,0,0,0.25)]">
      <div className="border-b border-line-strong bg-surface-3/40 px-5 py-2.5">
        <h3 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-brass">
          <span className="h-3 w-[3px] rounded-full bg-brass" />
          {title}
        </h3>
      </div>
      <div className="p-5">{children}</div>
    </section>
  )
}

// The slot indices to show for a group like "followup" / "checkin": always the
// default first slot, plus any index that already has a saved email (so deleting a
// middle slot leaves a stable gap in the keys but the titles still render in order).
function buildSlots(emails: ProjectEmail[], prefix: string): number[] {
  const set = new Set<number>([1])
  for (const e of emails) {
    const match = e.kind.match(new RegExp(`^${prefix}-(\\d+)$`))
    if (match) set.add(Number(match[1]))
  }
  return Array.from(set).sort((a, b) => a - b)
}

// The dashed "+ Add follow-up / Add check-in" button that appends another email slot.
function AddEmailButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-dashed border-line px-3 py-1.5 text-[12px] font-medium text-muted transition-colors hover:border-brass-dim hover:text-brass-bright"
    >
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 5v14M5 12h14" />
      </svg>
      {label}
    </button>
  )
}

// A placeholder card for a feature that's wired up but not built yet.
function ComingSoon({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-dashed border-line bg-surface-2/30 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-muted">{title}</p>
        <p className="mt-0.5 text-[11.5px] leading-relaxed text-faint">{desc}</p>
      </div>
      <span className="mt-0.5 shrink-0 rounded-full border border-line px-2 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.12em] text-faint">
        Coming soon
      </span>
    </div>
  )
}

const byDueAsc = (a: Task, b: Task) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999')

function ProjectTasks({
  tasks,
  onAdd,
  onToggle,
  onDelete,
}: {
  tasks: Task[]
  onAdd: (title: string, dueDate: string) => void
  onToggle: (id: string, done: boolean) => void
  onDelete: (id: string) => void
}) {
  const [title, setTitle] = useState('')
  const [due, setDue] = useState('')

  const active = tasks.filter((t) => !t.done).sort(byDueAsc)
  const done = tasks.filter((t) => t.done).sort(byDueAsc)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const t = title.trim()
    if (!t) return
    onAdd(t, due)
    setTitle('')
    setDue('')
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
            <TaskRow key={t.id} task={t} onToggle={(d) => onToggle(t.id, d)} onDelete={() => onDelete(t.id)} />
          ))}
          {done.length > 0 && (
            <div className="space-y-2 pt-1 opacity-70">
              {done.map((t) => (
                <TaskRow key={t.id} task={t} onToggle={(d) => onToggle(t.id, d)} onDelete={() => onDelete(t.id)} />
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
