// Shared display formatting: Michael's standing preference is 12-hour times and written-out dates
// (never 24-hour or bare ISO) anywhere he reads them in the CRM.

// "16:00" -> "4:00 PM". Anything that isn't a bare HH:MM passes through unchanged, so free-form
// entries ("5 or 6 PM", "TBD", "4pm-ish") are left alone.
export function to12h(value: string): string {
  const s = (value || '').trim()
  const m = s.match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return s
  let h = parseInt(m[1], 10)
  if (h > 23) return s
  const period = h >= 12 ? 'PM' : 'AM'
  h = h % 12
  if (h === 0) h = 12
  return `${h}:${m[2]} ${period}`
}

// "2026-10-17" -> "Saturday, October 17th, 2026". Non-ISO values pass through unchanged.
export function writtenDate(iso: string): string {
  const s = (iso || '').trim()
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return s
  const d = new Date(+m[1], +m[2] - 1, +m[3])
  const wd = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()]
  const mo = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][d.getMonth()]
  const day = d.getDate()
  const ord = day % 10 === 1 && day !== 11 ? 'st' : day % 10 === 2 && day !== 12 ? 'nd' : day % 10 === 3 && day !== 13 ? 'rd' : 'th'
  return `${wd}, ${mo} ${day}${ord}, ${m[1]}`
}
