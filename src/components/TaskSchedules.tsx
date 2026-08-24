import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  DAY_LABELS,
  SCHEDULE_FREQUENCIES,
  addTaskSchedule,
  deleteTaskSchedule,
  describeSchedule,
  loadTaskSchedules,
  runTaskScheduleNow,
  updateTaskSchedule,
  type ScheduleFrequency,
  type TaskSchedule,
} from '../api'
import type { Project } from '../pipeline'

// Recurring tasks, visible and editable.
//
// Michael, 2026-08-23: "I don't like the idea of things not being transparent... something that
// appears every week without any way for me to adjust it or change it or even see that it exists
// outside using Claude." Before this, the weekly Finances task was a hand-written Postgres job: it
// worked, but the only way to know it existed was to ask me. Now every recurrence is a row he can
// see, pause, edit or delete, and one generic job materialises all of them.

const inputCls =
  'w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-[13.5px] text-parchment placeholder:text-faint focus:border-brass focus:outline-none'
const labelCls = 'mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-faint'

type Draft = {
  title: string
  projectId: string
  frequency: ScheduleFrequency
  daysOfWeek: number[]
  dayOfMonth: number
  runTime: string
  dueTime: string
  active: boolean
}

const emptyDraft = (): Draft => ({
  title: '',
  projectId: '',
  frequency: 'weekly',
  daysOfWeek: [1],
  dayOfMonth: 1,
  runTime: '07:00',
  dueTime: '',
  active: true,
})

export function TaskSchedules({ projects, onTasksChanged }: { projects: Project[]; onTasksChanged: () => void }) {
  const [schedules, setSchedules] = useState<TaskSchedule[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<TaskSchedule | 'new' | null>(null)
  const [err, setErr] = useState('')
  const [note, setNote] = useState('')

  const refresh = () =>
    loadTaskSchedules()
      .then(setSchedules)
      .catch((e) => setErr(e?.message || 'Could not load schedules.'))
      .finally(() => setLoading(false))

  useEffect(() => {
    void refresh()
  }, [])

  const toggleActive = async (s: TaskSchedule) => {
    const saved = await updateTaskSchedule(s.id, { active: !s.active })
    setSchedules((prev) => prev.map((x) => (x.id === saved.id ? saved : x)))
  }

  const runNow = async (s: TaskSchedule) => {
    setNote('')
    try {
      const r = await runTaskScheduleNow(s.id)
      setNote(r.created ? `Added "${s.title}" to today's tasks.` : `"${s.title}" is already on today's list.`)
      onTasksChanged()
      void refresh()
    } catch (e) {
      setErr((e as Error)?.message || 'Could not run that schedule.')
    }
  }

  const remove = async (s: TaskSchedule) => {
    if (
      !window.confirm(
        `Stop scheduling "${s.title}"?\n\nTasks it has already created stay on your list. This only stops future ones.`,
      )
    )
      return
    await deleteTaskSchedule(s.id)
    setSchedules((prev) => prev.filter((x) => x.id !== s.id))
  }

  return (
    <section className="mt-10 border-t border-line pt-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-[17px] leading-tight text-parchment">Scheduled tasks</h2>
          <p className="text-[11.5px] text-faint">
            These create themselves on a repeat. They run in the cloud, so your laptop can be shut.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setErr('')
            setNote('')
            setEditing('new')
          }}
          className="rounded-lg bg-brass px-3.5 py-2 text-[12.5px] font-semibold text-white transition-all hover:brightness-110"
        >
          New schedule
        </button>
      </div>

      {err && <p className="mb-3 text-[12.5px] text-[#dc2626]">{err}</p>}
      {note && <p className="mb-3 text-[12.5px] text-[#15803d]">{note}</p>}

      {loading ? (
        <p className="py-6 text-center text-[12.5px] text-faint">Loading…</p>
      ) : schedules.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-4 py-8 text-center text-[12.5px] text-faint">
          Nothing scheduled. Add one for anything you want to be reminded of on a repeat.
        </p>
      ) : (
        <div className="space-y-2">
          {schedules.map((s) => (
            <div
              key={s.id}
              className={[
                'flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3',
                s.active ? '' : 'opacity-55',
              ].join(' ')}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-medium text-parchment">
                  {s.title}
                  {!s.active && <span className="ml-2 text-[11px] font-semibold uppercase tracking-wide text-faint">Paused</span>}
                </p>
                <p className="text-[11.5px] text-muted">
                  {describeSchedule(s)}
                  {s.projectId && (
                    <span className="text-faint">
                      {' · '}
                      {projects.find((p) => p.id === s.projectId)?.client ?? s.projectId}
                    </span>
                  )}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button type="button" onClick={() => void runNow(s)} className="rounded-lg border border-line px-2.5 py-1.5 text-[12px] text-muted transition-colors hover:text-parchment">
                  Run now
                </button>
                <button type="button" onClick={() => void toggleActive(s)} className="rounded-lg border border-line px-2.5 py-1.5 text-[12px] text-muted transition-colors hover:text-parchment">
                  {s.active ? 'Pause' : 'Resume'}
                </button>
                <button type="button" onClick={() => { setErr(''); setNote(''); setEditing(s) }} className="rounded-lg border border-line px-2.5 py-1.5 text-[12px] text-muted transition-colors hover:text-parchment">
                  Edit
                </button>
                <button type="button" onClick={() => void remove(s)} className="rounded-lg border border-line px-2.5 py-1.5 text-[12px] text-muted transition-colors hover:border-[#dc2626]/50 hover:text-[#dc2626]">
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <ScheduleModal
        target={editing}
        projects={projects}
        onClose={() => setEditing(null)}
        onSaved={(saved, isNew) => {
          setSchedules((prev) => (isNew ? [...prev, saved] : prev.map((x) => (x.id === saved.id ? saved : x))))
          setEditing(null)
        }}
      />
    </section>
  )
}

function ScheduleModal({
  target,
  projects,
  onClose,
  onSaved,
}: {
  target: TaskSchedule | 'new' | null
  projects: Project[]
  onClose: () => void
  onSaved: (s: TaskSchedule, isNew: boolean) => void
}) {
  const [f, setF] = useState<Draft>(emptyDraft())
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const isNew = target === 'new'

  useEffect(() => {
    if (!target) return
    setErr('')
    if (target === 'new') setF(emptyDraft())
    else
      setF({
        title: target.title,
        projectId: target.projectId,
        frequency: target.frequency,
        daysOfWeek: target.daysOfWeek.length ? target.daysOfWeek : [1],
        dayOfMonth: target.dayOfMonth ?? 1,
        runTime: target.runTime,
        dueTime: target.dueTime,
        active: target.active,
      })
  }, [target])

  useEffect(() => {
    if (!target) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [target, onClose])

  const toggleDay = (iso: number) =>
    setF((p) => ({
      ...p,
      daysOfWeek: p.daysOfWeek.includes(iso) ? p.daysOfWeek.filter((d) => d !== iso) : [...p.daysOfWeek, iso].sort(),
    }))

  const submit = async () => {
    if (!f.title.trim()) {
      setErr('Give it a title.')
      return
    }
    if (f.frequency === 'weekly' && f.daysOfWeek.length === 0) {
      setErr('Pick at least one day.')
      return
    }
    setBusy(true)
    try {
      const saved = isNew ? await addTaskSchedule(f) : await updateTaskSchedule((target as TaskSchedule).id, f)
      onSaved(saved, isNew)
    } catch (e) {
      setErr((e as Error)?.message || 'Could not save.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <AnimatePresence>
      {!!target && (
        <motion.div
          className="fixed inset-0 z-[80] flex justify-center overflow-y-auto px-4 py-[10vh]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
          <motion.div
            initial={{ opacity: 0, y: -10, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.985 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className="relative z-10 h-fit w-full max-w-[520px] rounded-2xl border border-line-strong bg-surface shadow-[0_40px_80px_-30px_rgba(0,0,0,0.25)]"
          >
            <div className="border-b border-line px-5 py-4">
              <p className="text-[15px] font-semibold text-parchment">{isNew ? 'New scheduled task' : 'Edit schedule'}</p>
            </div>
            <div className="space-y-3 p-5">
              <div>
                <span className={labelCls}>Task title *</span>
                <input value={f.title} onChange={(e) => setF((p) => ({ ...p, title: e.target.value }))} placeholder="Finances" className={inputCls} />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <span className={labelCls}>Repeats</span>
                  <select
                    value={f.frequency}
                    onChange={(e) => setF((p) => ({ ...p, frequency: e.target.value as ScheduleFrequency }))}
                    className={inputCls}
                  >
                    {SCHEDULE_FREQUENCIES.map((x) => (
                      <option key={x} value={x}>
                        {x[0].toUpperCase() + x.slice(1)}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <span className={labelCls}>Appears at</span>
                  <input type="time" value={f.runTime} onChange={(e) => setF((p) => ({ ...p, runTime: e.target.value }))} className={inputCls} />
                </div>
              </div>

              {f.frequency === 'weekly' && (
                <div>
                  <span className={labelCls}>On these days</span>
                  <div className="flex flex-wrap gap-1.5">
                    {DAY_LABELS.map((d, i) => {
                      const iso = i + 1
                      const on = f.daysOfWeek.includes(iso)
                      return (
                        <button
                          key={d}
                          type="button"
                          onClick={() => toggleDay(iso)}
                          className={[
                            'rounded-lg border px-3 py-1.5 text-[12px] font-medium transition-colors',
                            on ? 'border-brass bg-brass text-white' : 'border-line text-muted hover:text-parchment',
                          ].join(' ')}
                        >
                          {d}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}

              {f.frequency === 'monthly' && (
                <div>
                  <span className={labelCls}>Day of the month</span>
                  <input
                    type="number"
                    min={1}
                    max={31}
                    value={f.dayOfMonth}
                    onChange={(e) => setF((p) => ({ ...p, dayOfMonth: Number(e.target.value) }))}
                    className={inputCls}
                  />
                  <p className="mt-1 text-[11px] text-faint">
                    Pick 29, 30 or 31 and short months fall back to their last day, so it never skips a month.
                  </p>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <span className={labelCls}>Project (optional)</span>
                  <select value={f.projectId} onChange={(e) => setF((p) => ({ ...p, projectId: e.target.value }))} className={inputCls}>
                    <option value="">No project</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.client}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <span className={labelCls}>Due time (optional)</span>
                  <input type="time" value={f.dueTime} onChange={(e) => setF((p) => ({ ...p, dueTime: e.target.value }))} className={inputCls} />
                </div>
              </div>

              <p className="text-[11.5px] leading-relaxed text-faint">
                The task is due the day it appears. Times are your local time, and stay correct through
                daylight saving.
              </p>

              {err && <p className="text-[12.5px] text-[#dc2626]">{err}</p>}

              <div className="flex items-center justify-end gap-2 pt-1">
                <button type="button" onClick={onClose} className="rounded-lg border border-line px-3.5 py-2 text-[12.5px] text-muted hover:text-parchment">
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={submit}
                  disabled={busy}
                  className="rounded-lg bg-brass px-4 py-2 text-[12.5px] font-semibold text-white hover:brightness-110 disabled:opacity-40"
                >
                  {busy ? 'Saving…' : isNew ? 'Create schedule' : 'Save'}
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
