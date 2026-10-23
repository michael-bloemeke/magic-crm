import { useEffect, useRef, useState } from 'react'
import { motion, Reorder, useDragControls } from 'motion/react'
import {
  createShow,
  deleteShow,
  loadShows,
  setPacked,
  uncheckAllPacked,
  updateShow,
  type PackingItem,
  type PackingItemType,
  type SetListItem,
  type Show,
} from '../api'

// SHOWS: set lists and packing lists.
//
// Michael, 2026-10-23: "a page to help me organize my packing list and my show structures." The page
// starts with the list of his shows; clicking one opens it, the way a project opens from the
// pipeline. A show has two tabs:
//
//   Set List      the running order, one block of text per trick, top to bottom. Read-only until
//                 Edit; in Edit he can drag to reorder, rename, delete and add. Done saves.
//   Packing List  the same kind of list, but every item has a checkbox he can tick WITHOUT editing,
//                 and in Edit he can also add a header (bold, no checkbox) or a blank line, to break
//                 the list into groups. "Uncheck all" clears every box at once.
//
// His instructions on the look: no arrows, no flow-chart spacing. Just a vertical list.
//
// ⚠️ The phone has the same page (mobile/app.js, "SHOWS"), reading the same `shows` rows, so a box
// ticked on the phone is ticked here. Keep the two in step.
//
// ⚠️ The row components are declared at MODULE scope on purpose. A component declared inside another
// is a new type on every render, so React remounts it and an input loses focus mid-typing (see
// react-inner-component-trap: it has bitten this app twice).

const newId = () => {
  try {
    return crypto.randomUUID()
  } catch {
    return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  }
}
const SHOW_KEY = 'crm:show'

const HANDLE = (
  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
    <circle cx="9" cy="6" r="1.6" />
    <circle cx="15" cy="6" r="1.6" />
    <circle cx="9" cy="12" r="1.6" />
    <circle cx="15" cy="12" r="1.6" />
    <circle cx="9" cy="18" r="1.6" />
    <circle cx="15" cy="18" r="1.6" />
  </svg>
)
const X_ICON = (
  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
)
const CHECK = (
  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="#ffffff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 12l5 5L20 6" />
  </svg>
)

const btnGhost =
  'rounded-lg border border-line bg-gradient-to-b from-surface-3 to-surface px-3 py-1.5 text-[12.5px] font-semibold text-brass-bright transition-all hover:border-brass-dim'
const btnSolid = 'rounded-lg bg-brass px-4 py-1.5 text-[12.5px] font-semibold text-[#ffffff] transition-all hover:brightness-110 disabled:opacity-40'
const inputCls =
  'w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-[14px] text-parchment placeholder:text-faint focus:border-brass-dim focus:outline-none'

export function ShowsPage() {
  const [shows, setShows] = useState<Show[] | null>(null)
  const [err, setErr] = useState('')
  const [openId, setOpenId] = useState<string | null>(() => localStorage.getItem(SHOW_KEY))
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')

  useEffect(() => {
    loadShows()
      .then(setShows)
      .catch((e) => setErr(e?.message || 'Could not load shows.'))
  }, [])

  const open = (id: string | null) => {
    setOpenId(id)
    if (id) localStorage.setItem(SHOW_KEY, id)
    else localStorage.removeItem(SHOW_KEY)
  }
  const replace = (s: Show) => setShows((prev) => (prev ? prev.map((x) => (x.id === s.id ? s : x)) : prev))

  const add = async () => {
    const n = newName.trim()
    if (!n) return
    try {
      const s = await createShow(n)
      setShows((prev) => [...(prev ?? []), s])
      setNewName('')
      setAdding(false)
      open(s.id)
    } catch (e) {
      setErr((e as Error)?.message || 'Could not add the show.')
    }
  }

  const current = openId && shows ? shows.find((s) => s.id === openId) ?? null : null

  if (current) {
    return (
      <ShowDetail
        show={current}
        onBack={() => open(null)}
        onSaved={replace}
        onDeleted={(id) => {
          setShows((prev) => (prev ? prev.filter((x) => x.id !== id) : prev))
          open(null)
        }}
      />
    )
  }

  return (
    <div className="board-scroll h-full overflow-y-auto px-8 pb-12">
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }} className="max-w-3xl">
        <div className="mb-5 flex flex-wrap items-center gap-2">
          {adding ? (
            <>
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void add()
                  if (e.key === 'Escape') setAdding(false)
                }}
                placeholder="Name the show"
                className="min-w-[16rem] flex-1 rounded-lg border border-line bg-surface-2 px-3 py-2 text-[13.5px] text-parchment placeholder:text-faint focus:border-brass-dim focus:outline-none"
              />
              <button type="button" onClick={() => void add()} disabled={!newName.trim()} className={btnSolid + ' py-2'}>
                Add show
              </button>
              <button type="button" onClick={() => setAdding(false)} className="px-2 text-[12.5px] text-muted hover:text-parchment">
                Cancel
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setAdding(true)} className={btnGhost + ' py-2'}>
              + New show
            </button>
          )}
        </div>
        {err && <p className="mb-4 text-[12.5px] text-[#f87171]">{err}</p>}
        {!shows ? (
          <p className="animate-pulse text-[13px] text-faint">Loading shows…</p>
        ) : shows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <p className="font-display text-[20px] text-parchment">No shows yet</p>
            <p className="mt-2 max-w-sm text-[13px] leading-relaxed text-muted">
              Add one above. Each show gets a set list and a packing list.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {shows.map((s) => {
              const items = s.packingList.filter((x) => x.type === 'item')
              const packed = items.filter((x) => x.done).length
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => open(s.id)}
                  className="flex items-center justify-between gap-4 rounded-xl border border-line bg-surface px-5 py-4 text-left transition-all hover:-translate-y-0.5 hover:border-line-strong"
                >
                  <div className="min-w-0">
                    <p className="truncate font-display text-[18px] leading-snug text-parchment">{s.name}</p>
                    <p className="mt-1 text-[12px] text-muted">
                      {s.setList.length} in the set list · {items.length ? `${packed} of ${items.length} packed` : 'nothing to pack yet'}
                    </p>
                  </div>
                  <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-faint" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 6l6 6-6 6" />
                  </svg>
                </button>
              )
            })}
          </div>
        )}
      </motion.div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
type Tab = 'set' | 'pack'

function ShowDetail({
  show,
  onBack,
  onSaved,
  onDeleted,
}: {
  show: Show
  onBack: () => void
  onSaved: (s: Show) => void
  onDeleted: (id: string) => void
}) {
  const [tab, setTab] = useState<Tab>('set')
  const [editing, setEditing] = useState(false)
  const [setDraft, setSetDraft] = useState<SetListItem[]>([])
  const [packDraft, setPackDraft] = useState<PackingItem[]>([])
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(show.name)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  const startEdit = () => {
    setSetDraft(show.setList.map((x) => ({ ...x })))
    setPackDraft(show.packingList.map((x) => ({ ...x })))
    setErr('')
    setEditing(true)
  }
  const switchTab = (t: Tab) => {
    if (editing) return // finish (Done) before leaving, so nothing half-edited is lost
    setTab(t)
  }
  const done = async () => {
    setBusy(true)
    try {
      const saved = await updateShow(show.id, tab === 'set' ? { setList: setDraft } : { packingList: packDraft })
      onSaved(saved)
      setEditing(false)
    } catch (e) {
      setErr((e as Error)?.message || 'Could not save.')
    } finally {
      setBusy(false)
    }
  }
  const saveName = async () => {
    const n = name.trim()
    if (!n || n === show.name) {
      setRenaming(false)
      setName(show.name)
      return
    }
    try {
      onSaved(await updateShow(show.id, { name: n }))
      setRenaming(false)
    } catch (e) {
      setErr((e as Error)?.message || 'Could not rename.')
    }
  }
  const remove = async () => {
    if (!window.confirm(`Delete "${show.name}"?\n\nIts set list and packing list go with it. This cannot be undone.`)) return
    try {
      await deleteShow(show.id)
      onDeleted(show.id)
    } catch (e) {
      setErr((e as Error)?.message || 'Could not delete.')
    }
  }
  const toggle = async (item: PackingItem) => {
    // Optimistic: the box flips now, the server copy follows.
    onSaved({ ...show, packingList: show.packingList.map((x) => (x.id === item.id ? { ...x, done: !x.done } : x)) })
    try {
      onSaved(await setPacked(show.id, item.id, !item.done))
    } catch (e) {
      onSaved(show)
      setErr((e as Error)?.message || 'Could not save that checkmark.')
    }
  }
  const uncheckAll = async () => {
    const n = show.packingList.filter((x) => x.type === 'item' && x.done).length
    if (!n) return
    if (!window.confirm(`Uncheck all ${n} packed item${n === 1 ? '' : 's'}?`)) return
    try {
      onSaved(await uncheckAllPacked(show.id))
    } catch (e) {
      setErr((e as Error)?.message || 'Could not uncheck the list.')
    }
  }

  const items = show.packingList.filter((x) => x.type === 'item')
  const packed = items.filter((x) => x.done).length

  return (
    <motion.div ref={scrollRef} layoutScroll className="board-scroll h-full overflow-y-auto px-8 pb-16">
      <div className="max-w-3xl">
        <button type="button" onClick={onBack} className="mb-3 inline-flex items-center gap-1 text-[12.5px] font-medium text-muted hover:text-parchment">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 6l-6 6 6 6" />
          </svg>
          All shows
        </button>

        <div className="mb-4 flex flex-wrap items-center gap-3">
          {renaming ? (
            <>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveName()
                  if (e.key === 'Escape') {
                    setRenaming(false)
                    setName(show.name)
                  }
                }}
                className="min-w-[16rem] flex-1 rounded-lg border border-line bg-surface-2 px-3 py-2 font-display text-[20px] text-parchment focus:border-brass-dim focus:outline-none"
              />
              <button type="button" onClick={() => void saveName()} className={btnSolid + ' py-2'}>
                Save
              </button>
            </>
          ) : (
            <>
              <h2 className="min-w-0 flex-1 truncate font-display text-[28px] leading-tight text-parchment">{show.name}</h2>
              <button type="button" onClick={() => setRenaming(true)} className="text-[12.5px] font-medium text-muted hover:text-parchment">
                Rename
              </button>
              <button type="button" onClick={() => void remove()} className="text-[12.5px] font-medium text-[#f87171] hover:brightness-110">
                Delete show
              </button>
            </>
          )}
        </div>

        {/* The two tabs. */}
        <div className="mb-5 flex items-center justify-between gap-3 border-b border-line">
          <div className="flex gap-1">
            {(
              [
                ['set', 'Set List'],
                ['pack', 'Packing List'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => switchTab(id)}
                disabled={editing && tab !== id}
                className={[
                  '-mb-px border-b-2 px-3 pb-2.5 pt-1 text-[13.5px] font-semibold transition-colors disabled:opacity-40',
                  tab === id ? 'border-brass text-parchment' : 'border-transparent text-muted hover:text-parchment',
                ].join(' ')}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 pb-2">
            {tab === 'pack' && !editing && items.length > 0 && (
              <>
                <span className="text-[12px] tabular-nums text-muted">
                  {packed} of {items.length} packed
                </span>
                <button type="button" onClick={() => void uncheckAll()} disabled={!packed} className={btnGhost + ' disabled:opacity-40'}>
                  Uncheck all
                </button>
              </>
            )}
            {editing ? (
              <button type="button" onClick={() => void done()} disabled={busy} className={btnSolid}>
                {busy ? 'Saving…' : 'Done'}
              </button>
            ) : (
              <button type="button" onClick={startEdit} className={btnGhost}>
                Edit
              </button>
            )}
          </div>
        </div>

        {err && <p className="mb-3 text-[12.5px] text-[#f87171]">{err}</p>}

        {tab === 'set' ? (
          editing ? (
            <>
              <Reorder.Group axis="y" values={setDraft} onReorder={setSetDraft} as="div" className="flex flex-col gap-2">
                {setDraft.map((it) => (
                  <SetEditRow
                    key={it.id}
                    item={it}
                    onChange={(text) => setSetDraft((d) => d.map((x) => (x.id === it.id ? { ...x, text } : x)))}
                    onRemove={() => setSetDraft((d) => d.filter((x) => x.id !== it.id))}
                  />
                ))}
              </Reorder.Group>
              <div className="mt-3">
                <button type="button" onClick={() => setSetDraft((d) => [...d, { id: newId(), text: '' }])} className={btnGhost}>
                  + Add item
                </button>
              </div>
              <p className="mt-3 text-[12px] text-muted">Drag the handle to move an item. Done saves.</p>
            </>
          ) : show.setList.length === 0 ? (
            <EmptyNote text="The set list is empty. Click Edit to add the first item." />
          ) : (
            <div className="flex flex-col gap-2">
              {show.setList.map((it) => (
                <div key={it.id} className="whitespace-pre-wrap rounded-xl border border-line bg-surface px-4 py-3 text-[14.5px] leading-snug text-parchment">
                  {it.text}
                </div>
              ))}
            </div>
          )
        ) : editing ? (
          <>
            <Reorder.Group axis="y" values={packDraft} onReorder={setPackDraft} as="div" className="flex flex-col gap-2">
              {packDraft.map((it) => (
                <PackEditRow
                  key={it.id}
                  item={it}
                  onChange={(text) => setPackDraft((d) => d.map((x) => (x.id === it.id ? { ...x, text } : x)))}
                  onRemove={() => setPackDraft((d) => d.filter((x) => x.id !== it.id))}
                />
              ))}
            </Reorder.Group>
            <div className="mt-3 flex flex-wrap gap-2">
              {(
                [
                  ['item', '+ Item'],
                  ['header', '+ Header'],
                  ['blank', '+ Blank line'],
                ] as [PackingItemType, string][]
              ).map(([type, label]) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => setPackDraft((d) => [...d, { id: newId(), type, text: '', done: false }])}
                  className={btnGhost}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="mt-3 text-[12px] text-muted">Drag the handle to move a line. Done saves.</p>
          </>
        ) : show.packingList.length === 0 ? (
          <EmptyNote text="The packing list is empty. Click Edit to add items, headers and blank lines." />
        ) : (
          <div className="flex flex-col gap-2">
            {show.packingList.map((it) =>
              it.type === 'blank' ? (
                <div key={it.id} className="h-4" aria-hidden />
              ) : it.type === 'header' ? (
                <p key={it.id} className="px-1 pt-1 text-[17px] font-bold leading-snug text-parchment">
                  {it.text}
                </p>
              ) : (
                <button
                  key={it.id}
                  type="button"
                  onClick={() => void toggle(it)}
                  aria-pressed={it.done}
                  className="flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-left transition-colors hover:border-line-strong"
                >
                  <span
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] border-2 transition-colors"
                    style={{
                      borderColor: it.done ? 'var(--color-brass)' : 'var(--color-line-strong)',
                      backgroundColor: it.done ? 'var(--color-brass)' : 'transparent',
                    }}
                  >
                    {it.done && CHECK}
                  </span>
                  <span className={['text-[14.5px] leading-snug', it.done ? 'text-faint line-through' : 'text-parchment'].join(' ')}>{it.text}</span>
                </button>
              ),
            )}
          </div>
        )}
      </div>
    </motion.div>
  )
}

function EmptyNote({ text }: { text: string }) {
  return <p className="rounded-xl border border-dashed border-line px-4 py-12 text-center text-[13px] text-muted">{text}</p>
}

function SetEditRow({ item, onChange, onRemove }: { item: SetListItem; onChange: (t: string) => void; onRemove: () => void }) {
  const controls = useDragControls()
  return (
    <Reorder.Item value={item} dragListener={false} dragControls={controls} as="div" className="flex items-center gap-2 rounded-xl border border-line bg-surface px-2 py-2">
      <span
        onPointerDown={(e) => controls.start(e)}
        className="flex h-8 w-7 shrink-0 cursor-grab touch-none items-center justify-center text-faint active:cursor-grabbing"
        aria-label="Drag to move"
      >
        {HANDLE}
      </span>
      <input autoFocus={!item.text} value={item.text} onChange={(e) => onChange(e.target.value)} placeholder="Trick or title" className={inputCls} />
      <button type="button" onClick={onRemove} aria-label="Delete" className="shrink-0 rounded-md p-1.5 text-faint hover:text-[#dc2626]">
        {X_ICON}
      </button>
    </Reorder.Item>
  )
}

function PackEditRow({ item, onChange, onRemove }: { item: PackingItem; onChange: (t: string) => void; onRemove: () => void }) {
  const controls = useDragControls()
  return (
    <Reorder.Item value={item} dragListener={false} dragControls={controls} as="div" className="flex items-center gap-2 rounded-xl border border-line bg-surface px-2 py-2">
      <span
        onPointerDown={(e) => controls.start(e)}
        className="flex h-8 w-7 shrink-0 cursor-grab touch-none items-center justify-center text-faint active:cursor-grabbing"
        aria-label="Drag to move"
      >
        {HANDLE}
      </span>
      {item.type === 'blank' ? (
        <span className="flex-1 rounded-md border border-dashed border-line px-2.5 py-1.5 text-[12.5px] text-faint">Blank line</span>
      ) : item.type === 'header' ? (
        <input autoFocus={!item.text} value={item.text} onChange={(e) => onChange(e.target.value)} placeholder="Header" className={inputCls + ' text-[16px] font-bold'} />
      ) : (
        <>
          <span className="h-5 w-5 shrink-0 rounded-[6px] border-2 border-line-strong" aria-hidden />
          <input autoFocus={!item.text} value={item.text} onChange={(e) => onChange(e.target.value)} placeholder="Something to pack" className={inputCls} />
        </>
      )}
      <button type="button" onClick={onRemove} aria-label="Delete" className="shrink-0 rounded-md p-1.5 text-faint hover:text-[#dc2626]">
        {X_ICON}
      </button>
    </Reorder.Item>
  )
}
