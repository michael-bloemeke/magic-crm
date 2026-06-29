import { useMemo, useState } from 'react'
import { motion } from 'motion/react'
import { todayISO, type Project } from '../pipeline'
import type { Task } from '../api'
import { TaskRow } from './TaskRow'

type Props = {
  tasks: Task[]
  projects: Project[]
  onAdd: (title: string, dueDate: string) => void
  onToggle: (id: string, done: boolean) => void
  onDelete: (id: string) => void
  onEdit: (id: string, patch: { title: string; dueDate: string }) => void
  onOpenProject: (project: Project) => void
}

const byDueAsc = (a: Task, b: Task) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999')

export function TasksPage({ tasks, projects, onAdd, onToggle, onDelete, onEdit, onOpenProject }: Props) {
  const byId = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects])
  const today = todayISO()
  const [newTitle, setNewTitle] = useState('')
  const [newDue, setNewDue] = useState('')
  const submitNew = () => {
    const t = newTitle.trim()
    if (!t) return
    onAdd(t, newDue)
    setNewTitle('')
    setNewDue('')
  }

  const active = tasks.filter((t) => !t.done)
  const overdue = active.filter((t) => t.dueDate && t.dueDate < today).sort(byDueAsc)
  const dueToday = active.filter((t) => t.dueDate === today).sort(byDueAsc)
  const upcoming = active.filter((t) => !t.dueDate || t.dueDate > today).sort(byDueAsc)
  const completed = tasks.filter((t) => t.done).sort(byDueAsc)

  const open = (projectId: string) => {
    const p = byId.get(projectId)
    if (p) onOpenProject(p)
  }

  const Section = ({
    title,
    color,
    items,
  }: {
    title: string
    color: string
    items: Task[]
  }) => {
    if (items.length === 0) return null
    return (
      <section className="mb-7">
        <div className="mb-2.5 flex items-center gap-2.5">
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
          <h3 className="text-[12px] font-semibold uppercase tracking-[0.18em]" style={{ color }}>
            {title}
          </h3>
          <span className="text-[11px] tabular-nums text-faint">{items.length}</span>
        </div>
        <div className="space-y-2">
          {items.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              projectName={t.projectId ? (byId.get(t.projectId)?.client ?? 'Unknown project') : undefined}
              onToggle={(done) => onToggle(t.id, done)}
              onDelete={() => onDelete(t.id)}
              onEdit={(patch) => onEdit(t.id, patch)}
              onOpenProject={t.projectId ? () => open(t.projectId) : undefined}
            />
          ))}
        </div>
      </section>
    )
  }

  const isEmpty = tasks.length === 0

  return (
    <div className="board-scroll h-full overflow-y-auto px-8 pb-12">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="max-w-3xl"
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
          <button
            type="button"
            onClick={submitNew}
            disabled={!newTitle.trim()}
            className="rounded-lg bg-brass px-4 py-2 text-[12.5px] font-semibold text-[#231a0c] transition-all hover:brightness-110 disabled:opacity-40"
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
          <>
            <Section title="Overdue" color="#e08a6b" items={overdue} />
            <Section title="Due today" color="var(--color-brass)" items={dueToday} />
            <Section title="Upcoming" color="var(--color-umb-postcall)" items={upcoming} />
            {completed.length > 0 && (
              <section className="mt-2 opacity-70">
                <div className="mb-2.5 flex items-center gap-2.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-faint" />
                  <h3 className="text-[12px] font-semibold uppercase tracking-[0.18em] text-faint">
                    Completed
                  </h3>
                  <span className="text-[11px] tabular-nums text-faint">{completed.length}</span>
                </div>
                <div className="space-y-2">
                  {completed.map((t) => (
                    <TaskRow
                      key={t.id}
                      task={t}
                      projectName={t.projectId ? (byId.get(t.projectId)?.client ?? 'Unknown project') : undefined}
                      onToggle={(done) => onToggle(t.id, done)}
                      onDelete={() => onDelete(t.id)}
                      onEdit={(patch) => onEdit(t.id, patch)}
                      onOpenProject={t.projectId ? () => open(t.projectId) : undefined}
                    />
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </motion.div>
    </div>
  )
}
