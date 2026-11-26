import { useEffect, useRef, useState } from 'react'
import {
  loadProposalEditor,
  loadTemplateEditor,
  saveProposal,
  saveProposalLibrary,
  type BankReview,
  type LibraryPackage,
  type LibraryStyle,
  type ProposalEditState,
  type ProposalLibrary,
  type ProposalReview,
} from '../api'
import { type PreviewTarget } from './PreviewPage'

// THE PROPOSAL EDITOR (Michael, 2026-11-26).
//
// His ask: "instead of it being just a preview, it's going to be like an editor." A tiny mistake on
// a proposal used to mean a round trip through Claude. Now the preview IS the editor: the real
// proposal page, framed exactly as before, with the title, the Your Event heading and write-up, the
// performance styles, the packages and the follow-up date typed straight onto the page, and a panel
// on the right for picking saved styles, reviews and packages.
//
// ⚠️ IT IS STILL THE REAL PAGE, AND IT STILL NEVER COUNTS AS A VIEW. The frame loads the same
// server-built preview link PreviewPage uses (`preview=1`, plus the admin key when the page is not
// public) with `&edit=1` added. The page switches its edit mode on only inside a frame, talks only to
// this window, and saves nothing itself: every change is posted here and saved through the CRM's own
// data layer, which is the only thing holding the database key. The `proposal` edge function and the
// client's link are untouched.
//
// TWO MODES.
//   proposal  one client's proposal. Everything Michael listed is editable, and edits change ONLY
//             that proposal: adding a saved style or package copies it in.
//   template  the Proposals page's "Proposal template". Edits the SAVED performance styles and
//             packages in `proposal_library`, which every new proposal is built from. Proposals
//             already made keep their own copies.
//
// What is deliberately NOT editable, his list: the rest of Next steps, the closing "Questions?"
// block, the logos, the bio, the review text itself, and any font, size or style. Text only.

const STYLE_CAP = 4 // the edge function shows four styles at most
const PACKAGE_CAP = 3 // and three packages
const REVIEW_CAP = 5 // and five reviews

const PRESETS: { key: string; label: string }[] = [
  { key: 'wedding', label: 'Weddings' },
  { key: 'corporate', label: 'Corporate' },
  { key: 'general', label: 'General' },
  { key: 'house', label: 'House party and bachelorette' },
]

const FILTERS: { key: string; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'best', label: 'Best' },
  { key: 'wedding', label: 'Weddings' },
  { key: 'corporate', label: 'Corporate' },
  { key: 'holiday', label: 'Holiday' },
  { key: 'house', label: 'House party' },
  { key: 'bachelorette', label: 'Bachelorette' },
  { key: 'mingling', label: 'Close-up and mingling' },
  { key: 'show', label: 'Stage show' },
]

type Mode = 'proposal' | 'template'
type TemplateState = { styles: LibraryStyle[]; packages: LibraryPackage[] }
type AnyState = ProposalEditState | TemplateState
type Loaded = {
  src: string
  publicUrl: string
  state: AnyState
  library: ProposalLibrary
  photos: string[]
}
type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error'

const SITE = 'https://michaelbloemeke.com'
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

// A review on the proposal is "the same" as a bank entry when it came from it, or, for reviews
// added before the bank existed, when the name and the opening words match.
function sameReview(r: ProposalReview, b: BankReview) {
  if (r.bank_id) return r.bank_id === b.id
  return r.name === b.name && norm(r.text).slice(0, 40) === norm(b.text).slice(0, 40)
}
const toProposalReview = (b: BankReview): ProposalReview => ({
  name: b.name,
  text: b.text,
  company: b.company || '',
  highlight: b.highlight || [],
  bank_id: b.id,
})

// Saves one state. Outside the component so the unmount save and the debounced save are the same
// code with nothing captured from a stale render.
async function persist(mode: Mode, projectId: string, s: AnyState) {
  if (mode === 'proposal') {
    const p = s as ProposalEditState
    await saveProposal(projectId, {
      headline: p.headline ?? '',
      event_title: p.event_title ?? '',
      event_copy: p.event_copy ?? '',
      styles: p.styles ?? [],
      packages: p.packages ?? [],
      reviews: p.reviews ?? [],
      followup: p.followup ?? '',
    })
  } else {
    const t = s as TemplateState
    await saveProposalLibrary({ styles: t.styles, packages: t.packages })
  }
}

export function ProposalEditor({ target, onBack }: { target: PreviewTarget; onBack: () => void }) {
  const editor = target.editor!
  const mode: Mode = editor.mode
  const projectId = editor.mode === 'proposal' ? editor.projectId : ''

  const [data, setData] = useState<Loaded | null>(null)
  const [loadError, setLoadError] = useState('')
  // The editable fields. `state` drives the panel; `stateRef` is the same value for the saves,
  // which run later and must always store the newest version. Both are set together, in handlers.
  const [state, setState] = useState<AnyState | null>(null)
  const stateRef = useRef<AnyState | null>(null)

  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const [frameKey, setFrameKey] = useState(0)
  const [pageReady, setPageReady] = useState(false)
  const [slowPage, setSlowPage] = useState(false)

  const [save, setSave] = useState<SaveState>('idle')
  const [saveError, setSaveError] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Saves run one after another on this chain, so two can never race and the last one wins.
  const queue = useRef<Promise<void>>(Promise.resolve())
  const dirty = useRef(false)

  const [tab, setTab] = useState<'styles' | 'reviews' | 'packages'>(mode === 'template' ? 'packages' : 'styles')
  const [photoFor, setPhotoFor] = useState<number | null>(null)
  const [filter, setFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [copied, setCopied] = useState(false)

  // --- Load --------------------------------------------------------------------------------
  useEffect(() => {
    let dead = false
    const go = async () => {
      try {
        if (mode === 'proposal') {
          const d = await loadProposalEditor(projectId)
          if (dead) return
          const st = clone(d.state)
          stateRef.current = st
          setState(st)
          setData({ src: d.src, publicUrl: d.publicUrl, state: d.state, library: d.library, photos: d.photos })
        } else {
          const d = await loadTemplateEditor()
          if (dead) return
          const st: TemplateState = clone({ styles: d.library.styles, packages: d.library.packages })
          stateRef.current = st
          setState(st)
          setData({ src: d.src, publicUrl: '', state: st, library: d.library, photos: d.photos })
        }
      } catch (e) {
        if (!dead) setLoadError(String(e instanceof Error ? e.message : e))
      }
    }
    go()
    return () => {
      dead = true
    }
  }, [mode, projectId])

  let frameOrigin = ''
  try {
    frameOrigin = data?.src ? new URL(data.src).origin : ''
  } catch {
    frameOrigin = ''
  }

  // --- Saving --------------------------------------------------------------------------------
  const saveIfDirty = async () => {
    if (!dirty.current || !stateRef.current) return
    dirty.current = false
    setSave('saving')
    try {
      await persist(mode, projectId, stateRef.current)
      setSaveError('')
      setSave(dirty.current ? 'pending' : 'saved')
    } catch (e) {
      dirty.current = true
      setSave('error')
      setSaveError(String(e instanceof Error ? e.message : e))
    }
  }
  const flush = () => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    queue.current = queue.current.then(saveIfDirty)
    return queue.current
  }
  const scheduleSave = () => {
    dirty.current = true
    setSave('pending')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      flush()
    }, 700)
  }
  const back = async () => {
    await flush()
    onBack()
  }

  // --- Talking to the page --------------------------------------------------------------------
  const pushToPage = (st: AnyState | null) => {
    const w = frameRef.current?.contentWindow
    if (!w || !frameOrigin || !st) return
    w.postMessage({ source: 'crm-editor', type: 'set', mode, state: st }, frameOrigin)
  }

  // The listeners read the newest handlers through this ref, so they are attached once and never
  // act on a stale render.
  const handlers = useRef({ message: (e: MessageEvent) => void e, key: (e: KeyboardEvent) => void e, unmount: () => {} })
  useEffect(() => {
    handlers.current.message = (e: MessageEvent) => {
      if (!frameOrigin || e.origin !== frameOrigin) return
      if (e.source !== frameRef.current?.contentWindow) return
      const m = e.data as { source?: string; type?: string; state?: AnyState; index?: number }
      if (!m || m.source !== 'pr-editor') return
      if (m.type === 'ready') {
        setPageReady(true)
        setSlowPage(false)
        pushToPage(stateRef.current)
      } else if (m.type === 'change' && m.state) {
        stateRef.current = m.state
        setState(m.state)
        scheduleSave()
      } else if (m.type === 'pick-photo' && typeof m.index === 'number') {
        setPhotoFor(m.index)
      }
    }
    handlers.current.key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (photoFor !== null) setPhotoFor(null)
      else back()
    }
    // Leaving by the sidebar or search unmounts this without Back. Save whatever is pending anyway.
    handlers.current.unmount = () => {
      if (timer.current) clearTimeout(timer.current)
      if (dirty.current && stateRef.current) persist(mode, projectId, stateRef.current).catch(() => {})
    }
  })
  useEffect(() => {
    const h = handlers.current
    const onMessage = (e: MessageEvent) => h.message(e)
    const onKey = (e: KeyboardEvent) => h.key(e)
    window.addEventListener('message', onMessage)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('message', onMessage)
      window.removeEventListener('keydown', onKey)
      h.unmount()
    }
  }, [])

  // A page that never says hello is almost always the website still serving the version from
  // before the editor existed (Cloudflare caches it for a few minutes after a deploy).
  useEffect(() => {
    if (!data || pageReady) return
    const t = setTimeout(() => setSlowPage(true), 9000)
    return () => clearTimeout(t)
  }, [data, pageReady, frameKey])

  // Changes made from the panel: edit a copy, hand it to the page, save it.
  const change = (fn: (s: AnyState) => void) => {
    if (!stateRef.current) return
    const next = clone(stateRef.current)
    fn(next)
    stateRef.current = next
    setState(next)
    pushToPage(next)
    scheduleSave()
  }

  const copy = () => {
    if (!data?.publicUrl) return
    navigator.clipboard.writeText(data.publicUrl).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    })
  }

  // --- Panel actions -------------------------------------------------------------------------
  const pState = mode === 'proposal' ? (state as ProposalEditState | null) : null
  const styles = (state?.styles ?? []) as ProposalEditState['styles']
  const packages = (state?.packages ?? []) as ProposalEditState['packages']
  const reviews = pState?.reviews ?? []
  const lib = data?.library

  const hasStyle = (ls: LibraryStyle) => styles.some((x) => (x.key && x.key === ls.key) || norm(x.name) === norm(ls.name))
  const addStyle = (ls: LibraryStyle) =>
    change((st) => {
      ;(st.styles as LibraryStyle[]).push({ key: ls.key, name: ls.name, description: ls.description, photo: ls.photo || '', photo2: '' })
    })

  const addPackage = (lp: LibraryPackage | null) =>
    change((st) => {
      const anyHighlighted = (st.packages as LibraryPackage[]).some((p) => p.recommended)
      const base: LibraryPackage = lp
        ? clone(lp)
        : { key: `custom-${Date.now().toString(36)}`, name: '', tagline: '', price: '', duration: '', includes: [''], recommended: false }
      base.recommended = !!base.recommended && !anyHighlighted
      ;(st.packages as LibraryPackage[]).push(base)
    })

  const setPhoto = (index: number, path: string) => {
    change((st) => {
      const target = st.styles[index]
      if (target) target.photo = path
    })
    setPhotoFor(null)
  }

  const addReview = (b: BankReview) =>
    change((st) => {
      ;(st as ProposalEditState).reviews.push(toProposalReview(b))
    })
  const removeReview = (i: number) =>
    change((st) => {
      ;(st as ProposalEditState).reviews.splice(i, 1)
    })
  const moveReview = (from: number, to: number) =>
    change((st) => {
      const list = (st as ProposalEditState).reviews
      const [r] = list.splice(from, 1)
      list.splice(to, 0, r)
    })
  const applyPreset = (key: string, label: string) => {
    if (!lib) return
    const ids = lib.review_presets[key] || []
    const picked = ids.map((id) => lib.reviews.find((r) => r.id === id)).filter(Boolean) as BankReview[]
    if (!picked.length) return
    if (reviews.length && !window.confirm(`Replace the ${reviews.length} review${reviews.length === 1 ? '' : 's'} on this proposal with the ${label.toLowerCase()} set?`)) return
    change((st) => {
      ;(st as ProposalEditState).reviews = picked.map(toProposalReview)
    })
  }

  const q = norm(query)
  const bank = lib ? lib.reviews.filter((r) => (filter === 'all' || r.tags.includes(filter)) && (!q || norm(`${r.name} ${r.text}`).includes(q))) : []

  // --- Render --------------------------------------------------------------------------------
  const saveLabel =
    save === 'saving' ? 'Saving…' : save === 'pending' ? 'Unsaved changes' : save === 'saved' ? 'All changes saved' : save === 'error' ? 'Not saved' : ''

  const tabBtn = (key: 'styles' | 'reviews' | 'packages', label: string) => (
    <button
      key={key}
      type="button"
      onClick={() => setTab(key)}
      className={`rounded-md px-2.5 py-1.5 text-[12px] font-semibold transition-colors ${
        tab === key ? 'bg-surface-3 text-brass-bright' : 'text-muted hover:text-parchment'
      }`}
    >
      {label}
    </button>
  )

  const smallBtn =
    'shrink-0 rounded-md border border-brass-dim/60 bg-surface-3 px-2.5 py-1 text-[11.5px] font-semibold text-brass-bright transition-colors hover:border-brass disabled:cursor-not-allowed disabled:border-line disabled:text-faint'

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* The bar, outside the frame, so nothing in it can appear in what a client sees. */}
      <div className="flex shrink-0 items-center gap-3 border-b border-line bg-surface px-5 py-3">
        <button
          type="button"
          onClick={() => back()}
          className="flex items-center gap-2 rounded-lg border border-line-strong bg-surface-2 px-3.5 py-2 text-[13px] font-semibold text-parchment transition-colors hover:border-brass hover:text-brass-bright"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
            <path d="M15 18l-6-6 6-6" />
          </svg>
          {target.backLabel}
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-parchment">{target.title}</p>
          <p className="truncate text-[11.5px] text-muted">
            {mode === 'template'
              ? 'Editing the saved styles and packages. New proposals start from these.'
              : 'Click any outlined text on the page to change it. Changes save on their own.'}
          </p>
        </div>
        <span className={`shrink-0 text-[11.5px] ${save === 'error' ? 'text-rose-300' : 'text-muted'}`} title={saveError || undefined}>
          {saveLabel}
        </span>
        {mode === 'proposal' && <span className="hidden shrink-0 text-[11px] text-faint lg:block">Not counted as a view.</span>}
        {mode === 'proposal' && data?.publicUrl && (
          <button
            type="button"
            onClick={copy}
            title="Copies the clean link, without the preview flag. This is the one to send."
            className="shrink-0 rounded-lg border border-line px-3 py-1.5 text-[12px] font-medium text-muted transition-colors hover:border-brass hover:text-brass-bright"
          >
            {copied ? 'Copied' : 'Copy link'}
          </button>
        )}
      </div>

      {save === 'error' && saveError && (
        <div className="shrink-0 border-b border-rose-500/40 bg-rose-500/[0.08] px-5 py-2 text-[12px] text-rose-200">
          {saveError}{' '}
          <button type="button" className="underline" onClick={() => { dirty.current = true; flush() }}>
            Try again
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1 bg-surface-2">
          {loadError ? (
            <div className="absolute inset-0 flex items-center justify-center px-8">
              <p className="max-w-md text-center text-[13px] leading-relaxed text-rose-300">{loadError}</p>
            </div>
          ) : !data ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <p className="text-[12.5px] text-muted">Loading the editor…</p>
            </div>
          ) : (
            <>
              {!pageReady && (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-surface-2">
                  <p className="text-[12.5px] text-muted">{slowPage ? 'The page has not answered yet.' : 'Loading the page the client sees…'}</p>
                  {slowPage && (
                    <>
                      <p className="max-w-sm text-center text-[11.5px] leading-relaxed text-faint">
                        If the website was updated in the last few minutes, it can still be serving the old page for a moment.
                      </p>
                      <button
                        type="button"
                        className={smallBtn}
                        onClick={() => {
                          setSlowPage(false)
                          setPageReady(false)
                          setFrameKey((k) => k + 1)
                        }}
                      >
                        Reload the page
                      </button>
                    </>
                  )}
                </div>
              )}
              {/* No `sandbox`, same as PreviewPage: it frames Michael's own domain, and the page's
                  own links and video embed have to keep working. */}
              <iframe
                key={`${data.src}#${frameKey}`}
                ref={frameRef}
                src={data.src}
                title={target.title}
                className="h-full w-full border-0"
              />
            </>
          )}
        </div>

        {/* THE PANEL. Pick saved styles, reviews and packages. Typing happens on the page itself. */}
        {data && lib && (
          <aside className="flex w-[360px] shrink-0 flex-col border-l border-line bg-surface">
            <div className="flex shrink-0 gap-1 border-b border-line px-3 py-2">
              {mode === 'proposal' ? (
                <>
                  {tabBtn('styles', `Styles (${styles.length})`)}
                  {tabBtn('reviews', `Reviews (${reviews.length})`)}
                  {tabBtn('packages', `Packages (${packages.length})`)}
                </>
              ) : (
                <>
                  {tabBtn('packages', 'Packages')}
                  {tabBtn('styles', 'Styles')}
                </>
              )}
            </div>

            <div className="board-scroll min-h-0 flex-1 overflow-y-auto px-4 py-3">
              {tab === 'styles' && mode === 'proposal' && (
                <div className="space-y-2.5">
                  <p className="text-[11.5px] leading-relaxed text-muted">
                    Adding a style copies its saved write-up and photo onto this proposal. Anything you then change on the page changes this proposal only. Up to {STYLE_CAP} show.
                  </p>
                  {lib.styles.map((ls) => {
                    const added = hasStyle(ls)
                    return (
                      <div key={ls.key} className="flex gap-3 rounded-lg border border-line bg-surface-2/50 p-2.5">
                        {ls.photo ? (
                          <img src={`${SITE}${ls.photo}`} alt="" className="h-14 w-20 shrink-0 rounded object-cover" />
                        ) : (
                          <div className="h-14 w-20 shrink-0 rounded bg-surface-3" />
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="text-[12.5px] font-semibold text-parchment">{ls.name}</p>
                          <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-muted">{ls.description}</p>
                        </div>
                        <button
                          type="button"
                          className={smallBtn + ' self-center'}
                          disabled={added || styles.length >= STYLE_CAP}
                          onClick={() => addStyle(ls)}
                        >
                          {added ? 'Added' : 'Add'}
                        </button>
                      </div>
                    )
                  })}
                  <p className="pt-1 text-[11px] leading-relaxed text-faint">
                    To remove, reorder or change a photo, use the buttons above each style on the page.
                  </p>
                </div>
              )}

              {tab === 'styles' && mode === 'template' && (
                <div className="space-y-2 text-[11.5px] leading-relaxed text-muted">
                  <p>
                    The four saved performance styles are on the page under Performance Styles. Click a name or a description to change it, or use Change photo.
                  </p>
                  <p>Changes here become the default for every new proposal. Proposals already made keep what they have.</p>
                </div>
              )}

              {tab === 'packages' && (
                <div className="space-y-2.5">
                  {mode === 'proposal' ? (
                    <>
                      <p className="text-[11.5px] leading-relaxed text-muted">
                        Add a saved package, then change anything on it right on the page: the name, the description, the price and every line. That changes this proposal only. Up to {PACKAGE_CAP} show.
                      </p>
                      {lib.packages.map((lp) => (
                        <div key={lp.key} className="flex items-center gap-3 rounded-lg border border-line bg-surface-2/50 p-2.5">
                          <div className="min-w-0 flex-1">
                            <p className="text-[12.5px] font-semibold text-parchment">
                              {lp.name} <span className="font-normal text-muted">· {lp.price}</span>
                            </p>
                            <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-muted">{lp.tagline}</p>
                          </div>
                          <button type="button" className={smallBtn} disabled={packages.length >= PACKAGE_CAP} onClick={() => addPackage(lp)}>
                            Add
                          </button>
                        </div>
                      ))}
                      <button type="button" className={smallBtn + ' w-full py-2'} disabled={packages.length >= PACKAGE_CAP} onClick={() => addPackage(null)}>
                        Add a blank package
                      </button>
                      <p className="pt-1 text-[11px] leading-relaxed text-faint">
                        Highlight, move and remove are the buttons on top of each package. Enter in a line starts the next one.
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="text-[11.5px] leading-relaxed text-muted">
                        Your saved packages are on the page under The packages. Change any name, description, price or line there, add or remove lines, and choose which one is highlighted by default.
                      </p>
                      <button type="button" className={smallBtn + ' w-full py-2'} onClick={() => addPackage(null)}>
                        Add a new saved package
                      </button>
                      <p className="text-[11px] leading-relaxed text-faint">
                        Changes become the default for every new proposal. Proposals already made keep their own packages.
                      </p>
                    </>
                  )}
                </div>
              )}

              {tab === 'reviews' && mode === 'proposal' && (
                <div className="space-y-4">
                  <div>
                    <p className="mb-1.5 text-[12px] font-semibold text-parchment">
                      On this proposal <span className="font-normal text-muted">({reviews.length} of {REVIEW_CAP})</span>
                    </p>
                    {reviews.length === 0 && <p className="text-[11.5px] text-muted">None yet. Use a quick set or add from the bank below.</p>}
                    <div className="space-y-1.5">
                      {reviews.map((r, i) => (
                        <div
                          key={`${r.name}-${i}`}
                          draggable
                          onDragStart={() => setDragFrom(i)}
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={() => {
                            if (dragFrom !== null && dragFrom !== i) moveReview(dragFrom, i)
                            setDragFrom(null)
                          }}
                          onDragEnd={() => setDragFrom(null)}
                          className={`flex cursor-grab items-start gap-2 rounded-lg border bg-surface-2/50 px-2.5 py-2 active:cursor-grabbing ${
                            dragFrom === i ? 'border-brass' : 'border-line'
                          }`}
                          title="Drag to reorder"
                        >
                          <span className="mt-0.5 select-none text-[12px] text-faint">⋮⋮</span>
                          <div className="min-w-0 flex-1">
                            <p className="text-[12px] font-semibold text-parchment">{r.name}</p>
                            <p className="line-clamp-2 text-[11px] leading-snug text-muted">{r.text}</p>
                          </div>
                          <button type="button" onClick={() => removeReview(i)} className="shrink-0 text-[13px] text-faint hover:text-rose-300" title="Remove from this proposal">
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div>
                    <p className="mb-1.5 text-[12px] font-semibold text-parchment">Quick sets</p>
                    <div className="flex flex-wrap gap-1.5">
                      {PRESETS.map((p) => (
                        <button key={p.key} type="button" className={smallBtn} onClick={() => applyPreset(p.key, p.label)}>
                          {p.label}
                        </button>
                      ))}
                    </div>
                    <p className="mt-1.5 text-[11px] leading-relaxed text-faint">Each one puts its usual four reviews on the proposal in place of what is there.</p>
                  </div>

                  <div>
                    <p className="mb-1.5 text-[12px] font-semibold text-parchment">
                      Review bank <span className="font-normal text-muted">({bank.length})</span>
                    </p>
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search names or words"
                      className="mb-2 w-full rounded-md border border-line bg-surface-2 px-2.5 py-1.5 text-[12px] text-parchment outline-none focus:border-brass"
                    />
                    <div className="mb-2 flex flex-wrap gap-1">
                      {FILTERS.map((f) => (
                        <button
                          key={f.key}
                          type="button"
                          onClick={() => setFilter(f.key)}
                          className={`rounded-full border px-2 py-0.5 text-[10.5px] font-medium transition-colors ${
                            filter === f.key ? 'border-brass bg-surface-3 text-brass-bright' : 'border-line text-muted hover:text-parchment'
                          }`}
                        >
                          {f.label}
                        </button>
                      ))}
                    </div>
                    <div className="space-y-1.5">
                      {bank.map((b) => {
                        const added = reviews.some((r) => sameReview(r, b))
                        return (
                          <div key={b.id} className="rounded-lg border border-line bg-surface-2/50 px-2.5 py-2">
                            <div className="flex items-center gap-2">
                              <p className="min-w-0 flex-1 truncate text-[12px] font-semibold text-parchment">
                                {b.name}
                                {b.used > 0 && <span className="font-normal text-faint"> · on {b.used} proposal{b.used === 1 ? '' : 's'}</span>}
                              </p>
                              <button type="button" className={smallBtn} disabled={added || reviews.length >= REVIEW_CAP} onClick={() => addReview(b)}>
                                {added ? 'Added' : 'Add'}
                              </button>
                            </div>
                            <p className="mt-1 line-clamp-4 text-[11px] leading-snug text-muted" title={b.text}>
                              {b.text}
                            </p>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </aside>
        )}
      </div>

      {/* The photo picker, for "Change photo" on a style. Every photo the website already has. */}
      {photoFor !== null && data && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8" onClick={() => setPhotoFor(null)}>
          <div className="flex max-h-full w-full max-w-4xl flex-col rounded-xl border border-line-strong bg-surface" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-line px-5 py-3">
              <p className="text-[13px] font-semibold text-parchment">
                Pick a photo for {styles[photoFor]?.name || 'this style'}
              </p>
              <button type="button" className="text-[12px] text-muted hover:text-parchment" onClick={() => setPhotoFor(null)}>
                Cancel
              </button>
            </div>
            <div className="board-scroll grid min-h-0 grid-cols-4 gap-2 overflow-y-auto p-4">
              {data.photos.map((ph) => {
                const current = styles[photoFor]?.photo === ph
                return (
                  <button
                    key={ph}
                    type="button"
                    onClick={() => setPhoto(photoFor, ph)}
                    className={`group overflow-hidden rounded-lg border-2 text-left ${current ? 'border-brass' : 'border-transparent hover:border-line-strong'}`}
                    title={ph.replace('/assets/photos/', '')}
                  >
                    <img src={`${SITE}${ph}`} alt="" loading="lazy" className="aspect-[3/2] w-full object-cover" />
                    <span className="block truncate px-1.5 py-1 text-[10px] text-muted">{ph.replace('/assets/photos/', '')}</span>
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
