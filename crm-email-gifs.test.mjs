// Regression test for EMBEDDED template GIFs.
//
// What this guards: Michael's Ghostbuster follow-ups are jokes that only land if the recipient sees
// the moving picture inside the email. A giphy URL, a broken image, or a data: src that Gmail
// strips from received mail all fail the same way, silently, and he would only find out from the
// client's confusion. So this asserts the whole chain: template -> composeOutgoing -> MIME, ending
// at "the bytes in the message are byte-identical to the GIF on disk and still a valid GIF".
//
// Run it:  node crm-email-gifs.test.mjs      (exits non-zero on failure)
import fs from 'node:fs'
import { composeOutgoing, emailGifPath } from './crm-email-render.mjs'
import { makeRaw } from './crm-gmail.mjs'
import { initStore } from './crm-store.mjs'

// composeOutgoing reads the signature out of the CRM config, which under CRM_STORE=supabase comes
// from the store cache, so the store has to be warmed exactly as the app warms it at startup.
await initStore()

let failures = 0
function check(name, cond, detail) {
  if (cond) return console.log(`  ok   ${name}`)
  failures++
  console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`)
}

// Every slug the template library actually references, read from the source of truth so a new
// template with a typo'd or missing GIF fails here rather than in a client's inbox.
// Slugs come from the gif('<slug>', ...) helper calls; the data-crm-gif attribute itself is built
// inside that helper from a template literal, so matching the attribute would only find the literal.
const templateSrc = fs.readFileSync('./src/emailTemplates.ts', 'utf8')
const slugs = [...new Set([...templateSrc.matchAll(/\bgif\('([a-z0-9][a-z0-9-]*)'/g)].map((m) => m[1]))]

console.log(`\n1. Every template GIF slug resolves to a real file (${slugs.length} slugs)`)
check('found some slugs', slugs.length > 0, 'no data-crm-gif in emailTemplates.ts')
for (const slug of slugs) {
  const f = emailGifPath(slug)
  check(`${slug} resolves`, !!f, 'no such file in email-gifs/')
  if (f) {
    const b = fs.readFileSync(f)
    check(`${slug} is a complete GIF`, b.slice(0, 3).toString() === 'GIF' && b[b.length - 1] === 0x3b)
  }
}

console.log('\n2. The GIF is embedded as cid:, and no giphy/local URL survives into the sent copy')
const slug = slugs[0]
const onDisk = fs.readFileSync(emailGifPath(slug))
const body = `<p>Hey there,</p><p><img src="/api/email-gif/${slug}" data-crm-gif="${slug}" alt="x" width="200" style="width:200px" /></p>`
const out = composeOutgoing(body)
check('sendHtml uses cid:', /src="cid:gif0@magic-crm"/.test(out.sendHtml), out.sendHtml.slice(0, 200))
check('sendHtml has no /api/ url', !out.sendHtml.includes('/api/email-gif'))
check('sendHtml has no giphy url', !/giphy|media\d?\.giphy/i.test(out.sendHtml))
check('one inline image produced', out.inlineImages.length === 1, String(out.inlineImages.length))
check('inline image is image/gif', out.inlineImages[0]?.contentType === 'image/gif')
check('other attributes preserved', /width="200"/.test(out.sendHtml) && /alt="x"/.test(out.sendHtml))

console.log('\n3. The attached bytes ARE the GIF on disk (not a placeholder or a truncated copy)')
const shipped = Buffer.from(out.inlineImages[0].contentBase64, 'base64')
check('byte-identical to email-gifs file', shipped.equals(onDisk), `${shipped.length} vs ${onDisk.length} bytes`)
check('still a valid animated GIF', shipped.slice(0, 6).toString() === 'GIF89a' && shipped[shipped.length - 1] === 0x3b)

console.log('\n4. The receipt keeps the local src so the in-app "sent" view still renders it')
check('receiptHtml keeps /api/email-gif', out.receiptHtml.includes(`/api/email-gif/${slug}`))
check('receiptHtml has no cid:', !out.receiptHtml.includes('cid:'))

console.log('\n5. The MIME message really carries it as an inline related part')
const raw = Buffer.from(
  makeRaw({ from: 'me@x.com', to: 'client@x.com', subject: 'S', body: 'text', html: out.sendHtml, inlineImages: out.inlineImages }),
  'base64url',
).toString('utf8')
check('multipart/related used', /Content-Type: multipart\/related/.test(raw))
check('Content-ID header present', /Content-ID: <gif0@magic-crm>/.test(raw))
check('disposition is inline, not attachment', /Content-Disposition: inline; filename="[^"]+\.gif"/.test(raw))
// Pull the base64 of the gif part back out of the assembled message and decode it.
const part = raw.split(/Content-ID: <gif0@magic-crm>/)[1] || ''
const b64 = (part.split(/\r\n\r\n/)[1] || '').split(/\r\n--/)[0].replace(/\s/g, '')
check('gif survives the MIME round-trip', Buffer.from(b64, 'base64').equals(onDisk), `${Buffer.from(b64, 'base64').length} vs ${onDisk.length}`)

console.log('\n6. Ordinary emails are untouched, and a bad slug cannot read outside email-gifs/')
const plain = composeOutgoing('<p>Just a normal note.</p>')
check('no inline images added', plain.inlineImages.length === 0)
check('body unchanged', plain.sendHtml.includes('Just a normal note.'))
const missing = composeOutgoing('<p><img src="/api/email-gif/nope" data-crm-gif="nope" /></p>')
check('missing gif left alone, not a broken cid:', missing.inlineImages.length === 0 && !missing.sendHtml.includes('cid:'))
for (const bad of ['../crm-gmail', '../../etc/passwd', 'a/../../b', '', 'UPPER', 'has space']) {
  check(`traversal refused: ${JSON.stringify(bad)}`, emailGifPath(bad) === null)
}

console.log('\n7. The library is exactly the NUMBERED Notion templates, with well-formed chips')
// Parsed out of the source rather than imported, because the module is TypeScript. Guards the two
// rules that are easy to break by hand: only numbered templates belong here, and every placeholder
// is a real merge-field chip (a bare "[Name]" would ship to a client as literal text).
const names = [...templateSrc.matchAll(/^\s*name: '([^']+)',$/gm)].map((m) => m[1])
const subjects = [...templateSrc.matchAll(/^\s*subject: '([^']*)',$/gm)].map((m) => m[1])
check('11 templates', names.length === 11, names.join(' | '))
check('11 subjects', subjects.length === 11, String(subjects.length))
check('all numbered 1-11 in order', names.every((n, i) => n.startsWith(`${i + 1}. `)), names.join(' | '))
check('every subject is non-empty', subjects.every((x) => x.trim().length > 0))
// Scoped to the array, not the whole file: the header comment names the excluded templates on purpose.
const bodyLiterals = templateSrc.slice(templateSrc.indexOf('export const EMAIL_TEMPLATES'))
check('no unfinished ones (Snacks / Worth A Try / Aliens / Jurassic)',
  !/Snacks|Worth A Try|Ruled Out Aliens|Jurassic/i.test(bodyLiterals))
// A stray bracketed placeholder that is NOT inside a chip would go out as literal text.
const bareBrackets = [...bodyLiterals.matchAll(/\[([^\]]{1,40})\]/g)]
  .map((m) => m[0])
  .filter((b) => !/^\[(Client first name|Event type|decision maker)\]$/.test(b))
check('no bare bracket placeholders outside chips', bareBrackets.length === 0, bareBrackets.join(' '))

console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nAll checks passed.\n')
process.exit(failures ? 1 : 0)
