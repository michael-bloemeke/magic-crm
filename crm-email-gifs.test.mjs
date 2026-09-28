// Regression test for EMBEDDED template GIFs.
//
// What this guards: Michael's Ghostbuster follow-ups are jokes that only land if the recipient sees
// the moving picture inside the email. A giphy URL, a broken image, or a data: src that Gmail
// strips from received mail all fail the same way, silently, and he would only find out from the
// client's confusion. So this asserts the whole chain: template -> composeOutgoing -> MIME, ending
// at "the bytes in the message are byte-identical to the GIF on disk and still a valid GIF".
//
// Run it:  node --experimental-strip-types crm-email-gifs.test.mjs
import fs from 'node:fs'
import { JSDOM } from 'jsdom'
import { composeOutgoing, emailGifPath } from './crm-email-render.mjs'
import { makeRaw } from './crm-gmail.mjs'

// The template library is TypeScript, so it is imported through Node's type stripping and read as
// real data rather than regex-scraped. That way a template whose GIF slug is wrong fails here.
const dom = new JSDOM('<body></body>')
globalThis.DOMParser = dom.window.DOMParser
const { TEMPLATE_GROUPS, EMAIL_TEMPLATES } = await import('./src/emailTemplates.ts')
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
// Read off the rendered bodies, so this checks what actually ships, not what the source looks like.
const slugs = [
  ...new Set(EMAIL_TEMPLATES.flatMap((t) => [...t.body.matchAll(/data-crm-gif="([^"]+)"/g)].map((m) => m[1]))),
]

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

console.log('\n6. A thread REPLY carries an inline GIF and a real attachment at the same time')
// The reply box sends through the same composeOutgoing, so the risk is not the GIF but the MIME
// nesting: an inline image needs multipart/related and an attachment needs multipart/mixed, and
// getting the order wrong makes Gmail show the GIF as a second paperclip instead of in the body.
const withAtt = Buffer.from(
  makeRaw({
    from: 'me@x.com', to: 'c@x.com', subject: 'Re: Your event', body: 'text', html: out.sendHtml,
    inlineImages: out.inlineImages,
    attachments: [{ filename: 'Rider.pdf', contentType: 'application/pdf', contentBase64: Buffer.from('%PDF-1.4').toString('base64') }],
    threadId: 't1',
  }),
  'base64url',
).toString('utf8')
const iMixed = withAtt.indexOf('multipart/mixed')
const iRelated = withAtt.indexOf('multipart/related')
const iAlt = withAtt.indexOf('multipart/alternative')
check('mixed wraps related wraps alternative', iMixed > -1 && iMixed < iRelated && iRelated < iAlt,
  `mixed@${iMixed} related@${iRelated} alt@${iAlt}`)
check('the GIF stays INLINE', /Content-Disposition: inline; filename="[^"]+\.gif"/.test(withAtt))
check('the file is a real attachment', /Content-Disposition: attachment; filename="Rider\.pdf"/.test(withAtt))
check('both parts present', withAtt.includes('image/gif') && withAtt.includes('application/pdf'))

console.log('\n7. Ordinary emails are untouched, and a bad slug cannot read outside email-gifs/')
const plain = composeOutgoing('<p>Just a normal note.</p>')
check('no inline images added', plain.inlineImages.length === 0)
check('body unchanged', plain.sendHtml.includes('Just a normal note.'))
const missing = composeOutgoing('<p><img src="/api/email-gif/nope" data-crm-gif="nope" /></p>')
check('missing gif left alone, not a broken cid:', missing.inlineImages.length === 0 && !missing.sendHtml.includes('cid:'))
for (const bad of ['../crm-gmail', '../../etc/passwd', 'a/../../b', '', 'UPPER', 'has space']) {
  check(`traversal refused: ${JSON.stringify(bad)}`, emailGifPath(bad) === null)
}

console.log('\n8. The library is the four folders, holding exactly what Michael asked for')
const byName = Object.fromEntries(TEMPLATE_GROUPS.map((g) => [g.name, g.templates.map((t) => t.name)]))
check('four folders', TEMPLATE_GROUPS.length === 4, TEMPLATE_GROUPS.map((g) => g.name).join(' | '))
check('folders are Ghostbusters / 14 Magic Emails / Old HoneyBook Templates / Misc',
  JSON.stringify(Object.keys(byName)) === JSON.stringify(['Ghostbusters', '14 Magic Emails', 'Old HoneyBook Templates', 'Misc']),
  Object.keys(byName).join(' | '))
// Misc is Michael's own, added 2026-09-28, and is the one folder that will keep growing.
check('Misc holds Proposal nudge', JSON.stringify(byName['Misc']) === JSON.stringify(['Proposal nudge']),
  (byName['Misc'] || []).join(' | '))
// The nudge must never name the document or hint that view tracking exists.
const nudge = EMAIL_TEMPLATES.find((t) => t.id === 'misc-proposal-nudge')
check('nudge never says "proposal" to the client',
  !!nudge && !/proposal/i.test(nudge.subject + nudge.body),
  nudge ? nudge.subject : 'MISSING')

// Ghostbusters: the numbered ones only.
const gb = byName['Ghostbusters'] || []
check('11 Ghostbusters', gb.length === 11, String(gb.length))
check('all numbered 1-11 in order', gb.every((n, i) => n.startsWith(`${i + 1}. `)), gb.join(' | '))
check('no unfinished Ghostbusters (Snacks / Worth A Try / Aliens / Jurassic)',
  !/Snacks|Worth A Try|Ruled Out Aliens|Jurassic/i.test(gb.join(' ')))

// 14 Magic Emails: all of them.
check('11 Magic Emails entries', (byName['14 Magic Emails'] || []).length === 11, String((byName['14 Magic Emails'] || []).length))

// HoneyBook: EXACTLY the eight he picked, and Post Call Email deliberately excluded.
const hb = byName['Old HoneyBook Templates'] || []
const wantHb = ['Initial Inquiry', 'Inquiry Follow Up', 'Follow Up', 'Follow Up #2', 'Follow Up #3',
  'Break Up', 'Booking Confirmation', '2-Week Check In']
check('the eight HoneyBook templates, in order', JSON.stringify(hb) === JSON.stringify(wantHb), hb.join(' | '))
check('Post Call Email is NOT included', !hb.some((n) => /post call/i.test(n)))
check('the contract/invoice email is NOT included', !hb.some((n) => /contract|invoice|agreement/i.test(n)))

console.log('\n9. Every template is sendable and uniquely addressable')
check('31 templates total', EMAIL_TEMPLATES.length === 31, String(EMAIL_TEMPLATES.length))
const ids = EMAIL_TEMPLATES.map((t) => t.id)
check('all ids unique', new Set(ids).size === ids.length, 'duplicate id')
// The composer refuses to send without a subject, so a template with a blank one is a dead end.
const noSubject = EMAIL_TEMPLATES.filter((t) => !t.subject.trim()).map((t) => t.name)
check('every template has a subject', noSubject.length === 0, noSubject.join(', '))
const noBody = EMAIL_TEMPLATES.filter((t) => !t.body.trim()).map((t) => t.name)
check('every template has a body', noBody.length === 0, noBody.join(', '))

console.log('\n10. Placeholders: ONLY the name autofills, everything else stays as a red write-in')
const autofill = [...new Set(EMAIL_TEMPLATES.flatMap((t) =>
  [...t.body.matchAll(/data-field="([^"]+)"/g)].map((m) => m[1])))]
check('firstName is the only autofilling field', JSON.stringify(autofill) === JSON.stringify(['firstName']), autofill.join(', '))
// Anything bracketed that is NOT inside a chip would be mailed to a client as literal text.
const bare = EMAIL_TEMPLATES.flatMap((t) => {
  const stripped = t.body.replace(/<span class="merge-field"[^>]*>[\s\S]*?<\/span>/g, '')
  return [...stripped.matchAll(/\[[^\]]{1,60}\]|\{\{[^}]{1,60}\}\}/g)].map((m) => `${t.id}: ${m[0]}`)
})
check('no bare placeholders outside chips', bare.length === 0, bare.join(' | '))
// The Calendly tags keep their own braces rather than being re-bracketed.
const calendly = EMAIL_TEMPLATES.flatMap((t) =>
  [...t.body.matchAll(/data-note="true"[^>]*>(\{\{[^<]+\}\})</g)].map((m) => m[1]))
check('{{calendly}} tags kept verbatim in red', calendly.length > 0 && calendly.every((c) => /^\{\{\w+\}\}$/.test(c)), calendly.join(', '))

const css = fs.readFileSync('./src/index.css', 'utf8')
const noteCss = css.slice(css.indexOf('.merge-field[data-note]'), css.indexOf('.merge-field[data-note]') + 260)
check('write-in chips are red', /#b91c1c/.test(noteCss) && /#fee2e2/.test(noteCss))

console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nAll checks passed.\n')
process.exit(failures ? 1 : 0)
