import { TASK_LENGTHS, taskLengthLabel, type TaskTiming } from '../api'

// The two extra task controls (Michael, 2026-11-12): how long the task runs, and whether it shows as
// Busy or Free on Google Calendar. They only matter once a time is picked, because a task with no
// time never goes on the calendar, so they stay greyed out until then. Free is the default: a free
// task shows on the calendar but does not stop a client booking a TidyCal call over it.
//
// Module scope on purpose (see the inner-component trap note in TasksPage.tsx).
export function TaskTimingInputs({
  value,
  onChange,
  hasTime,
  className,
}: {
  value: TaskTiming
  onChange: (next: TaskTiming) => void
  hasTime: boolean
  className: string
}) {
  const lengths = TASK_LENGTHS.includes(value.durationMin)
    ? TASK_LENGTHS
    : [...TASK_LENGTHS, value.durationMin].sort((a, b) => a - b)
  const hint = hasTime ? '' : 'Pick a time first. A task without a time stays off your calendar.'
  return (
    <>
      <select
        value={value.durationMin}
        onChange={(e) => onChange({ ...value, durationMin: Number(e.target.value) })}
        disabled={!hasTime}
        title={hint || 'How long this task runs on your calendar'}
        aria-label="Task length"
        className={`${className} disabled:opacity-40`}
      >
        {lengths.map((m) => (
          <option key={m} value={m}>
            {taskLengthLabel(m)}
          </option>
        ))}
      </select>
      <select
        value={value.busy ? 'busy' : 'free'}
        onChange={(e) => onChange({ ...value, busy: e.target.value === 'busy' })}
        disabled={!hasTime}
        title={hint || 'Busy blocks TidyCal from booking a call over this task. Free does not.'}
        aria-label="Busy or free"
        className={`${className} disabled:opacity-40`}
      >
        <option value="free">Free</option>
        <option value="busy">Busy</option>
      </select>
    </>
  )
}
