import { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { Sidebar, type Page } from './components/Sidebar'
import { PipelineBoard } from './components/PipelineBoard'
import { PipelineFlow } from './components/PipelineFlow'
import { ProjectDetail } from './components/ProjectDetail'
import { ProjectView } from './components/ProjectView'
import { ContactDetail } from './components/ContactDetail'
import { ProjectContactPickerModal } from './components/ProjectContactPickerModal'
import { HomePage } from './components/HomePage'
import { TasksPage } from './components/TasksPage'
import { InboxPage } from './components/InboxPage'
import { CalendarPage } from './components/CalendarPage'
import { FinancePage } from './components/FinancePage'
import { ContactsPage } from './components/ContactsPage'
import { TemplatesPage } from './components/TemplatesPage'
import { FilesPage } from './components/FilesPage'
import { RecordsPage } from './components/RecordsPage'
import { SettingsPage } from './components/SettingsPage'
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
import { getTheme, applyTheme, type ThemeId } from './theme'
import {
  loadProjects,
  loadTasks,
  loadUnreadByProject,
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
  loadConfig,
  saveConfig,
  loadPayments,
  loadContacts,
  loadLinks,
  linkContact as apiLinkContact,
  unlinkContact as apiUnlinkContact,
  addContact as apiAddContact,
  updateContact as apiUpdateContact,
  deleteContact as apiDeleteContact,
  isReceivedPayment,
  addTask as apiAddTask,
  setTaskDone,
  removeTask,
  type Task,
  type Payment,
  type Contact,
  type ContactType,
  type ProjectLinks,
} from './api'
import { linkedProjectsFor, contactsForProject } from './contacts'

type View = 'flow' | 'board'

const PAGE_META: Record<Page, { kicker: string; title: string }> = {
  home: { kicker: 'Home', title: 'Home' },
  pipeline: { kicker: 'Pipeline', title: 'The Pipeline' },
  inbox: { kicker: 'Inbox', title: 'Inbox' },
  tasks: { kicker: 'Tasks', title: 'Tasks' },
  calendar: { kicker: 'Calendar', title: 'Calendar' },
  finance: { kicker: 'Finance', title: 'Finance' },
  contacts: { kicker: 'Contacts', title: 'Contacts' },
  templates: { kicker: 'Library', title: 'Templates' },
  files: { kicker: 'Library', title: 'Files' },
  completed: { kicker: 'Records', title: 'Completed' },
  archive: { kicker: 'Records', title: 'Archive' },
  settings: { kicker: 'System', title: 'Settings' },
}

function App() {
  // Remember which screen Michael is on so a page refresh lands him back where he
  // was instead of bouncing to Home.
  const [view, setView] = useState<View>(() => {
    const saved = localStorage.getItem('crm:view')
    return saved === 'board' || saved === 'flow' ? saved : 'flow'
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
  const [archiveTarget, setArchiveTarget] = useState<Project | null>(null)
  const [completeTarget, setCompleteTarget] = useState<Project | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null)
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
  const [pendingContactId, setPendingContactId] = useState<string | null>(null)
  const [contactPane, setContactPane] = useState<Contact | null>(null) // a contact open in the side pane
  const [contactPickerProject, setContactPickerProject] = useState<Project | null>(null)
  const [tagLibrary, setTagLibrary] = useState<string[]>([])
  const [theme, setTheme] = useState<ThemeId>(getTheme)

  const changeTheme = (id: ThemeId) => {
    setTheme(id)
    applyTheme(id)
  }

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

  // Open a project: full page (primary) or the side pane.
  const openFull = (p: Project) => {
    if (!fullProject) {
      const s = captureScroll() // capture the page we're leaving (not when project->project)
      backRef.current = { page, view, top: s.top, left: s.left }
    }
    setContactPane(null)
    setSelected(null)
    setFullProject(p)
  }
  const openSide = (p: Project) => {
    setContactPane(null)
    setFullProject(null)
    setSelected(p)
  }
  const openProjectById = (id: string) => {
    const p = (projects ?? []).find((x) => x.id === id)
    if (p) openFull(p)
  }
  const goBack = () => {
    const b = backRef.current
    setFullProject(null)
    if (b) {
      setPage(b.page)
      setView(b.view)
      restoreRef.current = { top: b.top, left: b.left }
    }
  }

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
  const activeCount = activeProjects.length
  const inboxUnread = useMemo(() => Object.values(unread).reduce((a, b) => a + b, 0), [unread])

  const today = todayISO()
  const taskAlerts = allTasks.filter((t) => !t.done && t.dueDate && t.dueDate <= today).length
  const overdueCount = allTasks.filter((t) => !t.done && t.dueDate && t.dueDate < today).length
  const dueTodayCount = allTasks.filter((t) => !t.done && t.dueDate === today).length
  const upcomingCount = allTasks.filter((t) => !t.done && (!t.dueDate || t.dueDate > today)).length

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
    let v: string | number | null = value
    if (field === 'totalFee' || field === 'mileage' || field === 'tips') {
      const n = Number(String(value).replace(/[^0-9.]/g, ''))
      v = value === '' || Number.isNaN(n) ? null : n
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
  const reloadProjects = () => {
    loadProjects()
      .then((fresh) => {
        setProjects(fresh)
        setSelected((prev) => (prev ? fresh.find((p) => p.id === prev.id) ?? null : prev))
        setFullProject((prev) => (prev ? fresh.find((p) => p.id === prev.id) ?? prev : prev))
      })
      .catch(() => {})
  }
  const applyPatch = (id: string, patch: Partial<Project>) => {
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
  // Permanent delete: drop the project from the local lists immediately, close any
  // open pane/full view for it, and purge its tasks + unread badge locally. The
  // server removes the record + overlay data (stage/tasks/payments/mileage).
  const doDelete = (id: string) => {
    setProjects((prev) => (prev ? prev.filter((p) => p.id !== id) : prev))
    setTasks((prev) => (prev ? prev.filter((t) => t.projectId !== id) : prev))
    setSelected((prev) => (prev && prev.id === id ? null : prev))
    setFullProject((prev) => (prev && prev.id === id ? null : prev))
    dropUnread(id)
    apiDelete(id).catch(reloadProjects)
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

  const addTaskFor = (projectId: string, title: string, dueDate: string) => {
    apiAddTask({ projectId, title, dueDate })
      .then((task) => setTasks((prev) => [...(prev ?? []), task]))
      .catch(() => {})
  }
  const toggleTask = (id: string, done: boolean) => {
    setTasks((prev) => (prev ? prev.map((t) => (t.id === id ? { ...t, done } : t)) : prev))
    setTaskDone(id, done).catch(() => {
      loadTasks().then(setTasks).catch(() => {})
    })
  }
  const deleteTask = (id: string) => {
    setTasks((prev) => (prev ? prev.filter((t) => t.id !== id) : prev))
    removeTask(id).catch(() => {
      loadTasks().then(setTasks).catch(() => {})
    })
  }

  const tasksForSelected = selected ? allTasks.filter((t) => t.projectId === selected.id) : []
  const tasksForFull = fullProject ? allTasks.filter((t) => t.projectId === fullProject.id) : []

  const notifications = (
    <Notifications
      tasks={allTasks}
      projects={allProjects}
      onToggle={toggleTask}
      onDelete={deleteTask}
      onOpenProject={openFull}
    />
  )

  const meta = PAGE_META[page]

  return (
    <div className="relative z-10 flex h-screen overflow-hidden">
      <Sidebar
        page={page}
        onNavigate={(p) => {
          setContactPane(null)
          setFullProject(null)
          setSelected(null)
          setPage(p)
        }}
        taskAlerts={taskAlerts}
        inboxUnread={inboxUnread}
        onOpenSearch={() => setSearchOpen(true)}
        theme={theme}
        onChangeTheme={changeTheme}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        {fullProject ? (
          <ProjectView
            project={fullProject}
            tasks={tasksForFull}
            onChangeStage={(stageId) => changeStage(fullProject.id, stageId)}
            onSaveField={(field, value) => saveField(fullProject.id, field, value)}
            onAddTask={(title, dueDate) => addTaskFor(fullProject.id, title, dueDate)}
            onToggleTask={toggleTask}
            onDeleteTask={deleteTask}
            onArchive={() => setArchiveTarget(fullProject)}
            onComplete={() => setCompleteTarget(fullProject)}
            onRestore={() => doRestore(fullProject.id)}
            onDelete={() => setDeleteTarget(fullProject)}
            onLogCall={() => setCallTarget(fullProject)}
            onPaymentsChange={(pmts) => syncPayments(fullProject.id, pmts)}
            contacts={contacts}
            links={links}
            onOpenContact={setContactPane}
            onUnlinkContact={(c) => unlinkContactFromProject(fullProject, c)}
            onAddContact={() => setContactPickerProject(fullProject)}
            onThreadRead={(count) => clearProjectUnread(fullProject.id, count)}
            onBack={goBack}
            headerRight={notifications}
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
              className="flex items-end justify-between gap-6 px-8 pb-7 pt-8"
            >
              <div>
                <div className="mb-1 flex items-center gap-3 text-[11px] uppercase tracking-[0.24em] text-faint">
                  <span>{meta.kicker}</span>
                  <span className="h-px w-8 bg-brass-dim/50" />
                  <span>{todayLabel}</span>
                </div>
                <h1 className="font-display text-[40px] font-medium leading-none tracking-[-0.01em] text-parchment">
                  {page === 'home' ? `${greeting}, Michael` : meta.title}
                </h1>
              </div>

              <div className="flex items-center gap-4">
                {page === 'pipeline' && (
                  <>
                    <div className="flex items-center gap-1 rounded-xl border border-line bg-surface/60 p-1">
                      {(['flow', 'board'] as const).map((v) => (
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
                      <p className="font-display text-[24px] leading-none tabular-nums" style={{ color: '#e08a6b' }}>
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
                    className="rounded-xl border border-brass-dim/60 bg-gradient-to-b from-surface-3 to-surface px-4 py-2.5 text-[13px] font-semibold text-brass-bright shadow-[0_1px_0_rgba(255,255,255,0.04)_inset] transition-all duration-200 hover:border-brass hover:text-brass-bright hover:shadow-[0_0_22px_-6px_var(--color-brass)]"
                  >
                    + New project
                  </button>
                )}
              </div>
            </motion.header>

            {/* Hairline under the header, fading toward the right */}
            <div className="mx-8 h-px bg-gradient-to-r from-line-strong via-line to-transparent" />

            {/* Active view */}
            <div ref={contentRef} className="flex min-h-0 flex-1 flex-col pt-7">
              {error ? (
                <div className="flex flex-1 items-center justify-center px-8 text-center">
                  <div className="max-w-md">
                    <p className="font-display text-[20px] text-parchment">Couldn’t load your projects</p>
                    <p className="mt-2 text-[13px] leading-relaxed text-muted">{error}</p>
                    <p className="mt-3 text-[12px] text-faint">
                      Make sure the app is running through the dev server (the Open Magic CRM launcher), which serves
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
                  projects={allProjects}
                  tasks={allTasks}
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
                  tasks={allTasks}
                  projects={allProjects}
                  onToggle={toggleTask}
                  onDelete={deleteTask}
                  onOpenProject={openFull}
                />
              ) : page === 'inbox' ? (
                <InboxPage onOpenProject={openProjectById} onThreadRead={clearProjectUnread} />
              ) : page === 'calendar' ? (
                <CalendarPage
                  projects={allProjects}
                  tasks={allTasks}
                  onOpenProject={openFull}
                  onOpenProjectById={openProjectById}
                />
              ) : page === 'finance' ? (
                <FinancePage projects={allProjects} onOpenProject={openFull} />
              ) : page === 'contacts' ? (
                <ContactsPage
                  projects={allProjects}
                  onOpenProject={openProjectById}
                  openContactId={pendingContactId}
                  onContactOpened={() => setPendingContactId(null)}
                />
              ) : page === 'templates' ? (
                <TemplatesPage />
              ) : page === 'files' ? (
                <FilesPage />
              ) : page === 'archive' ? (
                <RecordsPage variant="archive" projects={archivedProjects} onOpenFull={openFull} onOpenSide={openSide} />
              ) : page === 'completed' ? (
                <RecordsPage
                  variant="completed"
                  projects={completedProjects}
                  onOpenFull={openFull}
                  onOpenSide={openSide}
                />
              ) : page === 'settings' ? (
                <SettingsPage />
              ) : view === 'board' ? (
                <PipelineBoard
                  pipeline={pipeline}
                  editMode={editMode}
                  onOpenFull={openFull}
                  onOpenSide={openSide}
                  onDropProject={changeStage}
                  unread={unread}
                  pendingPaymentIds={pendingPaymentIds}
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
              ) : (
                <PipelineFlow
                  pipeline={pipeline}
                  onOpenFull={openFull}
                  onOpenSide={openSide}
                  unread={unread}
                  pendingPaymentIds={pendingPaymentIds}
                />
              )}
            </div>
          </>
        )}
      </main>

      <ProjectDetail
        project={contactPane ? null : selected}
        tasks={tasksForSelected}
        contacts={contacts}
        links={links}
        onChangeStage={(stageId) => selected && changeStage(selected.id, stageId)}
        onSaveField={(field, value) => selected && saveField(selected.id, field, value)}
        onAddTask={(title, dueDate) => selected && addTaskFor(selected.id, title, dueDate)}
        onToggleTask={toggleTask}
        onDeleteTask={deleteTask}
        onArchive={() => selected && setArchiveTarget(selected)}
        onComplete={() => selected && setCompleteTarget(selected)}
        onRestore={() => selected && doRestore(selected.id)}
        onDelete={() => selected && setDeleteTarget(selected)}
        onLogCall={() => selected && setCallTarget(selected)}
        onPaymentsChange={(pmts) => selected && syncPayments(selected.id, pmts)}
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
        projects={allProjects}
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
            ? `“${deleteTarget.client}” will be permanently removed from your records, along with its tasks, payments, and mileage. This can’t be undone.`
            : ''
        }
        confirmLabel="Delete project"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          const t = deleteTarget
          setDeleteTarget(null)
          if (t) doDelete(t.id)
        }}
      />

      <SearchPalette
        projects={allProjects}
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
