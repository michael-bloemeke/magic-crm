// Phone formatting (Node side, shared by the project + contact data layers).
// Formats each phone-number run found in a string IN PLACE: 10 digits ->
// (XXX) XXX-XXXX ; 11 digits -> +X (XXX) XXX-XXXX. Any surrounding text (a name,
// "(cell)", "TBD", a second number) is preserved, and runs that aren't 10/11
// digits (dates, partials, extensions) are left untouched.

function fmtDigits(d) {
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
  if (d.length === 11) return `+${d[0]} (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`
  return null
}

// A plausible phone run: optional +, optional "(", a digit, then digits and
// phone separators, ending in a digit. "/" is intentionally excluded so dates
// like 8/19/2026 are never matched.
const PHONE_RUN = /\+?\(?\d[\d\s().\-]{7,}\d/g

export function formatPhone(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  return s.replace(PHONE_RUN, (run) => fmtDigits(run.replace(/\D/g, '')) ?? run)
}

// Same in-place logic; a field may hold several numbers (with or without labels).
export function formatPhoneField(raw) {
  return formatPhone(raw)
}
