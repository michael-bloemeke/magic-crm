import { useEffect, useRef, useState } from 'react'
import { parseDurationMinutes } from '../showUtils'

type Props = {
  value: string | undefined
  onChange: (value: string) => void
}

function parse(s: string | undefined): { mins: number; secs: number } {
  const total = parseDurationMinutes(s)
  const totalSeconds = Math.round(total * 60)
  return {
    mins: Math.floor(totalSeconds / 60),
    secs: totalSeconds % 60
  }
}

function format(mins: number, secs: number): string {
  if (mins === 0 && secs === 0) return ''
  return `${mins}:${String(secs).padStart(2, '0')}`
}

export function DurationInput({ value, onChange }: Props) {
  const initial = parse(value)
  const [mins, setMins] = useState(String(initial.mins))
  const [secs, setSecs] = useState(String(initial.secs).padStart(2, '0'))
  // Tracks what we most recently emitted so we don't re-sync from our own
  // updates (which would clobber what the user is typing).
  const lastEmittedRef = useRef<string>(format(initial.mins, initial.secs))

  useEffect(() => {
    if ((value ?? '') === lastEmittedRef.current) return
    const p = parse(value)
    setMins(String(p.mins))
    setSecs(String(p.secs).padStart(2, '0'))
    lastEmittedRef.current = format(p.mins, p.secs)
  }, [value])

  const emit = (m: string, s: string) => {
    const mNum = Math.max(0, parseInt(m) || 0)
    const sNum = Math.max(0, Math.min(59, parseInt(s) || 0))
    const formatted = format(mNum, sNum)
    lastEmittedRef.current = formatted
    onChange(formatted)
  }

  return (
    <div className="duration-input">
      <input
        type="number"
        min={0}
        inputMode="numeric"
        className="text-input duration-field"
        value={mins}
        onChange={(e) => {
          setMins(e.target.value)
          emit(e.target.value, secs)
        }}
        aria-label="Minutes"
      />
      <span className="duration-sep">:</span>
      <input
        type="number"
        min={0}
        max={59}
        inputMode="numeric"
        className="text-input duration-field"
        value={secs}
        onChange={(e) => {
          setSecs(e.target.value)
          emit(mins, e.target.value)
        }}
        onBlur={(e) => {
          // Pad on blur for consistent visual.
          const padded = String(parseInt(e.target.value) || 0).padStart(2, '0')
          setSecs(padded)
        }}
        aria-label="Seconds"
      />
      <span className="duration-suffix muted">min:sec</span>
    </div>
  )
}
