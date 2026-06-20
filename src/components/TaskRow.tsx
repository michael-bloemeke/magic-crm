import { formatEventDate, todayISO } from '../pipeline'
import type { Task } from '../api'

type Props = {
  task: Task
  projectName?: string
  onToggle: (done: boolean) => void
  onDelete: () => void
  onOpenProject?: () => void
}

const OVERDUE = '#e08a6b'

export function TaskRow({ task, projectName, onToggle, onDelete, onOpenProject }: Props) {
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
