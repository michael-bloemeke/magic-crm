import fs from 'node:fs'
const SD = new URL('.', import.meta.url).pathname
process.argv[2] = SD + 'app.built.mjs'
await import('./harness.mjs')
const { __app } = await import('./app.built.mjs')
const { CALLS } = await import('./stub.mjs')

let fails = 0
const ok = (cond, label, extra) => {
  if (cond) console.log('  PASS  ' + label)
  else { fails++; console.log('  FAIL  ' + label + (extra ? '  <<' + extra + '>>' : '')) }
}
const text = () => document.querySelector('#view').textContent.replace(/\s+/g, ' ').trim()
const has = (s) => text().includes(s)

const PROJECT = {
  id: 'sarah-whitfield', client: 'Sarah Whitfield', bucket: 'active', stageId: 's2', status: '',
  eventType: 'Gala', eventDate: '2026-10-04', arrivalTime: '19:00', eventStartTime: '19:30',
  showStartTime: '20:30', eventLocation: '3001 Cameron Blvd, Durham, NC 27705', venueType: 'Hotel ballroom',
  indoorsOrOutdoors: 'Indoors', numberOfGuests: '250', ageOfGuests: 'Adults', performanceStyle: 'The formal show',
  totalFee: 2500, tips: null, mileage: null, vips: '', av: 'House PA', bookingSource: 'Referral',
  eventSummary: 'Black tie gala', eventDescription: 'A long write-up.', projectNotes: 'Park in deck B.',
  contactNames: 'Sarah Whitfield', contactEmails: 'sarah@duke.edu', contactPhones: '9195551234',
  flags: {}, activityLog: ['2026-09-01 Inquiry received'],
}
const BARE = { ...PROJECT, id: 'bare-project', client: 'Bare Project', eventDate: '', arrivalTime: '',
  eventStartTime: '', showStartTime: '', eventLocation: '', contactEmails: '', contactPhones: '', contactNames: '' }

const SNAP = {
  projects: [PROJECT, BARE],
  tasks: [
    { id: 't1', projectId: 'sarah-whitfield', title: 'Confirm AV with venue', dueDate: '2026-09-15', dueTime: '', done: false },
    { id: 't2', projectId: 'sarah-whitfield', title: 'Send invoice', dueDate: '', dueTime: '', done: true },
    { id: 't3', projectId: '', title: 'Order new deck', dueDate: '2026-09-25', dueTime: '09:00', done: false },
  ],
  payments: [], notifications: [], contacts: [], links: {}, finance: null,
  eventFieldLabels: {}, eventFieldHidden: [], eventFieldDeleted: [], customFields: [], customValues: {},
  structure: { umbrellas: [] },
}
__app.setSnap(SNAP)
__app.setStageMap({ s2: { name: 'Proposal sent', umbrella: 'Selling', color: '#c9a227' } })

const settle = () => new Promise((r) => setTimeout(r, 30))

console.log('\n== project detail: the day-of card ==')
__app.setTab('pipeline'); __app.setPtab('details')
__app.renderDetail('sarah-whitfield')
await settle()
ok(__app.getPtab() === 'details', 'Details is the tab that opens')
ok(has('Oct 4, 2026') || /Oct\s*4/.test(text()), 'event date is on screen', text().slice(0, 120))
ok(has('7:00 PM'), 'arrival time renders as 7:00 PM (from "19:00")')
ok(has('8:30 PM'), 'show time renders as 8:30 PM')
ok(has('3001 Cameron Blvd, Durham, NC 27705'), 'venue address is on screen')
ok(has('Directions'), 'Directions button exists')
const addrBtn = [...document.querySelectorAll('.do-addr')][0]
ok(!!addrBtn, 'the address itself is a tap target')
ok(has('(919) 555-1234'), 'phone is formatted for reading', text().slice(0,200))
const call = [...document.querySelectorAll('a[href^="tel:"]')][0]
ok(call && call.getAttribute('href') === 'tel:9195551234', 'tel: link carries the RAW number, not the formatted one')
ok(has('250'), 'guest count shown')
ok(has('The formal show'), 'performance style shown')

console.log('\n== free text where a time was expected (found on real data) ==')
const FREE = { ...PROJECT, id: 'free-text', client: 'Free Text',
  eventStartTime: 'Not locked in yet', showStartTime: 'Cocktail hour, around 6', arrivalTime: '17:45',
  venueType: 'NC State University Club. Mainly indoors, with an outdoor patio guests move between.',
  indoorsOrOutdoors: 'Mainly indoors, with an outdoor patio' }
SNAP.projects.push(FREE)
__app.renderDetail('free-text')
await settle()
ok(has('Not locked in yet'), 'a free-text event time is shown in full, not truncated')
ok(has('Cocktail hour, around 6'), 'and so is a free-text show time')
ok(has('5:45 PM'), 'a real clock time beside them still formats')
const frees = [...document.querySelectorAll('.do-time-v.free')]
ok(frees.length === 2, 'exactly the two free-text values get the wrapping treatment', String(frees.length))
ok(!document.querySelector('.do-time-v.free.miss'), 'a free-text value is not also flagged as missing')
const vmeta = document.querySelector('.do-vmeta').textContent
ok(vmeta.toLowerCase().split('mainly indoors').length === 2, 'indoors/outdoors is not repeated when venue type already says it', vmeta)
// And the other direction: when they genuinely differ, both are shown.
FREE.venueType = 'Hotel ballroom'
__app.renderDetail('free-text')
await settle()
ok(document.querySelector('.do-vmeta').textContent.includes('Hotel ballroom') &&
   document.querySelector('.do-vmeta').textContent.includes('Mainly indoors'),
   'but both are shown when they say different things', document.querySelector('.do-vmeta').textContent)
SNAP.projects.pop()

console.log('\n== maps links ==')
const m = __app.mapsLinks(' 3001 Cameron Blvd,\n Durham, NC 27705 ')
ok(m.apple.startsWith('maps://?daddr='), 'Apple Maps uses the custom scheme (so iOS hands it to Maps)')
ok(m.apple.includes('dirflg=d'), 'asks for driving directions, not a search pin')
ok(!m.apple.includes('\n'), 'newlines in the stored address are collapsed before encoding')
ok(m.googleWeb.startsWith('https://'), 'Google has an https fallback that always resolves')
ok(__app.mapsLinks('   ') === null, 'a blank address yields no link at all')

console.log('\n== blanks are called out, not hidden ==')
__app.renderDetail('bare-project')
await settle()
ok(has('No date set'), 'missing date says so')
ok(has('No venue address yet'), 'missing address says so')
ok(document.querySelectorAll('.do-time-v.miss').length === 3, 'all three missing times are flagged')
ok(!document.querySelector('a[href^="tel:"]'), 'no dead Call button when there is no phone number')

console.log('\n== what the client sent back ==')
__app.renderDetail('sarah-whitfield')
await settle()
ok(has('What they sent back'), 'the submitted-form section appears')
ok(has('Performance agreement'), 'the agreement PDF is reachable from Details')
ok(has('Signed'), 'it says it was signed')
ok(has('Completed booking form'), 'the booking form answers are reachable')
const toggle = [...document.querySelectorAll('.pdfchip')].find((b) => b.textContent.includes('Completed booking form'))
ok(toggle.textContent.includes('6 answers'), 'blank answers are not counted (7 given, 1 blank)', toggle.textContent)
toggle.dispatchEvent(new window.Event('click'))
ok(has('Venue address'), 'raw answer ids are mapped to their questions')
ok(has('an id with no label mapping'), 'an UNKNOWN answer id still renders its value')
ok(has('brand_new_question'), 'an unknown id falls back to the id rather than vanishing')
ok(!!document.querySelector('.do-inline-addr'), "the client's typed address is tappable too")

console.log('\n== fee write path (the bug that was found) ==')
CALLS.length = 0
console.log('\n== tasks ==')
__app.setDetail(null); __app.setTab('tasks'); __app.renderTasks()
await settle()
ok(has('Order new deck'), 'an unassigned task shows on the Tasks page')
ok(has('Confirm AV with venue'), 'a project task shows on the Tasks page')
ok(has('Done · 1'), 'completed tasks are reachable again', text().slice(-120))
const taskBody = document.querySelector('.taskbody')
taskBody.dispatchEvent(new window.Event('click'))
await settle()
ok(!!document.querySelector('.sheet'), 'tapping a task opens the editor')
const sheetTxt = document.querySelector('.sheet').textContent
ok(sheetTxt.includes('Tomorrow') && sheetTxt.includes('+1 week'), 'quick reschedule buttons are there')
ok(sheetTxt.includes('Delete task'), 'delete lives in the editor')
const btns = [...document.querySelectorAll('.sheet .do-alt')]
btns.find((b) => b.textContent === 'Tomorrow').dispatchEvent(new window.Event('click'))
const dIn = document.querySelector('.sheet input[type=date]')
const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1)
const iso = tomorrow.toISOString().slice(0, 10)
ok(dIn.value === iso, 'Tomorrow sets the date to tomorrow', dIn.value + ' vs ' + iso)
btns.find((b) => b.textContent === 'Clear').dispatchEvent(new window.Event('click'))
ok(dIn.value === '', 'Clear empties the date')
;[...document.querySelectorAll('.sheet .btn-gold')].find((b) => b.textContent === 'Save').dispatchEvent(new window.Event('click'))
await settle()
const upd = CALLS.find((c) => c.name === 'updateTask')
ok(!!upd, 'Save calls updateTask')
ok(upd && upd.args[0].dueDate === '', 'clearing the date sends an empty STRING, not undefined', JSON.stringify(upd && upd.args[0]))
document.querySelectorAll('.sheet').forEach((s) => s.remove())

console.log('\n== inbox is scoped to contacts on ACTIVE projects ==')
CALLS.length = 0
__app.setDetail(null); __app.setTab('inbox'); __app.renderInbox()
await settle()
const q = CALLS.find((c) => c.name === 'gmailList')
ok(Array.isArray(q.args[0]), 'the inbox sends chunked queries, not one string')
const joined = q.args[0].join(' ')
ok(!/in:inbox/.test(joined), 'it never asks for the whole mailbox', joined)
ok(/from:\{[^}]*sarah@duke\.edu/.test(joined), "an active project's contact is in the query", joined)
ok(/to:\{[^}]*sarah@duke\.edu/.test(joined), 'and so is the same address under to:, so his sent mail counts')
ok(has('Sarah Whitfield'), 'a thread renders')
ok(document.querySelectorAll('.mailrow.unread').length === 1, 'exactly the unread thread is marked unread')
ok(document.querySelector('.mailproj').textContent === 'Sarah Whitfield', 'a thread is matched to its project')
;[...document.querySelectorAll('.segb')].find((b) => b.textContent === 'Unread').dispatchEvent(new window.Event('click'))
await settle()
const q2 = CALLS.filter((c) => c.name === 'gmailList').pop()
ok(q2.args[0].every((x) => x.startsWith('is:unread ')), 'Unread prefixes every chunk', JSON.stringify(q2.args[0]))
ok(!/in:inbox/.test(q2.args[0].join(' ')), 'and still never widens to the whole mailbox')
;[...document.querySelectorAll('.segb')].find((b) => b.textContent === 'All').dispatchEvent(new window.Event('click'))
await settle()

console.log('\n== the query is built from ACTIVE projects only ==')
const ARCHIVED = { ...PROJECT, id: 'old-client', client: 'Old Client', bucket: 'archived', contactEmails: 'archived@example.com' }
SNAP.projects.push(ARCHIVED)
const built = __app.buildClientMailQueries('')
ok(built.join(' ').includes('sarah@duke.edu'), 'an active contact is included')
ok(!built.join(' ').includes('archived@example.com'), 'an ARCHIVED project\'s contact is not', built.join(' '))
SNAP.projects.pop()
// Nobody to search for must mean an empty list, never a fallback that reopens the whole mailbox.
const keptProjects = SNAP.projects
SNAP.projects = [{ ...BARE, bucket: 'active' }]
ok(__app.buildClientMailQueries('').length === 0, 'no addresses yields NO query rather than a broad one')
__app.setTab('inbox'); __app.renderInbox()
await settle()
ok(has('nobody to show mail from'), 'and the page says why instead of showing junk')
SNAP.projects = keptProjects
// An address with a space would break out of Gmail's brace group and silently widen the search.
SNAP.projects.push({ ...PROJECT, id: 'bad-addr', client: 'Bad', bucket: 'active', contactEmails: 'not an email, {evil}' })
ok(!__app.buildClientMailQueries('').join(' ').match(/[{][^}]*\s(not|evil)/), 'a malformed address cannot escape the brace group')
SNAP.projects.pop()

console.log('\n== the row names the CLIENT, never Michael ==')
__app.setTab('inbox'); __app.renderInbox()
await settle()
const rows = [...document.querySelectorAll('.mailrow')]
const mine = rows.find((x) => x.textContent.includes('Booking details'))
ok(!!mine, 'the thread whose newest message is his own reply is in the list')
ok(!mine.querySelector('.mailfrom').textContent.includes('Michael Bloemeke'),
   'and it does NOT show his own name', mine.querySelector('.mailfrom').textContent)
ok(mine.querySelector('.mailfrom').textContent.includes('sarah@duke.edu'), 'it shows the client instead')
ok(!!mine.querySelector('.mailto'), 'marked "To" so an outbound thread still reads differently')
const inbound = rows.find((x) => x.textContent.includes('Magic for the gala'))
ok(!inbound.querySelector('.mailto'), 'an inbound thread is not marked To')
ok(inbound.querySelector('.mailfrom').textContent.includes('Sarah Whitfield'), 'and still shows the sender')

console.log('\n== reading a thread does not mark it read ==')
CALLS.length = 0
document.querySelector('.mailrow').dispatchEvent(new window.Event('click'))
await settle()
ok(!!document.querySelector('.sheet'), 'the thread opens')
ok(document.querySelector('.sheet').textContent.includes('What time would you arrive'), 'the body is readable')
ok(!CALLS.some((c) => c.name === 'gmailMarkRead'), 'opening a thread does NOT mark it read')
ok(document.querySelector('.sheet').textContent.includes('Mark read'), 'marking read is an explicit button')

console.log('\n== replying ==')
;[...document.querySelectorAll('.sheet .btn-gold')].find((b) => b.textContent === 'Reply').dispatchEvent(new window.Event('click'))
await settle()
const compose = document.querySelector('.sheet')
ok(compose.textContent.includes('Reply'), 'the composer opens as a reply')
const toIn = compose.querySelector('input[type=email]')
ok(toIn.value === 'sarah@duke.edu', 'it is addressed back to the sender', toIn.value)
const subIn = [...compose.querySelectorAll('input.search')].find((i) => i.type !== 'email')
ok(subIn.value === 'Re: Magic for the gala', 'the subject is not double-prefixed', subIn.value)
ok(!!compose.querySelector('[data-crm-signature]'), 'Settings has the signature on, so a new email starts with it ticked')
compose.querySelector('.rte').insertAdjacentHTML('afterbegin', '<p>I will be there at 7.</p>')
CALLS.length = 0
const sendBtn = [...compose.querySelectorAll('.btn-gold')].find((b) => b.textContent === 'Send')
sendBtn.dispatchEvent(new window.Event('click'))
ok(sendBtn.disabled === true, 'Send disables itself so a double tap cannot send twice')
await settle()
const sent = CALLS.find((c) => c.name === 'sendEmail')
ok(!!sent, 'sendEmail was called')
ok(sent && sent.args[0].to.join(',') === 'sarah@duke.edu', 'to the right person', sent && sent.args[0].to)
ok(sent && !!sent.args[0].threadId, 'a reply carries its threadId, so it lands IN the conversation')
ok(sent && sent.args[0].html.includes('I will be there at 7.') && sent.args[0].html.includes('data-crm-signature'), 'the HTML body goes out with the signature block in it')
ok(CALLS.some((c) => c.name === 'gmailMarkRead'), 'replying DOES mark the thread read')
document.querySelectorAll('.sheet').forEach((s) => s.remove())

console.log('\n== templates ==')
__app.openCompose({ project: PROJECT })
await settle()
let c3 = document.querySelector('.sheet')
;[...c3.querySelectorAll('.cmp-pick')].find((b) => b.textContent.includes('Template')).dispatchEvent(new window.Event('click'))
await settle()
const tplSheet = [...document.querySelectorAll('.sheet')].pop()
ok(tplSheet.textContent.includes('Ghostbusters') && tplSheet.textContent.includes('Misc'), 'the Mac\'s template folders are offered')
;[...tplSheet.querySelectorAll('.actrow')].find((b) => b.textContent.includes('Back to the Future')).dispatchEvent(new window.Event('click'))
await settle()
const subj3 = [...c3.querySelectorAll('input.search')].find((i) => i.type !== 'email')
ok(subj3.value === 'You Made A Great Call', 'picking a template fills the subject', subj3.value)
const rte3 = c3.querySelector('.rte')
ok(rte3.textContent.includes('Hello Sarah,'), 'the client\'s first name fills itself in', rte3.textContent.slice(0, 40))
ok(!!rte3.querySelector('span.merge-field[data-note]'), 'write-in placeholders stay as red chips')
ok(!!rte3.querySelector('img[data-crm-gif="back-to-the-future"]'), 'the GIF comes with it, tagged for embedding')
ok(!!rte3.querySelector('[data-crm-signature]'), 'the signature survives the template swap')
c3.querySelector('input[type=email]').value = 'sarah@duke.edu'
CALLS.length = 0
const send3 = [...c3.querySelectorAll('.btn-gold')].find((b) => b.textContent === 'Send')
send3.dispatchEvent(new window.Event('click'))
await settle()
ok(!CALLS.some((c) => c.name === 'sendEmail'), 'unfilled placeholders stop the first Send')
ok(c3.querySelector('.cmp-status').textContent.includes('the event'), 'and say which ones', c3.querySelector('.cmp-status').textContent)
// Fill one by tapping it.
rte3.querySelector('span.merge-field[data-note]').dispatchEvent(new window.Event('click', { bubbles: true }))
await settle()
const fill = [...document.querySelectorAll('.sheet')].pop()
fill.querySelector('input.search').value = 'the gala'
;[...fill.querySelectorAll('.btn-gold')].find((b) => b.textContent === 'Use this').dispatchEvent(new window.Event('click'))
await settle()
ok(rte3.textContent.includes('after the gala'), 'tapping a chip fills it with real words', rte3.textContent.slice(0, 120))
send3.dispatchEvent(new window.Event('click'))
await settle()
send3.dispatchEvent(new window.Event('click'))
await settle()
ok(CALLS.some((c) => c.name === 'sendEmail'), 'a second Send goes out as-is, like the Mac')
document.querySelectorAll('.sheet').forEach((s) => s.remove())

console.log('\n== drafts ==')
__app.openCompose({ project: PROJECT })
await settle()
const c4 = document.querySelector('.sheet')
CALLS.length = 0
c4.querySelector('.rte').insertAdjacentHTML('afterbegin', '<p>Thinking out loud</p>')
c4.querySelector('.rte').dispatchEvent(new window.Event('input'))
await new Promise((r) => setTimeout(r, 900))
await settle()
const sv = CALLS.find((c) => c.name === 'saveComposeDraft')
ok(!!sv, 'a project email autosaves as a draft')
ok(sv && sv.args[0].projectId === 'sarah-whitfield' && sv.args[0].html.includes('Thinking out loud'), 'with its project and its HTML')
ok(c4.textContent.includes('Discard draft'), 'and offers Discard once it exists')
document.querySelectorAll('.sheet').forEach((s) => s.remove())

console.log('\n== compose validation ==')
__app.openCompose({ project: PROJECT })
await settle()
const c2 = document.querySelector('.sheet')
ok(c2.textContent.includes('sarah@duke.edu'), "the project's address is offered as a one-tap chip")
CALLS.length = 0
;[...c2.querySelectorAll('.btn-gold')].find((b) => b.textContent === 'Send').dispatchEvent(new window.Event('click'))
await settle()
ok(!CALLS.some((c) => c.name === 'sendEmail'), 'an empty compose does not send')
document.querySelectorAll('.sheet').forEach((s) => s.remove())

console.log('\n== project email tab ==')
CALLS.length = 0
__app.setTab('pipeline'); __app.setPtab('email')
__app.renderDetail('sarah-whitfield')
await settle()
const mq = CALLS.find((c) => c.name === 'gmailList')
ok(mq && mq.args[0] === '(from:sarah@duke.edu OR to:sarah@duke.edu)', 'the query is parenthesised so OR binds correctly', mq && mq.args[0])
ok(has('Write'), 'there is a Write button on the project')
ok(has('Quick question') && has('Drafts'), 'saved drafts show on the project Email tab')
__app.setPtab('email')
__app.renderDetail('bare-project')
await settle()
ok(has('No email address on this project'), 'a project with no address explains itself')

console.log('\n== unread badge ==')
await __app.refreshUnreadMail()
await settle()
const badge = document.querySelector('#nav-badge-inbox')
ok(badge.textContent === '7', 'the drawer badge shows the unread count', badge.textContent)
ok(!badge.classList.contains('hidden'), 'and is visible')

console.log('\n== proposals ==')
CALLS.length = 0
__app.setDetail(null); __app.setTab('proposals'); __app.renderProposals()
await settle()
ok(has('Proposal template') && has('Booking form template'), 'the two templates are at the top')
ok(has('Out now'), 'proposals still in play are grouped first')
ok(has('Settled'), 'resolved ones are grouped after')
ok(has('Sarah Whitfield') && has('Vijay Rao'), 'both proposals render')
ok(has('6 views'), 'the view count is shown')
ok(has('Never opened.'), 'a proposal nobody opened says so plainly')
ok(has('Went with a band'), 'the archive reason is carried through')
ok(has('Fell through'), 'a lost deal is labelled')
ok(has('Live'), 'link state is shown separately from deal outcome')
const previews = [...document.querySelectorAll('.propcard button.do-go')]
ok(previews.length === 3, 'every proposal has a Preview button', String(previews.length))
ok([...document.querySelectorAll('#view a')].length === 0, 'and nothing on the page is an <a> that would leave the app')
ok(!document.querySelector('#view').innerHTML.includes('SECRETKEY'), 'the admin key is never rendered into the page')
// Preview opens IN the app, framing the flagged URL.
previews.find((b) => b.closest('.propcard').textContent.includes('Vijay Rao')).dispatchEvent(new window.Event('click'))
await settle()
const pane = document.querySelector('.previewpane')
ok(!!pane, 'Preview opens a pane inside the CRM rather than handing off to a browser')
const frame = pane.querySelector('iframe.pv-frame')
ok(!!frame, 'with the real page in an iframe')
ok(frame.src.includes('preview=1'), 'framing the FLAGGED url')
ok(frame.src.includes('&k=SECRETKEY'), 'and a taken-down proposal gets the admin key too', frame.src)
ok(pane.textContent.includes('Not counted as a view'), 'and it says so on screen')
pane.querySelector('.pv-back').dispatchEvent(new window.Event('click'))
await settle()
ok(!document.querySelector('.previewpane'), 'Back closes it')
ok(!document.body.classList.contains('previewing'), 'and unlocks the page behind it')
// The templates too.
;[...document.querySelectorAll('#view .do-alt')].find((b) => b.textContent === 'Proposal template').dispatchEvent(new window.Event('click'))
await settle()
const tpane = document.querySelector('.previewpane')
ok(!!tpane && tpane.querySelector('iframe').src.includes('demo=1'), 'the template opens in the pane too', tpane && tpane.querySelector('iframe').src)
ok(!tpane.querySelector('.pv-copy'), 'a template has no client link to copy')
tpane.remove(); document.body.classList.remove('previewing')
// Copy hands over the clean one.
let copied = null
window.navigator.clipboard = { writeText: (t) => { copied = t; return Promise.resolve() } }
// Copy on EVERY card, not just one: the invariant is that none of them ever hands over a flagged URL.
const cards = [...document.querySelectorAll('.propcard')]
const copiedAll = []
for (const card of cards) {
  copied = null
  ;[...card.querySelectorAll('.do-alt')].find((b) => b.textContent === 'Copy link').dispatchEvent(new window.Event('click'))
  await settle()
  copiedAll.push(copied)
}
ok(copiedAll.length === 3 && copiedAll.every((u) => u && !/preview=1|[?&]k=/.test(u)),
   'Copy gives the CLEAN link on every card, with no flags', JSON.stringify(copiedAll))
ok(copiedAll.includes('https://michaelbloemeke.com/proposal/?t=ABC'), 'and it is the real client URL')
;[...document.querySelectorAll('.segb')].find((b) => b.textContent === 'Booking forms').dispatchEvent(new window.Event('click'))
await settle()
ok(has('3 views') && !has('Vijay Rao'), 'the Booking forms tab shows forms, not proposals')
ok([...document.querySelectorAll('.propcard a.do-go')].every((a) => a.href.includes('preview=1')), 'booking form previews are flagged too')

console.log('\n== pipeline ==')
// Earlier tests edited the task fixture (the editor test cleared its due date), so restore a known
// overdue task rather than depending on test order.
SNAP.tasks[0].dueDate = '2026-09-15'; SNAP.tasks[0].dueTime = ''; SNAP.tasks[0].done = false
__app.setDetail(null); __app.setTab('pipeline'); __app.renderPipeline()
await settle()
ok(has('Sarah Whitfield'), 'an active project shows on the pipeline')
ok(/in \d+ days|Today|Tomorrow|days ago/.test(text()), 'the card says how far off the event is', text().slice(0,200))
ok(has('1 due'), 'a project with a due task is marked')
await __app.refreshUnreadMail()
await settle()
__app.renderPipeline()
await settle()
ok(document.querySelectorAll('.cmark-mail').length === 1, 'after the poll, the client with unread mail is marked')
ok(document.querySelector('.cmark-mail').textContent === '1 unread', 'and it says how many', document.querySelector('.cmark-mail')?.textContent)
const bad = [...document.querySelectorAll('.card')].filter(c => c.textContent.includes('Bare Project') && c.querySelector('.cmark-mail'))
ok(bad.length === 0, 'a client with no matching mail is NOT marked')

console.log('\n== proposal on the project page ==')
__app.setTab('pipeline'); __app.setPtab('booking')
__app.renderDetail('sarah-whitfield')
await settle()
ok(has('Proposal'), 'the proposal section appears on the Booking tab')
ok(has('Opened 6×'), 'with its view count')
ok(has('Live'), 'and its link state')
const pvBtn = [...document.querySelectorAll('#view button.do-go')].find(b => b.textContent === 'Open preview')
ok(!!pvBtn, 'it has a Preview button')
pvBtn.dispatchEvent(new window.Event('click'))
await settle()
const ppane = document.querySelector('.previewpane')
ok(!!ppane, 'which opens inside the CRM, not in a browser')
ok(ppane.querySelector('iframe').src.includes('preview=1'), 'framing the flagged url', ppane.querySelector('iframe').src)
ok(ppane.textContent.includes(PROJECT.client) || ppane.querySelector('.pv-back').textContent.includes(PROJECT.client),
   'and Back names the project he came from', ppane.querySelector('.pv-back').textContent)
ppane.remove(); document.body.classList.remove('previewing')
__app.setPtab('booking')
__app.renderDetail('bare-project')
await settle()
// Not a text search: "Proposal sent" is this project's STAGE and appears in the header regardless.
// The question is whether the proposal CARD was drawn.
// As on the Mac's ProposalCard: a project with no proposal offers to start one, rather than hiding.
ok([...document.querySelectorAll('#view button')].some((b) => b.textContent === 'Start a proposal'), 'a project with no proposal offers Start a proposal')
__app.setPtab('booking'); __app.renderDetail('sarah-whitfield')
await settle()
ok([...document.querySelectorAll('#view .section-label')].map(e => e.textContent.trim()).includes('Proposal'),
   'and a project WITH one does get the section')

console.log('\n== new project carries a lead source ==')
CALLS.length = 0
__app.setDetail(null); __app.setTab('pipeline')
__app.openNewProject()
await settle()
const np = document.querySelector('.sheet')
const srcSel = np.querySelector('#np-src')
ok(!!srcSel, 'there is a lead-source control on the create form')
ok([...srcSel.options].map(o => o.value).join('|') === '|Google/Web|Bark|The Bash|GigSalad|In Person|Referral|Instagram/TikTok|Other',
   'its options are exactly the eight canonical sources, plus a blank', [...srcSel.options].map(o => o.value).join('|'))
np.querySelector('#np-name').value = 'Test Client'
srcSel.value = 'GigSalad'
;[...np.querySelectorAll('.btn-gold')].find(b => b.textContent === 'Create project').dispatchEvent(new window.Event('click'))
await settle()
const created = CALLS.find(c => c.name === 'createProject')
ok(created && created.args[0].bookingSource === 'GigSalad', 'the chosen source reaches createProject', JSON.stringify(created && created.args[0].bookingSource))
document.querySelectorAll('.sheet').forEach(s => s.remove())

console.log('\n== APNs token refresh on launch ==')
// A fake Capacitor Push plugin that records what the app asked it to do.
let push
const fakePush = (permission) => {
  const listeners = {}
  push = { asked: [], registered: false, listeners,
    addListener: (n, cb) => { listeners[n] = cb },
    requestPermissions: () => { push.asked.push('request'); return Promise.resolve({ receive: permission }) },
    checkPermissions: () => { push.asked.push('check'); return Promise.resolve({ receive: permission }) },
    register: () => { push.registered = true; return Promise.resolve() } }
  window.Capacitor = { isNativePlatform: () => true, Plugins: { PushNotifications: push } }
  return push
}
const alerts = []
globalThis.alert = (m) => alerts.push(m)
window.localStorage.setItem('mcrm_push', '1')

fakePush('granted')
CALLS.length = 0; alerts.length = 0
__app.refreshNativePushToken()
await settle()
ok(push.asked.join() === 'check', 'the silent refresh CHECKS permission, never prompts for it', push.asked.join())
ok(push.registered, 'and it does re-register with APNs on launch')
push.listeners.registration({ value: 'FRESHTOKEN' })
await settle()
const saved = CALLS.find((c) => c.name === 'saveNativePushToken')
ok(saved && saved.args[0] === 'FRESHTOKEN', 'whatever token iOS returns is saved', JSON.stringify(saved && saved.args[0]))
ok(alerts.length === 0, 'and the whole thing is silent', JSON.stringify(alerts))

// Permission revoked in Settings: the bell must come back rather than the app pretending it is on.
fakePush('denied')
CALLS.length = 0; alerts.length = 0
window.localStorage.setItem('mcrm_push', '1')
__app.refreshNativePushToken()
await settle()
ok(window.localStorage.getItem('mcrm_push') !== '1', 'notifications turned off in Settings puts the bell back')
ok(alerts.length === 0, 'without nagging him about it', JSON.stringify(alerts))

// Never opted in: the silent path must not register or prompt behind his back.
fakePush('granted')
CALLS.length = 0; alerts.length = 0
window.localStorage.removeItem('mcrm_push')
__app.refreshNativePushToken()
await settle()
ok(!push.registered && push.asked.length === 0, 'a device that never opted in is left alone')

// The bell itself still asks out loud.
fakePush('granted')
CALLS.length = 0; alerts.length = 0
__app.registerNativePush({ loud: true })
await settle()
ok(push.asked.join() === 'request', 'tapping the bell REQUESTS permission', push.asked.join())
push.listeners.registration({ value: 'BELLTOKEN' })
await settle()
ok(alerts.some((m) => /Notifications are on/.test(m)), 'and says so', JSON.stringify(alerts))
delete window.Capacitor

console.log('\n== small helpers ==')
ok(__app.fmtTime('19:05') === '7:05 PM', 'fmtTime 19:05')
ok(__app.fmtTime('00:30') === '12:30 AM', 'fmtTime midnight half hour')
ok(__app.fmtTime('12:00') === '12:00 PM', 'fmtTime noon')
ok(__app.fmtTime('5ish') === '5ish', 'fmtTime passes free text through untouched')
ok(__app.fmtTime('') === '', 'fmtTime blank stays blank')
ok(__app.fmtPhoneDisplay('19195551234') === '(919) 555-1234', 'an 11-digit number with a leading 1')
ok(__app.fmtPhoneDisplay('+44 20 7946 0958') === '+44 20 7946 0958', 'a non-US number is left alone')
const t0 = new Date(); const d = (n) => { const x = new Date(t0); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10) }
ok(__app.countdownText(d(0)) === 'Today', 'countdown today')
ok(__app.countdownText(d(1)) === 'Tomorrow', 'countdown tomorrow')
ok(__app.countdownText(d(12)) === 'in 12 days', 'countdown future')
ok(__app.countdownText(d(-3)) === '3 days ago', 'countdown past')
ok(__app.projectEmails(PROJECT).join() === 'sarah@duke.edu', 'projectEmails reads the project column')

console.log('\n== home: each tile opens its own list ==')
{
  // Known task states relative to TODAY, whatever day the suite runs.
  const today = d(0)
  const GIG = { ...PROJECT, id: 'gig-soon', client: 'Gig Soon', eventDate: d(3), contactEmails: '' }
  const FAR = { ...PROJECT, id: 'gig-far', client: 'Gig Far Off', eventDate: d(20), contactEmails: '' }
  const saved = { projects: SNAP.projects, tasks: SNAP.tasks }
  SNAP.projects = [...saved.projects, GIG, FAR]
  SNAP.tasks = [
    { id: 'h1', projectId: 'gig-soon', title: 'Old overdue thing', dueDate: d(-5), dueTime: '', done: false },
    { id: 'h2', projectId: 'gig-soon', title: 'Today with no time', dueDate: today, dueTime: '', done: false },
    { id: 'h3', projectId: 'gig-soon', title: 'Tomorrow thing', dueDate: d(1), dueTime: '', done: false },
    { id: 'h4', projectId: 'gig-soon', title: 'Done yesterday', dueDate: d(-1), dueTime: '', done: true },
  ]
  document.querySelectorAll('.sheet').forEach((x) => x.remove())
  __app.setDetail(null); __app.setTab('home'); __app.render()
  await settle()
  ok(document.querySelectorAll('.statcard').length === 6, 'Home shows the four tiles plus the Mac\'s money and daily-duties tiles')
  ok(!!document.querySelector('.statcard.s-duty') && document.querySelector('.statcard.s-duty .n').textContent === '0/3', 'daily duties start at 0 of the three defaults')
  ok(!has('Needs attention') && !has('Next 7 days') && !document.querySelector('#view .card'), 'and nothing under them')
  const tile = (label) => [...document.querySelectorAll('.statcard')].find((c) => c.textContent.includes(label))
  ok(tile('Overdue tasks').querySelector('.n').textContent === '1', 'the overdue tile counts one')

  tile('Overdue tasks').dispatchEvent(new window.Event('click'))
  let sh = document.querySelector('.home-sheet')
  ok(!!sh && __app.getTab() === 'home', 'tapping a tile opens a list on Home instead of leaving it')
  ok(sh.textContent.includes('Old overdue thing') && !sh.textContent.includes('Today with no time') && !sh.textContent.includes('Tomorrow thing'),
     'the overdue list holds overdue tasks only', sh.textContent.slice(0, 200))
  ok(sh.querySelectorAll('.homesheet-go').length === 2 && [...sh.querySelectorAll('.homesheet-go')].every((b) => b.textContent === 'Go to Tasks'),
     'Go to Tasks sits at the top and the bottom')
  ok(sh.querySelectorAll('.taskrow .check').length === 1 && sh.querySelectorAll('.taskrow .taskdel').length === 1, 'each task can be completed or deleted')
  sh.querySelector('.taskrow .check').dispatchEvent(new window.Event('click'))
  await settle()
  ok(!document.querySelector('.home-sheet').textContent.includes('Old overdue thing'), 'completing it takes it off the list')
  document.querySelector('.home-sheet .sheet-x').dispatchEvent(new window.Event('click'))
  ok(!document.querySelector('.home-sheet') && tile('Overdue tasks').querySelector('.n').textContent === '0', 'closing repaints the tile')

  tile('Due today').dispatchEvent(new window.Event('click'))
  sh = document.querySelector('.home-sheet')
  ok(sh.textContent.includes('Today with no time') && !sh.textContent.includes('Tomorrow thing') && !sh.textContent.includes('Done yesterday'),
     'the due-today list is today only, no more, no less', sh.textContent.slice(0, 200))

  // Go to Tasks, then Back: Home with the same list open again.
  sh.querySelector('.homesheet-go').dispatchEvent(new window.Event('click'))
  ok(__app.getTab() === 'tasks' && !document.querySelector('.home-sheet'), 'Go to Tasks lands on Tasks and the list goes with it')
  ok(!document.querySelector('#back-btn').classList.contains('hidden'), 'Back shows on Tasks')
  ok(document.querySelector('#back-label').textContent === 'Home', 'and names where it goes', document.querySelector('#back-label').textContent)
  const hdr = document.querySelector('header.topbar')
  ok(hdr.firstElementChild.id === 'menu-btn', 'the menu button holds the far-left corner')
  ok(document.querySelector('#back-btn').nextElementSibling.id === 'refresh', 'Back sits just left of Refresh')
  __app.goBack()
  ok(__app.getTab() === 'home' && document.querySelector('.home-sheet .sheet-title').textContent.startsWith('Due today'),
     'Back returns to Home with the list he left from', document.querySelector('.home-sheet .sheet-title')?.textContent)
  document.querySelector('.home-sheet .sheet-x').dispatchEvent(new window.Event('click'))

  tile('Gigs next 7 days').dispatchEvent(new window.Event('click'))
  sh = document.querySelector('.home-sheet')
  ok(sh.textContent.includes('Gig Soon') && !sh.textContent.includes('Gig Far Off'), 'the gigs list is the next 7 days only')
  ok([...sh.querySelectorAll('.homesheet-go')].every((b) => b.textContent === 'View all gigs'), 'with View all gigs as the way through')
  ;[...sh.querySelectorAll('.card')].find((c) => c.textContent.includes('Gig Soon')).dispatchEvent(new window.Event('click'))
  ok(__app.getDetail() === 'gig-soon' && !document.querySelector('.home-sheet'), 'tapping a gig opens its project')
  __app.goBack()
  ok(__app.getDetail() === null && __app.getTab() === 'home' && document.querySelector('.home-sheet .sheet-title').textContent.startsWith('Gigs next 7 days'),
     'Back from the project reopens the gigs list')
  document.querySelector('.home-sheet .sheet-x').dispatchEvent(new window.Event('click'))
  __app.getNav().length = 0; __app.render() // earlier tests leave history behind; start clean
  ok(document.querySelector('#back-btn').classList.contains('hidden'), 'Back is hidden on Home with nothing behind it')

  SNAP.projects = saved.projects; SNAP.tasks = saved.tasks
}

console.log('\n== back button ==')
{
  __app.setDetail(null); __app.setTab('home'); __app.render()
  __app.navigate('pipeline')
  __app.renderDetail('sarah-whitfield')
  __app.navigate('inbox')
  ok(document.querySelector('#back-label').textContent === 'Sarah Whitfield', 'from Inbox, Back is labelled with the project he came from')
  __app.goBack()
  ok(__app.getDetail() === 'sarah-whitfield', 'Back from Inbox returns to the project he was on')
  __app.goBack()
  ok(__app.getDetail() === null && __app.getTab() === 'pipeline', 'then to the pipeline he opened it from')
  __app.goBack()
  ok(__app.getTab() === 'home', 'then Home')
  __app.renderDetail('sarah-whitfield'); __app.renderDetail('sarah-whitfield', true)
  __app.goBack()
  ok(__app.getTab() === 'home' && __app.getDetail() === null, 're-rendering the same page is not a step to go back through')
}

console.log('\n== pipeline: one row per stage, in structure order ==')
{
  const saved = { projects: SNAP.projects, structure: SNAP.structure }
  const mk = (id, stageId, date) => ({ ...PROJECT, id, client: id, stageId, eventDate: date, contactEmails: '' })
  SNAP.structure = { umbrellas: [
    { id: 'u1', label: 'First contact', role: 'first', stages: [{ id: 'inq', name: 'Inquiry' }, { id: 'ans', name: 'Answered Inquiry' }, { id: 'fup', name: 'Follow Up Sent' }] },
    { id: 'u2', label: 'Booked', role: 'booked', stages: [{ id: 'bk', name: 'Booked' }] },
  ] }
  __app.setStageMap({
    inq: { name: 'Inquiry', umbrella: 'First contact' }, ans: { name: 'Answered Inquiry', umbrella: 'First contact' },
    fup: { name: 'Follow Up Sent', umbrella: 'First contact' }, bk: { name: 'Booked', umbrella: 'Booked' },
  })
  SNAP.projects = [mk('Fup B', 'fup', '2026-12-01'), mk('Inq Late', 'inq', '2026-12-20'), mk('Inq Early', 'inq', '2026-11-02'),
    mk('Inq Undated', 'inq', ''), mk('Booked One', 'bk', '2026-11-09')]
  __app.setDetail(null); __app.setTab('pipeline'); __app.renderPipeline()
  const rows = [...document.querySelectorAll('.prow')]
  ok(rows.map((r) => r.querySelector('.prow-name').textContent).join('|') === 'Inquiry|Follow Up Sent|Booked',
     'stages run down the page in structure order, empty ones left out', rows.map((r) => r.querySelector('.prow-name').textContent).join('|'))
  const inqNames = [...rows[0].querySelectorAll('.prow-strip > .card .name')].map((n) => n.textContent)
  ok(inqNames.join('|') === 'Inq Early|Inq Late|Inq Undated', 'inside a stage, soonest first and undated last', inqNames.join('|'))
  ok(rows[0].querySelector('.prow-count').textContent === '3', 'each stage shows its count')
  ok(rows[2].classList.contains('prow-one') && !rows[0].classList.contains('prow-one'), 'a lone project takes the full row')
  SNAP.projects = saved.projects; SNAP.structure = saved.structure
  __app.setStageMap({ s2: { name: 'Proposal sent', umbrella: 'Selling', color: '#c9a227' } })
}

console.log('\n== shows ==')
{
  document.querySelectorAll('.sheet').forEach((x) => x.remove())
  ok(!!document.querySelector('#drawer-nav button[data-page="shows"]'), 'Shows is in the menu')
  __app.navigate('shows')
  await settle()
  ok(has('No shows yet'), 'the page starts blank')
  ;[...document.querySelectorAll('#view .addbtn')].find((b) => b.textContent.includes('New show')).dispatchEvent(new window.Event('click'))
  await settle()
  const ns = document.querySelector('.sheet')
  ns.querySelector('input').value = 'Corporate stand-up'
  ;[...ns.querySelectorAll('.btn-gold')].find((b) => b.textContent === 'Add show').dispatchEvent(new window.Event('click'))
  await settle()
  ok(CALLS.some((c) => c.name === 'createShow' && c.args[0] === 'Corporate stand-up'), 'New show creates it')
  ok(__app.getTab() === 'show' && document.querySelector('#pagetitle').textContent === 'Corporate stand-up', 'and opens it as its own page, titled with its name')
  const tabs = [...document.querySelectorAll('#ptabs .ptab-l')].map((x) => x.textContent)
  ok(tabs.join('|') === 'Set List|Packing List', 'two tabs along the bottom: Set List, then Packing List', tabs.join('|'))
  ok(document.querySelector('#ptabs .ptab.on .ptab-l').textContent === 'Set List', 'it opens on the Set List')
  ok(!document.querySelector('#view textarea'), 'read-only until Edit')

  const clickBtn = (label) => [...document.querySelectorAll('#view button')].find((b) => b.textContent.trim() === label).dispatchEvent(new window.Event('click'))
  clickBtn('Edit'); await settle()
  clickBtn('+ Add item'); clickBtn('+ Add item'); await settle()
  const tas = [...document.querySelectorAll('#view textarea')]
  tas[0].value = 'Cups and balls'; tas[0].dispatchEvent(new window.Event('input'))
  tas[1].value = 'Card to wallet'; tas[1].dispatchEvent(new window.Event('input'))
  ok(!!document.querySelector('#view .drag-h'), 'each row has a drag handle in Edit')
  clickBtn('Done'); await settle()
  const up = CALLS.filter((c) => c.name === 'updateShow').pop()
  ok(up && up.args[1].setList.map((x) => x.text).join('|') === 'Cups and balls|Card to wallet', 'Done saves the set list in order', up && JSON.stringify(up.args[1]))
  ok(has('Cups and balls') && !document.querySelector('#view textarea'), 'and goes back to read-only')

  // Packing list: an item, a header, a blank line.
  document.querySelectorAll('#ptabs .ptab')[1].dispatchEvent(new window.Event('click')); await settle()
  ok(document.querySelector('#ptabs .ptab.on .ptab-l').textContent === 'Packing List', 'the Packing List tab opens')
  clickBtn('Edit'); await settle()
  clickBtn('+ Header'); clickBtn('+ Item'); clickBtn('+ Item'); clickBtn('+ Blank line'); clickBtn('+ Header'); await settle()
  const pt = [...document.querySelectorAll('#view textarea')]
  ;['Cups', 'Three cups', 'Wand', 'Cards'].forEach((v, i) => { pt[i].value = v; pt[i].dispatchEvent(new window.Event('input')) })
  ok(document.querySelectorAll('#view .ed-blank').length === 1, 'a blank line shows as a placeholder while editing')
  clickBtn('Done'); await settle()
  const up2 = CALLS.filter((c) => c.name === 'updateShow').pop()
  ok(up2 && up2.args[1].packingList.map((x) => x.type).join(',') === 'header,item,item,blank,header', 'items, headers and blank lines save in order', up2 && JSON.stringify(up2.args[1].packingList.map((x) => x.type)))
  ok(document.querySelectorAll('#view .pack-item').length === 2 && document.querySelectorAll('#view .pack-head').length === 2 && document.querySelectorAll('#view .pack-blank').length === 1,
     'read-only: items get checkboxes, headers do not, the blank line is a gap')
  document.querySelector('#view .pack-item').dispatchEvent(new window.Event('click')); await settle()
  ok(CALLS.some((c) => c.name === 'setPacked' && c.args[2] === true), 'a box can be ticked without editing')
  ok(document.querySelector('#view .pack-item').classList.contains('done'), 'and it is crossed off, still on the list')
  ok(has('1 of 2 packed'), 'the count follows')
  clickBtn('Uncheck all'); await settle()
  ok(CALLS.some((c) => c.name === 'uncheckAllPacked'), 'Uncheck all clears every box at once')
  ok(!document.querySelector('#view .pack-item.done'), 'and nothing is ticked after')

  __app.navigate('shows'); await settle()
  ok(has('Corporate stand-up') && has('2 in the set list'), 'the show is listed with its counts')
  ;[...document.querySelectorAll('#view .show-dup')][0].dispatchEvent(new window.Event('click')); await settle()
  ok(CALLS.some((c) => c.name === 'duplicateShow'), 'Duplicate copies the show')
  const names = [...document.querySelectorAll('#view .show-card .name')].map((x) => x.textContent)
  ok(names.join('|') === 'Corporate stand-up|Copy of Corporate stand-up', 'the copy is named "Copy of ..." and listed after it', names.join('|'))
  ok([...document.querySelectorAll('#view .show-card .meta')][1].textContent.includes('2 in the set list'), 'with the same set list')
  __app.navigate('home')
  document.querySelectorAll('.sheet').forEach((x) => x.remove())
}

console.log('\n== el() never gets two top-level elements ==')
{
  // el() returns ONLY the first top-level element of its HTML. A label-and-value pair written as one
  // string silently loses the value; that left every field on the contact sheet blank and the booking
  // gate with labels and no values (found 2026-10-23). This scans every el('...') literal in app.js.
  const src = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8')
  const VOID = new Set(['input', 'br', 'img', 'hr', 'meta', 'link', 'source', 'col', 'wbr'])
  const bad = []
  src.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/\bel\(/g)) {
      const rest = line.slice(m.index + 3)
      let depth = 1, j = 0, q = null
      while (j < rest.length && depth > 0) {
        const c = rest[j]
        if (q) { if (c === '\\') { j += 2; continue } if (c === q) q = null }
        else if (c === "'" || c === '"' || c === '`') q = c
        else if (c === '(') depth++
        else if (c === ')') depth--
        j++
      }
      const html = [...rest.slice(0, j - 1).matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((x) => x[1]).join('')
      if (!html.includes('<')) continue
      let d = 0, top = 0
      for (const t of html.matchAll(/<(\/?)([a-zA-Z0-9]+)[^>]*?(\/?)>/g)) {
        if (t[1]) { d--; continue }
        if (d === 0) top++
        if (VOID.has(t[2].toLowerCase()) || t[3]) continue
        d++
      }
      if (top > 1) bad.push(i + 1)
    }
  })
  ok(bad.length === 0, 'every el() call builds exactly one element', bad.join(', '))
}

console.log('\n' + (fails ? 'FAILURES: ' + fails : 'ALL PASS'))
process.exit(fails ? 1 : 0)
