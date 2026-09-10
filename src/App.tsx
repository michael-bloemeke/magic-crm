import { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { Sidebar, type Page } from './components/Sidebar'
import { SettingsPage } from './components/SettingsPage'
import { PipelineBoard } from './components/PipelineBoard'
import { PipelineFlow } from './components/PipelineFlow'
import { PipelineCards } from './components/PipelineCards'
import { ProjectDetail } from './components/ProjectDetail'
import { ProjectView } from './components/ProjectView'
import { ContactDetail } from './components/ContactDetail'
import { ProjectContactPickerModal } from './components/ProjectContactPickerModal'
import { HomePage } from './components/HomePage'
import { TasksPage } from './components/TasksPage'
import { InboxPage } from './components/InboxPage'
import { CalendarPage } from './components/CalendarPage'
import { FinancePage } from './components/FinancePage'
import { WebsiteAnalyticsPage } from './components/WebsiteAnalyticsPage'
import { ProposalsPage } from './components/ProposalsPage'
import { PreviewPage, type PreviewTarget } from './components/PreviewPage'
import { StatsPage } from './components/StatsPage'
import { ContactsPage } from './components/ContactsPage'
import { FilesPage } from './components/FilesPage'
import { RecordsPage } from './components/RecordsPage'
import { DeletedPage } from './components/DeletedPage'
import { ArchiveReasonModal } from './components/ArchiveReasonModal'
import { CompleteProjectModal, type CompletePayload } from './components/CompleteProjectModal'
import { NewProjectModal } from './components/NewProjectModal'
import { ConfirmDialog } from './components/ConfirmDialog'
import { DepositPaidModal } from './components/DepositPaidModal'
import { CallLogModal, type CallLog } from './components/CallLogModal'
import { Notifications } from './components/Notifications'
import { SearchPalette } from './components/SearchPalette'
import { PipelineDeleteDialog, type DeleteBlock } from './components/PipelineDeleteDialog'
import {
  buildPipeline,
  bookedStageIds,
  postshowStageIds,
  todayISO,
  DEFAULT_STRUCTURE,
  ORPHAN_STAGE_ID,
  addStage as structAddStage,
  renameStage as structRenameStage,
  reorderStage as structReorderStage,
  removeStage as structRemoveStage,
  addCategory as structAddCategory,
  renameCategory as structRenameCategory,
  recolorCategory as structRecolorCategory,
  removeCategory as structRemoveCategory,
  reorderCategory as structReorderCategory,
  type PipelineStructure,
  type Project,
} from './pipeline'
import {
  loadProjects,
  loadTasks,
  loadUnreadByProject,
  loadInquiries,
  checkInquiries,
  dismissInquiry,
  type InquiryNotification,
  loadStatusNotifications,
  checkStatusNotifications,
  markStatusNotificationSeen,
  type StatusNotification,
  saveStage,
  loadStructure,
  saveStructure as apiSaveStructure,
  reassignStage as apiReassignStage,
  saveProjectField as apiSaveField,
  logCall as apiLogCall,
  archiveProject as apiArchive,
  completeProject as apiComplete,
  restoreProject as apiRestore,
  deleteProject as apiDelete,
  purgeProject as apiPurge,
  loadConfig,
  saveConfig,
  loadPayments,
  loadContacts,
  loadLinks,
  loadGigsEvents,
  type GigEvent,
  linkContact as apiLinkContact,
  unlinkContact as apiUnlinkContact,
  addContact as apiAddContact,
  updateContact as apiUpdateContact,
  deleteContact as apiDeleteContact,
  isReceivedPayment,
  addTask as apiAddTask,
  setTaskDone,
  editTask as apiEditTask,
  removeTask,
  type Task,
  type Payment,
  type Contact,
  type ContactType,
  type ProjectLinks,
} from './api'
import { linkedProjectsFor, contactsForProject } from './contacts'

type View = 'flow' | 'board' | 'cards'

const PAGE_META: Record<Page, { kicker: string; title: string }> = {
  home: { kicker: 'Home', title: 'Home' },
  pipeline: { kicker: 'Pipeline', title: 'The Pipeline' },
  inbox: { kicker: 'Inbox', title: 'Inbox' },
  tasks: { kicker: 'Tasks', title: 'Tasks' },
  calendar: { kicker: 'Calendar', title: 'Calendar' },
  finance: { kicker: 'Finance', title: 'Finance' },
  stats: { kicker: 'Stats', title: 'Lead Stats' },
  proposals: { kicker: 'Proposals', title: 'Proposals and Booking Forms' },
  website: { kicker: 'Website', title: 'Website Analytics' },
  contacts: { kicker: 'Contacts', title: 'Contacts' },
  files: { kicker: 'Library', title: 'Files' },
  completed: { kicker: 'Records', title: 'Completed' },
  archive: { kicker: 'Records', title: 'Archive' },
  deleted: { kicker: 'Records', title: 'Deleted' },
  settings: { kicker: 'System', title: 'Settings' },
}

// Back-button history tracks only real SCREENS (page / view / full-page project),
// never side panes or popups. Opening/closing a contact or project side pane must
// not create a history entry, otherwise closing a pane leaves an entry that Back
// would immediately re-open (an infinite loop). Panes are closed on Back instead.
type NavSnap = {
  page: Page
  view: View
  fullProjectId: string | null
}

function App() {
  // Remember which screen Michael is on so a page refresh lands him back where he
  // was instead of bouncing to Home.
  const [view, setView] = useState<View>(() => {
    const saved = localStorage.getItem('crm:view')
    return saved === 'board' || saved === 'flow' || saved === 'cards' ? saved : 'flow'
  })
  const [page, setPage] = useState<Page>(() => {
    const saved = localStorage.getItem('crm:page')
    return saved && saved in PAGE_META ? (saved as Page) : 'home'
  })
  const [selected, setSelected] = useState<Project | null>(null)
  const [fullProject, setFullProject] = useState<Project | null>(null)
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [tasks, setTasks] = useState<Task[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [unread, setUnread] = useState<Record<string, number>>({})
  const [inquiries, setInquiries] = useState<InquiryNotification[]>([])
  const [statusNotifs, setStatusNotifs] = useState<StatusNotification[]>([])
  const [archiveTarget, setArchiveTarget] = useState<Project | null>(null)
  const [completeTarget, setCompleteTarget] = useState<Project | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null)
  const [purgeTarget, setPurgeTarget] = useState<Project | null>(null)
  // The booked-stage move that's waiting on a payment (modal logs one, then proceeds).
  const [depositTarget, setDepositTarget] = useState<{ project: Project; stageId: string } | null>(null)
  // The project whose "Made a call" log flow is open.
  const [callTarget, setCallTarget] = useState<Project | null>(null)
  const [newProjectOpen, setNewProjectOpen] = useState(false)
  // Editable pipeline structure (categories + stages) + the board's edit mode.
  const [structure, setStructure] = useState<PipelineStructure>(DEFAULT_STRUCTURE)
  const [editMode, setEditMode] = useState(false)
  const [deleteBlock, setDeleteBlock] = useState<DeleteBlock | null>(null)
  const [archiveReasons, setArchiveReasons] = useState<string[]>([])
  const [payments, setPayments] = useState<Payment[]>([])
  const [contacts, setContacts] = useState<Contact[]>([])
  const [links, setLinks] = useState<ProjectLinks>({})
  // Manually-added Google "Gigs" calendar events, pulled in for the Calendar page + conflict detection.
  const [gigEvents, setGigEvents] = useState<GigEvent[]>([])
  const [pendingContactId, setPendingContactId] = useState<string | null>(null)
  const [contactPane, setContactPane] = useState<Contact | null>(null) // a contact open in the side pane
  const [contactPickerProject, setContactPickerProject] = useState<Project | null>(null)
  const [tagLibrary, setTagLibrary] = useState<string[]>([])
  // Cmd/Ctrl-K opens global search from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Persist the current screen so a refresh restores it (see the initial state
  // above + the project-restore step in the data-load effect).
  useEffect(() => {
    localStorage.setItem('crm:page', page)
  }, [page])
  useEffect(() => {
    localStorage.setItem('crm:view', view)
  }, [view])
  // Remember the open full-screen project (by id) so a refresh keeps it open.
  useEffect(() => {
    if (fullProject) localStorage.setItem('crm:project', fullProject.id)
    else localStorage.removeItem('crm:project')
  }, [fullProject])

  // --- Back-to-previous-screen + scroll restoration ---------------------------
  // When a project opens full-screen, remember which screen + scroll position we
  // came from so the project view's Back button can return there exactly.
  const contentRef = useRef<HTMLDivElement>(null)
  const backRef = useRef<{ page: Page; view: View; top: number; left: number } | null>(null)
  const restoreRef = useRef<{ top: number; left: number } | null>(null)
  // The full-screen project that was open before a refresh. Captured once at the
  // first render (before the persist effect can clear it) so the data-load effect
  // can re-open it after projects arrive.
  const pendingProjectId = useRef<string | null>(localStorage.getItem('crm:project'))

  const captureScroll = () => {
    const el = contentRef.current?.querySelector('.board-scroll') as HTMLElement | null
    return { top: el?.scrollTop ?? 0, left: el?.scrollLeft ?? 0 }
  }

  // The embedded proposal / booking-form viewer. See PreviewPage for why it is an iframe of the
  // real URL rather than a re-render, and for the rule that its src is always the server-built
  // flagged link so a preview can never count as a view.
  const [preview, setPreview] = useState<PreviewTarget | null>(null)
  const closePreview = () => setPreview(null)

  // Navigation history for the global Back button. Snapshots are tiny (ids + page), capped at 50.
  const [history, setHistory] = useState<NavSnap[]>([])
  const lastNav = useRef<NavSnap | null>(null)
  const restoringBack = useRef(false)
  // Timestamp of the last local optimistic edit. The background refresh uses this so it never
  // overwrites a just-made change with stale server data (an in-flight fetch that started before the
  // edit, or the server cache a beat behind the write). This is what made audit sign-offs "pop back
  // up": a refresh landing right after a click reverted the project to unsigned.
  const lastEditAt = useRef(0)

  // Open a project: full page (primary) or the side pane.
  const openFull = (p: Project) => {
    setPreview(null)
    if (!fullProject) {
      const s = captureScroll() // capture the page we're leaving (not when project->project)
      backRef.current = { page, view, top: s.top, left: s.left }
    }
    setContactPane(null)
    setSelected(null)
    setFullProject(p)
  }
  const openSide = (p: Project) => {
    setPreview(null)
    setContactPane(null)
    setFullProject(null)
    setSelected(p)
  }
  const openProjectById = (id: string) => {
    const p = (projects ?? []).find((x) => x.id === id)
    if (p) openFull(p)
  }
  // Back: pop the last recorded location and restore it (page/view/open-project/open-contact),
  // walking back through the whole session. Null-safe so a deleted project/contact just clears.
  const goBack = () => {
    // The preview sits on top of whatever screen opened it, so Back closes that first rather than
    // popping the history and skipping a screen.
    if (preview) {
      setPreview(null)
      return
    }
    setHistory((h) => {
      if (h.length === 0) return h
      const prev = h[h.length - 1]
      restoringBack.current = true
      setPage(prev.page)
      setView(prev.view)
      setFullProject(prev.fullProjectId ? (projects ?? []).find((p) => p.id === prev.fullProjectId) ?? null : null)
      // Back navigates screens only. Always close any open side/contact pane so a
      // pane can never be re-opened by Back.
      setSelected(null)
      setContactPane(null)
      return h.slice(0, -1)
    })
  }

  // Record the location we are leaving whenever the nav state changes (skipped while going Back).
  useEffect(() => {
    const snap: NavSnap = {
      page,
      view,
      fullProjectId: fullProject?.id ?? null,
    }
    const prev = lastNav.current
    lastNav.current = snap
    if (restoringBack.current) {
      restoringBack.current = false
      return
    }
    if (
      prev &&
      (prev.page !== snap.page ||
        prev.view !== snap.view ||
        prev.fullProjectId !== snap.fullProjectId)
    ) {
      setHistory((h) => [...h.slice(-49), prev])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, view, fullProject])

  // After returning from a project view, restore the previous scroll position.
  useEffect(() => {
    if (fullProject) return
    const s = restoreRef.current
    if (!s) return
    restoreRef.current = null
    const id = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const el = contentRef.current?.querySelector('.board-scroll') as HTMLElement | null
        if (el) {
          el.scrollTop = s.top
          el.scrollLeft = s.left
        }
      }),
    )
    return () => cancelAnimationFrame(id)
  }, [fullProject])

  useEffect(() => {
    let alive = true
    loadProjects()
      .then((p) => {
        if (!alive) return
        setProjects(p)
        // Re-open the project that was open before a refresh (if it still exists).
        const savedId = pendingProjectId.current
        if (savedId) {
          const proj = p.find((x) => x.id === savedId)
          if (proj) {
            backRef.current = { page, view, top: 0, left: 0 }
            setFullProject(proj)
          }
        }
      })
      .catch((e) => alive && setError(String(e?.message || e)))
    loadTasks()
      .then((t) => alive && setTasks(t))
      .catch(() => alive && setTasks([]))
    loadUnreadByProject()
      .then((u) => alive && setUnread(u))
      .catch(() => {})
    loadConfig()
      .then((c) => {
        if (!alive) return
        setArchiveReasons(c.archiveReasons)
        setTagLibrary(c.contactTags ?? [])
      })
      .catch(() => {})
    loadPayments()
      .then((p) => alive && setPayments(p))
      .catch(() => {})
    loadContacts()
      .then((c) => alive && setContacts(c))
      .catch(() => {})
    loadLinks()
      .then((l) => alive && setLinks(l))
      .catch(() => {})
    loadStructure()
      .then((s) => alive && setStructure(s))
      .catch(() => {})
    loadGigs()
    return () => {
      alive = false
    }
  }, [])

  const allProjects = projects ?? []
  const allTasks = tasks ?? []
  const pipeline = useMemo(() => buildPipeline(allProjects, structure), [allProjects, structure])
  const bookedIds = useMemo(() => bookedStageIds(structure), [structure])
  const postshowIds = useMemo(() => postshowStageIds(structure), [structure])
  const activeProjects = useMemo(() => allProjects.filter((p) => p.bucket === 'active'), [allProjects])
  const archivedProjects = useMemo(() => allProjects.filter((p) => p.bucket === 'archived'), [allProjects])
  const completedProjects = useMemo(() => allProjects.filter((p) => p.bucket === 'completed'), [allProjects])
  const deletedProjects = useMemo(() => allProjects.filter((p) => p.bucket === 'deleted'), [allProjects])
  // Everything except the trash: what Stats and global search should consider.
  const liveProjects = useMemo(() => allProjects.filter((p) => p.bucket !== 'deleted'), [allProjects])
  const deletedProjectIds = useMemo(() => new Set(deletedProjects.map((p) => p.id)), [deletedProjects])
  // Tasks and notifications tied to a trashed project are hidden from the global lists,
  // calendar, badges, and the bell (they still show on the deleted project itself, and
  // come back on restore). A task/notification with no project is always live.
  const liveTasks = useMemo(
    () => allTasks.filter((t) => !t.projectId || !deletedProjectIds.has(t.projectId)),
    [allTasks, deletedProjectIds],
  )
  const liveStatusNotifs = useMemo(
    () => statusNotifs.filter((n) => !n.projectId || !deletedProjectIds.has(n.projectId)),
    [statusNotifs, deletedProjectIds],
  )
  const activeCount = activeProjects.length
  const inboxUnread = useMemo(() => Object.values(unread).reduce((a, b) => a + b, 0), [unread])

  const today = todayISO()
  const taskAlerts = liveTasks.filter((t) => !t.done && t.dueDate && t.dueDate <= today).length
  const overdueCount = liveTasks.filter((t) => !t.done && t.dueDate && t.dueDate < today).length
  const dueTodayCount = liveTasks.filter((t) => !t.done && t.dueDate === today).length
  const upcomingCount = liveTasks.filter((t) => !t.done && (!t.dueDate || t.dueDate > today)).length

  // THE THREE COUNTERS, defined once so they cannot drift or double-count (Michael, 2026-08-16):
  //
  //   Tasks badge (sidebar) = tasks due today or overdue.       -> taskAlerts
  //   Bell badge            = everything else needing a look.   -> bellCount
  //   App icon (dock/phone) = the two added together.
  //
  // A due task used to be counted by BOTH the Tasks badge and the bell, so one task read as two
  // things to deal with. It now belongs to the Tasks badge alone.
  //
  // Unread mail is part of the bell and is derived from the live Gmail sync rather than stored, so
  // reading a message in Gmail drops it from the bell on the next sync with nothing to dismiss.
  const bellCount = liveStatusNotifs.length + inquiries.length + inboxUnread

  useEffect(() => {
    window.crm?.setBadge?.(taskAlerts + bellCount)
  }, [taskAlerts, bellCount])

  const todayLabel = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'

  // Payments: which active projects have a pending payment (flagged on cards/
  // rows), and whether a project has a received payment (gates Deposit Paid).
  const pendingPaymentIds = useMemo(
    () => new Set(payments.filter((p) => p.pending && p.amount > 0).map((p) => p.projectId)),
    [payments],
  )
  // For each project, the OTHER commitments on its event date (other CRM projects + manually-added
  // Google "Gigs" events) = a potential double-booking. Archived leads are ignored. A date is only
  // flagged when it's actionable: a Gigs event sits on it, or at least one CRM project on it is active
  // (so purely-historical same-day completed gigs don't nag). The map value is the list of conflicting
  // names/titles (shown on hover in the open project); dateConflictIds is just its key set (for cards).
  const dateConflictInfo = useMemo(() => {
    const byDate = new Map<string, { crm: { id: string; name: string; active: boolean }[]; gigs: string[] }>()
    for (const p of allProjects) {
      if (p.bucket !== 'active' && p.bucket !== 'completed') continue
      if (!/^\d{4}-\d{2}-\d{2}$/.test(p.eventDate || '')) continue
      const g = byDate.get(p.eventDate) ?? { crm: [], gigs: [] }
      g.crm.push({ id: p.id, name: p.client, active: p.bucket === 'active' })
      byDate.set(p.eventDate, g)
    }
    for (const e of gigEvents) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) continue
      const g = byDate.get(e.date) ?? { crm: [], gigs: [] }
      g.gigs.push(e.title)
      byDate.set(e.date, g)
    }
    const info = new Map<string, string[]>()
    for (const g of byDate.values()) {
      const actionable = g.gigs.length > 0 || g.crm.some((c) => c.active)
      if (!actionable) continue
      for (const c of g.crm) {
        const partners = [
          ...g.crm.filter((o) => o.id !== c.id).map((o) => o.name),
          ...g.gigs.map((t) => `${t} (Gigs calendar)`),
        ]
        if (partners.length > 0) info.set(c.id, partners)
      }
    }
    return info
  }, [allProjects, gigEvents])
  const dateConflictIds = useMemo(() => new Set(dateConflictInfo.keys()), [dateConflictInfo])
  const hasReceivedPayment = (projectId: string) =>
    payments.some((p) => p.projectId === projectId && isReceivedPayment(p))
  // Keep the global payments list in sync when a PaymentsEditor mutates a project.
  const syncPayments = (projectId: string, list: Payment[]) =>
    setPayments((prev) => [...prev.filter((p) => p.projectId !== projectId), ...list])

  // --- Stage + task + field mutations (optimistic, persisted to the CRM files) -

  const doSetStage = (id: string, stageId: string) => {
    setProjects((prev) => (prev ? prev.map((p) => (p.id === id ? { ...p, stageId } : p)) : prev))
    setSelected((prev) => (prev && prev.id === id ? { ...prev, stageId } : prev))
    setFullProject((prev) => (prev && prev.id === id ? { ...prev, stageId } : prev))
    saveStage(id, stageId).catch(reloadProjects)
  }
  const changeStage = (id: string, stageId: string) => {
    const cur = allProjects.find((p) => p.id === id)
    if (cur && cur.stageId === stageId) return // no change (e.g. dropped on the same column)
    lastEditAt.current = Date.now()
    // Post Show is auto-only: projects can be moved OUT of it but never INTO it
    // manually (they arrive the day after the event). Silently ignore such a move.
    if (postshowIds.has(stageId)) return
    // Any stage in the Booked category requires a recorded payment first; gate it
    // through a modal that logs one, then proceeds to the chosen stage.
    if (bookedIds.has(stageId) && !hasReceivedPayment(id)) {
      if (cur) setDepositTarget({ project: cur, stageId })
      return
    }
    doSetStage(id, stageId)
  }

  // Inline edit of a project detail field: optimistic update + persist to JSON.
  const saveField = (id: string, field: string, value: string) => {
    lastEditAt.current = Date.now()
    let v: string | number | boolean | null = value
    if (field === 'totalFee' || field === 'mileage' || field === 'tips') {
      const n = Number(String(value).replace(/[^0-9.]/g, ''))
      v = value === '' || Number.isNaN(n) ? null : n
    } else if (field === 'signedOff') {
      v = value === 'true'
    }
    const apply = (p: Project) => (p.id === id ? ({ ...p, [field]: v } as Project) : p)
    setProjects((prev) => (prev ? prev.map(apply) : prev))
    setSelected((prev) => (prev && prev.id === id ? ({ ...prev, [field]: v } as Project) : prev))
    setFullProject((prev) => (prev && prev.id === id ? ({ ...prev, [field]: v } as Project) : prev))
    apiSaveField(id, field, value).catch(reloadProjects)
  }

  // Log a "made a call" entry; the server appends to the activity log and returns
  // the updated log, which we patch into the open project.
  const doLogCall = (project: Project, payload: CallLog) => {
    setCallTarget(null)
    apiLogCall({ id: project.id, ...payload })
      .then(({ activityLog }) => applyPatch(project.id, { activityLog }))
      .catch(reloadProjects)
  }

  // Move a project between buckets (Archive / Complete / Restore). Optimistic so
  // the project leaves the pipeline immediately, then a reload syncs the records.
  // The reload also re-syncs any open pane from the canonical record (so a moved
  // or edited project shows the server's fields, e.g. the new activity-log line).
  // Universal refresh: re-pull every data set the app reads on load, without a full reload.
  // Pull the manually-added Google "Gigs" events over a wide window (last year through +2 years) so
  // they show on the Calendar and feed the date-conflict check. Best-effort; empty if not connected.
  const loadGigs = () => {
    const y = new Date().getFullYear()
    const from = `${y - 1}-01-01`
    const to = `${y + 2}-12-31`
    loadGigsEvents(from, to).then(setGigEvents).catch(() => {})
  }

  const refreshAll = () => {
    loadProjects().then(setProjects).catch(() => {})
    loadTasks().then(setTasks).catch(() => {})
    loadGigs()
    loadUnreadByProject().then(setUnread).catch(() => {})
    loadConfig()
      .then((c) => {
        setArchiveReasons(c.archiveReasons)
        setTagLibrary(c.contactTags ?? [])
      })
      .catch(() => {})
    loadPayments().then(setPayments).catch(() => {})
    loadContacts().then(setContacts).catch(() => {})
    loadLinks().then(setLinks).catch(() => {})
    loadStructure().then(setStructure).catch(() => {})
    loadStatusNotifications()
      .then(setStatusNotifs)
      .catch(() => {})
    loadInquiries()
      .then((d) => setInquiries(d.notifications))
      .catch(() => {})
  }

  const reloadProjects = () => {
    loadProjects()
      .then((fresh) => {
        setProjects(fresh)
        setSelected((prev) => (prev ? fresh.find((p) => p.id === prev.id) ?? null : prev))
        setFullProject((prev) => (prev ? fresh.find((p) => p.id === prev.id) ?? prev : prev))
      })
      .catch(() => {})
  }

  // --- Live refresh from Supabase (edits made on the phone / in Cowork / via Claude Code) ----------
  // The server keeps its cache ~15s fresh; the UI pulls that fresh data on window-focus and on a slow
  // interval so it reflects external changes without a manual reload. This runs in the BACKGROUND, so
  // it must never yank the user: we skip a tick entirely while a modal is open, the pipeline is in
  // edit mode, or focus is in an editable field (an in-progress inline edit or rename would otherwise
  // get clobbered when its `value` prop changes). When it does run it only refreshes list/collection
  // data and re-syncs any open pane BY ID (never opening/closing panes or moving scroll).
  const modalOpen =
    !!archiveTarget ||
    !!completeTarget ||
    !!deleteTarget ||
    !!purgeTarget ||
    !!depositTarget ||
    !!callTarget ||
    !!contactPickerProject ||
    !!deleteBlock ||
    newProjectOpen ||
    searchOpen
  // Latest values the background refresh needs, without re-subscribing its effect on every change.
  const bgGuards = useRef({ modalOpen, editMode })
  bgGuards.current = { modalOpen, editMode }

  // True while the user is actively typing/focused in a text field (so a refresh won't overwrite it).
  const isEditingActive = () => {
    const el = document.activeElement as HTMLElement | null
    if (!el) return false
    const tag = el.tagName
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
  }

  // Pull the live collections and merge them into state without disturbing the current view. Open
  // panes are re-synced by id (same as reloadProjects); the structure is only refreshed when the
  // pipeline is NOT in edit mode (so a rename in progress on the board is never clobbered).
  const backgroundRefresh = () => {
    const g = bgGuards.current
    if (g.modalOpen || isEditingActive()) return
    // Just made a local edit? Hold off a beat so the write settles and we don't clobber it (this is
    // what fixes audit sign-offs reverting).
    if (Date.now() - lastEditAt.current < 2500) return
    const startedAt = Date.now()
    loadProjects()
      .then((fresh) => {
        // If an edit landed after this fetch began, the fetched data predates it — discard it.
        if (lastEditAt.current > startedAt) return
        setProjects(fresh)
        setSelected((prev) => (prev ? fresh.find((p) => p.id === prev.id) ?? null : prev))
        setFullProject((prev) => (prev ? fresh.find((p) => p.id === prev.id) ?? prev : prev))
      })
      .catch(() => {})
    loadTasks().then(setTasks).catch(() => {})
    loadPayments().then(setPayments).catch(() => {})
    loadContacts().then(setContacts).catch(() => {})
    loadLinks().then(setLinks).catch(() => {})
    loadGigs()
    loadUnreadByProject().then(setUnread).catch(() => {})
    if (!g.editMode) loadStructure().then(setStructure).catch(() => {})
  }

  useEffect(() => {
    // Refresh on a ~20s interval and whenever the window regains focus / the tab becomes visible
    // (the common case: Michael edited something on his phone, then comes back to the Mac).
    const timer = setInterval(backgroundRefresh, 20 * 1000)
    const onFocus = () => backgroundRefresh()
    const onVisible = () => { if (document.visibilityState === 'visible') backgroundRefresh() }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Poll Notion for new HoneyBook inquiries: import any new ones (server-side), refresh the
  // in-app notification list, and reload projects when some were created so they show up in the
  // pipeline. Quietly does nothing if the Notion sync isn't configured.
  useEffect(() => {
    let alive = true
    let running = false
    const run = async () => {
      if (running) return // avoid stacking overlapping checks (interval + focus)
      running = true
      try {
        const r = await checkInquiries()
        if (r?.importedCount && r.importedCount > 0) reloadProjects()
        const d = await loadInquiries()
        if (alive) setInquiries(d.notifications)
      } catch {
        // not configured / offline — ignore
      } finally {
        running = false
      }
    }
    run()
    // Poll the website-inquiry relay every 20s (was 5 min) so new inquiries show up fast.
    const timer = setInterval(run, 20 * 1000)
    // And check immediately whenever the CRM window regains focus / becomes visible,
    // so an inquiry that just arrived appears the moment Michael looks at the app.
    const onFocus = () => run()
    const onVisible = () => { if (document.visibilityState === 'visible') run() }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  const dismissInquiryNotif = (blockId: string) => {
    setInquiries((prev) => prev.filter((i) => i.blockId !== blockId))
    dismissInquiry(blockId).catch(() => {})
  }

  // Poll for status-change notifications (invoice paid, contract viewed/signed). The sweep runs on
  // the server (polls QuickBooks + SignWell); here we just refresh the bell list on a timer.
  useEffect(() => {
    let alive = true
    const run = async () => {
      try {
        const list = await checkStatusNotifications()
        if (alive) setStatusNotifs(list)
      } catch {
        // offline or not configured, ignore
      }
    }
    loadStatusNotifications()
      .then((l) => alive && setStatusNotifs(l))
      .catch(() => {})
    run()
    const timer = setInterval(run, 3 * 60 * 1000)
    return () => {
      alive = false
      clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const dismissStatusNotif = (id: string) => {
    setStatusNotifs((prev) => prev.filter((n) => n.id !== id))
    markStatusNotificationSeen(id).catch(() => {})
  }

  const applyPatch = (id: string, patch: Partial<Project>) => {
    lastEditAt.current = Date.now()
    const apply = (p: Project) => (p.id === id ? { ...p, ...patch } : p)
    setProjects((prev) => (prev ? prev.map(apply) : prev))
    setSelected((prev) => (prev && prev.id === id ? { ...prev, ...patch } : prev))
    setFullProject((prev) => (prev && prev.id === id ? { ...prev, ...patch } : prev))
  }
  // A project leaving the pipeline shouldn't keep its unread count in the
  // sidebar/inbox tally (the Inbox page only counts active projects).
  const dropUnread = (id: string) =>
    setUnread((prev) => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
  // Decrement a project's unread badge when threads are marked read / replied to.
  const clearProjectUnread = (id: string, count: number) =>
    setUnread((prev) => {
      const cur = prev[id] || 0
      if (!cur) return prev
      const next = { ...prev }
      const remaining = cur - count
      if (remaining > 0) next[id] = remaining
      else delete next[id]
      return next
    })
  const doArchive = (id: string, reason: string) => {
    applyPatch(id, { bucket: 'archived', archiveReason: reason, stageId: '' })
    dropUnread(id)
    apiArchive(id, reason).then(reloadProjects).catch(reloadProjects)
  }
  const doComplete = (id: string) => {
    applyPatch(id, { bucket: 'completed', completedDate: today, stageId: '' })
    dropUnread(id)
    apiComplete(id).then(reloadProjects).catch(reloadProjects)
  }
  // Completion goes through the modal so mileage + event date + a payment are
  // recorded first. Payments are logged live inside the modal (PaymentsEditor),
  // so here we only persist mileage/date and move the project to Completed.
  const finishComplete = (project: Project, data: CompletePayload) => {
    setCompleteTarget(null)
    if (data.mileage !== (project.mileage ?? null)) saveField(project.id, 'mileage', String(data.mileage))
    if (data.eventDate && data.eventDate !== project.eventDate) saveField(project.id, 'eventDate', data.eventDate)
    doComplete(project.id)
  }
  const doRestore = (id: string) => {
    applyPatch(id, { bucket: 'active', archiveReason: '', completedDate: '' })
    apiRestore(id).then(reloadProjects).catch(reloadProjects)
  }
  // Soft delete: move the project to the 30-day trash. It leaves the pipeline (and any
  // open pane) immediately but stays in allProjects with bucket='deleted', so it shows
  // on the Deleted page. Nothing is destroyed; a restore is lossless.
  const doDelete = (id: string) => {
    applyPatch(id, { bucket: 'deleted', stageId: '', deletedAt: new Date().toISOString() })
    setSelected((prev) => (prev && prev.id === id ? null : prev))
    setFullProject((prev) => (prev && prev.id === id ? null : prev))
    dropUnread(id)
    // Do NOT swallow a server failure here. This used to be `.catch(reloadProjects)`, which showed
    // the optimistic patch, silently discarded the error, then reloaded the unchanged row so the
    // project reappeared exactly as it was. That is indistinguishable from "delete does nothing".
    // Trigger: 2026-08-31, two projects that could not be deleted with no error shown anywhere.
    apiDelete(id)
      .then(reloadProjects)
      .catch((e) => {
        reloadProjects()
        setError(`Could not delete that project: ${String((e as Error)?.message || e)}`)
      })
  }
  // Permanent delete (full cascade, no undo): drop the project + its tasks from the
  // local lists, close any open view, and tell the server to purge everything.
  const doPurge = (id: string) => {
    setProjects((prev) => (prev ? prev.filter((p) => p.id !== id) : prev))
    setTasks((prev) => (prev ? prev.filter((t) => t.projectId !== id) : prev))
    setSelected((prev) => (prev && prev.id === id ? null : prev))
    setFullProject((prev) => (prev && prev.id === id ? null : prev))
    dropUnread(id)
    apiPurge(id).catch(reloadProjects)
  }

  // --- Contacts on a project --------------------------------------------------
  // The project<->contact link is an explicit stored list of contact ids
  // (crm-links.json). Linking/unlinking edits that list by id, so renaming a
  // contact never breaks the link and nothing is ever auto-recreated.
  const patchContact = (id: string, patch: Partial<Contact>) => {
    setContacts((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)))
    setContactPane((prev) => (prev && prev.id === id ? { ...prev, ...patch } : prev))
    apiUpdateContact({ id, ...patch }).catch(() => loadContacts().then(setContacts).catch(() => {}))
  }
  const removeContactRecord = (id: string) => {
    setContacts((prev) => prev.filter((c) => c.id !== id))
    setContactPane((prev) => (prev && prev.id === id ? null : prev))
    // The server purges this contact from every project's link list; mirror that
    // locally so its cards disappear without a reload.
    setLinks((prev) => {
      const next: ProjectLinks = {}
      for (const [pid, ids] of Object.entries(prev)) next[pid] = ids.filter((x) => x !== id)
      return next
    })
    apiDeleteContact(id).catch(() => {})
  }
  const registerTag = (tag: string) => {
    setTagLibrary((prev) => (prev.some((t) => t.toLowerCase() === tag.toLowerCase()) ? prev : [...prev, tag]))
    saveConfig({ contactTags: [...tagLibrary, tag] }).catch(() => {})
  }
  const linkContactToProject = (project: Project, c: Contact) => {
    setLinks((prev) => {
      const ids = prev[project.id] || []
      return ids.includes(c.id) ? prev : { ...prev, [project.id]: [...ids, c.id] }
    })
    apiLinkContact(project.id, c.id)
      .then(setLinks)
      .catch(() => loadLinks().then(setLinks).catch(() => {}))
  }
  const unlinkContactFromProject = (project: Project, c: Contact) => {
    setLinks((prev) => ({ ...prev, [project.id]: (prev[project.id] || []).filter((x) => x !== c.id) }))
    apiUnlinkContact(project.id, c.id)
      .then(setLinks)
      .catch(() => loadLinks().then(setLinks).catch(() => {}))
  }
  const createAndLinkContact = async (
    project: Project,
    details: { name: string; email?: string; phone?: string; type?: ContactType },
  ) => {
    try {
      const c = await apiAddContact({
        name: details.name.trim(),
        type: details.type || 'client',
        emails: details.email ? [details.email.trim()] : [],
        phones: details.phone ? [details.phone.trim()] : [],
      })
      setContacts((prev) => [...prev, c])
      linkContactToProject(project, c)
    } catch {
      // non-fatal
    }
  }

  // --- Editable pipeline structure -------------------------------------------
  // Apply a new structure optimistically, then persist (the server re-normalizes
  // and returns the canonical version, which we adopt).
  const applyStructure = (next: PipelineStructure) => {
    setStructure(next)
    apiSaveStructure(next)
      .then(setStructure)
      .catch(() => loadStructure().then(setStructure).catch(() => {}))
  }
  const activeProjectsInStage = (stageId: string) =>
    allProjects.filter((p) => p.bucket === 'active' && p.stageId === stageId)
  const stageName = (stageId: string) => {
    for (const u of structure.umbrellas) for (const s of u.stages) if (s.id === stageId) return s.name
    return 'this stage'
  }

  const addStageTo = (categoryId: string) => applyStructure(structAddStage(structure, categoryId))
  const renameStageTo = (stageId: string, name: string) => applyStructure(structRenameStage(structure, stageId, name))
  const reorderStageBy = (stageId: string, dir: -1 | 1) => applyStructure(structReorderStage(structure, stageId, dir))
  const requestDeleteStage = (stageId: string) => {
    const count = activeProjectsInStage(stageId).length
    if (count > 0) {
      setDeleteBlock({ kind: 'stage', id: stageId, name: stageName(stageId), count })
      return
    }
    applyStructure(structRemoveStage(structure, stageId))
  }
  const addCategory = () => applyStructure(structAddCategory(structure))
  const renameCategoryTo = (categoryId: string, label: string) =>
    applyStructure(structRenameCategory(structure, categoryId, label))
  const recolorCategoryTo = (categoryId: string, color: string) =>
    applyStructure(structRecolorCategory(structure, categoryId, color))
  const reorderCategoryBy = (categoryId: string, dir: -1 | 1) =>
    applyStructure(structReorderCategory(structure, categoryId, dir))
  const requestDeleteCategory = (categoryId: string) => {
    const cat = structure.umbrellas.find((u) => u.id === categoryId)
    if (!cat) return
    const count = cat.stages.reduce((n, s) => n + activeProjectsInStage(s.id).length, 0)
    if (count > 0) {
      setDeleteBlock({ kind: 'category', id: categoryId, name: cat.label, count })
      return
    }
    applyStructure(structRemoveCategory(structure, categoryId))
  }
  // "Dump all projects into Inquiry": reassign every affected project to the
  // permanent Inquiry stage, then delete the stage/category, then refresh.
  const dumpAndDelete = async (block: DeleteBlock) => {
    const stageIds =
      block.kind === 'stage'
        ? [block.id]
        : (structure.umbrellas.find((u) => u.id === block.id)?.stages.map((s) => s.id) ?? [])
    setDeleteBlock(null)
    try {
      await apiReassignStage(stageIds, ORPHAN_STAGE_ID)
    } catch {
      // best effort; the orphan rule will still rehome anything left behind
    }
    const next =
      block.kind === 'stage' ? structRemoveStage(structure, block.id) : structRemoveCategory(structure, block.id)
    applyStructure(next)
    reloadProjects()
  }

  const addTaskFor = (projectId: string, title: string, dueDate: string, dueTime = '') => {
    lastEditAt.current = Date.now()
    apiAddTask({ projectId, title, dueDate, dueTime })
      .then((task) => setTasks((prev) => [...(prev ?? []), task]))
      .catch(() => {})
  }
  const toggleTask = (id: string, done: boolean) => {
    lastEditAt.current = Date.now()
    setTasks((prev) => (prev ? prev.map((t) => (t.id === id ? { ...t, done } : t)) : prev))
    setTaskDone(id, done).catch(() => {
      loadTasks().then(setTasks).catch(() => {})
    })
  }
  const deleteTask = (id: string) => {
    lastEditAt.current = Date.now()
    setTasks((prev) => (prev ? prev.filter((t) => t.id !== id) : prev))
    removeTask(id).catch(() => {
      loadTasks().then(setTasks).catch(() => {})
    })
  }
  const editTask = (id: string, patch: { title: string; dueDate: string; dueTime: string }) => {
    lastEditAt.current = Date.now()
    setTasks((prev) => (prev ? prev.map((t) => (t.id === id ? { ...t, ...patch } : t)) : prev))
    apiEditTask(id, patch).catch(() => {
      loadTasks().then(setTasks).catch(() => {})
    })
  }

  const tasksForSelected = selected ? allTasks.filter((t) => t.projectId === selected.id) : []
  const tasksForFull = fullProject ? allTasks.filter((t) => t.projectId === fullProject.id) : []

  const notifications = (
    <Notifications
      projects={liveProjects}
      inquiries={inquiries}
      onDismissInquiry={dismissInquiryNotif}
      statusNotifications={liveStatusNotifs}
      onDismissStatus={dismissStatusNotif}
      unread={unread}
      onOpenProject={openFull}
    />
  )

  const refreshBtn = (
    <button
      type="button"
      onClick={refreshAll}
      title="Refresh all data"
      aria-label="Refresh"
      className="flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-surface/60 text-muted transition-colors hover:border-line-strong hover:text-parchment"
    >
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5" />
      </svg>
    </button>
  )
  const backBtn = history.length > 0 && (
    <button
      type="button"
      onClick={goBack}
      title="Back"
      aria-label="Back"
      className="flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-surface/60 text-muted transition-colors hover:border-line-strong hover:text-parchment"
    >
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M15 6l-6 6 6 6" />
      </svg>
    </button>
  )

  const meta = PAGE_META[page]

  // THE PROPOSALS PAGE IS THE ONE PAGE ON THE WEBSITE'S OWN ROYAL-BLUE SURFACE.
  //
  // Michael's reason (2026-09-09): "that way it looks like it's a page on my website almost." The
  // blue and the damask live in ProposalsPage itself; what has to happen HERE is the page header,
  // because a light header meeting a navy content area draws a hard seam across the screen and the
  // blue reads as a panel pasted in rather than as the page. Extending it up removes the seam.
  //
  // Everything below is a ternary on this flag, so no other page's markup changes at all.
  // Which pages wear the website's look. Michael, 2026-09-09: Home, Pipeline, Proposals and a
  // project page. Damask goes only where the page is calm enough to carry it: Home and Proposals
  // have few, large elements, while the Pipeline is a map of small nodes and connector lines that
  // a repeating pattern would fight. A project page is the densest screen in the app, so it takes
  // the plain navy too.
  // EVERY page now (Michael, 2026-09-09, after seeing the first four): "add my own design to it so
  // that it looks almost like it pairs with my website well." So the ground is the default and the
  // exceptions are listed, rather than the other way round.
  //
  // ⚠️ DAMASK IS THE EXCEPTION, NOT THE RULE. It goes only where a page is a few large blocks with
  // room to breathe. Anything that is a dense list, a table, a grid of small controls or a map of
  // nodes gets plain navy, because a repeating pattern behind small type is noise. This is the
  // website's own rule (ornament goes where it carries meaning) applied to the app.
  const DAMASK_PAGES: Page[] = ['home', 'proposals', 'website', 'settings']
  const onBrand = true
  const groundClass = onBrand
    ? `brand-ground${DAMASK_PAGES.includes(page) ? ' brand-ground--damask' : ''}`
    : ''


  return (
    <div className="relative z-10 flex h-screen overflow-hidden">
      <Sidebar
        // While a project is open, highlight the nav item for where that project lives
        // (Pipeline for active, Completed/Archive otherwise) instead of the page we opened it from.
        page={
          fullProject
            ? fullProject.bucket === 'completed'
              ? 'completed'
              : fullProject.bucket === 'archived'
                ? 'archive'
                : fullProject.bucket === 'deleted'
                  ? 'deleted'
                  : 'pipeline'
            : page
        }
        onNavigate={(p) => {
          setContactPane(null)
          setFullProject(null)
          setSelected(null)
          // The preview is a full-screen takeover, so it has to come down with everything else or
          // the sidebar looks broken: the page behind changes and the screen does not.
          setPreview(null)
          setPage(p)
        }}
        taskAlerts={taskAlerts}
        inboxUnread={inboxUnread}
        onOpenSearch={() => setSearchOpen(true)}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        {preview ? (
          <PreviewPage target={preview} onBack={closePreview} />
        ) : fullProject ? (
          <ProjectView
            groundClass="brand-ground"
            project={fullProject}
            onPreview={setPreview}
            dateConflict={dateConflictIds.has(fullProject.id)}
            conflictWith={dateConflictInfo.get(fullProject.id)}
            tasks={tasksForFull}
            onChangeStage={(stageId) => changeStage(fullProject.id, stageId)}
            onSaveField={(field, value) => saveField(fullProject.id, field, value)}
            onAddTask={(title, dueDate, dueTime) => addTaskFor(fullProject.id, title, dueDate, dueTime)}
            onToggleTask={toggleTask}
            onDeleteTask={deleteTask}
            onEditTask={editTask}
            onArchive={() => setArchiveTarget(fullProject)}
            onComplete={() => setCompleteTarget(fullProject)}
            onRestore={() => doRestore(fullProject.id)}
            onDelete={() => setDeleteTarget(fullProject)}
            onPurge={() => setPurgeTarget(fullProject)}
            onLogCall={() => setCallTarget(fullProject)}
            onPaymentsChange={(pmts) => syncPayments(fullProject.id, pmts)}
            onProjectChanged={reloadProjects}
            contacts={contacts}
            links={links}
            onOpenContact={setContactPane}
            onUnlinkContact={(c) => unlinkContactFromProject(fullProject, c)}
            onAddContact={() => setContactPickerProject(fullProject)}
            onThreadRead={(count) => clearProjectUnread(fullProject.id, count)}
            onBack={goBack}
            headerRight={
              <>
                {refreshBtn}
                {notifications}
              </>
            }
            categories={structure.umbrellas}
          />
        ) : (
          <>
            {/* Header */}
            <motion.header
              key={page}
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
              className={`flex items-end justify-between gap-6 px-8 pb-7 pt-8 ${onBrand ? 'brand-header' : ''}`}
              style={onBrand ? { background: 'linear-gradient(180deg, #18295f 0%, #16265a 100%)' } : undefined}
            >
              <div>
                <div className={`mb-1 flex items-center gap-3 text-[11px] uppercase tracking-[0.24em] ${onBrand ? 'text-[#b0b3bd]' : 'text-faint'}`}>
                  <span>{meta.kicker}</span>
                  <span className="h-px w-8 bg-brass-dim/50" />
                  <span>{todayLabel}</span>
                </div>
                <h1 className={`font-display text-[40px] font-medium leading-none tracking-[-0.01em] ${onBrand ? 'text-[#f4f5f7]' : 'text-parchment'}`}>
                  {page === 'home' ? `${greeting}, Michael` : meta.title}
                </h1>
              </div>

              <div className="flex items-center gap-4">
                {page === 'pipeline' && (
                  <>
                    <div className="flex items-center gap-1 rounded-xl border border-line bg-surface/60 p-1">
                      {(['flow', 'board', 'cards'] as const).map((v) => (
                        <button
                          key={v}
                          type="button"
                          onClick={() => setView(v)}
                          className={[
                            'rounded-lg px-4 py-1.5 text-[12.5px] font-semibold capitalize transition-colors duration-200',
                            view === v
                              ? 'bg-surface-3 text-brass-bright shadow-[inset_0_0_0_1px_var(--color-brass-dim)]'
                              : 'text-muted hover:text-parchment',
                          ].join(' ')}
                        >
                          {v}
                        </button>
                      ))}
                    </div>
                    <div className="text-right">
                      <p className="font-display text-[26px] leading-none text-brass tabular-nums">
                        {projects ? String(activeCount).padStart(2, '0') : '--'}
                      </p>
                      <p className="mt-1 text-[10px] uppercase tracking-[0.18em] text-faint">Active</p>
                    </div>
                  </>
                )}

                {page === 'tasks' && (
                  <div className="flex items-center gap-5 text-right">
                    <div>
                      <p className="font-display text-[24px] leading-none tabular-nums" style={{ color: '#dc2626' }}>
                        {String(overdueCount).padStart(2, '0')}
                      </p>
                      <p className="mt-1 text-[10px] uppercase tracking-[0.18em] text-faint">Overdue</p>
                    </div>
                    <div>
                      <p className="font-display text-[24px] leading-none text-brass tabular-nums">
                        {String(dueTodayCount).padStart(2, '0')}
                      </p>
                      <p className="mt-1 text-[10px] uppercase tracking-[0.18em] text-faint">Today</p>
                    </div>
                    <div>
                      <p className="font-display text-[24px] leading-none text-muted tabular-nums">
                        {String(upcomingCount).padStart(2, '0')}
                      </p>
                      <p className="mt-1 text-[10px] uppercase tracking-[0.18em] text-faint">Upcoming</p>
                    </div>
                  </div>
                )}

                {backBtn}
                {refreshBtn}
                {notifications}

                {page === 'pipeline' && (
                  <button
                    type="button"
                    title={editMode ? 'Finish editing the pipeline' : 'Add, rename, reorder, or delete stages and categories'}
                    onClick={() => {
                      // Editing happens on the board; flip there when turning it on.
                      setEditMode((v) => {
                        if (!v) setView('board')
                        return !v
                      })
                    }}
                    className={[
                      'rounded-xl border px-4 py-2.5 text-[13px] font-semibold transition-all duration-200',
                      editMode
                        ? 'border-brass bg-surface-3 text-brass-bright shadow-[0_0_22px_-6px_var(--color-brass)]'
                        : 'border-line text-muted hover:border-line-strong hover:text-parchment',
                    ].join(' ')}
                  >
                    {editMode ? 'Done editing' : 'Edit pipeline'}
                  </button>
                )}

                {page === 'pipeline' && (
                  <button
                    type="button"
                    title="New project"
                    onClick={() => setNewProjectOpen(true)}
                    // ⚠️ THE ONE FILLED BUTTON IN THE HEADER, and on the brand ground it has to be
                    // a different colour from the light theme's version. The light version is a
                    // near-white gradient with gold text, which the surface reset cannot reach (it
                    // is a `bg-gradient-to-b`, not a `bg-surface`), so on navy it rendered as faint
                    // gold on near-white and stopped reading as the primary action.
                    //
                    // Solid gold with dark text is what the website uses in this position, and it
                    // is the only element on a branded page painted that way, which is what makes
                    // it the obvious thing to click.
                    className={
                      onBrand
                        ? 'rounded-xl border border-transparent bg-[#e3c279] px-4 py-2.5 text-[13px] font-semibold text-[#14161c] shadow-[0_10px_24px_-12px_rgba(227,194,121,0.9)] transition-all duration-200 hover:bg-[#f0d69b] hover:shadow-[0_12px_28px_-10px_rgba(227,194,121,0.95)]'
                        : 'rounded-xl border border-brass-dim/60 bg-gradient-to-b from-surface-3 to-surface px-4 py-2.5 text-[13px] font-semibold text-brass-bright shadow-[0_1px_0_rgba(255,255,255,0.04)_inset] transition-all duration-200 hover:border-brass hover:text-brass-bright hover:shadow-[0_0_22px_-6px_var(--color-brass)]'
                    }
                  >
                    + New project
                  </button>
                )}
              </div>
            </motion.header>

            {/* Hairline under the header, fading toward the right */}
            <div
              className={`mx-8 h-px ${onBrand ? 'bg-gradient-to-r from-white/25 via-white/10 to-transparent' : 'bg-gradient-to-r from-line-strong via-line to-transparent'}`}
            />

            {/* Active view */}
            <div
              ref={contentRef}
              className={`flex min-h-0 flex-1 flex-col pt-7 ${groundClass}`}
            >
              {error ? (
                <div className="flex flex-1 items-center justify-center px-8 text-center">
                  <div className="max-w-md">
                    <p className="font-display text-[20px] text-parchment">Couldn’t load your projects</p>
                    <p className="mt-2 text-[13px] leading-relaxed text-muted">{error}</p>
                    <p className="mt-3 text-[12px] text-faint">
                      Make sure the app is running through the dev server (the Open Bloom CRM launcher), which serves
                      your Project Records.
                    </p>
                  </div>
                </div>
              ) : !projects || !tasks ? (
                <div className="flex flex-1 items-center justify-center">
                  <p className="animate-pulse text-[13px] tracking-wide text-faint">Loading…</p>
                </div>
              ) : page === 'home' ? (
                <HomePage
                  projects={liveProjects}
                  tasks={liveTasks}
                  unread={unread}
                  onToggleTask={toggleTask}
                  onDeleteTask={deleteTask}
                  onOpenFull={openFull}
                  onOpenSide={openSide}
                  onOpenProjectById={openProjectById}
                  onThreadRead={clearProjectUnread}
                  onNavigate={(p) => {
                    setContactPane(null)
                    setFullProject(null)
                    setSelected(null)
                    setPage(p)
                  }}
                />
              ) : page === 'tasks' ? (
                <TasksPage
                  tasks={liveTasks}
                  projects={liveProjects}
                  onAdd={(title, dueDate, dueTime) => addTaskFor('', title, dueDate, dueTime)}
                  onToggle={toggleTask}
                  onDelete={deleteTask}
                  onEdit={editTask}
                  onOpenProject={openFull}
                />
              ) : page === 'inbox' ? (
                <InboxPage onOpenProject={openProjectById} onThreadRead={clearProjectUnread} />
              ) : page === 'calendar' ? (
                <CalendarPage
                  projects={liveProjects}
                  tasks={liveTasks}
                  gigEvents={gigEvents}
                  onOpenProject={openFull}
                  onOpenProjectById={openProjectById}
                />
              ) : page === 'finance' ? (
                <FinancePage projects={liveProjects} onOpenProject={openFull} />
              ) : page === 'stats' ? (
                <StatsPage projects={liveProjects} onOpenProject={openFull} onSaveField={saveField} />
              ) : page === 'proposals' ? (
                <ProposalsPage onPreview={setPreview} />
              ) : page === 'website' ? (
                <WebsiteAnalyticsPage />
              ) : page === 'contacts' ? (
                <ContactsPage
                  projects={liveProjects}
                  onOpenProject={openProjectById}
                  openContactId={pendingContactId}
                  onContactOpened={() => setPendingContactId(null)}
                />
              ) : page === 'files' ? (
                <FilesPage />
              ) : page === 'settings' ? (
                <SettingsPage />
              ) : page === 'archive' ? (
                <RecordsPage variant="archive" projects={archivedProjects} onOpenFull={openFull} onOpenSide={openSide} />
              ) : page === 'completed' ? (
                <RecordsPage
                  variant="completed"
                  projects={completedProjects}
                  onOpenFull={openFull}
                  onOpenSide={openSide}
                />
              ) : page === 'deleted' ? (
                <DeletedPage
                  projects={deletedProjects}
                  onOpenFull={openFull}
                  onOpenSide={openSide}
                  onRestore={doRestore}
                  onPurge={(p) => setPurgeTarget(p)}
                />
              ) : view === 'board' ? (
                <PipelineBoard
                  pipeline={pipeline}
                  editMode={editMode}
                  onOpenFull={openFull}
                  onOpenSide={openSide}
                  onDropProject={changeStage}
                  unread={unread}
                  pendingPaymentIds={pendingPaymentIds}
                  dateConflictIds={dateConflictIds}
                  onAddStage={addStageTo}
                  onRenameStage={renameStageTo}
                  onReorderStage={reorderStageBy}
                  onDeleteStage={requestDeleteStage}
                  onAddCategory={addCategory}
                  onRenameCategory={renameCategoryTo}
                  onRecolorCategory={recolorCategoryTo}
                  onDeleteCategory={requestDeleteCategory}
                  onReorderCategory={reorderCategoryBy}
                />
              ) : view === 'cards' ? (
                <PipelineCards
                  pipeline={pipeline}
                  onOpenFull={openFull}
                  onOpenSide={openSide}
                  unread={unread}
                  pendingPaymentIds={pendingPaymentIds}
                  dateConflictIds={dateConflictIds}
                />
              ) : (
                <PipelineFlow
                  pipeline={pipeline}
                  onOpenFull={openFull}
                  onOpenSide={openSide}
                  unread={unread}
                  pendingPaymentIds={pendingPaymentIds}
                  dateConflictIds={dateConflictIds}
                />
              )}
            </div>
          </>
        )}
      </main>

      <ProjectDetail
        onPreview={setPreview}
        project={contactPane ? null : selected}
        dateConflict={!!(selected && dateConflictIds.has(selected.id))}
        conflictWith={selected ? dateConflictInfo.get(selected.id) : undefined}
        tasks={tasksForSelected}
        contacts={contacts}
        links={links}
        onChangeStage={(stageId) => selected && changeStage(selected.id, stageId)}
        onSaveField={(field, value) => selected && saveField(selected.id, field, value)}
        onAddTask={(title, dueDate, dueTime) => selected && addTaskFor(selected.id, title, dueDate, dueTime)}
        onToggleTask={toggleTask}
        onDeleteTask={deleteTask}
        onEditTask={editTask}
        onArchive={() => selected && setArchiveTarget(selected)}
        onComplete={() => selected && setCompleteTarget(selected)}
        onRestore={() => selected && doRestore(selected.id)}
        onDelete={() => selected && setDeleteTarget(selected)}
        onPurge={() => selected && setPurgeTarget(selected)}
        onLogCall={() => selected && setCallTarget(selected)}
        onPaymentsChange={(pmts) => selected && syncPayments(selected.id, pmts)}
        onProjectChanged={reloadProjects}
        onOpenContact={setContactPane}
        onUnlinkContact={(c) => selected && unlinkContactFromProject(selected, c)}
        onAddContact={() => selected && setContactPickerProject(selected)}
        onExpand={openFull}
        onClose={() => setSelected(null)}
        categories={structure.umbrellas}
        escActive={
          !contactPane &&
          !contactPickerProject &&
          !archiveTarget &&
          !completeTarget &&
          !depositTarget &&
          !deleteTarget &&
          !purgeTarget &&
          !callTarget &&
          !searchOpen &&
          !newProjectOpen
        }
      />

      {/* Contact opened from a project (swaps over/with the project side pane). */}
      <ContactDetail
        contact={contactPane}
        linkedProjects={contactPane ? linkedProjectsFor(contactPane, allProjects, links) : []}
        knownTags={tagLibrary}
        onNewTag={registerTag}
        onChange={(patch) => contactPane && patchContact(contactPane.id, patch)}
        onDelete={() => contactPane && removeContactRecord(contactPane.id)}
        onOpenProject={(id) => {
          setContactPane(null)
          openProjectById(id)
        }}
        onBack={selected ? () => setContactPane(null) : undefined}
        onClose={() => setContactPane(null)}
      />

      <ProjectContactPickerModal
        open={!!contactPickerProject}
        contacts={contacts}
        linkedIds={
          contactPickerProject
            ? new Set(contactsForProject(contactPickerProject, contacts, links).map((c) => c.id))
            : new Set<string>()
        }
        onPick={(c) => {
          if (contactPickerProject) linkContactToProject(contactPickerProject, c)
          setContactPickerProject(null)
        }}
        onCreate={(details) => {
          if (contactPickerProject) createAndLinkContact(contactPickerProject, details)
          setContactPickerProject(null)
        }}
        onClose={() => setContactPickerProject(null)}
      />

      <ArchiveReasonModal
        project={archiveTarget}
        reasons={archiveReasons}
        onReasonsChange={(r) => {
          setArchiveReasons(r)
          saveConfig({ archiveReasons: r }).catch(() => {})
        }}
        onCancel={() => setArchiveTarget(null)}
        onConfirm={(reason) => {
          const t = archiveTarget
          setArchiveTarget(null)
          if (t) doArchive(t.id, reason)
        }}
      />

      <CompleteProjectModal
        project={completeTarget}
        onCancel={() => setCompleteTarget(null)}
        onConfirm={(data) => completeTarget && finishComplete(completeTarget, data)}
        onPaymentsChange={(pmts) => completeTarget && syncPayments(completeTarget.id, pmts)}
      />

      <DepositPaidModal
        project={depositTarget?.project ?? null}
        onCancel={() => setDepositTarget(null)}
        onConfirm={() => {
          const t = depositTarget
          setDepositTarget(null)
          if (t) doSetStage(t.project.id, t.stageId)
        }}
        onPaymentsChange={(pmts) => depositTarget && syncPayments(depositTarget.project.id, pmts)}
      />

      <NewProjectModal
        open={newProjectOpen}
        contacts={contacts}
        categories={structure.umbrellas}
        onClose={() => setNewProjectOpen(false)}
        onCreated={(p) => {
          setProjects((prev) => (prev ? [...prev, p] : [p]))
          openFull(p)
          // A new project gets one contact seeded server-side; pull the fresh
          // links + contacts so it shows up on the project right away.
          loadLinks().then(setLinks).catch(() => {})
          loadContacts().then(setContacts).catch(() => {})
        }}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete this project?"
        message={
          deleteTarget
            ? `“${deleteTarget.client}” will move to Deleted and leave your pipeline. It is kept for 30 days (with all its data) so you can restore it, then it is permanently removed.`
            : ''
        }
        confirmLabel="Move to Deleted"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          const t = deleteTarget
          setDeleteTarget(null)
          if (t) doDelete(t.id)
        }}
      />

      <ConfirmDialog
        open={!!purgeTarget}
        title="Delete permanently?"
        message={
          purgeTarget
            ? `“${purgeTarget.client}” and everything tied to it (payments, emails, invoices, contracts, inquiries) will be erased for good. This cannot be undone.`
            : ''
        }
        confirmLabel="Delete permanently"
        onCancel={() => setPurgeTarget(null)}
        onConfirm={() => {
          const t = purgeTarget
          setPurgeTarget(null)
          if (t) doPurge(t.id)
        }}
      />

      <SearchPalette
        projects={liveProjects}
        contacts={contacts}
        categories={structure.umbrellas}
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onOpen={(p) => {
          setSearchOpen(false)
          openFull(p)
        }}
        onOpenContact={(c) => {
          setSearchOpen(false)
          setContactPane(null)
          setFullProject(null)
          setSelected(null)
          setPage('contacts')
          setPendingContactId(c.id)
        }}
      />

      <PipelineDeleteDialog
        target={deleteBlock}
        onCancel={() => setDeleteBlock(null)}
        onDump={() => deleteBlock && dumpAndDelete(deleteBlock)}
      />

      <CallLogModal
        project={callTarget}
        onClose={() => setCallTarget(null)}
        onSubmit={(payload) => callTarget && doLogCall(callTarget, payload)}
      />
    </div>
  )
}

export default App
