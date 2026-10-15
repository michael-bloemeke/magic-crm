// The pipeline structure mirrors Michael's Notion system exactly:
// 15 stages grouped under 4 color-coded umbrellas. Stage names are verbatim
// from notion-system.md so this stays the single source of truth for the CRM.
//
// Project DATA is no longer hardcoded here. It is read live from Michael's
// canonical records (Project Records/*.json) via /api/projects, with stage
// supplied by the CRM-owned overlay (crm-pipeline.json). See crm-data-core.mjs.

export type EventType =
  | 'Wedding'
  | 'Corporate'
  | 'Private Event'
  | 'Bachelor(ette) Party'
  | 'Other'

export type Project = {
  id: string
  client: string
  stageId: string
  bucket: 'active' | 'completed' | 'archived' | 'deleted'
  eventType: EventType
  eventDate: string // ISO yyyy-mm-dd, or '' if unknown
  leadDate: string // when the lead/inquiry came in (ISO yyyy-mm-dd), or '' if unknown
  signedOff: boolean // Michael has audited this project's stat fields (temporary audit flag)
  eventLocation: string
  venueType: string
  indoorsOrOutdoors: string
  arrivalTime: string
  eventStartTime: string
  showStartTime: string
  // PRIVATE (2026-10-15): when Michael leaves home for the gig and when he expects to be back. Booked
  // gigs go on the calendar as a busy block between these two. Required before a project can move
  // into a Booked stage.
  leaveHomeTime: string
  backHomeTime: string
  numberOfGuests: string
  ageOfGuests: string
  performanceStyle: string
  totalFee: number | null // the quote: the contracted price (used for projections, not "money in")
  tips: number | null // gratuity received at the gig, on top of the quote (optional)
  tipsMethod: string // how the tip came in: Cash (default) / Venmo / CashApp / Zelle
  mileage: number | null // round-trip miles driven for this gig
  vips: string
  av: string
  contactNames: string
  contactEmails: string
  contactPhones: string
  bookingSource: string
  eventSummary: string // a brief 1-2 sentence blurb shown in Event details
  eventDescription: string // the fuller write-up shown in the Notes side panel
  projectNotes: string
  initialInquiry: string // the raw content the client typed into the website inquiry form
  // Which contract version this project's booking form went out with ('standard' | 'no-media').
  // Set when the form is issued; the PDF renders whichever one the client actually signed.
  agreementVariant?: string
  howItWent: string
  assets: string
  status: string
  flags: string[]
  activityLog: string[]
  // Archive / completed bookkeeping (set when a project leaves the pipeline).
  archiveReason: string
  whyArchived: string
  completedDate: string
  deletedAt: string // ISO timestamp when soft-deleted (in the 30-day trash), or '' if not deleted
}

// Reasons offered when archiving a project. Michael maintains this list;
// add/rename entries here and the dropdown + Archive filters pick them up.
export const ARCHIVE_REASONS = [
  'Booked elsewhere',
  'Went with someone else',
  'Decided against having a magician',
  'Outside budget',
  'No response / Ghosted',
  'Date no longer available',
  'Event cancelled',
  'Not the right fit',
  'Duplicate inquiry',
  'Other',
]

// --- Editable pipeline structure --------------------------------------------
// The categories ("umbrellas") and their stages are now editable + stored
// server-side (crm-pipeline.json `structure`). role 'first' = the permanent
// Inquiry category (holds the permanent 'inquiry' stage, the orphanage); 'last' =
// the Booked category (payment-gated, always >=1 stage); null = a middle category.

export const ORPHAN_STAGE_ID = 'inquiry'
// 'first' = Inquiry (permanent home); 'booked' = payment-gated Booked; 'postshow' =
// auto-only Post Show (always last); null = a middle category.
export type PipelineRole = 'first' | 'booked' | 'postshow' | null
export type StageDef = { id: string; name: string }
export type CategoryDef = { id: string; label: string; color: string; role: PipelineRole; stages: StageDef[] }
export type PipelineStructure = { umbrellas: CategoryDef[] }

// Live pipeline (structure + the projects grouped into each stage).
export type Stage = { id: string; name: string; projects: Project[] }
export type Umbrella = { id: string; label: string; color: string; role: PipelineRole; stages: Stage[] }

// Colors offered for new/edited categories (the three defaults use theme tokens).
export const CATEGORY_COLORS = [
  '#c8a96a',
  '#7ea1c4',
  '#6abf9b',
  '#c47e9e',
  '#b48ad6',
  '#d69a6a',
  '#8ab0d6',
  '#cf7e6e',
]

// Frontend default, mirrors the backend DEFAULT_STRUCTURE. Used as initial state
// until the real structure loads from the server.
export const DEFAULT_STRUCTURE: PipelineStructure = {
  umbrellas: [
    {
      id: 'inquiry',
      label: 'Inquiry',
      color: 'var(--color-umb-inquiry)',
      role: 'first',
      stages: [
        { id: 'inquiry', name: 'Inquiry' },
        { id: 'answered-inquiry', name: 'Answered Inquiry' },
        { id: 'inquiry-followup-1', name: 'Inquiry Follow Up #1 Sent' },
        { id: 'inquiry-followup-2', name: 'Inquiry Follow Up #2 Sent' },
        { id: 'inquiry-shark', name: 'Inquiry Shark Sent' },
        { id: 'inquiry-breakup', name: 'Inquiry Breakup Sent' },
      ],
    },
    {
      id: 'postcall',
      label: 'Not Yet Booked',
      color: 'var(--color-umb-postcall)',
      role: null,
      stages: [
        { id: 'post-call-info', name: 'Post-Call Info Sent' },
        { id: 'in-communication', name: 'In Communication' },
        { id: 'followup-1', name: 'Follow Up #1 Sent' },
        { id: 'followup-2', name: 'Follow Up #2 Sent' },
        { id: 'shark', name: 'Shark Email Sent' },
        { id: 'breakup', name: 'Breakup Sent' },
      ],
    },
    {
      id: 'booked',
      label: 'Booked',
      color: 'var(--color-umb-booked)',
      role: 'booked',
      stages: [
        { id: 'deposit-sent', name: 'Deposit Sent' },
        { id: 'deposit-paid', name: 'Deposit Paid' },
      ],
    },
    {
      id: 'post-show',
      label: 'Post Show',
      color: 'var(--color-umb-archive)',
      role: 'postshow',
      stages: [
        { id: 'thank-you-payment', name: 'Thank You + Payment' },
        { id: 'thank-you', name: 'Thank You' },
      ],
    },
  ],
}

// All stage ids in the Booked category: moving a project into any of these requires
// a received payment.
export function bookedStageIds(structure: PipelineStructure): Set<string> {
  const booked = structure.umbrellas.find((u) => u.role === 'booked')
  return new Set(booked ? booked.stages.map((s) => s.id) : [])
}
// All stage ids in the Post Show category: projects can never be moved into these
// manually (they arrive automatically the day after the event).
export function postshowStageIds(structure: PipelineStructure): Set<string> {
  const ps = structure.umbrellas.find((u) => u.role === 'postshow')
  return new Set(ps ? ps.stages.map((s) => s.id) : [])
}

// Group active projects into the live umbrella/stage structure. Completed/archived
// projects have their own pages, so they're excluded regardless of any stale stage.
export function buildPipeline(projects: Project[], structure: PipelineStructure): Umbrella[] {
  const active = projects.filter((p) => p.bucket === 'active')
  return structure.umbrellas.map((u) => ({
    id: u.id,
    label: u.label,
    color: u.color,
    role: u.role,
    stages: u.stages.map((s) => ({
      id: s.id,
      name: s.name,
      projects: active.filter((p) => p.stageId === s.id).sort(byEventDateAsc),
    })),
  }))
}

// --- Pure structure-edit helpers (client-side; the server re-normalizes) -----
const rid = (p: string) => `${p}_${Math.random().toString(36).slice(2, 10)}`

export function addStage(s: PipelineStructure, categoryId: string): PipelineStructure {
  return {
    umbrellas: s.umbrellas.map((u) =>
      u.id === categoryId ? { ...u, stages: [...u.stages, { id: rid('s'), name: 'New stage' }] } : u,
    ),
  }
}
export function renameStage(s: PipelineStructure, stageId: string, name: string): PipelineStructure {
  return {
    umbrellas: s.umbrellas.map((u) => ({
      ...u,
      stages: u.stages.map((st) => (st.id === stageId ? { ...st, name } : st)),
    })),
  }
}
// Move a stage left/right within its own category.
export function reorderStage(s: PipelineStructure, stageId: string, dir: -1 | 1): PipelineStructure {
  return {
    umbrellas: s.umbrellas.map((u) => {
      const i = u.stages.findIndex((st) => st.id === stageId)
      const j = i + dir
      if (i < 0 || j < 0 || j >= u.stages.length) return u
      const stages = u.stages.slice()
      ;[stages[i], stages[j]] = [stages[j], stages[i]]
      return { ...u, stages }
    }),
  }
}
export function removeStage(s: PipelineStructure, stageId: string): PipelineStructure {
  return { umbrellas: s.umbrellas.map((u) => ({ ...u, stages: u.stages.filter((st) => st.id !== stageId) })) }
}
export function addCategory(s: PipelineStructure): PipelineStructure {
  const color = CATEGORY_COLORS[s.umbrellas.length % CATEGORY_COLORS.length]
  const fresh: CategoryDef = { id: rid('c'), label: 'New category', color, role: null, stages: [{ id: rid('s'), name: 'New stage' }] }
  // Insert just before Booked so new categories are middles (Booked + Post Show
  // stay pinned at the bottom).
  const bookedIdx = s.umbrellas.findIndex((u) => u.role === 'booked')
  const at = bookedIdx === -1 ? s.umbrellas.length : bookedIdx
  const umbrellas = [...s.umbrellas.slice(0, at), fresh, ...s.umbrellas.slice(at)]
  return { umbrellas }
}
export function renameCategory(s: PipelineStructure, categoryId: string, label: string): PipelineStructure {
  return { umbrellas: s.umbrellas.map((u) => (u.id === categoryId ? { ...u, label } : u)) }
}
export function recolorCategory(s: PipelineStructure, categoryId: string, color: string): PipelineStructure {
  return { umbrellas: s.umbrellas.map((u) => (u.id === categoryId ? { ...u, color } : u)) }
}
export function removeCategory(s: PipelineStructure, categoryId: string): PipelineStructure {
  return { umbrellas: s.umbrellas.filter((u) => u.id !== categoryId) }
}
// Move a middle category up/down among the other middle categories. The first slot
// (Inquiry) and the last two slots (Booked, then Post Show) are reserved, so a
// middle can only move within [1, length-3].
export function reorderCategory(s: PipelineStructure, categoryId: string, dir: -1 | 1): PipelineStructure {
  const arr = s.umbrellas.slice()
  const i = arr.findIndex((u) => u.id === categoryId)
  const j = i + dir
  if (i < 0 || j <= 0 || j >= arr.length - 2) return s
  ;[arr[i], arr[j]] = [arr[j], arr[i]]
  return { umbrellas: arr }
}

// Sort by event date, soonest first; undated projects sink to the bottom.
export function byEventDateAsc(a: Project, b: Project): number {
  return (a.eventDate || '9999-99-99').localeCompare(b.eventDate || '9999-99-99')
}

// --- Display helpers ----------------------------------------------------------

export function formatEventDate(iso: string): string {
  if (!iso) return 'Date TBD'
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${months[m - 1]} ${d}, ${y}`
}

export function formatFee(fee: number | null): string {
  if (fee == null) return 'Quote TBD'
  return `$${fee.toLocaleString('en-US')}`
}

// Local today as YYYY-MM-DD (ISO date strings compare lexicographically).
export function todayISO(): string {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

export const EVENT_TYPE_ACCENT: Record<EventType, string> = {
  Wedding: 'var(--color-umb-postcall)',
  Corporate: 'var(--color-umb-booked)',
  'Private Event': 'var(--color-brass)',
  'Bachelor(ette) Party': 'var(--color-umb-inquiry)',
  Other: 'var(--color-faint)',
}
