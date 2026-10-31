import { useMemo, useState, type ReactElement } from 'react'
import { motion } from 'motion/react'
import { todayISO, type Project } from '../pipeline'
import type { Task } from '../api'
import { TaskRow } from './TaskRow'
import { TaskSchedules } from './TaskSchedules'

type Props = {
  tasks: Task[]
  projects: Project[]
  onAdd: (title: string, dueDate: string, dueTime: string) => void
  onToggle: (id: string, done: boolean) => void
  onDelete: (id: string) => void
  onEdit: (id: string, patch: { title: string; dueDate: string; dueTime: string }) => void
  onOpenProject: (project: Project) => void
}

const byDueAsc = (a: Task, b: Task) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999')

// This RETURNS elements; it is not a component, and it lives at module scope.
//
// They used to be components declared inside TasksPage and rendered as <Section />. React identifies
// a component by its function reference, so a fresh one on every render is a DIFFERENT type: the
// whole subtree gets unmounted and rebuilt rather than updated. Every TaskRow inside went with it,
// taking its local `editing` state along.
//
// That is what cancelled Michael's edit mid-typing: the 20-second background refresh re-rendered
// TasksPage, the task list remounted, and the open editor vanished with whatever he had typed.
// Calling a plain function sidesteps component identity entirely, so the rows below just update.
function section(title: string, color: string, items: Task[], row: (t: Task) => ReactElement) {
  if (items.length === 0) return null
  return (
    <section className="mb-6" key={title}>
      <div className="mb-2.5 flex items-center gap-2.5">
        <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
        <h3 className="text-[12px] font-semibold uppercase tracking-[0.18em]" style={{ color }}>
          {title}
        </h3>
        <span className="text-[11px] tabular-nums text-faint">{items.length}</span>
      </div>
      <div className="space-y-2">{items.map(row)}</div>
    </section>
  )
}

export function TasksPage({ tasks, projects, onAdd, onToggle, onDelete, onEdit, onOpenProject }: Props) {
  const byId = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects])
  const today = todayISO()
  const [newTitle, setNewTitle] = useState('')
  const [newDue, setNewDue] = useState('')
  const [newTime, setNewTime] = useState('')
  // Completed tasks are not listed on this page (Michael, 2026-10-31); each project's page still shows
  // its own. A task ticked off HERE stays in place, struck through, until he leaves the page, so a
  // mis-tap can be undone. That matters most for standalone tasks, which have no project page.
  const [doneHere, setDoneHere] = useState<Set<string>>(() => new Set())
  const toggle = (id: string, done: boolean) => {
    setDoneHere((prev) => {
      const next = new Set(prev)
      if (done) next.add(id)
      else next.delete(id)
      return next
    })
    onToggle(id, done)
  }
  const submitNew = () => {
    const t = newTitle.trim()
    if (!t) return
    onAdd(t, newDue, newTime)
    setNewTitle('')
    setNewDue('')
    setNewTime('')
  }

  // A task is overdue if its due date already passed, OR it's due today with a set time that's passed.
  const isOverdue = (t: Task) => {
    if (!t.dueDate) return false
    if (t.dueDate < today) return true
    if (t.dueDate === today && t.dueTime) {
      const [h, m] = t.dueTime.split(':').map(Number)
      if (Number.isFinite(h) && Number.isFinite(m)) {
        const d = new Date()
        const nowMs = d.getTime()
        d.setHours(h, m, 0, 0)
        return d.getTime() < nowMs
      }
    }
    return false
  }

  // Bucket any task list into the same three groups. The overdue / due-date logic and the
  // notifications that read these tasks are unchanged; this only splits WHERE they render.
  const bucket = (list: Task[]) => {
    const shown = list.filter((t) => !t.done || doneHere.has(t.id))
    return {
      overdue: shown.filter(isOverdue).sort(byDueAsc),
      dueToday: shown.filter((t) => t.dueDate === today && !isOverdue(t)).sort(byDueAsc),
      upcoming: shown.filter((t) => !t.dueDate || t.dueDate > today).sort(byDueAsc),
      openCount: list.filter((t) => !t.done).length,
      shownCount: shown.length,
    }
  }

  // A task belongs to a project when it has a projectId; empty projectId = standalone.
  const projectData = bucket(tasks.filter((t) => t.projectId))
  const soloData = bucket(tasks.filter((t) => !t.projectId))

  const open = (projectId: string) => {
    const p = byId.get(projectId)
    if (p) onOpenProject(p)
  }

  const taskRow = (t: Task) => (
    <TaskRow
      key={t.id}
      task={t}
      projectName={t.projectId ? (byId.get(t.projectId)?.client ?? 'Unknown project') : undefined}
      onToggle={(done) => toggle(t.id, done)}
      onDelete={() => onDelete(t.id)}
      onEdit={(patch) => onEdit(t.id, patch)}
      onOpenProject={t.projectId ? () => open(t.projectId) : undefined}
    />
  )

  // One column = a labeled header + the same three sections, filtered to that group.
  const column = (label: string, sub: string, data: ReturnType<typeof bucket>) => (
    <div>
      <div className="mb-4 flex items-baseline justify-between gap-2 border-b border-line pb-2.5">
        <div>
          <h2 className="font-display text-[17px] leading-tight text-parchment">{label}</h2>
          <p className="text-[11px] text-faint">{sub}</p>
        </div>
        <span className="shrink-0 text-[11.5px] tabular-nums text-faint">{data.openCount} open</span>
      </div>
      {data.shownCount === 0 ? (
        <p className="py-10 text-center text-[12.5px] text-faint">Nothing here.</p>
      ) : (
        <>
          {section('Overdue', '#dc2626', data.overdue, taskRow)}
          {section('Due today', 'var(--color-brass)', data.dueToday, taskRow)}
          {section('Upcoming', 'var(--color-umb-postcall)', data.upcoming, taskRow)}
        </>
      )}
    </div>
  )

  const isEmpty = tasks.length === 0

  return (
    <div className="board-scroll h-full overflow-y-auto px-8 pb-12">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="max-w-6xl"
      >
        <div className="mb-7 flex flex-wrap items-center gap-2">
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitNew()
            }}
            placeholder="Add a task (not tied to a project)…"
            className="min-w-[14rem] flex-1 rounded-lg border border-line bg-surface-2 px-3 py-2 text-[13px] text-parchment placeholder:text-faint focus:border-brass-dim focus:outline-none"
          />
          <input
            type="date"
            value={newDue}
            onChange={(e) => setNewDue(e.target.value)}
            className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-[13px] text-parchment focus:border-brass-dim focus:outline-none"
          />
          <input
            type="time"
            value={newTime}
            onChange={(e) => setNewTime(e.target.value)}
            title="Optional time (leave blank for an all-day task)"
            className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-[13px] text-parchment focus:border-brass-dim focus:outline-none"
          />
          <button
            type="button"
            onClick={submitNew}
            disabled={!newTitle.trim()}
            className="rounded-lg bg-brass px-4 py-2 text-[12.5px] font-semibold text-[#ffffff] transition-all hover:brightness-110 disabled:opacity-40"
          >
            Add task
          </button>
        </div>
        {isEmpty ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <p className="font-display text-[20px] text-parchment">No tasks yet</p>
            <p className="mt-2 max-w-sm text-[13px] leading-relaxed text-muted">
              Add one above, or open any project to add project tasks. They’ll show up here, grouped by
              when they’re due.
            </p>
          </div>
        ) : (
          <div className="grid gap-8 lg:grid-cols-2">
            {column('Project tasks', 'Linked to a project', projectData)}
            {column('Standalone tasks', 'Not tied to a project', soloData)}
          </div>
        )}
        {/* Recurring tasks live at the bottom of this page: they ARE tasks, just ones that create
            themselves, so this is where he would look for them. */}
        <TaskSchedules projects={projects} />
      </motion.div>
    </div>
  )
}
