import { useEffect, useState, type ReactNode } from 'react'
import { type Project, type PipelineStructure, type CategoryDef } from '../pipeline'
import { deleteProjectEmail, loadConfig, loadCustomValues, loadInquiryForm, loadProjectEmails, loadRecipient, loadStructure, loadTextMarkers, saveCustomValue, saveRecipient, saveTextMarker, TIP_METHODS, type Contact, type DocRecipient, type InquiryForm, type MarkerChannel, type Payment, type ProjectEmail, type ProjectLinks, type Task, type TextMarker } from '../api'
import { type CustomField } from '../eventFields'
import { to12h } from '../format'
import { TaskRow } from './TaskRow'
import { EditableField } from './EditableField'
import { PaymentsEditor } from './PaymentsEditor'
import { ContactCard } from './ContactCard'
import { ProjectNotesPanel } from './ProjectNotesPanel'
import { InitialInquiryModal } from './InitialInquiryModal'
import { CommsSlotRow } from './CommsSlotRow'
import { InvoiceCard } from './InvoiceCard'
import { ContractCard } from './ContractCard'
import { CalendarInviteCard } from './CalendarInviteCard'
import { QuestionnaireCard } from './QuestionnaireCard'
import { RecipientsCard } from './RecipientsCard'
import { contactsForProject } from '../contacts'
import { evalNumberFormula } from '../calc'

// The working details for a project. Contacts, tasks and the Gmail conversation list sit at the top,
// then four sections: Communication, Event details, Booking, Post show.
//
// Communication is the whole client relationship in one timeline: inquiry, post-call, booked and
// post-show steps stacked in order, separated by rules. Each step is a record, not a composer.
// Michael drafts in Gmail and sends from there, then marks the step here with the date it went out,
// by email or by text. Reading top to bottom shows exactly how a client has been worked, including
// the steps that were skipped.
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
  onEditTask,
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

  // Per-project emails. The slot rows no longer compose anything, so this is only here for the
  // questionnaire invite (the one place the CRM still sends its own email, since it carries a
  // generated link). The follow-up / check-in slots are explicit index lists so any added one can be
  // removed (the slot index is the storage key; titles render by position).
  const [emails, setEmails] = useState<ProjectEmail[]>([])
  const [inquiryFollowupSlots, setInquiryFollowupSlots] = useState<number[]>([1])
  const [followupSlots, setFollowupSlots] = useState<number[]>([1])
  const [checkinSlots, setCheckinSlots] = useState<number[]>([1])
  // The "sent" marks for this project's communication steps: a flag plus the date it went out, one
  // per slot per channel (email / text). No message content, just the record that it happened.
  const [markers, setMarkers] = useState<TextMarker[]>([])

  useEffect(() => {
    let live = true
    loadProjectEmails()
      .then((all) => live && setEmails(all.filter((e) => e.projectId === project.id)))
      .catch(() => live && setEmails([]))
    return () => {
      live = false
    }
  }, [project.id])

  useEffect(() => {
    let live = true
    loadTextMarkers()
      .then((all) => {
        if (!live) return
        const mine = all.filter((m) => m.projectId === project.id)
        setMarkers(mine)
        // Added follow-up / check-in slots persist by having a mark on them, so a marked slot 2 or 3
        // comes back the next time the project is opened.
        setInquiryFollowupSlots(buildSlots(mine, 'inquiry-followup'))
        setFollowupSlots(buildSlots(mine, 'followup'))
        setCheckinSlots(buildSlots(mine, 'checkin'))
      })
      .catch(() => live && setMarkers([]))
    return () => {
      live = false
    }
  }, [project.id])

  // kind -> marker, split by channel, for the rows.
  const emailMarks: Record<string, TextMarker> = {}
  const textMarks: Record<string, TextMarker> = {}
  for (const m of markers) (m.channel === 'email' ? emailMarks : textMarks)[m.kind] = m
  const setMarker = (kind: string, channel: MarkerChannel, sent: boolean, date: string) => {
    // Optimistic: reflect it immediately; an emptied mark (off + no date) drops out of the list.
    const same = (m: TextMarker) => m.kind === kind && m.channel === channel
    setMarkers((prev) => {
      const others = prev.filter((m) => !same(m))
      return !sent && !date
        ? others
        : [...others, { projectId: project.id, kind, channel, sent, date, updatedAt: new Date().toISOString() }]
    })
    saveTextMarker({ projectId: project.id, kind, channel, sent, date })
      .then((saved) =>
        setMarkers((prev) => {
          const others = prev.filter((m) => !same(m))
          return saved.sent || saved.date ? [...others, saved] : others
        }),
      )
      .catch(() => {})
  }

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

  // One row of the Communication timeline. A plain function (not a nested component) so the rows
  // keep their identity across parent re-renders and an open date popover isn't torn down.
  const slotRow = (kind: string, title: string, onDelete?: () => void) => (
    <CommsSlotRow
      key={kind}
      kind={kind}
      title={title}
      email={emailMarks[kind] ?? null}
      text={textMarks[kind] ?? null}
      onSet={setMarker}
      onDelete={onDelete}
    />
  )

  const emailFor = (kind: string) => emails.find((e) => e.kind === kind) ?? null
  const upsertEmail = (e: ProjectEmail) => setEmails((prev) => [...prev.filter((x) => x.id !== e.id), e])
  // Discard a saved draft: drop it locally and delete it (which also cleans up its uploads).
  const discardEmail = (id: string) => {
    setEmails((prev) => prev.filter((x) => x.id !== id))
    deleteProjectEmail(id).catch(() => {})
  }

  const addSlot = (setSlots: React.Dispatch<React.SetStateAction<number[]>>) =>
    setSlots((s) => [...s, (s.length ? Math.max(...s) : 0) + 1])

  // Drop an added follow-up / check-in slot. The row only offers this while nothing is marked, so
  // clearing the marks is just belt and braces against a stale row.
  const removeSlot = (prefix: string, n: number, setSlots: React.Dispatch<React.SetStateAction<number[]>>) => {
    const kind = `${prefix}-${n}`
    if (emailMarks[kind]) setMarker(kind, 'email', false, '')
    if (textMarks[kind]) setMarker(kind, 'text', false, '')
    setSlots((s) => s.filter((x) => x !== n))
  }

  // Document recipients (contract signer + invoice bill-to), defaulting to the first linked contact.
  const [recipient, setRecipient] = useState<DocRecipient | null>(null)
  useEffect(() => {
    let live = true
    loadRecipient(project.id)
      .then((r) => live && setRecipient(r))
      .catch(() => live && setRecipient(null))
    return () => {
      live = false
    }
  }, [project.id])
  const changeRecipient = (patch: Partial<DocRecipient>) => {
    setRecipient((prev) => ({
      signerId: prev?.signerId || '',
      billToId: prev?.billToId || '',
      billToName: prev?.billToName || '',
      ...patch,
    }))
    saveRecipient(project.id, patch).catch(() => {})
  }
  const signerContact = linkedContacts.find((c) => c.id === recipient?.signerId) || linkedContacts[0] || null
  const billToContact = linkedContacts.find((c) => c.id === recipient?.billToId) || linkedContacts[0] || null
  const firstProjectEmail = (project.contactEmails || '').split(/[,;]/)[0].trim()
  const signerName = signerContact?.name || project.client
  const signerEmail = signerContact?.emails?.[0] || firstProjectEmail
  const billToEmail = billToContact?.emails?.[0] || firstProjectEmail
  const billToName = (recipient?.billToName || '').trim() || billToContact?.name || project.client

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

      {/* Communication: the whole relationship as one timeline. The website form fill (the client's
          own first message) sits on top, then the four phases separated by rules. The project's
          current stage highlights its phase rather than the whole section. */}
      <DetailSection
        title="Communication"
        collapsible
        open={isOpen('communication')}
        onToggle={() => toggleSection('communication')}
      >
        {/* How it started, one click away rather than taking up room above the timeline. */}
        <button
          type="button"
          onClick={() => setInquiryOpen(true)}
          title="See the client's first message and their website form"
          className={[
            'mb-3 inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11.5px] font-medium transition-colors',
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

        <div className="divide-y divide-line">
          <CommsGroup
            label="Inquiry"
            active={highlightedSection === 'inquiry'}
            action={<AddSlotButton label="Add follow-up" onClick={() => addSlot(setInquiryFollowupSlots)} />}
          >
            {slotRow('inquiry-response', 'Inquiry response')}
            {inquiryFollowupSlots.map((n, i) =>
              slotRow(
                `inquiry-followup-${n}`,
                `Follow-up #${i + 1}`,
                inquiryFollowupSlots.length > 1 ? () => removeSlot('inquiry-followup', n, setInquiryFollowupSlots) : undefined,
              ),
            )}
            {slotRow('inquiry-shark', 'Shark email')}
            {slotRow('inquiry-breakup', 'Break-up email')}
          </CommsGroup>

          <CommsGroup
            label="Post Call"
            active={highlightedSection === 'postcall'}
            action={<AddSlotButton label="Add follow-up" onClick={() => addSlot(setFollowupSlots)} />}
          >
            {slotRow('postcall', 'Post-call email')}
            {followupSlots.map((n, i) =>
              slotRow(
                `followup-${n}`,
                `Follow-up #${i + 1}`,
                followupSlots.length > 1 ? () => removeSlot('followup', n, setFollowupSlots) : undefined,
              ),
            )}
            {slotRow('shark', 'Shark email')}
            {slotRow('breakup', 'Break-up email')}
          </CommsGroup>

          <CommsGroup
            label="Booked"
            active={highlightedSection === 'booked'}
            action={<AddSlotButton label="Add check-in" onClick={() => addSlot(setCheckinSlots)} />}
          >
            {slotRow('booking-confirmation', 'Booking confirmation')}
            {checkinSlots.map((n, i) =>
              slotRow(
                `checkin-${n}`,
                `Check-in #${i + 1}`,
                checkinSlots.length > 1 ? () => removeSlot('checkin', n, setCheckinSlots) : undefined,
              ),
            )}
          </CommsGroup>

          <CommsGroup label="Post Show" active={highlightedSection === 'postshow'}>
            {slotRow('thankyou', 'Thank-you email')}
          </CommsGroup>
        </div>
      </DetailSection>

      {/* Event details: the blurb up top (the most immediate detail), then the structured fields
          grouped when / scope / where / show / source. This is the reference Michael checks before
          anything else, so any blank turns the whole section red until it's filled in. */}
      <DetailSection title="Event details" alert={missingCount > 0} alertNote={missingNote}>
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

      {/* Booking. Two balanced columns so the section doesn't waste vertical space: the left holds
          the financial/recipient inputs (payments + who the documents go to), the right holds the
          document actions (invoice, contract, questionnaire). Recipients is the tall card, so it
          anchors the left while the three shorter action cards stack on the right. In narrow view
          splitGrid collapses to a single stack, preserving the original top-to-bottom order. */}
      <DetailSection title="Booking">
        <div className={splitGrid}>
          <div className="space-y-2">
            <PaymentsEditor projectId={project.id} onChange={onPaymentsChange} />
            <RecipientsCard project={project} contacts={linkedContacts} recipient={recipient} onChange={changeRecipient} />
          </div>
          <div className="space-y-2">
            <InvoiceCard project={project} billToName={billToName} billToEmail={billToEmail} />
            <ContractCard project={project} signerName={signerName} signerEmail={signerEmail} />
            <QuestionnaireCard
              key={project.id}
              project={project}
              onApplied={onProjectChanged}
              recipientEmails={recipientEmails}
              inviteEmail={emailFor('questionnaire-invite')}
              onEmailSaved={upsertEmail}
              onEmailDiscard={discardEmail}
            />
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

// One phase of the Communication timeline (Inquiry / Post Call / Booked / Post Show). The rail
// running behind the row dots is what makes a group read as a sequence rather than a list, and the
// label goes brass on the phase the project's current stage belongs to.
function CommsGroup({
  label,
  active,
  action,
  children,
}: {
  label: string
  active: boolean
  // The "add another slot" button, rendered below the rail so the rail ends on the last row.
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="py-3 first:pt-0 last:pb-0">
      <div className="mb-1 flex items-center gap-2">
        <h4 className={['text-[10px] font-semibold uppercase tracking-[0.16em]', active ? 'text-brass' : 'text-faint'].join(' ')}>
          {label}
        </h4>
        {active && (
          <span
            className="rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.1em] text-brass-bright"
            style={{ backgroundColor: 'color-mix(in oklab, var(--color-brass) 16%, transparent)' }}
          >
            Current stage
          </span>
        )}
      </div>
      <div className="relative">
        {/* The rail runs between the first and last dot centers, so it terminates on a node rather
            than trailing off. A single-row group hides it behind that row's dot entirely. */}
        <span aria-hidden className="absolute bottom-4 left-[3px] top-4 w-px bg-line" />
        {children}
      </div>
      {action}
    </div>
  )
}

// The slot indices to show for a group like "followup" / "checkin": always the default first slot,
// plus any index that already carries a mark (so an added slot 2 survives reopening the project).
function buildSlots(markers: TextMarker[], prefix: string): number[] {
  const set = new Set<number>([1])
  for (const m of markers) {
    const match = m.kind.match(new RegExp(`^${prefix}-(\\d+)$`))
    if (match) set.add(Number(match[1]))
  }
  return Array.from(set).sort((a, b) => a - b)
}

// The "+ Add follow-up / Add check-in" button that appends another slot to a phase. Indented to line
// up with the row titles so it reads as the next step in the sequence.
function AddSlotButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="ml-[19px] mt-1 inline-flex items-center gap-1 text-[11.5px] font-medium text-faint transition-colors hover:text-brass-bright"
    >
      <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 5v14M5 12h14" />
      </svg>
      {label}
    </button>
  )
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
