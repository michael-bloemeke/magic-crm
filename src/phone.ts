// Phone formatting + search helpers (client side; mirrors crm-phone.mjs).
// Formats each phone-number run found in a string IN PLACE: 10 digits ->
// (XXX) XXX-XXXX ; 11 digits -> +X (XXX) XXX-XXXX. Surrounding text (a name,
// "(cell)", "TBD", a second number) is preserved; runs that aren't 10/11 digits
// (dates, partials) are left untouched.

function fmtDigits(d: string): string | null {
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
  if (d.length === 11) return `+${d[0]} (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`
  return null
}

// Optional +, optional "(", a digit, then digits/separators, ending in a digit.
// "/" is excluded so dates like 8/19/2026 are never matched.
const PHONE_RUN = /\+?\(?\d[\d\s().\-]{7,}\d/g

export function formatPhone(raw: string): string {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  return s.replace(PHONE_RUN, (run) => fmtDigits(run.replace(/\D/g, '')) ?? run)
}

export function formatPhoneField(raw: string): string {
  return formatPhone(raw)
}

// Digits only, for search matching (so "(123) 456-7890" matches "1234567890",
// "4567890", or "678").
export function phoneDigits(s: string): string {
  return String(s ?? '').replace(/\D/g, '')
}
