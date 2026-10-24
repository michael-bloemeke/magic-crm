import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react'
import type { Tag, Trick } from '../types'
import { sbApi, useOnFocus } from '../sbApi'

type TricksContextValue = {
  tricks: Trick[]
  tricksById: Map<string, Trick>
  tags: Tag[]
  tagsById: Map<string, Tag>
  loading: boolean
  refresh: () => Promise<void>
  saveTrick: (trick: Trick) => Promise<Trick>
  deleteTrick: (id: string) => Promise<void>
  saveTag: (tag: Tag) => Promise<Tag>
  deleteTag: (id: string) => Promise<void>
  createTag: (name: string) => Promise<Tag>
}

const TricksContext = createContext<TricksContextValue | null>(null)

function makeUuid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function TricksProvider({ children }: { children: ReactNode }) {
  const [tricks, setTricks] = useState<Trick[]>([])
  const [tags, setTags] = useState<Tag[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    const [trickList, tagList] = await Promise.all([
      sbApi.listTricks(),
      sbApi.listTags()
    ])
    setTricks(trickList)
    setTags(tagList)
    setLoading(false)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])
  useOnFocus(refresh)

  const saveTrick = useCallback(async (trick: Trick) => {
    const saved = await sbApi.saveTrick(trick)
    setTricks((current) => {
      const idx = current.findIndex((t) => t.id === saved.id)
      const next = idx >= 0
        ? [...current.slice(0, idx), saved, ...current.slice(idx + 1)]
        : [...current, saved]
      next.sort((a, b) => a.name.localeCompare(b.name))
      return next
    })
    return saved
  }, [])

  const deleteTrick = useCallback(async (id: string) => {
    await sbApi.deleteTrick(id)
    setTricks((current) => current.filter((t) => t.id !== id))
  }, [])

  const saveTag = useCallback(async (tag: Tag) => {
    const saved = await sbApi.saveTag(tag)
    setTags((current) => {
      const idx = current.findIndex((t) => t.id === saved.id)
      const next = idx >= 0
        ? [...current.slice(0, idx), saved, ...current.slice(idx + 1)]
        : [...current, saved]
      next.sort((a, b) => a.name.localeCompare(b.name))
      return next
    })
    return saved
  }, [])

  const deleteTag = useCallback(async (id: string) => {
    await sbApi.deleteTag(id)
    setTags((current) => current.filter((t) => t.id !== id))
    // Cascade happened in main process; refresh tricks to pick up the
    // updated tagIds arrays.
    const refreshed = await sbApi.listTricks()
    setTricks(refreshed)
  }, [])

  const createTag = useCallback(async (name: string) => {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('Tag name required')
    const now = new Date().toISOString()
    return saveTag({
      id: makeUuid(),
      name: trimmed,
      createdAt: now,
      updatedAt: now
    })
  }, [saveTag])

  const tricksById = useMemo(() => {
    const map = new Map<string, Trick>()
    for (const t of tricks) map.set(t.id, t)
    return map
  }, [tricks])

  const tagsById = useMemo(() => {
    const map = new Map<string, Tag>()
    for (const t of tags) map.set(t.id, t)
    return map
  }, [tags])

  const value = useMemo<TricksContextValue>(
    () => ({
      tricks,
      tricksById,
      tags,
      tagsById,
      loading,
      refresh,
      saveTrick,
      deleteTrick,
      saveTag,
      deleteTag,
      createTag
    }),
    [tricks, tricksById, tags, tagsById, loading, refresh, saveTrick, deleteTrick, saveTag, deleteTag, createTag]
  )

  return <TricksContext.Provider value={value}>{children}</TricksContext.Provider>
}

export function useTricks(): TricksContextValue {
  const ctx = useContext(TricksContext)
  if (!ctx) throw new Error('useTricks must be used within TricksProvider')
  return ctx
}

export function makeTrickId(): string {
  return makeUuid()
}

export function blankTrick(): Trick {
  const now = new Date().toISOString()
  return {
    id: makeTrickId(),
    name: '',
    description: '',
    script: '',
    source: '',
    props: [],
    duration: '',
    notes: '',
    tagIds: [],
    createdAt: now,
    updatedAt: now
  }
}
