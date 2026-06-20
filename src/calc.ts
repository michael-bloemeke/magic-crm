// Evaluate a simple arithmetic formula typed into a number field, so "100+134"
// becomes "234" and "150x2" becomes "300". Supports + - * / (x, X, or × all mean
// multiply; ÷ means divide), decimals, parentheses, and a leading minus. Returns
// the original string unchanged if it isn't a valid arithmetic expression, so the
// caller can coerce or ignore it. No eval/Function: a tiny recursive-descent parser.

export function evalNumberFormula(input: string): string {
  const raw = String(input ?? '').trim()
  if (!raw) return ''
  const s = raw
    .replace(/[xX×]/g, '*')
    .replace(/÷/g, '/')
    .replace(/\s+/g, '')
  if (!/^[\d+\-*/().]+$/.test(s)) return raw // not a pure arithmetic expression

  let i = 0
  const eat = (c: string) => (s[i] === c ? (i++, true) : false)

  function parseExpr(): number {
    let v = parseTerm()
    for (;;) {
      if (eat('+')) v += parseTerm()
      else if (eat('-')) v -= parseTerm()
      else break
    }
    return v
  }
  function parseTerm(): number {
    let v = parseFactor()
    for (;;) {
      if (eat('*')) v *= parseFactor()
      else if (eat('/')) v /= parseFactor()
      else break
    }
    return v
  }
  function parseFactor(): number {
    if (eat('+')) return parseFactor()
    if (eat('-')) return -parseFactor()
    if (eat('(')) {
      const v = parseExpr()
      if (!eat(')')) throw new Error('unbalanced')
      return v
    }
    let num = ''
    while (i < s.length && /[\d.]/.test(s[i])) num += s[i++]
    if (num === '' || num === '.') throw new Error('expected number')
    const n = Number(num)
    if (!Number.isFinite(n)) throw new Error('NaN')
    return n
  }

  try {
    const v = parseExpr()
    if (i !== s.length || !Number.isFinite(v)) return raw
    return String(Math.round(v * 100) / 100) // round to 2 decimals, strip trailing zeros
  } catch {
    return raw
  }
}
