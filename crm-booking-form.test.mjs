// Regression test for the BOOKING FORM page (Website/book/index.html, served at michaelbloemeke.com/book/).
//
// Two things this guards:
//
//  1. The page's question list is a hand-kept copy of BOOKING_FIELDS in crm-booking-form.mjs. It has
//     to be: the form is a static page on michaelbloemeke.com and cannot reach the CRM on Michael's
//     Mac, so the list cannot be fetched at runtime. If the two ever drift, answers silently vanish
//     on the way in. This test fails loudly instead.
//  2. The page itself actually works: it builds every question, blocks an incomplete submit, posts
//     the token from the URL, and refuses a malformed link.
//
// Driven through real jsdom, so it tests the shipped page rather than a re-implementation.
//
// Run it:  node crm-booking-form.test.mjs      (exits non-zero on failure)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The form now lives in the WEBSITE repo (served from michaelbloemeke.com/book/), not here. It is a
// sibling checkout, so the path is absolute rather than relative to this file.
const BOOK_PAGE = path.join(os.homedir(), 'Desktop', 'Claude', 'Website', 'book', 'index.html')
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')

const html = fs.readFileSync(BOOK_PAGE, 'utf8')
let posted = null
const dom = new JSDOM(html, {
  url: 'https://michaelbloemeke.com/book/AbC123_-token',
  runScripts: 'dangerously',
  beforeParse(w) {
    // The page makes TWO different calls to the same endpoint: a GET (has-this-been-submitted,
    // no body) and a POST (the answers). Parsing a body unconditionally throws on the GET, which
    // would halt the page script before it ever attaches its submit handler.
    w.fetch = (url, opts) => {
      if (!opts || !opts.body) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ submitted: false }) })
      }
      posted = JSON.parse(opts.body)
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) })
    }
    w.scrollTo = () => {}
    w.HTMLElement.prototype.scrollIntoView = () => {}
  },
})
const { document } = dom.window
let fails = 0
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) fails++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}


// --- the list on the page must match the list in the CRM ---------------------
const { BOOKING_FIELDS } = await import('./crm-booking-form.mjs')
const listMatch = html.match(/var FIELDS = \[([\s\S]*?)\n      \];/)
const pageIds = [...listMatch[1].matchAll(/id: '([^']+)'/g)].map((x) => x[1])
const crmIds = BOOKING_FIELDS.map((f) => f.id)
check('page questions match the CRM field list exactly (and in order)', pageIds, crmIds)

check('renders every question', document.querySelectorAll('#bk-fields .bk-field').length, BOOKING_FIELDS.length)
check('the form view is showing', document.getElementById('bk-form-view').style.display !== 'none', true)
check('required questions are starred', document.querySelectorAll('#bk-fields .bk-req').length, 9)
check('indoors/outdoors is a dropdown with 3 options + placeholder', document.getElementById('indoors_or_outdoors').options.length, 4)
check('date field is a real date input', document.getElementById('event_date').type, 'date')
check('invoice email is an email input', document.getElementById('invoice_email').type, 'email')

// Submit empty: should block and flag every required field.
document.getElementById('bk-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
check('empty submit is blocked (nothing posted)', posted, null)
check('every required field is flagged invalid', document.querySelectorAll('#bk-fields .bk-field.bk-invalid').length, 9)

// Fill it in properly.
const vals = {
  event_date: '2026-11-14', event_location: '807 E Main St, Durham NC', venue_type: 'Event venue',
  indoors_or_outdoors: 'Indoors', event_start_time: '18:00', show_start_time: '19:30',
  number_of_guests: '80', age_of_guests: 'adults', vips: 'Denise, 70th',
  av: 'house sound', invoice_to: 'Cave Family Holdings LLC', invoice_email: 'ap@example.com',
  notes: 'parking is tight',
}
for (const [k, v] of Object.entries(vals)) document.getElementById(k).value = v
document.getElementById('bk-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))

await new Promise((r) => setTimeout(r, 20))
check('submitted with the token from the URL', posted && posted.token, 'AbC123_-token')
check('posted every answer', posted && posted.answers.length, BOOKING_FIELDS.length)
check('invoice recipient came through', posted && posted.answers.find(a => a.id === 'invoice_to').value, 'Cave Family Holdings LLC')
check('no fields left flagged', document.querySelectorAll('#bk-fields .bk-field.bk-invalid').length, 0)
check('thank-you view is shown', document.getElementById('bk-done').style.display, 'block')

// A bad token should show the dead-link banner instead of a form.
const bad = new JSDOM(html, { url: 'https://michaelbloemeke.com/book/not a token!', runScripts: 'dangerously',
  beforeParse(w) { w.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }); w.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {} } })
check('malformed token shows the dead-link banner', bad.window.document.getElementById('bk-dead').style.display, 'block')
check('malformed token renders no form', bad.window.document.querySelectorAll('#bk-fields .bk-field').length, 0)

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
process.exit(fails ? 1 : 0)
