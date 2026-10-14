import type { PipelineStructure, Project } from './pipeline'

// Reads the live project records (served by the crm-data Vite plugin in dev).
export async function loadProjects(): Promise<Project[]> {
  const res = await fetch('/api/projects')
  if (!res.ok) throw new Error(`Failed to load projects (${res.status})`)
  const data = await res.json()
  return (data.projects ?? []) as Project[]
}

// Persist a stage change to the CRM-owned overlay (crm-pipeline.json).
export async function saveStage(id: string, stageId: string): Promise<void> {
  const res = await fetch('/api/stage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, stageId }),
  })
  if (!res.ok) throw new Error(`Failed to save stage (${res.status})`)
}

// --- Editable pipeline structure (categories + stages) -----------------------
export async function loadStructure(): Promise<PipelineStructure> {
  const res = await fetch('/api/pipeline/structure')
  if (!res.ok) throw new Error(`Failed to load pipeline (${res.status})`)
  return (await res.json()).structure as PipelineStructure
}
export async function saveStructure(structure: PipelineStructure): Promise<PipelineStructure> {
  const res = await fetch('/api/pipeline/structure', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ structure }),
  })
  if (!res.ok) throw new Error(`Failed to save pipeline (${res.status})`)
  return (await res.json()).structure as PipelineStructure
}
// Move every project on `fromStageIds` to `toStageId` (the "dump into Inquiry" action).
export async function reassignStage(fromStageIds: string[], toStageId: string): Promise<void> {
  const res = await fetch('/api/pipeline/reassign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fromStageIds, toStageId }),
  })
  if (!res.ok) throw new Error(`Failed to reassign (${res.status})`)
}

export type FlowLayout = {
  positions: Record<string, { x: number; y: number }>
  edges: { id: string; from: string; to: string }[]
}

// Flow-view node layout is stored server-side in crm-pipeline.json so it
// survives app changes (and is visible to/resettable by the maintainer).
export async function getFlowLayout(): Promise<FlowLayout | null> {
  const res = await fetch('/api/flow-layout')
  if (!res.ok) throw new Error(`Failed to load layout (${res.status})`)
  const data = await res.json()
  return (data.flowLayout ?? null) as FlowLayout | null
}

export async function putFlowLayout(layout: FlowLayout): Promise<void> {
  await fetch('/api/flow-layout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(layout),
  })
}

// --- Tasks -------------------------------------------------------------------

export type Task = {
  id: string
  projectId: string
  title: string
  dueDate: string // YYYY-MM-DD
  dueTime: string // HH:MM (24h), or '' for an all-day task. CRM reminders stay date-based either way.
  done: boolean
  createdAt: string
}

export async function loadTasks(): Promise<Task[]> {
  const res = await fetch('/api/tasks')
  if (!res.ok) throw new Error(`Failed to load tasks (${res.status})`)
  const data = await res.json()
  return (data.tasks ?? []) as Task[]
}

export async function addTask(input: {
  projectId?: string
  title: string
  dueDate: string
  dueTime?: string
}): Promise<Task> {
  const res = await fetch('/api/tasks/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) throw new Error(`Failed to add task (${res.status})`)
  const data = await res.json()
  return data.task as Task
}

export async function setTaskDone(id: string, done: boolean): Promise<void> {
  const res = await fetch('/api/tasks/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, done }),
  })
  if (!res.ok) throw new Error(`Failed to update task (${res.status})`)
}

// Rename a task and/or change its due date/time.
export async function editTask(id: string, patch: { title?: string; dueDate?: string; dueTime?: string }): Promise<void> {
  const res = await fetch('/api/tasks/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, ...patch }),
  })
  if (!res.ok) throw new Error(`Failed to update task (${res.status})`)
}

export async function removeTask(id: string): Promise<void> {
  const res = await fetch('/api/tasks/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  })
  if (!res.ok) throw new Error(`Failed to delete task (${res.status})`)
}

// Log a "made a call" entry to the project's activity log. Returns the updated log.
export async function logCall(input: {
  id: string
  answered: boolean
  voicemail?: boolean
  note?: string
}): Promise<{ activityLog: string[] }> {
  const res = await fetch('/api/project/log-call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) throw new Error(`Failed to log call (${res.status})`)
  return (await res.json()) as { activityLog: string[] }
}

// Persist an inline edit of a project detail field to the canonical JSON.
export async function saveProjectField(id: string, field: string, value: string): Promise<void> {
  const res = await fetch('/api/project/field', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, field, value }),
  })
  if (!res.ok) throw new Error(`Failed to save (${res.status})`)
}

// --- Contacts ----------------------------------------------------------------

export type ContactType = 'client' | 'vendor' | 'associate' | 'other'
// 'active' = currently in the pipeline; yes/no/maybe = durable disposition once
// the client has left the pipeline (set when archiving/completing).
export type Relationship = 'yes' | 'no' | 'maybe' | 'active' | ''
export type Engagement = 'emailed' | 'collaborated' | ''
export type Contact = {
  id: string
  name: string
  emails: string[]
  phones: string[]
  type: ContactType
  relationship: Relationship
  engagement: Engagement
  tags: string[]
  notes: string
  createdAt: string
  updatedAt: string
}

export async function loadContacts(): Promise<Contact[]> {
  const res = await fetch('/api/contacts')
  if (!res.ok) throw new Error(`Failed to load contacts (${res.status})`)
  return ((await res.json()).contacts ?? []) as Contact[]
}
export async function addContact(input: Partial<Contact>): Promise<Contact> {
  const res = await fetch('/api/contacts/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) throw new Error(`Failed to add contact (${res.status})`)
  return (await res.json()).contact as Contact
}
export async function updateContact(input: { id: string } & Partial<Contact>): Promise<Contact> {
  const res = await fetch('/api/contacts/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) throw new Error(`Failed to update contact (${res.status})`)
  return (await res.json()).contact as Contact
}
export async function deleteContact(id: string): Promise<void> {
  await postJson('/api/contacts/delete', { id })
}

// --- Project <-> contact links ----------------------------------------------
// links[projectId] = the contact ids attached to that project. The single source
// of truth for which contacts are on a project (replaces the old name-matching).
export type ProjectLinks = Record<string, string[]>

export async function loadLinks(): Promise<ProjectLinks> {
  const res = await fetch('/api/links')
  if (!res.ok) throw new Error(`Failed to load links (${res.status})`)
  return ((await res.json()).links ?? {}) as ProjectLinks
}
export async function linkContact(projectId: string, contactId: string): Promise<ProjectLinks> {
  const res = await fetch('/api/links/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, contactId }),
  })
  if (!res.ok) throw new Error(`Failed to link contact (${res.status})`)
  return ((await res.json()).links ?? {}) as ProjectLinks
}
export async function unlinkContact(projectId: string, contactId: string): Promise<ProjectLinks> {
  const res = await fetch('/api/links/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, contactId }),
  })
  if (!res.ok) throw new Error(`Failed to unlink contact (${res.status})`)
  return ((await res.json()).links ?? {}) as ProjectLinks
}

// --- Create a project --------------------------------------------------------

export async function createProject(input: {
  clientName: string
  eventType?: string
  stageId?: string
  eventDate?: string
  totalFee?: string | number
  eventLocation?: string
  contactNames?: string
  contactEmails?: string
  contactPhones?: string
  projectNotes?: string
}): Promise<Project> {
  const res = await fetch('/api/project/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error((data as { error?: string }).error || `Failed to create project (${res.status})`)
  }
  return (await res.json()).project as Project
}

// --- Archive / complete / restore (move a project between buckets) -----------

async function postJson(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error((data as { error?: string }).error || `Request failed (${res.status})`)
  }
}

export function archiveProject(id: string, reason: string): Promise<void> {
  return postJson('/api/project/archive', { id, reason })
}
export function completeProject(id: string): Promise<void> {
  return postJson('/api/project/complete', { id })
}
export function restoreProject(id: string): Promise<void> {
  return postJson('/api/project/restore', { id })
}
// Soft delete: moves the project to the 30-day trash (the Deleted page). Nothing is
// destroyed; it can be restored, and is permanently purged after 30 days.
export function deleteProject(id: string): Promise<void> {
  return postJson('/api/project/delete', { id })
}
// Permanent delete (full cascade, no undo): removes the project and every related
// record across all tables. Used by the "Delete permanently" action on the Deleted page.
export function purgeProject(id: string): Promise<void> {
  return postJson('/api/project/purge', { id })
}

// The saved email-template library (type, loaders, Templates page, composer picker) was removed on
// 2026-07-31. Michael is rewriting his templates outside the CRM; the old ones are archived in the
// business folder as email-templates-archive-2026-07-31.md.

// --- Composed per-project emails (thank-you, etc.) ---------------------------
// An attachment is either a document picked from the Files page (source 'files', referenced
// by name) or a one-off uploaded while composing (source 'upload', referenced by id).
export type EmailAttachment = {
  source: 'files' | 'upload'
  name: string
  id?: string
  size?: number
}
export type ProjectEmail = {
  id: string
  projectId: string
  kind: string
  to: string[]
  subject: string
  body: string
  format: 'html' | 'text'
  attachments: EmailAttachment[]
  // When set, the email is sent as a reply into this existing Gmail thread instead of a new one.
  // threadSubject is kept for display. Empty = a new thread.
  threadId: string
  threadSubject: string
  status: 'draft' | 'sent'
  createdAt: string
  updatedAt: string
  sentAt: string
}

export async function loadProjectEmails(): Promise<ProjectEmail[]> {
  const res = await fetch('/api/emails')
  if (!res.ok) throw new Error(`Failed to load emails (${res.status})`)
  return ((await res.json()).emails ?? []) as ProjectEmail[]
}

export async function saveProjectEmail(input: {
  id?: string
  projectId: string
  kind?: string
  to: string[]
  subject: string
  body: string
  format?: 'html' | 'text'
  attachments?: EmailAttachment[]
  threadId?: string
  threadSubject?: string
}): Promise<ProjectEmail> {
  const res = await fetch('/api/emails/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) throw new Error(`Failed to save email (${res.status})`)
  return (await res.json()).email as ProjectEmail
}

// Upload a one-off attachment (kept out of the Files page). Returns its stored ref.
export async function uploadEmailAttachment(file: File): Promise<EmailAttachment> {
  const res = await fetch(`/api/email-attachments/upload?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `Failed to upload attachment (${res.status})`)
  return { source: 'upload', ...(data.attachment as { id: string; name: string; size: number }) }
}
export async function deleteEmailAttachment(id: string): Promise<void> {
  await postJson('/api/email-attachments/delete', { id })
}

export async function sendProjectEmail(id: string): Promise<{ ok: boolean; demo: boolean; email: ProjectEmail }> {
  const res = await fetch('/api/emails/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  })
  if (!res.ok) throw new Error(`Failed to send email (${res.status})`)
  return (await res.json()) as { ok: boolean; demo: boolean; email: ProjectEmail }
}

export async function deleteProjectEmail(id: string): Promise<void> {
  await postJson('/api/emails/delete', { id })
}

// The per-step communication markers (email/text "sent" flags) were removed from the UI on
// 2026-08-02 along with the Communication section. The `text_markers` table and its /api/text-markers
// routes still exist and the 49 existing marker rows are untouched, so nothing was lost; there is
// simply no screen reading them right now.

// The client portal and the per-project questionnaire were removed 2026-08-03. Both were
// experiments that never earned their keep; the booking form replaced them. The Vercel
// deployment now serves only /book/<token>.

// --- Document recipients (contract signer + invoice bill-to) -----------------
export type DocRecipient = { signerId: string; billToId: string; billToName: string }
export async function loadRecipient(projectId: string): Promise<DocRecipient | null> {
  const res = await fetch(`/api/recipients?projectId=${encodeURIComponent(projectId)}`)
  if (!res.ok) return null
  return ((await res.json()).recipient ?? null) as DocRecipient | null
}
export async function saveRecipient(projectId: string, patch: Partial<DocRecipient>): Promise<DocRecipient> {
  const res = await fetch('/api/recipients/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, ...patch }),
  })
  if (!res.ok) throw new Error(`Failed to save recipients (${res.status})`)
  return (await res.json()).recipient as DocRecipient
}

// --- Status-change notifications (invoice paid, contract viewed, contract signed) ----
export type StatusNotification = {
  id: string
  projectId: string
  projectName: string
  kind: string
  // For task-due this is now the task's real title (resolved server-side); for new-inquiry it's
  // "New inquiry"; otherwise a static kind label ("Invoice paid", etc.).
  label: string
  sourceId: string
  createdAt: string
  seen: boolean
}
export async function loadStatusNotifications(): Promise<StatusNotification[]> {
  const res = await fetch('/api/notifications')
  if (!res.ok) return []
  return ((await res.json()).notifications ?? []) as StatusNotification[]
}
// Runs the server-side sweep (polls QuickBooks + SignWell) and returns the current unseen list.
export async function checkStatusNotifications(): Promise<StatusNotification[]> {
  const res = await fetch('/api/notifications/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  if (!res.ok) return []
  return ((await res.json()).notifications ?? []) as StatusNotification[]
}
export async function markStatusNotificationSeen(id: string): Promise<StatusNotification[]> {
  const res = await fetch('/api/notifications/seen', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  })
  if (!res.ok) return []
  return ((await res.json()).notifications ?? []) as StatusNotification[]
}

// --- Claude drafting (headless Claude Code) ----------------------------------
export async function claudeStatus(): Promise<{ available: boolean; configured: boolean }> {
  try {
    const res = await fetch('/api/claude')
    if (!res.ok) return { available: false, configured: false }
    return (await res.json()) as { available: boolean; configured: boolean }
  } catch {
    return { available: false, configured: false }
  }
}
// Draft a fresh email in Michael's voice from an instruction. Reads project + voice + recordings.
export async function claudeDraftEmail(input: { projectId: string; label?: string; instruction?: string }): Promise<string> {
  const res = await fetch('/api/claude/draft', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.error) throw new Error(data.error || `Claude draft failed (${res.status})`)
  return String(data.draft || '')
}
// Complete a smart-field template for this client.
// Finish a rough draft already in the composer for this specific client.
export async function claudeCompleteDraft(input: { projectId: string; body: string }): Promise<string> {
  const res = await fetch('/api/claude/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.error) throw new Error(data.error || `Claude draft completion failed (${res.status})`)
  return String(data.draft || '')
}
// Draft a reply to a specific email thread (plain text), thread- and project-aware.
export async function claudeDraftReply(input: { projectId: string; threadText: string }): Promise<string> {
  const res = await fetch('/api/claude/reply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.error) throw new Error(data.error || `Claude reply failed (${res.status})`)
  return String(data.draft || '')
}
// A per-project chat message (read + write; can do real work like editing the activity log).
export type ClaudeChatMessage = { role: 'user' | 'assistant'; text: string }

export async function claudeChat(input: { projectId: string; message: string; history: ClaudeChatMessage[] }): Promise<string> {
  const res = await fetch('/api/claude/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.error) throw new Error(data.error || `Claude chat failed (${res.status})`)
  return String(data.reply || '')
}

// --- QuickBooks --------------------------------------------------------------
export type QuickBooksStatus = { configured: boolean; connected: boolean; environment: string }
export type QuickBooksInvoice = {
  invoiceId: string
  docNumber: string
  total: number
  amount?: number
  processingFee?: number
  dueDate?: string
  customer: string
  email: string
  createdAt: string
  sentAt: string
  // Outstanding balance, and when it hit zero. Written by the paid-invoice poll on the server timer.
  // A paid invoice also drops the "Inquiry: " prefix from the gig's calendar entry.
  balance?: number
  paidAt?: string
}
export type InvoiceOptions = { amount?: number; dueDate?: string; processingFeePercent?: number; customerName?: string; email?: string }

export async function loadQuickBooks(): Promise<{ status: QuickBooksStatus; invoices: Record<string, QuickBooksInvoice> }> {
  const res = await fetch('/api/quickbooks')
  if (!res.ok) throw new Error(`Failed to load QuickBooks status (${res.status})`)
  const d = await res.json()
  return { status: d.status, invoices: d.invoices ?? {} }
}
export async function createQbInvoice(projectId: string, opts: InvoiceOptions = {}): Promise<QuickBooksInvoice> {
  const res = await fetch('/api/quickbooks/invoice', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, ...opts }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Failed to create invoice (${res.status})`)
  return data.invoice as QuickBooksInvoice
}
export async function sendQbInvoice(projectId: string, email?: string): Promise<QuickBooksInvoice> {
  const res = await fetch('/api/quickbooks/invoice/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, email }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Failed to send invoice (${res.status})`)
  return data.invoice as QuickBooksInvoice
}
export function qbInvoicePdfUrl(projectId: string): string {
  return `/api/quickbooks/invoice/pdf?projectId=${encodeURIComponent(projectId)}`
}
export async function disconnectQuickBooks(): Promise<void> {
  await postJson('/api/quickbooks/disconnect', {})
}

// --- Contracts ---------------------------------------------------------------
export type ContractStatus = 'draft' | 'sent'
export type ContractField = { label: string; value: string }
export type EsignInfo = {
  id: string
  status: string
  signerName: string
  signerEmail: string
  testMode: boolean
  sentAt: string
  viewedAt?: string
  signedAt: string
}
export type ContractVersion = {
  id: string
  createdAt: string
  esign?: EsignInfo
  // Current (SignWell-template) records:
  templateId?: string
  templateLabel?: string
  // Legacy (in-CRM generated) fields, kept optional for old records:
  version?: number
  status?: ContractStatus
  includeMedia?: boolean
  format?: string
  body?: string
  sentAt?: string
}
export type EsignStatus = { configured: boolean; testMode: boolean }

export async function loadContracts(): Promise<Record<string, ContractVersion[]>> {
  const res = await fetch('/api/contracts')
  if (!res.ok) throw new Error(`Failed to load contracts (${res.status})`)
  const d = await res.json()
  return d.contracts ?? {}
}
export type ContractDraft = {
  html: string
  mediaHtml: string
  fields: ContractField[]
  missingFields: string[]
  brand: string
  title: string
  signatureLines: string[]
}
export async function draftContract(projectId: string): Promise<ContractDraft> {
  const res = await fetch('/api/contracts/draft', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Failed to build contract draft (${res.status})`)
  return {
    html: data.html ?? '',
    mediaHtml: data.mediaHtml ?? '',
    fields: data.fields ?? [],
    missingFields: data.missingFields ?? [],
    brand: data.brand ?? '',
    title: data.title ?? '',
    signatureLines: data.signatureLines ?? [],
  }
}
export async function createContract(projectId: string, body: string, includeMedia: boolean): Promise<ContractVersion> {
  const res = await fetch('/api/contracts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, body, includeMedia, format: 'html' }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Failed to save contract (${res.status})`)
  return data.contract as ContractVersion
}
export async function setContractStatus(projectId: string, id: string, status: ContractStatus): Promise<ContractVersion> {
  const res = await fetch('/api/contracts/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, id, status }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Failed to update contract (${res.status})`)
  return data.contract as ContractVersion
}
export async function deleteContract(projectId: string, id: string): Promise<void> {
  const res = await fetch('/api/contracts/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, id }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error || `Failed to delete contract (${res.status})`)
  }
}
export function contractPdfUrl(projectId: string, id: string): string {
  return `/api/contracts/pdf?projectId=${encodeURIComponent(projectId)}&id=${encodeURIComponent(id)}`
}

// --- Booking flow (booking form -> agreement -> invoice) ---------------------
// Michael sends a link, the client fills in the event details, and the CRM turns that into an
// agreement (summary page + short contract + type-your-name) and a not-yet-sent invoice.

export type BookingStatus = {
  token: string
  url: string
  sentAt: string
  submission: { submittedAt: string; answers: { id: string; value: string }[] } | null
  summary: { label: string; value: string }[]
  invoiceTo: { name: string; email: string }
  // What the client typed on the website's signing step. Null until they sign. This, not the PDF,
  // is the record of the agreement.
  signature: { name: string; date: string; signedAt: string; ip: string; agent: string } | null
  // Live read of how far the client has got, so the card's status bar moves without a button.
  progress?: {
    stage: 'none' | 'viewed' | 'submitted' | 'signed'
    // One timestamp per step of the timeline, so each label can say when it happened.
    sentAt: string
    viewedAt: string
    submittedAt: string
    signedAt: string
    signedName?: string
    variant?: string
    unavailable?: boolean
  }
  // Set once the signed PDF has been emailed back to them for their records.
  agreementSentAt: string
  // Why the last automatic send failed, if it did. Cleared on a successful send.
  agreementError: string
}

export async function loadBookingStatus(projectId: string): Promise<BookingStatus | null> {
  const res = await fetch(`/api/booking/status?projectId=${encodeURIComponent(projectId)}`)
  if (!res.ok) return null
  return (await res.json()) as BookingStatus
}

// Issue (or reuse) this project's booking-form link.
export async function createBookingLink(projectId: string): Promise<BookingStatus> {
  return postJsonStrict('/api/booking/link', { projectId }, 'Could not create the booking link')
}

// Check the form store for the client's submission and apply it to the project. If the submission is
// there, this also mails the agreement (the server does it inline rather than leaving it to the
// 2-minute sweep, since pressing the button means Michael is waiting on the answer).
export async function pullBookingSubmission(projectId: string): Promise<{
  ok: boolean
  fresh?: boolean
  error?: string
  filledFields?: string[]
  submission?: { submittedAt: string; answers: { id: string; value: string }[] } | null
  signature?: { name: string; date: string; signedAt: string } | null
  freshSignature?: boolean
  agreementSent?: boolean
  agreementTo?: string
  agreementError?: string
  invoiceSent?: boolean
  invoiceTo?: string
  invoiceAmount?: number
  invoiceEnvironment?: string
  invoiceSkipped?: string
  invoiceError?: string
}> {
  try {
    return await postJsonStrict('/api/booking/pull', { projectId }, 'Could not check for answers')
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e) }
  }
}

// Send the agreement again, after correcting something. Only path that sends a second copy.
export async function resendAgreement(projectId: string): Promise<{ ok: boolean; to?: string; fileName?: string }> {
  return postJsonStrict('/api/booking/resend-agreement', { projectId }, 'Could not resend the agreement')
}

// POST a JSON call and INSIST on a JSON reply.
//
// Without this, a route the running server doesn't have yet is silently mistaken for success: the
// dev server answers an unknown /api/... path with the app's own index.html at HTTP 200, res.json()
// rejects, a bare .catch(() => ({})) swallows it, and the caller cheerfully reports that something
// happened when nothing did. That exact bug shipped once here (the Ready to book button claimed it
// had made a Gmail draft that never existed). So a non-JSON reply is now a loud, specific error that
// names the likely cause.
async function postJsonStrict<T>(path: string, body: unknown, whatFailed: string): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let d: { error?: string } & Record<string, unknown>
  try {
    d = JSON.parse(text)
  } catch {
    throw new Error(
      `${whatFailed}: the CRM server didn't recognise ${path}. It's probably running an older build. Quit Bloom CRM and reopen it, then try again.`,
    )
  }
  if (!res.ok || d.error) throw new Error(d.error || `${whatFailed} (${res.status})`)
  return d as T
}

// "Ready to book": issue the form link and leave a ready-to-send draft in Gmail. Never sends.
export type ContractVariant = { id: string; label: string; hint: string }

// Which contract versions can be sent. Currently the standard one and a version with the media
// clause removed, for clients who don't want the event photographed.
export async function loadContractVariants(): Promise<ContractVariant[]> {
  const res = await fetch('/api/booking/variants')
  if (!res.ok) return []
  return ((await res.json()) as { variants: ContractVariant[] }).variants || []
}

// `resend` wipes the previous attempt (its timestamps, signature, and the CRM's invoice record)
// before issuing the new one, so the timeline describes the form the client currently holds.
export async function readyToBook(projectId: string, variant = 'standard', resend = false): Promise<{ ok: boolean; to: string; url: string; variant: string; reset?: boolean }> {
  return postJsonStrict('/api/booking/ready', { projectId, variant, resend }, 'Could not create the draft')
}

// The agreement PDF: summary page + short contract + type-your-name. Built fresh each time.
export function bookingAgreementPdfUrl(projectId: string, download = false): string {
  return `/api/booking/agreement-pdf?projectId=${encodeURIComponent(projectId)}${download ? '&download=1' : ''}`
}

// --- Proposal page -----------------------------------------------------------
//
// The step before the booking flow: the per-client page Michael sends after a sales call. It lives
// on michaelbloemeke.com and is served from Supabase, so publishing is a database write rather than
// a deploy and the link works whether or not this app is running.
// ---------------------------------------------------------------------------
// The Proposals page
// ---------------------------------------------------------------------------

// ⚠️ `state` is COMPUTED on the server, not read off proposals.status. A proposal can say `live` in
// the database while its page is actually dark, because the edge function also refuses anything past
// its expiry or belonging to a project that has left the pipeline. See proposalsOverview in
// crm-proposals.mjs. Never render `status` here; render `state`.
export type ProposalState = 'draft' | 'live' | 'expired' | 'down'

// Did the deal close? Read off the PROJECT, not the proposal: a proposal has no idea, and reading
// `retired` as a loss would call every tidied-up page a lost deal.
export type ProposalOutcome = 'open' | 'booked' | 'lost' | 'unknown'

export type ProposalOverviewItem = {
  projectId: string
  projectName: string
  contactNames: string
  eventType: string
  eventDate: string
  totalFee: number | string | null
  bucket: string
  stageId: string

  state: ProposalState
  stateReason: string
  outcome: ProposalOutcome
  outcomeLabel: string
  outcomeNote: string

  // The clean link, the one Michael actually sends. Carries no flags.
  url: string
  // The link to open FROM THE CRM. Always flagged, so his own reading is never counted, and for a
  // page that is no longer public it carries his preview key so he can still read it back.
  openUrl: string
  views: number
  firstViewedAt: string
  lastViewedAt: string
  expiresAt: string
  emailDraftedAt: string
  createdAt: string
}

export type BookingOverviewItem = {
  projectId: string
  projectName: string
  // Same active/past split the proposals use. A form on a completed project is history.
  bucket: string
  outcome: ProposalOutcome
  outcomeLabel: string
  outcomeNote: string
  eventType: string
  eventDate: string
  totalFee: number | string | null
  sentAt: string
  openUrl: string
  views: number
  firstViewedAt: string
  lastViewedAt: string
  variant: string
}

export type ProposalsOverview = {
  items: ProposalOverviewItem[]
  bookings: BookingOverviewItem[]
  // The blank templates, attached to no client. What a client actually sees.
  samples: { proposal: string; booking: string }
}

export async function loadProposalsOverview(): Promise<ProposalsOverview> {
  const res = await fetch('/api/proposals/overview')
  if (!res.ok) throw new Error('Could not load the proposals.')
  return (await res.json()) as ProposalsOverview
}

export type ProposalStatus = {
  exists: boolean
  // none = never created. draft = link issued but dead. live = the link works. retired = taken down.
  status: 'none' | 'draft' | 'live' | 'retired'
  // ⚠️ Render `state`, not `status`. Same reason as the Proposals page: the status column says
  // 'live' on proposals whose pages are actually dark, because the edge function also gates on
  // expiry and on the project's bucket. Absent only when no proposal exists.
  state?: ProposalState
  stateReason?: string
  url?: string
  // The link to open FROM the CRM: always flagged, so previewing never counts as a view, and
  // carrying the admin key when the page is no longer public so a draft can still be read.
  openUrl?: string
  headline?: string
  // What still has to be filled in before it can be published, in plain words.
  gaps: string[]
  // Every view is counted, not every viewer: the forwarded view is the one that decides the booking.
  views: number
  firstViewedAt?: string
  lastViewedAt?: string
  expiresAt?: string
  emailDraftedAt?: string
  packageCount?: number
}

export async function loadProposalStatus(projectId: string): Promise<ProposalStatus | null> {
  const res = await fetch(`/api/proposal/status?projectId=${encodeURIComponent(projectId)}`)
  if (!res.ok) return null
  return (await res.json()) as ProposalStatus
}

// Start a draft, seeded from the project's event type. Does NOT make the link live.
export async function createProposal(projectId: string): Promise<ProposalStatus> {
  return postJsonStrict('/api/proposal/create', { projectId }, 'Could not start the proposal')
}

export async function saveProposal(projectId: string, patch: Record<string, unknown>): Promise<ProposalStatus> {
  return postJsonStrict('/api/proposal/save', { projectId, ...patch }, 'Could not save the proposal')
}

// Make the link live and leave the email waiting in Gmail. Never sends it.
export async function publishProposal(
  projectId: string,
  draftEmail = true,
): Promise<ProposalStatus & { draft?: { to: string } | null; draftError?: string }> {
  return postJsonStrict('/api/proposal/publish', { projectId, draftEmail }, 'Could not publish the proposal')
}

// Draft the email on its own, for a proposal that is already live.
export async function draftProposalEmail(projectId: string): Promise<ProposalStatus & { draft?: { to: string } }> {
  return postJsonStrict('/api/proposal/email', { projectId }, 'Could not draft the proposal email')
}

// Take the page down by hand. Archiving or deleting the project already does this on its own.
export async function retireProposal(projectId: string): Promise<ProposalStatus> {
  return postJsonStrict('/api/proposal/retire', { projectId }, 'Could not retire the proposal')
}

// Back to zero, so the next view is known to be the client's rather than Michael's proofreading.
// Also re-arms the first-view alert; see resetProposalViews in crm-proposals.mjs.
export async function resetProposalViews(projectId: string): Promise<ProposalStatus> {
  return postJsonStrict('/api/proposal/reset-views', { projectId }, 'Could not reset the view count')
}

export async function loadEsignStatus(): Promise<EsignStatus> {
  const res = await fetch('/api/esign')
  if (!res.ok) throw new Error(`Failed to load e-sign status (${res.status})`)
  const d = await res.json()
  return d.status ?? { configured: false, testMode: true }
}
export async function sendContractForSignature(
  projectId: string,
  id: string,
  signerName: string,
  signerEmail: string,
): Promise<ContractVersion> {
  const res = await fetch('/api/contracts/send-signature', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, id, signerName, signerEmail }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Failed to send for signature (${res.status})`)
  return data.contract as ContractVersion
}
export async function refreshContractSignature(projectId: string, id: string): Promise<ContractVersion> {
  const res = await fetch('/api/contracts/refresh-signature', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, id }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Failed to refresh signature status (${res.status})`)
  return data.contract as ContractVersion
}
export function signedContractPdfUrl(projectId: string, id: string): string {
  return `/api/contracts/signed-pdf?projectId=${encodeURIComponent(projectId)}&id=${encodeURIComponent(id)}`
}
export type SignwellTemplate = { id: string; name: string }
export async function loadContractTemplates(): Promise<SignwellTemplate[]> {
  const res = await fetch('/api/contract-templates')
  if (!res.ok) throw new Error(`Failed to load contract templates (${res.status})`)
  const d = await res.json()
  return d.templates ?? []
}
export async function sendContract(
  projectId: string,
  templateId: string,
  templateLabel: string,
  signerName: string,
  signerEmail: string,
): Promise<ContractVersion> {
  const res = await fetch('/api/contracts/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, templateId, templateLabel, signerName, signerEmail }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Failed to send contract (${res.status})`)
  return data.contract as ContractVersion
}

// --- Default contract template (Settings) ------------------------------------
export type ContractTemplateData = {
  template: string
  isCustom: boolean
  brand: string
  title: string
  signatureLines: string[]
  fields: { key: string; label: string }[]
}
export async function loadContractTemplate(): Promise<ContractTemplateData> {
  const res = await fetch('/api/contract-template')
  if (!res.ok) throw new Error(`Failed to load contract template (${res.status})`)
  return (await res.json()) as ContractTemplateData
}
// Pass '' to reset to the built-in default.
export async function saveContractTemplate(template: string): Promise<void> {
  const res = await fetch('/api/contract-template', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ template }),
  })
  if (!res.ok) {
    const d = await res.json().catch(() => ({}))
    throw new Error(d.error || `Failed to save contract template (${res.status})`)
  }
}

// --- Business files ----------------------------------------------------------

export type FileItem = {
  name: string
  size: number
  modified: string
}

export async function loadFiles(): Promise<FileItem[]> {
  const res = await fetch('/api/files')
  if (!res.ok) throw new Error(`Failed to load files (${res.status})`)
  const data = await res.json()
  return (data.files ?? []) as FileItem[]
}

export async function uploadFile(file: File): Promise<FileItem> {
  const res = await fetch(`/api/files/upload?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  })
  if (!res.ok) throw new Error(`Failed to upload (${res.status})`)
  return (await res.json()).file as FileItem
}

export async function deleteFile(name: string): Promise<void> {
  await postJson('/api/files/delete', { name })
}

export function fileRawUrl(name: string): string {
  return `/api/files/raw?name=${encodeURIComponent(name)}`
}

// --- Editable settings -------------------------------------------------------

export type AppConfig = {
  incomeGoals: number[]
  monthlyGoal: number
  archiveReasons: string[]
  contactTags: string[]
  eventFieldLabels: Record<string, string>
  eventFieldHidden: string[]
  // Display-only built-in event fields the user deleted (hidden everywhere; reversible).
  eventFieldDeleted: string[]
  // User-defined custom event fields (definitions; values via load/saveCustomValue).
  customFields: { id: string; label: string }[]
  // Which project-page section to highlight per pipeline umbrella (umbrellaId -> sectionId).
  sectionHighlights: Record<string, string>
  // Email signature appended below the body on send. signatureHtml may embed a logo as a data: <img>.
  signatureEnabled: boolean
  signatureHtml: string
}

// Per-project values for the custom event fields, keyed by custom field id.
export async function loadCustomValues(projectId: string): Promise<Record<string, string>> {
  const res = await fetch(`/api/custom-values?projectId=${encodeURIComponent(projectId)}`)
  if (!res.ok) return {}
  return ((await res.json()).values ?? {}) as Record<string, string>
}
export async function saveCustomValue(projectId: string, fieldId: string, value: string): Promise<void> {
  const res = await fetch('/api/custom-values/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, fieldId, value }),
  })
  if (!res.ok) throw new Error(`Failed to save field (${res.status})`)
}

export async function loadConfig(): Promise<AppConfig> {
  const res = await fetch('/api/config')
  if (!res.ok) throw new Error(`Failed to load config (${res.status})`)
  return (await res.json()) as AppConfig
}
export async function saveConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
  const res = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!res.ok) throw new Error(`Failed to save config (${res.status})`)
  return (await res.json()) as AppConfig
}

// --- Website inquiry form (for the Inquiry section) --------------------------
export type InquiryForm = { submittedAt: string; formLocation: string; fields: { key: string; label: string; value: string }[] }
export async function loadInquiryForm(projectId: string): Promise<InquiryForm | null> {
  const res = await fetch(`/api/inquiry?projectId=${encodeURIComponent(projectId)}`)
  if (!res.ok) return null
  return ((await res.json()).inquiry ?? null) as InquiryForm | null
}

// --- Phone push (ntfy) -------------------------------------------------------
export type PushConfig = { enabled: boolean; topic: string; server: string; subscribeUrl: string }
export async function loadPush(): Promise<PushConfig> {
  const res = await fetch('/api/push')
  if (!res.ok) throw new Error(`Failed to load push settings (${res.status})`)
  return (await res.json()).push as PushConfig
}
export async function savePush(patch: { enabled?: boolean; regenerateTopic?: boolean; server?: string }): Promise<PushConfig> {
  const res = await fetch('/api/push/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!res.ok) throw new Error(`Failed to save push settings (${res.status})`)
  return (await res.json()).push as PushConfig
}
export async function testPush(): Promise<{ ok: boolean; status?: number; error?: string; skipped?: boolean }> {
  const res = await fetch('/api/push/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  if (!res.ok) throw new Error(`Failed to send test (${res.status})`)
  return (await res.json()).result
}

// --- Finance -----------------------------------------------------------------

// One project's contribution to a figure (drives the breakdown popovers).
export type BreakdownItem = { id: string; name: string; amount: number }
// All money figures come from payments. The two bases differ only in which month
// a payment lands in: "received" = the month it arrived, "earned" = its project's
// event month. Tips are tracked separately (by event month) and only fold into
// the figures when the app's "include tips" toggle is on.
export type FinanceBasis = 'received' | 'earned'
export type MonthMoney = {
  received: number
  earned: number
  tips: number
  receivedItems: BreakdownItem[]
  earnedItems: BreakdownItem[]
  tipItems: BreakdownItem[]
}
export type MonthPoint = { key: string; label: string } & MonthMoney
export type FinanceSummary = {
  year: number
  today: string
  months: MonthPoint[]
  thisMonth: MonthMoney
  last12: MonthMoney
  expectedRemaining: number
  expectedItems: BreakdownItem[]
  goals: { goal: number }[]
  monthlyGoal: number
  hasPayments: boolean
}

export async function loadFinance(): Promise<FinanceSummary> {
  const res = await fetch('/api/finance')
  if (!res.ok) throw new Error(`Failed to load finance (${res.status})`)
  return (await res.json()) as FinanceSummary
}

// How a payment came in. Empty = unspecified.
//
// "QuickBooks invoice" leads because it is how everything gets paid from now on. "HoneyBook" is the
// historical one and was labelled "Online (HB)" until 2026-08-04; the 102 existing payments carrying
// the old label were renamed in the same change, so no record has to be read twice.
// 'Bank transfer (ACH)' added 2026-08-24: how The Magician's Table pays Michael for a run of shows.
// Not a client invoice, a direct deposit into his account, so none of the other options describe it.
export const PAYMENT_METHODS = ['QuickBooks invoice', 'HoneyBook', 'Cash', 'Check', 'PayPal', 'Venmo', 'CashApp', 'Zelle', 'Bank transfer (ACH)'] as const
// How a tip came in. Defaults to Cash (most tips are cash handed over at the gig).
export const TIP_METHODS = ['Cash', 'Venmo', 'CashApp', 'Zelle'] as const
export type PaymentMethod = (typeof PAYMENT_METHODS)[number] | ''

export type Payment = {
  id: string
  projectId: string
  amount: number
  dateReceived: string
  pending: boolean // amount known, date not yet received (does not count as cash)
  type: 'deposit' | 'balance' | 'full' | 'other'
  method: string // payment method tag (see PAYMENT_METHODS), or '' if unspecified
  note: string
  createdAt: string
}
// A payment that actually counts as money received (not a date-pending one).
export function isReceivedPayment(p: Payment): boolean {
  return !p.pending && p.amount > 0 && !!p.dateReceived
}
export async function loadPayments(): Promise<Payment[]> {
  const res = await fetch('/api/finance/payments')
  if (!res.ok) throw new Error(`Failed to load payments (${res.status})`)
  return ((await res.json()).payments ?? []) as Payment[]
}
export async function addPayment(input: {
  projectId: string
  amount: number | string
  dateReceived?: string
  pending?: boolean
  type?: string
  method?: string
  note?: string
}): Promise<Payment> {
  const res = await fetch('/api/finance/payments/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) throw new Error(`Failed to add payment (${res.status})`)
  return (await res.json()).payment as Payment
}
export async function updatePayment(input: {
  id: string
  amount?: number | string
  dateReceived?: string
  pending?: boolean
  type?: string
  method?: string
  note?: string
}): Promise<Payment> {
  const res = await fetch('/api/finance/payments/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) throw new Error(`Failed to update payment (${res.status})`)
  return (await res.json()).payment as Payment
}
export async function deletePayment(id: string): Promise<void> {
  await postJson('/api/finance/payments/delete', { id })
}

export type Expense = {
  id: string
  name: string
  amount: number
  cadence: 'monthly' | 'quarterly' | 'yearly' | 'weekly' | 'one-time'
  category: string
  note: string
  createdAt: string
}
export async function loadExpenses(): Promise<Expense[]> {
  const res = await fetch('/api/finance/recurring-expenses')
  if (!res.ok) throw new Error(`Failed to load expenses (${res.status})`)
  return ((await res.json()).expenses ?? []) as Expense[]
}
export async function addExpense(input: {
  name: string
  amount: number | string
  cadence: string
  category?: string
  note?: string
}): Promise<Expense> {
  const res = await fetch('/api/finance/expenses/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) throw new Error(`Failed to add expense (${res.status})`)
  return (await res.json()).expense as Expense
}
export async function deleteExpense(id: string): Promise<void> {
  await postJson('/api/finance/expenses/delete', { id })
}

export type Trip = {
  id: string
  date: string
  miles: number
  purpose: string
  projectId: string
  createdAt: string
}
export type MileageData = { trips: Trip[]; ratePerMile: number }
export async function loadMileage(): Promise<MileageData> {
  const res = await fetch('/api/finance/mileage')
  if (!res.ok) throw new Error(`Failed to load mileage (${res.status})`)
  return (await res.json()) as MileageData
}
export async function addTrip(input: {
  date: string
  miles: number | string
  purpose?: string
  projectId?: string
}): Promise<Trip> {
  const res = await fetch('/api/finance/mileage/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) throw new Error(`Failed to add trip (${res.status})`)
  return (await res.json()).trip as Trip
}
export async function deleteTrip(id: string): Promise<void> {
  await postJson('/api/finance/mileage/delete', { id })
}
export async function setMileageRate(rate: number | string): Promise<void> {
  await postJson('/api/finance/mileage/rate', { rate })
}

// --- Communications (Gmail) --------------------------------------------------

export type EmailMessage = {
  id?: string // Gmail message id (absent for demo messages); needed to star a single message
  from: string
  fromName: string
  date: string // '' on an unsent draft: nothing was sent, so there is no send date
  ts?: number
  body: string
  unread?: boolean
  starred?: boolean
  // An unsent Gmail draft sitting in the thread. It must never read as a message the client
  // received; render it as a draft with no send date.
  isDraft?: boolean
}
export type EmailThread = {
  id: string
  subject: string
  participants: string[]
  // Both computed from SENT messages only, so an unsent draft can't restamp or reorder a thread.
  lastDate: string
  lastTs?: number
  unread?: number
  starred?: boolean // true if any message in the thread is starred
  hasDraft?: boolean // an unsent draft is waiting in this thread
  messages: EmailMessage[]
}

// An inbox thread is a normal thread tagged with the project it belongs to.
export type InboxThread = EmailThread & { project: { id: string; client: string } | null }
export type InboxData = {
  connected: boolean
  hasCredentials?: boolean
  canMarkRead?: boolean
  demo: boolean
  count: number
  threads: InboxThread[]
  error?: string
}

export async function loadInbox(): Promise<InboxData> {
  const res = await fetch('/api/inbox')
  if (!res.ok) throw new Error(`Failed to load inbox (${res.status})`)
  return (await res.json()) as InboxData
}

// --- Google Calendar ---------------------------------------------------------
export type CalendarStatus = {
  connected: boolean // Google (Gmail) connected at all
  hasScope: boolean // the connection was granted the calendar permission
  gigsName: string
  workName: string
  gigsCalendar: boolean // a calendar named gigsName exists in the account
  workCalendar: boolean
  error?: string
}
// Manually-added events on the Google "Gigs" calendar (CRM-created project events excluded server-side),
// pulled into the CRM for the Calendar page + the date-conflict flag.
export type GigEvent = { id: string; title: string; date: string; allDay: boolean; startTime: string; location: string; htmlLink: string }
export async function loadGigsEvents(from: string, to: string): Promise<GigEvent[]> {
  try {
    const res = await fetch(`/api/calendar/gigs?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
    if (!res.ok) return []
    const d = await res.json()
    return Array.isArray(d?.events) ? (d.events as GigEvent[]) : []
  } catch {
    return []
  }
}

export async function loadCalendarStatus(): Promise<CalendarStatus> {
  const res = await fetch('/api/calendar')
  if (!res.ok) return { connected: false, hasScope: false, gigsName: 'Gigs', workName: 'Work', gigsCalendar: false, workCalendar: false }
  return (await res.json()) as CalendarStatus
}
export async function syncCalendar(): Promise<{ ok: boolean; projects?: number; tasks?: number; errors?: string[]; error?: string }> {
  const res = await fetch('/api/calendar/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  if (!res.ok) return { ok: false, error: `Sync failed (${res.status})` }
  return (await res.json()) as { ok: boolean; projects?: number; tasks?: number; errors?: string[]; error?: string }
}

// Send a one-off Google Calendar invite (on the "Work" calendar) to the attendees.
// Creates the event + emails the invitation; logs the send on the project.
export type CalendarInviteInput = {
  projectId?: string
  summary: string
  date: string // YYYY-MM-DD
  startTime?: string // "HH:MM" (24h) or "" for an all-day invite
  durationMin?: number
  attendees: string[]
  location?: string
  description?: string
  allDay?: boolean
}
export async function sendCalendarInvite(
  input: CalendarInviteInput,
): Promise<{ ok: boolean; eventId?: string; htmlLink?: string; summary?: string; attendees?: string[]; error?: string }> {
  const res = await fetch('/api/calendar/invite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  return (await res.json()) as { ok: boolean; eventId?: string; htmlLink?: string; summary?: string; attendees?: string[]; error?: string }
}

// Unread email counts per project id (for the flow-view badges).
export async function loadUnreadByProject(): Promise<Record<string, number>> {
  try {
    const res = await fetch('/api/gmail/unread')
    if (!res.ok) return {}
    const data = await res.json()
    return (data.unread ?? {}) as Record<string, number>
  } catch {
    return {}
  }
}
export type CommsData = {
  connected: boolean
  hasCredentials?: boolean
  canMarkRead?: boolean
  demo: boolean
  contacts: string[]
  threads: EmailThread[]
  error?: string
  noEmail?: boolean
}

// Mark a Gmail thread read (clears the unread highlight). Returns needsReconnect
// when the Gmail token predates the label-write permission.
export async function markThreadRead(threadId: string): Promise<{ ok: boolean; needsReconnect?: boolean }> {
  const res = await fetch('/api/comms/read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadId }),
  })
  if (!res.ok) return { ok: false }
  return (await res.json()) as { ok: boolean; needsReconnect?: boolean }
}

export async function loadThreads(projectId: string): Promise<CommsData> {
  const res = await fetch('/api/comms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId }),
  })
  if (!res.ok) throw new Error(`Failed to load conversations (${res.status})`)
  return (await res.json()) as CommsData
}

export async function draftReply(projectId: string, threadId?: string): Promise<{ draft: string; demo: boolean }> {
  const res = await fetch('/api/comms/draft', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, threadId }),
  })
  if (!res.ok) throw new Error(`Failed to draft (${res.status})`)
  return (await res.json()) as { draft: string; demo: boolean }
}

export async function sendEmail(input: {
  projectId: string
  threadId?: string
  to?: string
  subject?: string
  body: string
  format?: 'html' | 'text'
  mode: 'send' | 'draft'
  // Attachment REFERENCES; the server reads the actual bytes from the Files page / upload store.
  attachments?: EmailAttachment[]
}): Promise<{ ok: boolean; demo: boolean; mode: string }> {
  const res = await fetch('/api/comms/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) throw new Error(`Failed to send (${res.status})`)
  return (await res.json()) as { ok: boolean; demo: boolean; mode: string }
}

// Star / unstar a whole conversation. Writes the STARRED label to Gmail so the same star shows
// there. needsReconnect = the Gmail token predates the label-write permission.
export async function starThread(input: {
  threadId: string
  starred: boolean
}): Promise<{ ok: boolean; demo?: boolean; needsReconnect?: boolean }> {
  const res = await fetch('/api/comms/star', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) return { ok: false }
  return (await res.json()) as { ok: boolean; demo?: boolean; needsReconnect?: boolean }
}

// Star / unstar a single message in a thread.
export async function starMessage(input: {
  messageId: string
  starred: boolean
}): Promise<{ ok: boolean; demo?: boolean; needsReconnect?: boolean }> {
  const res = await fetch('/api/comms/star', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) return { ok: false }
  return (await res.json()) as { ok: boolean; demo?: boolean; needsReconnect?: boolean }
}

// --- HoneyBook inquiry sync (Notion Activity Log -> auto-created projects) ----
export type InquiryNotification = {
  blockId: string
  name: string
  email: string
  eventDate: string
  projectId: string | null
  importedAt: string
  dismissed: boolean
  note?: string
}
export type InquiryStatus = { configured: boolean; baselined: boolean; unread: number }

export async function loadInquiries(): Promise<{ status: InquiryStatus; notifications: InquiryNotification[] }> {
  const res = await fetch('/api/inquiries')
  if (!res.ok) throw new Error(`Failed to load inquiries (${res.status})`)
  const d = await res.json()
  return { status: d.status ?? { configured: false, baselined: false, unread: 0 }, notifications: d.notifications ?? [] }
}
// Poll Notion for new inquiries and import them server-side. Returns how many projects it made.
export async function checkInquiries(): Promise<{ ok: boolean; importedCount?: number; error?: string }> {
  const res = await fetch('/api/inquiries/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  return (await res.json()) as { ok: boolean; importedCount?: number; error?: string }
}
export async function dismissInquiry(blockId: string): Promise<void> {
  await postJson('/api/inquiries/dismiss', { blockId })
}

// --- Live website analytics (GA4 + Search Console via the website-analytics edge function) ----
export type AnalyticsSummary = {
  users: number
  sessions: number
  newUsers: number
  avgSessionDuration: number // seconds
  pageViews: number
}
export type Analytics = {
  ok: boolean
  // false = the Google credential (GOOGLE_SA_KEY secret) isn't set yet, or the function is unreachable.
  connected: boolean
  generatedAt: string
  property?: string
  error?: string
  errors?: string[]
  realtime?: {
    activeUsers: number
    byCity: { city: string; users: number }[]
    byPage: { page: string; users: number }[]
  } | null
  visitors?: {
    last7: AnalyticsSummary
    last28: AnalyticsSummary
    trend: { date: string; users: number }[]
  } | null
  sources?: {
    channels: { channel: string; sessions: number; users: number }[]
    top: { source: string; sessions: number; users: number }[]
  } | null
  locations?: {
    countries: { country: string; users: number }[]
    cities: { city: string; region: string; country: string; users: number }[]
  } | null
  devices?: {
    categories: { device: string; users: number }[]
    browsers: { browser: string; users: number }[]
    os: { os: string; users: number }[]
  } | null
  pages?: { path: string; views: number; avgTime: number }[] | null
  ads?: {
    // false = the GA4 property isn't linked to Google Ads yet (so no cost data flows in).
    linked: boolean
    last7: { cost: number; clicks: number; impressions: number }
    last28: { cost: number; clicks: number; impressions: number }
    campaigns: { name: string; cost: number; clicks: number }[]
  } | null
  search?: {
    startDate: string
    endDate: string
    totals: { clicks: number; impressions: number; ctr: number; queries: number }
    queries: { query: string; clicks: number; impressions: number; ctr: number; position: number }[]
  } | null
  conversions?: {
    leads7: number
    leads28: number
    rate7: number | null
    rate28: number | null
  } | null
}

export async function loadAnalytics(): Promise<Analytics> {
  const res = await fetch('/api/analytics')
  if (!res.ok) throw new Error(`Failed to load analytics (${res.status})`)
  return (await res.json()) as Analytics
}

// --- Bank balances (Coastal via YNAB, through the bank-balances edge function) ---------------
// READ ONLY, and deliberately so. This returns how much is sitting in each account and nothing
// else: no transactions, no spending, no transfers. The YNAB token lives only as a Supabase
// secret and never reaches the browser.
export type BankAccount = {
  id: string
  name: string
  type: string
  onBudget: boolean
  // What the bank itself says. This is the number shown.
  cleared: number
  // Includes transactions entered in YNAB that have not hit the bank yet, so it can differ.
  balance: number
  uncleared: number
  lastReconciledAt: string | null
}
export type BankBalances = {
  ok: boolean
  // false = the YNAB_TOKEN secret is not set yet, or YNAB is unreachable. `reason` says which.
  connected: boolean
  generatedAt: string
  budgetName?: string
  accounts: BankAccount[]
  total?: number
  reason?: string
}
export async function loadBankBalances(force = false): Promise<BankBalances> {
  const res = await fetch(`/api/bank${force ? '?force=1' : ''}`)
  if (!res.ok) throw new Error(`Failed to load bank balances (${res.status})`)
  return (await res.json()) as BankBalances
}

// --- QuickBooks money, by month (cash basis) --------------------------------
// READ ONLY. Powers both the Finance page's "money received" headline and the "after business
// expenses" line under it.
//
// ⚠️ `covered` is the important field on each month. QuickBooks holds nothing before 2026-01-01
// while the CRM has payments back to May 2025, and an uncovered month reports 0.00, which is
// indistinguishable from a month in which nothing happened. The page must decide PER MONTH which
// ledger to believe: QuickBooks where it is covered, the CRM's own logged payments where it is not.
// Reading the zeros as real would wipe about $30,000 off his twelve-month figure and do it quietly.
export type QuickBooksMonth = {
  // 'YYYY-MM'
  month: string
  income: number
  // Total business spend: operating expenses + COGS + other expenses.
  expenses: number
  // false = QuickBooks has no data for this month, so its 0.00 means "don't know", not "nothing".
  // The Finance page falls back to the CRM's own logged payments for these months.
  covered: boolean
}
export type BusinessExpenses = {
  ok: boolean
  // false = QuickBooks is not connected, or the call failed. `reason` says which. The page falls
  // back to the CRM figures entirely rather than showing a zero, because zero would read as
  // "no money and no expenses".
  connected: boolean
  generatedAt?: string
  // The earliest date / month QuickBooks has anything on. '' when it has nothing at all.
  dataStartsAt?: string
  dataStartsMonth?: string
  // Oldest first, one entry per month of the rolling twelve-month window.
  months?: QuickBooksMonth[]
  thisMonth?: QuickBooksMonth | null
  reason?: string
}
export async function loadBusinessExpenses(force = false): Promise<BusinessExpenses> {
  const res = await fetch(`/api/finance/expenses${force ? '?force=1' : ''}`)
  if (!res.ok) throw new Error(`Failed to load business expenses (${res.status})`)
  return (await res.json()) as BusinessExpenses
}

// --- Recurring task schedules ----------------------------------------------
// A schedule is DATA, not a cron job: one Postgres job materialises every row, so adding a
// recurrence here never means editing a schedule by hand somewhere invisible.

export const SCHEDULE_FREQUENCIES = ['daily', 'weekly', 'monthly'] as const
export type ScheduleFrequency = (typeof SCHEDULE_FREQUENCIES)[number]
// index 0 = ISO day 1 (Monday), matching what Postgres's isodow returns.
export const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export type TaskSchedule = {
  id: string
  title: string
  projectId: string
  frequency: ScheduleFrequency
  daysOfWeek: number[]
  dayOfMonth: number | null
  runTime: string
  dueTime: string
  active: boolean
  lastCreatedOn: string
  createdAt: string
}

export async function loadTaskSchedules(): Promise<TaskSchedule[]> {
  const res = await fetch('/api/task-schedules')
  if (!res.ok) throw new Error(`Failed to load schedules (${res.status})`)
  return ((await res.json()).schedules ?? []) as TaskSchedule[]
}

async function schedulePost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`)
  return data as T
}

export async function addTaskSchedule(input: Partial<TaskSchedule>): Promise<TaskSchedule> {
  return (await schedulePost<{ schedule: TaskSchedule }>('/api/task-schedules/add', input)).schedule
}
export async function updateTaskSchedule(id: string, patch: Partial<TaskSchedule>): Promise<TaskSchedule> {
  return (await schedulePost<{ schedule: TaskSchedule }>('/api/task-schedules/update', { id, patch })).schedule
}
export async function deleteTaskSchedule(id: string): Promise<void> {
  await schedulePost('/api/task-schedules/delete', { id })
}

// "Every Monday at 7:00 AM" from a schedule, for the list.
export function describeSchedule(s: TaskSchedule): string {
  const [h, m] = s.runTime.split(':').map(Number)
  const h12 = h % 12 === 0 ? 12 : h % 12
  const time = `${h12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
  if (s.frequency === 'daily') return `Every day at ${time}`
  if (s.frequency === 'monthly') {
    const d = s.dayOfMonth ?? 1
    const suffix = d % 10 === 1 && d !== 11 ? 'st' : d % 10 === 2 && d !== 12 ? 'nd' : d % 10 === 3 && d !== 13 ? 'rd' : 'th'
    return `Monthly on the ${d}${suffix} at ${time}`
  }
  const days = [...s.daysOfWeek].sort().map((n) => DAY_LABELS[n - 1]).join(', ')
  return `Every ${days || '(no day set)'} at ${time}`
}
