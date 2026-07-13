import { type Project } from '../pipeline'
import { EditableField } from './EditableField'

// The fuller event write-up, project notes (editable), and the activity log.
// Shown in the slide-in panel on the full project view, and inline at the bottom
// of the narrow side pane. The activity log is read-only and always newest-first.

// Activity-log entries are stored as "Month D, YYYY: ...". Show them newest first.
// Entries with no parseable date (e.g. "Earlier: ...") sink to the bottom, and
// same-day entries keep their original order (stable via the index tiebreaker).
function entryTime(entry: string): number {
  const m = entry.match(/^([A-Za-z]+ \d{1,2}, \d{4})/)
  if (!m) return -Infinity
  const t = Date.parse(m[1])
  return Number.isNaN(t) ? -Infinity : t
}
function sortActivityLog(log: string[]): string[] {
  return log
    .map((entry, i) => ({ entry, i, t: entryTime(entry) }))
    .sort((a, b) => b.t - a.t || a.i - b.i)
    .map((x) => x.entry)
}

export function ProjectNotesPanel({
  project,
  onSaveField,
}: {
  project: Project
  onSaveField: (field: string, value: string) => void
}) {
  const sortedLog = sortActivityLog(project.activityLog)
  return (
    <div className="space-y-8">
      <section>
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-brass-dim">Initial inquiry</h3>
        <div className="rounded-xl border border-line bg-surface-2/30 px-3 py-2">
          <EditableField
            value={project.initialInquiry}
            onSave={(v) => onSaveField('initialInquiry', v)}
            multiline
            placeholder="What the client typed into the website inquiry form."
          />
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-brass-dim">Full description</h3>
        <EditableField value={project.eventDescription} onSave={(v) => onSaveField('eventDescription', v)} multiline />
      </section>

      <section>
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-brass-dim">Notes</h3>
        <EditableField value={project.projectNotes} onSave={(v) => onSaveField('projectNotes', v)} multiline />
      </section>

      {sortedLog.length > 0 && (
        <section>
          <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-brass-dim">Activity log</h3>
          <ul className="space-y-3">
            {sortedLog.map((entry, i) => (
              <li key={i} className="relative pl-5 text-[13.5px] leading-relaxed text-muted">
                <span className="absolute left-0 top-[6px] h-1.5 w-1.5 rounded-full bg-brass-dim" />
                {i < sortedLog.length - 1 && (
                  <span className="absolute left-[2.5px] top-[14px] bottom-[-12px] w-px bg-line" />
                )}
                {entry}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
