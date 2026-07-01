import { useEffect, useState, type ReactNode } from 'react'
import { type Project, type PipelineStructure, type CategoryDef } from '../pipeline'
import { deleteProjectEmail, loadConfig, loadCustomValues, loadInquiryForm, loadProjectEmails, loadRecipient, loadStructure, loadTextMarkers, saveCustomValue, saveRecipient, saveTextMarker, TIP_METHODS, type Contact, type DocRecipient, type InquiryForm, type Payment, type ProjectEmail, type ProjectLinks, type Task, type TextMarker } from '../api'
import { type CustomField } from '../eventFields'
import { TaskRow } from './TaskRow'
import { EditableField } from './EditableField'
import { PaymentsEditor } from './PaymentsEditor'
import { ContactCard } from './ContactCard'
import { ProjectNotesPanel } from './ProjectNotesPanel'
import { EmailBuilderCard } from './EmailBuilderCard'
import { InvoiceCard } from './InvoiceCard'
import { ContractCard } from './ContractCard'
import { QuestionnaireCard } from './QuestionnaireCard'
import { RecipientsCard } from './RecipientsCard'
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
  const [inquiryFollowupSlots, setInquiryFollowupSlots] = useState<number[]>([1])
  const [followupSlots, setFollowupSlots] = useState<number[]>([1])
  const [checkinSlots, setCheckinSlots] = useState<number[]>([1])
  // "Text sent" markers (manual SMS flags), keyed by email-slot kind. Independent of the emails.
  const [textMarkers, setTextMarkers] = useState<TextMarker[]>([])

  useEffect(() => {
    let live = true
    loadProjectEmails()
      .then((all) => {
        if (!live) return
        const mine = all.filter((e) => e.projectId === project.id)
        setEmails(mine)
        setInquiryFollowupSlots(buildSlots(mine, 'inquiry-followup'))
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

  useEffect(() => {
    let live = true
    loadTextMarkers()
      .then((all) => live && setTextMarkers(all.filter((m) => m.projectId === project.id)))
      .catch(() => live && setTextMarkers([]))
    return () => {
      live = false
    }
  }, [project.id])

  // kind -> marker, for the cards. Toggling/dating a text persists it and updates this map.
  const textMarkerMap: Record<string, TextMarker> = {}
  for (const m of textMarkers) textMarkerMap[m.kind] = m
  const setTextMarker = (kind: string, sent: boolean, date: string) => {
    // Optimistic: reflect it immediately; an emptied marker (off + no date) drops out of the list.
    setTextMarkers((prev) => {
      const others = prev.filter((m) => m.kind !== kind)
      return !sent && !date ? others : [...others, { projectId: project.id, kind, sent, date, updatedAt: new Date().toISOString() }]
    })
    saveTextMarker({ projectId: project.id, kind, sent, date })
      .then((saved) =>
        setTextMarkers((prev) => {
          const others = prev.filter((m) => m.kind !== kind)
          return saved.sent || saved.date ? [...others, saved] : others
        }),
      )
      .catch(() => {})
  }

  // The original website inquiry form for this project (if it came from the site contact form).
  const [inquiryForm, setInquiryForm] = useState<InquiryForm | null>(null)
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

  // The highlighted section opens by default; the rest collapse. Re-derives when the project or its
  // stage changes; manual toggles persist until then.
  const [openSections, setOpenSections] = useState<Set<string>>(new Set())
  useEffect(() => {
    setOpenSections(new Set(highlightedSection ? [highlightedSection] : []))
  }, [project.id, highlightedSection])
  const toggleSection = (id: string) =>
    setOpenSections((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const isOpen = (id: string) => openSections.has(id)

  const emailFor = (kind: string) => emails.find((e) => e.kind === kind) ?? null
  const upsertEmail = (e: ProjectEmail) => setEmails((prev) => [...prev.filter((x) => x.id !== e.id), e])
  // Discard a saved draft: drop it locally and delete it (which also cleans up its uploads).
  const discardEmail = (id: string) => {
    setEmails((prev) => prev.filter((x) => x.id !== id))
    deleteProjectEmail(id).catch(() => {})
  }

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

      {/* Inquiry: the original website form fill (if any) + the inquiry-stage email sequence.
          Collapsible; auto-expands and highlights while the project sits in an Inquiry stage. */}
      <DetailSection
        title="Inquiry"
        collapsible
        open={isOpen('inquiry')}
        onToggle={() => toggleSection('inquiry')}
        highlight={highlightedSection === 'inquiry'}
      >
        {inquiryForm && inquiryForm.fields.length > 0 ? (
          <div className="mb-4">
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">
              Website inquiry{inquiryForm.submittedAt ? ' · ' + fmtSubmitted(inquiryForm.submittedAt) : ''}
            </div>
            <div className="space-y-1.5 rounded-lg border border-line bg-surface px-3.5 py-3">
              {inquiryForm.fields.map((f) => (
                <div key={f.key} className="text-[13px] leading-relaxed">
                  <span className="text-faint">{f.label}: </span>
                  <span className="whitespace-pre-wrap text-parchment">{f.value}</span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="mb-4 text-[12px] text-faint">
            No saved website inquiry for this project. (The form is saved automatically for new website inquiries.)
          </p>
        )}
        <div className={cardGrid}>
          <EmailBuilderCard
            project={project} recipientEmails={recipientEmails} onSaved={upsertEmail} onDiscard={discardEmail}
            textMarkers={textMarkerMap} onSetTextMarker={setTextMarker}
            kind="inquiry-response" title="Inquiry response" defaultSubject="Re: Your inquiry"
            templateHint={/inquiry/i} email={emailFor('inquiry-response')}
          />
          {inquiryFollowupSlots.map((n, i) => (
            <EmailBuilderCard
              key={`inquiry-followup-${n}`}
              project={project} recipientEmails={recipientEmails} onSaved={upsertEmail} onDiscard={discardEmail}
            textMarkers={textMarkerMap} onSetTextMarker={setTextMarker}
              kind={`inquiry-followup-${n}`} title={`Follow-up #${i + 1}`} defaultSubject="Checking In"
              templateHint={/follow-up/i} email={emailFor(`inquiry-followup-${n}`)}
              onDelete={inquiryFollowupSlots.length > 1 ? () => removeSlot('inquiry-followup', n, setInquiryFollowupSlots) : undefined}
            />
          ))}
          <EmailBuilderCard
            project={project} recipientEmails={recipientEmails} onSaved={upsertEmail} onDiscard={discardEmail}
            textMarkers={textMarkerMap} onSetTextMarker={setTextMarker}
            kind="inquiry-shark" title="Shark email" defaultSubject="Checking In" email={emailFor('inquiry-shark')}
          />
          <EmailBuilderCard
            project={project} recipientEmails={recipientEmails} onSaved={upsertEmail} onDiscard={discardEmail}
            textMarkers={textMarkerMap} onSetTextMarker={setTextMarker}
            kind="inquiry-breakup" title="Break-up email" defaultSubject="Following Up" email={emailFor('inquiry-breakup')}
          />
        </div>
        <AddEmailButton label="Add follow-up" onClick={() => addSlot(setInquiryFollowupSlots)} />
      </DetailSection>

      {/* Event details: the blurb up top (the most immediate detail), then the
          structured fields grouped when / scope / where / show / source. */}
      <DetailSection title="Event details">
        {shown('eventSummary') && (
          <div className="mb-5">
            <EditableField label={lbl('eventSummary', 'Description')} placeholder="A sentence or two about the event…" value={project.eventSummary} onSave={save('eventSummary')} multiline />
          </div>
        )}
        <div className={fieldGrid}>
          {shown('eventDate') && <EditableField label={lbl('eventDate', 'Event date')} type="date" value={project.eventDate} onSave={save('eventDate')} />}
          {shown('arrivalTime') && <EditableField label={lbl('arrivalTime', 'Arrival time')} value={project.arrivalTime} onSave={save('arrivalTime')} />}
          {shown('eventStartTime') && <EditableField label={lbl('eventStartTime', 'Event start')} value={project.eventStartTime} onSave={save('eventStartTime')} />}
          {shown('showStartTime') && <EditableField label={lbl('showStartTime', 'Show start')} value={project.showStartTime} onSave={save('showStartTime')} />}
          {shown('totalFee') && <EditableField label={lbl('totalFee', 'Quote')} prefix="$" value={project.totalFee == null ? '' : String(project.totalFee)} onSave={save('totalFee')} />}
          {shown('numberOfGuests') && <EditableField label={lbl('numberOfGuests', 'Guest Count')} multiline value={project.numberOfGuests} onSave={save('numberOfGuests')} />}
          {shown('ageOfGuests') && <EditableField label={lbl('ageOfGuests', 'Guest ages')} multiline value={project.ageOfGuests} onSave={save('ageOfGuests')} />}
          {shown('eventLocation') && <EditableField label={lbl('eventLocation', 'Location')} multiline value={project.eventLocation} onSave={save('eventLocation')} />}
          {shown('venueType') && <EditableField label={lbl('venueType', 'Venue type')} multiline value={project.venueType} onSave={save('venueType')} />}
          {shown('indoorsOrOutdoors') && <EditableField label={lbl('indoorsOrOutdoors', 'Indoors / Outdoors')} multiline value={project.indoorsOrOutdoors} onSave={save('indoorsOrOutdoors')} />}
          {shown('performanceStyle') && <EditableField label={lbl('performanceStyle', 'Performance')} multiline value={project.performanceStyle} onSave={save('performanceStyle')} />}
          {shown('av') && <EditableField label={lbl('av', 'AV')} multiline value={project.av} onSave={save('av')} />}
          {shown('vips') && <EditableField label={lbl('vips', 'VIPs')} multiline value={project.vips} onSave={save('vips')} />}
          {shown('bookingSource') && <EditableField label={lbl('bookingSource', 'Booking source')} multiline value={project.bookingSource} onSave={save('bookingSource')} />}
          {/* User-defined custom fields (added in Settings). Values are stored CRM-side per project. */}
          {customFields.map((f) => (
            <EditableField key={f.id} label={f.label} multiline value={customVals[f.id] || ''} onSave={saveCustom(f.id)} />
          ))}
        </div>
      </DetailSection>

      {/* Post Call: the nurture sequence after the sales call. */}
      <DetailSection title="Post Call" collapsible open={isOpen('postcall')} onToggle={() => toggleSection('postcall')} highlight={highlightedSection === 'postcall'}>
        <div className={cardGrid}>
          <EmailBuilderCard
            project={project} recipientEmails={recipientEmails} onSaved={upsertEmail} onDiscard={discardEmail}
            textMarkers={textMarkerMap} onSetTextMarker={setTextMarker}
            kind="postcall" title="Post-call email" defaultSubject="Magician Information - Please Reply"
            templateHint={/post-call/i} email={emailFor('postcall')}
          />
          {followupSlots.map((n, i) => (
            <EmailBuilderCard
              key={`followup-${n}`}
              project={project} recipientEmails={recipientEmails} onSaved={upsertEmail} onDiscard={discardEmail}
            textMarkers={textMarkerMap} onSetTextMarker={setTextMarker}
              kind={`followup-${n}`} title={`Follow-up #${i + 1}`} defaultSubject="Checking In"
              templateHint={/follow-up/i} email={emailFor(`followup-${n}`)}
              onDelete={followupSlots.length > 1 ? () => removeSlot('followup', n, setFollowupSlots) : undefined}
            />
          ))}
          <EmailBuilderCard
            project={project} recipientEmails={recipientEmails} onSaved={upsertEmail} onDiscard={discardEmail}
            textMarkers={textMarkerMap} onSetTextMarker={setTextMarker}
            kind="shark" title="Shark email" defaultSubject="Checking In" email={emailFor('shark')}
          />
          <EmailBuilderCard
            project={project} recipientEmails={recipientEmails} onSaved={upsertEmail} onDiscard={discardEmail}
            textMarkers={textMarkerMap} onSetTextMarker={setTextMarker}
            kind="breakup" title="Break-up email" defaultSubject="Following Up" email={emailFor('breakup')}
          />
        </div>
        <AddEmailButton label="Add follow-up" onClick={() => addSlot(setFollowupSlots)} />
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
          </div>
        </div>
      </DetailSection>

      {/* Booked: the show paperwork once it's locked in, plus the check-in emails. */}
      <DetailSection title="Booked" collapsible open={isOpen('booked')} onToggle={() => toggleSection('booked')} highlight={highlightedSection === 'booked'}>
        <div className={cardGrid}>
          {/* Booking confirmation — the "you're all set" note once the booking is locked in, ahead of the check-ins. */}
          <EmailBuilderCard
            project={project} recipientEmails={recipientEmails} onSaved={upsertEmail} onDiscard={discardEmail}
            textMarkers={textMarkerMap} onSetTextMarker={setTextMarker}
            kind="booking-confirmation" title="Booking confirmation" defaultSubject="Booking Confirmed"
            templateHint={/booking|confirm/i} email={emailFor('booking-confirmation')}
          />
          {checkinSlots.map((n, i) => (
            <EmailBuilderCard
              key={`checkin-${n}`}
              project={project} recipientEmails={recipientEmails} onSaved={upsertEmail} onDiscard={discardEmail}
            textMarkers={textMarkerMap} onSetTextMarker={setTextMarker}
              kind={`checkin-${n}`} title={`Check-in #${i + 1}`} defaultSubject="Checking In"
              templateHint={/check-in/i} email={emailFor(`checkin-${n}`)}
              onDelete={checkinSlots.length > 1 ? () => removeSlot('checkin', n, setCheckinSlots) : undefined}
            />
          ))}
        </div>
        <AddEmailButton label="Add check-in" onClick={() => addSlot(setCheckinSlots)} />
      </DetailSection>

      {/* Post show: the wrap-up numbers and the thank-you note. */}
      <DetailSection title="Post show" collapsible open={isOpen('postshow')} onToggle={() => toggleSection('postshow')} highlight={highlightedSection === 'postshow'}>
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
            project={project} recipientEmails={recipientEmails} onSaved={upsertEmail} onDiscard={discardEmail}
            textMarkers={textMarkerMap} onSetTextMarker={setTextMarker}
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

// "2026-06-24T19:31:05.883Z" -> "Jun 24, 2026, 3:31 PM" (local), for the saved inquiry timestamp.
function fmtSubmitted(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
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
}: {
  title: string
  children: ReactNode
  collapsible?: boolean
  open?: boolean
  onToggle?: () => void
  highlight?: boolean
}) {
  const shown = !collapsible || open
  const header = (
    <div
      className={[
        'flex items-center justify-between gap-2 px-5 py-2.5',
        shown ? 'border-b border-line-strong' : '',
        highlight ? 'bg-brass/10' : 'bg-surface-3/40',
      ].join(' ')}
    >
      <h3 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-brass">
        <span className="h-3 w-[3px] rounded-full bg-brass" />
        {title}
      </h3>
      {collapsible && (
        <svg
          className={['h-4 w-4 text-muted transition-transform', open ? 'rotate-180' : ''].join(' ')}
          viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      )}
    </div>
  )
  return (
    <section
      className={[
        'overflow-hidden rounded-2xl border bg-surface-2/30 shadow-[0_1px_2px_rgba(0,0,0,0.25)] transition-colors',
        highlight ? 'border-brass-dim ring-1 ring-brass-dim/40' : 'border-line-strong',
      ].join(' ')}
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
