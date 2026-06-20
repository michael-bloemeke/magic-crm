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
  projectId: string
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
export type ProjectEmail = {
  id: string
  projectId: string
  kind: string
  to: string[]
  subject: string
  body: string
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
}): Promise<ProjectEmail> {
  const res = await fetch('/api/emails/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) throw new Error(`Failed to save email (${res.status})`)
  return (await res.json()).email as ProjectEmail
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
export type ShareableField = { id: string; label: string }
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

export type AppConfig = { incomeGoals: number[]; archiveReasons: string[]; contactTags: string[] }

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
