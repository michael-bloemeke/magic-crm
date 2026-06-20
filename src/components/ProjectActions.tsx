import type { Project } from '../pipeline'

// Archive / Complete / Restore buttons shown on an open project. Active projects
// can be completed or archived (both move it out of the pipeline); archived or
// completed projects can be returned to the pipeline.

type Props = {
  project: Project
  onArchive: () => void
  onComplete: () => void
  onRestore: () => void
  onDelete: () => void
  onLogCall: () => void
  compact?: boolean
}

// "Made a call" — logs the call (with today's date) to the project's activity log
// after a couple of quick questions. Available on every project.
function CallButton({ onLogCall, compact, pad }: { onLogCall: () => void; compact?: boolean; pad: string }) {
  const icon = (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  )
  if (compact) {
    return (
      <button
        type="button"
        onClick={onLogCall}
        title="Log a call you made"
        aria-label="Log a call you made"
        className="inline-flex items-center justify-center rounded-lg border border-line p-1.5 text-muted transition-colors hover:border-brass-dim hover:text-brass-bright"
      >
        {icon}
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={onLogCall}
      title="Log a call you made"
      className={`inline-flex items-center gap-1.5 rounded-lg border border-line ${pad} font-semibold text-muted transition-colors hover:border-brass-dim hover:text-brass-bright`}
    >
      {icon}
      Log a call
    </button>
  )
}

// A small, muted trash button. Deleting is permanent (record removed from the
// database), so it's visually de-emphasised and goes through a confirm dialog.
function DeleteButton({ onDelete, compact }: { onDelete: () => void; compact?: boolean }) {
  return (
    <button
      type="button"
      onClick={onDelete}
      title="Delete this project permanently (removes it from your records)"
      aria-label="Delete project"
      className={`inline-flex items-center justify-center rounded-lg border border-line text-faint transition-colors hover:border-[#e08a6b]/60 hover:text-[#e08a6b] ${
        compact ? 'p-1.5' : 'p-2'
      }`}
    >
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6M10 11v6M14 11v6" />
      </svg>
    </button>
  )
}

export function ProjectActions({ project, onArchive, onComplete, onRestore, onDelete, onLogCall, compact }: Props) {
  const pad = compact ? 'px-2.5 py-1.5 text-[11.5px]' : 'px-3 py-2 text-[12.5px]'

  if (project.bucket !== 'active') {
    return (
      <div className="flex items-start gap-2">
        <CallButton onLogCall={onLogCall} compact={compact} pad={pad} />
        <div className="flex flex-col items-end">
          <span className="rounded-full border border-line bg-surface-2 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
            {project.bucket === 'archived' ? 'Archived' : 'Completed'}
          </span>
          {project.bucket === 'archived' && project.archiveReason && (
            <span className="mt-1 max-w-[15rem] text-right text-[11px] leading-snug text-faint" title={project.archiveReason}>
              {project.archiveReason}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onRestore}
          className={`inline-flex items-center gap-1.5 rounded-lg border border-line ${pad} font-semibold text-muted transition-colors hover:border-brass-dim hover:text-brass-bright`}
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5" />
          </svg>
          Return to pipeline
        </button>
        <DeleteButton onDelete={onDelete} compact={compact} />
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <CallButton onLogCall={onLogCall} compact={compact} pad={pad} />
      <button
        type="button"
        onClick={onComplete}
        title="Mark this project complete and move it to Completed"
        className={`inline-flex items-center gap-1.5 rounded-lg border ${pad} font-semibold transition-colors`}
        style={{
          borderColor: 'color-mix(in oklab, var(--color-umb-booked) 50%, transparent)',
          color: 'var(--color-umb-booked)',
        }}
      >
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6L9 17l-5-5" />
        </svg>
        Complete
      </button>
      <button
        type="button"
        onClick={onArchive}
        title="Archive this project and move it out of the pipeline"
        className={`inline-flex items-center gap-1.5 rounded-lg border border-line ${pad} font-semibold text-muted transition-colors hover:border-brass-dim hover:text-brass-bright`}
      >
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="4" rx="1" />
          <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" />
        </svg>
        Archive
      </button>
      <DeleteButton onDelete={onDelete} compact={compact} />
    </div>
  )
}
