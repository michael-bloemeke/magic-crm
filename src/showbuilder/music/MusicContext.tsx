import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import type { AudioFile, Music } from '../types'
import { sbApi } from '../sbApi'

type MusicContextValue = {
  music: Music[]
  musicById: Map<string, Music>
  audioFiles: AudioFile[]
  audioFilesById: Map<string, AudioFile>
  loading: boolean
  refresh: () => Promise<void>
  saveMusic: (m: Music) => Promise<Music>
  deleteMusic: (id: string) => Promise<void>
  uploadAudio: () => Promise<AudioFile | null>
  deleteAudio: (id: string) => Promise<void>
  // Playback
  playingAudioId: string | null
  play: (audioFileId: string) => void
  stop: () => void
}

const MusicContext = createContext<MusicContextValue | null>(null)

function makeUuid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function MusicProvider({ children }: { children: ReactNode }) {
  const [music, setMusic] = useState<Music[]>([])
  const [audioFiles, setAudioFiles] = useState<AudioFile[]>([])
  const [loading, setLoading] = useState(true)
  const [playingAudioId, setPlayingAudioId] = useState<string | null>(null)
  const audioElRef = useRef<HTMLAudioElement | null>(null)

  const refresh = useCallback(async () => {
    const [m, a] = await Promise.all([
      sbApi.listMusic(),
      sbApi.listAudioFiles()
    ])
    setMusic(m)
    setAudioFiles(a)
    setLoading(false)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const saveMusic = useCallback(async (m: Music) => {
    const saved = await sbApi.saveMusic(m)
    setMusic((current) => {
      const idx = current.findIndex((x) => x.id === saved.id)
      const next = idx >= 0
        ? [...current.slice(0, idx), saved, ...current.slice(idx + 1)]
        : [...current, saved]
      next.sort((a, b) => a.name.localeCompare(b.name))
      return next
    })
    return saved
  }, [])

  const deleteMusic = useCallback(async (id: string) => {
    await sbApi.deleteMusic(id)
    setMusic((current) => current.filter((m) => m.id !== id))
  }, [])

  const uploadAudio = useCallback(async () => {
    const result = await sbApi.uploadAudioFile()
    if (result) {
      setAudioFiles((current) => {
        const next = [...current, result]
        next.sort((a, b) => a.displayName.localeCompare(b.displayName))
        return next
      })
    }
    return result
  }, [])

  const deleteAudio = useCallback(async (id: string) => {
    await sbApi.deleteAudioFile(id)
    setAudioFiles((current) => current.filter((a) => a.id !== id))
    // Cascade happened in main process; refresh music to pick up cleared
    // audioFileId.
    const refreshed = await sbApi.listMusic()
    setMusic(refreshed)
  }, [])

  // Lazily create the single shared audio element on first play.
  const ensureAudio = useCallback((): HTMLAudioElement => {
    if (!audioElRef.current) {
      const el = new Audio()
      el.addEventListener('ended', () => setPlayingAudioId(null))
      el.addEventListener('pause', () => {
        // Pause without seeking back; treat as stopped for our UI purposes.
        if (el.currentTime >= el.duration || el.paused) {
          // already handled by 'ended' or external stop
        }
      })
      audioElRef.current = el
    }
    return audioElRef.current
  }, [])

  const stop = useCallback(() => {
    const el = audioElRef.current
    if (el) {
      el.pause()
      el.currentTime = 0
    }
    setPlayingAudioId(null)
  }, [])

  const play = useCallback((audioFileId: string) => {
    const meta = audioFiles.find((a) => a.id === audioFileId)
    if (!meta) return
    const el = ensureAudio()
    el.pause()
    // Was showaudio:// (a file on the Mac). Now a signed link to the file in storage.
    el.src = sbApi.audioUrl(meta.id)
    el.currentTime = 0
    el.play()
      .then(() => {
        setPlayingAudioId(audioFileId)
      })
      .catch((err) => {
        console.error('Audio playback failed', err)
        setPlayingAudioId(null)
      })
  }, [audioFiles, ensureAudio])

  // If the user deletes the audio that's currently playing, stop it.
  useEffect(() => {
    if (playingAudioId && !audioFiles.find((a) => a.id === playingAudioId)) {
      stop()
    }
  }, [audioFiles, playingAudioId, stop])

  const musicById = useMemo(() => {
    const map = new Map<string, Music>()
    for (const m of music) map.set(m.id, m)
    return map
  }, [music])

  const audioFilesById = useMemo(() => {
    const map = new Map<string, AudioFile>()
    for (const a of audioFiles) map.set(a.id, a)
    return map
  }, [audioFiles])

  const value = useMemo<MusicContextValue>(
    () => ({
      music,
      musicById,
      audioFiles,
      audioFilesById,
      loading,
      refresh,
      saveMusic,
      deleteMusic,
      uploadAudio,
      deleteAudio,
      playingAudioId,
      play,
      stop
    }),
    [music, musicById, audioFiles, audioFilesById, loading, refresh, saveMusic, deleteMusic, uploadAudio, deleteAudio, playingAudioId, play, stop]
  )

  return <MusicContext.Provider value={value}>{children}</MusicContext.Provider>
}

export function useMusic(): MusicContextValue {
  const ctx = useContext(MusicContext)
  if (!ctx) throw new Error('useMusic must be used within MusicProvider')
  return ctx
}

export function blankMusic(): Music {
  const now = new Date().toISOString()
  return {
    id: makeUuid(),
    name: '',
    description: '',
    startCue: '',
    stopCue: '',
    audioFileId: null,
    createdAt: now,
    updatedAt: now
  }
}
