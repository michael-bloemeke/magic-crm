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
// Permanently delete a project: removes the record from the database and the
// CRM's overlay data (stage, tasks, payments, mileage). No undo.
export function deleteProject(id: string): Promise<void> {
  return postJson('/api/project/delete', { id })
}

// --- Email templates ---------------------------------------------------------

export type Template = {
  id: string
  name: string
  subject: string
  body: string
  // 'html' = the body is rich HTML (may contain smart-field placeholder chips); 'text' = a
  // legacy plain-text template. Absent is treated as 'text'.
  format?: 'html' | 'text'
  updatedAt: string
}

export async function loadTemplates(): Promise<Template[]> {
  const res = await fetch('/api/templates')
  if (!res.ok) throw new Error(`Failed to load templates (${res.status})`)
  const data = await res.json()
  return (data.templates ?? []) as Template[]
}

export async function saveTemplate(input: {
  id?: string
  name: string
  subject: string
  body: string
  format?: 'html' | 'text'
}): Promise<Template> {
  const res = await fetch('/api/templates/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) throw new Error(`Failed to save template (${res.status})`)
  return (await res.json()).template as Template
}

export async function deleteTemplate(id: string): Promise<void> {
  await postJson('/api/templates/delete', { id })
}

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

// --- Client portal -----------------------------------------------------------
export type PortalSettings = {
  token: string
  published: boolean
  sharedFields: string[]
  assetIds: string[]
  links: Record<string, string>
  message: string
  accessCode?: string
  expiresAt?: string
  lastPublishedAt?: string
}
export type ShareableField = { id: string; label: string; custom?: boolean }
export type PortalBundle = {
  token: string
  projectName: string
  eventType: string
  message: string
  fields: { label: string; value: string }[]
  links: Record<string, string>
  expiresAt: string | null
  publishedAt: string | null
}

export type PortalDeploy = { ok: boolean; url?: string; error?: string }
type PortalPatch = Partial<Pick<PortalSettings, 'sharedFields' | 'assetIds' | 'links' | 'message' | 'accessCode' | 'expiresAt'>>

export async function loadPortals(): Promise<{ portals: Record<string, PortalSettings>; shareableFields: ShareableField[]; baseUrl: string }> {
  const res = await fetch('/api/portal')
  if (!res.ok) throw new Error(`Failed to load portals (${res.status})`)
  const d = await res.json()
  return { portals: d.portals ?? {}, shareableFields: d.shareableFields ?? [], baseUrl: d.baseUrl ?? '' }
}
export async function savePortal(input: { projectId: string; patch: PortalPatch }): Promise<PortalSettings> {
  const res = await fetch('/api/portal/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) throw new Error(`Failed to save portal (${res.status})`)
  return (await res.json()).portal as PortalSettings
}
// Publish saves the latest config, writes the curated bundle, and deploys it live.
// Slow (~20-40s) because it pushes to Vercel.
export async function publishPortal(
  projectId: string,
  patch: PortalPatch,
): Promise<{ portal: PortalSettings; bundle: PortalBundle | null; baseUrl: string; deploy: PortalDeploy }> {
  const res = await fetch('/api/portal/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, patch }),
  })
  if (!res.ok) throw new Error(`Failed to publish portal (${res.status})`)
  return (await res.json()) as { portal: PortalSettings; bundle: PortalBundle | null; baseUrl: string; deploy: PortalDeploy }
}
export async function unpublishPortal(
  projectId: string,
): Promise<{ portal: PortalSettings; baseUrl: string; deploy: PortalDeploy }> {
  const res = await fetch('/api/portal/unpublish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId }),
  })
  if (!res.ok) throw new Error(`Failed to unpublish portal (${res.status})`)
  return (await res.json()) as { portal: PortalSettings; baseUrl: string; deploy: PortalDeploy }
}
export async function loadPortalBundle(projectId: string): Promise<PortalBundle | null> {
  const res = await fetch(`/api/portal/bundle?projectId=${encodeURIComponent(projectId)}`)
  if (!res.ok) throw new Error(`Failed to load portal bundle (${res.status})`)
  return ((await res.json()).bundle ?? null) as PortalBundle | null
}

// --- Client questionnaire ----------------------------------------------------
export type QuestionType = 'text' | 'textarea' | 'date' | 'tel' | 'number' | 'select'
export type Question = { id: string; label: string; type: QuestionType; required: boolean; options?: string[]; fieldKey?: string }
export type QuestionnaireAnswer = { id: string; label: string; value: string }
export type QuestionnaireResponse = { answers: QuestionnaireAnswer[]; submittedAt: string; pulledAt: string; appliedFields: string[] }
export type Questionnaire = { enabled: boolean; intro: string; questions: Question[]; response: QuestionnaireResponse | null }
export type QuestionnaireState = { questionnaire: Questionnaire | null; blobConfigured: boolean; published: boolean; portalUrl: string }
export type QuestionnairePull = { ok: boolean; error?: string; response?: QuestionnaireResponse | null; filledFields?: string[]; fresh?: boolean; deploy?: PortalDeploy }

export async function loadQuestionnaire(projectId: string): Promise<QuestionnaireState> {
  const res = await fetch(`/api/questionnaire?projectId=${encodeURIComponent(projectId)}`)
  if (!res.ok) throw new Error(`Failed to load questionnaire (${res.status})`)
  return (await res.json()) as QuestionnaireState
}
// Turn the questionnaire on/off (and edit its intro). Enabling publishes the portal and
// redeploys, so this is slow (~20-40s), like a portal publish.
export async function setQuestionnaire(
  projectId: string,
  patch: { enabled?: boolean; intro?: string },
): Promise<{ questionnaire: Questionnaire; portalUrl: string; published: boolean; deploy: PortalDeploy }> {
  const res = await fetch('/api/questionnaire/set', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, ...patch }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `Failed to update questionnaire (${res.status})`)
  return data as { questionnaire: Questionnaire; portalUrl: string; published: boolean; deploy: PortalDeploy }
}
// Poll for the latest submitted answers; auto-fills mapped fields when a new one arrives.
export async function pullQuestionnaire(projectId: string): Promise<QuestionnairePull> {
  const res = await fetch('/api/questionnaire/pull', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `Failed to pull answers (${res.status})`)
  return data as QuestionnairePull
}

// A client questionnaire submission Michael hasn't acknowledged yet (drives the bell notification).
export type QuestionnaireSubmission = { projectId: string; projectName: string; submittedAt: string }
// The current unseen submissions (cheap; does not pull from the cloud).
export async function loadQuestionnaireSubmissions(): Promise<QuestionnaireSubmission[]> {
  const res = await fetch('/api/questionnaire/submissions')
  if (!res.ok) return []
  return ((await res.json()).submissions ?? []) as QuestionnaireSubmission[]
}
// Background sweep: pulls any newly-submitted questionnaires (auto-filling fields + republishing
// the portal) and returns the current unseen submissions. `fresh` = how many newly arrived.
export async function checkQuestionnaireSubmissions(): Promise<{ fresh: number; submissions: QuestionnaireSubmission[] }> {
  const res = await fetch('/api/questionnaire/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  if (!res.ok) return { fresh: 0, submissions: [] }
  return (await res.json()) as { fresh: number; submissions: QuestionnaireSubmission[] }
}
// Acknowledge a submission (clears its notification). Returns the remaining unseen ones.
export async function markQuestionnaireSeen(projectId: string): Promise<QuestionnaireSubmission[]> {
  const res = await fetch('/api/questionnaire/seen', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId }),
  })
  if (!res.ok) return []
  return ((await res.json()).submissions ?? []) as QuestionnaireSubmission[]
}

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

// --- Global questionnaire template (Settings editor) -------------------------
export type QuestionnaireTemplate = { intro: string; questions: Question[] }
export async function loadQuestionnaireTemplate(): Promise<QuestionnaireTemplate> {
  const res = await fetch('/api/questionnaire-template')
  if (!res.ok) throw new Error(`Failed to load questionnaire template (${res.status})`)
  return ((await res.json()).template ?? { intro: '', questions: [] }) as QuestionnaireTemplate
}
export async function saveQuestionnaireTemplate(t: QuestionnaireTemplate): Promise<QuestionnaireTemplate> {
  const res = await fetch('/api/questionnaire-template/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(t),
  })
  if (!res.ok) throw new Error(`Failed to save questionnaire template (${res.status})`)
  return (await res.json()).template as QuestionnaireTemplate
}

// --- Status-change notifications (invoice paid, contract viewed, contract signed) ----
export type StatusNotification = {
  id: string
  projectId: string
  projectName: string
  kind: string
  label: string
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
export async function claudeCompleteTemplate(input: { projectId: string; body: string }): Promise<string> {
  const res = await fetch('/api/claude/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.error) throw new Error(data.error || `Claude template completion failed (${res.status})`)
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
export const PAYMENT_METHODS = ['Online (HB)', 'Cash', 'Check', 'PayPal', 'Venmo', 'CashApp', 'Zelle'] as const
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
  const res = await fetch('/api/finance/expenses')
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
  from: string
  fromName: string
  date: string
  ts?: number
  body: string
  unread?: boolean
}
export type EmailThread = {
  id: string
  subject: string
  participants: string[]
  lastDate: string
  lastTs?: number
  unread?: number
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
  mode: 'send' | 'draft'
}): Promise<{ ok: boolean; demo: boolean; mode: string }> {
  const res = await fetch('/api/comms/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) throw new Error(`Failed to send (${res.status})`)
  return (await res.json()) as { ok: boolean; demo: boolean; mode: string }
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
