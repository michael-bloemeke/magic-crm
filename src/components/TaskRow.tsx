import { useState } from 'react'
import { formatEventDate, todayISO } from '../pipeline'
import type { Task } from '../api'

type Props = {
  task: Task
  projectName?: string
  onToggle: (done: boolean) => void
  onDelete: () => void
  // When provided, the row can be renamed / re-dated / re-timed inline (a pencil appears on hover).
  onEdit?: (patch: { title: string; dueDate: string; dueTime: string }) => void
  onOpenProject?: () => void
}

const OVERDUE = '#dc2626'

// "13:00" -> "1:00 PM" for display. Empty for an all-day task.
function fmtTime(hhmm: string): string {
  const m = (hhmm || '').match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return ''
  let h = Number(m[1])
  const ampm = h >= 12 ? 'PM' : 'AM'
  h = h % 12
  if (h === 0) h = 12
  return `${h}:${m[2]} ${ampm}`
}

export function TaskRow({ task, projectName, onToggle, onDelete, onEdit, onOpenProject }: Props) {
  const [editing, setEditing] = useState(false)
  const [draftTitle, setDraftTitle] = useState(task.title)
  const [draftDue, setDraftDue] = useState(task.dueDate || '')
  const [draftTime, setDraftTime] = useState(task.dueTime || '')

  const startEdit = () => {
    setDraftTitle(task.title)
    setDraftDue(task.dueDate || '')
    setDraftTime(task.dueTime || '')
    setEditing(true)
  }
  const saveEdit = () => {
    const t = draftTitle.trim()
    if (!t) return
    onEdit?.({ title: t, dueDate: draftDue, dueTime: draftTime })
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-brass-dim bg-surface-2/50 px-3 py-2">
        <input
          value={draftTitle}
          onChange={(e) => setDraftTitle(e.target.value)}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') saveEdit()
            if (e.key === 'Escape') setEditing(false)
          }}
          className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1 text-[13px] text-parchment focus:border-brass-dim focus:outline-none"
        />
        <input
          type="date"
          value={draftDue}
          onChange={(e) => setDraftDue(e.target.value)}
          className="shrink-0 rounded-md border border-line bg-surface px-2 py-1 text-[12px] text-parchment focus:border-brass-dim focus:outline-none"
          style={{ colorScheme: 'dark' }}
        />
        <input
          type="time"
          value={draftTime}
          onChange={(e) => setDraftTime(e.target.value)}
          title="Optional time (leave blank for an all-day task)"
          className="shrink-0 rounded-md border border-line bg-surface px-2 py-1 text-[12px] text-parchment focus:border-brass-dim focus:outline-none"
          style={{ colorScheme: 'dark' }}
        />
        <button type="button" onClick={saveEdit} aria-label="Save task" className="shrink-0 rounded-md p-1 text-brass-bright transition-colors hover:text-brass">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 6" /></svg>
        </button>
        <button type="button" onClick={() => setEditing(false)} aria-label="Cancel" className="shrink-0 rounded-md p-1 text-faint transition-colors hover:text-parchment">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>
    )
  }

  const today = todayISO()
  const overdue = !task.done && !!task.dueDate && task.dueDate < today
  const isToday = !task.done && task.dueDate === today
  const dueColor = task.done
    ? 'var(--color-faint)'
    : overdue
      ? OVERDUE
      : isToday
        ? 'var(--color-brass)'
        : 'var(--color-muted)'

  return (
    <div className="group flex items-center gap-3 rounded-lg border border-line bg-surface-2/50 px-3 py-2 transition-colors hover:border-line-strong">
      {/* Checkbox */}
      <button
        type="button"
        onClick={() => onToggle(!task.done)}
        aria-label={task.done ? 'Mark not done' : 'Mark done'}
        className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border transition-colors"
        style={{
          borderColor: task.done ? 'var(--color-brass)' : 'var(--color-line-strong)',
          backgroundColor: task.done ? 'var(--color-brass)' : 'transparent',
        }}
      >
        {task.done && (
          <svg viewBox="0 0 24 24" className="h-3 w-3 text-canvas" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12l5 5L20 6" />
          </svg>
        )}
      </button>

      {/* Body */}
      <div className="min-w-0 flex-1">
        <p
          className={[
            'truncate text-[13px] leading-snug',
            task.done ? 'text-faint line-through' : 'text-parchment',
          ].join(' ')}
        >
          {task.title}
        </p>
        <div className="mt-0.5 flex items-center gap-2 text-[11px]">
          <span className="tabular-nums" style={{ color: dueColor }}>
            {overdue ? 'Overdue · ' : ''}
            {formatEventDate(task.dueDate)}
            {task.dueTime ? ` · ${fmtTime(task.dueTime)}` : ''}
          </span>
          {projectName && onOpenProject && (
            <>
              <span className="h-0.5 w-0.5 rounded-full bg-faint" />
              <button
                type="button"
                onClick={onOpenProject}
                className="truncate text-muted transition-colors hover:text-brass"
              >
                {projectName}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Edit (rename / change date) */}
      {onEdit && (
        <button
          type="button"
          onClick={startEdit}
          aria-label="Edit task"
          title="Edit task"
          className="shrink-0 rounded-md p-1 text-faint opacity-0 transition-all hover:text-[var(--color-brass-bright)] group-hover:opacity-100"
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
          </svg>
        </button>
      )}

      {/* Delete */}
      <button
        type="button"
        onClick={onDelete}
        aria-label="Delete task"
        title="Delete task"
        className="shrink-0 rounded-md p-1 text-faint opacity-0 transition-all hover:text-[var(--color-brass-bright)] group-hover:opacity-100"
      >
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
        </svg>
      </button>
    </div>
  )
}
