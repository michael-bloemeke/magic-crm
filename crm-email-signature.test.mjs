// Regression test for the email signature and for the template placeholder rule.
//
// Two failures this exists to prevent, both of which reach a client silently:
//   - two signatures on one email (the checkbox puts one in the body, Settings appends another),
//   - a placeholder mailed out as literal text, or the website turned into a link.
//
// Run it:  node --experimental-strip-types crm-email-signature.test.mjs
import fs from 'node:fs'
import { JSDOM } from 'jsdom'
import { signatureFor, tightenEmailHtml } from './crm-email-render.mjs'

// The signature helpers are DOM helpers, so give them a DOM before importing them.
const dom = new JSDOM('<body></body>')
globalThis.DOMParser = dom.window.DOMParser

const { hasSignature, withSignature, withoutSignature, signatureBlock, DEFAULT_SIGNATURE_HTML } =
  await import('./src/emailSignature.ts')

let failures = 0
function check(name, cond, detail) {
  if (cond) return console.log(`  ok   ${name}`)
  failures++
  console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`)
}

const SIG = 'Michael Bloemeke<div>michaelbloemeke.com</div><div>919-239-9898</div>'

console.log('\n1. The signature block is the three lines, under a separator, with NO link')
const block = signatureBlock(SIG)
check('has the name', block.includes('Michael Bloemeke'))
check('has the website', block.includes('michaelbloemeke.com'))
check('has the phone number', block.includes('919-239-9898'))
check('the website is NOT a link', !/<a\b/i.test(block), block)
check('there is a separator rule above it', /border-top:\s*1px solid/.test(block))
check('the rule comes before the text', block.indexOf('border-top') < block.indexOf('Michael Bloemeke'))
check('falls back to Michael\'s signature when Settings is empty', signatureBlock('').includes('919-239-9898'))
check('default matches the three-line form', DEFAULT_SIGNATURE_HTML.includes('michaelbloemeke.com'))

console.log('\n2. Ticking and unticking the checkbox is lossless')
const body = '<p>Hey there,</p><p>Just following up.</p>'
const on = withSignature(body, SIG)
check('detected as on', hasSignature(on))
check('body text preserved', on.includes('Just following up.'))
check('signature is at the END', on.indexOf('919-239-9898') > on.indexOf('Just following up.'))
check('unticking restores the body exactly', withoutSignature(on) === body, JSON.stringify(withoutSignature(on)))
check('detected as off again', !hasSignature(withoutSignature(on)))
check('ticking twice does not stack', (withSignature(on, SIG).match(/919-239-9898/g) || []).length === 1)
check('unticking a plain body is a no-op', withoutSignature(body) === body)

console.log('\n3. An email can never carry TWO signatures')
const cfgOn = { signatureEnabled: true, signatureHtml: SIG }
check('body already has one -> Settings stands down', signatureFor(on, cfgOn) === '', signatureFor(on, cfgOn))
check('body has none + Settings on -> appended', signatureFor(body, cfgOn).includes('919-239-9898'))
check('body has none + Settings off -> nothing', signatureFor(body, { signatureEnabled: false, signatureHtml: SIG }) === '')
check('no config at all -> nothing', signatureFor(body, null) === '')
check('Settings on but empty signature -> nothing', signatureFor(body, { signatureEnabled: true, signatureHtml: '' }) === '')
check('appended signature is not a link either', !/<a\b/i.test(signatureFor(body, cfgOn)))

console.log('\n4. Placeholders: ONLY the name autofills; every other bracket stays, in red')
const src = fs.readFileSync('./src/emailTemplates.ts', 'utf8')
const arr = src.slice(src.indexOf('export const EMAIL_TEMPLATES'))
const fields = [...arr.matchAll(/\$\{field\('([^']+)'/g)].map((m) => m[1])
const notes = [...arr.matchAll(/\$\{note\('([^']+)'\)\}/g)].map((m) => m[1])
// NAME is a const referencing field('firstName'); no template may call field() for anything else.
check('no autofilling chips other than the name', fields.length === 0, fields.join(', '))
check('the name const is the only field chip', /const NAME = field\('firstName'/.test(src))
check('NAME is used', arr.includes('${NAME}'))
// Verbatim, exactly as they read in Notion — casing included.
const expected = ['the event', 'event', 'Event', 'decision maker', 'the event', 'the event']
check('write-ins are verbatim and in order', JSON.stringify(notes) === JSON.stringify(expected), notes.join(' | '))
check('no event-type autofill survives', !/field\('eventType'/.test(src))

const css = fs.readFileSync('./src/index.css', 'utf8')
const noteCss = css.slice(css.indexOf('.merge-field[data-note]'), css.indexOf('.merge-field[data-note]') + 260)
check('write-in chips are red', /#b91c1c/.test(noteCss) && /#fee2e2/.test(noteCss), noteCss.slice(0, 120))

console.log('\n5. The outgoing-HTML tightener does not eat the separator rule')
// It collapses empty <p>/<div> into a short spacer, which is right for a blank line and WRONG for
// an element whose entire purpose is a border it draws. That bug deleted the signature separator
// from every signed email, visible only as a missing line.
const rule = '<div style="width:150px;border-top:1px solid #d8d8d8;font-size:1px;line-height:1px;margin:0 0 10px 0">&nbsp;</div>'
check('a bordered empty div survives', tightenEmailHtml(rule).includes('border-top'), tightenEmailHtml(rule))
check('a background-only empty div survives', tightenEmailHtml('<div style="background:#eee"></div>').includes('background'))
check('a real blank line still collapses', tightenEmailHtml('<p>a</p><p><br></p><p>b</p>').includes('line-height:12px'))
check('an empty unstyled div still collapses', !tightenEmailHtml('<div></div>').includes('<div></div>'))
check('the full signature block keeps its rule', tightenEmailHtml(signatureBlock(SIG)).includes('border-top: 1px solid') || tightenEmailHtml(signatureBlock(SIG)).includes('border-top:1px solid'))

console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nAll checks passed.\n')
process.exit(failures ? 1 : 0)
