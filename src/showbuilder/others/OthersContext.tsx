import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react'
import type { Other } from '../types'
import { sbApi, useOnFocus } from '../sbApi'

type OthersContextValue = {
  others: Other[]
  othersById: Map<string, Other>
  loading: boolean
  refresh: () => Promise<void>
  saveOther: (o: Other) => Promise<Other>
  deleteOther: (id: string) => Promise<void>
}

const OthersContext = createContext<OthersContextValue | null>(null)

function makeUuid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function OthersProvider({ children }: { children: ReactNode }) {
  const [others, setOthers] = useState<Other[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    const list = await sbApi.listOthers()
    setOthers(list)
    setLoading(false)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])
  useOnFocus(refresh)

  const saveOther = useCallback(async (o: Other) => {
    const saved = await sbApi.saveOther(o)
    setOthers((current) => {
      const idx = current.findIndex((x) => x.id === saved.id)
      const next = idx >= 0
        ? [...current.slice(0, idx), saved, ...current.slice(idx + 1)]
        : [...current, saved]
      next.sort((a, b) => a.name.localeCompare(b.name))
      return next
    })
    return saved
  }, [])

  const deleteOther = useCallback(async (id: string) => {
    await sbApi.deleteOther(id)
    setOthers((current) => current.filter((o) => o.id !== id))
  }, [])

  const othersById = useMemo(() => {
    const map = new Map<string, Other>()
    for (const o of others) map.set(o.id, o)
    return map
  }, [others])

  const value = useMemo<OthersContextValue>(
    () => ({ others, othersById, loading, refresh, saveOther, deleteOther }),
    [others, othersById, loading, refresh, saveOther, deleteOther]
  )

  return <OthersContext.Provider value={value}>{children}</OthersContext.Provider>
}

export function useOthers(): OthersContextValue {
  const ctx = useContext(OthersContext)
  if (!ctx) throw new Error('useOthers must be used within OthersProvider')
  return ctx
}

export function blankOther(): Other {
  const now = new Date().toISOString()
  return {
    id: makeUuid(),
    name: '',
    description: '',
    duration: '',
    color: '#7a8aa0', // neutral blue-gray default
    props: [],
    createdAt: now,
    updatedAt: now
  }
}

function parseHex(hex: string): [number, number, number] | null {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  if (h.length !== 6) return null
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  if ([r, g, b].some((n) => Number.isNaN(n))) return null
  return [r, g, b]
}

// Convert hex (#rrggbb) to an rgba string with the given alpha. Used for
// outer effects like box-shadow glows.
export function hexToRgba(hex: string, alpha: number): string {
  const parsed = parseHex(hex)
  if (!parsed) return `rgba(120, 120, 130, ${alpha})`
  const [r, g, b] = parsed
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

// Mix the given color with a dark base to produce an opaque tinted color
// suitable for a node background. Result has no transparency, so the
// canvas dotted pattern doesn't show through.
export function tintedBg(hex: string, alpha = 0.16, baseHex = '#1e1e22'): string {
  const tint = parseHex(hex)
  const base = parseHex(baseHex)
  if (!tint || !base) return baseHex
  const mix = (t: number, b: number) => Math.round(b * (1 - alpha) + t * alpha)
  const r = mix(tint[0], base[0])
  const g = mix(tint[1], base[1])
  const b = mix(tint[2], base[2])
  const toHex = (n: number) => n.toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}
