/* Bloom CRM mobile. Logs in with Supabase Auth and reads LIVE data straight from the database (RLS
   lets the logged-in user read everything; the publishable key alone reads nothing). Login is
   once-per-device (supabase-js persists the session). Read-only for now: the view renders live data;
   writes are a later stage and slot into supabase-data.js behind the load*() functions.

   This file is an ES module (loaded with <script type="module">) so it can import the data layer. */

'use strict'

import {
  loadEverything, dataChangedSinceLastLoad, getSession, signIn, signOut, currentUserEmail,
  addTask, updateTask, toggleTask, deleteTask, addNote, updateProjectField, addPayment, setStage,
  reloadPaymentsFinance, savePushSubscription, saveNativePushToken,
  createProject, archiveProject, completeProject, restoreProject, deleteProject, LEAD_SOURCES,
  updateContact, loadContacts, linkOrCreateContact, unlinkContact, loadLinks, setNotificationSeen,
  loadBookingProgress, loadContractVariants, readyToBookOnPhone, resetBookingOnPhone, agreementPdfUrl,
  gmailList, gmailThread, gmailMarkRead, gmailUnread, sendEmail, loadProposalsOverview,
  saveComposeDraft, deleteDraft, loadProjectDrafts, uploadEmailAttachment,
  SCHEDULE_FREQUENCIES, DAY_LABELS, loadTaskSchedules, saveTaskSchedule, deleteTaskSchedule, describeSchedule,
  loadInquiryReview, dismissInquiryReview,
  loadShows, createShow, updateShow, setPacked, uncheckAllPacked, duplicateShow, deleteShow,
  phoneApi, saveConfigPatch, loadRawConfig, loadQuickBooksMonths, loadBankBalances, deletePayment,
  EXPENSE_CADENCES, loadExpenses, addExpense, deleteExpense, loadMileage, addTrip, deleteTrip, setMileageRate,
  loadAnalytics, sbCalendarAlertSettings, saveCalendarAlertSettings,
  listFiles, fileUrl, uploadFile, deleteFile,
  loadInquiryForm, loadInvoice, createContact, deleteContact, reloadProjectLog,
} from './supabase-data.js'
import { VAPID_PUBLIC_KEY } from './config.js'
import { TEMPLATE_GROUPS } from './email-templates.js'

var SNAP = null
var TAB = 'home' // current page (drawer destination)
var CONTACT_FILTER = 'all' // contacts page relationship filter
var COLLAPSED = {} // pipeline section label -> collapsed? (persists per session)
var STAGE = {} // stageId -> { name, umbrella, color }
var DETAIL_ID = null // when non-null, the detail view for this project is on screen (not a tab)

var PAGE_TITLES = {
  home: 'Home', pipeline: 'Pipeline', completed: 'Completed', archived: 'Archived', deleted: 'Deleted',
  contacts: 'Contacts', tasks: 'Tasks', alerts: 'Alerts', finance: 'Finance', inbox: 'Inbox',
  proposals: 'Proposals and Booking Forms', calendar: 'Calendar', stats: 'Lead Stats', website: 'Website Analytics',
  playbook: 'Playbook', files: 'Files', settings: 'Settings', shows: 'Shows', show: 'Show',
}

// Completed / Archived / Deleted are their own pages now (2026-08-06). They used to be a segmented
// control on top of Pipeline, which meant the pipeline page was really four pages wearing a trench
// coat and Deleted had nowhere to live at all. Each bucket maps 1:1 to a drawer destination.
var BUCKET_PAGES = { active: 'pipeline', completed: 'completed', archived: 'archived', deleted: 'deleted' }
function pageForBucket(b) { return BUCKET_PAGES[b] || 'pipeline' }

// Contact relationship options (mirrors src/contacts.ts RELATIONSHIP_OPTIONS; FISM colors).
var CONTACT_REL = [
  { v: 'active', label: 'Active', color: '#0e7490' },
  { v: 'yes', label: 'Yes', color: '#15803d' },
  { v: 'maybe', label: 'Maybe', color: '#b45309' },
  { v: 'no', label: 'No', color: '#dc2626' },
]
function relColor(v) { for (var i = 0; i < CONTACT_REL.length; i++) if (CONTACT_REL[i].v === v) return CONTACT_REL[i].color; return 'var(--faint)' }

// The booking workflow, by phase, mirroring the desktop project view. Each phase holds its standard
// email steps (the "email cards"); the Booking phase also carries the document actions (placeholders
// on the phone for now). Follow-up / check-in emails that exist in the DB are added dynamically.
// A human title for a dynamic email kind (followup-1 -> "Follow-up #1", etc.).

// Re-render whatever is currently on screen: the open project detail, else the active tab. Used after
// a write so the change shows immediately without kicking the user out of a detail view.
function refreshView() {
  if (DETAIL_ID && SNAP && SNAP.projects.some(function (p) { return p.id === DETAIL_ID })) renderDetail(DETAIL_ID)
  else render()
}

// ---------- helpers ----------
function $(sel) { return document.querySelector(sel) }
function el(html) { var t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] }) }

function money(n) {
  if (n == null || n === '' || isNaN(Number(n))) return ''
  var v = Math.round(Number(n))
  return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US')
}
// To the cent, for figures that come from QuickBooks (the Mac's money2).
function money2(n) {
  var v = Number(n) || 0
  return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
// The Mac's two method lists (src/api.ts), kept identical so a payment logged on either reads the same.
var PAYMENT_METHODS = ['QuickBooks invoice', 'HoneyBook', 'Cash', 'Check', 'PayPal', 'Venmo', 'CashApp', 'Zelle', 'Bank transfer (ACH)']
var TIP_METHODS = ['Cash', 'Venmo', 'CashApp', 'Zelle']
// "12+15" or "150x2" -> "27" / "300". A port of src/calc.ts evalNumberFormula, used for miles and tips.
function evalNumberFormula(input) {
  var raw = String(input == null ? '' : input).trim()
  if (!raw) return ''
  var s = raw.replace(/[xX×]/g, '*').replace(/÷/g, '/').replace(/\s+/g, '')
  if (!/^[\d+\-*/().]+$/.test(s)) return raw
  var i = 0
  function eat(c) { if (s[i] === c) { i++; return true } return false }
  function expr() { var v = term(); for (;;) { if (eat('+')) v += term(); else if (eat('-')) v -= term(); else break } return v }
  function term() { var v = factor(); for (;;) { if (eat('*')) v *= factor(); else if (eat('/')) v /= factor(); else break } return v }
  function factor() {
    if (eat('+')) return factor()
    if (eat('-')) return -factor()
    if (eat('(')) { var v = expr(); if (!eat(')')) throw new Error('unbalanced'); return v }
    var n = ''
    while (i < s.length && /[\d.]/.test(s[i])) n += s[i++]
    if (n === '' || n === '.') throw new Error('expected number')
    return Number(n)
  }
  try { var v = expr(); if (i !== s.length || !isFinite(v)) return raw; return String(Math.round(v * 100) / 100) } catch (e) { return raw }
}
function parseDate(s) {
  if (!s || !/^\d{4}-\d{2}-\d{2}/.test(s)) return null
  var p = s.slice(0, 10).split('-')
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]))
}
function fmtDate(s) {
  var d = parseDate(s); if (!d) return s || ''
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
}
function fmtShort(s) {
  var d = parseDate(s); if (!d) return s || ''
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
// "18:00" -> "6:00 PM". Times arrive from a <input type=time> on the booking form (always HH:MM)
// or from Michael typing free text, so anything that is not HH:MM is passed straight through
// rather than mangled. Never guess at a time; showing "5ish" verbatim beats showing nothing.
function fmtTime(v) {
  var t = String(v == null ? '' : v).trim()
  var m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(t)
  if (!m) return t
  var h = Number(m[1]), mi = m[2]
  if (h > 23) return t
  var ap = h < 12 ? 'AM' : 'PM'
  var h12 = h % 12 === 0 ? 12 : h % 12
  return h12 + ':' + mi + ' ' + ap
}

// How far off the event is, in his words rather than a date maths answer. Drives the line under the
// date on the day-of card: on the morning of a gig it should say "Today", not "0 days".
function countdownText(dateStr) {
  var d = parseDate(dateStr); if (!d) return ''
  var t = new Date(); t.setHours(0, 0, 0, 0)
  d.setHours(0, 0, 0, 0)
  var days = Math.round((d - t) / 86400000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  if (days === -1) return 'Yesterday'
  if (days > 0) return 'in ' + days + ' days'
  return Math.abs(days) + ' days ago'
}

// ---- the venue address, and getting it into a map ----
//
// Michael, 2026-09-21: "I need to be able to see the event address. The venue address when I get in
// my car so I can stick it in the map."
//
// `maps://` (and `comgooglemaps://`) are custom schemes, which is the whole reason they work here.
// A WKWebView will not load a scheme it does not know, so Capacitor's navigation delegate hands it
// to the OS instead. That is the exact path the tel: / sms: / mailto: links in this app already
// take, so it is proven in this build rather than hoped for. An https://maps.apple.com link would
// be a universal link, and universal links do NOT open the target app when they are followed from
// inside a WKWebView, so it would load a web map in the app window. Wrong tool.
//
// `daddr` (destination address) rather than `q` (search): he is getting in the car. He wants the
// route, not a pin he then has to tap again.
function mapsLinks(addr) {
  var a = String(addr || '').replace(/\s+/g, ' ').trim()
  if (!a) return null
  var e = encodeURIComponent(a)
  return {
    address: a,
    apple: 'maps://?daddr=' + e + '&dirflg=d',
    // Google Maps' own scheme when the app is installed; the https form is the fallback that
    // always resolves, so this link is never a dead tap.
    google: 'comgooglemaps://?daddr=' + e + '&directionsmode=driving',
    googleWeb: 'https://www.google.com/maps/dir/?api=1&destination=' + e + '&travelmode=driving',
  }
}

// Copy to the clipboard, with the older execCommand path kept because navigator.clipboard is
// undefined on a page served over plain http (the localhost dev build) and would otherwise throw.
function copyText(text, okMsg) {
  var done = function () { toast(okMsg || 'Copied') }
  var fail = function () { toast('Could not copy', 'err') }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(fail)
    return
  }
  try {
    var ta = document.createElement('textarea')
    ta.value = text
    ta.style.cssText = 'position:fixed;left:-9999px'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
    done()
  } catch (_) { fail() }
}

function todayStr() {
  var n = new Date()
  return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0')
}
function dueState(dateStr, dueTime) {
  if (!dateStr) return null
  var t = todayStr()
  if (dateStr < t) return 'overdue'
  if (dateStr === t) {
    // Due today: overdue once a set time has passed; otherwise still "due today".
    if (dueTime) {
      var parts = String(dueTime).split(':')
      var h = Number(parts[0]), m = Number(parts[1])
      if (isFinite(h) && isFinite(m)) {
        var n = new Date()
        if (n.getHours() > h || (n.getHours() === h && n.getMinutes() >= m)) return 'overdue'
      }
    }
    return 'due'
  }
  return null
}
function timeAgo(iso) {
  if (!iso) return ''
  var s = Math.floor((Date.now() - Date.parse(iso)) / 1000)
  if (isNaN(s)) return ''
  if (s < 60) return 'just now'
  if (s < 3600) return Math.floor(s / 60) + 'm ago'
  if (s < 86400) return Math.floor(s / 3600) + 'h ago'
  return Math.floor(s / 86400) + 'd ago'
}

// A brief bottom toast for write success / failure feedback (native-feeling, non-blocking).
var toastTimer = null
function toast(msg, kind) {
  var t = $('#toast')
  if (!t) { t = el('<div id="toast"></div>'); document.body.appendChild(t) }
  t.textContent = msg
  t.className = 'show' + (kind === 'err' ? ' err' : '')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(function () { t.className = '' }, kind === 'err' ? 3600 : 2200)
}
// A toast carrying one action, used for Undo. Deliberately chosen over a confirm dialog for
// dismissing an alert: a confirm interrupts every deliberate dismissal to guard against the rare
// accidental one, while an undo does nothing until you actually need it. Stays up longer than a
// plain toast, because it is only useful if it is still there when you notice the mistake.
function toastUndo(msg, label, onAction) {
  var t = $('#toast')
  if (!t) { t = el('<div id="toast"></div>'); document.body.appendChild(t) }
  t.textContent = msg
  var b = el('<button class="toast-act">' + esc(label) + '</button>')
  var used = false
  b.addEventListener('click', function () {
    if (used) return
    used = true
    t.className = ''
    clearTimeout(toastTimer)
    onAction()
  })
  t.appendChild(b)
  t.className = 'show'
  clearTimeout(toastTimer)
  toastTimer = setTimeout(function () { t.className = '' }, 6000)
}

// Swipe-to-reveal. Wraps a row so dragging it left uncovers one action button underneath.
//
// Chosen over an always-visible X because the alert card itself is tappable (it opens the project),
// so a delete control sitting next to it is a fat-finger waiting to happen. A swipe cannot fire by
// accident while scrolling, and swipe-then-tap is already two deliberate moves.
var OPEN_SWIPE = null // only one row is ever open; opening another closes it
function swipeRow(inner, actionLabel, onAction) {
  var REVEAL = -104
  var wrap = el('<div class="swipe"></div>')
  var act = el('<div class="swipe-act"><button type="button" class="swipe-btn">' + esc(actionLabel) + '</button></div>')
  var fg = el('<div class="swipe-fg"></div>')
  fg.appendChild(inner)
  wrap.appendChild(act)
  wrap.appendChild(fg)

  var startX = 0, startY = 0, dx = 0, open = false, axis = null
  function place(v, animate) {
    fg.style.transition = animate ? 'transform .18s ease' : ''
    fg.style.transform = 'translateX(' + v + 'px)'
  }
  function close(animate) { open = false; place(0, animate !== false); if (OPEN_SWIPE === api) OPEN_SWIPE = null }
  var api = { close: close }

  fg.addEventListener('touchstart', function (e) {
    var t = e.touches[0]
    startX = t.clientX; startY = t.clientY; dx = open ? REVEAL : 0; axis = null
    fg.style.transition = ''
  }, { passive: true })

  fg.addEventListener('touchmove', function (e) {
    var t = e.touches[0]
    var mx = t.clientX - startX, my = t.clientY - startY
    // Decide once whether this is a horizontal or a vertical gesture, then stick with it. Without
    // the lock, a slightly-diagonal scroll drags the row sideways and the page fights the finger.
    if (axis === null) {
      if (Math.abs(mx) < 6 && Math.abs(my) < 6) return
      axis = Math.abs(mx) > Math.abs(my) ? 'x' : 'y'
    }
    if (axis !== 'x') return
    e.preventDefault() // stop the page scrolling while a row is being dragged
    dx = Math.max(REVEAL - 28, Math.min(0, (open ? REVEAL : 0) + mx)) // clamp, with a little rubber band
    place(dx, false)
  }, { passive: false })

  fg.addEventListener('touchend', function () {
    if (axis !== 'x') return
    if (dx < REVEAL / 2) {
      if (OPEN_SWIPE && OPEN_SWIPE !== api) OPEN_SWIPE.close()
      open = true; OPEN_SWIPE = api; place(REVEAL, true)
    } else close()
  })

  // While a row is open, a tap on it closes it instead of triggering whatever the row normally does.
  // Capture phase, so it lands before the card's own click handler opens the project.
  fg.addEventListener('click', function (e) {
    if (!open) return
    e.preventDefault()
    e.stopPropagation()
    close()
  }, true)

  act.querySelector('.swipe-btn').addEventListener('click', function (e) {
    e.stopPropagation()
    close(false)
    onAction()
  })
  return wrap
}

// Run a write, showing a failure toast if it throws. `after` runs only on success.
function doWrite(promise, okMsg, after) {
  return promise.then(function (r) {
    if (okMsg) toast(okMsg)
    reloadWidgets() // the home-screen widgets show tasks and gigs, so a change should reach them
    if (after) after(r)
    return r
  }).catch(function (e) {
    toast((e && e.message) ? e.message : 'Could not save. Try again.', 'err')
    throw e
  })
}
// Today as YYYY-MM-DD, and the stage label for a given stage id.
function stageName(id) { return (STAGE[id] || {}).name || '' }

// The event-detail fields, in the desktop's order. Settings can relabel, hide or delete any of them
// (SNAP.eventFieldLabels / eventFieldHidden / eventFieldDeleted), which allFieldRows applies.
var EVENT_FIELDS = [
  ['eventSummary', 'Description'], ['eventDate', 'Event date'], ['arrivalTime', 'Arrival time'],
  ['eventStartTime', 'Event start'],
  ['showStartTime', 'Show start'], ['totalFee', 'Quote'], ['numberOfGuests', 'Guest Count'],
  ['ageOfGuests', 'Guest ages'], ['eventLocation', 'Location'], ['venueType', 'Venue type'],
  ['indoorsOrOutdoors', 'Indoors / Outdoors'], ['performanceStyle', 'Performance'],
  ['av', 'AV'], ['vips', 'VIPs'], ['bookingSource', 'Booking source'],
]

function stageInfo(id) { return STAGE[id] || { name: '', umbrella: '', color: 'var(--brass)' } }

// ---------- views ----------
// Count projects in one bucket (drives the drawer nav counts).
function bucketCount(b) {
  var n = 0
  ;(SNAP && SNAP.projects ? SNAP.projects : []).forEach(function (p) { if (p.bucket === b) n++ })
  return n
}

// The shared body of every project-list page. `bucket` picks the pool; `emptyText` is what to say
// when there is nothing in it (each page deserves its own sentence, not a generic "no projects").
// Only the active pipeline gets the stage-grouped board and the New-project button; the history
// pages get the flat, date-sorted record list.
function renderProjectList(bucket, opts) {
  DETAIL_ID = null
  removeProjectTabs() // the project tab bar belongs to a project, not to a list of them
  var o = opts || {}
  var v = $('#view')
  v.innerHTML = ''
  var pt = $('#pagetitle'); if (pt) pt.textContent = PAGE_TITLES[pageForBucket(bucket)] || 'Pipeline'

  if (o.note) v.appendChild(el('<div class="pagenote">' + esc(o.note) + '</div>'))

  var pool = SNAP.projects.filter(function (p) { return p.bucket === bucket })
  v.appendChild(el('<input class="search" id="q" placeholder="' + esc(o.searchLabel || 'Search projects…') + '" />'))
  // Completed and Archived get the Mac Records page's filters: event type and year on both, month on
  // Completed, reason on Archived, a running count, and the event-date order toggle.
  var rf = (bucket === 'completed' || bucket === 'archived') ? recordFilters(bucket) : null
  var fbar = null, countEl = el('<div class="rec-count"></div>')
  if (rf) {
    fbar = el('<div class="rec-filters"></div>')
    var addSel = function (key, allLabel, values, labelOf) {
      if (!values.length) return
      var sel = el('<select class="rec-sel"></select>')
      sel.appendChild(el('<option value="">' + esc(allLabel) + '</option>'))
      values.forEach(function (x) { var op = el('<option></option>'); op.value = x; op.textContent = labelOf ? labelOf(x) : x; sel.appendChild(op) })
      sel.value = rf[key] || ''
      sel.classList.toggle('on', !!rf[key])
      sel.addEventListener('change', function () { rf[key] = sel.value; sel.classList.toggle('on', !!sel.value); draw($('#q').value) })
      fbar.appendChild(sel)
    }
    var uniq = function (fn) { var m = {}; pool.forEach(function (p) { var k = fn(p); if (k) m[k] = 1 }); return Object.keys(m).sort() }
    addSel('type', 'All types', uniq(function (p) { return p.eventType || '' }))
    addSel('year', 'All years', uniq(function (p) { return (p.eventDate || '').slice(0, 4) }).filter(function (y) { return /^\d{4}$/.test(y) }).reverse())
    if (bucket === 'completed') addSel('month', 'All months', ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'], function (m) { return MONTHS_SHORT[Number(m) - 1] })
    if (bucket === 'archived') addSel('reason', 'All reasons', uniq(function (p) { return p.archiveReason || 'Uncategorized' }))
    var sortBtn = el('<button class="rec-sort"></button>')
    var paintSort = function () { sortBtn.textContent = rf.asc ? 'Soonest first' : 'Latest first' }
    paintSort()
    sortBtn.addEventListener('click', function () { rf.asc = !rf.asc; paintSort(); draw($('#q').value) })
    fbar.appendChild(sortBtn)
    v.appendChild(fbar)
  }
  if (rf || bucket === 'deleted') v.appendChild(countEl)
  var list = el('<div id="plist"></div>')
  v.appendChild(list)

  function draw(filter) {
    var f = (filter || '').toLowerCase().trim()
    var items = pool.filter(function (p) {
      if (rf) {
        if (rf.type && p.eventType !== rf.type) return false
        if (rf.year && (p.eventDate || '').slice(0, 4) !== rf.year) return false
        if (rf.month && (p.eventDate || '').slice(5, 7) !== rf.month) return false
        if (rf.reason && (p.archiveReason || 'Uncategorized') !== rf.reason) return false
      }
      if (!f) return true
      return (p.client + ' ' + (p.eventLocation || '') + ' ' + (p.eventType || '') + ' ' + (p.contactNames || '')).toLowerCase().indexOf(f) >= 0
    })
    var noun = bucket === 'deleted' ? 'in trash' : bucket
    countEl.textContent = items.length !== pool.length ? items.length + ' of ' + pool.length + ' ' + noun : pool.length + ' ' + noun
    list.innerHTML = ''
    if (!items.length) {
      list.appendChild(el('<div class="empty">' + esc(f || (rf && (rf.type || rf.year || rf.month || rf.reason)) ? 'No projects match.' : o.emptyText || 'Nothing here.') + '</div>'))
      return
    }
    if (bucket === 'active') drawActive(list, items)
    else drawRecords(list, items, bucket, rf ? rf.asc : false)
  }
  draw('')
  $('#q').addEventListener('input', function (e) { draw(e.target.value) })
}
// Per-page filter state for this session. The Mac's defaults: Archived oldest event first, Completed
// newest first.
var REC_FILTERS = {}
function recordFilters(bucket) {
  return REC_FILTERS[bucket] = REC_FILTERS[bucket] || { type: '', year: '', month: '', reason: '', asc: bucket !== 'completed' }
}
var MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function renderPipeline() {
  renderProjectList('active', { searchLabel: 'Search active projects…', emptyText: 'No active projects.' })
  ensureFab() // the "New project" button belongs to the pipeline page only
}

function renderCompleted() {
  renderProjectList('completed', { searchLabel: 'Search completed projects…', emptyText: 'No completed projects yet.' })
}

function renderArchived() {
  renderProjectList('archived', {
    searchLabel: 'Search archived projects…',
    emptyText: 'Nothing archived.',
  })
}

function renderDeleted() {
  renderProjectList('deleted', {
    searchLabel: 'Search deleted projects…',
    emptyText: 'Nothing deleted. (Deleting a project sends it here, not into the void.)',
    note: 'Deleted projects stay here for 30 days and can be restored with everything attached. After that they are purged for good.',
  })
}

// A phone-palette color per umbrella (the structure's own colors are desktop CSS vars, unavailable
// here). Keyed by role, then by position, so the sections stay visually distinct in the app palette.
function umbrellaColor(u, i) {
  var byRole = { first: '#0e7490', booked: '#15803d', postshow: '#7c3aed' }
  if (u && u.role && byRole[u.role]) return byRole[u.role]
  var ramp = ['#0e7490', '#b45309', '#15803d', '#7c3aed', '#2563eb']
  return ramp[i % ramp.length]
}

// Active projects: one collapsible, color-coded section per pipeline umbrella, in structure order,
// and inside each one a ROW PER STAGE, in the stage order the structure defines.
//
// Michael, 2026-10-23: the board used to list every project in a category straight down the page
// with the stages mixed together, so "who is at Follow Up Sent" meant reading every pill. Now each
// stage is its own labelled row and its projects scroll sideways, the phone version of the desktop
// columns. Inside a stage, soonest event first, undated last (same rule as the desktop's
// byEventDateAsc). Empty stages are left out: on a phone an empty row is only scrolling.
function drawActive(list, items) {
  var umbrellas = SNAP.structure.umbrellas || []
  var groups = {} // umbrella label -> { stageId -> [projects] }
  var seenStages = {} // umbrella label -> stage ids in first-seen order (for stages not in the structure)
  items.forEach(function (p) {
    var si = stageInfo(p.stageId)
    var key = si.umbrella || 'Other'
    var g = groups[key] = groups[key] || {}
    var sid = p.stageId || ''
    if (!g[sid]) { g[sid] = []; (seenStages[key] = seenStages[key] || []).push(sid) }
    g[sid].push(p)
  })
  var order = umbrellas.map(function (u) { return u.label })
  Object.keys(groups).forEach(function (k) { if (order.indexOf(k) < 0) order.push(k) })
  order.forEach(function (label, i) {
    var g = groups[label]; if (!g) return
    var u = umbrellas.find(function (x) { return x.label === label })
    var stageOrder = ((u && u.stages) || []).map(function (st) { return st.id })
    ;(seenStages[label] || []).forEach(function (sid) { if (stageOrder.indexOf(sid) < 0) stageOrder.push(sid) })
    var rows = stageOrder.filter(function (sid) { return g[sid] && g[sid].length }).map(function (sid) {
      return { name: stageName(sid) || 'No stage', projects: g[sid].slice().sort(byEventDateAsc) }
    })
    list.appendChild(stageSection(label, umbrellaColor(u, i), rows))
  })
}
function byEventDateAsc(a, b) {
  return (a.eventDate || '9999-99-99').localeCompare(b.eventDate || '9999-99-99')
}

// A collapsible pipeline section: a colored header (tinted by the section color) + count + chevron,
// with one row per stage below. Collapse persists per session.
function stageSection(label, color, rows) {
  var total = rows.reduce(function (n, r) { return n + r.projects.length }, 0)
  var wrap = el('<div class="psection"></div>')
  var head = el('<button class="psection-head"><span class="psection-bar"></span><span class="psection-name">' + esc(label) + '</span><span class="psection-count">' + total + '</span><span class="psection-chev"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></span></button>')
  head.style.setProperty('--sec', color)
  var body = el('<div class="psection-body"></div>')
  rows.forEach(function (r) { body.appendChild(stageRow(r.name, color, r.projects)) })
  function apply() {
    var col = !!COLLAPSED[label]
    body.style.display = col ? 'none' : ''
    head.querySelector('.psection-chev').classList.toggle('col', col)
  }
  apply()
  head.addEventListener('click', function () { COLLAPSED[label] = !COLLAPSED[label]; apply() })
  wrap.appendChild(head)
  wrap.appendChild(body)
  return wrap
}

// One stage: its name and count, then its projects in a sideways-scrolling strip. A single project
// takes the full width; with more than one, each card is a little narrower than the screen so the
// next one peeks in from the right, which is what tells you the row scrolls.
function stageRow(name, color, projects) {
  var row = el('<div class="prow' + (projects.length === 1 ? ' prow-one' : '') + '"></div>')
  row.style.setProperty('--sec', color)
  row.appendChild(el('<div class="prow-head"><span class="prow-name">' + esc(name) + '</span><span class="prow-count">' + projects.length + '</span></div>'))
  var strip = el('<div class="prow-strip"></div>')
  projects.forEach(function (p) { strip.appendChild(projectCard(p, color)) })
  row.appendChild(strip)
  return row
}

// Completed / archived records: newest first by event date (fallback completed date), grouped by year.
function drawRecords(list, items, bucket, asc) {
  // Deleted is ordered by WHEN IT WAS DELETED, newest first, and not grouped by year: what matters
  // on that page is how much of the 30-day window is left, not when the event was. Each row carries
  // its own Restore, like the Mac's trash, so bringing one back is one tap.
  if (bucket === 'deleted') {
    items.slice().sort(function (a, b) {
      var ad = a.deletedAt || '', bd = b.deletedAt || ''
      return bd < ad ? -1 : bd > ad ? 1 : 0
    }).forEach(function (p) {
      var row = el('<div class="del-row"></div>')
      var card = projectCard(p)
      var left = deletedDaysLeft(p)
      if (left != null && left <= 7) card.classList.add('del-urgent')
      row.appendChild(card)
      var rb = el('<button class="del-restore" aria-label="Restore">Restore</button>')
      rb.addEventListener('click', function () { doRestore(p) })
      row.appendChild(rb)
      list.appendChild(row)
    })
    return
  }
  // Undated last in either order, like the Mac's byEventDateAsc.
  var sorted = items.slice().sort(function (a, b) {
    var ad = a.eventDate || a.completedDate || ''
    var bd = b.eventDate || b.completedDate || ''
    if (!ad || !bd) return !ad && !bd ? 0 : !ad ? 1 : -1
    return asc ? (ad < bd ? -1 : ad > bd ? 1 : 0) : (bd < ad ? -1 : bd > ad ? 1 : 0)
  })
  var groups = {}, order = []
  sorted.forEach(function (p) {
    var d = p.eventDate || p.completedDate || ''
    var yr = /^\d{4}/.test(d) ? d.slice(0, 4) : 'Undated'
    if (!groups[yr]) { groups[yr] = []; order.push(yr) }
    groups[yr].push(p)
  })
  order.forEach(function (yr) {
    list.appendChild(sectionLabel(yr + '  ·  ' + groups[yr].length))
    groups[yr].forEach(function (p) { list.appendChild(projectCard(p)) })
  })
}

// The floating "New project" button (pipeline tab only). Idempotent; removed when leaving the tab.
function ensureFab() {
  if ($('#fab')) return
  var fab = el('<button id="fab" aria-label="New project"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg></button>')
  fab.addEventListener('click', openNewProject)
  document.body.appendChild(fab)
}
function removeFab() { var f = $('#fab'); if (f) f.remove() }

// New-project sheet. Only the name is required; a new project is always active and defaults to Inquiry
// (createProject clamps any Booked/Post Show pick down to Inquiry, since it has no payment yet).
function openNewProject() {
  var stageOpts = ''
  ;(SNAP.structure.umbrellas || []).forEach(function (u) {
    stageOpts += '<optgroup label="' + esc(u.label) + '">'
    ;(u.stages || []).forEach(function (st) {
      stageOpts += '<option value="' + esc(st.id) + '"' + (st.id === 'inquiry' ? ' selected' : '') + '>' + esc(st.name) + '</option>'
    })
    stageOpts += '</optgroup>'
  })
  var typeOpts = ['', 'Wedding', 'Corporate', 'Private Event', 'Bachelor(ette) Party', 'Other']
    .map(function (t) { return '<option value="' + esc(t) + '">' + esc(t || 'Event type…') + '</option>' }).join('')
  // Where the lead came from, asked at CREATE time, which on the phone is usually seconds after the
  // gig-site notification arrived and is the only moment he actually knows the answer.
  var srcOpts = [''].concat(LEAD_SOURCES)
    .map(function (t) { return '<option value="' + esc(t) + '">' + esc(t || 'Where did they find you?') + '</option>' }).join('')
  var sheet = el(
    '<div class="sheet"><div class="sheet-card">' +
      '<div class="sheet-title">New project</div>' +
      '<input class="field-input" id="np-name" placeholder="Project / client name  *" />' +
      '<div class="addrow" style="margin-top:8px"><select class="field-input" id="np-type">' + typeOpts + '</select>' +
      '<select class="stagesel" id="np-stage">' + stageOpts + '</select></div>' +
      '<div class="addrow"><input class="field-input" id="np-date" type="date" /><input class="field-input" id="np-fee" inputmode="decimal" placeholder="Fee" /></div>' +
      '<input class="field-input" id="np-loc" placeholder="Location" style="margin-top:8px" />' +
      '<select class="field-input" id="np-src" style="margin-top:8px">' + srcOpts + '</select>' +
      '<div class="fld-l" style="margin:14px 0 6px">Contacts</div>' +
      '<div id="np-contacts"></div>' +
      '<button class="btn-ghost" id="np-addcontact" style="width:100%">+ Add contact</button>' +
      '<textarea class="field-input" id="np-notes" rows="2" placeholder="Notes" style="margin-top:12px"></textarea>' +
      '<div class="addrow" style="margin-top:14px"><button class="btn-ghost" id="np-cancel">Cancel</button><button class="btn-gold" id="np-save">Create project</button></div>' +
    '</div></div>'
  )
  var close = function () { sheet.remove() }
  sheet.querySelector('#np-cancel').addEventListener('click', close)
  sheet.addEventListener('click', function (e) { if (e.target === sheet) close() })

  // Contacts staged for this project, in the order they were added. The first is the primary.
  //
  // This replaced three free-text boxes (name / email / phone) on 2026-08-06. Typing a person in by
  // hand meant retyping details the CRM already had, only ever produced ONE contact, and made a
  // near-duplicate record whenever the spelling drifted. Now it is the same picker the project view
  // uses, so a project starts life with real linked contacts. The project does not exist yet, so
  // these are held here and linked once it does.
  var staged = []

  function drawStaged() {
    var host = sheet.querySelector('#np-contacts')
    host.innerHTML = ''
    staged.forEach(function (s, i) {
      var sub = [s.email, s.phone].filter(Boolean).join('  ·  ')
      var row = el(
        '<div class="card" style="margin-bottom:6px;cursor:default">' +
          '<div class="cc-head"><div class="name" style="font-size:14px;flex:1;min-width:0">' + esc(s.name) +
          (i === 0 && staged.length > 1 ? '<span class="cc-primary">Primary</span>' : '') + '</div>' +
          '<button class="cc-x" aria-label="Remove"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button></div>' +
          (sub ? '<div class="meta">' + esc(sub) + '</div>' : '') +
        '</div>'
      )
      row.querySelector('.cc-x').addEventListener('click', function () { staged.splice(i, 1); drawStaged() })
      host.appendChild(row)
    })
  }

  sheet.querySelector('#np-addcontact').addEventListener('click', function () {
    var exclude = {}
    staged.forEach(function (s) { if (s.contactId) exclude[s.contactId] = true })
    openContactPicker({
      title: 'Add contact',
      excludeIds: exclude,
      createHint: 'This creates a contact in the CRM and attaches it to the new project. Phone numbers are auto-formatted.',
      createLabel: 'Add to project',
      onChoose: function (chosen) {
        staged.push({
          contactId: chosen.contact ? chosen.contact.id : '',
          name: chosen.name,
          email: chosen.email,
          phone: chosen.phone,
        })
        drawStaged()
      },
    })
  })

  sheet.querySelector('#np-save').addEventListener('click', function () {
    var name = sheet.querySelector('#np-name').value.trim()
    if (!name) { toast('Enter a project name.', 'err'); return }
    // The first staged contact seeds the project's own contact fields (the primary), matching what
    // attachContactToProject does. Everyone else is a link only.
    var primary = staged[0] || { name: '', email: '', phone: '' }
    var input = {
      clientName: name,
      eventType: sheet.querySelector('#np-type').value,
      stageId: sheet.querySelector('#np-stage').value,
      eventDate: sheet.querySelector('#np-date').value,
      totalFee: sheet.querySelector('#np-fee').value,
      eventLocation: sheet.querySelector('#np-loc').value,
      bookingSource: sheet.querySelector('#np-src').value,
      contactNames: primary.name,
      contactEmails: primary.email,
      contactPhones: primary.phone,
      projectNotes: sheet.querySelector('#np-notes').value,
    }
    doWrite(createProject(input, SNAP.structure), 'Project created', function (proj) {
      SNAP.projects.push(proj)
      close()
      TAB = 'pipeline' // a new project is always active, so back out lands on the pipeline
      renderDetail(proj.id)
      // Build the real contact records + links AFTER the project exists. Deliberately not awaited and
      // deliberately not able to fail the create: the project is already saved and on screen, and a
      // join-table hiccup must not make a successful save look broken. Sequential so the link order
      // (and therefore the primary) matches what he staged.
      staged.reduce(function (chain, s) {
        return chain.then(function () {
          return linkOrCreateContact(proj.id, { contactId: s.contactId, name: s.name, email: s.email, phone: s.phone })
            .then(function (r) {
              if (!r || !r.ok) return
              noteContactLocally(r.contactId, s)
              noteLinkLocally(proj.id, r.contactId)
            })
        })
      }, Promise.resolve())
        .then(function () { return Promise.all([refreshContactsCache(), refreshLinksCache()]) })
        .then(function () { if (DETAIL_ID === proj.id) renderDetail(proj.id, true) })
        .catch(function (e) { console.error('[mobile] could not link the contacts:', e && e.message) })
    })
  })
  document.body.appendChild(sheet)
  setTimeout(function () { var e = sheet.querySelector('#np-name'); if (e) e.focus() }, 40)
}
function sectionLabel(text) { return el('<div class="section-label"><span class="dot"></span>' + esc(text) + '</div>') }
// Days left in a soft-deleted project's 30-day restore window. Null when it was never stamped
// (older deletes, before deleted_at existed), which the caller renders as a plain "Deleted".
var DELETED_TTL_DAYS = 30
function deletedDaysLeft(p) {
  var t = Date.parse(p.deletedAt || '')
  if (!isFinite(t)) return null
  var left = DELETED_TTL_DAYS - Math.floor((Date.now() - t) / 86400000)
  return left > 0 ? left : 0
}

// The status pill for a project card, by bucket: active -> its stage; completed -> "Done · <date>";
// archived -> the archive reason (or "Archived"); deleted -> how long is left to restore it.
function cardPill(p) {
  if (p.bucket === 'completed') {
    var d = p.completedDate || p.eventDate
    return { text: 'Done' + (d ? '  ·  ' + fmtShort(d) : ''), cls: 'done' }
  }
  if (p.bucket === 'archived') return { text: p.archiveReason || 'Archived', cls: 'arch' }
  if (p.bucket === 'deleted') {
    var left = deletedDaysLeft(p)
    if (left == null) return { text: 'Deleted', cls: 'del' }
    return { text: left === 0 ? 'Purges today' : left + (left === 1 ? ' day left' : ' days left'), cls: 'del' }
  }
  var si = stageInfo(p.stageId)
  return si.name ? { text: si.name, cls: '' } : null
}
function projectCard(p, accent) {
  var pill = cardPill(p)
  var pillHtml = ''
  if (pill) {
    // Tint an active-stage pill with the section accent; done/arch pills keep their semantic color.
    var pillStyle = (accent && !pill.cls) ? ' style="color:' + accent + ';border-color:color-mix(in oklab,' + accent + ' 45%, var(--line))"' : ''
    pillHtml = '<span class="pill ' + pill.cls + '"' + pillStyle + '>' + esc(pill.text) + '</span>'
  }
  // The date on its own is a fact he then has to do arithmetic on. "Oct 4 · in 13 days" is the
  // answer he was going to work out anyway, and on an active project it is the whole reason he is
  // looking at the board. Past events keep just the date: "42 days ago" on a finished gig is noise.
  var cd = p.bucket === 'active' ? countdownText(p.eventDate) : ''
  var soon = cd === 'Today' || cd === 'Tomorrow'
  var active = p.bucket === 'active'
  // An active card leads with the Mac's coloured event-type pill, so the type is not repeated here.
  var meta = [active ? '' : p.eventType, p.eventDate ? fmtDate(p.eventDate) : ''].filter(Boolean).join('  ·  ')

  // Two marks, both answering "does this one need me today". Tasks come from data already loaded;
  // unread mail comes from the five-minute inbox poll and is simply absent until it has run once.
  var due = (SNAP.tasks || []).filter(function (t) {
    if (t.projectId !== p.id || t.done) return false
    var st = dueState(t.dueDate, t.dueTime)
    return st === 'due' || st === 'overdue'
  }).length
  var unread = UNREAD_BY_PROJECT[p.id] || 0
  var marks = ''
  if (due) marks += '<span class="cmark cmark-task">' + due + ' due</span>'
  if (unread) marks += '<span class="cmark cmark-mail">' + unread + ' unread</span>'
  // The Mac card's two flags: a payment logged without a received date, and another live project
  // (or a Gigs calendar entry) on the same date.
  if (active) {
    if ((SNAP.payments || []).some(function (pm) { return pm.projectId === p.id && pm.pending })) marks += '<span class="cmark cmark-pay">Payment pending</span>'
    if (conflictsFor(p).length) marks += '<span class="cmark cmark-conflict">Date conflict</span>'
  }
  var loc = active ? (p.eventLocation || p.venueType || 'Location TBD') : ''

  var c = el(
    '<button class="card' + (accent ? ' accented' : '') + '">' +
      '<div class="row1"><span class="name">' + esc(p.client) + '</span><span class="fee">' + esc(money(p.totalFee)) + '</span></div>' +
      '<div class="meta">' + (active ? eventTypePill(p.eventType) + ' ' : '') + esc(meta) + (cd ? '<span class="cdown' + (soon ? ' soon' : '') + '">' + esc(cd) + '</span>' : '') + '</div>' +
      (loc ? '<div class="card-loc">' + esc(loc) + '</div>' : '') +
      (marks ? '<div class="cmarks">' + marks + '</div>' : '') +
      pillHtml +
    '</button>'
  )
  if (accent) c.style.setProperty('--acc', accent)
  c.addEventListener('click', function () { renderDetail(p.id) })
  return c
}

// One-line status for a completed/archived project (shown above its actions).
function statusText(p) {
  if (p.bucket === 'completed') return 'Completed' + (p.completedDate ? '  ·  ' + fmtDate(p.completedDate) : '')
  if (p.bucket === 'archived') return 'Archived' + (p.archiveReason ? '  ·  ' + p.archiveReason : '')
  if (p.bucket === 'deleted') {
    var left = deletedDaysLeft(p)
    if (left == null) return 'Deleted'
    return 'Deleted  ·  ' + (left === 0 ? 'purges today' : left + (left === 1 ? ' day' : ' days') + ' left to restore')
  }
  return ''
}

// The lifecycle action block at the top of a project detail. Active: Complete (gold) + Archive
// (ghost). Completed/archived: a status line + Return to pipeline. Both: a subdued Delete (confirm-
// gated, no undo).
function lifecycleActions(p) {
  var wrap = el('<div class="actions"></div>')
  if (p.bucket !== 'active') wrap.appendChild(el('<div class="statusline">' + esc(statusText(p)) + '</div>'))
  var row = el('<div class="actrow"></div>')
  if (p.bucket === 'active') {
    var comp = el('<button class="btn-gold" style="flex:1">Complete</button>')
    comp.addEventListener('click', function () { openCompleteSheet(p) })
    var arch = el('<button class="btn-ghost" style="flex:1">Archive</button>')
    arch.addEventListener('click', function () { openArchiveSheet(p) })
    row.appendChild(comp); row.appendChild(arch)
  } else {
    var rest = el('<button class="btn-gold" style="flex:1">Return to pipeline</button>')
    rest.addEventListener('click', function () { doRestore(p) })
    row.appendChild(rest)
  }
  wrap.appendChild(row)
  var del = el('<button class="btn-danger">Delete permanently</button>')
  del.addEventListener('click', function () { doDelete(p) })
  wrap.appendChild(del)
  return wrap
}

// Total RECEIVED (non-pending, dated) payments for a project, from the loaded ledger.
function receivedFor(projectId) {
  var sum = 0
  ;(SNAP.payments || []).forEach(function (pm) {
    if (pm.projectId === projectId && !pm.pending && String(pm.dateReceived || '').trim() !== '') {
      var a = Number(String(pm.amount).replace(/[^0-9.\-]/g, '')); if (isFinite(a)) sum += a
    }
  })
  return sum
}

// Complete sheet: requires event date + mileage + paid-in-full (the desktop's Complete gate). Shows the
// live paid/outstanding math and only enables Complete when all three are satisfied.
function openCompleteSheet(p) {
  var received = receivedFor(p.id)
  var feeNum = (typeof p.totalFee === 'number') ? p.totalFee : Number(String(p.totalFee == null ? '' : p.totalFee).replace(/[^0-9.]/g, ''))
  var hasFee = isFinite(feeNum) && String(p.totalFee == null ? '' : p.totalFee).trim() !== ''
  var remaining = hasFee ? Math.max(0, feeNum - received) : null
  var paidInFull = hasFee && remaining <= 0.005

  var sheet = el('<div class="sheet"><div class="sheet-card"></div></div>')
  var card = sheet.querySelector('.sheet-card')
  card.appendChild(el('<div class="sheet-title">Complete ' + esc(p.client) + '</div>'))
  card.appendChild(el('<div class="hint" style="margin:-4px 0 10px">Moves to Completed. Confirm the details for the books.</div>'))
  card.appendChild(el('<div class="k" style="margin-bottom:4px">Event date</div>'))
  var dateIn = document.createElement('input'); dateIn.className = 'field-input'; dateIn.type = 'date'; dateIn.value = p.eventDate || ''
  card.appendChild(dateIn)
  card.appendChild(el('<div class="k" style="margin:12px 0 4px">Round-trip mileage</div>'))
  var mileIn = document.createElement('input'); mileIn.className = 'field-input'; mileIn.inputMode = 'decimal'; mileIn.placeholder = 'Miles'; mileIn.value = (p.mileage == null ? '' : String(p.mileage))
  card.appendChild(mileIn)
  mileIn.addEventListener('blur', function () { mileIn.value = evalNumberFormula(mileIn.value); refresh() })
  var payLine = el('<div class="payline"></div>'); card.appendChild(payLine)
  // Log a payment right here, the way the Mac's Complete dialog embeds its payments editor.
  var paySlot = el('<div></div>')
  var payBtn = el('<button class="linkbtn">+ Log a payment</button>')
  payBtn.addEventListener('click', function () {
    if (paySlot.firstChild) { paySlot.innerHTML = ''; return }
    paySlot.appendChild(addPaymentForm(p, function () {
      received = receivedFor(p.id); remaining = hasFee ? Math.max(0, feeNum - received) : null; paidInFull = hasFee && remaining <= 0.005
      paySlot.innerHTML = ''; refresh()
    }))
  })
  card.appendChild(payBtn); card.appendChild(paySlot)
  card.appendChild(contactTagger(p))
  var bar = el('<div class="addrow" style="margin-top:14px"><button class="btn-ghost">Cancel</button><button class="btn-gold">Complete</button></div>')
  var confirmBtn = bar.children[1]
  var close = function () { sheet.remove() }
  bar.children[0].addEventListener('click', close)
  function refresh() {
    if (!hasFee) payLine.innerHTML = '<span style="color:var(--red)">Set a total fee on the project first, so payments can be reconciled to it.</span>'
    else if (!paidInFull) payLine.innerHTML = 'Paid ' + esc(money(received)) + ' of ' + esc(money(feeNum)) + '. <span style="color:var(--red)">' + esc(money(remaining)) + ' still outstanding.</span> Must be paid in full to complete.'
    else payLine.innerHTML = '<span style="color:var(--green)">Paid in full — ' + esc(money(received)) + ' received.</span>'
    var ok = paidInFull && dateIn.value.trim() !== '' && mileIn.value.trim() !== ''
    confirmBtn.disabled = !ok
    confirmBtn.style.opacity = ok ? '1' : '0.45'
  }
  dateIn.addEventListener('input', refresh)
  mileIn.addEventListener('input', refresh)
  refresh()
  confirmBtn.addEventListener('click', function () {
    if (confirmBtn.disabled) return
    doWrite(completeProject(p.id, { mileage: mileIn.value, eventDate: dateIn.value }, SNAP.payments || []), 'Completed', function (r) {
      p.bucket = 'completed'; p.stageId = ''; p.completedDate = r.completedDate
      if (r.mileage != null) p.mileage = r.mileage
      if (r.eventDate) p.eventDate = r.eventDate
      p.activityLog = r.activityLog
      close(); renderDetail(p.id)
    })
  })
  card.appendChild(bar)
  sheet.addEventListener('click', function (e) { if (e.target === sheet) close() })
  document.body.appendChild(sheet)
}

// Archive sheet: an optional reason (from the config list; "Other" reveals a free-text field). Archive
// is deliberately ungated (a lost/ghosted lead has no payment and must still be archivable).
function openArchiveSheet(p) {
  var sh = makeSheet('Archive ' + p.client, true)
  var editing = false
  var reasons = ((SNAP.config && SNAP.config.archiveReasons) || []).slice()
  var draw = function () {
    sh.body.innerHTML = ''
    sh.body.appendChild(el('<div class="hint" style="margin:0 0 10px">Removes it from the pipeline. You can return it anytime.</div>'))
    if (editing) {
      var list = reasons.slice()
      list.forEach(function (r, i) {
        var row = el('<div class="setf"><input class="field-input"><button class="setf-x" aria-label="Remove">×</button></div>')
        row.querySelector('input').value = r
        row.querySelector('input').addEventListener('input', function (e) { list[i] = e.target.value })
        row.querySelector('button').addEventListener('click', function () { reasons.splice(i, 1); draw() })
        sh.body.appendChild(row)
      })
      var add = el('<button class="linkbtn">+ Add reason</button>')
      add.addEventListener('click', function () { reasons = list.concat(['']); draw() })
      sh.body.appendChild(add)
      var bar = el('<div class="addrow" style="margin-top:12px"><button class="btn-ghost">Cancel</button><button class="btn-gold">Save list</button></div>')
      bar.children[0].addEventListener('click', function () { reasons = ((SNAP.config && SNAP.config.archiveReasons) || []).slice(); editing = false; draw() })
      bar.children[1].addEventListener('click', function () {
        var clean = list.map(function (x) { return String(x).trim() }).filter(Boolean)
        doWrite(saveConfigPatch({ archiveReasons: clean }), 'Reasons saved', function () { SNAP.config.archiveReasons = clean; reasons = clean.slice(); editing = false; draw() })
      })
      sh.body.appendChild(bar)
      return
    }
    var opts = reasons.indexOf('Other') >= 0 ? reasons : reasons.concat(['Other'])
    var head = el('<div class="fld-l" style="display:flex;justify-content:space-between">Reason<button class="linkbtn" style="padding:0;font-size:12px">Edit list</button></div>')
    head.querySelector('button').addEventListener('click', function () { editing = true; draw() })
    sh.body.appendChild(head)
    var sel = document.createElement('select'); sel.className = 'field-input'
    sel.appendChild(el('<option value="">Choose a reason…</option>'))
    opts.forEach(function (r) { var o = document.createElement('option'); o.value = r; o.textContent = r; sel.appendChild(o) })
    sh.body.appendChild(sel)
    var otherIn = document.createElement('input'); otherIn.className = 'field-input'; otherIn.placeholder = 'What happened?'; otherIn.style.marginTop = '8px'; otherIn.style.display = 'none'
    sh.body.appendChild(otherIn)
    sel.addEventListener('change', function () { otherIn.style.display = sel.value === 'Other' ? 'block' : 'none'; if (sel.value === 'Other') setTimeout(function () { otherIn.focus() }, 20) })
    sh.body.appendChild(contactTagger(p))
    var bar2 = el('<div class="addrow" style="margin-top:14px"><button class="btn-ghost">Cancel</button><button class="btn-gold">Archive</button></div>')
    bar2.children[0].addEventListener('click', sh.close)
    bar2.children[1].addEventListener('click', function () {
      var reason = sel.value === 'Other' ? (otherIn.value.trim() || 'Other') : sel.value
      if (!reason) { toast('Pick a reason first.', 'err'); return }
      doWrite(archiveProject(p.id, reason), 'Archived', function (r) {
        p.bucket = 'archived'; p.stageId = ''; p.archiveReason = r.archiveReason || reason || ''
        p.activityLog = r.activityLog
        sh.close(); renderDetail(p.id)
      })
    })
    sh.body.appendChild(bar2)
  }
  draw()
}

// Return an archived/completed project to the active pipeline (lands in Inquiry).
function doRestore(p) {
  doWrite(restoreProject(p.id), 'Back in the pipeline', function (r) {
    p.bucket = 'active'; p.stageId = r.stageId || 'inquiry'; p.archiveReason = ''; p.completedDate = ''
    p.deletedAt = '' // no stale delete stamp on a project that is live again
    p.activityLog = r.activityLog
    TAB = 'pipeline' // it lives on the active board now, so that is where backing out should land
    renderDetail(p.id)
  })
}

// Move to Deleted. Reversible for 30 days, matching the Mac.
//
// This used to permanently destroy the project AND its tasks, payments and mileage, with the wording
// "There is no undo." Same button, same label, on the Mac moved it to a restorable Deleted page.
// Fixed 2026-08-05. Nothing is destroyed now; tasks and payments stay attached and come back intact
// if it is restored, which is why they are no longer pruned from the local snapshot here.
function doDelete(p) {
  if (!confirm('Move "' + p.client + '" to Deleted?\n\nIt leaves the pipeline but nothing is lost. You can restore it from the Deleted page for 30 days.')) return
  doWrite(deleteProject(p.id), 'Moved to Deleted', function () {
    p.bucket = 'deleted'
    p.stageId = ''
    p.deletedAt = new Date().toISOString()
    // Kept in SNAP deliberately: it has to still be there for the Deleted page to list it. It used
    // to be spliced out here, back when the phone had nowhere to show deleted projects.
    DETAIL_ID = null
    navigate('deleted')
  })
}

// A project is now four TABS with a shared header, not one long scroll of sections.
//
// Michael, 2026-08-06: "this one page filled to so many buttons and sections". The page had grown a
// stage picker, a contacts block, tasks, details, booking and payments stacked end to end, and the
// stage dropdown alone took a whole section for a single value.
//
// The header block (name, stage, contacts, Actions) repeats on every tab so the things you always
// want are always there. It is NOT sticky by request: it scrolls away like any other content.
// Everything that mutates the project's shape (stage, contacts, lifecycle) lives behind Actions.
// Details FIRST, and the default. Michael, 2026-09-21: "I spend most of my time with the project
// details page." Booking used to open first because it was the tab with the buttons on it, but
// sending a booking form is something he does once per client and reading the event details is
// something he does every time he opens the project.
var PROJECT_TABS = [
  ['details', 'Details', '<path d="M4 5h16M4 12h16M4 19h10"/>'],
  ['booking', 'Booking', '<path d="M5 3h11l4 4v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M15 3v5h5"/><path d="M9 13h6M9 17h4"/>'],
  ['tasks', 'Tasks', '<path d="M9 11l3 3L20 6"/><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/>'],
  ['email', 'Email', '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>'],
  ['notes', 'Notes', '<path d="M4 4h16v12l-4 4H4z"/><path d="M20 16h-4v4"/>'],
]
var PTAB = 'details' // which tab of the project view is showing

function renderDetail(id, keepScroll) {
  if (SHOW_EDIT) flushShowEdit() // opening a project from a show mid-edit keeps the edit
  var p = SNAP.projects.find(function (x) { return x.id === id }); if (!p) return renderPipeline()
  noteLoc({ tab: TAB, detail: id, ptab: PTAB })
  DETAIL_ID = id
  removeFab()
  var v = $('#view'); v.innerHTML = ''
  var pt = $('#pagetitle'); if (pt) pt.textContent = p.client || 'Project'
  setHeaderChrome('project')
  // No back link in the page any more: the header's back button (2026-10-23) returns to whatever
  // was on screen before, which is what this link was approximating with "the page it lives on".

  v.appendChild(projectHeader(p))

  if (PTAB === 'details') v.appendChild(detailsTab(p))
  else if (PTAB === 'tasks') v.appendChild(tasksSection(p))
  else if (PTAB === 'email') v.appendChild(emailTab(p))
  else if (PTAB === 'notes') v.appendChild(notesTab(p))
  else v.appendChild(bookingTab(p))

  ensureProjectTabs(p)
  if (!keepScroll) window.scrollTo(0, 0)
}

// The block that repeats at the top of every tab: who and what this project is, plus the one button
// that changes it. Deliberately plain content, so it scrolls out of the way.
function projectHeader(p) {
  var si = stageInfo(p.stageId)
  var head = el('<div class="phead"></div>')

  var top = el('<div class="phead-top"></div>')
  top.appendChild(el('<div class="phead-name">' + esc(p.client) + '</div>'))
  var act = el('<button class="phead-act" aria-label="Actions"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg></button>')
  act.addEventListener('click', function () { openActionsPanel(p) })
  top.appendChild(act)
  head.appendChild(top)

  var metaRow = el('<div class="phead-meta"></div>')
  var tp = el('<button class="etype-btn">' + eventTypePill(p.eventType) + '</button>')
  tp.addEventListener('click', function () { openEventTypeSheet(p) })
  metaRow.appendChild(tp)
  if (p.eventDate) metaRow.appendChild(el('<span>' + esc(fmtDate(p.eventDate)) + '</span>'))
  head.appendChild(metaRow)
  var conf = conflictsFor(p)
  if (conf.length) head.appendChild(el('<div class="conflict"><b>⚠ Potential date conflict</b><span>Same date as: ' + esc(conf.join('; ')) + '. Check for a double-booking.</span></div>'))
  ensureConflictMonth(p)

  // Stage is a label here, not a control. It used to be a full-width dropdown in its own section,
  // which spent a lot of screen on one word; changing it now lives in Actions.
  var chips = el('<div class="phead-chips"></div>')
  if (p.bucket === 'active') {
    if (si.name) chips.appendChild(el('<span class="pill" style="margin:0;color:' + si.color + ';border-color:color-mix(in oklab,' + si.color + ' 45%, var(--line))">' + esc(si.name) + '</span>'))
  } else {
    chips.appendChild(el('<span class="pill ' + (p.bucket === 'completed' ? 'done' : p.bucket === 'archived' ? 'arch' : 'del') + '" style="margin:0">' + esc(statusText(p)) + '</span>'))
  }
  if (p.totalFee != null && p.totalFee !== '') chips.appendChild(el('<span class="phead-fee">' + esc(money(p.totalFee)) + '</span>'))
  if (chips.children.length) head.appendChild(chips)

  // Contacts: shown, not managed. Call / Text / Email stay one tap away because that is the whole
  // point of having the CRM on a phone; add and remove moved to Actions.
  var linked = projectContactCards(p)
  if (linked.length) {
    var cwrap = el('<div class="phead-contacts"></div>')
    linked.forEach(function (row) {
      var line = el('<div class="phead-c"></div>')
      var cc = row.contact
      var nm = el('<button class="phead-cn">' + (cc ? '<span class="reldot" style="background:' + relColor(cc.relationship) + ';margin-right:7px"></span>' : '') + esc(row.name) +
        (cc && cc.type ? '<span class="ctype">' + esc(String(cc.type).toLowerCase()) + '</span>' : '') +
        (row.primary && linked.length > 1 ? '<span class="cc-primary">Primary</span>' : '') + '</button>')
      if (cc) nm.addEventListener('click', function () { openContactSheet(cc) })
      line.appendChild(nm)
      var sub = [row.emails[0], row.phones[0]].filter(Boolean).join('  ·  ')
      if (sub) line.appendChild(el('<div class="phead-cs">' + esc(sub) + '</div>'))
      var actions = el('<div class="contact" style="margin-top:6px"></div>')
      if (row.phones[0]) actions.appendChild(el('<a href="tel:' + esc(row.phones[0]) + '">Call</a>'))
      if (row.phones[0]) actions.appendChild(el('<a href="sms:' + esc(row.phones[0]) + '">Text</a>'))
      if (row.emails[0]) actions.appendChild(el('<a href="mailto:' + esc(row.emails[0]) + '">Email</a>'))
      if (actions.children.length) line.appendChild(actions)
      cwrap.appendChild(line)
    })
    head.appendChild(cwrap)
  } else {
    head.appendChild(el('<div class="phead-nc">No contact on this project. Add one from Actions.</div>'))
  }
  return head
}

// The contacts on a project. The LINKS are the truth, in link order, and the first one is the
// primary: that is who the contract and invoice get addressed to. Every card is removable, primary
// included; removing the primary promotes whoever is next.
//
// ⚠️ This used to decide "primary" by comparing each linked contact's NAME to the project's
// contact_names text, and to invent an extra, undeletable card whenever nothing matched. On Conner
// Soules the link said "Conner Soules" and the text said "Conner Soules (groom)", so the phone drew
// TWO contacts where the database has one, and the phantom had no remove button because it had no
// join row to delete. Michael, 2026-08-06: "it seems like there was a mistake, and a second one got
// added... I can't delete the primary one". There was no second contact. The name test was the bug.
//
// Position, not name, decides the primary now, so nothing can be a primary that does not exist.
function projectContactCards(p) {
  var linked = contactsForProject(p)
  if (linked.length) {
    return linked.map(function (c, i) {
      return {
        id: c.id,
        contact: c,
        name: c.name || '(no name)',
        emails: (c.emails || []).filter(Boolean),
        phones: (c.phones || []).filter(Boolean),
        primary: i === 0,
      }
    })
  }
  // Only when there are NO links at all: an older project whose contact was typed in as plain text
  // and never linked. That text is genuinely the only thing we know, so it is worth showing, but it
  // is the fallback and never competes with a real record.
  var name = String(p.contactNames || '').trim()
  if (!name) return []
  return [{
    id: '',
    contact: null,
    name: name,
    emails: (p.contactEmails || '').split(/[,;]/).map(function (s) { return s.trim() }).filter(Boolean),
    phones: (p.contactPhones || '').split(/[,;]/).map(function (s) { return s.trim() }).filter(Boolean),
    primary: true,
    textOnly: true,
  }]
}

// ---- the four tabs ----

// Booking: the send flow plus the money. What is left once stage, contacts, details, tasks and notes
// each have a home of their own.
function bookingTab(p) {
  var wrap = el('<div></div>')
  wrap.appendChild(proposalSection(p))
  wrap.appendChild(calendarInviteCard(p))
  wrap.appendChild(bookingSection(p))
  wrap.appendChild(paymentsSection(p))
  return wrap
}
// The Mac's CalendarInviteCard, as a card on the Booking tab.
function calendarInviteCard(p) {
  var c = el('<div><div class="section-label">Calendar invite</div><div class="fin-card"><p class="fin-h" style="margin:0 0 10px">Send a Google Calendar invite to the client. It goes on your Work calendar and theirs.</p><button class="btn-ghost" style="width:100%">Schedule invite</button></div></div>')
  c.querySelector('button').addEventListener('click', function () { openCalendarInviteSheet(p) })
  return c
}

// This project's proposal: is it up, and has anyone read it.
//
// The whole list lives on the Proposals page; this is the one row that belongs to the client whose
// page he is already on, because "did they open it yet" is a question he asks about a SPECIFIC
// client, days after sending. Reuses the Proposals page's cache, so opening a project after
// visiting that page costs nothing.
//
// ⚠️ Preview only, same as everywhere else. openUrl is pre-flagged by the server; url is the clean
// one and is only ever copied.
function proposalSection(p) {
  // The Mac's ProposalCard (2026-10-23): one control showing the next thing to do, and a status line
  // the server moves on its own. Start, publish (which also leaves the email in Gmail as a DRAFT,
  // never sent), draft the email, reset the view count, take it down. All through phone-api, since
  // the proposals table is server-only. Building the page's CONTENT is still done with Claude, as on
  // the Mac.
  var wrap = el('<div></div>')
  wrap.appendChild(sectionLabel('Proposal'))
  var card = el('<div class="fin-card prop-card"><div class="fin-h">Checking…</div></div>')
  wrap.appendChild(card)
  var act = function (action, okMsg, confirmText) {
    if (confirmText && !confirm(confirmText)) return
    card.querySelectorAll('button').forEach(function (b) { b.disabled = true })
    doWrite(phoneApi(action, { projectId: p.id }), okMsg, function (r) {
      PROP_CACHE = null
      if (r && r.draftError) toast('Published. The email draft failed: ' + r.draftError, 'err')
      draw(r)
      if (r && (action === 'proposal-publish' || action === 'proposal-email' || action === 'proposal-retire')) addNoteLocalRefresh(p)
    }).catch(function () { load() })
  }
  var d2 = function (iso) { return iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '' }
  function draw(r) {
    card.innerHTML = ''
    if (!r || !r.exists) {
      card.appendChild(el('<p class="fin-h" style="margin:0 0 10px">No proposal page for this client yet. Starting one seeds the reviews, photos and logo wall for this event type; the packages and the write-up get filled in with Claude.</p>'))
      if (p.bucket === 'active') {
        var st = el('<button class="btn-gold" style="width:100%">Start a proposal</button>')
        st.addEventListener('click', function () { act('proposal-start', 'Proposal started') })
        card.appendChild(st)
      }
      return
    }
    var chips = el('<div class="phead-chips" style="margin-top:0"></div>')
    chips.appendChild(el('<span class="pill ' + propStateClass(r.state) + '" style="margin:0">' + esc(propStateLabel(r.state)) + '</span>'))
    chips.appendChild(el('<span class="propviews">' + (r.views ? 'Opened ' + r.views + '×' : 'Not opened yet') + '</span>'))
    card.appendChild(chips)
    if (r.headline) card.appendChild(el('<div style="font-weight:600;margin-top:8px">' + esc(r.headline) + '</div>'))
    var line = r.state === 'draft' ? 'Draft. Not published yet.' : r.state !== 'live' ? r.stateReason :
      r.views ? 'Opened ' + r.views + '×, first ' + d2(r.firstViewedAt) + ', last ' + d2(r.lastViewedAt) + '.' : 'Live. Nobody has opened the page yet.'
    card.appendChild(el('<div class="fin-h" style="margin-top:4px">' + esc(line) + '</div>'))
    if (r.emailDraftedAt) card.appendChild(el('<div class="fin-h">Email drafted ' + esc(d2(r.emailDraftedAt)) + '. Send it from Gmail.</div>'))
    var link = el('<div class="prop-link"><span>' + esc(r.url.replace('https://', '')) + '</span></div>')
    card.appendChild(link)
    var acts = el('<div class="do-actions" style="margin-top:10px"></div>')
    if (r.openUrl) {
      var view = el('<button class="do-go">Open preview</button>')
      view.addEventListener('click', function () { openPreview({ src: r.openUrl, publicUrl: r.url, title: r.headline || p.client, backLabel: p.client }) })
      acts.appendChild(view)
    }
    var copy = el('<button class="do-alt">Copy</button>')
    copy.addEventListener('click', function () { copyText(r.url, 'Client link copied') })
    acts.appendChild(copy)
    card.appendChild(acts)
    if (r.state === 'draft') {
      if (r.gaps && r.gaps.length) card.appendChild(el('<div class="prop-gaps"><b>Still needs</b>' + r.gaps.map(function (g) { return '<div>' + esc(g) + '</div>' }).join('') + '</div>'))
      var pub = el('<button class="btn-gold" style="width:100%;margin-top:10px"' + (r.gaps && r.gaps.length ? ' disabled' : '') + '>Publish and draft the email</button>')
      pub.addEventListener('click', function () { act('proposal-publish', 'Published. The email is waiting in Gmail.') })
      card.appendChild(pub)
    } else if (r.state === 'live' && !r.emailDraftedAt) {
      var em = el('<button class="btn-gold" style="width:100%;margin-top:10px">Draft the email</button>')
      em.addEventListener('click', function () { act('proposal-email', 'Draft is in Gmail. Send it from there.') })
      card.appendChild(em)
    }
    var small = el('<div class="prop-small"></div>')
    if (r.views) {
      var rs = el('<button class="linkbtn">Reset the count</button>')
      rs.addEventListener('click', function () { act('proposal-reset', 'View count reset', 'Reset the view count to zero? Use this when the opens were you, not the client.') })
      small.appendChild(rs)
    }
    if (r.state === 'live') {
      var down = el('<button class="linkbtn" style="color:var(--red)">Take it down</button>')
      down.addEventListener('click', function () { act('proposal-retire', 'Proposal taken down', 'Take the proposal page down? The link will show a friendly "expired" message.') })
      small.appendChild(down)
    }
    if (small.children.length) card.appendChild(small)
  }
  var load = function () {
    phoneApi('proposal-status', { projectId: p.id }).then(function (r) { if (DETAIL_ID === p.id) draw(r) })
      .catch(function (e) { card.innerHTML = '<div class="fin-h">Could not load the proposal: ' + esc(e.message || '') + '</div>' })
  }
  load()
  return wrap
}

// ---- the day-of card ----
//
// The single block Michael actually reads, and the reason the phone app exists. His brief,
// 2026-09-21: "being able to see the event details in full clarity, especially the time and
// location and contact information of the client. I need to be able to see the event address. The
// venue address when I get in my car so I can stick it in the map."
//
// So: WHEN, WHERE, WHO, at a size he can read at arm's length, with the three things he does with
// them (drive there, call them, text them) as one tap each. Everything that is merely *recorded*
// about the event, rather than *done* on the day, is below in "Everything else".
//
// Blank fields say "Not set" in red here too. On the day of a gig, not knowing the show time is a
// louder fact than any of the ones you do know.
function dayOfCard(p) {
  var card = el('<div class="dayof"></div>')

  // WHEN. The date, then the three times side by side, because their ORDER is the thing he is
  // reading: arrive, doors, show.
  var when = el('<div class="do-sec"></div>')
  var dateLine = el('<div class="do-date"></div>')
  if (p.eventDate) {
    dateLine.appendChild(el('<div class="do-date-v">' + esc(fmtDate(p.eventDate)) + '</div>'))
    var cd = countdownText(p.eventDate)
    if (cd) dateLine.appendChild(el('<div class="do-date-c' + (cd === 'Today' || cd === 'Tomorrow' ? ' soon' : '') + '">' + esc(cd) + '</div>'))
  } else {
    dateLine.appendChild(el('<div class="do-date-v miss">No date set</div>'))
  }
  when.appendChild(dateLine)

  // These three fields are NOT always times. On the first real project this card was tried against,
  // "Event" held "Not locked in yet" and "Show" held "Cocktail hour, around 6", and both were
  // truncated to "Not locked...." and "Cocktail ho..." by a nowrap rule written for "8:30 PM".
  // A real clock time stays big and on one line; anything else is set smaller and allowed to wrap,
  // because a sentence he wrote himself is worth more than a tidy column.
  var times = el('<div class="do-times"></div>')
  ;[['arrivalTime', 'Arrive'], ['eventStartTime', 'Event'], ['showStartTime', 'Show']].forEach(function (t) {
    var raw = String(p[t[0]] == null ? '' : p[t[0]]).trim()
    var v = fmtTime(raw)
    var isClock = /^\d{1,2}:\d{2}\s?(AM|PM)$/i.test(v)
    times.appendChild(el(
      '<div class="do-time"><div class="do-time-l">' + esc(t[1]) + '</div>' +
      '<div class="do-time-v' + (v ? (isClock ? '' : ' free') : ' miss') + '">' + (v ? esc(v) : '--') + '</div></div>'
    ))
  })
  when.appendChild(times)
  card.appendChild(when)

  // WHERE. The address is the payload; venue type and indoors/outdoors are the context he wants
  // alongside it (what am I walking into, and do I need to worry about weather).
  var where = el('<div class="do-sec"></div>')
  where.appendChild(el('<div class="do-l">Venue</div>'))
  // Don't say the same thing twice. venueType is free text and often already contains the answer:
  // one real project reads "NC State University Club. Mainly indoors, with an outdoor patio guests
  // move between", and joining indoorsOrOutdoors onto that printed "Mainly indoors, with an outdoor
  // patio" a second time in the same sentence.
  var vt = String(p.venueType || '').trim()
  var io = String(p.indoorsOrOutdoors || '').trim()
  var parts = [vt]
  if (io && vt.toLowerCase().indexOf(io.toLowerCase()) < 0) parts.push(io)
  var vmeta = parts.filter(Boolean).join('  ·  ')
  if (vmeta) where.appendChild(el('<div class="do-vmeta">' + esc(vmeta) + '</div>'))

  var m = mapsLinks(p.eventLocation)
  if (m) {
    var addr = el('<button class="do-addr">' + esc(m.address) + '</button>')
    addr.addEventListener('click', function () { window.location.href = m.apple })
    where.appendChild(addr)

    var row = el('<div class="do-actions"></div>')
    var drive = el('<a class="do-go">Directions</a>')
    drive.href = m.apple
    row.appendChild(drive)
    // Google gets its own button because he may be routing around traffic, not because Apple Maps
    // failed. Try the app, fall back to the web after a beat if nothing took the tap.
    var g = el('<a class="do-alt">Google</a>')
    g.href = m.google
    g.addEventListener('click', function () {
      var hid = false
      var onHide = function () { hid = true }
      document.addEventListener('visibilitychange', onHide, { once: true })
      setTimeout(function () {
        document.removeEventListener('visibilitychange', onHide)
        if (!hid && !document.hidden) window.open(m.googleWeb, '_blank')
      }, 700)
    })
    row.appendChild(g)
    var cp = el('<button class="do-alt">Copy</button>')
    cp.addEventListener('click', function () { copyText(m.address, 'Address copied') })
    row.appendChild(cp)
    where.appendChild(row)
  } else {
    where.appendChild(el('<div class="do-addr miss" style="pointer-events:none">No venue address yet</div>'))
  }
  card.appendChild(where)

  // WHO. The header already lists every contact; this repeats the PRIMARY one, because on the day
  // there is exactly one person he calls and it should not take a scroll to find them.
  var linked = projectContactCards(p)
  var who = linked[0]
  if (who) {
    var sec = el('<div class="do-sec"></div>')
    sec.appendChild(el('<div class="do-l">Day-of contact</div>'))
    sec.appendChild(el('<div class="do-who">' + esc(who.name) + '</div>'))
    var sub = [fmtPhoneDisplay(who.phones[0]), who.emails[0]].filter(Boolean).join('  ·  ')
    if (sub) sec.appendChild(el('<div class="do-whos">' + esc(sub) + '</div>'))
    var acts = el('<div class="do-actions"></div>')
    if (who.phones[0]) {
      acts.appendChild(el('<a class="do-go" href="tel:' + esc(who.phones[0]) + '">Call</a>'))
      acts.appendChild(el('<a class="do-alt" href="sms:' + esc(who.phones[0]) + '">Text</a>'))
    }
    if (who.emails[0]) acts.appendChild(el('<a class="do-alt" href="mailto:' + esc(who.emails[0]) + '">Email</a>'))
    if (acts.children.length) sec.appendChild(acts)
    card.appendChild(sec)
  }

  // Headcount and what he is actually performing. Short, because they are one-glance facts.
  var facts = []
  if (String(p.numberOfGuests || '').trim()) facts.push(['Guests', String(p.numberOfGuests).trim()])
  if (String(p.ageOfGuests || '').trim()) facts.push(['Ages', String(p.ageOfGuests).trim()])
  if (String(p.performanceStyle || '').trim()) facts.push(['Performing', String(p.performanceStyle).trim()])
  if (facts.length) {
    var fsec = el('<div class="do-sec do-facts"></div>')
    facts.forEach(function (f) {
      fsec.appendChild(el('<div class="do-fact"><span class="do-fact-l">' + esc(f[0]) + '</span><span class="do-fact-v">' + esc(f[1]) + '</span></div>'))
    })
    card.appendChild(fsec)
  }
  return card
}

// (123) 456-7890 for a plain 10-digit string, verbatim for anything else. Display only; the tel:
// href always carries the raw value so nothing can be lost to formatting.
function fmtPhoneDisplay(v) {
  var d = String(v || '').replace(/\D/g, '')
  if (d.length === 10) return '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6)
  if (d.length === 11 && d[0] === '1') return '(' + d.slice(1, 4) + ') ' + d.slice(4, 7) + '-' + d.slice(7)
  return String(v || '')
}

// ---- what the client actually sent back ----
//
// Two different artefacts, and Michael asked for both: "I need to be able to see the PDF of their
// completed booking form and performance agreement so I can see what they entered".
//
//   - The ANSWERS, verbatim, as text. This is the useful one on a phone: it is selectable,
//     searchable and the address in it is tappable. A PDF of a form is a picture of a form.
//   - The AGREEMENT PDF, which is the document with legal weight, built by the same cloud renderer
//     that produced the client's copy. Already wired; it just lived on the Booking tab where he
//     was not looking for it.
//
// Note the answers are the raw submission, NOT the project fields. They can differ: Michael edits a
// project after the form comes in. Seeing what the CLIENT said, unedited, is the point.
function submittedSection(p) {
  var wrap = el('<div></div>')
  var body = el('<div></div>')

  function draw(g) {
    body.innerHTML = ''
    var answers = (g && Array.isArray(g.answers) ? g.answers : []).filter(function (a) {
      return a && String(a.value == null ? '' : a.value).trim()
    })
    if (!answers.length && !(g && (g.stage === 'submitted' || g.stage === 'signed'))) return
    body.appendChild(sectionLabel('What they sent back'))

    if (g.stage === 'submitted' || g.stage === 'signed') {
      var chip = el(
        '<button class="pdfchip"><span class="pdfchip-i">PDF</span><span>' +
        '<span class="pdfchip-n">Performance agreement' + (g.stage === 'signed' ? ' (signed)' : '') + '</span>' +
        '<span class="pdfchip-s">' + (g.stage === 'signed' ? 'Signed ' + esc(bookingStamp(g.signedAt) || '') + (g.signedName ? ' by ' + esc(g.signedName) : '') : 'Details in, not signed yet') + ' · tap to preview</span>' +
        '</span></button>'
      )
      chip.addEventListener('click', function () { openPdfPreview(p) })
      body.appendChild(chip)
    }

    if (!answers.length) return
    var open = false
    var toggle = el('<button class="pdfchip"><span class="pdfchip-i" style="background:rgba(93,169,163,0.16);color:var(--teal)">FRM</span><span><span class="pdfchip-n">Completed booking form</span><span class="pdfchip-s">' + answers.length + ' answers · tap to read</span></span></button>')
    var list = el('<div class="kv kv-full" style="display:none"></div>')
    answers.forEach(function (a) {
      var label = BOOKING_FORM_LABELS[a.id] || a.id
      var value = String(a.value).trim()
      var item = el('<div class="item"><div class="k">' + esc(label) + '</div></div>')
      // The venue address the CLIENT typed gets the same one-tap route as the one on the day-of
      // card, because this is often where it lands first.
      var mm = a.id === 'venue_address' ? mapsLinks(value) : null
      if (mm) {
        var v = el('<button class="v do-inline-addr">' + esc(value) + '</button>')
        v.addEventListener('click', function () { window.location.href = mm.apple })
        item.appendChild(v)
      } else {
        item.appendChild(el('<div class="v">' + esc(value) + '</div>'))
      }
      list.appendChild(item)
    })
    toggle.addEventListener('click', function () {
      open = !open
      list.style.display = open ? '' : 'none'
      toggle.querySelector('.pdfchip-s').textContent = answers.length + ' answers · tap to ' + (open ? 'hide' : 'read')
    })
    body.appendChild(toggle)
    body.appendChild(list)
  }

  draw(BOOKING_PROGRESS[p.id])
  refreshBookingProgress(p.id, draw)
  wrap.appendChild(body)
  return wrap
}

// Answer id -> the question the client was asked. Mirrors BOOKING_FIELDS in crm-booking-form.mjs,
// shortened for a phone: the form asks "For a stage show, what AV is available at the venue (sound
// system, projector/screen, etc)?" and on a 390px screen that is a paragraph, not a label.
//
// ⚠️ Keys must stay in step with BOOKING_FIELDS. An id with no entry here falls back to the raw id,
// which is ugly but never wrong, so a new question added to the form degrades rather than breaks.
var BOOKING_FORM_LABELS = {
  event_summary: 'Description of the event',
  event_start_time: 'Event start time',
  show_start_time: 'Show start time',
  number_of_guests: 'Number of guests',
  age_of_guests: 'Ages of the guests',
  venue_address: 'Venue address',
  venue_type: 'Venue type',
  indoors_or_outdoors: 'Indoor or outdoor',
  av: 'AV available',
  vips: 'VIPs',
  invoice_to: 'Invoice made out to',
  unforgettable: 'How to make it unforgettable',
  notes: 'Anything else',
}

// Details: EVERY event field, including the blank ones, which are called out in red. A field you
// have not filled is the thing you most need to see, and a list that silently omits them cannot
// tell you what is missing. Editing stays behind a button: twenty live inputs on a phone is a
// minefield of accidental edits.
function detailsTab(p) {
  var wrap = el('<div></div>')
  wrap.appendChild(dayOfCard(p))
  wrap.appendChild(submittedSection(p))
  wrap.appendChild(sectionLabel('Everything else'))
  var rows = allFieldRows(p)
  var missing = rows.filter(function (r) { return r.empty }).length
  var kv = el('<div class="kv kv-full"></div>')
  rows.forEach(function (r) {
    kv.appendChild(el(
      '<div class="item' + (r.empty ? ' miss' : '') + '"><div class="k">' + esc(r.k) + '</div>' +
      '<div class="v">' + (r.empty ? 'Not set' : r.optional ? '<span class="faint">Not set</span>' : esc(r.v)) + '</div></div>'
    ))
  })
  wrap.appendChild(kv)
  if (missing) wrap.appendChild(el('<div class="hint" style="margin-top:8px">' + missing + (missing === 1 ? ' field is' : ' fields are') + ' still blank.</div>'))
  var edit = el('<button class="btn-gold" style="width:100%;margin-top:14px">Edit details</button>')
  edit.addEventListener('click', function () { openDetailsPanel(p) })
  wrap.appendChild(edit)
  var inq = el('<button class="btn-ghost" style="width:100%;margin-top:8px">Initial inquiry</button>')
  inq.addEventListener('click', function () { openInitialInquirySheet(p) })
  wrap.appendChild(inq)
  wrap.appendChild(postShowSection(p))
  return wrap
}

// Every event field with its value, blanks included and flagged. This replaced fieldRows(), which
// silently dropped anything unset because it fed a compact summary; the Details tab wants the
// opposite, since an unfilled field is the one thing a summary can never tell you about.
function allFieldRows(p) {
  var labels = SNAP.eventFieldLabels || {}, hidden = SNAP.eventFieldHidden || [], deleted = SNAP.eventFieldDeleted || []
  var rows = []
  EVENT_FIELDS.forEach(function (f) {
    var id = f[0]
    if (hidden.indexOf(id) >= 0 || deleted.indexOf(id) >= 0) return
    var val = id === 'totalFee' ? money(p.totalFee) : (id === 'eventDate' ? fmtDate(p.eventDate) : p[id])
    var empty = val == null || String(val).trim() === ''
    rows.push({ k: labels[id] || f[1], v: empty ? '' : String(val), empty: empty })
    if (id === 'eventDate') {
      var ld = p.leadDate ? fmtDate(p.leadDate) : ''
      rows.push({ k: 'Lead date', v: ld, empty: !ld })
    }
    if (id === 'showStartTime') {
      rows.push({ k: 'Leave home', v: p.leaveHomeTime || '', empty: false, optional: !p.leaveHomeTime })
      rows.push({ k: 'Back home', v: p.backHomeTime || '', empty: false, optional: !p.backHomeTime })
    }
  })
  ;(SNAP.customFields || []).forEach(function (cf) {
    var v = (SNAP.customValues[p.id] || {})[cf.id]
    var empty = !v || !String(v).trim()
    rows.push({ k: cf.label, v: empty ? '' : String(v), empty: empty })
  })
  return rows
}

// Notes: the fuller write-up, then the working notes, then the activity log.
//
// These are two different things and are kept apart on purpose. The write-up expands on the event
// details (what the job actually is); the notes are Michael's own remarks about the event, the
// client, whatever he wants to remember. Each gets its own Edit.
function notesTab(p) {
  var wrap = el('<div></div>')

  wrap.appendChild(sectionLabel('Additional details'))
  wrap.appendChild(textBlock(p.eventDescription, 'Nothing written up yet.'))
  var e1 = el('<button class="btn-ghost" style="width:100%;margin-top:8px">Edit additional details</button>')
  e1.addEventListener('click', function () {
    openTextEditor(p, 'eventDescription', 'Additional details', 'What the event is and what you need to know about it.')
  })
  wrap.appendChild(e1)

  wrap.appendChild(sectionLabel('Notes'))
  wrap.appendChild(textBlock(p.projectNotes, 'No notes yet.'))
  var e2 = el('<button class="btn-ghost" style="width:100%;margin-top:8px">Edit notes</button>')
  e2.addEventListener('click', function () {
    openTextEditor(p, 'projectNotes', 'Notes', 'Anything you want to remember about this one.')
  })
  wrap.appendChild(e2)

  wrap.appendChild(sectionLabel('Activity'))
  wrap.appendChild(addNoteBox(p))
  var logWrap = el('<div></div>')
  renderLog(logWrap, p)
  wrap.appendChild(logWrap)
  return wrap
}

// A read-only paragraph of project text, preserving the line breaks he typed.
function textBlock(text, emptyText) {
  var t = String(text == null ? '' : text).trim()
  if (!t) return el('<div class="empty" style="padding:6px 2px;text-align:left">' + esc(emptyText) + '</div>')
  return el('<div class="card textblock" style="pointer-events:none">' + esc(t).replace(/\n/g, '<br>') + '</div>')
}

// A full-height editor for one long text field (the write-up, the notes).
function openTextEditor(p, field, title, hint) {
  var sheet = el(
    '<div class="sheet"><div class="sheet-card sheet-tall">' +
      '<div class="sheet-head"><div class="sheet-title">' + esc(title) + '</div>' +
      '<button class="sheet-x" aria-label="Close">' +
      '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>' +
      '</button></div><div class="sheet-body"></div>' +
    '</div></div>'
  )
  var body = sheet.querySelector('.sheet-body')
  var close = function () { sheet.remove() }
  sheet.querySelector('.sheet-x').addEventListener('click', close)
  sheet.addEventListener('click', function (e) { if (e.target === sheet) close() })
  if (hint) body.appendChild(el('<div class="hint" style="margin:0 0 8px">' + esc(hint) + '</div>'))
  var ta = document.createElement('textarea')
  ta.className = 'field-input'
  ta.rows = 12
  ta.value = p[field] == null ? '' : String(p[field])
  body.appendChild(ta)
  var bar = el('<div class="addrow" style="margin-top:12px"><button class="btn-ghost">Cancel</button><button class="btn-gold">Save</button></div>')
  bar.children[0].addEventListener('click', close)
  bar.children[1].addEventListener('click', function () {
    var nv = ta.value
    if (nv === (p[field] == null ? '' : String(p[field]))) { close(); return }
    doWrite(updateProjectField(p.id, field, nv), 'Saved', function (r) {
      p[field] = r.value
      close()
      if (DETAIL_ID === p.id) renderDetail(p.id, true)
    })
  })
  body.appendChild(bar)
  document.body.appendChild(sheet)
  setTimeout(function () { ta.focus() }, 40)
}

// ---- the bottom tab bar ----
//
// Lives on document.body rather than inside #view so it stays put while the page scrolls, and so
// clearing #view on every render does not take it with it. Rebuilt per render so the Tasks badge
// and the active tab are always current.
function ensureProjectTabs(p) {
  removeProjectTabs()
  var bar = el('<nav id="ptabs"></nav>')
  var due = (SNAP.tasks || []).filter(function (t) {
    if (t.projectId !== p.id || t.done) return false
    var st = dueState(t.dueDate, t.dueTime)
    return st === 'due' || st === 'overdue'
  }).length
  PROJECT_TABS.forEach(function (t) {
    var key = t[0]
    var b = el(
      '<button class="ptab' + (PTAB === key ? ' on' : '') + '">' +
        '<span class="ptab-i"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + t[2] + '</svg>' +
        (key === 'tasks' && due ? '<span class="ptab-badge">' + due + '</span>' : '') +
        '</span>' +
        '<span class="ptab-l">' + esc(t[1]) + '</span>' +
      '</button>'
    )
    b.addEventListener('click', function () {
      if (PTAB === key) return
      PTAB = key
      renderDetail(p.id)
    })
    bar.appendChild(b)
  })
  document.body.appendChild(bar)
  document.body.classList.add('has-ptabs')
}
function removeProjectTabs() {
  var b = $('#ptabs'); if (b) b.remove()
  document.body.classList.remove('has-ptabs')
}

// Everything below used to be a row of buttons that each opened a sheet: "Emails & booking",
// "Tasks", "Payments". Michael, 2026-08-06: the only one that earns a dialog is Event details
// (about twenty fields, which would bury the rest of the page). The other three are short, so
// hiding them behind a tap meant two taps to reach a one-tap action, most obviously "Payments ->
// Log". They are now sections on the page itself.

// A section heading with an action button on the right ("Tasks    + Add").
function sectionHead(text, actionLabel, onAction) {
  var row = el('<div class="section-label sec-head"><span class="dot"></span><span class="sec-t">' + esc(text) + '</span></div>')
  if (actionLabel && onAction) {
    var b = el('<button class="addbtn"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>' + esc(actionLabel) + '</button>')
    b.addEventListener('click', onAction)
    row.appendChild(b)
  }
  return row
}

// Open tasks for a project, with Add inline. Rebuilds itself in place so ticking one off does not
// re-render (and re-scroll) the whole project page.
function tasksSection(p) {
  var wrap = el('<div></div>')
  function rebuild() {
    wrap.innerHTML = ''
    var slot = el('<div></div>')
    var open = (SNAP.tasks || []).filter(function (t) { return t.projectId === p.id && !t.done })
    open.sort(function (a, b) { return (a.dueDate || '') < (b.dueDate || '') ? -1 : 1 })
    wrap.appendChild(sectionHead(open.length ? 'Tasks  ·  ' + open.length + ' open' : 'Tasks', 'Add', function () {
      if (slot.firstChild) { slot.innerHTML = ''; return } // second tap closes the form again
      slot.appendChild(addTaskForm(p.id, rebuild))
    }))
    wrap.appendChild(slot)
    if (open.length) open.forEach(function (t) { wrap.appendChild(taskCard(t, false, rebuild)) })
    else wrap.appendChild(el('<div class="empty" style="padding:6px 2px;text-align:left">No open tasks.</div>'))
    wrap.appendChild(doneSection((SNAP.tasks || []).filter(function (t) { return t.projectId === p.id && t.done }), false))
  }
  rebuild()
  return wrap
}

// Payments for a project, with Log inline. Last section on the page.
function paymentsSection(p) {
  var wrap = el('<div></div>')
  function rebuild() {
    wrap.innerHTML = ''
    var slot = el('<div></div>')
    var pays = (SNAP.payments || []).filter(function (x) { return x.projectId === p.id })
      .sort(function (a, b) { return String(b.dateReceived || '').localeCompare(String(a.dateReceived || '')) })
    var recv = receivedFor(p.id)
    wrap.appendChild(sectionHead(recv ? 'Payments  ·  ' + money(recv) + ' received' : 'Payments', 'Log', function () {
      if (slot.firstChild) { slot.innerHTML = ''; return }
      slot.appendChild(addPaymentForm(p, rebuild))
    }))
    wrap.appendChild(slot)
    if (pays.length) {
      pays.forEach(function (pm) {
        var lbl = [pm.type, pm.method].filter(Boolean).join(' · ')
        var pc = el('<div class="card taskrow"><div class="taskbody"><div class="row1"><span class="name" style="font-size:14.5px;color:var(--green)">' + esc(money(pm.amount) || String(pm.amount)) + (pm.pending ? ' <span style="color:var(--faint);font-size:12px">(pending)</span>' : '') + '</span><span class="fee" style="color:var(--faint);font-variant-numeric:normal">' + esc(pm.dateReceived ? fmtShort(pm.dateReceived) : '') + '</span></div>' + (lbl ? '<div class="meta">' + esc(lbl) + '</div>' : '') + '</div>' +
          '<button class="taskdel" aria-label="Delete payment"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button></div>')
        pc.querySelector('.taskdel').addEventListener('click', function () {
          if (!confirm('Delete this ' + (money(pm.amount) || '') + ' payment?')) return
          doWrite(deletePayment(pm.id), 'Payment deleted', function () { refreshPaymentsFinance(rebuild) })
        })
        wrap.appendChild(pc)
      })
    } else wrap.appendChild(el('<div class="empty" style="padding:6px 2px;text-align:left">No payments logged.</div>'))
  }
  rebuild()
  return wrap
}

// ---- booking / emails ----

// The saved email (if any) for a project + step.
// ---------- Booking ----------
// One row, one action, matching the desktop. This used to be an "Emails & booking" panel listing a
// card per workflow email (shark, break-up, follow-ups, questionnaire invite). Michael had those
// removed: he sends the booking form and everything after it runs itself, so tracking a dozen email
// steps by hand was work the system no longer needs anyone to do.

// The four states of a booking link, in order.
var BOOKING_STEPS = [
  { key: 'none', label: 'Sent', at: 'sentAt' },
  { key: 'viewed', label: 'Viewed', at: 'viewedAt' },
  { key: 'submitted', label: 'Details in', at: 'submittedAt' },
  { key: 'signed', label: 'Signed', at: 'signedAt' },
]

// Short date + time under each timeline step: "Aug 3, 9:25 AM". A resend clears everything after
// "Sent", so these always describe the form the client currently holds.
function bookingStamp(iso) {
  if (!iso) return ''
  var d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// Cache of live booking progress per project, filled when a project detail opens.
var BOOKING_PROGRESS = {}
function refreshBookingProgress(projectId, then) {
  loadBookingProgress(projectId)
    .then(function (g) { BOOKING_PROGRESS[projectId] = g; if (then) then(g) })
    .catch(function () { /* leave the row blank rather than break the page */ })
}

// The booking sheet: the two gated fields, live progress, and the one button.
function bookingSection(p) {
  var card = el('<div></div>')
  card.appendChild(sectionLabel('Booking'))

  var style = String(p.performanceStyle || '').trim()
  var fee = Number(p.totalFee)
  var feeOk = !!fee && !isNaN(fee) && fee > 0
  var eventDate = String(p.eventDate || '').trim()
  var dateOk = /^\d{4}-\d{2}-\d{2}$/.test(eventDate)
  var ready = !!style && feeOk && dateOk
  // Only a live project can be sent a booking form. Completed / archived / deleted projects still
  // show their booking history and their signed agreement, but not the gate or the send button.
  //
  // This mattered once the section came out of its sheet: "Ready to book" on a finished gig used to
  // be three taps behind a panel, and would now be one, sitting right there on a job that already
  // happened. Sending a client a fresh agreement for a show they have paid for is not a mistake
  // worth leaving one tap away.
  var canSend = p.bucket === 'active'

  // The three facts the client reads on the agreement. Blank means they'd be looking at a literal
  // "[Performance scope]" or "[Event date]" on the document they're about to sign. The date is not
  // asked on the form by design, so nothing downstream can fill it in.
  if (canSend) {
    var gate = el('<div class="bk-gate' + (ready ? '' : ' bad') + '"></div>')
    gate.appendChild(el('<div class="bk-gate-t">' + (ready ? 'Goes on the agreement' : 'Fill these to send the booking form') + '</div>'))
    // Each label and value wrapped in one <div>: el() keeps only the FIRST top-level element, so the
    // values used to be dropped and the gate showed three labels with nothing beside them.
    gate.appendChild(el('<div><div class="k">Performance style</div><div class="v">' + (style ? esc(style) : '<span class="miss">Not set</span>') + '</div></div>'))
    gate.appendChild(el('<div><div class="k" style="margin-top:8px">Quote</div><div class="v">' + (feeOk ? esc(money(fee)) : '<span class="miss">Not set</span>') + '</div></div>'))
    gate.appendChild(el('<div><div class="k" style="margin-top:8px">Event date</div><div class="v">' + (dateOk ? esc(fmtDate(eventDate)) : '<span class="miss">Not set</span>') + '</div></div>'))
    if (!ready) gate.appendChild(el('<div class="hint" style="margin-top:8px">Edit these in Event details.</div>'))
    card.appendChild(gate)
  }

  var body = el('<div></div>')
  card.appendChild(body)

  function draw(g) {
    body.innerHTML = ''
    if (g && g.linkOut) {
      var idx = BOOKING_STEPS.findIndex(function (x) { return x.key === g.stage })
      var bar = el('<div class="bk-prog"></div>')
      BOOKING_STEPS.forEach(function (st, i) {
        var when = i <= idx ? (bookingStamp(g[st.at]) || '—') : ''
        var seg = el('<div class="bk-seg' + (i <= idx ? (i === BOOKING_STEPS.length - 1 ? ' done' : ' on') : '') + '"><span class="bk-bar"></span><span class="bk-lab">' + esc(st.label) + '</span><span class="bk-when">' + esc(when) + '</span></div>')
        bar.appendChild(seg)
      })
      body.appendChild(bar)
      if (g.variant) body.appendChild(el('<div class="hint" style="margin-top:8px">Sent with the <b>' + esc(variantLabel(g.variant)) + '</b> agreement.</div>'))
      if (g.completeError) body.appendChild(el('<div class="hint" style="margin-top:6px;color:var(--red)">The automatic step after signing hit a problem: ' + esc(g.completeError) + '</div>'))
      if (g.token) {
        // The form exactly as the client sees it, flagged as a preview so it never counts as a view.
        var pv = el('<button class="btn-ghost" style="width:100%;margin-top:10px">Preview the form</button>')
        pv.addEventListener('click', function () {
          var url = 'https://michaelbloemeke.com/book/?t=' + encodeURIComponent(g.token)
          openPreview({ src: url + '&preview=1', publicUrl: url, title: 'Booking form', backLabel: p.client })
        })
        body.appendChild(pv)
      }
      // The invoice the signed booking produced: "Invoice #1058 sent Oct 7 to ... · paid Oct 13".
      var invLine = el('<div class="hint" style="margin-top:8px"></div>')
      body.appendChild(invLine)
      loadInvoice(p.id).then(function (inv) {
        if (!inv || !inv.docNumber) return
        var d2 = function (iso) { return iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '' }
        invLine.innerHTML = 'Invoice #' + esc(inv.docNumber) + (inv.sentAt ? ' sent ' + esc(d2(inv.sentAt)) : ' created ' + esc(d2(inv.createdAt))) + (inv.email ? ' to ' + esc(inv.email) : '') +
          (inv.paidAt ? ' · <span style="color:var(--green)">paid ' + esc(d2(inv.paidAt)) + '</span>' : inv.balance > 0 ? ' · ' + esc(money2(inv.balance)) + ' due' : '')
      }).catch(function () {})
      if (g.stage === 'signed') body.appendChild(el('<div class="hint" style="margin-top:4px">Their signed copy and the invoice were sent automatically.</div>'))
      if (g.stage === 'submitted' || g.stage === 'signed') {
        var chip = el('<button class="pdfchip"><span class="pdfchip-i">PDF</span><span><span class="pdfchip-n">Agreement' + (g.stage === 'signed' ? ' (signed)' : '') + '</span><span class="pdfchip-s">' + (g.stage === 'signed' ? 'The copy the client received' : 'Not signed yet') + ' · tap to preview</span></span></button>')
        chip.addEventListener('click', function () { openPdfPreview(p) })
        body.appendChild(chip)
      }
    } else if (canSend) {
      body.appendChild(el('<div class="hint" style="margin-top:10px">They fill in the event details, sign the agreement, and get invoiced without you touching anything.</div>'))
    } else {
      body.appendChild(el('<div class="empty" style="padding:6px 2px;text-align:left">No booking form was sent for this project.</div>'))
    }

    if (!canSend) return
    var btn = el('<button class="btn-gold" style="width:100%;margin-top:14px"' + (ready ? '' : ' disabled') + '>' + (g && g.linkOut ? 'Resend booking form' : 'Ready to book') + '</button>')
    btn.addEventListener('click', function () { pickVariantThen(p, btn, !!(g && g.linkOut)) })
    body.appendChild(btn)
    if (!ready) body.appendChild(el('<div class="hint" style="margin-top:6px">Add a performance style, a quote and an event date first.</div>'))
  }

  draw(BOOKING_PROGRESS[p.id])
  refreshBookingProgress(p.id, draw)

  return card
}

// Preview the agreement in place, the way a mail client shows an attachment. No download first:
// the document exists, so looking at it should not mean a file landing in Files.
function openPdfPreview(p) {
  toast('Building the agreement…')
  agreementPdfUrl(p.id)
    .then(function (url) {
      var sheet = el('<div class="sheet pdfsheet"><div class="sheet-card pdfcard"></div></div>')
      var card = sheet.querySelector('.sheet-card')
      var close = function () { sheet.remove(); URL.revokeObjectURL(url) }
      var head = el('<div class="pdfhead"><span class="sheet-title" style="margin:0">Agreement</span></div>')
      var actions = el('<div style="display:flex;gap:8px"></div>')
      var open = el('<a class="btn-ghost" style="padding:6px 12px" target="_blank">Open</a>')
      open.href = url
      var done = el('<button class="btn-ghost" style="padding:6px 12px">Close</button>')
      done.addEventListener('click', close)
      actions.appendChild(open); actions.appendChild(done)
      head.appendChild(actions)
      card.appendChild(head)
      var frame = document.createElement('iframe')
      frame.className = 'pdfframe'
      frame.src = url
      card.appendChild(frame)
      sheet.addEventListener('click', function (e) { if (e.target === sheet) close() })
      document.body.appendChild(sheet)
    })
    .catch(function (e) { toast(e.message || 'Could not build the agreement', 'err') })
}

// Remembered so a label can be shown without another round-trip.
var CONTRACT_VARIANTS = []
function variantLabel(id) {
  var v = CONTRACT_VARIANTS.find(function (x) { return x.variant === id })
  return v ? v.label : id
}

// Choosing WHICH agreement. Two taps rather than one, on purpose: which contract a client signs is
// not a thing to get wrong by muscle memory, and swapping it is the reason a resend exists.
function pickVariantThen(p, btn, isResend) {
  // Restore whatever it said, rather than hardcoding "Ready to book": on a project that already has
  // a form out, this button reads "Resend booking form" and relabelling it would be a lie. Barely
  // noticeable when this lived in a sheet that got dismissed; obvious now it sits on the page.
  var label = btn.textContent
  btn.disabled = true
  btn.textContent = 'Loading…'
  loadContractVariants()
    .then(function (vs) {
      CONTRACT_VARIANTS = vs
      btn.disabled = false
      btn.textContent = label
      var sheet = el('<div class="sheet"><div class="sheet-card"></div></div>')
      var card = sheet.querySelector('.sheet-card')
      var close = function () { sheet.remove() }
      card.appendChild(el('<div class="sheet-title">Which agreement?</div>'))
      if (isResend) card.appendChild(el('<div class="hint" style="color:var(--red);margin:-4px 0 10px">Resending clears the timeline and any signature, and drops the CRM\'s invoice record. Delete the old invoice in QuickBooks yourself if one went out.</div>'))
      if (!vs.length) {
        card.appendChild(el('<div class="hint">No contract templates have been published yet. Open the Mac app once and they will appear here.</div>'))
      }
      vs.forEach(function (v) {
        var b = el('<button class="emailcard" style="flex-direction:column;align-items:flex-start;gap:2px"><span class="ec-title">' + esc(v.label) + '</span><span class="hint" style="margin:0">' + esc(v.hint || '') + '</span></button>')
        b.addEventListener('click', function () { close(); sendBooking(p, v, isResend) })
        card.appendChild(b)
      })
      var cancel = el('<button class="btn-ghost" style="width:100%;margin-top:10px">Cancel</button>')
      cancel.addEventListener('click', close)
      card.appendChild(cancel)
      sheet.addEventListener('click', function (e) { if (e.target === sheet) close() })
      document.body.appendChild(sheet)
    })
    .catch(function (e) {
      btn.disabled = false
      btn.textContent = label
      toast(e.message || 'Could not load the agreements', 'err')
    })
}

// Issue the form and hand back the link. No email is sent: the phone has no Gmail drafting by
// design, so this copies the URL for Michael to send however he likes.
function sendBooking(p, variant, isResend) {
  toast('Preparing…')
  // A RESEND wipes the previous attempt first, so the timeline and the signed/invoiced claims
  // describe the form the client currently holds rather than the one being replaced.
  var pre = isResend ? resetBookingOnPhone(p.id) : Promise.resolve()
  pre
    .then(function () { return readyToBookOnPhone(p, variant.variant) })
    .then(function (r) {
      BOOKING_PROGRESS[p.id] = null
      refreshBookingProgress(p.id)
      var sheet = el('<div class="sheet"><div class="sheet-card"></div></div>')
      var card = sheet.querySelector('.sheet-card')
      var close = function () { sheet.remove(); if (DETAIL_ID === p.id) renderDetail(p.id, true) }
      card.appendChild(el('<div class="sheet-title">Booking form ready</div>'))
      card.appendChild(el('<div class="hint">Using the <b>' + esc(r.label) + '</b> agreement. Send this link to the client and everything after it happens on its own.</div>'))
      card.appendChild(el('<div class="v" style="word-break:break-all;margin-top:10px;font-size:13px">' + esc(r.url) + '</div>'))
      var bar = el('<div class="addrow" style="margin-top:14px"><button class="btn-ghost" style="flex:1">Copy link</button><button class="btn-gold" style="flex:1">Done</button></div>')
      bar.children[0].addEventListener('click', function () {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(r.url).then(function () { toast('Link copied') }).catch(function () { toast('Could not copy', 'err') })
        } else { toast('Copy not supported here', 'err') }
      })
      bar.children[1].addEventListener('click', close)
      card.appendChild(bar)
      sheet.addEventListener('click', function (e) { if (e.target === sheet) close() })
      document.body.appendChild(sheet)
    })
    .catch(function (e) { toast(e.message || 'Could not create the booking form', 'err') })
}

// The project's primary contact first name (for merge fields like [firstName]).
function firstNameFor(p) {
  var n = (p.contactNames || '').split(/[,;]/)[0].trim()
  return n ? n.split(/\s+/)[0] : ''
}

// Compose + SEND an email for a booking step. Prefills from an existing draft/sent email or from the
// step's default subject; a template picker fills subject + body (with [firstName] merged). Send goes
// through the cloud Gmail function (works with the Mac off); Save draft writes to the emails table.

// ---- project-detail panels (bottom sheets = the mobile form of the Mac's side panels) ----

// Actions: the lifecycle buttons, consolidated behind one button to save space at the top.
function openActionsPanel(p) {
  var sheet = el('<div class="sheet"><div class="sheet-card"></div></div>')
  var card = sheet.querySelector('.sheet-card')
  var close = function () { sheet.remove() }
  card.appendChild(el('<div class="sheet-title">Actions</div>'))
  if (p.bucket !== 'active') card.appendChild(el('<div class="statusline" style="margin:-4px 0 12px">' + esc(statusText(p)) + '</div>'))

  // Stage and contacts moved in here on 2026-08-06. Both used to be full sections on the project
  // page: the stage was a whole block spent on one dropdown, and the contacts block carried its own
  // add/remove controls. They are edits, not information, so they belong with the other edits.
  var edits = el('<div class="actstack" style="margin-bottom:14px"></div>')
  if (p.bucket === 'active') {
    var st = el('<button class="actrow"><span class="ar-l">Change stage</span><span class="ar-v">' + esc(stageName(p.stageId) || 'Not set') + '</span></button>')
    st.addEventListener('click', function () { close(); openStageSheet(p) })
    edits.appendChild(st)
  }
  var et = el('<button class="actrow"><span class="ar-l">Event type</span><span class="ar-v">' + esc(p.eventType || 'Not set') + '</span></button>')
  et.addEventListener('click', function () { close(); openEventTypeSheet(p) })
  edits.appendChild(et)
  var lc = el('<button class="actrow"><span class="ar-l">Log a call</span><span class="ar-v">Answered, voicemail, notes</span></button>')
  lc.addEventListener('click', function () { close(); openLogCallSheet(p) })
  edits.appendChild(lc)
  var ii = el('<button class="actrow"><span class="ar-l">Initial inquiry</span><span class="ar-v">What they first sent</span></button>')
  ii.addEventListener('click', function () { close(); openInitialInquirySheet(p) })
  edits.appendChild(ii)
  var ci = el('<button class="actrow"><span class="ar-l">Send a calendar invite</span><span class="ar-v">Work calendar</span></button>')
  ci.addEventListener('click', function () { close(); openCalendarInviteSheet(p) })
  edits.appendChild(ci)
  var nC = projectContactCards(p).length
  var ct = el('<button class="actrow"><span class="ar-l">Contacts</span><span class="ar-v">' + (nC ? nC + (nC === 1 ? ' person' : ' people') : 'None') + '</span></button>')
  ct.addEventListener('click', function () { close(); openContactsSheet(p) })
  edits.appendChild(ct)
  card.appendChild(edits)

  var stack = el('<div class="actstack"></div>')
  if (p.bucket === 'active') {
    var comp = el('<button class="btn-gold" style="width:100%">Complete project</button>')
    comp.addEventListener('click', function () { close(); openCompleteSheet(p) })
    var arch = el('<button class="btn-ghost" style="width:100%">Archive project</button>')
    arch.addEventListener('click', function () { close(); openArchiveSheet(p) })
    stack.appendChild(comp); stack.appendChild(arch)
  } else {
    var rest = el('<button class="btn-gold" style="width:100%">' + (p.bucket === 'deleted' ? 'Restore project' : 'Return to pipeline') + '</button>')
    rest.addEventListener('click', function () { close(); doRestore(p) })
    stack.appendChild(rest)
  }
  // Not shown on a project that is already deleted: there is nothing left for it to do, and the
  // permanent purge deliberately lives only on the Mac (and the 30-day sweep).
  //
  // It also used to be labelled "Delete permanently", which stopped being true when delete became a
  // soft move on 2026-08-05. A button that overstates what it does is worse than no button.
  if (p.bucket !== 'deleted') {
    var del = el('<button class="btn-danger">Move to Deleted</button>')
    del.addEventListener('click', function () { close(); doDelete(p) })
    stack.appendChild(del)
  }
  card.appendChild(stack)
  var cancel = el('<button class="btn-ghost" style="width:100%;margin-top:12px">Close</button>')
  cancel.addEventListener('click', close)
  card.appendChild(cancel)
  sheet.addEventListener('click', function (e) { if (e.target === sheet) close() })
  document.body.appendChild(sheet)
}

// Change the stage. A list of tappable rows rather than a <select>: on a phone a native picker for
// something you change a handful of times per project is more friction than a list, and the list can
// show the umbrella each stage belongs to.
function openStageSheet(p) {
  var sheet = el(
    '<div class="sheet"><div class="sheet-card sheet-tall">' +
      '<div class="sheet-head"><div class="sheet-title">Stage</div>' +
      '<button class="sheet-x" aria-label="Close">' +
      '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>' +
      '</button></div><div class="sheet-body"></div>' +
    '</div></div>'
  )
  var body = sheet.querySelector('.sheet-body')
  var close = function () { sheet.remove() }
  sheet.querySelector('.sheet-x').addEventListener('click', close)
  sheet.addEventListener('click', function (e) { if (e.target === sheet) close() })

  ;(SNAP.structure.umbrellas || []).forEach(function (u) {
    body.appendChild(sectionLabel(u.label))
    var auto = u.role === 'postshow'
    ;(u.stages || []).forEach(function (s) {
      var on = s.id === p.stageId
      var row = el('<button class="actrow' + (on ? ' on' : '') + (auto && !on ? ' off' : '') + '"><span class="ar-l">' + esc(s.name) + '</span>' + (on ? '<span class="ar-v">Current</span>' : auto ? '<span class="ar-v">Automatic</span>' : '') + '</button>')
      row.addEventListener('click', function () {
        if (on) { close(); return }
        // Post Show is moved into automatically after the event, as on the Mac, never by hand.
        if (auto) { toast('Projects move into Post Show on their own after the event.', 'err'); return }
        // A Booked stage runs the Mac's two gates first: gig times, then a received payment.
        close()
        moveToStage(p, s)
      })
      body.appendChild(row)
    })
  })
  document.body.appendChild(sheet)
}

// Manage who is on the project: add someone, or take someone off. Viewing them (and calling /
// texting / emailing them) stays in the header where it is one tap from anywhere.
function openContactsSheet(p) {
  var sheet = el(
    '<div class="sheet"><div class="sheet-card sheet-tall">' +
      '<div class="sheet-head"><div class="sheet-title">Contacts</div>' +
      '<button class="sheet-x" aria-label="Close">' +
      '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>' +
      '</button></div><div class="sheet-body"></div>' +
    '</div></div>'
  )
  var body = sheet.querySelector('.sheet-body')
  var close = function () { sheet.remove(); if (DETAIL_ID === p.id) renderDetail(p.id, true) }
  sheet.querySelector('.sheet-x').addEventListener('click', close)
  sheet.addEventListener('click', function (e) { if (e.target === sheet) close() })

  function rebuild() {
    body.innerHTML = ''
    var cards = projectContactCards(p)
    if (!cards.length) body.appendChild(el('<div class="empty" style="padding:14px">Nobody on this project yet.</div>'))
    cards.forEach(function (row) {
      var card = el('<div class="card contactcard"></div>')
      var head = el('<div class="cc-head"></div>')
      head.appendChild(el('<div class="name" style="font-size:14.5px;flex:1;min-width:0">' + esc(row.name) +
        (row.primary && cards.length > 1 ? '<span class="cc-primary">Primary</span>' : '') + '</div>'))
      // Every card can be removed, primary included. A linked contact loses its join row; a
      // text-only one (a project that never had links) clears the project's contact fields, since
      // that text IS the whole record. Nothing on this sheet is undeletable.
      var x = el('<button class="cc-x" aria-label="Remove from project"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button>')
      x.addEventListener('click', function () {
        if (row.id) { detachContactFromProject(p, row.contact, rebuild); return }
        if (!confirm('Remove ' + row.name + ' from "' + p.client + '"?\n\nThis project has no linked contact record, so this just clears the name, email and phone stored on the project.')) return
        doWrite(Promise.all([
          updateProjectField(p.id, 'contactNames', '').then(function (r) { p.contactNames = r.value }),
          updateProjectField(p.id, 'contactEmails', '').then(function (r) { p.contactEmails = r.value }),
          updateProjectField(p.id, 'contactPhones', '').then(function (r) { p.contactPhones = r.value }),
        ]), 'Contact removed', rebuild)
      })
      head.appendChild(x)
      card.appendChild(head)
      var sub = [row.emails.join(', '), row.phones.join(', ')].filter(Boolean)
      sub.forEach(function (line) { card.appendChild(el('<div class="meta">' + esc(line) + '</div>')) })
      body.appendChild(card)
    })
    var add = el('<button class="btn-gold" style="width:100%;margin-top:14px">Add contact</button>')
    add.addEventListener('click', function () { openAddContact(p, rebuild) })
    body.appendChild(add)
  }
  rebuild()
  document.body.appendChild(sheet)
}

// Details: all the editable event fields.
// Every event field, each one a real text box showing its current value.
//
// It used to be a compact tap-to-reveal list: label on the left, value hidden until you opened that
// one row. That fits more on screen and is worse to actually use. Michael's point (2026-08-05): he
// wants to READ the guest count without opening the guest count, and would rather scroll a longer
// list than play hide and seek with fourteen fields.
//
// So: full-width inputs, always showing their value, saved on blur. The header is pinned with a real
// X, because the old way out was tapping the few pixels of backdrop above the sheet.
function openDetailsPanel(p) {
  var sheet = el(
    '<div class="sheet"><div class="sheet-card sheet-tall">' +
      '<div class="sheet-head"><div class="sheet-title">Event details</div>' +
      '<button class="sheet-x" aria-label="Close">' +
      '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>' +
      '</button></div>' +
      '<div class="sheet-body"></div>' +
    '</div></div>'
  )
  var body = sheet.querySelector('.sheet-body')
  var dirty = false
  var close = function () { sheet.remove(); if (dirty) renderDetail(p.id, true) }

  var fLabels = SNAP.eventFieldLabels || {}, fHidden = SNAP.eventFieldHidden || [], fDeleted = SNAP.eventFieldDeleted || []
  EDITABLE_DETAIL_FIELDS.forEach(function (f) {
    var key = f[0], label = fLabels[f[0]] || f[1], kind = f[2]
    if (fHidden.indexOf(key) >= 0 || fDeleted.indexOf(key) >= 0) return
    var cur = key === 'projectName' ? (p.client || '') : (p[key] == null ? '' : String(p[key]))
    var fld = el('<div class="fld"><div class="fld-l">' + esc(label) + '</div></div>')
    var input
    if (kind === 'select') {
      // A fixed list the CLIENT also picks from on the booking form, so the two must agree. Any
      // older free-text value is kept as an extra option rather than silently dropped.
      input = document.createElement('select')
      var opts = [''].concat(f[3] || [])
      if (cur && opts.indexOf(cur) < 0) opts.push(cur)
      opts.forEach(function (o) {
        var el2 = document.createElement('option')
        el2.value = o
        el2.textContent = o || 'Not set'
        input.appendChild(el2)
      })
    } else {
      input = kind === 'textarea' ? document.createElement('textarea') : document.createElement('input')
    }
    input.className = 'field-input'
    input.value = cur
    if (kind === 'date') input.type = 'date'
    if (kind === 'money') input.inputMode = 'decimal'
    if (kind === 'textarea') input.rows = 3
    if (kind !== 'select') input.placeholder = 'Not set'
    // Save on blur only, and only when it actually changed. Saving per keystroke would fire a write
    // for every letter typed on a phone keyboard.
    if (TIME_FIELDS[key]) input.placeholder = 'e.g. 6:30 PM'
    var save = function () {
      var nv = TIME_FIELDS[key] ? to12h(input.value) : input.value
      input.value = nv
      if (nv === cur) return
      doWrite(updateProjectField(p.id, key, nv), 'Saved', function (r) {
        if (key === 'projectName') p.client = r.value; else p[key] = r.value
        cur = r.value == null ? '' : String(r.value)
        input.value = cur
        dirty = true
      }).catch(function () { input.value = cur })
    }
    // A dropdown commits on change; a typed field waits for blur, because saving per keystroke
    // would fire a write for every letter typed on a phone keyboard.
    input.addEventListener(kind === 'select' ? 'change' : 'blur', save)
    fld.appendChild(input)
    body.appendChild(fld)
  })

  var done = el('<button class="btn-gold" style="width:100%;margin-top:6px">Done</button>')
  done.addEventListener('click', close)
  body.appendChild(done)

  sheet.querySelector('.sheet-x').addEventListener('click', close)
  sheet.addEventListener('click', function (e) { if (e.target === sheet) close() })
  document.body.appendChild(sheet)
}

// Render (or re-render) a project's activity log into `wrap`.
function renderLog(wrap, p) {
  wrap.innerHTML = ''
  wrap.id = 'log-' + p.id
  var lines = (Array.isArray(p.activityLog) ? p.activityLog : []).map(function (line, i) {
    var text = typeof line === 'string' ? line : (line && line.text) || JSON.stringify(line)
    var t = Date.parse(String(text).split(':')[0])
    return { text: text, t: isFinite(t) ? t : -Infinity, i: i }
  })
  if (!lines.length) { wrap.appendChild(el('<div class="empty" style="padding:10px">No activity yet.</div>')); return }
  // Newest first by the date each line carries (the Mac sorts the same way); undated lines keep their place.
  lines.sort(function (a, b) { return a.t === b.t ? a.i - b.i : b.t - a.t })
  var showAll = wrap.dataset.all === '1'
  lines.slice(0, showAll ? lines.length : 25).forEach(function (l) { wrap.appendChild(el('<div class="log">' + esc(l.text) + '</div>')) })
  if (!showAll && lines.length > 25) {
    var more = el('<button class="linkbtn" style="margin:6px 2px">Show all ' + lines.length + '</button>')
    more.addEventListener('click', function () { wrap.dataset.all = '1'; renderLog(wrap, p) })
    wrap.appendChild(more)
  }
}

// The allow-listed editable event fields, in a sensible order. Each maps a camelCase project key to a
// label + input kind. Only SAFE fields (never client_name).
var EDITABLE_DETAIL_FIELDS = [
  ['projectName', 'Display name', 'text'],
  ['eventType', 'Event type', 'select', ['Wedding', 'Corporate', 'Private Event', 'Bachelor(ette) Party', 'Other']],
  // The Mac's "Description" is event_summary. The phone's editor used to label event_description
  // as Description, so the summary shown at the top of Details could not be changed from the phone.
  // event_description is the longer write-up and is edited on the Notes tab.
  ['eventSummary', 'Description', 'textarea'],
  ['eventDate', 'Event date', 'date'],
  ['leadDate', 'Lead date', 'date'],
  // Arrival time. Present in the desktop's EVENT_FIELDS since the beginning and missing from the
  // phone's until 2026-09-21, which meant the one time that decides when Michael leaves the house
  // was the one time he could not read or set from his phone.
  ['arrivalTime', 'Arrival time', 'text'],
  ['eventStartTime', 'Event start', 'text'],
  ['showStartTime', 'Show start', 'text'],
  // Private: when he leaves the house and gets back. They block his calendar for the whole trip.
  ['leaveHomeTime', 'Leave home', 'text'],
  ['backHomeTime', 'Back home', 'text'],
  // The QUOTE. Missing from this list until 2026-08-05, which meant the phone blocked "Ready to book"
  // on a field the phone gave you no way to fill.
  ['totalFee', 'Quote', 'money'],
  ['numberOfGuests', 'Guest count', 'text'],
  ['ageOfGuests', 'Guest ages', 'text'],
  ['eventLocation', 'Location', 'text'],
  ['venueType', 'Venue type', 'text'],
  // Fixed choices, matching BOOKING_FIELDS in crm-booking-form.mjs and src/eventFields.ts. The
  // client picks from this same list on the booking form and the answer writes straight onto the
  // project, so the two lists have to stay identical.
  ['indoorsOrOutdoors', 'Indoors / Outdoors', 'select', ['Indoors', 'Outdoors', 'Both']],
  ['performanceStyle', 'Performance', 'text'],
  ['av', 'AV', 'text'],
  ['vips', 'VIPs', 'text'],
  ['bookingSource', 'Booking source', 'text'],
]
// The "add a note" box: appends a dated line to the activity log (newest first).
function addNoteBox(p) {
  var wrap = el('<div class="addform"><textarea class="field-input" id="note-in" rows="2" placeholder="Add a note to the activity log…"></textarea><div class="addrow"><span></span><button class="btn-gold" id="note-save">Add note</button></div></div>')
  wrap.querySelector('#note-save').addEventListener('click', function () {
    var text = wrap.querySelector('#note-in').value.trim()
    if (!text) { toast('Enter a note.', 'err'); return }
    doWrite(addNote(p.id, text), 'Note added', function (r) {
      p.activityLog = r.activityLog
      var lw = $('#log-' + p.id)
      if (lw) renderLog(lw, p)
      wrap.querySelector('#note-in').value = ''
    })
  })
  return wrap
}

// The "log a payment" form: amount + date + type + method. A dated payment satisfies the Booked gate.
// onDone (optional) runs after the ledger refresh instead of a full page re-render (used by the panel).
function addPaymentForm(p, onDone) {
  var wrap = el(
    '<div class="addform">' +
      '<input class="field-input" id="pay-amt" inputmode="decimal" placeholder="Amount (e.g. 500)" />' +
      '<div class="addrow"><input class="field-input" id="pay-date" type="date" /></div>' +
      '<div class="addrow">' +
        '<select class="field-input" id="pay-type"><option value="deposit">Deposit</option><option value="balance">Balance</option><option value="full">Paid in full</option><option value="other">Other</option></select>' +
        '<select class="field-input" id="pay-method"><option value="">Method…</option><option>QuickBooks invoice</option><option>HoneyBook</option><option>Cash</option><option>Check</option><option>PayPal</option><option>Venmo</option><option>CashApp</option><option>Zelle</option><option>Bank transfer (ACH)</option></select>' +
      '</div>' +
      '<label class="pendrow"><input type="checkbox" id="pay-pending" /> Amount known, no date yet (pending)</label>' +
      '<div class="addrow"><button class="btn-ghost" id="pay-cancel">Cancel</button><button class="btn-gold" id="pay-save">Log payment</button></div>' +
    '</div>'
  )
  wrap.querySelector('#pay-date').value = todayStr()
  var pend = wrap.querySelector('#pay-pending')
  pend.addEventListener('change', function () { wrap.querySelector('#pay-date').disabled = pend.checked })
  wrap.querySelector('#pay-cancel').addEventListener('click', function () { wrap.remove() })
  wrap.querySelector('#pay-save').addEventListener('click', function () {
    var amt = wrap.querySelector('#pay-amt').value.trim()
    if (!amt || isNaN(Number(amt.replace(/[^0-9.\-]/g, '')))) { toast('Enter a valid amount.', 'err'); return }
    var pending = pend.checked
    doWrite(addPayment({
      projectId: p.id,
      amount: amt,
      dateReceived: pending ? '' : (wrap.querySelector('#pay-date').value || ''),
      type: wrap.querySelector('#pay-type').value,
      method: wrap.querySelector('#pay-method').value,
      pending: pending,
    }), 'Payment logged', function () {
      // Refresh the ledger + finance so Money, the stage gate, and the caller see the new payment.
      var after = onDone || function () { renderDetail(p.id) }
      reloadPaymentsFinance(SNAP.projects, SNAP.config).then(function (r) {
        SNAP.payments = r.payments
        SNAP.finance = r.finance
        after()
      }).catch(after)
    })
  })
  return wrap
}

// Suggest people Michael already knows, instead of making him retype them.
//
// The phone stored contact details as free text on the project and offered no lookup at all, so
// adding "Jack Kelly" to a new project meant typing his name, email and phone from memory even
// though the contact was already in the CRM. Worse than tedious: a typo'd email is the difference
// between a booking form arriving and not.
//
// Deliberately a plain list rather than <datalist>: datalist rendering on iOS Safari is inconsistent
// and cannot show the email underneath, which is the bit that tells two similarly-named people apart.
//
// Picking someone fills the other fields too, via onPick. Michael can still type a name that matches
// nobody; this only ever offers, never restricts.
// Pull the contact list again after we have added one, so the next suggestion box knows about the
// person just created without waiting for a full app reload. Silent on failure: a stale suggestion
// list is a minor annoyance, an error toast about it would be noise.
function refreshContactsCache() {
  return loadContacts()
    .then(function (list) { if (SNAP) SNAP.contacts = list })
    .catch(function () {})
}


// Every contact record linked to a project, in link order. The join table (contact_links) is the
// truth here, exactly as on the Mac: a project can have any number of people on it.
function contactsForProject(p) {
  var ids = ((SNAP && SNAP.links) || {})[p.id] || []
  var byId = {}
  ;((SNAP && SNAP.contacts) || []).forEach(function (c) { byId[c.id] = c })
  return ids.map(function (id) { return byId[id] }).filter(Boolean)
}

// Re-read the join table after a link/unlink so the card list matches the database. Silent on
// failure for the same reason as refreshContactsCache: a stale list is a nuisance, a toast is noise.
function refreshLinksCache() {
  return loadLinks()
    .then(function (m) { if (SNAP) SNAP.links = m })
    .catch(function () {})
}

// Optimistic local edits to SNAP.links, so the UI updates on tap instead of after a round trip.
function noteLinkLocally(projectId, contactId) {
  if (!SNAP) return
  SNAP.links = SNAP.links || {}
  var ids = SNAP.links[projectId] || []
  if (ids.indexOf(contactId) < 0) ids = ids.concat([contactId])
  SNAP.links[projectId] = ids
}

// A contact that was just CREATED is not in the local contacts cache yet, and contactsForProject
// resolves ids through that cache. Without this, adding a brand-new person linked them correctly but
// showed nothing until the background refresh landed, which reads as "it didn't work". Provisional
// row; the refresh overwrites it with the real one moments later.
function noteContactLocally(id, chosen) {
  if (!SNAP || !id) return
  SNAP.contacts = SNAP.contacts || []
  if (SNAP.contacts.some(function (c) { return c.id === id })) return
  SNAP.contacts = SNAP.contacts.concat([{
    id: id,
    name: chosen.name || '',
    emails: chosen.email ? [chosen.email] : [],
    phones: chosen.phone ? [chosen.phone] : [],
    type: 'Client', relationship: 'active', engagement: '', tags: [], notes: '',
  }])
}
function forgetLinkLocally(projectId, contactId) {
  if (!SNAP || !SNAP.links) return
  SNAP.links[projectId] = (SNAP.links[projectId] || []).filter(function (x) { return x !== contactId })
}

// CONTACT PICKER: choose someone already in the CRM, or create a new one. Mirrors the Mac's
// ProjectContactPickerModal, including the "+ Create a new contact" escape hatch at the bottom.
//
// The phone used to offer only "Edit contact info": three free-text boxes where you retyped a name,
// an email and a phone that the CRM already knew, with no link to the contact record. Michael's words
// (2026-08-05): "this makes no sense". He was right. A contact is one thing, not three strings.
//
// Generic on purpose (2026-08-06): the project detail view and the New-project sheet both open it.
// The sheet has no project yet, so this only COLLECTS a choice; what to do with it is the caller's
// business. onChoose gets { contact, name, email, phone } where contact is null for a brand-new one.
function openContactPicker(opts) {
  var o = opts || {}
  var exclude = o.excludeIds || {}
  var sheet = el(
    '<div class="sheet"><div class="sheet-card sheet-tall">' +
      '<div class="sheet-head"><div class="sheet-title">' + esc(o.title || 'Add contact') + '</div>' +
      '<button class="sheet-x" aria-label="Close">' +
      '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>' +
      '</button></div><div class="sheet-body"></div>' +
    '</div></div>'
  )
  var body = sheet.querySelector('.sheet-body')
  var close = function () { sheet.remove(); if (o.onClose) o.onClose() }
  sheet.querySelector('.sheet-x').addEventListener('click', close)
  sheet.addEventListener('click', function (e) { if (e.target === sheet) close() })

  function choose(contact, name, email, phone) {
    sheet.remove()
    if (o.onChoose) o.onChoose({ contact: contact || null, name: name, email: email, phone: phone })
  }

  function drawPick() {
    body.innerHTML = ''
    body.appendChild(el('<div class="fld-l" style="margin-bottom:8px">Choose someone already in the CRM</div>'))
    var search = document.createElement('input')
    search.className = 'field-input'
    search.placeholder = 'Search contacts…'
    body.appendChild(search)
    var list = el('<div style="margin-top:8px"></div>')
    body.appendChild(list)

    function draw() {
      var q = String(search.value || '').trim().toLowerCase()
      // Anyone already on this project is filtered out: offering to add them twice is a dead end.
      var all = ((SNAP && SNAP.contacts) || []).filter(function (c) { return !exclude[c.id] })
      var hits = q
        ? all.filter(function (c) { return ((c.name || '') + ' ' + (c.emails || []).join(' ')).toLowerCase().indexOf(q) >= 0 })
        : all
      hits.sort(function (a, b) { return (a.name || '').toLowerCase() < (b.name || '').toLowerCase() ? -1 : 1 })
      list.innerHTML = ''
      if (!hits.length) {
        list.appendChild(el('<div class="empty" style="padding:16px">' + (q ? 'No matching contacts.' : 'No other contacts to add.') + '</div>'))
        return
      }
      hits.slice(0, 40).forEach(function (c) {
        var sub = [(c.emails || [])[0], (c.phones || [])[0]].filter(Boolean).join('  ·  ')
        var row = el('<button class="card" style="margin-bottom:6px"><div class="name" style="font-size:14.5px">' + esc(c.name || '(no name)') + '</div>' +
          (sub ? '<div class="meta">' + esc(sub) + '</div>' : '') + '</button>')
        row.addEventListener('click', function () {
          choose(c, c.name || '', (c.emails || [])[0] || '', (c.phones || [])[0] || '')
        })
        list.appendChild(row)
      })
    }
    search.addEventListener('input', draw)
    draw()

    var newBtn = el('<button class="btn-gold" style="width:100%;margin-top:14px">+ Create a new contact</button>')
    newBtn.addEventListener('click', drawNew)
    body.appendChild(newBtn)
  }

  function drawNew() {
    body.innerHTML = ''
    body.appendChild(el('<div class="fld-l" style="margin-bottom:8px">New contact</div>'))
    var nameIn = document.createElement('input'); nameIn.className = 'field-input'; nameIn.placeholder = 'Name  *'
    var emIn = document.createElement('input'); emIn.className = 'field-input'; emIn.placeholder = 'Email'; emIn.inputMode = 'email'; emIn.style.marginTop = '8px'
    var phIn = document.createElement('input'); phIn.className = 'field-input'; phIn.placeholder = 'Phone'; phIn.inputMode = 'tel'; phIn.style.marginTop = '8px'
    body.appendChild(nameIn); body.appendChild(emIn); body.appendChild(phIn)
    body.appendChild(el('<div class="hint">' + esc(o.createHint || 'This creates a contact in the CRM and attaches it to this project. Phone numbers are auto-formatted.') + '</div>'))

    var save = el('<button class="btn-gold" style="width:100%;margin-top:14px">' + esc(o.createLabel || 'Create and attach') + '</button>')
    save.addEventListener('click', function () {
      var name = nameIn.value.trim()
      if (!name) { toast('Enter a name.', 'err'); return }
      choose(null, name, emIn.value.trim(), phIn.value.trim())
    })
    body.appendChild(save)

    var back = el('<button class="btn-ghost" style="width:100%;margin-top:8px">Back to existing contacts</button>')
    back.addEventListener('click', drawPick)
    body.appendChild(back)
  }

  drawPick()
  document.body.appendChild(sheet)
}

// Add a contact to a project: always an ADD, never a replace.
//
// The project's own contact_names / contact_emails / contact_phones columns hold the PRIMARY contact
// only. That is the person the booking form, the contract and the QuickBooks invoice are addressed
// to (see clientEmailFor in crm-booking-form.mjs), so they are written only when the project has no
// primary yet. Everyone added after that is a join row and nothing else, which is exactly what the
// desktop's linkContactToProject does. Adding a second contact must never silently re-address a
// contract at them.
function attachContactToProject(p, chosen, after) {
  var redraw = after || function () { if (DETAIL_ID === p.id) renderDetail(p.id, true) }
  // "First person on the project" means the first LINK, not "the text field happens to be empty".
  var isFirst = contactsForProject(p).length === 0
  doWrite(
    linkOrCreateContact(p.id, {
      contactId: chosen.contact ? chosen.contact.id : '',
      name: chosen.name,
      email: chosen.email,
      phone: chosen.phone,
    }).then(function (r) {
      if (!r || !r.ok) return r
      noteContactLocally(r.contactId, chosen)
      noteLinkLocally(p.id, r.contactId)
      if (isFirst) {
        // The first contact becomes the primary, so the paperwork is addressed to them.
        return Promise.all([
          updateProjectField(p.id, 'contactNames', chosen.name).then(function (x) { p.contactNames = x.value }),
          updateProjectField(p.id, 'contactEmails', chosen.email).then(function (x) { p.contactEmails = x.value }),
          updateProjectField(p.id, 'contactPhones', chosen.phone).then(function (x) { p.contactPhones = x.value }),
        ]).then(function () { return r })
      }
      return r
    }),
    'Contact added',
    function () {
      Promise.all([refreshContactsCache(), refreshLinksCache()]).then(redraw)
      redraw()
    },
  )
}

// Remove a contact from a project. Unlinks only: the contact record survives, because the same
// person is usually on other projects too.
//
// ANY contact can be removed, the primary included. Removing the primary promotes the next one into
// the project's contact fields; removing the last one clears them. Michael, 2026-08-06: "it doesn't
// make any sense that I can't delete it. I should be able to just delete the primary contact, and
// then the other contact will, by default, become the primary contact."
function detachContactFromProject(p, contact, after) {
  if (!confirm('Remove ' + (contact.name || 'this contact') + ' from "' + p.client + '"?\n\nThey stay in your Contacts, they are just no longer on this project.')) return
  var redraw = after || function () { if (DETAIL_ID === p.id) renderDetail(p.id, true) }
  // Primary is a POSITION (first link), not a name match against the text fields.
  var before = contactsForProject(p)
  var wasPrimary = before.length > 0 && before[0].id === contact.id
  doWrite(
    unlinkContact(p.id, contact.id).then(function () {
      forgetLinkLocally(p.id, contact.id)
      if (!wasPrimary) return
      var next = contactsForProject(p)[0] // recomputed: whoever is first now
      return Promise.all([
        updateProjectField(p.id, 'contactNames', next ? next.name || '' : '').then(function (x) { p.contactNames = x.value }),
        updateProjectField(p.id, 'contactEmails', next ? (next.emails || [])[0] || '' : '').then(function (x) { p.contactEmails = x.value }),
        updateProjectField(p.id, 'contactPhones', next ? (next.phones || [])[0] || '' : '').then(function (x) { p.contactPhones = x.value }),
      ])
    }),
    'Contact removed',
    function () {
      refreshLinksCache().then(redraw)
      redraw()
    },
  )
}

function openAddContact(p, after) {
  var exclude = {}
  contactsForProject(p).forEach(function (c) { exclude[c.id] = true })
  openContactPicker({
    title: 'Add contact',
    excludeIds: exclude,
    onChoose: function (chosen) { attachContactToProject(p, chosen, after) },
  })
}

// A task row with a tap-to-toggle checkbox on the left, the title/meta in the middle (tapping the
// body opens the project when showProject), and a delete (x) on the right. Toggling checks it off
// (crm rule: done=true), which removes it from the open lists on the next render.
function taskCard(t, showProject, onChange) {
  var after = onChange || refreshView
  var st = dueState(t.dueDate, t.dueTime)
  var pName = ''
  if (showProject) { var pr = SNAP.projects.find(function (x) { return x.id === t.projectId }); pName = pr ? pr.client : t.projectId }
  var c = el(
    '<div class="card taskrow' + (t.done ? ' done' : '') + '">' +
      '<button class="check" aria-label="Toggle done">' +
        (t.done ? '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>' : '') +
      '</button>' +
      '<div class="taskbody">' +
        '<div class="name" style="font-size:14.5px">' + esc(t.title || 'Task') + '</div>' +
        (showProject && pName ? '<div class="meta">' + esc(pName) + '</div>' : '') +
        (t.dueDate ? '<span class="pill ' + (st || '') + '">' + (st === 'overdue' ? 'Overdue · ' : st === 'due' ? 'Due today' : 'Due ') + (st === 'due' ? '' : esc(fmtShort(t.dueDate))) + (t.dueTime ? esc(' · ' + to12h(t.dueTime)) : '') + '</span>' : '') +
      '</div>' +
      '<button class="taskdel" aria-label="Delete task"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button>' +
    '</div>'
  )
  var check = c.querySelector('.check')
  check.addEventListener('click', function (ev) {
    ev.stopPropagation()
    var next = !t.done
    doWrite(toggleTask(t.id, next), next ? 'Task done' : 'Task reopened', function () {
      t.done = next // optimistic; SNAP.tasks holds the same object reference
      after()
    })
  })
  var del = c.querySelector('.taskdel')
  del.addEventListener('click', function (ev) {
    ev.stopPropagation()
    if (!confirm('Delete this task?')) return
    doWrite(deleteTask(t.id), 'Task deleted', function () {
      SNAP.tasks = SNAP.tasks.filter(function (x) { return x.id !== t.id })
      after()
    })
  })
  // Tapping the task opens the editor, on the Tasks page AND inside a project. It used to open the
  // project on one screen and do nothing on the other, so the only thing you could do to a task
  // from the phone was tick it or bin it. Michael, 2026-09-21: "I want to... go through all of my
  // tasks easily, both in the overview task view and in the individual project view." Going
  // through them means rescheduling them, which needs somewhere to do it.
  c.querySelector('.taskbody').addEventListener('click', function () { openTaskEditor(t, after) })
  return c
}

// One task, editable: retitle, reschedule, jump to its project, delete. The quick-date row is the
// part that matters for his morning pass, because "not today" is the most common answer to a task
// and it should not cost a date picker.
function openTaskEditor(t, after) {
  var refresh = after || refreshView
  var pr = t.projectId ? SNAP.projects.find(function (x) { return x.id === t.projectId }) : null
  var sheet = el(
    '<div class="sheet"><div class="sheet-card">' +
      '<div class="sheet-head"><div class="sheet-title">Task</div>' +
      '<button class="sheet-x" aria-label="Close">' +
      '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>' +
      '</button></div><div class="sheet-body"></div>' +
    '</div></div>'
  )
  var body = sheet.querySelector('.sheet-body')
  var close = function () { sheet.remove() }
  sheet.querySelector('.sheet-x').addEventListener('click', close)
  sheet.addEventListener('click', function (e) { if (e.target === sheet) close() })

  var title = document.createElement('textarea')
  title.className = 'field-input'
  title.rows = 2
  title.value = t.title || ''
  body.appendChild(el('<div class="do-l" style="margin-bottom:6px">Task</div>'))
  body.appendChild(title)

  body.appendChild(el('<div class="do-l" style="margin:14px 0 6px">Due</div>'))
  var when = el('<div class="addrow"></div>')
  var dIn = document.createElement('input'); dIn.className = 'search'; dIn.type = 'date'; dIn.value = t.dueDate || ''
  var tIn = document.createElement('input'); tIn.className = 'search'; tIn.type = 'time'; tIn.value = t.dueTime || ''
  when.appendChild(dIn); when.appendChild(tIn)
  body.appendChild(when)

  var quick = el('<div class="do-actions" style="margin-top:9px"></div>')
  ;[['Today', 0], ['Tomorrow', 1], ['+1 week', 7], ['Clear', null]].forEach(function (q) {
    var b = el('<button class="do-alt" style="padding:8px 4px;font-size:12.5px">' + esc(q[0]) + '</button>')
    b.addEventListener('click', function () {
      dIn.value = q[1] == null ? '' : addDays(todayStr(), q[1])
      if (q[1] == null) tIn.value = ''
    })
    quick.appendChild(b)
  })
  body.appendChild(quick)

  if (pr) {
    var go = el('<button class="btn-ghost" style="width:100%;margin-top:14px">Open ' + esc(pr.client) + '</button>')
    go.addEventListener('click', function () { close(); renderDetail(pr.id) })
    body.appendChild(go)
  }

  var bar = el('<div class="addrow" style="margin-top:14px"><button class="btn-ghost">Cancel</button><button class="btn-gold">Save</button></div>')
  bar.children[0].addEventListener('click', close)
  bar.children[1].addEventListener('click', function () {
    var nt = title.value.trim()
    if (!nt) { toast('A task needs a title.', 'err'); return }
    // Every field is sent, including the blanks: updateTask treats null as "leave alone" and a
    // string as "set to this", so clearing a due date has to be an empty STRING, not an omission.
    doWrite(updateTask({ id: t.id, title: nt, dueDate: dIn.value || '', dueTime: tIn.value || '' }), 'Task saved', function () {
      t.title = nt; t.dueDate = dIn.value || ''; t.dueTime = tIn.value || ''
      close(); refresh()
    })
  })
  body.appendChild(bar)

  var del = el('<button class="btn-ghost" style="width:100%;margin-top:9px;color:var(--red);border-color:color-mix(in oklab,var(--red) 40%, var(--line))">Delete task</button>')
  del.addEventListener('click', function () {
    doWrite(deleteTask(t.id), 'Task deleted', function () {
      SNAP.tasks = SNAP.tasks.filter(function (x) { return x.id !== t.id })
      close(); refresh()
    })
  })
  body.appendChild(del)

  document.body.appendChild(sheet)
}

// A minimal add-task form (title + optional due date/time), used both on the Tasks tab (no project)
// and inside a project detail (projectId prefilled). onDone(newTask) fires after a successful add.
function addTaskForm(projectId, onDone) {
  var wrap = el(
    '<div class="addform">' +
      '<input class="search" id="nt-title" placeholder="New task…" />' +
      '<div class="addrow">' +
        '<input class="search" id="nt-date" type="date" />' +
        '<input class="search" id="nt-time" type="time" />' +
      '</div>' +
      '<div class="addrow">' +
        '<button class="btn-ghost" id="nt-cancel">Cancel</button>' +
        '<button class="btn-gold" id="nt-save">Add task</button>' +
      '</div>' +
    '</div>'
  )
  var close = function () { wrap.remove() }
  wrap.querySelector('#nt-cancel').addEventListener('click', close)
  wrap.querySelector('#nt-save').addEventListener('click', function () {
    var title = wrap.querySelector('#nt-title').value.trim()
    if (!title) { toast('Enter a task title.', 'err'); return }
    var dueDate = wrap.querySelector('#nt-date').value || ''
    var dueTime = wrap.querySelector('#nt-time').value || ''
    doWrite(addTask({ projectId: projectId || '', title: title, dueDate: dueDate, dueTime: dueTime }), 'Task added', function (nt) {
      SNAP.tasks.push(nt)
      close()
      if (onDone) onDone(nt)
      refreshView()
    })
  })
  setTimeout(function () { var e = wrap.querySelector('#nt-title'); if (e) e.focus() }, 40)
  return wrap
}

function renderTasks() {
  var v = $('#view'); v.innerHTML = ''
  // Header row: title + a "+" to add a task (no project attached from this tab).
  var head = el('<div class="tabhead"><span></span><button class="addbtn" id="add-task" aria-label="Add task"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>New task</button></div>')
  v.appendChild(head)
  var formSlot = el('<div id="taskform-slot"></div>')
  v.appendChild(formSlot)
  head.querySelector('#add-task').addEventListener('click', function () {
    if (formSlot.firstChild) { formSlot.innerHTML = ''; return }
    formSlot.appendChild(addTaskForm('', function () { /* render() re-runs; keep it simple */ }))
  })
  // The Mac splits project tasks from standalone ones into two columns; on a phone that is a switch.
  var seg = el('<div class="seg" style="margin:2px 0 6px"></div>')
  ;[['all', 'All'], ['project', 'Projects'], ['solo', 'Standalone']].forEach(function (o) {
    var b = el('<button class="segb' + (TASK_SPLIT === o[0] ? ' on' : '') + '">' + o[1] + '</button>')
    b.addEventListener('click', function () { if (TASK_SPLIT === o[0]) return; TASK_SPLIT = o[0]; renderTasks() })
    seg.appendChild(b)
  })
  v.appendChild(seg)
  // A deleted project's tasks are in the trash with it, not on the list.
  var deletedIds = {}
  ;(SNAP.projects || []).forEach(function (p) { if (p.bucket === 'deleted') deletedIds[p.id] = 1 })
  var pool = SNAP.tasks.filter(function (t) {
    if (t.projectId && deletedIds[t.projectId]) return false
    if (TASK_SPLIT === 'project') return !!t.projectId
    if (TASK_SPLIT === 'solo') return !t.projectId
    return true
  })
  var open = pool.filter(function (t) { return !t.done })
  var dated = open.filter(function (t) { return t.dueDate })
  dated.sort(function (a, b) { return a.dueDate < b.dueDate ? -1 : 1 })
  var overdue = dated.filter(function (t) { return dueState(t.dueDate, t.dueTime) === 'overdue' })
  var today = dated.filter(function (t) { return dueState(t.dueDate, t.dueTime) === 'due' })
  var upcoming = dated.filter(function (t) { return !dueState(t.dueDate, t.dueTime) })
  var nodate = open.filter(function (t) { return !t.dueDate })
  if (!open.length) v.appendChild(el('<div class="empty">No open tasks. Nice.</div>'))
  if (overdue.length) { v.appendChild(sectionLabel('Overdue · ' + overdue.length)); overdue.forEach(function (t) { v.appendChild(taskCard(t, true)) }) }
  if (today.length) { v.appendChild(sectionLabel('Today · ' + today.length)); today.forEach(function (t) { v.appendChild(taskCard(t, true)) }) }
  if (upcoming.length) { v.appendChild(sectionLabel('Upcoming · ' + upcoming.length)); upcoming.forEach(function (t) { v.appendChild(taskCard(t, true)) }) }
  if (nodate.length) { v.appendChild(sectionLabel('No due date · ' + nodate.length)); nodate.forEach(function (t) { v.appendChild(taskCard(t, true)) }) }
  v.appendChild(doneSection(pool.filter(function (t) { return t.done }), true))
  v.appendChild(scheduleSection())
}
var TASK_SPLIT = 'all'

// ---- recurring tasks (the Mac's TaskSchedules) ----
// "I don't like the idea of things not being transparent." Every repeat is a row he can see, pause,
// edit or delete. They run in the cloud, so neither the Mac nor the phone has to be open.
function scheduleSection() {
  var wrap = el('<div class="sched"></div>')
  var head = el('<div class="sched-head"><div><div class="sched-t">Recurring</div><div class="hint" style="margin:2px 0 0">These create themselves on a repeat, in the cloud.</div></div><button class="addbtn">+ New</button></div>')
  head.querySelector('.addbtn').addEventListener('click', function () { openScheduleSheet(null, draw) })
  wrap.appendChild(head)
  var list = el('<div><div class="empty" style="padding:10px 2px">Loading…</div></div>')
  wrap.appendChild(list)
  function draw() {
    loadTaskSchedules().then(function (rows) {
      list.innerHTML = ''
      if (!rows.length) { list.appendChild(el('<div class="empty" style="padding:10px 2px">Nothing scheduled.</div>')); return }
      rows.forEach(function (sc) {
        var pr = sc.projectId ? (SNAP.projects || []).find(function (p) { return p.id === sc.projectId }) : null
        var r = el('<div class="card sched-row' + (sc.active ? '' : ' paused') + '"><div class="sched-b"><div class="name" style="font-size:14.5px"></div><div class="meta"></div></div>' +
          '<div class="sched-acts"><button class="sched-pause"></button><button class="sched-edit">Edit</button></div></div>')
        r.querySelector('.name').textContent = sc.title
        r.querySelector('.meta').textContent = describeSchedule(sc) + (pr ? '  ·  ' + pr.client : '') + (sc.active ? '' : '  ·  Paused')
        var pb = r.querySelector('.sched-pause')
        pb.textContent = sc.active ? 'Pause' : 'Resume'
        pb.addEventListener('click', function () { doWrite(saveTaskSchedule(sc.id, { active: !sc.active }), sc.active ? 'Paused' : 'Resumed', draw) })
        r.querySelector('.sched-edit').addEventListener('click', function () { openScheduleSheet(sc, draw) })
        list.appendChild(r)
      })
    }).catch(function (e) { list.innerHTML = ''; list.appendChild(el('<div class="empty"></div>')).textContent = e.message || 'Could not load schedules.' })
  }
  draw()
  return wrap
}
function openScheduleSheet(sc, after) {
  var f = sc ? JSON.parse(JSON.stringify(sc)) : { title: '', projectId: '', frequency: 'weekly', daysOfWeek: [1], dayOfMonth: 1, runTime: '07:00', dueTime: '', active: true }
  if (!f.daysOfWeek || !f.daysOfWeek.length) f.daysOfWeek = [1]
  var sh = makeSheet(sc ? 'Edit schedule' : 'New schedule', true)
  var b = sh.body
  b.appendChild(el('<div class="do-l" style="margin-bottom:6px">Task title</div>'))
  var title = el('<input class="search" placeholder="What should appear on your list">'); title.value = f.title; b.appendChild(title)
  b.appendChild(el('<div class="do-l" style="margin:12px 0 6px">Project (optional)</div>'))
  var proj = el('<select class="field-input"><option value="">No project</option></select>')
  ;(SNAP.projects || []).filter(function (p) { return p.bucket === 'active' || p.id === f.projectId }).sort(function (x, y) { return x.client.localeCompare(y.client) })
    .forEach(function (p) { var o = el('<option></option>'); o.value = p.id; o.textContent = p.client; proj.appendChild(o) })
  proj.value = f.projectId || ''; b.appendChild(proj)
  b.appendChild(el('<div class="do-l" style="margin:12px 0 6px">How often</div>'))
  var freq = el('<div class="seg"></div>')
  var detail = el('<div style="margin-top:10px"></div>')
  SCHEDULE_FREQUENCIES.forEach(function (x) {
    var bt = el('<button class="segb">' + x[0].toUpperCase() + x.slice(1) + '</button>')
    bt.addEventListener('click', function () { f.frequency = x; paint() })
    freq.appendChild(bt)
  })
  b.appendChild(freq); b.appendChild(detail)
  function paint() {
    Array.prototype.forEach.call(freq.children, function (bt, i) { bt.classList.toggle('on', SCHEDULE_FREQUENCIES[i] === f.frequency) })
    detail.innerHTML = ''
    if (f.frequency === 'weekly') {
      var days = el('<div class="relrow"></div>')
      DAY_LABELS.forEach(function (d, i) {
        var iso = i + 1, on = f.daysOfWeek.indexOf(iso) >= 0
        var bt = el('<button class="relchip' + (on ? ' on on-plain' : '') + '">' + d + '</button>')
        bt.addEventListener('click', function () {
          f.daysOfWeek = on ? f.daysOfWeek.filter(function (n) { return n !== iso }) : f.daysOfWeek.concat([iso]).sort()
          paint()
        })
        days.appendChild(bt)
      })
      detail.appendChild(days)
    } else if (f.frequency === 'monthly') {
      detail.appendChild(el('<div class="do-l" style="margin-bottom:6px">Day of the month</div>'))
      var dom = el('<select class="field-input"></select>')
      for (var i = 1; i <= 31; i++) { var o = el('<option></option>'); o.value = String(i); o.textContent = String(i); dom.appendChild(o) }
      dom.value = String(f.dayOfMonth || 1)
      dom.addEventListener('change', function () { f.dayOfMonth = Number(dom.value) })
      detail.appendChild(dom)
    }
  }
  paint()
  var times = el('<div class="addrow" style="margin-top:12px;align-items:flex-end"><label style="flex:1"><div class="do-l" style="margin-bottom:6px">Appears at</div><input type="time" class="field-input"></label><label style="flex:1"><div class="do-l" style="margin-bottom:6px">Due at (optional)</div><input type="time" class="field-input"></label></div>')
  var runIn = times.querySelectorAll('input')[0], dueIn = times.querySelectorAll('input')[1]
  runIn.value = f.runTime || '07:00'; dueIn.value = f.dueTime || ''
  b.appendChild(times)
  var err = el('<div class="cmp-status bad"></div>'); b.appendChild(err)
  var bar = el('<div class="addrow" style="margin-top:14px"><button class="btn-ghost">Cancel</button><button class="btn-gold">Save</button></div>')
  bar.children[0].addEventListener('click', sh.close)
  bar.children[1].addEventListener('click', function () {
    f.title = title.value.trim(); f.projectId = proj.value; f.runTime = runIn.value || '07:00'; f.dueTime = dueIn.value || ''
    if (!f.title) { err.textContent = 'Give it a title.'; return }
    if (f.frequency === 'weekly' && !f.daysOfWeek.length) { err.textContent = 'Pick at least one day.'; return }
    doWrite(saveTaskSchedule(sc ? sc.id : '', f), 'Schedule saved', function () { sh.close(); after() })
  })
  b.appendChild(bar)
  if (sc) {
    var del = el('<button class="cmp-discard">Delete schedule</button>')
    del.addEventListener('click', function () {
      if (!confirm('Stop scheduling "' + sc.title + '"?\n\nTasks it has already created stay on your list. This only stops future ones.')) return
      doWrite(deleteTaskSchedule(sc.id), 'Schedule deleted', function () { sh.close(); after() })
    })
    b.appendChild(del)
  }
}

// The tasks he has already ticked, folded away. Not a report: a way BACK.
//
// A tapped checkbox removes a task from every list on the phone instantly, so a mis-tap while
// scrolling through a morning's worth of tasks used to be unrecoverable without the laptop. The
// tasks table has no completion timestamp, so this cannot honestly claim to be "done today" and
// does not try; it is just "done", newest due date first, capped at 25.
function doneSection(done, showProject) {
  var wrap = el('<div></div>')
  if (!done.length) return wrap
  var open = false
  var head = el('<button class="donehead"><span>Done · ' + done.length + '</span><span class="donechev">Show</span></button>')
  var list = el('<div style="display:none"></div>')
  done.slice().sort(function (a, b) { return String(b.dueDate || '').localeCompare(String(a.dueDate || '')) })
    .slice(0, 25)
    .forEach(function (t) { list.appendChild(taskCard(t, showProject)) })
  head.addEventListener('click', function () {
    open = !open
    list.style.display = open ? '' : 'none'
    head.querySelector('.donechev').textContent = open ? 'Hide' : 'Show'
  })
  wrap.appendChild(head)
  wrap.appendChild(list)
  return wrap
}

// ================================ EMAIL ================================
//
// Michael, 2026-09-21: "I want to read and send emails. I often send emails from the client's
// project page... but the inbox page is still good because I want to be able to see notifications
// when I have unread emails."
//
// Two entry points, one engine:
//   - INBOX, a page: everything, newest first, unread called out.
//   - PROJECT > Email, a tab: only the correspondence with THAT client, plus a compose box already
//     addressed to them. This is the one he says he actually uses.
//
// Both read through the `gmail` Edge Function. Sending goes through `send-email`, which already
// existed and already records the sent message against the project.

// Threads are cached per query so switching tabs and coming back is instant and does not spend a
// Gmail quota unit. 90 seconds, because an inbox that is a minute and a half stale is fine and a
// pull-to-refresh he has to think about is not.
var MAIL_CACHE = {}
var MAIL_TTL_MS = 90 * 1000
function mailFetch(q, max, cb) {
  var key = (Array.isArray(q) ? q.join('~') : q) + '|' + max
  var hit = MAIL_CACHE[key]
  if (hit && Date.now() - hit.at < MAIL_TTL_MS) { cb(null, hit.threads); return }
  gmailList({ q: q, max: max })
    .then(function (threads) { MAIL_CACHE[key] = { at: Date.now(), threads: threads }; cb(null, threads) })
    .catch(function (e) { cb(e) })
}
function mailForget() { MAIL_CACHE = {} }

// "3:42 PM" today, "Sep 14" this year, "Sep 14 2024" beyond. Same shape Mail uses, for the same
// reason: the older a message is, the less its time of day matters.
function mailWhen(ts) {
  var d = new Date(Number(ts) || 0)
  if (!ts || isNaN(d.getTime())) return ''
  var now = new Date()
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// Every email address that belongs to a project: its own contact_emails column plus every linked
// contact's addresses. Lower-cased, de-duplicated. This is what decides whether a thread is "about"
// a client, and it runs HERE rather than in the Edge Function because the phone already holds all
// of it in memory and a second copy on the server would be a second thing to keep in step.
function projectEmails(p) {
  var out = {}
  ;(p.contactEmails || '').split(/[,;]/).forEach(function (e) {
    var v = e.trim().toLowerCase(); if (v) out[v] = 1
  })
  contactsForProject(p).forEach(function (c) {
    ;(c.emails || []).forEach(function (e) { var v = String(e).trim().toLowerCase(); if (v) out[v] = 1 })
  })
  return Object.keys(out)
}

// projectId for a thread, or '' when it belongs to nobody in the CRM. Built once per render rather
// than per row: with a few hundred projects and a few dozen threads, doing it per row is a few
// thousand string comparisons for an answer that does not change.
//
// ACTIVE PROJECTS FIRST, then everything else. Mirrors unreadByProject in crm-gmail.mjs: first wins,
// so a contact who appears on both a live job and an old archived one is attributed to the live one
// rather than to whichever the loop happened to reach first.
function emailToProjectIndex() {
  var ix = {}
  // SNAP is null until the first load finishes, and the mail poll starts at the same moment.
  var all = (SNAP && SNAP.projects) || []
  var ordered = all.filter(function (p) { return p.bucket === 'active' })
    .concat(all.filter(function (p) { return p.bucket !== 'active' }))
  ordered.forEach(function (p) {
    projectEmails(p).forEach(function (e) { if (!ix[e]) ix[e] = p.id })
  })
  return ix
}

// ---- WHOSE MAIL THE INBOX SHOWS ----
//
// Michael, 2026-09-21: "it's pulling in my entire Gmail inbox... that's not how the CRM on my
// laptop works. It only shows me emails that are sent to or from contacts in my active projects.
// I don't want things like Bark updates or GigSalad or any of that nonsense."
//
// So the Inbox is not a mailbox, it is a CLIENT CORRESPONDENCE view. The scope is every email
// address belonging to a contact on an ACTIVE project, and a thread qualifies if it was sent to OR
// from one of them. His own sent mail counts, which is the point: this is the conversation, not the
// arrivals board.
//
// Why it is chunked. Gmail caps a query at roughly 2,000 characters. Thirty addresses written twice
// (once under from:, once under to:) is well past that, so the list is split and the Edge Function
// runs one query per chunk and merges. `from:{a b c}` is Gmail's own OR-over-a-field syntax, which
// is what crm-gmail.mjs uses for the same reason, and it is far shorter than "from:a OR from:b".
var MAIL_CHUNK = 12
function activeProjectEmails() {
  var seen = {}
  var out = []
  ;((SNAP && SNAP.projects) || []).forEach(function (p) {
    if (p.bucket !== 'active') return
    projectEmails(p).forEach(function (e) {
      // Gmail's brace syntax is whitespace-separated, so an address containing a space would break
      // out of the group and silently widen the search. Anything that is not a plain address is
      // dropped rather than trusted.
      if (!/^[^\s{}]+@[^\s{}]+\.[^\s{}]+$/.test(e)) return
      if (seen[e]) return
      seen[e] = 1
      out.push(e)
    })
  })
  return out
}

// The queries for the Inbox. `extra` prefixes each one ('is:unread' for the unread view).
// Returns [] when there is nobody to search for, which the caller must treat as "show nothing"
// rather than falling back to a bare query: a fallback here would quietly put all 201 Bark and
// GigSalad notifications back on the screen, which is the exact thing being fixed.
function buildClientMailQueries(extra) {
  var addrs = activeProjectEmails()
  if (!addrs.length) return []
  var pre = extra ? extra + ' ' : ''
  var qs = []
  for (var i = 0; i < addrs.length; i += MAIL_CHUNK) {
    var group = addrs.slice(i, i + MAIL_CHUNK).join(' ')
    qs.push(pre + '(from:{' + group + '} OR to:{' + group + '})')
  }
  return qs
}

// ---- the Inbox page ----
var INBOX_UNREAD_ONLY = false
function renderInbox() {
  var v = $('#view'); v.innerHTML = ''
  var head = el('<div class="tabhead"><div class="seg"></div><button class="addbtn" id="mail-refresh" aria-label="Refresh"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>Refresh</button></div>')
  var seg = head.querySelector('.seg')
  ;[['All', false], ['Unread', true]].forEach(function (o) {
    var b = el('<button class="segb' + (INBOX_UNREAD_ONLY === o[1] ? ' on' : '') + '">' + o[0] + '</button>')
    b.addEventListener('click', function () { if (INBOX_UNREAD_ONLY === o[1]) return; INBOX_UNREAD_ONLY = o[1]; renderInbox() })
    seg.appendChild(b)
  })
  head.querySelector('#mail-refresh').addEventListener('click', function () { mailForget(); renderInbox() })
  v.appendChild(head)

  var list = el('<div></div>')
  v.appendChild(list)

  var q = buildClientMailQueries(INBOX_UNREAD_ONLY ? 'is:unread' : '')
  if (!q.length) {
    list.appendChild(el('<div class="empty" style="padding:40px 16px">No active project has a contact with an email address, so there is nobody to show mail from yet.</div>'))
    return
  }
  // Say out loud what this list is, because it is deliberately NOT the mailbox and a short list is
  // otherwise indistinguishable from a broken one.
  var hint = el('<div class="hint" style="margin:0 2px 4px">Everyone on your active projects. Nothing else.</div>')
  v.insertBefore(hint, list)
  list.appendChild(el('<div class="empty">Loading mail…</div>'))

  mailFetch(q, 25, function (err, threads) {
    if (TAB !== 'inbox') return // he navigated away while it was in flight
    list.innerHTML = ''
    if (err) { list.appendChild(mailError(err, function () { mailForget(); renderInbox() })); return }
    if (!threads.length) {
      list.appendChild(el('<div class="empty">' + (INBOX_UNREAD_ONLY ? 'Nothing unread from a client.' : 'No mail with anyone on your active projects yet.') + '</div>'))
      return
    }
    var ix = emailToProjectIndex()
    // The Mac's header count: conversations, and how many are unread.
    var unread = threads.filter(function (t) { return t.unread }).length
    hint.textContent = 'Everyone on your active projects. ' + threads.length + ' conversation' + (threads.length === 1 ? '' : 's') + (unread ? ', ' + unread + ' unread.' : '.')
    threads.forEach(function (t) { list.appendChild(mailRow(t, ix, function () { renderInbox() })) })
  })
}

// One thread in a list. The project name, when we can work it out, is the most valuable thing on
// the row: it turns "who is Sarah again" into "oh, the Duke wedding".
//
// THE NAME ON THE ROW IS THE CLIENT, NEVER MICHAEL. A thread is collapsed to its newest message,
// and in an ongoing conversation the newest message is usually his own reply, so a straight "from"
// made most of the inbox read "Michael Bloemeke ... Michael Bloemeke ... Michael Bloemeke". The
// counterpart is worked out by scope rather than by knowing his own address: whichever party to the
// thread is a contact on one of his projects is the client, and if that is a recipient rather than
// the sender the row says "To" so a conversation he is waiting on still reads differently from one
// he last spoke in. Same convention Mail uses, for the same reason.
function mailRow(t, ix, after) {
  var pid = ix ? ix[t.fromEmail] || (t.to || []).map(function (e) { return ix[e] }).filter(Boolean)[0] || '' : ''
  var pr = pid ? SNAP.projects.find(function (x) { return x.id === pid }) : null
  var who = t.from || t.fromEmail
  var outbound = false
  if (ix && !ix[t.fromEmail]) {
    var toClient = (t.to || []).filter(function (e) { return ix[e] })[0]
    if (toClient) { who = toClient; outbound = true }
  }
  var row = el(
    '<button class="mailrow' + (t.unread ? ' unread' : '') + '">' +
      '<span class="maildot"></span>' +
      '<span class="mailbody">' +
        '<span class="mailtop"><span class="mailfrom">' + (outbound ? '<span class="mailto">To</span> ' : '') + esc(who) + '</span><span class="mailwhen">' + esc(mailWhen(t.ts)) + '</span></span>' +
        '<span class="mailsub">' + esc(t.subject) + '</span>' +
        '<span class="mailsnip">' + esc(String(t.snippet || '').slice(0, 130)) + '</span>' +
        (pr ? '<span class="mailproj">' + esc(pr.client) + '</span>' : '') +
      '</span>' +
    '</button>'
  )
  row.addEventListener('click', function () { openThread(t, pr, after) })
  return row
}

function mailError(err, retry) {
  var box = el('<div class="empty" style="padding:26px 14px"><div>' + esc(err.message || 'Could not reach email.') + '</div></div>')
  var b = el('<button class="btn-ghost" style="margin-top:12px">Try again</button>')
  b.addEventListener('click', retry)
  box.appendChild(b)
  return box
}

// ---- reading one thread ----
//
// Opening does NOT mark read. Michael's unread count is a real signal about what he still owes an
// answer to, and glancing at a thread to see who it is from should not quietly spend it. "Mark
// read" is a button, and replying marks it read on his behalf because a reply settles the question.
function openThread(t, project, after) {
  var sheet = el(
    '<div class="sheet"><div class="sheet-card sheet-tall">' +
      '<div class="sheet-head"><div class="sheet-title" style="min-width:0">' + esc(t.subject || '(no subject)') + '</div>' +
      '<button class="sheet-x" aria-label="Close">' +
      '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>' +
      '</button></div><div class="sheet-body"></div>' +
    '</div></div>'
  )
  var body = sheet.querySelector('.sheet-body')
  var dirty = false
  var close = function () { sheet.remove(); if (dirty && after) after() }
  sheet.querySelector('.sheet-x').addEventListener('click', close)
  sheet.addEventListener('click', function (e) { if (e.target === sheet) close() })
  body.appendChild(el('<div class="empty">Loading…</div>'))
  document.body.appendChild(sheet)

  gmailThread(t.threadId).then(function (th) {
    body.innerHTML = ''
    if (project) {
      var go = el('<button class="btn-ghost" style="width:100%;margin-bottom:12px">Open ' + esc(project.client) + '</button>')
      go.addEventListener('click', function () { close(); closeDrawer(); TAB = pageForBucket(project.bucket); renderDetail(project.id) })
      body.appendChild(go)
    }
    th.messages.forEach(function (m) {
      var msg = el('<div class="msg"></div>')
      msg.appendChild(el('<div class="msg-h"><span class="msg-from">' + esc(m.from || m.fromEmail) + '</span><span class="msg-when">' + esc(mailWhen(m.ts)) + '</span></div>'))
      msg.appendChild(el('<div class="msg-to">to ' + esc((m.to || []).join(', ') || 'me') + '</div>'))
      msg.appendChild(el('<div class="msg-b">' + esc(m.body || '(no text)').replace(/\n/g, '<br>') + '</div>'))
      body.appendChild(msg)
    })

    var last = th.messages[th.messages.length - 1] || {}
    var bar = el('<div class="addrow" style="margin-top:14px"></div>')
    var rep = el('<button class="btn-gold">Reply</button>')
    rep.addEventListener('click', function () {
      close()
      openCompose({
        to: last.fromEmail && last.fromEmail !== 'me' ? last.fromEmail : (last.to || [])[0] || '',
        subject: /^re:/i.test(th.subject) ? th.subject : 'Re: ' + th.subject,
        project: project,
        threadId: t.threadId,
        after: after,
      })
    })
    var mk = el('<button class="btn-ghost">' + (t.unread ? 'Mark read' : 'Read') + '</button>')
    if (!t.unread) mk.disabled = true
    mk.addEventListener('click', function () {
      doWrite(gmailMarkRead(t.threadId), 'Marked read', function () {
        t.unread = false; mailForget(); dirty = true; close()
      })
    })
    bar.appendChild(mk); bar.appendChild(rep)
    body.appendChild(bar)
  }).catch(function (e) {
    body.innerHTML = ''
    body.appendChild(mailError(e, close))
  })
}

// ---- writing one ----
//
// REBUILT 2026-10-23 as a port of the Mac's composer (EmailBuilderModal), because Michael asked for
// the phone to do everything the Mac does. It used to be a plain textarea. What it has now, and where
// each came from on the Mac:
//   - the template library (src/emailTemplates.ts, generated into email-templates.js). Picking one
//     fills the subject and message; only the client's first name autofills; every other placeholder
//     stays a RED chip, which on a phone you TAP to fill in
//   - the signature checkbox. The block lives IN the message, tagged data-crm-signature, so the send
//     function's Settings signature stands down and an email never gets two
//   - reply into an existing conversation with this client (the Mac's "reply to a thread")
//   - attachments, from the Files library or picked from the phone
//   - autosaved drafts on a project, by id, so one opened on the Mac carries on here and vice versa
//   - the one-time "these placeholders still need filling" warning before a send
// The send itself goes through send-email, which renders exactly like the Mac (GIFs embedded, not
// linked).
var SMART_FIELDS = [
  ['clientName', 'Client name'], ['firstName', 'Client first name'], ['eventType', 'Event type'], ['eventDate', 'Event date'],
  ['eventLocation', 'Venue / location'], ['venueType', 'Venue type'], ['eventStartTime', 'Event start time'], ['showStartTime', 'Show start time'],
  ['numberOfGuests', 'Guest count'], ['ageOfGuests', 'Age of guests'], ['performanceStyle', 'Performance'], ['totalFee', 'Booking fee'],
  ['contactName', 'On-site contact name'], ['myName', 'My name'],
]
function smartFieldValue(key, p) {
  if (!p && key !== 'myName') return ''
  switch (key) {
    case 'clientName': return (p.client || '').trim()
    case 'firstName': return (p.client || '').trim().split(/\s+/)[0] || ''
    case 'eventDate': {
      var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(p.eventDate || '')
      return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : ''
    }
    case 'totalFee': return p.totalFee != null ? '$' + Math.round(Number(p.totalFee)).toLocaleString('en-US') : ''
    case 'contactName': return (p.contactNames || '').split(/[,;]/)[0].trim()
    case 'myName': return 'Michael Bloemeke'
    default: return String((p && p[key]) || '').trim()
  }
}
// Fill every data chip whose project value is set; leave the rest (and every write-in note) as chips.
function resolveChips(root, p) {
  root.querySelectorAll('span.merge-field[data-field]').forEach(function (c) {
    var v = smartFieldValue(c.getAttribute('data-field') || '', p)
    if (v) c.replaceWith(document.createTextNode(v))
  })
}
function chipLabels(root) {
  var seen = {}
  root.querySelectorAll('span.merge-field').forEach(function (c) { seen[(c.textContent || '').replace(/^\s*\[|\]\s*$/g, '').trim()] = 1 })
  return Object.keys(seen).filter(Boolean)
}
var SIG_RULE = '<div style="width:150px;border-top:1px solid #d8d8d8;font-size:1px;line-height:1px;margin:0 0 10px 0">&nbsp;</div>'
var DEFAULT_SIG = 'Michael Bloemeke<div>michaelbloemeke.com</div><div>919-239-9898</div>'
function signatureBlockHtml(sigHtml) {
  return '<div data-crm-signature="1" contenteditable="false" style="margin-top:22px">' + SIG_RULE +
    '<div style="color:#555555;font-size:13px;line-height:1.6">' + ((sigHtml || '').trim() || DEFAULT_SIG) + '</div></div>'
}
function htmlHasContent(html) {
  return /<img\b/i.test(html || '') || String(html || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim() !== ''
}
function plainToHtml(t) {
  return String(t || '').split(/\n{2,}/).map(function (para) { return '<p>' + esc(para).replace(/\n/g, '<br>') + '</p>' }).join('')
}

function openCompose(opts) {
  var o = opts || {}
  var project = o.project || null
  var existing = o.existing || null // a saved draft row from loadProjectDrafts
  var sh = makeSheet(existing ? 'Draft' : o.threadId ? 'Reply' : 'New email', true)
  var body = sh.body
  sh.sheet.classList.add('compose-sheet')

  var draftId = existing ? existing.id : ''
  var threadId = o.threadId || (existing && existing.threadId) || ''
  var threadSubject = (existing && existing.threadSubject) || ''
  var attachments = existing ? existing.attachments.slice() : []
  var sessionUploads = [] // uploaded this session; removed again if the email is abandoned unsaved
  var sigCfg = { enabled: false, html: '' }
  var confirmUnfilled = false
  var sending = false

  // --- To ---
  var to = document.createElement('input')
  to.className = 'search'; to.type = 'email'; to.placeholder = 'To'
  to.autocapitalize = 'off'; to.autocorrect = 'off'
  to.value = existing ? existing.to.join(', ') : o.to || ''
  body.appendChild(el('<div class="do-l" style="margin-bottom:6px">To</div>'))
  body.appendChild(to)
  if (project) {
    var addrs = projectEmails(project)
    if (addrs.length) {
      var chips = el('<div class="do-actions" style="flex-wrap:wrap;margin-top:8px"></div>')
      addrs.forEach(function (a) {
        var c = el('<button class="do-alt" style="flex:0 1 auto;padding:7px 11px;font-size:12px">' + esc(a) + '</button>')
        c.addEventListener('click', function () {
          var cur = to.value.split(',').map(function (s) { return s.trim() }).filter(Boolean)
          if (cur.indexOf(a) === -1) cur.push(a)
          to.value = cur.join(', '); changed()
        })
        chips.appendChild(c)
      })
      body.appendChild(chips)
    }
  }

  // --- Template + reply-in-thread ---
  var tools = el('<div class="cmp-tools"></div>')
  var tplBtn = el('<button class="cmp-pick"><span class="cmp-pick-l">Template</span><span class="cmp-pick-v">None</span></button>')
  tplBtn.addEventListener('click', function () { openTemplatePicker() })
  tools.appendChild(tplBtn)
  var thrBtn = null
  if (project && !o.threadId) {
    thrBtn = el('<button class="cmp-pick"><span class="cmp-pick-l">Conversation</span><span class="cmp-pick-v">New thread</span></button>')
    thrBtn.addEventListener('click', function () { openThreadPicker() })
    tools.appendChild(thrBtn)
  }
  body.appendChild(tools)

  // --- Subject ---
  var subj = document.createElement('input')
  subj.className = 'search'; subj.placeholder = 'Subject'
  subj.value = existing ? (existing.subject === '(no subject)' ? '' : existing.subject) : o.subject || ''
  body.appendChild(el('<div class="do-l" style="margin:14px 0 6px">Subject</div>'))
  body.appendChild(subj)

  // --- Message: a small rich editor ---
  body.appendChild(el('<div class="do-l" style="margin:14px 0 6px">Message</div>'))
  var bar = el('<div class="rte-bar">' +
    '<button data-cmd="bold" aria-label="Bold"><b>B</b></button>' +
    '<button data-cmd="italic" aria-label="Italic"><i>I</i></button>' +
    '<button data-cmd="underline" aria-label="Underline"><u>U</u></button>' +
    '<button data-cmd="insertUnorderedList" aria-label="Bulleted list">&#8226; List</button>' +
    '<button data-cmd="link" aria-label="Link">Link</button>' +
    '<button data-cmd="field" aria-label="Insert a field">+ Field</button>' +
    '</div>')
  var ed = document.createElement('div')
  ed.className = 'rte'; ed.contentEditable = 'true'; ed.setAttribute('role', 'textbox'); ed.setAttribute('aria-multiline', 'true')
  if (existing) ed.innerHTML = existing.format === 'html' ? existing.body : plainToHtml(existing.body)
  else if (o.body) ed.innerHTML = plainToHtml(o.body)
  resolveChips(ed, project)
  var savedRange = null
  ed.addEventListener('blur', function () {
    var s = window.getSelection()
    if (s && s.rangeCount && ed.contains(s.anchorNode)) savedRange = s.getRangeAt(0).cloneRange()
  })
  function restoreRange() {
    ed.focus()
    if (savedRange) { var s = window.getSelection(); s.removeAllRanges(); s.addRange(savedRange) }
  }
  bar.querySelectorAll('button').forEach(function (b) {
    // mousedown/touchstart default would steal focus from the editor and lose the selection.
    b.addEventListener('mousedown', function (e) { e.preventDefault() })
    b.addEventListener('click', function () {
      var cmd = b.getAttribute('data-cmd')
      if (cmd === 'field') { openFieldPicker(); return }
      if (cmd === 'link') {
        var url = prompt('Link address')
        if (!url) return
        if (!/^(https?:|mailto:)/i.test(url)) url = 'https://' + url
        restoreRange(); document.execCommand('createLink', false, url); changed(); return
      }
      restoreRange(); document.execCommand(cmd, false, null); changed()
    })
  })
  // Tap a red placeholder to replace it with real words.
  ed.addEventListener('click', function (e) {
    var chip = e.target.closest && e.target.closest('span.merge-field')
    if (!chip || !ed.contains(chip)) return
    e.preventDefault()
    fillChip(chip)
  })
  ed.addEventListener('input', changed)
  body.appendChild(bar)
  body.appendChild(ed)

  // --- Signature ---
  var sigRow = el('<label class="cmp-check"><input type="checkbox"> <span>Signature</span></label>')
  var sigBox = sigRow.querySelector('input')
  sigBox.checked = !!ed.querySelector('[data-crm-signature]')
  sigBox.addEventListener('change', function () {
    ed.querySelectorAll('[data-crm-signature]').forEach(function (n) { n.remove() })
    if (sigBox.checked) ed.insertAdjacentHTML('beforeend', signatureBlockHtml(sigCfg.html))
    confirmUnfilled = false; changed()
  })
  body.appendChild(sigRow)

  // --- Attachments ---
  var attWrap = el('<div class="cmp-att"></div>')
  var attList = el('<div class="cmp-att-list"></div>')
  var attBtns = el('<div class="do-actions" style="margin-top:6px"><button class="do-alt">Attach from Files</button><button class="do-alt">Attach from phone</button></div>')
  var picker = document.createElement('input')
  picker.type = 'file'; picker.multiple = true; picker.style.display = 'none'
  attBtns.children[0].addEventListener('click', function () { openFilesPicker() })
  attBtns.children[1].addEventListener('click', function () { picker.click() })
  picker.addEventListener('change', function () {
    var files = Array.prototype.slice.call(picker.files || [])
    picker.value = ''
    files.forEach(function (f) {
      var tmp = { name: f.name, path: '', size: f.size, uploading: true }
      attachments.push(tmp); drawAtt()
      uploadEmailAttachment(f).then(function (a) {
        tmp.path = a.path; tmp.uploading = false; sessionUploads.push(a.path); drawAtt(); changed()
      }).catch(function (e) {
        attachments.splice(attachments.indexOf(tmp), 1); drawAtt(); toast(e.message || 'Could not upload ' + f.name, 'err')
      })
    })
  })
  function drawAtt() {
    attList.innerHTML = ''
    attachments.forEach(function (a) {
      var chip = el('<span class="cmp-att-chip"><span class="cmp-att-n"></span><span class="cmp-att-s"></span><button aria-label="Remove">&times;</button></span>')
      chip.querySelector('.cmp-att-n').textContent = a.name
      chip.querySelector('.cmp-att-s').textContent = a.uploading ? 'Uploading…' : fmtBytes(a.size)
      chip.querySelector('button').addEventListener('click', function () { attachments.splice(attachments.indexOf(a), 1); drawAtt(); changed() })
      attList.appendChild(chip)
    })
  }
  attWrap.appendChild(attList); attWrap.appendChild(attBtns); attWrap.appendChild(picker)
  body.appendChild(attWrap)
  drawAtt()

  var status = el('<div class="cmp-status"></div>')
  body.appendChild(status)
  function say(t, bad) { status.textContent = t || ''; status.classList.toggle('bad', !!bad) }

  // --- Buttons ---
  var actions = el('<div class="addrow" style="margin-top:14px"></div>')
  var leftBtn = el('<button class="btn-ghost">' + (project ? 'Close' : 'Cancel') + '</button>')
  var sendBtn = el('<button class="btn-gold">Send</button>')
  actions.appendChild(leftBtn); actions.appendChild(sendBtn)
  body.appendChild(actions)
  var discardBtn = el('<button class="cmp-discard">Discard draft</button>')
  discardBtn.style.display = draftId ? '' : 'none'
  discardBtn.addEventListener('click', function () {
    if (!draftId || !confirm('Discard this draft? This permanently deletes it.')) return
    var id = draftId; draftId = ''
    deleteDraft(id).catch(function () {})
    cleanupUploads()
    shut(true)
  })
  if (project) body.appendChild(discardBtn)

  // Settings' signature is the DEFAULT for a brand-new email only. A saved draft keeps the choice it
  // was written with, exactly like the Mac.
  loadRawConfig().then(function (c) {
    sigCfg = { enabled: !!c.signatureEnabled, html: c.signatureHtml || '' }
    if (!existing && sigCfg.enabled && !ed.querySelector('[data-crm-signature]')) {
      ed.insertAdjacentHTML('beforeend', signatureBlockHtml(sigCfg.html)); sigBox.checked = true
    }
  }).catch(function () {})

  // --- autosave (projects only: a draft row belongs to a project) ---
  var saveTimer = null
  var saving = Promise.resolve()
  function changed() {
    confirmUnfilled = false
    if (!project || sending) return
    clearTimeout(saveTimer)
    saveTimer = setTimeout(persist, 800)
  }
  function payload() {
    return {
      id: draftId, projectId: project.id, to: to.value, subject: subj.value.trim(), html: ed.innerHTML,
      threadId: threadId, threadSubject: threadSubject, attachments: attachments.filter(function (a) { return a.path }),
    }
  }
  function persist() {
    clearTimeout(saveTimer)
    saving = saving.then(function () {
      if (!project) return
      if (!htmlHasContent(ed.innerHTML) && !attachments.length) {
        if (!draftId) return
        var id = draftId; draftId = ''; discardBtn.style.display = 'none'
        return deleteDraft(id).catch(function () {})
      }
      return saveComposeDraft(payload()).then(function (id) {
        draftId = id; discardBtn.style.display = ''; sessionUploads = []
        say('Draft saved')
      }).catch(function () { say('Could not save the draft right now.', true) })
    })
    return saving
  }
  function cleanupUploads() {
    sessionUploads.forEach(function (p) { deleteFile(p).catch(function () {}) })
    sessionUploads = []
  }
  function shut(skipFlush) {
    if (!skipFlush) {
      if (project) persist()
      else cleanupUploads()
    }
    sh.close()
    if (o.after) o.after()
  }
  leftBtn.addEventListener('click', function () { shut(false) })
  // The X and a tap outside close through makeSheet; both still keep the draft (or tidy uploads).
  var flushOnClose = function () { if (sending) return; if (project) persist(); else cleanupUploads() }
  sh.sheet.querySelector('.sheet-x').addEventListener('click', flushOnClose)
  sh.sheet.addEventListener('click', function (e) { if (e.target === sh.sheet) flushOnClose() })

  // --- send ---
  sendBtn.addEventListener('click', function () {
    var list = to.value.split(/[,;]/).map(function (s) { return s.trim() }).filter(Boolean)
    if (!list.length || list.some(function (a) { return !/.+@.+\..+/.test(a) })) { say('Add a valid recipient.', true); return }
    if (!subj.value.trim()) { say('Add a subject before sending.', true); return }
    if (!htmlHasContent(ed.innerHTML) && !attachments.length) { say('The message is empty.', true); return }
    if (attachments.some(function (a) { return a.uploading })) { say('Wait for the attachment to finish uploading.', true); return }
    resolveChips(ed, project)
    var left = chipLabels(ed)
    if (left.length && !confirmUnfilled) {
      say('These placeholders still need filling: ' + left.join(', ') + '. Tap one to fill it in, or tap Send again to send as-is.', true)
      confirmUnfilled = true
      return
    }
    // Disabled while in flight. A cloud send is a second or two on a phone network, and a second
    // tap would be a second email in the client's inbox.
    sending = true
    clearTimeout(saveTimer)
    sendBtn.disabled = true; sendBtn.textContent = 'Sending…'; say('')
    saving.then(function () {
      return sendEmail({
        to: list, subject: subj.value.trim(), html: ed.innerHTML, projectId: project ? project.id : '', kind: 'custom',
        threadId: threadId, threadSubject: threadSubject, emailId: draftId,
        attachments: attachments.map(function (a) { return { path: a.path, name: a.name, size: a.size } }),
      })
    }).then(function () {
      toast('Email sent')
      mailForget()
      // The reply settles the thread, so it is no longer unread. Failing to mark it is not worth
      // failing the send over: the email is gone either way.
      if (threadId) gmailMarkRead(threadId).catch(function () {})
      // send-email wrote "Sent email to x." into the activity log; pull it so the Log shows it now.
      if (project) reloadProjectLog(project.id).then(function (log) { if (log) project.activityLog = log; if (DETAIL_ID === project.id) renderDetail(project.id, true) }).catch(function () {})
      sh.close()
      if (o.after) o.after()
    }).catch(function (e) {
      sending = false
      sendBtn.disabled = false; sendBtn.textContent = 'Send'
      say(e.message || 'Could not send.', true)
    })
  })

  // --- pickers ---
  function openTemplatePicker() {
    var ps = makeSheet('Template', true)
    var none = el('<button class="actrow"><span class="ar-l">No template</span></button>')
    none.addEventListener('click', function () { applyTemplate(null); ps.close() })
    ps.body.appendChild(none)
    TEMPLATE_GROUPS.forEach(function (g) {
      var head = el('<button class="tpl-group"><span></span><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></button>')
      head.querySelector('span').textContent = g.name + '  ·  ' + g.templates.length
      var list = el('<div class="tpl-list" hidden></div>')
      head.addEventListener('click', function () { list.hidden = !list.hidden; head.classList.toggle('open', !list.hidden) })
      g.templates.forEach(function (t) {
        var r = el('<button class="actrow"><span class="ar-l"></span>' + (t.needsRewrite ? '<span class="ar-v">Needs rewrite</span>' : '') + '</button>')
        r.querySelector('.ar-l').textContent = t.name
        r.addEventListener('click', function () { if (applyTemplate(t)) ps.close() })
        list.appendChild(r)
      })
      ps.body.appendChild(head); ps.body.appendChild(list)
    })
  }
  // Applying a template REPLACES the subject and message, so it asks first when there is something
  // to lose. The signature decision survives the swap.
  function applyTemplate(t) {
    var dirty = htmlHasContent(withoutSig(ed.innerHTML)) || subj.value.trim() !== ''
    if (dirty && !confirm(t ? 'Replace what is here with "' + t.name + '"?' : 'Clear the subject and message?')) return false
    var keepSig = sigBox.checked
    subj.value = t ? t.subject : ''
    ed.innerHTML = t ? t.body : ''
    resolveChips(ed, project)
    if (keepSig) ed.insertAdjacentHTML('beforeend', signatureBlockHtml(sigCfg.html))
    tplBtn.querySelector('.cmp-pick-v').textContent = t ? t.name : 'None'
    say(''); changed()
    return true
  }
  function withoutSig(html) {
    var d = document.createElement('div'); d.innerHTML = html
    d.querySelectorAll('[data-crm-signature]').forEach(function (n) { n.remove() })
    return d.innerHTML
  }
  function openFieldPicker() {
    var fs = makeSheet('Insert a field')
    SMART_FIELDS.forEach(function (f) {
      var v = smartFieldValue(f[0], project)
      var r = el('<button class="actrow"><span class="ar-l"></span><span class="ar-v"></span></button>')
      r.querySelector('.ar-l').textContent = f[1]
      r.querySelector('.ar-v').textContent = v || 'Not set'
      r.addEventListener('click', function () {
        fs.close()
        restoreRange()
        var html = v ? esc(v) : '<span class="merge-field" data-field="' + f[0] + '" contenteditable="false">[' + esc(f[1]) + ']</span>&nbsp;'
        document.execCommand('insertHTML', false, html)
        changed()
      })
      fs.body.appendChild(r)
    })
  }
  function fillChip(chip) {
    var label = (chip.textContent || '').replace(/^\s*\[|\]\s*$/g, '')
    var fs = makeSheet('Fill in')
    fs.body.appendChild(el('<div class="do-l" style="margin-bottom:6px"></div>')).textContent = label
    var inp = document.createElement('input')
    inp.className = 'search'; inp.placeholder = 'Type the words that go here'
    fs.body.appendChild(inp)
    var row = el('<div class="addrow" style="margin-top:12px"><button class="btn-ghost">Remove it</button><button class="btn-gold">Use this</button></div>')
    row.children[0].addEventListener('click', function () { chip.remove(); fs.close(); changed() })
    row.children[1].addEventListener('click', function () {
      var v = inp.value.trim()
      if (!v) { inp.focus(); return }
      chip.replaceWith(document.createTextNode(v)); fs.close(); changed()
    })
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') row.children[1].click() })
    fs.body.appendChild(row)
    setTimeout(function () { inp.focus() }, 60)
  }
  function openThreadPicker() {
    var ps = makeSheet('Reply in a conversation', true)
    var none = el('<button class="actrow' + (threadId ? '' : ' on') + '"><span class="ar-l">Start a new thread</span></button>')
    none.addEventListener('click', function () { threadId = ''; threadSubject = ''; thrBtn.querySelector('.cmp-pick-v').textContent = 'New thread'; ps.close(); changed() })
    ps.body.appendChild(none)
    var list = el('<div><div class="empty" style="padding:14px 2px">Loading their conversations…</div></div>')
    ps.body.appendChild(list)
    var addrs = projectEmails(project)
    if (!addrs.length) { list.innerHTML = '<div class="empty" style="padding:14px 2px">No email address on this project yet.</div>'; return }
    var q = '(' + addrs.map(function (a) { return 'from:' + a + ' OR to:' + a }).join(' OR ') + ')'
    mailFetch(q, 20, function (err, threads) {
      list.innerHTML = ''
      if (err) { list.appendChild(el('<div class="empty">Could not load their conversations.</div>')); return }
      if (!threads.length) { list.appendChild(el('<div class="empty" style="padding:14px 2px">Nothing in the mailbox with them yet.</div>')); return }
      threads.forEach(function (t) {
        var r = el('<button class="actrow' + (t.threadId === threadId ? ' on' : '') + '"><span class="ar-l"></span><span class="ar-v"></span></button>')
        r.querySelector('.ar-l').textContent = t.subject || '(no subject)'
        r.querySelector('.ar-v').textContent = mailWhen(t.ts)
        r.addEventListener('click', function () {
          threadId = t.threadId; threadSubject = t.subject || ''
          subj.value = /^re:/i.test(threadSubject) ? threadSubject : 'Re: ' + threadSubject
          thrBtn.querySelector('.cmp-pick-v').textContent = threadSubject || 'Conversation'
          ps.close(); changed()
        })
        list.appendChild(r)
      })
    })
  }
  function openFilesPicker() {
    var ps = makeSheet('Attach from Files', true)
    ps.body.appendChild(el('<div class="empty">Loading files…</div>'))
    listFiles().then(function (files) {
      ps.body.innerHTML = ''
      if (!files.length) { ps.body.appendChild(el('<div class="empty">Nothing in Files yet.</div>')); return }
      files.forEach(function (f) {
        var on = attachments.some(function (a) { return a.path === f.name })
        var r = el('<button class="actrow' + (on ? ' on' : '') + '"><span class="ar-l"></span><span class="ar-v"></span></button>')
        r.querySelector('.ar-l').textContent = f.name
        r.querySelector('.ar-v').textContent = on ? 'Attached' : fmtBytes(f.size)
        r.addEventListener('click', function () {
          if (!on) attachments.push({ name: f.name, path: f.name, size: f.size })
          drawAtt(); changed(); ps.close()
        })
        ps.body.appendChild(r)
      })
    }).catch(function (e) { ps.body.innerHTML = ''; ps.body.appendChild(el('<div class="empty"></div>')).textContent = e.message || 'Could not load Files.' })
  }

  if (existing && existing.threadId && thrBtn) thrBtn.querySelector('.cmp-pick-v').textContent = existing.threadSubject || 'Conversation'
  setTimeout(function () { (to.value ? ed : to).focus() }, 60)
}
function fmtBytes(n) {
  n = Number(n) || 0
  if (!n) return ''
  if (n < 1024) return n + ' B'
  if (n < 1048576) return Math.round(n / 1024) + ' KB'
  return (n / 1048576).toFixed(1) + ' MB'
}

// ---- the project's Email tab ----
//
// "I often send emails from the client's project page, the details page, and not on the inbox
// page." So this is the one that matters: their correspondence and a Write button, in the place he
// is already standing when he decides to write.
function emailTab(p) {
  var wrap = el('<div></div>')
  var addrs = projectEmails(p)

  var head = sectionHead(addrs.length ? 'Email  ·  ' + addrs.join(', ') : 'Email', 'Write', function () {
    openCompose({ to: addrs[0] || '', project: p, after: function () { if (DETAIL_ID === p.id) renderDetail(p.id, true) } })
  })
  wrap.appendChild(head)

  if (!addrs.length) {
    wrap.appendChild(el('<div class="empty" style="padding:6px 2px;text-align:left">No email address on this project. Add a contact from Actions, then you can write to them from here.</div>'))
    return wrap
  }

  // Drafts saved in the CRM (by this composer or the Mac's), above the mailbox, so a half-written
  // email is one tap from carrying on.
  var drafts = el('<div></div>')
  wrap.appendChild(drafts)
  loadProjectDrafts(p.id).then(function (rows) {
    if (DETAIL_ID !== p.id || !rows.length) return
    drafts.appendChild(sectionLabel('Drafts · ' + rows.length))
    rows.forEach(function (d) {
      var tmp = document.createElement('div'); tmp.innerHTML = d.format === 'html' ? d.body : esc(d.body)
      tmp.querySelectorAll('[data-crm-signature]').forEach(function (n) { n.remove() })
      var r = el('<button class="mailrow"><span class="maildot" style="background:var(--gold)"></span><span class="mailbody">' +
        '<span class="mailtop"><span class="mailfrom"><span class="mailto">Draft</span> ' + esc(d.to.join(', ') || 'No recipient yet') + '</span><span class="mailwhen">' + esc(mailWhen(Date.parse(d.updatedAt))) + '</span></span>' +
        '<span class="mailsub">' + esc(d.subject) + '</span><span class="mailsnip">' + esc((tmp.textContent || '').slice(0, 130)) + '</span></span></button>')
      r.addEventListener('click', function () {
        openCompose({ project: p, existing: d, after: function () { if (DETAIL_ID === p.id) renderDetail(p.id, true) } })
      })
      drafts.appendChild(r)
    })
  }).catch(function () {})

  var list = el('<div></div>')
  list.appendChild(el('<div class="empty" style="padding:18px 2px">Loading their emails…</div>'))
  wrap.appendChild(list)

  // Gmail's OR needs the terms parenthesised or it binds only to the last one, which would silently
  // search for "from:a" OR "anything to:b" and quietly return the wrong mail.
  var clause = addrs.map(function (a) { return 'from:' + a + ' OR to:' + a }).join(' OR ')
  var q = '(' + clause + ')'
  mailFetch(q, 20, function (err, threads) {
    if (DETAIL_ID !== p.id) return
    list.innerHTML = ''
    if (err) { list.appendChild(mailError(err, function () { mailForget(); renderDetail(p.id, true) })); return }
    if (!threads.length) { list.appendChild(el('<div class="empty" style="padding:6px 2px;text-align:left">Nothing in the mailbox with them yet.</div>')); return }
    threads.forEach(function (t) {
      list.appendChild(mailRow(t, null, function () { if (DETAIL_ID === p.id) renderDetail(p.id, true) }))
    })
  })
  return wrap
}

// ================================ PROPOSALS ================================
//
// Every proposal and booking form he has ever sent, what state it is in, and whether anyone read
// it. The desktop version of this page was built 2026-09-09; this is the same list on the phone,
// which Michael named as one of the pages he wants there ("the proposal page is a big one").
//
// ⚠️ EVERY LINK OPENED FROM HERE IS A PREVIEW. `openUrl` comes back from the server already
// carrying preview=1 (and the admin key for anything the public can no longer reach). `url` is the
// clean link and is only ever COPIED, never opened. His view counts are real data about whether
// clients are reading his proposals, and his own checking must not show up in them.

var PROP_CACHE = null
var PROP_TAB = 'proposals' // 'proposals' | 'bookings'

function renderProposals() {
  var v = $('#view'); v.innerHTML = ''
  var head = el('<div class="tabhead"><div class="seg"></div><button class="addbtn" id="prop-refresh" aria-label="Refresh"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>Refresh</button></div>')
  var seg = head.querySelector('.seg')
  ;[['Proposals', 'proposals'], ['Booking forms', 'bookings']].forEach(function (o) {
    var b = el('<button class="segb' + (PROP_TAB === o[1] ? ' on' : '') + '">' + o[0] + '</button>')
    b.addEventListener('click', function () { if (PROP_TAB === o[1]) return; PROP_TAB = o[1]; renderProposals() })
    seg.appendChild(b)
  })
  head.querySelector('#prop-refresh').addEventListener('click', function () { PROP_CACHE = null; renderProposals() })
  v.appendChild(head)

  var body = el('<div></div>')
  body.appendChild(el('<div class="empty">Loading proposals…</div>'))
  v.appendChild(body)

  var draw = function (data) {
    if (TAB !== 'proposals') return
    body.innerHTML = ''
    // The templates, first, because "what does a client actually see" is a question he asks far
    // more often than any single client's page.
    var samples = el('<div class="do-actions" style="margin-bottom:6px"></div>')
    var s1 = el('<button class="do-alt">Proposal template</button>')
    s1.addEventListener('click', function () {
      openPreview({ src: data.samples.proposal, title: 'Proposal template', backLabel: 'Proposals' })
    })
    var s2 = el('<button class="do-alt">Booking form template</button>')
    s2.addEventListener('click', function () {
      openPreview({ src: data.samples.booking, title: 'Booking form template', backLabel: 'Proposals' })
    })
    samples.appendChild(s1); samples.appendChild(s2)
    body.appendChild(samples)

    var rows = PROP_TAB === 'proposals' ? data.items : data.bookings
    if (!rows.length) { body.appendChild(el('<div class="empty">Nothing sent yet.</div>')); return }

    // Active first, then everything that has already resolved. Same split as the desktop: what is
    // out right now is a different question from what happened to the ones that are done.
    var live = rows.filter(function (r) { return r.outcome === 'open' })
    var past = rows.filter(function (r) { return r.outcome !== 'open' })
    live.sort(propSort); past.sort(propSort)
    if (live.length) {
      body.appendChild(sectionLabel('Out now · ' + live.length))
      live.forEach(function (r) { body.appendChild(proposalCard(r)) })
    }
    if (past.length) {
      body.appendChild(sectionLabel('Settled · ' + past.length))
      past.forEach(function (r) { body.appendChild(proposalCard(r)) })
    }
  }

  if (PROP_CACHE) { draw(PROP_CACHE); return }
  loadProposalsOverview()
    .then(function (d) { PROP_CACHE = d; draw(d) })
    .catch(function (e) {
      if (TAB !== 'proposals') return
      body.innerHTML = ''
      body.appendChild(mailError(e, function () { PROP_CACHE = null; renderProposals() }))
    })
}

// Most recently touched first: last viewed, else sent, else created. A proposal a client opened an
// hour ago is the one he wants at the top, not whichever happens to be newest.
function propSort(a, b) {
  var ka = a.lastViewedAt || a.sentAt || a.createdAt || ''
  var kb = b.lastViewedAt || b.sentAt || b.createdAt || ''
  return String(kb).localeCompare(String(ka))
}

function proposalCard(r) {
  var card = el('<div class="card propcard"></div>')
  var top = el('<div class="row1"></div>')
  top.appendChild(el('<span class="name" style="font-size:15px">' + esc(r.projectName) + '</span>'))
  if (r.totalFee !== '' && r.totalFee != null) top.appendChild(el('<span class="fee">' + esc(money(r.totalFee)) + '</span>'))
  card.appendChild(top)

  var meta = [r.eventType, r.eventDate ? fmtDate(r.eventDate) : ''].filter(Boolean).join('  ·  ')
  if (meta) card.appendChild(el('<div class="meta">' + esc(meta) + '</div>'))

  var chips = el('<div class="phead-chips" style="margin-top:8px"></div>')
  // Two different facts, side by side, because they answer two different questions: is the LINK
  // still working, and did the DEAL close. A dead link on a booked gig is fine; a dead link on a
  // deal still in play is something to fix.
  if (r.state) chips.appendChild(el('<span class="pill ' + propStateClass(r.state) + '" style="margin:0">' + esc(propStateLabel(r.state)) + '</span>'))
  chips.appendChild(el('<span class="pill ' + (r.outcome === 'booked' ? 'done' : r.outcome === 'lost' ? 'del' : '') + '" style="margin:0">' + esc(r.outcomeLabel) + '</span>'))
  // Views is the number he actually came for.
  chips.appendChild(el('<span class="propviews">' + r.views + (r.views === 1 ? ' view' : ' views') + '</span>'))
  card.appendChild(chips)

  if (r.lastViewedAt) card.appendChild(el('<div class="hint">Last opened ' + esc(timeAgo(r.lastViewedAt)) + '</div>'))
  else if (r.views === 0) card.appendChild(el('<div class="hint">Never opened.</div>'))
  if (r.stateReason && r.state !== 'live') card.appendChild(el('<div class="hint">' + esc(r.stateReason) + '</div>'))
  if (r.outcomeNote) card.appendChild(el('<div class="hint">' + esc(r.outcomeNote) + '</div>'))

  var acts = el('<div class="do-actions" style="margin-top:11px"></div>')
  if (r.openUrl) {
    var view = el('<button class="do-go">Preview</button>')
    view.addEventListener('click', function () {
      openPreview({
        src: r.openUrl,
        publicUrl: r.url,
        title: r.projectName,
        backLabel: 'Proposals',
      })
    })
    acts.appendChild(view)
  }
  var copy = el('<button class="do-alt">Copy link</button>')
  copy.addEventListener('click', function () { copyText(r.url, 'Client link copied') })
  acts.appendChild(copy)
  var proj = SNAP.projects.find(function (x) { return x.id === r.projectId })
  if (proj) {
    var go = el('<button class="do-alt">Project</button>')
    go.addEventListener('click', function () { navigate(pageForBucket(proj.bucket)); renderDetail(proj.id) })
    acts.appendChild(go)
  }
  card.appendChild(acts)
  card.appendChild(el('<div class="hint" style="margin-top:7px">Preview does not count as a view. Copy gives the clean link.</div>'))
  return card
}

function propStateLabel(s) {
  return s === 'live' ? 'Live' : s === 'draft' ? 'Draft' : s === 'expired' ? 'Expired' : 'Down'
}
function propStateClass(s) {
  return s === 'live' ? 'due' : s === 'expired' ? 'overdue' : s === 'draft' ? '' : 'arch'
}

// ---- the proposal, INSIDE the CRM ----
//
// Michael, 2026-09-21: "whenever I click preview on a proposal or if I look at the proposal
// template, it moves me over to Firefox. And I don't want to have to look at these things in a
// separate browser. I want it to pull up as an embedded page within the CRM, just like you did in
// my laptop app."
//
// So this is the phone's version of PreviewPage.tsx: one full-screen pane, a bar with Back, and the
// real page in an iframe underneath. It frames the ACTUAL URL rather than re-rendering the proposal,
// for the same reason the desktop does: a second implementation would drift from the first the
// moment either is edited, and the whole point is to trust what he is looking at.
//
// ⚠️ NOTHING HERE MAY EVER COUNT AS A VIEW. `src` is always the server-built `openUrl`, which
// already carries preview=1 and, for anything the public can no longer reach, the admin key. The
// clean link is `publicUrl` and is only ever copied. Never point this at a raw proposal URL and
// never build the URL here.
//
// An overlay rather than a router destination, deliberately: dismissing it puts him back exactly
// where he was, whether that was the Proposals page or a project's Booking tab, with no bookkeeping
// about where "back" should go.
function openPreview(opts) {
  var o = opts || {}
  if (!o.src) { toast('No link for that.', 'err'); return }
  var pane = el(
    '<div class="previewpane">' +
      '<div class="pv-bar">' +
        '<button class="pv-back" aria-label="Back">' +
        '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>' +
        '<span>' + esc(o.backLabel || 'Back') + '</span></button>' +
        '<div class="pv-t"><div class="pv-title">' + esc(o.title || 'Preview') + '</div>' +
        '<div class="pv-sub">Preview. Not counted as a view.</div></div>' +
      '</div>' +
      '<div class="pv-body"><div class="pv-load">Loading the page the client sees…</div></div>' +
    '</div>'
  )
  var body = pane.querySelector('.pv-body')
  var close = function () {
    pane.remove()
    document.body.classList.remove('previewing')
    window.removeEventListener('popstate', onPop)
  }
  // The iPhone's own back swipe and the Android back button both raise popstate. Pushing a state
  // means the hardware/gesture back closes the preview instead of leaving the app.
  var onPop = function () { close() }
  try { history.pushState({ preview: 1 }, '') } catch (_) { /* not fatal */ }
  window.addEventListener('popstate', onPop)
  pane.querySelector('.pv-back').addEventListener('click', function () {
    try { history.back() } catch (_) { close() }
  })

  var frame = document.createElement('iframe')
  frame.className = 'pv-frame'
  frame.src = o.src
  frame.setAttribute('referrerpolicy', 'no-referrer')
  frame.addEventListener('load', function () {
    var l = body.querySelector('.pv-load')
    if (l) l.remove()
    frame.style.opacity = '1'
  })
  frame.style.opacity = '0'
  body.appendChild(frame)

  if (o.publicUrl) {
    var copy = el('<button class="pv-copy">Copy the link to send</button>')
    copy.addEventListener('click', function () { copyText(o.publicUrl, 'Client link copied') })
    pane.appendChild(copy)
  }

  document.body.appendChild(pane)
  document.body.classList.add('previewing')
}

// ---------- Finance ----------
//
// ⚠️ A PORT OF src/components/FinancePage.tsx ON THE MAC (2026-10-23). Michael: "the finance page is
// severely lacking". The phone used to show three numbers. This is the Mac's page, tab for tab, with
// the same rules underneath, so the two apps can never disagree about money:
//   - Money RECEIVED comes from QuickBooks for every month it covers, and from logged payments before
//     that (blended per month; phone-api `finance-qbo` is the same report the Mac reads).
//   - Money EARNED is logged payments counted in the gig's event month.
//   - "After business expenses" is ONE window: 12 months received, minus what QuickBooks says he spent.
//   - Goals and the month blocks track the same number as the cards above them.
// The reasoning behind each rule lives in the Mac file's comments; do not re-derive it here.
var FIN_TAB = 'overview'
var FIN_BASIS = 'received'
var FIN_TIPS = false
var FIN_QBO = null
var FIN_BANK = null
var FIN_LOADS = { qbo: false, bank: false }
var FIN_EDIT_GOALS = null // null, or the draft list of goal strings while editing
var FIN_EDIT_MONTHLY = false

function renderFinance() {
  var v = $('#view'); v.innerHTML = ''
  var seg = el('<div class="seg fin-tabs"></div>')
  ;[['overview', 'Overview'], ['payments', 'Payments'], ['tips', 'Tips'], ['expenses', 'Expenses'], ['mileage', 'Mileage']].forEach(function (t) {
    var b = el('<button class="segb' + (FIN_TAB === t[0] ? ' on' : '') + '">' + t[1] + '</button>')
    b.addEventListener('click', function () { if (FIN_TAB === t[0]) return; FIN_TAB = t[0]; renderFinance(); window.scrollTo(0, 0) })
    seg.appendChild(b)
  })
  v.appendChild(seg)
  var body = el('<div class="fin-body"></div>')
  v.appendChild(body)
  if (FIN_TAB === 'payments') finPayments(body)
  else if (FIN_TAB === 'tips') finTips(body)
  else if (FIN_TAB === 'expenses') finExpenses(body)
  else if (FIN_TAB === 'mileage') finMileage(body)
  else finOverview(body)
}
// Repaint the Finance page once an async figure lands, unless he is typing into it.
function finRepaint() {
  if (TAB === 'finance' && !DETAIL_ID && !isEditingActive() && !document.querySelector('.sheet')) renderFinance()
}

// The breakdown behind any figure: which projects fed it, largest first, tap a name to open it.
function openBreakdown(title, subtitle, items) {
  var sheet = el('<div class="sheet"><div class="sheet-card sheet-tall"><div class="sheet-head"><div class="sheet-title"></div>' +
    '<button class="sheet-x" aria-label="Close"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button></div>' +
    '<div class="sheet-body"></div></div></div>')
  sheet.querySelector('.sheet-title').textContent = title
  var body = sheet.querySelector('.sheet-body')
  var close = function () { sheet.remove() }
  sheet.querySelector('.sheet-x').addEventListener('click', close)
  sheet.addEventListener('click', function (e) { if (e.target === sheet) close() })
  if (subtitle) body.appendChild(el('<p class="hint" style="margin:0 0 10px">' + esc(subtitle) + '</p>'))
  var rows = (items || []).slice().sort(function (a, b) { return b.amount - a.amount })
  if (!rows.length) body.appendChild(el('<div class="empty">Nothing contributing to this figure yet.</div>'))
  var list = el('<div class="bd-list"></div>')
  var total = 0
  rows.forEach(function (it) {
    total += Number(it.amount) || 0
    var proj = it.id && SNAP.projects.find(function (p) { return p.id === it.id })
    var row = el('<div class="bd-row"><span class="bd-name">' + esc(it.name || '(unassigned)') + '</span><span class="bd-amt">' + esc(money(it.amount)) + '</span></div>')
    if (proj) {
      row.classList.add('bd-link')
      row.addEventListener('click', function () { close(); TAB = pageForBucket(proj.bucket); renderDetail(proj.id) })
    }
    list.appendChild(row)
  })
  body.appendChild(list)
  if (rows.length) body.appendChild(el('<div class="bd-foot"><span>' + rows.length + ' project' + (rows.length === 1 ? '' : 's') + '</span><span>Total <b>' + esc(money(total)) + '</b></span></div>'))
  document.body.appendChild(sheet)
}

function finFigure(label, value, hint, color, onClick) {
  var b = el('<button class="fin-fig"><div class="fin-l">' + esc(label) + '</div><div class="fin-n"' + (color ? ' style="color:' + color + '"' : '') + '>' + esc(value) + '</div>' +
    (hint ? '<div class="fin-h">' + esc(hint) + '</div>' : '') + '</button>')
  if (onClick) b.addEventListener('click', onClick)
  else b.disabled = true
  return b
}
function finNet(received, expenses) {
  return el('<div class="fin-net"><div class="fin-l">' + (FIN_BASIS === 'received' ? 'After business expenses' : 'Received, after business expenses') + '</div>' +
    '<div class="fin-n2">' + esc(money2(received - expenses)) + '</div>' +
    '<div class="fin-h">' + esc(money2(received)) + ' received, minus ' + esc(money2(expenses)) + ' in business expenses</div>' +
    (FIN_BASIS === 'earned' ? '<div class="fin-h">still on money received, not earned, so expenses line up with the month they were paid</div>' : '') +
    '</div>')
}

function finOverview(body) {
  var f = SNAP.finance
  if (!f) { body.appendChild(el('<div class="empty">Loading finances…</div>')); return }
  if (!FIN_LOADS.qbo) { FIN_LOADS.qbo = true; loadQuickBooksMonths().then(function (d) { FIN_QBO = d; finRepaint() }) }
  if (!FIN_LOADS.bank) { FIN_LOADS.bank = true; loadBankBalances().then(function (d) { FIN_BANK = d; finRepaint() }) }

  var basis = FIN_BASIS, tips = FIN_TIPS
  var valueOf = function (m) { return (basis === 'received' ? m.received : m.earned) + (tips ? m.tips : 0) }
  var baseItems = function (m) { return basis === 'received' ? m.receivedItems : m.earnedItems }
  var itemsOf = function (m) {
    return tips ? baseItems(m).concat((m.tipItems || []).map(function (t) { return { id: t.id, name: t.name + ' · tip', amount: t.amount } })) : baseItems(m)
  }
  var basisLabel = basis === 'received' ? 'Money received' : 'Money earned'
  var tipNote = tips ? ' + tips' : ''
  var itemSubtitle = (basis === 'received' ? 'Payments by date received, by project' : 'Payments by event month, by project') + (tips ? ' (tips included)' : '')
  var last12Value = valueOf(f.last12)
  var crmReceived = function (m) { return m.received + (tips ? m.tips : 0) }
  var qbMonths = FIN_QBO && FIN_QBO.connected ? (FIN_QBO.months || []) : []
  var qbBy = {}
  qbMonths.forEach(function (m) { qbBy[m.month] = m })
  var usingQB = qbMonths.some(function (m) { return m.covered })
  var moneyFor = function (m) { var q = qbBy[m.key]; return q && q.covered ? q.income + (tips ? m.tips : 0) : crmReceived(m) }
  var months = f.months || []
  var thisKey = months.length ? months[months.length - 1].key : ''
  var thisQb = qbBy[thisKey]
  var thisMonthValue = thisQb && thisQb.covered ? thisQb.income + (tips ? f.thisMonth.tips : 0) : crmReceived(f.thisMonth)
  var last12Received = usingQB ? months.reduce(function (s2, m) { return s2 + moneyFor(m) }, 0) : crmReceived(f.last12)
  var goalValue = basis === 'received' && usingQB ? last12Received : last12Value
  var windowExpenses = qbMonths.filter(function (m) { return m.covered }).reduce(function (s2, m) { return s2 + m.expenses }, 0)
  var monthlyGoal = Math.max(1, f.monthlyGoal)

  // Master controls: one basis toggle and the tips switch drive every figure on the page.
  body.appendChild(el('<p class="fin-intro"><b>Money received</b> comes from <b>QuickBooks</b> for every month it covers, and from the <b>payments</b> you\'ve logged before that. It counts money in the month it arrived. <b>Money earned</b> is your logged payments only, counted in the gig\'s event month. The quote and tips stay out unless you turn tips on.</p>'))
  var ctrl = el('<div class="fin-ctrl"><label class="fin-check"><input type="checkbox"' + (tips ? ' checked' : '') + '> Include tips</label><div class="seg fin-basis"></div></div>')
  ctrl.querySelector('input').addEventListener('change', function (e) { FIN_TIPS = e.target.checked; renderFinance() })
  ;[['received', 'Received'], ['earned', 'Earned']].forEach(function (o) {
    var b = el('<button class="segb' + (basis === o[0] ? ' on' : '') + '">' + o[1] + '</button>')
    b.addEventListener('click', function () { if (FIN_BASIS === o[0]) return; FIN_BASIS = o[0]; renderFinance() })
    ctrl.querySelector('.fin-basis').appendChild(b)
  })
  body.appendChild(ctrl)

  body.appendChild(finBankCard())

  // This month
  var c1 = el('<div class="fin-card"><div class="fin-cap">This month' + esc(tipNote) + '</div></div>')
  c1.appendChild(finFigure(basisLabel,
    basis === 'received' && thisQb && thisQb.covered ? money2(thisMonthValue) : money(valueOf(f.thisMonth)),
    basis === 'received' ? 'money that hit your account this month' : 'payments for gigs performed this month', null,
    function () { openBreakdown('This month · ' + basisLabel, itemSubtitle, itemsOf(f.thisMonth)) }))
  if (thisQb && thisQb.covered) c1.appendChild(finNet(thisMonthValue, thisQb.expenses))
  body.appendChild(c1)

  // Last 12 months
  var c2 = el('<div class="fin-card"><div class="fin-cap">Last 12 months' + esc(tipNote) + '</div></div>')
  c2.appendChild(finFigure(basisLabel,
    basis === 'received' && usingQB ? money2(last12Received) : money(last12Value),
    basis === 'received' ? 'money received over the last 12 months' : 'payments by event month, last 12 months', null,
    function () { openBreakdown('Last 12 months · ' + basisLabel, itemSubtitle, itemsOf(f.last12)) }))
  if (usingQB) c2.appendChild(finNet(last12Received, windowExpenses))
  body.appendChild(c2)

  // Still expected
  var c3 = el('<div class="fin-card"><div class="fin-cap">Still expected to come in</div></div>')
  var fig3 = finFigure('', money(f.expectedRemaining), 'if every active gig closes and no one cancels', 'var(--brass)',
    function () { openBreakdown('Still expected to come in', 'Quote minus what each active gig has already paid', f.expectedItems) })
  fig3.querySelector('.fin-l').remove()
  fig3.appendChild(el('<div class="fin-h" style="opacity:.8">from the quote, not yet in the door</div>'))
  c3.appendChild(fig3)
  body.appendChild(c3)

  // Goals
  var gh = el('<div class="fin-sec"><span>Goals</span></div>')
  body.appendChild(gh)
  if (FIN_EDIT_GOALS) {
    var ed = el('<div class="fin-card fin-goaledit"></div>')
    FIN_EDIT_GOALS.forEach(function (g, i) {
      var row = el('<div class="goal-row"><span>$</span><input class="field-input" inputmode="numeric" placeholder="Goal amount"><span class="faint">/ yr</span><button class="taskdel" aria-label="Remove">×</button></div>')
      var inp = row.querySelector('input'); inp.value = g
      inp.addEventListener('input', function () { FIN_EDIT_GOALS[i] = inp.value })
      row.querySelector('button').addEventListener('click', function () { FIN_EDIT_GOALS.splice(i, 1); renderFinance() })
      ed.appendChild(row)
    })
    var addG = el('<button class="linkbtn">+ Add goal</button>')
    addG.addEventListener('click', function () { FIN_EDIT_GOALS.push(''); renderFinance() })
    ed.appendChild(addG)
    var bar = el('<div class="addrow" style="margin-top:12px"><button class="btn-ghost">Cancel</button><button class="btn-gold">Save</button></div>')
    bar.children[0].addEventListener('click', function () { FIN_EDIT_GOALS = null; renderFinance() })
    bar.children[1].addEventListener('click', function () {
      var nums = FIN_EDIT_GOALS.map(function (x) { return Number(String(x).replace(/[^0-9.]/g, '')) }).filter(function (n) { return n > 0 })
      if (!nums.length) nums = [80000]
      doWrite(saveConfigPatch({ incomeGoals: nums }), 'Goals saved', function () {
        nums.sort(function (a, b) { return a - b })
        SNAP.config.incomeGoals = nums
        f.goals = nums.map(function (g) { return { goal: g } })
        FIN_EDIT_GOALS = null
        renderFinance()
      })
    })
    ed.appendChild(bar)
    body.appendChild(ed)
  } else {
    var editBtn = el('<button class="fin-edit">Edit</button>')
    editBtn.addEventListener('click', function () { FIN_EDIT_GOALS = (f.goals || []).map(function (g) { return String(g.goal) }); renderFinance() })
    gh.appendChild(editBtn)
    var gl = el('<div class="fin-goals"></div>')
    ;(f.goals || []).forEach(function (g) {
      var pct = g.goal ? goalValue / g.goal : 0
      gl.appendChild(el('<div class="goal"><div class="goal-top"><b>$' + (g.goal / 1000).toLocaleString('en-US') + 'k / yr</b><span>' + esc(money(goalValue)) + ' (' + Math.round(pct * 100) + '%)</span></div>' +
        '<div class="goal-bar"><span style="width:' + Math.min(100, Math.max(0, pct * 100)) + '%"></span></div></div>'))
    })
    body.appendChild(gl)
    body.appendChild(el('<p class="fin-foot">Tracking ' + esc(basisLabel.toLowerCase()) + ' over the last 12 months against each goal' + (tips ? ', tips included' : '') +
      (basis === 'received' && usingQB ? ', from QuickBooks where it has the data' : '') + '.</p>'))
  }

  // Month by month
  var mh = el('<div class="fin-sec"><span>Month by month</span></div>')
  if (FIN_EDIT_MONTHLY) {
    var me = el('<span class="fin-monthly-edit">Goal $<input class="field-input" inputmode="numeric"><button class="fin-edit">Save</button><button class="fin-edit">Cancel</button></span>')
    var mi = me.querySelector('input'); mi.value = String(f.monthlyGoal)
    var saveM = function () {
      var n = Number(String(mi.value).replace(/[^0-9.]/g, ''))
      var val = n > 0 ? n : 10000
      doWrite(saveConfigPatch({ monthlyGoal: val }), 'Monthly goal saved', function () { SNAP.config.monthlyGoal = val; f.monthlyGoal = val; FIN_EDIT_MONTHLY = false; renderFinance() })
    }
    me.querySelectorAll('button')[0].addEventListener('click', saveM)
    me.querySelectorAll('button')[1].addEventListener('click', function () { FIN_EDIT_MONTHLY = false; renderFinance() })
    mi.addEventListener('keydown', function (e) { if (e.key === 'Enter') saveM() })
    mh.appendChild(me)
    setTimeout(function () { mi.focus() }, 30)
  } else {
    var mb = el('<button class="fin-goal-link">Goal ' + esc(money(f.monthlyGoal)) + '/mo · edit</button>')
    mb.addEventListener('click', function () { FIN_EDIT_MONTHLY = true; renderFinance() })
    mh.appendChild(mb)
  }
  body.appendChild(mh)
  var grid = el('<div class="fin-months"></div>')
  months.forEach(function (m) {
    var fromQb = basis === 'received' && !!(qbBy[m.key] && qbBy[m.key].covered)
    var val = basis === 'received' && usingQB ? moneyFor(m) : valueOf(m)
    var pct = Math.min(1, val / monthlyGoal)
    var b = el('<button class="fin-month"><span class="fin-fill" style="height:' + (pct * 100) + '%"></span><span class="fin-ml">' + esc(m.label) + '</span><span class="fin-mv">' + esc(money(val)) + '</span></button>')
    b.addEventListener('click', function () {
      openBreakdown(m.label + ' · ' + basisLabel, fromQb ? itemSubtitle + ". The month's total comes from QuickBooks; this is the gig-by-gig record behind it." : itemSubtitle, itemsOf(m))
    })
    grid.appendChild(b)
  })
  body.appendChild(grid)
  if (!f.hasPayments) body.appendChild(el('<p class="fin-foot">No payments logged yet. Log them on each project (or the Payments tab) and these figures fill in.</p>'))
}

// What is actually sitting in the bank, read off YNAB (the bank-balances function). Shows the
// CLEARED balance and shouts when the reconcile is stale, exactly as the Mac does and for the same
// reason: YNAB's ledger silently drifts from the bank when an import is missed.
function finBankCard() {
  var d = FIN_BANK
  var card = el('<div class="fin-card"><div class="fin-cap fin-caprow"><span>In the bank</span><span class="fin-asof"></span></div><div class="fin-bank"></div></div>')
  var refresh = el('<button class="fin-edit">Refresh</button>')
  refresh.addEventListener('click', function () {
    refresh.disabled = true; refresh.textContent = 'Checking…'
    loadBankBalances(true).then(function (x) { FIN_BANK = x; renderFinance() })
  })
  var box = card.querySelector('.fin-bank')
  if (!d) { box.appendChild(el('<p class="fin-h">Checking the bank…</p>')); return card }
  if (d.generatedAt) card.querySelector('.fin-asof').textContent = 'as of ' + new Date(d.generatedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  card.querySelector('.fin-caprow').appendChild(refresh)
  if (!d.connected) {
    box.appendChild(el('<p class="fin-h"><b>Not connected yet.</b> Balances come from YNAB, which holds the read-only link to Coastal. ' + esc(d.reason || '') + '</p>'))
    return card
  }
  var accts = d.accounts || []
  if (!accts.length) { box.appendChild(el('<p class="fin-h">Connected to YNAB, but no open accounts came back. Check that Coastal is still linked in YNAB.</p>')); return card }
  accts.forEach(function (a) {
    var drift = Math.abs(a.balance - a.cleared) >= 0.01
    var rec = a.lastReconciledAt ? new Date(a.lastReconciledAt) : null
    var daysStale = rec ? Math.floor((Date.now() - rec.getTime()) / 86400000) : null
    var stale = daysStale === null || daysStale > 7
    box.appendChild(el('<div class="acct"><div class="acct-n">' + esc(a.name) + '</div>' +
      '<div class="acct-v"' + (a.cleared < 0 ? ' style="color:var(--red)"' : '') + '>' + esc(money(a.cleared)) + '</div>' +
      (drift ? '<div class="fin-h">' + esc(money(a.balance)) + ' in YNAB</div>' : '') +
      '<div class="fin-h"' + (stale ? ' style="color:var(--brass)"' : '') + '>' +
        (rec ? (daysStale === 0 ? 'Reconciled today' : 'Reconciled ' + daysStale + ' day' + (daysStale === 1 ? '' : 's') + ' ago' + (stale ? ', may be wrong' : '')) : 'Never reconciled, treat as unreliable') +
      '</div></div>'))
  })
  if (accts.length > 1 && typeof d.total === 'number') box.appendChild(el('<p class="fin-h" style="margin-top:8px">Across every account: <b>' + esc(money(d.total)) + '</b></p>'))
  if (d.budgetName) box.appendChild(el('<p class="fin-h">YNAB budget: ' + esc(d.budgetName) + '</p>'))
  return card
}

function projectOptions(selected, sortBy) {
  var list = (SNAP.projects || []).filter(function (p) { return p.bucket !== 'deleted' }).slice()
  if (sortBy === 'date') list.sort(function (a, b) { return (b.eventDate || '').localeCompare(a.eventDate || '') })
  else list.sort(function (a, b) { return (a.client || '').localeCompare(b.client || '') })
  return '<option value="">(none)</option>' + list.map(function (p) {
    return '<option value="' + esc(p.id) + '"' + (p.id === selected ? ' selected' : '') + '>' + esc(p.client) + (sortBy === 'date' && p.eventDate ? ' · ' + esc(fmtShort(p.eventDate)) : '') + '</option>'
  }).join('')
}
function openProjectById(id) {
  var p = (SNAP.projects || []).find(function (x) { return x.id === id })
  if (!p) return
  TAB = pageForBucket(p.bucket)
  renderDetail(p.id)
}
// Payments changed somewhere: refetch them and recompute every figure, the same as the project page.
function refreshPaymentsFinance(after) {
  reloadPaymentsFinance(SNAP.projects, SNAP.config).then(function (r) {
    SNAP.payments = r.payments
    SNAP.finance = r.finance
    if (after) after()
  })
}

// ---- Payments tab: every payment, newest first, with add and delete ----
function finPayments(body) {
  body.appendChild(el('<p class="fin-intro">Every payment you\'ve logged, newest first. These feed Money earned, and Money received for the months QuickBooks does not cover. A payment can belong to a project or stand on its own.</p>'))
  var form = el('<div class="fin-card fin-form">' +
    '<div class="ff-row"><label>Date<input type="date" class="field-input" id="fp-date"></label><label>Amount<input class="field-input" id="fp-amt" inputmode="decimal" placeholder="$"></label></div>' +
    '<label>Project<select class="field-input" id="fp-proj">' + projectOptions('', 'name') + '</select></label>' +
    '<div class="ff-row"><label>Type<select class="field-input" id="fp-type"><option value="deposit">Deposit</option><option value="balance">Balance</option><option value="full">Full</option><option value="other">Other</option></select></label>' +
    '<label>Method<select class="field-input" id="fp-method"><option value="">-</option>' + PAYMENT_METHODS.map(function (m) { return '<option' + (m === 'QuickBooks invoice' ? ' selected' : '') + '>' + esc(m) + '</option>' }).join('') + '</select></label></div>' +
    '<button class="btn-gold" id="fp-add" style="width:100%;margin-top:10px">Add payment</button></div>')
  form.querySelector('#fp-date').value = todayStr()
  var addBtn = form.querySelector('#fp-add')
  var amt = form.querySelector('#fp-amt')
  var sync = function () { addBtn.disabled = !amt.value.trim(); addBtn.style.opacity = addBtn.disabled ? 0.45 : 1 }
  amt.addEventListener('input', sync); sync()
  addBtn.addEventListener('click', function () {
    if (addBtn.disabled) return
    doWrite(addPayment({
      projectId: form.querySelector('#fp-proj').value,
      amount: amt.value,
      dateReceived: form.querySelector('#fp-date').value,
      type: form.querySelector('#fp-type').value,
      method: form.querySelector('#fp-method').value,
    }), 'Payment logged', function () { refreshPaymentsFinance(renderFinance) })
  })
  body.appendChild(form)

  var pays = (SNAP.payments || []).slice().sort(function (a, b) { return String(b.dateReceived || '').localeCompare(String(a.dateReceived || '')) })
  var total = pays.reduce(function (s2, p) { return s2 + (Number(p.amount) || 0) }, 0)
  body.appendChild(el('<div class="fin-sec"><span>' + pays.length + ' payment' + (pays.length === 1 ? '' : 's') + '</span><span class="fin-sec-r">Total logged <b>' + esc(money(total)) + '</b></span></div>'))
  if (!pays.length) { body.appendChild(el('<div class="empty">No payments logged yet.</div>')); return }
  var list = el('<div class="fin-card fin-list"></div>')
  pays.forEach(function (pm) {
    var proj = pm.projectId && SNAP.projects.find(function (p) { return p.id === pm.projectId })
    var row = el('<div class="fl-row"><div class="fl-main"><div class="fl-top"><span class="fl-name">' + esc(proj ? proj.client : '(unassigned)') + '</span><span class="fl-amt">' + esc(money(pm.amount)) + '</span></div>' +
      '<div class="fl-meta">' + esc(pm.dateReceived ? fmtShort(pm.dateReceived) : 'No date') + (pm.method ? '<span class="pill">' + esc(pm.method) + '</span>' : '') + (pm.type ? '<span class="pill">' + esc(String(pm.type).toUpperCase()) + '</span>' : '') + (pm.pending ? '<span class="pill due">Pending</span>' : '') + '</div></div>' +
      '<button class="taskdel" aria-label="Delete payment"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button></div>')
    if (proj) row.querySelector('.fl-name').addEventListener('click', function () { openProjectById(proj.id) })
    row.querySelector('.taskdel').addEventListener('click', function () {
      if (!confirm('Delete this ' + money(pm.amount) + ' payment?')) return
      doWrite(deletePayment(pm.id), 'Payment deleted', function () { refreshPaymentsFinance(renderFinance) })
    })
    list.appendChild(row)
  })
  body.appendChild(list)
}

// ---- Tips tab ----
var FIN_TIP_FROM = ''
var FIN_TIP_TO = ''
var FIN_TIP_OVER = false
function finTips(body) {
  if (!FIN_TIP_FROM) FIN_TIP_FROM = todayStr().slice(0, 8) + '01'
  if (!FIN_TIP_TO) FIN_TIP_TO = todayStr()
  var range = el('<div class="fin-card fin-form"><div class="ff-row"><label>From<input type="date" class="field-input"></label><label>To<input type="date" class="field-input"></label></div></div>')
  var ins = range.querySelectorAll('input')
  ins[0].value = FIN_TIP_FROM; ins[1].value = FIN_TIP_TO
  ins[0].addEventListener('change', function () { FIN_TIP_FROM = ins[0].value; renderFinance() })
  ins[1].addEventListener('change', function () { FIN_TIP_TO = ins[1].value; renderFinance() })
  body.appendChild(range)
  var live = (SNAP.projects || []).filter(function (p) { return p.bucket !== 'deleted' })
  var inRange = function (d) { return d && d >= FIN_TIP_FROM && d <= FIN_TIP_TO }
  var tipped = live.filter(function (p) { return (Number(p.tips) || 0) > 0 && inRange(p.eventDate) })
    .sort(function (a, b) { return (b.eventDate || '').localeCompare(a.eventDate || '') })
  var total = tipped.reduce(function (s2, p) { return s2 + Number(p.tips) }, 0)
  body.appendChild(el('<div class="fin-card"><div class="fin-cap">Tips in range</div><div class="fin-n">' + esc(money(total)) + '</div></div>'))
  if (!tipped.length) body.appendChild(el('<div class="empty">No tips in this range. Add a tip on a project\'s Details.</div>'))
  else {
    var list = el('<div class="fin-card fin-list"></div>')
    tipped.forEach(function (p) {
      var row = el('<div class="fl-row fl-tap"><div class="fl-main"><div class="fl-top"><span class="fl-name">' + esc(p.client) + '</span><span class="fl-amt">' + esc(money(p.tips)) + '</span></div>' +
        '<div class="fl-meta">' + esc(fmtShort(p.eventDate)) + '<span class="pill">' + esc(p.tipsMethod || 'Cash') + '</span></div></div></div>')
      row.addEventListener('click', function () { openProjectById(p.id) })
      list.appendChild(row)
    })
    body.appendChild(list)
  }
  // Gigs that paid more than their quote: the money that came in above the agreed fee.
  var chk = el('<label class="fin-check" style="margin:14px 2px 8px"><input type="checkbox"' + (FIN_TIP_OVER ? ' checked' : '') + '> Show gigs paid above their quote</label>')
  chk.querySelector('input').addEventListener('change', function (e) { FIN_TIP_OVER = e.target.checked; renderFinance() })
  body.appendChild(chk)
  if (FIN_TIP_OVER) {
    var paid = {}
    ;(SNAP.payments || []).forEach(function (pm) { if (!pm.pending && pm.dateReceived && Number(pm.amount) > 0) paid[pm.projectId] = (paid[pm.projectId] || 0) + Number(pm.amount) })
    var over = live.filter(function (p) { return typeof p.totalFee === 'number' && inRange(p.eventDate) && (paid[p.id] || 0) > p.totalFee + 0.005 })
      .map(function (p) { return { p: p, paid: paid[p.id], over: paid[p.id] - p.totalFee } })
      .sort(function (a, b) { return b.over - a.over })
    var sum = over.reduce(function (s2, o) { return s2 + o.over }, 0)
    body.appendChild(el('<div class="fin-sec"><span>' + over.length + ' gig' + (over.length === 1 ? '' : 's') + ' over quote</span><span class="fin-sec-r">+' + esc(money(sum)) + ' over</span></div>'))
    if (over.length) {
      var ol = el('<div class="fin-card fin-list"></div>')
      over.forEach(function (o) {
        var row = el('<div class="fl-row fl-tap"><div class="fl-main"><div class="fl-top"><span class="fl-name">' + esc(o.p.client) + '</span><span class="fl-amt" style="color:var(--green)">+' + esc(money(o.over)) + '</span></div>' +
          '<div class="fl-meta">' + esc(money(o.p.totalFee)) + ' quote · ' + esc(money(o.paid)) + ' paid</div></div></div>')
        row.addEventListener('click', function () { openProjectById(o.p.id) })
        ol.appendChild(row)
      })
      body.appendChild(ol)
    }
  }
}

// ---- Expenses tab: recurring overhead ----
var EXPENSE_PER_MONTH = { monthly: 1, quarterly: 1 / 3, yearly: 1 / 12, weekly: 52 / 12, 'one-time': 0 }
var FIN_EXPENSES = null
function finExpenses(body) {
  if (!FIN_EXPENSES) {
    body.appendChild(el('<div class="empty">Loading expenses…</div>'))
    loadExpenses().then(function (x) { FIN_EXPENSES = x; finRepaint() }).catch(function (e) { toast(e.message || 'Could not load expenses', 'err') })
    return
  }
  var monthly = FIN_EXPENSES.reduce(function (s2, e) { return s2 + (Number(e.amount) || 0) * (EXPENSE_PER_MONTH[e.cadence] || 0) }, 0)
  body.appendChild(el('<div class="fin-pair"><div class="fin-card"><div class="fin-cap">Monthly overhead</div><div class="fin-n">' + esc(money(monthly)) + '</div></div>' +
    '<div class="fin-card"><div class="fin-cap">Annual overhead</div><div class="fin-n">' + esc(money(monthly * 12)) + '</div></div></div>'))
  var form = el('<div class="fin-card fin-form"><label>Name<input class="field-input" id="fe-name" placeholder="e.g. Website hosting"></label>' +
    '<div class="ff-row"><label>Amount<input class="field-input" id="fe-amt" inputmode="decimal" placeholder="$"></label><label>Cadence<select class="field-input" id="fe-cad">' +
    EXPENSE_CADENCES.map(function (c) { return '<option value="' + c + '">' + c.charAt(0).toUpperCase() + c.slice(1) + '</option>' }).join('') + '</select></label></div>' +
    '<label>Category (optional)<input class="field-input" id="fe-cat"></label><button class="btn-gold" id="fe-add" style="width:100%;margin-top:10px">Add expense</button></div>')
  var name = form.querySelector('#fe-name'), amt = form.querySelector('#fe-amt'), addBtn = form.querySelector('#fe-add')
  var sync = function () { addBtn.disabled = !(name.value.trim() && amt.value.trim()); addBtn.style.opacity = addBtn.disabled ? 0.45 : 1 }
  name.addEventListener('input', sync); amt.addEventListener('input', sync); sync()
  addBtn.addEventListener('click', function () {
    if (addBtn.disabled) return
    doWrite(addExpense({ name: name.value, amount: amt.value, cadence: form.querySelector('#fe-cad').value, category: form.querySelector('#fe-cat').value }), 'Expense added', function (e) {
      FIN_EXPENSES.push(e); renderFinance()
    })
  })
  body.appendChild(form)
  if (!FIN_EXPENSES.length) { body.appendChild(el('<div class="empty">No recurring expenses yet.</div>')); return }
  var list = el('<div class="fin-card fin-list"></div>')
  FIN_EXPENSES.forEach(function (e) {
    var per = (Number(e.amount) || 0) * (EXPENSE_PER_MONTH[e.cadence] || 0)
    var row = el('<div class="fl-row"><div class="fl-main"><div class="fl-top"><span class="fl-name">' + esc(e.name) + (e.category ? ' <span class="faint">· ' + esc(e.category) + '</span>' : '') + '</span><span class="fl-amt">' + esc(money(e.amount)) + '</span></div>' +
      '<div class="fl-meta"><span class="pill">' + esc(e.cadence) + '</span>' + esc(money(per)) + '/mo</div></div>' +
      '<button class="taskdel" aria-label="Delete expense"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button></div>')
    row.querySelector('.taskdel').addEventListener('click', function () {
      if (!confirm('Delete "' + e.name + '"?')) return
      doWrite(deleteExpense(e.id), 'Expense deleted', function () { FIN_EXPENSES = FIN_EXPENSES.filter(function (x) { return x.id !== e.id }); renderFinance() })
    })
    list.appendChild(row)
  })
  body.appendChild(list)
}

// ---- Mileage tab ----
var FIN_MILEAGE = null
function finMileage(body) {
  if (!FIN_MILEAGE) {
    body.appendChild(el('<div class="empty">Loading mileage…</div>'))
    loadMileage().then(function (x) { FIN_MILEAGE = x; finRepaint() }).catch(function (e) { toast(e.message || 'Could not load mileage', 'err') })
    return
  }
  var year = todayStr().slice(0, 4), today = todayStr()
  var gigMiles = (SNAP.projects || []).filter(function (p) { return p.bucket !== 'deleted' && p.eventDate && p.eventDate.slice(0, 4) === year && p.eventDate <= today })
    .reduce(function (s2, p) { return s2 + (Number(p.mileage) || 0) }, 0)
  var tripMiles = FIN_MILEAGE.trips.filter(function (t) { return (t.date || '').slice(0, 4) === year }).reduce(function (s2, t) { return s2 + (Number(t.miles) || 0) }, 0)
  var total = gigMiles + tripMiles
  var cards = el('<div class="fin-pair">' +
    '<div class="fin-card"><div class="fin-cap">Miles · ' + year + '</div><div class="fin-n">' + Math.round(total).toLocaleString('en-US') + '</div><div class="fin-h">' + Math.round(gigMiles).toLocaleString('en-US') + ' from gigs · ' + Math.round(tripMiles).toLocaleString('en-US') + ' other</div></div>' +
    '<div class="fin-card"><div class="fin-cap">Est. deduction · ' + year + '</div><div class="fin-n">' + esc(money(total * FIN_MILEAGE.rate)) + '</div><div class="fin-h">at the rate below</div></div></div>')
  body.appendChild(cards)
  var rate = el('<div class="fin-card fin-form"><label>Rate per mile<input class="field-input" inputmode="decimal"></label></div>')
  var ri = rate.querySelector('input'); ri.value = String(FIN_MILEAGE.rate)
  ri.addEventListener('blur', function () {
    var r = Number(ri.value)
    if (r === FIN_MILEAGE.rate) return
    doWrite(setMileageRate(r), 'Rate saved', function (saved) { FIN_MILEAGE.rate = saved; renderFinance() })
  })
  body.appendChild(rate)
  var form = el('<div class="fin-card fin-form"><div class="ff-row"><label>Date<input type="date" class="field-input" id="fm-date"></label><label>Miles<input class="field-input" id="fm-miles" placeholder="e.g. 12+15"></label></div>' +
    '<label>Purpose<input class="field-input" id="fm-purpose" placeholder="e.g. Supplies run"></label>' +
    '<label>Project<select class="field-input" id="fm-proj">' + projectOptions('', 'date') + '</select></label>' +
    '<button class="btn-gold" id="fm-add" style="width:100%;margin-top:10px">Add trip</button></div>')
  form.querySelector('#fm-date').value = todayStr()
  var miles = form.querySelector('#fm-miles'), addBtn = form.querySelector('#fm-add')
  var sync = function () { addBtn.disabled = !miles.value.trim(); addBtn.style.opacity = addBtn.disabled ? 0.45 : 1 }
  miles.addEventListener('input', sync); sync()
  miles.addEventListener('blur', function () { miles.value = evalNumberFormula(miles.value) })
  addBtn.addEventListener('click', function () {
    if (addBtn.disabled) return
    miles.value = evalNumberFormula(miles.value)
    doWrite(addTrip({ date: form.querySelector('#fm-date').value, miles: miles.value, purpose: form.querySelector('#fm-purpose').value, projectId: form.querySelector('#fm-proj').value }), 'Trip added', function (t) {
      FIN_MILEAGE.trips.push(t); renderFinance()
    })
  })
  body.appendChild(form)
  var trips = FIN_MILEAGE.trips.slice().sort(function (a, b) { return String(b.date || '').localeCompare(String(a.date || '')) })
  if (!trips.length) { body.appendChild(el('<div class="empty">No other trips logged. Gig miles come from each project.</div>')); return }
  var list = el('<div class="fin-card fin-list"></div>')
  trips.forEach(function (t) {
    var proj = t.projectId && SNAP.projects.find(function (p) { return p.id === t.projectId })
    var row = el('<div class="fl-row"><div class="fl-main"><div class="fl-top"><span class="fl-name">' + esc(t.purpose || 'Trip') + '</span><span class="fl-amt">' + Math.round(Number(t.miles) || 0) + ' mi</span></div>' +
      '<div class="fl-meta">' + esc(t.date ? fmtShort(t.date) : '') + (proj ? ' · ' + esc(proj.client) : '') + '</div></div>' +
      '<button class="taskdel" aria-label="Delete trip"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button></div>')
    row.querySelector('.taskdel').addEventListener('click', function () {
      if (!confirm('Delete this trip?')) return
      doWrite(deleteTrip(t.id), 'Trip deleted', function () { FIN_MILEAGE.trips = FIN_MILEAGE.trips.filter(function (x) { return x.id !== t.id }); renderFinance() })
    })
    list.appendChild(row)
  })
  body.appendChild(list)
}


function alertCard(n) {
  // A brand-new website inquiry is Michael's top-priority alert: render it with a distinct gold
  // border + sparkle + gold title so it visibly stands out from routine alerts (contract/invoice/task).
  var isInquiry = n.kind === 'new-inquiry'
  var cardStyle = isInquiry
    ? ' style="border-color:var(--brass);box-shadow:0 0 0 1px var(--brass);background:color-mix(in oklab, var(--brass) 12%, transparent)"'
    : ''
  var titleText = isInquiry ? ('✨ New inquiry') : (n.label || 'Update')
  var titleStyle = isInquiry
    ? 'font-size:14.5px;color:var(--brass-bright);font-weight:700'
    : 'font-size:14.5px'
  var c = el(
    '<button class="card"' + cardStyle + '>' +
      '<div class="row1"><span class="name" style="' + titleStyle + '">' + esc(titleText) + '</span>' +
      '<span class="fee" style="color:var(--faint);font-variant-numeric:normal">' + esc(timeAgo(n.createdAt)) + '</span></div>' +
      (n.projectName ? '<div class="meta"' + (isInquiry ? ' style="color:var(--brass-bright);font-weight:600"' : '') + '>' + esc(n.projectName) + '</div>' : '') +
    '</button>'
  )
  if (n.projectId) c.addEventListener('click', function () { renderDetail(n.projectId) })
  else c.style.pointerEvents = 'none'
  // Swipe left to uncover Dismiss. Opening the project deliberately does NOT clear the alert:
  // Michael, 2026-08-07, "i dont want them dismissed just by clicking on it and looking at the
  // project". Looking at something is not the same as dealing with it.
  return swipeRow(c, 'Dismiss', function () { dismissAlert(n) })
}

// Mark an alert seen. Nothing is deleted, so Undo is just flipping the flag back.
function dismissAlert(n) {
  var idx = (SNAP.notifications || []).findIndex(function (x) { return x.id === n.id })
  doWrite(setNotificationSeen(n.id, true), null, function () {
    if (idx >= 0) SNAP.notifications.splice(idx, 1)
    renderAlerts()
    updateCounts()
    toastUndo('Alert dismissed', 'Undo', function () {
      doWrite(setNotificationSeen(n.id, false), 'Alert restored', function () {
        // Back in its old position, so an undone dismissal leaves the list exactly as it was.
        SNAP.notifications.splice(idx >= 0 ? idx : 0, 0, n)
        renderAlerts()
        updateCounts()
      })
    })
  })
}

function renderAlerts() {
  var v = $('#view'); v.innerHTML = ''
  OPEN_SWIPE = null
  var ns = (SNAP.notifications || []).slice().sort(function (a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')) })
  var inq = el('<div></div>')
  v.appendChild(inq)
  if (!ns.length) v.appendChild(el('<div class="empty">No new alerts. You\'re all caught up.</div>'))
  else {
    v.appendChild(sectionLabel('New alerts · ' + ns.length))
    ns.forEach(function (n) { v.appendChild(alertCard(n)) })
    v.appendChild(el('<p class="empty" style="padding:14px 10px 0">Swipe an alert left to dismiss it. Opening one leaves it here.</p>'))
  }
  // The Mac bell's second list: website inquiries he has not cleared yet.
  loadInquiryReview().then(function (rows) {
    if (TAB !== 'alerts' || DETAIL_ID || !rows.length) return
    inq.appendChild(sectionLabel('Inquiries to review · ' + rows.length))
    rows.forEach(function (r) {
      var pr = r.projectId ? (SNAP.projects || []).find(function (p) { return p.id === r.projectId }) : null
      var card = el('<div class="card inq-row"><button class="inq-main"><div class="name" style="font-size:14.5px"></div><div class="meta"></div></button><button class="inq-x">Dismiss</button></div>')
      card.querySelector('.name').textContent = r.name || r.email || 'New inquiry'
      card.querySelector('.meta').textContent = [r.eventDate ? fmtDate(r.eventDate) : '', r.email && r.name ? r.email : '', pr ? '' : 'No project'].filter(Boolean).join('  ·  ')
      card.querySelector('.inq-main').addEventListener('click', function () { if (pr) { TAB = pageForBucket(pr.bucket); renderDetail(pr.id) } })
      card.querySelector('.inq-x').addEventListener('click', function () {
        doWrite(dismissInquiryReview(r.id), 'Dismissed', function () { card.remove(); if (!inq.querySelector('.inq-row')) inq.innerHTML = '' })
      })
      inq.appendChild(card)
    })
  }).catch(function () {})
}

function dueCount() {
  var t = todayStr()
  return (SNAP && SNAP.tasks ? SNAP.tasks : []).filter(function (x) { return !x.done && x.dueDate && x.dueDate <= t }).length
}
function setTabCount(id, n) {
  var e = $('#' + id); if (!e) return
  if (n > 0) { e.textContent = n > 99 ? '99+' : String(n); e.classList.remove('hidden') } else e.classList.add('hidden')
}
// THE THREE COUNTERS, defined once so they cannot drift or double-count (Michael, 2026-08-16):
//
//   Tasks badge  = tasks due today or overdue.
//   Alerts badge = everything else needing a look (the bell). Never tasks.
//   App icon     = the two added together.
//
// A due task used to be counted by BOTH badges, so one task read as two things to deal with. It
// belongs to Tasks alone now; loadNotifications drops task-due rows on the way in.
function updateCounts() {
  if (!SNAP) return
  var alerts = (SNAP.notifications || []).length
  var due = dueCount()
  setTabCount('nav-badge-alerts', alerts)
  setTabCount('nav-badge-tasks', due)
  // Plain counts on the history pages, so the drawer says how much is in each without opening it.
  ;['active', 'completed', 'archived', 'deleted'].forEach(function (b) {
    var elc = $('#nav-count-' + b)
    if (!elc) return
    var n = bucketCount(b)
    elc.textContent = n ? String(n) : ''
  })
  // Number on the home-screen app icon = alerts + tasks, i.e. exactly what the two badges show.
  try {
    if (navigator.setAppBadge) {
      var total = alerts + due
      if (total > 0) navigator.setAppBadge(total)
      else if (navigator.clearAppBadge) navigator.clearAppBadge()
    }
  } catch (e) { /* badge unsupported */ }
}

// ---- unread mail, on the drawer ----
//
// Deliberately NOT folded into the app-icon number. That number is defined as alerts + due tasks
// and nothing else (see updateCounts), and both of those are things only this CRM knows about.
// Unread mail already has a notification: the Mail app's own. What was missing was seeing it from
// inside the CRM, next to the client it belongs to, which is what the drawer badge is for.
//
// Five minutes, not the twenty-second data refresh: mail is not a CRM write, and polling Gmail
// every twenty seconds is how the desktop's inbox counter blew through its API quota on 2026-09-09.
var UNREAD_MAIL = 0
var UNREAD_BY_PROJECT = {} // projectId -> how many unread threads are from / to that client
// FIXED 2026-10-24 (Michael: the Home tile said 0 while its list, once it finally loaded, showed 3;
// and reopening the list sat on "Loading mail…"). Three causes, all fixed here:
//   1. The first count ran the moment the app opened, BEFORE the projects had loaded, so there were
//      no client addresses to search for, the answer was 0, and the next try was five minutes away.
//      Now nothing is counted until the projects are in, and the first count runs straight after.
//   2. The tile's count and the tile's list were two separate Gmail fetches. Now there is ONE: the
//      count fetch keeps the threads (UNREAD_THREADS), the list draws them instantly, and anything
//      older than 30 seconds is refreshed in the background while the old list stays on screen.
//   3. Nothing de-duplicated a fetch already in flight, and nothing gave up on a stalled one. Now a
//      second request joins the first, and a fetch that takes longer than 20 seconds reports an error
//      with a Retry instead of "Loading mail…" forever.
// Two minutes between counts (plus one whenever the app comes back to the foreground). Still far
// from the quota trouble the desktop's 20-second counter caused on 2026-09-09: three small queries.
var UNREAD_THREADS = null // the last unread list, or null before the first fetch
var UNREAD_AT = 0         // when it was fetched
var UNREAD_INFLIGHT = null
var MAIL_COUNT_MS = 2 * 60 * 1000
var mailCountTimer = null
function withTimeout(promise, ms, msg) {
  return new Promise(function (resolve, reject) {
    var t = setTimeout(function () { reject(new Error(msg || 'Email is taking too long. Try again.')) }, ms)
    promise.then(function (v) { clearTimeout(t); resolve(v) }, function (e) { clearTimeout(t); reject(e) })
  })
}
function refreshUnreadMail() {
  // The badge counts EXACTLY what the Inbox page shows: unread mail from someone on an active
  // project. It used to count the whole Gmail inbox, which read 201 and meant nothing, because 201
  // is mostly Bark and GigSalad notifications rather than anyone waiting on a reply.
  if (!SNAP) return Promise.resolve() // projects not loaded yet: a count now would be a false 0
  if (UNREAD_INFLIGHT) return UNREAD_INFLIGHT
  var queries = buildClientMailQueries('is:unread')
  if (!queries.length) {
    UNREAD_MAIL = 0; UNREAD_BY_PROJECT = {}; UNREAD_THREADS = []; UNREAD_AT = Date.now()
    setTabCount('nav-badge-inbox', 0)
    return Promise.resolve()
  }
  var before = UNREAD_MAIL
  UNREAD_INFLIGHT = withTimeout(gmailUnread(queries), 20000)
    .then(function (r) {
      var threads = (r.threads || []).filter(function (t) { return t.unread })
      UNREAD_THREADS = threads
      UNREAD_AT = Date.now()
      UNREAD_MAIL = threads.length
      setTabCount('nav-badge-inbox', UNREAD_MAIL)
      // The same fetch also answers "which clients are waiting on me", which is the version of this
      // question that is actually useful on the pipeline. Matching happens here, against contacts
      // the phone already holds, so it costs nothing extra.
      var ix = emailToProjectIndex()
      var by = {}
      threads.forEach(function (t) {
        var pid = ix[t.fromEmail] || (t.to || []).map(function (e) { return ix[e] }).filter(Boolean)[0] || ''
        if (pid) by[pid] = (by[pid] || 0) + 1
      })
      UNREAD_BY_PROJECT = by
      if (UNREAD_MAIL !== before) reloadWidgets()
      // Repaint only the list pages, and only when nothing is being typed into or edited: a
      // background repaint that throws away a half-written search box is worse than a stale mark.
      if (!DETAIL_ID && !isEditingActive() && !editorOpen() && (TAB === 'pipeline' || TAB === 'home')) render()
      else if (TAB === 'home' && !DETAIL_ID) paintMailTile()
    })
    .finally(function () { UNREAD_INFLIGHT = null })
  // A mail hiccup must never break the CRM: callers that care catch; the timer ignores it.
  UNREAD_INFLIGHT.catch(function () {})
  return UNREAD_INFLIGHT
}
// Just the tile's number, for when a full repaint would disturb an open sheet.
function paintMailTile() {
  var n = document.querySelector('.statcard.s-mail .n')
  if (n) n.textContent = String(UNREAD_MAIL)
}
function startMailCount() {
  if (mailCountTimer) return
  refreshUnreadMail() // a no-op until the projects are in; loadAndRender runs it again once they are
  mailCountTimer = setInterval(function () {
    if (!document.hidden) refreshUnreadMail()
  }, MAIL_COUNT_MS)
  // Back in the app after a while: the count is the first thing he looks at, so freshen it now.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && Date.now() - UNREAD_AT > 60000) refreshUnreadMail()
  })
}

// The header's date line and the page marker the stylesheet keys off (Home gets the damask ground,
// as on the Mac). Called by every full render and by the project view.
function setHeaderChrome(page) {
  document.body.dataset.page = page
  var d = $('#hdr-date')
  if (d) d.textContent = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
}

function render() {
  if (TAB !== 'show') flushShowEdit() // leaving a show mid-edit saves the edit
  noteLoc({ tab: TAB, detail: null, show: TAB === 'show' ? SHOW_ID : null })
  DETAIL_ID = null // a tab page is on screen now, so no project is
  if (TAB !== 'pipeline') removeFab() // the New-project button lives only on the pipeline page
  removeProjectTabs() // any full page render means we are no longer inside a project
  if (TAB === 'home') renderHome()
  else if (TAB === 'pipeline') renderPipeline()
  else if (TAB === 'completed') renderCompleted()
  else if (TAB === 'archived') renderArchived()
  else if (TAB === 'deleted') renderDeleted()
  else if (TAB === 'contacts') renderContacts()
  else if (TAB === 'tasks') renderTasks()
  else if (TAB === 'alerts') renderAlerts()
  else if (TAB === 'inbox') renderInbox()
  else if (TAB === 'proposals') renderProposals()
  else if (TAB === 'finance' || TAB === 'money') { TAB = 'finance'; renderFinance() }
  else if (TAB === 'calendar') renderCalendar()
  else if (TAB === 'stats') renderStats()
  else if (TAB === 'website') renderWebsite()
  else if (TAB === 'playbook') renderPlaybook()
  else if (TAB === 'files') renderFiles()
  else if (TAB === 'settings') renderSettings()
  else if (TAB === 'shows') renderShows()
  else if (TAB === 'show') renderShow()
  var title = $('#pagetitle'); if (title) title.textContent = TAB === 'home' ? greetingText() : TAB === 'show' ? ((showById(SHOW_ID) || {}).name || 'Show') : (PAGE_TITLES[TAB] || 'Bloom CRM')
  setHeaderChrome(TAB)
  updateCounts()
  updateDrawerActive()
}

// ================================ SHOWS ================================
//
// Set lists and packing lists. Michael, 2026-10-23: "a page to help me organize my packing list and my
// show structures." Shows (in the menu, under Library) lists his shows; tapping one opens it as its
// own page, the way a project opens from the pipeline, with two tabs along the bottom:
//
//   Set List      the running order, one block of text per trick, top to bottom. Read-only until
//                 Edit; in Edit he can drag to reorder, rename, delete and add. Done saves.
//   Packing List  the same kind of list, but every item has a checkbox he can tick WITHOUT editing,
//                 and in Edit he can also add a header (bold, no checkbox) or a blank line, to break
//                 it into groups. "Uncheck all" clears every box at once.
//
// His instructions on the look: no arrows, no flow-chart spacing, just a vertical list.
//
// ⚠️ The Mac has the same page (src/components/ShowsPage.tsx), on the same `shows` rows, so a box
// ticked here is ticked there. Keep the two in step.
var SHOWS = null          // the loaded list, or null before the first load
var SHOW_ID = null        // the open show (TAB 'show')
var SHOW_TAB = 'set'      // 'set' | 'pack'
var SHOW_EDIT = false     // true while the open tab is in Edit
var SHOW_DRAFT = null     // the list being edited, a copy, saved on Done
var SHOW_PACK_SEQ = 0     // only the newest checkmark save may write its server copy back

function showById(id) { return (SHOWS || []).find(function (s) { return s.id === id }) || null }
function replaceShow(s) {
  if (!SHOWS) SHOWS = []
  var i = SHOWS.findIndex(function (x) { return x.id === s.id })
  if (i >= 0) SHOWS[i] = s; else SHOWS.push(s)
}
function showsLoad(after) {
  loadShows().then(function (rows) { SHOWS = rows; if (after) after() }).catch(function (e) {
    if (SHOWS == null) SHOWS = []
    toast(e.message || 'Could not load shows', 'err')
    if (after) after()
  })
}
function newShowItemId() {
  try { return crypto.randomUUID() } catch (e) { return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) }
}

// ---- the list of shows ----
function renderShows() {
  var v = $('#view'); v.innerHTML = ''
  var head = el('<div class="tabhead"><span></span><button class="addbtn"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>New show</button></div>')
  head.querySelector('.addbtn').addEventListener('click', openNewShow)
  v.appendChild(head)
  var list = el('<div></div>')
  v.appendChild(list)
  function draw() {
    if (TAB !== 'shows') return
    list.innerHTML = ''
    if (SHOWS == null) { list.appendChild(el('<div class="empty">Loading shows…</div>')); return }
    if (!SHOWS.length) {
      list.appendChild(el('<div class="empty" style="padding:40px 16px">No shows yet. Tap New show to add the first one. Each show gets a set list and a packing list.</div>'))
      return
    }
    SHOWS.forEach(function (s) {
      var items = s.packingList.filter(function (x) { return x.type === 'item' })
      var packed = items.filter(function (x) { return x.done }).length
      var c = el('<div class="card show-card"><button class="show-open"><div class="name"></div><div class="meta"></div></button><button class="show-dup" aria-label="Duplicate"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/></svg>Duplicate</button></div>')
      c.querySelector('.name').textContent = s.name
      c.querySelector('.meta').textContent = s.setList.length + ' in the set list  ·  ' + (items.length ? packed + ' of ' + items.length + ' packed' : 'nothing to pack yet')
      c.querySelector('.show-open').addEventListener('click', function () { openShow(s.id) })
      // Duplicate (2026-10-23): an exact copy named "Copy of <name>", added at the end of the list,
      // which is where it stays after a reload (shows are listed oldest first).
      var dup = c.querySelector('.show-dup')
      dup.addEventListener('click', function () {
        dup.disabled = true
        doWrite(duplicateShow(s.id), 'Copied', function (copy) { replaceShow(copy); draw() })
          .catch(function () { dup.disabled = false })
      })
      list.appendChild(c)
    })
  }
  draw()
  // Always re-read in the background, so a show added on the Mac appears without a manual refresh.
  showsLoad(draw)
}
function openNewShow() {
  var sh = makeSheet('New show')
  var inp = el('<input class="search" placeholder="Name the show">')
  sh.body.appendChild(inp)
  var bar = el('<div class="addrow" style="margin-top:12px"><button class="btn-ghost">Cancel</button><button class="btn-gold">Add show</button></div>')
  bar.children[0].addEventListener('click', sh.close)
  var go = function () {
    var n = inp.value.trim()
    if (!n) { inp.focus(); return }
    doWrite(createShow(n), 'Show added', function (s) { replaceShow(s); sh.close(); openShow(s.id) })
  }
  bar.children[1].addEventListener('click', go)
  inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') go() })
  sh.body.appendChild(bar)
  setTimeout(function () { inp.focus() }, 60)
}
function openShow(id) {
  SHOW_ID = id; SHOW_TAB = 'set'; SHOW_EDIT = false; SHOW_DRAFT = null
  TAB = 'show'
  render()
  window.scrollTo(0, 0)
}

// Leaving a show (or its tab) mid-edit SAVES the edit rather than throwing it away. Done is still the
// normal way out; this is the safety net for tapping the menu instead.
function flushShowEdit() {
  if (!SHOW_EDIT || !SHOW_ID || !SHOW_DRAFT) { SHOW_EDIT = false; SHOW_DRAFT = null; return }
  var id = SHOW_ID, patch = SHOW_TAB === 'set' ? { setList: SHOW_DRAFT } : { packingList: SHOW_DRAFT }
  SHOW_EDIT = false; SHOW_DRAFT = null
  updateShow(id, patch).then(replaceShow).catch(function (e) { toast(e.message || 'Could not save the show', 'err') })
}

// ---- one show ----
function renderShow() {
  var v = $('#view'); v.innerHTML = ''
  var s = showById(SHOW_ID)
  if (!s) {
    if (SHOWS == null) { v.appendChild(el('<div class="empty">Loading…</div>')); showsLoad(function () { if (TAB === 'show') render() }); return }
    TAB = 'shows'; SHOW_ID = null; render(); return
  }
  var title = $('#pagetitle'); if (title) title.textContent = s.name
  ensureShowTabs()

  var top = el('<div class="show-top"><div class="show-acts"></div><button class="show-more" aria-label="Show options"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg></button></div>')
  top.querySelector('.show-more').addEventListener('click', function () { openShowOptions(s) })
  var acts = top.querySelector('.show-acts')
  var items = s.packingList.filter(function (x) { return x.type === 'item' })
  var packed = items.filter(function (x) { return x.done }).length
  if (SHOW_EDIT) {
    var done = el('<button class="btn-gold show-btn">Done</button>')
    done.addEventListener('click', function () {
      var patch = SHOW_TAB === 'set' ? { setList: SHOW_DRAFT } : { packingList: SHOW_DRAFT }
      done.disabled = true; done.textContent = 'Saving…'
      doWrite(updateShow(s.id, patch), 'Saved', function (saved) {
        replaceShow(saved); SHOW_EDIT = false; SHOW_DRAFT = null; render()
      }).catch(function () { done.disabled = false; done.textContent = 'Done' })
    })
    acts.appendChild(done)
  } else {
    var edit = el('<button class="btn-ghost show-btn">Edit</button>')
    edit.addEventListener('click', function () {
      SHOW_DRAFT = (SHOW_TAB === 'set' ? s.setList : s.packingList).map(function (x) { return Object.assign({}, x) })
      SHOW_EDIT = true
      render()
    })
    acts.appendChild(edit)
    if (SHOW_TAB === 'pack' && items.length) {
      var un = el('<button class="btn-ghost show-btn">Uncheck all</button>')
      un.disabled = !packed
      un.addEventListener('click', function () {
        if (!confirm('Uncheck all ' + packed + ' packed item' + (packed === 1 ? '' : 's') + '?')) return
        doWrite(uncheckAllPacked(s.id), 'All unchecked', function (saved) { replaceShow(saved); render() })
      })
      acts.appendChild(un)
      acts.appendChild(el('<span class="show-count">' + packed + ' of ' + items.length + ' packed</span>'))
    }
  }
  v.appendChild(top)

  if (SHOW_TAB === 'set') {
    if (SHOW_EDIT) v.appendChild(showEditor('set'))
    else if (!s.setList.length) v.appendChild(el('<div class="empty" style="padding:36px 16px">The set list is empty. Tap Edit to add the first item.</div>'))
    else {
      var sl = el('<div class="show-list"></div>')
      s.setList.forEach(function (it) {
        var r = el('<div class="card show-line"></div>'); r.textContent = it.text
        sl.appendChild(r)
      })
      v.appendChild(sl)
    }
    return
  }

  if (SHOW_EDIT) { v.appendChild(showEditor('pack')); return }
  if (!s.packingList.length) { v.appendChild(el('<div class="empty" style="padding:36px 16px">The packing list is empty. Tap Edit to add items, headers and blank lines.</div>')); return }
  var pl = el('<div class="show-list"></div>')
  s.packingList.forEach(function (it) {
    if (it.type === 'blank') { pl.appendChild(el('<div class="pack-blank" aria-hidden="true"></div>')); return }
    if (it.type === 'header') { var hd = el('<div class="pack-head"></div>'); hd.textContent = it.text; pl.appendChild(hd); return }
    var row = el('<button class="card pack-item' + (it.done ? ' done' : '') + '"><span class="pack-box"></span><span class="pack-t"></span></button>')
    row.querySelector('.pack-t').textContent = it.text
    row.setAttribute('aria-pressed', it.done ? 'true' : 'false')
    row.addEventListener('click', function () { togglePacked(s, it) })
    pl.appendChild(row)
  })
  v.appendChild(pl)
}
function togglePacked(s, it) {
  // Optimistic: the box flips now, the server copy follows.
  var next = !it.done
  replaceShow(Object.assign({}, s, { packingList: s.packingList.map(function (x) { return x.id === it.id ? Object.assign({}, x, { done: next }) : x }) }))
  if (TAB === 'show') render()
  var seq = ++SHOW_PACK_SEQ
  setPacked(s.id, it.id, next).then(function (saved) {
    if (seq !== SHOW_PACK_SEQ) return
    replaceShow(saved)
    if (TAB === 'show' && SHOW_ID === s.id && !SHOW_EDIT) render()
  }).catch(function (e) {
    toast(e.message || 'Could not save that checkmark', 'err')
    if (seq === SHOW_PACK_SEQ) { replaceShow(s); if (TAB === 'show' && SHOW_ID === s.id && !SHOW_EDIT) render() }
  })
}

// The editor for whichever tab is open. Rows carry a drag handle, the text box (or a "Blank line"
// placeholder) and a delete ×. New rows go at the bottom; drag them into place.
function showEditor(kind) {
  var wrap = el('<div class="show-edit editing"></div>')
  var list = el('<div class="show-list"></div>')
  wrap.appendChild(list)
  function rowFor(it) {
    var r = el('<div class="card ed-row"><span class="drag-h" aria-label="Drag to move"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg></span><div class="ed-body"></div><button class="ed-x" aria-label="Delete">&times;</button></div>')
    r.dataset.id = it.id
    var body = r.querySelector('.ed-body')
    if (it.type === 'blank') {
      body.appendChild(el('<span class="ed-blank">Blank line</span>'))
    } else {
      if (kind === 'pack' && it.type === 'item') body.appendChild(el('<span class="pack-box"></span>'))
      var ta = document.createElement('textarea')
      ta.rows = 1
      ta.className = 'ed-text' + (it.type === 'header' ? ' ed-header' : '')
      ta.placeholder = kind === 'set' ? 'Trick or title' : it.type === 'header' ? 'Header' : 'Something to pack'
      ta.value = it.text || ''
      var grow = function () { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px' }
      ta.addEventListener('input', function () { it.text = ta.value; grow() })
      // A packing line is one line: Enter adds the next item of the same kind instead of a newline.
      ta.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && kind === 'pack') { e.preventDefault(); addRow(it.type === 'header' ? 'item' : it.type) }
      })
      body.appendChild(ta)
      setTimeout(grow, 0)
    }
    r.querySelector('.ed-x').addEventListener('click', function () {
      SHOW_DRAFT = SHOW_DRAFT.filter(function (x) { return x.id !== it.id })
      r.remove()
    })
    return r
  }
  function addRow(type) {
    var it = kind === 'set' ? { id: newShowItemId(), text: '' } : { id: newShowItemId(), type: type, text: '', done: false }
    SHOW_DRAFT.push(it)
    var r = rowFor(it)
    list.appendChild(r)
    var ta = r.querySelector('textarea')
    var reveal = function () { if (r.scrollIntoView) r.scrollIntoView({ block: 'center', behavior: 'smooth' }) }
    if (ta) setTimeout(function () { ta.focus(); reveal() }, 30)
    else reveal()
  }
  SHOW_DRAFT.forEach(function (it) { list.appendChild(rowFor(it)) })
  makeSortable(list, function (ids) {
    var byId = {}; SHOW_DRAFT.forEach(function (x) { byId[x.id] = x })
    SHOW_DRAFT = ids.map(function (id) { return byId[id] }).filter(Boolean)
  })
  var adds = el('<div class="show-adds"></div>')
  var kinds = kind === 'set' ? [['item', '+ Add item']] : [['item', '+ Item'], ['header', '+ Header'], ['blank', '+ Blank line']]
  kinds.forEach(function (k) {
    var b = el('<button class="btn-ghost"></button>'); b.textContent = k[1]
    b.addEventListener('click', function () { addRow(k[0]) })
    adds.appendChild(b)
  })
  wrap.appendChild(adds)
  wrap.appendChild(el('<p class="hint" style="margin:10px 2px 0">Drag the handle to move a line. Done saves.</p>'))
  return wrap
}

// Drag to reorder, by the handle, with a finger or a mouse. The row follows the pointer and swaps
// places with a neighbour once it passes that neighbour's middle; the page scrolls when the row is
// held near the top or bottom edge, so a long list can be reordered end to end. Letting go snaps the
// row into its slot. `onDone` gets the new order of data-id values.
//
// FIXED 2026-10-23 after Michael found rows freezing half way between two others on his iPhone,
// mostly when dragging UP. Two causes, both fixed here:
//   1. Moving up used to move the DRAGGED ROW itself in the page. On iOS that drops the pointer
//      capture on the handle, so the "finger lifted" event went somewhere else and the drag never
//      ended: the row stayed lifted and offset. Now only the NEIGHBOURS are ever moved, and the
//      move/lift events are heard on the whole document, so the end of a drag cannot be missed.
//   2. One swap per finger movement meant a quick drag could end a slot or two short of where the
//      row was showing. Now every swap the position calls for happens at once.
function makeSortable(list, onDone) {
  var drag = null
  function place() {
    if (!drag) return
    var row = drag.row
    for (var guard = 0; guard < 500; guard++) {
      row.style.transform = 'translateY(' + ((drag.y + window.scrollY) - drag.anchor) + 'px)'
      var r = row.getBoundingClientRect(), mid = r.top + r.height / 2
      var next = row.nextElementSibling, prev = row.previousElementSibling
      var before = row.offsetTop
      if (next && mid >= next.getBoundingClientRect().top + next.offsetHeight / 2) list.insertBefore(next, row)
      else if (prev && mid <= prev.getBoundingClientRect().top + prev.offsetHeight / 2) list.insertBefore(prev, row.nextElementSibling)
      else return
      // The row's slot moved; shift the anchor by the same amount so it stays under the finger.
      drag.anchor += row.offsetTop - before
    }
  }
  function onMove(ev) {
    if (!drag || ev.pointerId !== drag.pid) return
    if (ev.cancelable) ev.preventDefault()
    drag.y = ev.clientY
    place()
  }
  function onUp(ev) {
    if (!drag || ev.pointerId !== drag.pid) return
    // The lift position counts: the last movement can arrive WITH the lift rather than before it.
    if (ev.type === 'pointerup' && typeof ev.clientY === 'number') { drag.y = ev.clientY; place() }
    finish()
  }
  function finish() {
    if (!drag) return
    var d = drag; drag = null
    clearInterval(d.timer)
    document.removeEventListener('pointermove', onMove, true)
    document.removeEventListener('pointerup', onUp, true)
    document.removeEventListener('pointercancel', onUp, true)
    window.removeEventListener('blur', finish)
    document.removeEventListener('visibilitychange', finish)
    list.classList.remove('sorting')
    // Snap: glide from where the finger left it into its slot.
    var row = d.row
    row.style.transition = 'transform 140ms ease-out'
    row.style.transform = ''
    setTimeout(function () { row.style.transition = ''; row.classList.remove('dragging') }, 160)
    onDone(Array.prototype.map.call(list.children, function (c) { return c.dataset.id }))
  }
  list.addEventListener('pointerdown', function (e) {
    var h = e.target.closest && e.target.closest('.drag-h')
    if (!h || !list.contains(h)) return
    var row = h.closest('.ed-row'); if (!row) return
    e.preventDefault()
    finish() // a drag that somehow never ended is closed before a new one starts
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur()
    row.style.transition = ''
    drag = { row: row, pid: e.pointerId, y: e.clientY, anchor: e.clientY + window.scrollY, timer: 0 }
    row.classList.add('dragging')
    list.classList.add('sorting')
    try { h.setPointerCapture(e.pointerId) } catch (err) { /* not needed: the document listens */ }
    document.addEventListener('pointermove', onMove, true)
    document.addEventListener('pointerup', onUp, true)
    document.addEventListener('pointercancel', onUp, true)
    window.addEventListener('blur', finish)
    document.addEventListener('visibilitychange', finish)
    drag.timer = setInterval(function () {
      if (!drag) return
      var edge = 90
      if (drag.y < edge) { window.scrollBy(0, -10); place() }
      else if (drag.y > window.innerHeight - edge - 70) { window.scrollBy(0, 10); place() }
    }, 16)
  })
}

// The two tabs along the bottom, in the same bar a project uses.
var SHOW_TABS = [
  ['set', 'Set List', '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>'],
  ['pack', 'Packing List', '<rect x="4" y="7" width="16" height="13" rx="2"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M8.5 13.5l2 2 4-4"/>'],
]
function ensureShowTabs() {
  removeProjectTabs()
  var bar = el('<nav id="ptabs"></nav>')
  SHOW_TABS.forEach(function (t) {
    var b = el('<button class="ptab' + (SHOW_TAB === t[0] ? ' on' : '') + '"><span class="ptab-i"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + t[2] + '</svg></span><span class="ptab-l">' + esc(t[1]) + '</span></button>')
    b.addEventListener('click', function () {
      if (SHOW_TAB === t[0]) return
      flushShowEdit() // switching tabs mid-edit keeps the edit
      SHOW_TAB = t[0]
      render()
      window.scrollTo(0, 0)
    })
    bar.appendChild(b)
  })
  document.body.appendChild(bar)
  document.body.classList.add('has-ptabs')
}

function openShowOptions(s) {
  var sh = makeSheet(s.name)
  var ren = el('<button class="actrow"><span class="ar-l">Rename</span></button>')
  ren.addEventListener('click', function () {
    sh.body.innerHTML = ''
    var inp = el('<input class="search">'); inp.value = s.name
    sh.body.appendChild(inp)
    var bar = el('<div class="addrow" style="margin-top:12px"><button class="btn-ghost">Cancel</button><button class="btn-gold">Save</button></div>')
    bar.children[0].addEventListener('click', sh.close)
    var go = function () {
      var n = inp.value.trim()
      if (!n) { inp.focus(); return }
      doWrite(updateShow(s.id, { name: n }), 'Renamed', function (saved) { replaceShow(saved); sh.close(); render() })
    }
    bar.children[1].addEventListener('click', go)
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') go() })
    sh.body.appendChild(bar)
    setTimeout(function () { inp.focus(); inp.select() }, 40)
  })
  var del = el('<button class="actrow"><span class="ar-l" style="color:var(--red)">Delete show</span></button>')
  del.addEventListener('click', function () {
    if (!confirm('Delete "' + s.name + '"?\n\nIts set list and packing list go with it. This cannot be undone.')) return
    doWrite(deleteShow(s.id), 'Show deleted', function () {
      SHOWS = (SHOWS || []).filter(function (x) { return x.id !== s.id })
      SHOW_ID = null; SHOW_EDIT = false; SHOW_DRAFT = null
      sh.close()
      TAB = 'shows'; render()
    })
  })
  sh.body.appendChild(ren); sh.body.appendChild(del)
}

// ---------- drawer navigation ----------
// ---- global search (the Mac's SearchPalette) ----
// Every project in every bucket, then contacts, matched across the same fields the Mac searches:
// names, contact details, venue, type, date, performance, VIPs, source, description and notes, plus
// any run of 3+ digits against phone numbers however they are formatted.
function openSearch() {
  var sh = makeSheet('Search', true)
  var inp = el('<input class="search" placeholder="Projects and contacts…" autocapitalize="off" autocorrect="off">')
  var out = el('<div class="srch-out"></div>')
  sh.body.appendChild(inp); sh.body.appendChild(out)
  var digits = function (x) { return String(x || '').replace(/\D/g, '') }
  var hay = function (p) {
    return [p.client, p.contactNames, p.contactEmails, p.contactPhones, p.eventLocation, p.venueType, p.eventType, p.eventDate,
      p.performanceStyle, p.vips, p.bookingSource, p.eventDescription, p.projectNotes].join(' ').toLowerCase()
  }
  var bucketLabel = { active: '', completed: 'Completed', archived: 'Archived', deleted: 'Deleted' }
  function draw() {
    var q = inp.value.trim().toLowerCase(), qd = digits(q)
    out.innerHTML = ''
    var projects = (SNAP.projects || []).slice()
    var contacts = []
    if (!q) {
      projects = projects.filter(function (p) { return p.bucket === 'active' }).sort(function (a, b) { return a.client.localeCompare(b.client) }).slice(0, 8)
    } else {
      projects = projects.filter(function (p) { return hay(p).indexOf(q) >= 0 || (qd.length >= 3 && digits(p.contactPhones).indexOf(qd) >= 0) })
        .sort(function (a, b) {
          var an = a.client.toLowerCase().indexOf(q) >= 0 ? 0 : 1, bn = b.client.toLowerCase().indexOf(q) >= 0 ? 0 : 1
          return an !== bn ? an - bn : a.client.localeCompare(b.client)
        }).slice(0, 30)
      contacts = (SNAP.contacts || []).filter(function (c) {
        var h = [c.name, (c.emails || []).join(' '), c.notes, (c.tags || []).join(' ')].join(' ').toLowerCase()
        return h.indexOf(q) >= 0 || (qd.length >= 3 && digits((c.phones || []).join(' ')).indexOf(qd) >= 0)
      }).sort(function (a, b) { return (a.name || '').localeCompare(b.name || '') }).slice(0, 20)
    }
    if (!projects.length && !contacts.length) { out.appendChild(el('<div class="empty">Nothing matches.</div>')); return }
    if (projects.length) out.appendChild(sectionLabel(q ? 'Projects  ·  ' + projects.length : 'Active projects'))
    projects.forEach(function (p) {
      var where = p.bucket === 'active' ? stageName(p.stageId) : bucketLabel[p.bucket] || p.bucket
      var r = el('<button class="srch-row"><span class="srch-n"></span><span class="srch-m"></span></button>')
      r.querySelector('.srch-n').textContent = p.client
      r.querySelector('.srch-m').textContent = [where, p.eventDate ? fmtDate(p.eventDate) : ''].filter(Boolean).join('  ·  ')
      r.addEventListener('click', function () { sh.close(); TAB = pageForBucket(p.bucket); renderDetail(p.id) })
      out.appendChild(r)
    })
    if (contacts.length) out.appendChild(sectionLabel('Contacts  ·  ' + contacts.length))
    contacts.forEach(function (c) {
      var r = el('<button class="srch-row"><span class="srch-n"></span><span class="srch-m"></span></button>')
      r.querySelector('.srch-n').textContent = c.name || '(no name)'
      r.querySelector('.srch-m').textContent = [(c.emails || [])[0], (c.phones || [])[0]].filter(Boolean).join('  ·  ')
      r.addEventListener('click', function () { sh.close(); openContactSheet(c) })
      out.appendChild(r)
    })
  }
  inp.addEventListener('input', draw)
  draw()
  setTimeout(function () { inp.focus() }, 60)
}

function openDrawer() { var d = $('#drawer'); if (d) { d.classList.remove('hidden'); updateDrawerActive() } }
function closeDrawer() { var d = $('#drawer'); if (d) d.classList.add('hidden') }
function updateDrawerActive() {
  var here = TAB === 'show' ? 'shows' : TAB
  document.querySelectorAll('#drawer-nav button').forEach(function (b) { b.classList.toggle('on', b.dataset.page === here) })
}
function navigate(page) {
  DETAIL_ID = null
  TAB = page
  closeDrawer()
  render()
  window.scrollTo(0, 0)
}

// ---------- the back button ----------
//
// Michael, 2026-10-23: one back button, in the same place at the top of every view, that returns to
// whatever was on screen before. It used to exist only inside a project, and there it went to the
// page the project lives on rather than the page he came from.
//
// A "location" is the tab plus the open project (if any). Every render notes where it is; when that
// differs from the last place rendered, the last place goes on the stack. Re-rendering the same
// place (a write, a background refresh, switching tabs inside a project) is not a move and pushes
// nothing. Each entry also keeps the scroll position and, on Home, which of the four lists was open,
// so going back lands exactly where he left.
var NAV_STACK = []
var LAST_LOC = null
var NAV_RESTORING = false
var NAV_MAX = 50
function sameLoc(a, b) {
  if (!a || !b) return false
  if (a.detail || b.detail) return a.detail === b.detail
  if (a.tab === 'show' && b.tab === 'show') return a.show === b.show
  return a.tab === b.tab
}
function noteLoc(loc) {
  if (LAST_LOC && !sameLoc(LAST_LOC, loc)) {
    if (!NAV_RESTORING) {
      var prev = { tab: LAST_LOC.tab, detail: LAST_LOC.detail, ptab: LAST_LOC.ptab, show: LAST_LOC.show || null, y: window.scrollY || 0, sheet: HOME_SHEET }
      NAV_STACK.push(prev)
      if (NAV_STACK.length > NAV_MAX) NAV_STACK.shift()
    }
    closeHomeSheet() // moving anywhere takes a Home list with it
  }
  LAST_LOC = loc
  updateBackBtn()
  // Remembered so a relaunch opens where he left off, like the Mac does.
  try { localStorage.setItem('crm-last-loc', JSON.stringify({ tab: loc.tab, detail: loc.detail || null, ptab: loc.ptab || '', show: loc.show || null, at: Date.now() })) } catch (e) { /* private mode */ }
}
// Where Back would go right now, without going there: the newest entry that is not where he already
// is and is not a project that has since disappeared. With nothing usable left, Home is the floor.
function backTarget() {
  for (var i = NAV_STACK.length - 1; i >= 0; i--) {
    var e = NAV_STACK[i]
    if (e.detail && !(SNAP && SNAP.projects.some(function (x) { return x.id === e.detail }))) continue
    if (e.tab === 'show' && !showById(e.show)) continue // a show deleted since
    if (sameLoc(e, LAST_LOC)) continue
    return { e: e, i: i }
  }
  var here = LAST_LOC || { tab: TAB, detail: DETAIL_ID }
  if (here.tab === 'home' && !here.detail) return null
  return { e: { tab: 'home', detail: null, y: 0 }, i: 0 }
}
// The label is the destination, the way iOS does it, so he knows where he is going before he taps.
function backLabel(e) {
  if (e.tab === 'show') return (showById(e.show) || {}).name || 'Show'
  if (e.detail) {
    var p = SNAP && SNAP.projects.find(function (x) { return x.id === e.detail })
    return (p && p.client) || 'Project'
  }
  return PAGE_TITLES[e.tab] || 'Back'
}
function updateBackBtn() {
  var b = $('#back-btn'); if (!b) return
  var t = backTarget()
  b.classList.toggle('hidden', !t)
  if (!t) return
  var label = backLabel(t.e)
  b.querySelector('#back-label').textContent = label
  b.setAttribute('aria-label', 'Back to ' + label)
}
function goBack() {
  closeDrawer()
  var t = backTarget()
  if (!t) { updateBackBtn(); return }
  var e = t.e
  NAV_STACK.length = t.i // drop the destination and anything skipped above it
  NAV_RESTORING = true
  try {
    TAB = e.tab
    if (e.tab === 'show') { SHOW_ID = e.show; SHOW_EDIT = false; SHOW_DRAFT = null }
    if (e.detail) { if (e.ptab) PTAB = e.ptab; renderDetail(e.detail) }
    else render()
  } finally { NAV_RESTORING = false }
  window.scrollTo(0, e.y || 0)
  if (e.sheet && TAB === 'home' && !DETAIL_ID) openHomeSheet(e.sheet)
  updateBackBtn()
}

// ---------- Home dashboard ----------
function greetingText() {
  var h = new Date().getHours()
  var g = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
  return g + ', Michael'
}
// Shift a YYYY-MM-DD string by n days (local).
function addDays(dateStr, n) {
  var d = parseDate(dateStr); if (!d) return dateStr
  d.setDate(d.getDate() + n)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}
// The four numbers Home is built around, computed once so a tile and the list it opens can never
// disagree about what they are counting.
function homeData() {
  var today = todayStr()
  var open = (SNAP.tasks || []).filter(function (t) { return !t.done })
  var byDue = function (a, b) { return ((a.dueDate || '') + ' ' + (a.dueTime || '')).localeCompare((b.dueDate || '') + ' ' + (b.dueTime || '')) }
  var end7 = addDays(today, 7)
  return {
    overdue: open.filter(function (t) { return dueState(t.dueDate, t.dueTime) === 'overdue' }).sort(byDue),
    dueToday: open.filter(function (t) { return dueState(t.dueDate, t.dueTime) === 'due' }).sort(byDue),
    gigs: (SNAP.projects || []).filter(function (p) {
      return p.bucket === 'active' && p.eventDate && p.eventDate >= today && p.eventDate <= end7
    }).sort(function (a, b) { return a.eventDate < b.eventDate ? -1 : 1 }),
  }
}
function statCard(n, label, kind, cls) {
  var c = el('<button class="statcard ' + (cls || '') + '"><div class="n">' + esc(n) + '</div><div class="l">' + esc(label) + '</div></button>')
  c.addEventListener('click', function () { openHomeSheet(kind) })
  return c
}
// Home is the greeting and the tiles, nothing under them (Michael, 2026-10-23). Each tile opens
// its own list in place instead of jumping to another page; the list has a button through to the
// full page for when he wants more than the answer to the tile's question.
function renderHome() {
  var v = $('#view'); v.innerHTML = ''
  var d = homeData()

  // The greeting is the page title now, in the header, the way the Mac's Home does it.

  var grid = el('<div class="statgrid"></div>')
  // Unread mail took the money tile, 2026-09-21. Michael: "I don't expect to use the finance page
  // on my phone", and in the same breath, "I want to be able to see notifications when I have
  // unread emails." Money is still a tap away in the drawer; this tile now answers a question he
  // asked for. It reads 0 until the five-minute poll has run once, which is honest: it is a count
  // of what the app has actually seen.
  grid.appendChild(statCard(String(UNREAD_MAIL), 'Unread email', 'mail', 's-mail'))
  grid.appendChild(statCard(String(d.overdue.length), 'Overdue tasks', 'overdue', 's-over'))
  grid.appendChild(statCard(String(d.dueToday.length), 'Due today', 'today', 's-due'))
  grid.appendChild(statCard(String(d.gigs.length), 'Gigs next 7 days', 'gigs', 's-gigs'))
  // The Mac's other two Home pieces, as tiles in the same grid rather than lists under it: money in
  // this month (through to Finance), and the daily duties checklist.
  var money = el('<button class="statcard s-money"><div class="n"></div><div class="l">Money in this month</div></button>')
  money.querySelector('.n').textContent = SNAP.finance && SNAP.finance.thisMonth ? money0(SNAP.finance.thisMonth.received) : '--'
  money.addEventListener('click', function () { navigate('finance') })
  grid.appendChild(money)
  var duties = loadDuties(), checks = loadDutyChecks()
  var doneN = duties.filter(function (x) { return checks[x.id] }).length
  var dt = el('<button class="statcard s-duty"><div class="n">' + doneN + '/' + duties.length + '</div><div class="l">Daily duties</div></button>')
  dt.addEventListener('click', openDutiesSheet)
  grid.appendChild(dt)
  v.appendChild(grid)
}
function money0(n) { return '$' + Math.round(Number(n) || 0).toLocaleString('en-US') }

// ---- daily duties (the Mac's DailyDuties) ----
// Things he does every day. The list persists; the ticks reset every morning. Kept on the device,
// exactly as the Mac keeps its own, under the same storage keys.
var DUTIES_KEY = 'crm-daily-duties', DUTY_CHECKS_KEY = 'crm-daily-duty-checks'
var DEFAULT_DUTIES = [{ id: 'mail', label: 'Go through my mail' }, { id: 'emails', label: 'Clean up emails' }, { id: 'expenses', label: 'Document expenses' }]
function loadDuties() {
  try {
    var r = JSON.parse(localStorage.getItem(DUTIES_KEY) || '')
    if (Array.isArray(r) && r.every(function (x) { return x && typeof x.id === 'string' })) return r
  } catch (e) { /* defaults */ }
  return DEFAULT_DUTIES.slice()
}
function loadDutyChecks() {
  try {
    var r = JSON.parse(localStorage.getItem(DUTY_CHECKS_KEY) || '')
    if (r && r.date === todayStr() && r.checked) return r.checked
  } catch (e) { /* a new day */ }
  return {}
}
function saveDuties(list) { try { localStorage.setItem(DUTIES_KEY, JSON.stringify(list)) } catch (e) { /* private mode */ } }
function saveDutyChecks(c) { try { localStorage.setItem(DUTY_CHECKS_KEY, JSON.stringify({ date: todayStr(), checked: c })) } catch (e) { /* private mode */ } }
function openDutiesSheet() {
  var sh = makeSheet('Daily duties')
  var editing = false
  sh.sheet.addEventListener('click', function (e) { if (e.target === sh.sheet && TAB === 'home' && !DETAIL_ID) render() })
  sh.sheet.querySelector('.sheet-x').addEventListener('click', function () { if (TAB === 'home' && !DETAIL_ID) render() })
  function draw() {
    var duties = loadDuties(), checks = loadDutyChecks()
    sh.body.innerHTML = ''
    var top = el('<div class="duty-top"><span class="hint" style="margin:0"></span><button class="btn-ghost duty-edit"></button></div>')
    top.querySelector('.hint').textContent = duties.filter(function (x) { return checks[x.id] }).length + ' of ' + duties.length + ' done today'
    top.querySelector('.duty-edit').textContent = editing ? 'Done' : 'Edit'
    top.querySelector('.duty-edit').addEventListener('click', function () { editing = !editing; draw() })
    sh.body.appendChild(top)
    duties.forEach(function (x) {
      var on = !!checks[x.id]
      var row = el('<div class="duty' + (on ? ' on' : '') + '"><button class="duty-main"><span class="duty-box">' + (on ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>' : '') + '</span><span class="duty-l"></span></button></div>')
      row.querySelector('.duty-l').textContent = x.label
      row.querySelector('.duty-main').addEventListener('click', function () { var c = loadDutyChecks(); c[x.id] = !c[x.id]; saveDutyChecks(c); draw() })
      if (editing) {
        var rm = el('<button class="duty-rm" aria-label="Remove">&times;</button>')
        rm.addEventListener('click', function () { saveDuties(loadDuties().filter(function (y) { return y.id !== x.id })); draw() })
        row.appendChild(rm)
      }
      sh.body.appendChild(row)
    })
    if (editing) {
      var add = el('<div class="addrow" style="margin-top:10px"><input class="search" placeholder="Add a daily duty…" style="margin:0"><button class="btn-gold" style="flex:none">Add</button></div>')
      var inp = add.querySelector('input')
      var go = function () {
        var l = inp.value.trim(); if (!l) return
        saveDuties(loadDuties().concat([{ id: 'duty-' + Date.now().toString(36), label: l }])); draw()
      }
      add.querySelector('button').addEventListener('click', go)
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') go() })
      sh.body.appendChild(add)
    }
  }
  draw()
}

// ---- the four Home lists ----
//
// A full-height sheet per tile, with the way through to the full page at the top AND the bottom, so
// it is in reach whether he has just opened the list or just reached the end of it.
var HOME_SHEET = null // which list is open, so Back can reopen it after he leaves Home from inside one
var HOME_SHEETS = {
  mail: { title: 'Unread email', go: 'inbox', goLabel: 'Open Inbox' },
  overdue: { title: 'Overdue tasks', go: 'tasks', goLabel: 'Go to Tasks' },
  today: { title: 'Due today', go: 'tasks', goLabel: 'Go to Tasks' },
  gigs: { title: 'Gigs next 7 days', go: 'pipeline', goLabel: 'View all gigs' },
}
function closeHomeSheet() {
  document.querySelectorAll('.home-sheet').forEach(function (x) { x.remove() })
  HOME_SHEET = null
}
function openHomeSheet(kind) {
  var cfg = HOME_SHEETS[kind]; if (!cfg) return
  closeHomeSheet()
  HOME_SHEET = kind
  var sheet = el(
    '<div class="sheet home-sheet"><div class="sheet-card sheet-tall sheet-full">' +
      '<div class="sheet-head"><div class="sheet-title"></div>' +
      '<button class="sheet-x" aria-label="Close">' +
      '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>' +
      '</button></div><div class="sheet-body"></div>' +
    '</div></div>'
  )
  var titleEl = sheet.querySelector('.sheet-title')
  var body = sheet.querySelector('.sheet-body')
  // Closing repaints Home underneath, so a tile reflects anything done in its list.
  var close = function () {
    sheet.remove()
    if (HOME_SHEET === kind) HOME_SHEET = null
    if (TAB === 'home' && !DETAIL_ID) render()
  }
  sheet.querySelector('.sheet-x').addEventListener('click', close)
  sheet.addEventListener('click', function (e) { if (e.target === sheet) close() })

  function goBtn() {
    var b = el('<button class="btn-ghost homesheet-go">' + esc(cfg.goLabel) + '</button>')
    // Navigate BEFORE removing the sheet, so the history records that this list was open and Back
    // from the full page brings him back to it.
    b.addEventListener('click', function () { navigate(cfg.go) })
    return b
  }
  function setTitle(n) { titleEl.textContent = cfg.title + (n == null ? '' : '  ·  ' + n) }

  function draw() {
    body.innerHTML = ''
    body.appendChild(goBtn())
    var list = el('<div class="homesheet-list"></div>')
    body.appendChild(list)
    body.appendChild(goBtn())
    if (kind === 'mail') return fillMail(list)
    var d = homeData()
    if (kind === 'gigs') {
      setTitle(d.gigs.length)
      if (!d.gigs.length) list.appendChild(el('<div class="empty">No gigs in the next 7 days.</div>'))
      // Tapping a gig opens its project; the sheet goes with the move (see noteLoc).
      d.gigs.forEach(function (p) { list.appendChild(projectCard(p)) })
      return
    }
    var tasks = kind === 'overdue' ? d.overdue : d.dueToday
    setTitle(tasks.length)
    if (!tasks.length) list.appendChild(el('<div class="empty">' + (kind === 'overdue' ? 'Nothing overdue.' : 'Nothing due today.') + '</div>'))
    tasks.forEach(function (t) { list.appendChild(taskCard(t, true, draw)) })
  }

  // The tile's own list: the threads the count fetch already holds (UNREAD_THREADS), drawn at once.
  // If they are more than 30 seconds old, a refresh runs in the background and the list redraws
  // when it lands; "Loading mail…" only ever shows on the very first fetch.
  function fillMail(list) {
    var paint = function () {
      list.innerHTML = ''
      var threads = (UNREAD_THREADS || []).filter(function (t) { return t.unread })
      setTitle(threads.length)
      if (!threads.length) { list.appendChild(el('<div class="empty">Nothing unread from a client.</div>')); return }
      var ix = emailToProjectIndex()
      threads.forEach(function (t) {
        // Reading one marks it read; the list and the tile drop it straight away, then re-check.
        list.appendChild(mailRow(t, ix, function () { UNREAD_MAIL = (UNREAD_THREADS || []).filter(function (x) { return x.unread }).length; paintMailTile(); paint(); refreshUnreadMail() }))
      })
    }
    if (UNREAD_THREADS) paint()
    else { setTitle(null); list.appendChild(el('<div class="empty">Loading mail…</div>')) }
    if (!UNREAD_THREADS || Date.now() - UNREAD_AT > 30000) {
      refreshUnreadMail().then(function () {
        if (sheet.isConnected) paint()
      }).catch(function (err) {
        if (!sheet.isConnected) return
        if (UNREAD_THREADS) return // keep showing what we have; the next refresh will try again
        list.innerHTML = ''
        list.appendChild(mailError(err, function () { list.innerHTML = ''; list.appendChild(el('<div class="empty">Loading mail…</div>')); fillMail(list) }))
      })
    }
  }

  draw()
  document.body.appendChild(sheet)
}



// ---------- Calendar ----------
//
// The Mac's Calendar page (src/components/CalendarPage.tsx), ported 2026-10-23: gigs (green when
// booked, blue when not), open tasks with a due date (red), and his Google Work and Gigs calendars
// (teal and purple, TidyCal bookings tagged), the CRM's own synced events left out so nothing shows
// twice. The Google layer comes through phone-api `calendar-events`, the same rules as the Mac's
// /api/calendar/events. A seven-column month is too narrow on a phone for the Mac's text chips, so
// the grid carries coloured dots and the selected day's full list sits underneath, which is how the
// iPhone's own Calendar does it.
var CAL_COLORS = { booked: '#15803d', unbooked: '#2563eb', task: '#dc2626', gcal: '#a855f7', work: '#0e7490' }
var CAL_CURSOR = null // { y, m }
var CAL_SELECTED = ''
var CAL_EVENTS = {} // 'YYYY-MM' -> { events, error } or 'loading'
function calMinutes(raw) {
  var s = String(raw || '').toLowerCase()
  if (!s.trim() || /^\s*(tbd|to be determined|unknown|n\/?a|none)\b/.test(s)) return -1
  var ap = s.match(/(\d{1,2})(?::([0-5]\d))?\s*([ap])\.?\s?m\.?/)
  if (ap) {
    var h = Number(ap[1]), m = ap[2] ? Number(ap[2]) : 0
    if (ap[3] === 'p' && h < 12) h += 12
    else if (ap[3] === 'a' && h === 12) h = 0
    return h > 23 ? -1 : h * 60 + m
  }
  var hm = s.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/)
  return hm ? Number(hm[1]) * 60 + Number(hm[2]) : -1
}
function calLabel12(min) {
  if (min < 0) return ''
  var h = Math.floor(min / 60)
  return (h % 12 === 0 ? 12 : h % 12) + ':' + String(min % 60).padStart(2, '0') + ' ' + (h < 12 ? 'AM' : 'PM')
}
function stageSetForRole(role) {
  var set = {}
  ;(SNAP.structure.umbrellas || []).forEach(function (u) { if (u.role === role) (u.stages || []).forEach(function (st) { set[st.id] = 1 }) })
  return set
}
// Everything on one day, untimed first, then by time. Shared by the calendar and the date-conflict flag.
function calendarEntries(fromISO, toISO, gEvents) {
  var booked = stageSetForRole('booked'), post = stageSetForRole('postshow')
  var map = {}
  var add = function (k, e) { if (k && k >= fromISO && k <= toISO) (map[k] = map[k] || []).push(e) }
  ;(SNAP.projects || []).forEach(function (p) {
    if (p.bucket === 'archived' || p.bucket === 'deleted' || !p.eventDate) return
    var isBooked = p.bucket === 'completed' || booked[p.stageId] || post[p.stageId]
    var at = [p.arrivalTime, p.eventStartTime, p.showStartTime].map(calMinutes).filter(function (m) { return m >= 0 })[0]
    add(p.eventDate, { kind: 'gig', label: p.client, color: isBooked ? CAL_COLORS.booked : CAL_COLORS.unbooked, projectId: p.id, booked: !!isBooked, time: '', sortMin: at == null ? -1 : at })
  })
  ;(SNAP.tasks || []).forEach(function (t) {
    if (t.done || !t.dueDate) return
    var pr = t.projectId && SNAP.projects.find(function (x) { return x.id === t.projectId })
    if (pr && pr.bucket === 'deleted') return
    var at = calMinutes(t.dueTime)
    add(t.dueDate, { kind: 'task', label: t.title, color: CAL_COLORS.task, projectId: t.projectId, task: t, time: calLabel12(at), sortMin: at })
  })
  ;(gEvents || []).forEach(function (e) {
    if (!e.date) return
    var start = e.allDay || !e.startTime ? null : new Date(e.startTime)
    var at = start && !isNaN(start.getTime()) ? start.getHours() * 60 + start.getMinutes() : -1
    var work = e.calendar === 'Work'
    add(e.date, { kind: work ? 'work' : 'gcal', label: e.title, color: work ? CAL_COLORS.work : CAL_COLORS.gcal, href: e.htmlLink, time: calLabel12(at), sortMin: at, booking: !!e.booking, calendar: e.calendar })
  })
  Object.keys(map).forEach(function (k) { map[k].sort(function (a, b) { return a.sortMin - b.sortMin }) })
  return map
}
function calMonthKey(c) { return c.y + '-' + String(c.m + 1).padStart(2, '0') }
function loadCalMonth(c) {
  var key = calMonthKey(c)
  if (CAL_EVENTS[key]) return
  CAL_EVENTS[key] = 'loading'
  var from = key + '-01'
  var last = new Date(c.y, c.m + 1, 0).getDate()
  var to = key + '-' + String(last).padStart(2, '0')
  phoneApi('calendar-events', { from: from, to: to })
    .then(function (r) { CAL_EVENTS[key] = { events: r.events || [], error: r.errors ? r.errors.join(' ') : '' } })
    .catch(function (e) { CAL_EVENTS[key] = { events: [], error: e.message || 'Could not reach Google Calendar.' } })
    .then(function () { if (TAB === 'calendar' && !DETAIL_ID && !document.querySelector('.sheet')) renderCalendar() })
}
function renderCalendar() {
  var v = $('#view'); v.innerHTML = ''
  var now = new Date()
  if (!CAL_CURSOR) CAL_CURSOR = { y: now.getFullYear(), m: now.getMonth() }
  if (!CAL_SELECTED) CAL_SELECTED = todayStr()
  var c = CAL_CURSOR
  loadCalMonth(c)
  var key = calMonthKey(c)
  var g = CAL_EVENTS[key]
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

  var head = el('<div class="cal-head"><button class="iconbtn cal-prev" aria-label="Previous month"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button>' +
    '<div class="cal-title">' + MONTHS[c.m] + ' ' + c.y + '</div>' +
    '<button class="iconbtn cal-next" aria-label="Next month"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></button>' +
    '<button class="fin-edit cal-today">Today</button></div>')
  head.querySelector('.cal-prev').addEventListener('click', function () { CAL_CURSOR = { y: c.m === 0 ? c.y - 1 : c.y, m: (c.m + 11) % 12 }; renderCalendar() })
  head.querySelector('.cal-next').addEventListener('click', function () { CAL_CURSOR = { y: c.m === 11 ? c.y + 1 : c.y, m: (c.m + 1) % 12 }; renderCalendar() })
  head.querySelector('.cal-today').addEventListener('click', function () { CAL_CURSOR = { y: now.getFullYear(), m: now.getMonth() }; CAL_SELECTED = todayStr(); renderCalendar() })
  v.appendChild(head)
  v.appendChild(el('<div class="cal-legend"><span><i style="background:' + CAL_COLORS.booked + '"></i>Booked gig</span><span><i style="background:' + CAL_COLORS.unbooked + '"></i>Not booked</span>' +
    '<span><i style="background:' + CAL_COLORS.work + '"></i>Work calendar</span><span><i style="background:' + CAL_COLORS.gcal + '"></i>Gigs calendar</span><span><i style="background:' + CAL_COLORS.task + '"></i>Task due</span></div>'))

  // Sunday-first grid, only as many weeks as the month needs.
  var first = new Date(c.y, c.m, 1)
  var start = new Date(c.y, c.m, 1 - first.getDay())
  var lastDay = new Date(c.y, c.m + 1, 0)
  var weeks = Math.ceil((first.getDay() + lastDay.getDate()) / 7)
  var iso = function (d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') }
  var gridFrom = iso(start)
  var gridEnd = new Date(start); gridEnd.setDate(gridEnd.getDate() + weeks * 7 - 1)
  var map = calendarEntries(gridFrom, iso(gridEnd), g && g !== 'loading' ? g.events : [])
  var grid = el('<div class="cal-grid"></div>')
  ;['S', 'M', 'T', 'W', 'T', 'F', 'S'].forEach(function (d) { grid.appendChild(el('<div class="cal-wd">' + d + '</div>')) })
  var today = todayStr()
  for (var i = 0; i < weeks * 7; i++) {
    var d = new Date(start); d.setDate(start.getDate() + i)
    var k = iso(d)
    var items = map[k] || []
    var cell = el('<button class="cal-day' + (d.getMonth() !== c.m ? ' out' : '') + (k === today ? ' today' : '') + (k === CAL_SELECTED ? ' sel' : '') + '"><span class="cal-n">' + d.getDate() + '</span><span class="cal-dots"></span></button>')
    var dots = cell.querySelector('.cal-dots')
    items.slice(0, 4).forEach(function (e) { dots.appendChild(el('<i style="background:' + e.color + '"></i>')) })
    if (items.length > 4) dots.appendChild(el('<b>+</b>'))
    ;(function (key2) { cell.addEventListener('click', function () { CAL_SELECTED = key2; renderCalendar() }) })(k)
    grid.appendChild(cell)
  }
  v.appendChild(grid)
  if (g === 'loading') v.appendChild(el('<p class="fin-foot">Loading your Google calendars…</p>'))
  else if (g && g.error) v.appendChild(el('<p class="fin-foot">Google Calendar: ' + esc(g.error) + '</p>'))

  // The selected day, in full.
  var sel = parseDate(CAL_SELECTED)
  var dayItems = calendarEntries(CAL_SELECTED, CAL_SELECTED, g && g !== 'loading' ? g.events : [])[CAL_SELECTED] || []
  v.appendChild(el('<div class="fin-sec"><span>' + esc(sel ? sel.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) : CAL_SELECTED) + '</span><span class="fin-sec-r">' + dayItems.length + ' item' + (dayItems.length === 1 ? '' : 's') + '</span></div>'))
  if (!dayItems.length) { v.appendChild(el('<div class="empty">Nothing on this day.</div>')); return }
  var list = el('<div class="fin-card fin-list"></div>')
  dayItems.forEach(function (e) {
    var kind = e.kind === 'gig' ? (e.booked ? 'Booked gig' : 'Not booked') : e.kind === 'task' ? 'Task' : (e.calendar || 'Calendar') + ' calendar'
    var row = el('<div class="fl-row fl-tap cal-item"><span class="cal-bar" style="background:' + e.color + '"></span><div class="fl-main"><div class="fl-top"><span class="fl-name">' + esc(e.label) + '</span>' +
      (e.time ? '<span class="cal-time">' + esc(e.time) + '</span>' : '') + '</div><div class="fl-meta">' + esc(kind) + (e.booking ? '<span class="pill">TidyCal</span>' : '') + '</div></div></div>')
    row.addEventListener('click', function () {
      if (e.kind === 'gig') openProjectById(e.projectId)
      else if (e.kind === 'task') openTaskEditor(e.task, function () { renderCalendar() })
      else if (e.href) window.open(e.href, '_blank')
    })
    list.appendChild(row)
  })
  v.appendChild(list)
}


// ---------- Lead Stats ----------
//
// The Mac's Stats page (src/components/StatsPage.tsx), ported 2026-10-23: the same period and basis
// switches, the same signed-off pool (Audit decides what counts), the same won/lost definitions and
// source buckets, and the Audit tab for signing projects off. Keep the two in step.
var STATS_TAB = 'overview', STATS_PERIOD = 'year', STATS_BASIS = 'event', STATS_PREVIEW = false, STATS_AUDIT = 'needs'
var STAT_LEAD_SOURCES = ['Google/Web', 'Bark', 'The Bash', 'GigSalad', 'In Person', 'Referral', 'Instagram/TikTok', 'AI', 'Repeat client', 'Other']
var STAT_SOURCE_KEYWORDS = [
  [/\bai\b|chatgpt|chat gpt|gemini|perplexity|claude|copilot/, 'AI'],
  [/repeat|returning client|past client/, 'Repeat client'],
  [/gigsalad|gig salad/, 'GigSalad'],
  [/\bbash\b/, 'The Bash'],
  [/\bbark\b/, 'Bark'],
  [/instagram|tiktok|tik tok/, 'Instagram/TikTok'],
  [/google|website|wix|online|\bweb\b|search|internet/, 'Google/Web'],
  [/referral|referred|recommend/, 'Referral'],
  [/live show|in person|in-person|saw michael|saw him|perform|went to|met michael|\bmet\b/, 'In Person'],
  [/magician|jack kelly|kevin|evan driggs|gary goodman|steve vaught|wayne haarhaus/, 'Referral'],
]
var EVENT_TYPES = ['Wedding', 'Corporate', 'Private Event', 'Bachelor(ette) Party', 'Other']
var EVENT_TYPE_COLOR = { Wedding: '#2563eb', Corporate: '#15803d', 'Private Event': '#b7791f', 'Bachelor(ette) Party': '#64748b', Other: '#858d97' }
function normalizeSource(raw) {
  var s2 = String(raw || '').toLowerCase().trim()
  if (!s2) return 'Other'
  var exact = STAT_LEAD_SOURCES.find(function (o) { return o.toLowerCase() === s2 })
  if (exact) return exact
  var best = 'Other', at = Infinity
  STAT_SOURCE_KEYWORDS.forEach(function (kw) { var m = kw[0].exec(s2); if (m && m.index < at) { at = m.index; best = kw[1] } })
  return best
}
function statsIsWon(p) { return p.bucket === 'completed' || p.stageId === 'deposit-paid' }
function statsIsLost(p) { return p.bucket === 'archived' }
function statsInRange(d, period) {
  if (period === 'all') return true
  if (!/^\d{4}-\d{2}-\d{2}/.test(d || '')) return false
  if (period === 'year') return d.slice(0, 4) === todayStr().slice(0, 4)
  var back = period === 'last12' ? 365 : 30
  var from = new Date(); from.setDate(from.getDate() - back)
  var fromISO = from.getFullYear() + '-' + String(from.getMonth() + 1).padStart(2, '0') + '-' + String(from.getDate()).padStart(2, '0')
  return d >= fromISO && d <= todayStr()
}
function statsTally(items, keyFn) {
  var m = {}
  items.forEach(function (x) { var k = keyFn(x); m[k] = (m[k] || 0) + 1 })
  return Object.keys(m).map(function (k) { return { k: k, n: m[k] } }).sort(function (a, b) { return b.n - a.n })
}
function statsBars(rows, color) {
  var box = el('<div class="sbars"></div>')
  if (!rows.length) { box.appendChild(el('<p class="fin-h">No data in this view.</p>')); return box }
  var max = Math.max.apply(null, [1].concat(rows.map(function (r) { return r.n })))
  var sum = rows.reduce(function (a, r) { return a + r.n }, 0)
  rows.forEach(function (r) {
    var c = typeof color === 'function' ? color(r.k) : (color || '#2563eb')
    box.appendChild(el('<div class="sbar"><div class="sbar-top"><span>' + esc(r.k) + '</span><span>' + r.n + (sum ? ' <i>· ' + Math.round(r.n / sum * 100) + '%</i>' : '') + '</span></div><div class="sbar-track"><span style="width:' + (r.n / max * 100) + '%;background:' + c + '"></span></div></div>'))
  })
  return box
}
function statsRates(rows) {
  var box = el('<div class="sbars"></div>')
  if (!rows.length) { box.appendChild(el('<p class="fin-h">No resolved leads in this view.</p>')); return box }
  rows.forEach(function (r) {
    box.appendChild(el('<div class="sbar"><div class="sbar-top"><span>' + esc(r.k) + '</span><span>' + r.booked + '/' + r.leads + ' <b>' + Math.round(r.rate * 100) + '%</b></span></div><div class="sbar-track"><span style="width:' + (r.rate * 100) + '%;background:#15803d"></span></div></div>'))
  })
  return box
}
function statsSeg(opts, cur, onPick) {
  var seg = el('<div class="seg stats-seg"></div>')
  opts.forEach(function (o) {
    var b = el('<button class="segb' + (cur === o[0] ? ' on' : '') + '">' + esc(o[1]) + '</button>')
    b.addEventListener('click', function () { if (cur !== o[0]) onPick(o[0]) })
    seg.appendChild(b)
  })
  return seg
}
function renderStats() {
  var v = $('#view'); v.innerHTML = ''
  v.appendChild(statsSeg([['overview', 'Overview'], ['audit', 'Audit']], STATS_TAB, function (t) { STATS_TAB = t; renderStats() }))
  var live = (SNAP.projects || []).filter(function (p) { return p.bucket !== 'deleted' })
  if (STATS_TAB === 'audit') return statsAudit(v, live)

  v.appendChild(statsSeg([['year', 'This year (' + todayStr().slice(0, 4) + ')'], ['last12', 'Last 12 months'], ['last30', 'Last 30 days'], ['all', 'All-time']], STATS_PERIOD, function (t) { STATS_PERIOD = t; renderStats() }))
  var row = el('<div class="fin-ctrl"></div>')
  row.appendChild(statsSeg([['event', 'By event date'], ['lead', 'By lead date']], STATS_BASIS, function (t) { STATS_BASIS = t; renderStats() }))
  var pv = el('<button class="fin-edit' + (STATS_PREVIEW ? ' on' : '') + '">' + (STATS_PREVIEW ? 'Previewing unsigned' : 'Preview unsigned') + '</button>')
  pv.addEventListener('click', function () { STATS_PREVIEW = !STATS_PREVIEW; renderStats() })
  row.appendChild(pv)
  v.appendChild(row)

  var pool = STATS_PREVIEW ? live : live.filter(function (p) { return p.signedOff })
  var dateOf = function (p) { return STATS_BASIS === 'lead' ? p.leadDate : p.eventDate }
  var leads = pool.filter(function (p) { return statsInRange(dateOf(p), STATS_PERIOD) })
  var won = leads.filter(statsIsWon), lost = leads.filter(statsIsLost)
  var open = leads.filter(function (p) { return p.bucket === 'active' && !statsIsWon(p) })
  var resolved = leads.filter(function (p) { return statsIsWon(p) || statsIsLost(p) })
  var closeRate = resolved.length ? won.length / resolved.length : 0
  var revenue = won.reduce(function (a, p) { return a + (typeof p.totalFee === 'number' ? p.totalFee : 0) }, 0)
  var avg = won.length ? revenue / won.length : 0
  var rateBy = function (keyFn) {
    var keys = {}
    resolved.forEach(function (p) { keys[keyFn(p)] = 1 })
    return Object.keys(keys).map(function (k) {
      var ls = resolved.filter(function (p) { return keyFn(p) === k }), b = ls.filter(statsIsWon).length
      return { k: k, leads: ls.length, booked: b, rate: ls.length ? b / ls.length : 0 }
    }).sort(function (a, b) { return b.leads - a.leads })
  }
  v.appendChild(el('<div class="pagenote">' + (STATS_PREVIEW ? 'Previewing ALL projects, including ones you have not signed off. These numbers are not final.' :
    'Showing ' + pool.length + ' signed-off project' + (pool.length === 1 ? '' : 's') + '. Sign projects off in the Audit tab to include them.') +
    ' Conversion excludes still-open projects; close rate = won of resolved (won + lost).</div>'))
  if (!pool.length) {
    v.appendChild(el('<div class="fin-card" style="text-align:center"><p style="margin:6px 0 4px;font-weight:600">No signed-off projects yet.</p><p class="fin-h">Open the Audit tab to review each project and sign it off, or tap "Preview unsigned" above to peek at the raw numbers.</p></div>'))
    return
  }
  var grid = el('<div class="stat-grid"></div>')
  ;[['Leads', String(leads.length), '', '#2563eb'], ['Booked', String(won.length), Math.round(closeRate * 100) + '% close rate', '#15803d'], ['Lost', String(lost.length), '', '#dc2626'],
    ['Still open', String(open.length), '', '#64748b'], ['Booked revenue', money(revenue), '', '#2563eb'], ['Avg booking', money(avg), '', '#2563eb']].forEach(function (c) {
    grid.appendChild(el('<div class="statcard" style="border-left-color:' + c[3] + '"><div class="n" style="color:var(--parchment)">' + esc(c[1]) + '</div><div class="l">' + esc(c[0]) + '</div>' + (c[2] ? '<div class="l" style="color:var(--muted)">' + esc(c[2]) + '</div>' : '') + '</div>'))
  })
  v.appendChild(grid)

  // Leads over time: one bar per month that has leads.
  var mm = {}
  leads.forEach(function (p) { var d = dateOf(p); if (/^\d{4}-\d{2}/.test(d || '')) mm[d.slice(0, 7)] = (mm[d.slice(0, 7)] || 0) + 1 })
  var mrows = Object.keys(mm).sort().map(function (k) { return { k: k, n: mm[k] } })
  var MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  var mc = el('<div class="fin-card"><div class="fin-cap">Leads over time · by ' + (STATS_BASIS === 'lead' ? 'lead date' : 'event date') + '</div></div>')
  if (!mrows.length) mc.appendChild(el('<p class="fin-h">No dated leads in this view.</p>'))
  else {
    var mmax = Math.max.apply(null, [1].concat(mrows.map(function (r) { return r.n })))
    var bars = el('<div class="mbars"></div>')
    mrows.forEach(function (r) {
      bars.appendChild(el('<div class="mbar"><span class="mbar-n">' + r.n + '</span><span class="mbar-b" style="height:' + (r.n / mmax * 100) + '%"></span><span class="mbar-l">' + MN[Number(r.k.slice(5, 7)) - 1] + " '" + r.k.slice(2, 4) + '</span></div>'))
    })
    mc.appendChild(bars)
  }
  v.appendChild(mc)
  var typeColor = function (k) { return EVENT_TYPE_COLOR[k] || '#858d97' }
  ;[['Where leads came from', statsBars(statsTally(leads, function (p) { return normalizeSource(p.bookingSource) }))],
    ['Close rate by source', statsRates(rateBy(function (p) { return normalizeSource(p.bookingSource) }))],
    ['Lead type mix', statsBars(statsTally(leads, function (p) { return p.eventType || 'Other' }), typeColor)],
    ['Booked type mix', statsBars(statsTally(won, function (p) { return p.eventType || 'Other' }), typeColor)],
    ['Close rate by event type', statsRates(rateBy(function (p) { return p.eventType || 'Other' }))],
    ['Why leads were lost', statsBars(statsTally(lost, function (p) { return p.archiveReason || 'Unspecified' }), '#dc2626')]].forEach(function (sec) {
    var card = el('<div class="fin-card"><div class="fin-cap">' + esc(sec[0]) + '</div></div>')
    card.appendChild(sec[1])
    v.appendChild(card)
  })
}

// The Audit tab: review every project's stat fields and sign it off, so Stats only counts clean data.
function statsAudit(v, live) {
  var signed = live.filter(function (p) { return p.signedOff }).length
  var top = el('<div class="fin-card"><div class="fin-caprow" style="display:flex;align-items:center"><span style="flex:1"><b>' + signed + '</b> of ' + live.length + ' signed off</span></div><div class="goal-bar" style="margin-top:8px;background:#e5e9ef"><span style="width:' + (live.length ? signed / live.length * 100 : 0) + '%;background:#15803d"></span></div></div>')
  v.appendChild(top)
  v.appendChild(statsSeg([['needs', 'Needs review'], ['signed', 'Signed off'], ['all', 'All']], STATS_AUDIT, function (t) { STATS_AUDIT = t; renderStats() }))
  var shown = function (p) { return STATS_AUDIT === 'all' ? true : STATS_AUDIT === 'needs' ? !p.signedOff : p.signedOff }
  var archiveReasons = (SNAP.config && SNAP.config.archiveReasons) || []
  ;[['Active', 'active'], ['Completed', 'completed'], ['Archived', 'archived']].forEach(function (g) {
    var all = live.filter(function (p) { return p.bucket === g[1] })
    if (!all.length) return
    var list = all.filter(shown).sort(function (a, b) { return Number(a.signedOff) - Number(b.signedOff) || (a.client || '').localeCompare(b.client || '') })
    v.appendChild(el('<div class="fin-sec"><span>' + g[0] + ' · ' + all.filter(function (p) { return p.signedOff }).length + '/' + all.length + ' signed off</span></div>'))
    if (!list.length) { v.appendChild(el('<p class="fin-foot" style="margin-bottom:8px">Nothing here for this filter.</p>')); return }
    list.forEach(function (p) { v.appendChild(auditCard(p, archiveReasons)) })
  })
}
function auditCard(p, archiveReasons) {
  var card = el('<div class="fin-card audit' + (p.signedOff ? ' signed' : '') + '"><div class="audit-top"><button class="audit-name">' + esc(p.client) + '</button><button class="audit-sign">' + (p.signedOff ? '✓ Signed off' : 'Sign off') + '</button></div><div class="audit-grid"></div></div>')
  card.querySelector('.audit-name').addEventListener('click', function () { openProjectById(p.id) })
  var save = function (field, value, after) {
    doWrite(updateProjectField(p.id, field, value), 'Saved', function (r) {
      if (field === 'totalFee') p.totalFee = r.value
      else p[field] = r.value
      if (after) after()
    })
  }
  card.querySelector('.audit-sign').addEventListener('click', function () { save('signedOff', !p.signedOff, renderStats) })
  var grid = card.querySelector('.audit-grid')
  var field = function (label, kind, value, opts, warn, key) {
    var w = el('<label class="audit-f"><span>' + esc(label) + '</span></label>')
    var input
    if (kind === 'select') {
      input = document.createElement('select')
      input.appendChild(el('<option value="">(none)</option>'))
      if (value && opts.indexOf(value) < 0) input.appendChild(el('<option value="' + esc(value) + '">' + esc(value) + ' (uncategorized)</option>'))
      opts.forEach(function (o) { input.appendChild(el('<option value="' + esc(o) + '">' + esc(o) + '</option>')) })
      input.value = value || ''
      input.addEventListener('change', function () {
        var nv = input.value
        if (key === 'bookingSource' && nv === 'Referral' && /^referral\b/i.test(p.bookingSource || '')) nv = p.bookingSource
        save(key, nv, renderStats)
      })
    } else {
      input = document.createElement('input')
      input.type = kind === 'date' ? 'date' : 'text'
      if (kind === 'number') input.inputMode = 'decimal'
      input.value = value || ''
      input.addEventListener('blur', function () { if (input.value !== (value || '')) save(key, input.value) })
    }
    input.className = 'field-input' + (!String(value || '').trim() ? ' f-empty' : warn ? ' f-warn' : '')
    w.appendChild(input)
    grid.appendChild(w)
  }
  field('Lead date', 'date', p.leadDate, null, false, 'leadDate')
  field('Event date', 'date', p.eventDate, null, false, 'eventDate')
  field('Lead source', 'select', /^referral\b/i.test(p.bookingSource || '') ? 'Referral' : p.bookingSource, STAT_LEAD_SOURCES, STAT_LEAD_SOURCES.indexOf(p.bookingSource) < 0 && !/^referral\b/i.test(p.bookingSource || ''), 'bookingSource')
  // A referral keeps who referred them, saved as "Referral - Name", the Mac's format.
  if (/^referral\b/i.test(p.bookingSource || '')) {
    var ref = el('<label class="audit-f"><span>Referred by</span><input class="field-input" placeholder="Name"></label>')
    var ri = ref.querySelector('input')
    ri.value = String(p.bookingSource).replace(/^referral\s*[-:]?\s*/i, '').trim()
    ri.addEventListener('blur', function () { var nm = ri.value.trim(); var next = nm ? 'Referral - ' + nm : 'Referral'; if (next !== p.bookingSource) save('bookingSource', next) })
    grid.appendChild(ref)
  }
  field('Event type', 'select', p.eventType, EVENT_TYPES, p.eventType === 'Other', 'eventType')
  if (p.bucket === 'archived') field('Archive reason', 'select', p.archiveReason, archiveReasons, p.archiveReason === 'Other', 'archiveReason')
  field('Total fee', 'number', p.totalFee == null ? '' : String(p.totalFee), null, false, 'totalFee')
  return card
}


// ---------- Website Analytics ----------
//
// The Mac's Website page (src/components/WebsiteAnalyticsPage.tsx), ported 2026-10-23: the Live Feed
// from the website-analytics function (GA4 + Search Console, the same data the Mac shows) and the
// static Guide. The Guide's text is copied from the Mac file; keep the two in step.
var WEB_TAB = 'live'
var WEB_DATA = null, WEB_ERR = '', WEB_LOADING = false, WEB_TIMER = null
var WEB_TOOLS = [
  { name: 'Google Analytics 4', tag: 'Traffic & behavior', blurb: 'Who visits your site, where they come from, and what they do once they arrive.', url: 'https://analytics.google.com/', account: 'business',
    looks: [['Who is on the site right now', 'Reports  ›  Realtime'], ['Where visitors come from (Google, direct, social)', 'Reports  ›  Acquisition  ›  Traffic acquisition'], ['Your most-visited pages', 'Reports  ›  Engagement  ›  Pages and screens'], ['How many people submitted the contact form', 'Reports  ›  Engagement  ›  Conversions']],
    note: 'Data is near-live: most reports are fresh within a few hours, and Realtime is the last 30 minutes.' },
  { name: 'Google Search Console', tag: 'How you rank on Google', blurb: 'The exact searches that surface your site, how often you get clicked, and where you sit in the results.', url: 'https://search.google.com/search-console', account: 'personal',
    looks: [['The keywords you rank for, plus clicks', 'Performance  ›  Queries tab'], ['Your average position for a search', 'Performance  ›  turn on "Average position"'], ['Which pages Google has indexed', 'Indexing  ›  Pages'], ['Ask Google to re-crawl a page', 'the URL-inspection bar up top']],
    note: 'Search Console data is always about 2-3 days behind. That is a Google limitation, not a bug.' },
  { name: 'Google Ads', tag: 'Your paid campaign', blurb: 'The paid search campaign that puts you at the top of Google for the searches you want. What you spend and what it brings in.', url: 'https://ads.google.com/', account: 'personal',
    looks: [['Spend against your daily budget', 'Campaigns  ›  "Michael’s campaign"'], ['Leads and cost per lead', 'Campaigns  ›  Conversions column'], ['Wasted or out-of-area clicks to block', 'Insights  ›  Search terms'], ['That the ad is still running and approved', 'Campaigns  ›  Status = Eligible']],
    note: 'A weekly look is plenty. Avoid changing settings daily. The bidding needs a stable runway to learn.' },
  { name: 'Bing Webmaster Tools', tag: 'Bing + ChatGPT', blurb: 'The same idea as Search Console, but for Bing. It matters because ChatGPT search leans on the Bing index.', url: 'https://www.bing.com/webmasters', account: 'business',
    looks: [['Keywords and clicks on Bing', 'Search Performance'], ['How you show up in AI answers', 'AI Performance (Beta)']] },
  { name: 'Cloudflare', tag: 'Raw traffic & speed', blurb: 'The plumbing under your site: total visits, requests, and how fast pages load around the world.', url: 'https://dash.cloudflare.com/', account: 'business',
    looks: [['Total visits and requests', 'Workers & Pages  ›  website  ›  Metrics'], ['Traffic and performance overview', 'Analytics & Logs  ›  Web Analytics']] },
]
var WEB_ACCOUNTS = [
  ['Google Analytics (GA4)', 'business', 'property michaelbloemeke.com'], ['Google Search Console', 'personal', 'sc-domain:michaelbloemeke.com'],
  ['Google Ads', 'personal', '"Michael’s campaign"'], ['Google Cloud (analytics API)', 'personal', 'project wide-ceiling-272318'],
  ['Bing Webmaster Tools', 'business', 'Bing + ChatGPT index'], ['Cloudflare (hosting)', 'business', 'Pages project "website"'], ['Google Business Profile', 'business', 'the 344 five-star reviews'],
]
var WEB_QUICK = [['Is anyone on my site right now?', 'Analytics  ›  Realtime'], ['What keywords am I ranking for?', 'Search Console  ›  Performance'], ['Did I get new leads this week?', 'Your CRM Inbox (or Analytics  ›  Conversions)'],
  ['Is my site fast and online?', 'Cloudflare  ›  Web Analytics'], ['Am I showing up in Bing / ChatGPT?', 'Bing Webmaster  ›  AI Performance']]
var WEB_EMAILS = { business: 'michael@michaelbloemeke.com', personal: 'mchlbloemeke@gmail.com' }
function webBadge(account, withEmail) {
  return '<span class="acc-badge"><i style="background:' + (account === 'business' ? '#b7791f' : '#2563eb') + '"></i>' + esc(withEmail ? WEB_EMAILS[account] : account === 'business' ? 'Business' : 'Personal') + '</span>'
}
function webLoad(force) {
  if (WEB_LOADING) return
  WEB_LOADING = true
  loadAnalytics(force).then(function (d) { WEB_DATA = d; WEB_ERR = '' }).catch(function (e) { WEB_ERR = e.message || 'Could not reach the analytics service.' })
    .then(function () { WEB_LOADING = false; if (TAB === 'website' && WEB_TAB === 'live' && !DETAIL_ID && !document.querySelector('.sheet')) renderWebsite() })
}
function renderWebsite() {
  var v = $('#view'); v.innerHTML = ''
  v.appendChild(statsSeg([['live', 'Live Feed'], ['guide', 'Guide']], WEB_TAB, function (t) { WEB_TAB = t; renderWebsite() }))
  if (WEB_TAB === 'guide') return webGuide(v)
  // Refresh every minute while the page is open, like the Mac.
  clearInterval(WEB_TIMER)
  WEB_TIMER = setInterval(function () { if (TAB === 'website' && WEB_TAB === 'live') webLoad(true); else clearInterval(WEB_TIMER) }, 60 * 1000)
  if (!WEB_DATA && !WEB_ERR) { webLoad(false); v.appendChild(el('<div class="empty">Loading live analytics…</div>')); return }
  if (WEB_ERR && !WEB_DATA) {
    var e = el('<div class="fin-card"><p style="margin:0 0 8px">' + esc(WEB_ERR) + '</p><button class="btn-ghost">Try again</button></div>')
    e.querySelector('button').addEventListener('click', function () { WEB_ERR = ''; webLoad(true); renderWebsite() })
    v.appendChild(e); return
  }
  var d = WEB_DATA
  if (!d.connected) { v.appendChild(el('<div class="fin-card"><b>Live data is not connected yet.</b><p class="fin-h">The Google credential the analytics function needs is not set. The Guide tab says where to look in the meantime.</p></div>')); return }
  var when = d.generatedAt ? new Date(d.generatedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : ''
  v.appendChild(el('<p class="fin-intro"><span class="live-dot"></span> Live · updated ' + esc(when) + ' · refreshes every minute' + ((d.errors && d.errors.length) ? '. Some panels could not load.' : '') + '</p>'))
  var nf = function (n) { return Number(n || 0).toLocaleString('en-US') }
  var dur = function (sec) { sec = Math.round(Number(sec) || 0); return Math.floor(sec / 60) + 'm ' + String(sec % 60).padStart(2, '0') + 's' }
  var card = function (cap) { var c = el('<div class="fin-card"><div class="fin-cap">' + esc(cap) + '</div></div>'); v.appendChild(c); return c }
  var bars = function (rows, key, val, color) { return statsBars(rows.map(function (r) { return { k: r[key] || '(not set)', n: r[val] || 0 } }), color) }

  var rt = d.realtime
  var c1 = card('Right now · last 30 min')
  if (!rt) c1.appendChild(el('<p class="fin-h">Realtime data did not load.</p>'))
  else {
    c1.appendChild(el('<div><div class="fin-n">' + nf(rt.activeUsers) + '</div><div class="fin-h">' + (rt.activeUsers === 1 ? 'person' : 'people') + ' on your site</div></div>'))
    if ((rt.byCity || []).length) { c1.appendChild(el('<div class="fin-l" style="margin-top:12px">Cities</div>')); c1.appendChild(bars(rt.byCity, 'city', 'users')) }
    if ((rt.byPage || []).length) { c1.appendChild(el('<div class="fin-l" style="margin-top:12px">On this page</div>')); c1.appendChild(bars(rt.byPage, 'page', 'users')) }
  }
  var vi = d.visitors
  if (vi) {
    var c2 = card('Visitors · last 7 / 28 days')
    var newPct = vi.last28 && vi.last28.users ? Math.round(vi.last28.newUsers / vi.last28.users * 100) : 0
    c2.appendChild(el('<div class="kv4"><div><span>Visitors (7d)</span><b>' + nf(vi.last7.users) + '</b><i>' + nf(vi.last7.sessions) + ' sessions</i></div><div><span>Visitors (28d)</span><b>' + nf(vi.last28.users) + '</b><i>' + nf(vi.last28.sessions) + ' sessions</i></div>' +
      '<div><span>New (28d)</span><b>' + newPct + '%</b></div><div><span>Avg time</span><b>' + dur(vi.last28.avgSessionDuration) + '</b></div></div>'))
    var tr = vi.trend || []
    if (tr.length > 1) {
      var mx = Math.max.apply(null, [1].concat(tr.map(function (t) { return t.users })))
      var pts = tr.map(function (t, i) { return (i / (tr.length - 1) * 300).toFixed(1) + ',' + (56 - t.users / mx * 52).toFixed(1) }).join(' ')
      c2.appendChild(el('<div class="fin-l" style="margin-top:12px">28-day trend</div>'))
      c2.appendChild(el('<svg class="spark" viewBox="0 0 300 60" preserveAspectRatio="none"><polyline points="' + pts + '" fill="none" stroke="#2563eb" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>'))
    }
  }
  if (d.sources) {
    var c3 = card('Where they came from')
    c3.appendChild(el('<div class="fin-l">Channels</div>')); c3.appendChild(bars(d.sources.channels || [], 'channel', 'sessions'))
    c3.appendChild(el('<div class="fin-l" style="margin-top:12px">Top sources</div>')); c3.appendChild(bars(d.sources.top || [], 'source', 'sessions'))
  }
  if (d.locations) {
    var c4 = card('Where they are')
    c4.appendChild(el('<div class="fin-l">Countries</div>')); c4.appendChild(bars((d.locations.countries || []).slice(0, 6), 'country', 'users'))
    c4.appendChild(el('<div class="fin-l" style="margin-top:12px">Cities</div>'))
    c4.appendChild(statsBars((d.locations.cities || []).slice(0, 8).map(function (c) { return { k: [c.city, c.region].filter(Boolean).join(', '), n: c.users } })))
  }
  if (d.devices) {
    var c5 = card('Devices')
    c5.appendChild(bars(d.devices.categories || [], 'device', 'users'))
    c5.appendChild(el('<div class="fin-l" style="margin-top:12px">Browsers</div>')); c5.appendChild(bars((d.devices.browsers || []).slice(0, 5), 'browser', 'users'))
    c5.appendChild(el('<div class="fin-l" style="margin-top:12px">Operating systems</div>')); c5.appendChild(bars((d.devices.os || []).slice(0, 5), 'os', 'users'))
  }
  if (d.pages && d.pages.length) {
    var c6 = card('Top pages · last 28 days')
    var tbl = el('<div class="wtable"></div>')
    d.pages.forEach(function (pg) { tbl.appendChild(el('<div class="wrow"><span class="wq">' + esc(pg.path) + '</span><span>' + nf(pg.views) + '</span><span>' + dur(pg.avgTime) + '</span></div>')) })
    c6.appendChild(el('<div class="wrow whead"><span class="wq">Page</span><span>Views</span><span>Avg time</span></div>'))
    c6.appendChild(tbl)
  }
  var ads = d.ads
  var c7 = card('Ad spend')
  if (!ads || !ads.linked) c7.appendChild(el('<p class="fin-h">Google Ads is not linked to Analytics yet, so no spend data flows in.</p>'))
  else {
    var cpc = ads.last28.clicks ? ads.last28.cost / ads.last28.clicks : 0
    c7.appendChild(el('<div class="kv4"><div><span>Spend (28d)</span><b>' + esc(money2(ads.last28.cost)) + '</b></div><div><span>Clicks (28d)</span><b>' + nf(ads.last28.clicks) + '</b></div>' +
      '<div><span>Cost per click</span><b>' + esc(money2(cpc)) + '</b></div><div><span>Spend (7d)</span><b>' + esc(money2(ads.last7.cost)) + '</b></div></div>'))
    c7.appendChild(el('<p class="fin-h">' + nf(ads.last28.impressions) + ' impressions in 28 days</p>'))
    ;(ads.campaigns || []).forEach(function (cmp) { c7.appendChild(el('<div class="wrow"><span class="wq">' + esc(cmp.name) + '</span><span>' + esc(money2(cmp.cost)) + '</span><span>' + nf(cmp.clicks) + ' clicks</span></div>')) })
  }
  var cv = d.conversions
  if (cv) {
    var c8 = card('Conversions & leads')
    c8.appendChild(el('<div class="kv4"><div><span>Leads (7d)</span><b>' + nf(cv.leads7) + '</b></div><div><span>Leads (28d)</span><b>' + nf(cv.leads28) + '</b></div>' +
      '<div><span>Conversion rate (28d)</span><b>' + (cv.rate28 == null ? '-' : (cv.rate28 * 100).toFixed(1) + '%') + '</b></div></div>'))
  }
  var sr = d.search
  if (sr) {
    var c9 = card('Top search keywords')
    c9.appendChild(el('<p class="fin-h" style="margin-top:-4px">' + esc(sr.startDate) + ' to ' + esc(sr.endDate) + '. Search Console runs 2 to 3 days behind.</p>'))
    c9.appendChild(el('<div class="wrow whead"><span class="wq">Query</span><span>Clicks</span><span>Impr.</span><span>Pos.</span></div>'))
    ;(sr.queries || []).forEach(function (q) {
      c9.appendChild(el('<div class="wrow"><span class="wq">' + esc(q.query) + '</span><span>' + nf(q.clicks) + '</span><span>' + nf(q.impressions) + '</span><span>' + (Number(q.position) || 0).toFixed(1) + '</span></div>'))
    })
  }
}
function webGuide(v) {
  v.appendChild(el('<p class="fin-intro">Until the Live Feed is connected (and any time you want the source of truth), here is where to check each dashboard yourself. Open the ones you care about and bookmark them.</p>'))
  var acc = el('<div class="fin-card"><div class="fin-cap fin-caprow"><span>Which login is each one under</span></div></div>')
  WEB_ACCOUNTS.forEach(function (a) { acc.appendChild(el('<div class="wrow"><span class="wq">' + esc(a[0]) + '<i class="faint"> · ' + esc(a[2]) + '</i></span>' + webBadge(a[1]) + '</div>')) })
  acc.appendChild(el('<p class="fin-h" style="margin-top:8px">Split on purpose. Analytics, Bing, Cloudflare, and your Google Business Profile sit under the business email. Search Console, Google Ads, and the analytics API project sit under your personal Gmail.</p>'))
  v.appendChild(acc)
  var qk = el('<div class="fin-card"><div class="fin-cap">Quick answers</div></div>')
  WEB_QUICK.forEach(function (q) { qk.appendChild(el('<div class="quick"><span>' + esc(q[0]) + '</span><b>' + esc(q[1]) + '</b></div>')) })
  v.appendChild(qk)
  WEB_TOOLS.forEach(function (t) {
    var c = el('<div class="fin-card"><div class="tool-top"><div><div class="fin-cap" style="margin:0;color:#b7791f">' + esc(t.tag) + '</div><div class="pb-h">' + esc(t.name) + '</div></div><button class="btn-ghost">Open ↗</button></div>' +
      '<p class="pb-blurb">' + esc(t.blurb) + '</p>' + webBadge(t.account, true) + '<div class="fin-l" style="margin:12px 0 6px">What to look at</div></div>')
    c.querySelector('button').addEventListener('click', function () { window.open(t.url, '_blank') })
    t.looks.forEach(function (l) { c.appendChild(el('<div class="look"><span>' + esc(l[0]) + '</span><i>' + esc(l[1]) + '</i></div>')) })
    if (t.note) c.appendChild(el('<p class="tool-note">' + esc(t.note) + '</p>'))
    v.appendChild(c)
  })
}


// ---------- Settings ----------
//
// The Mac's Settings page (src/components/SettingsPage.tsx + CalendarAlerts.tsx), ported 2026-10-23.
// Every tab writes the SAME rows the Mac writes (crm_config.data, calendar_alert_settings), always
// read-then-merge, so the two apps share one set of settings. Two Mac tabs are about the MacBook
// itself (the Google sign-in it syncs with, and ntfy pushes); on the phone those become this
// device's own push status and a read-only view of what the cloud sees.
var SET_TAB = 'fields'
var SET_CFG = null // the raw crm_config.data while Settings is open
var SET_DRAFT = null
var SET_ALERTS = null, SET_ALERT_STATE = null, SET_ALERT_TIMER = null, SET_ALERT_PENDING = {}
var EVENT_FIELD_DEFS = [
  ['eventSummary', 'Description'], ['eventDate', 'Event date'], ['arrivalTime', 'Arrival time'], ['eventStartTime', 'Event start'], ['showStartTime', 'Show start'],
  ['totalFee', 'Quote'], ['numberOfGuests', 'Guest Count'], ['ageOfGuests', 'Guest ages'], ['eventLocation', 'Location'], ['venueType', 'Venue type'],
  ['indoorsOrOutdoors', 'Indoors / Outdoors'], ['performanceStyle', 'Performance'], ['av', 'AV'], ['vips', 'VIPs'], ['bookingSource', 'Booking source'],
]
var ESSENTIAL_FIELDS = { eventDate: 1, eventStartTime: 1, showStartTime: 1, totalFee: 1, numberOfGuests: 1, ageOfGuests: 1, eventLocation: 1, venueType: 1, indoorsOrOutdoors: 1, performanceStyle: 1 }
function renderSettings() {
  var v = $('#view'); v.innerHTML = ''
  v.appendChild(statsSeg([['fields', 'Event fields'], ['highlighting', 'Highlighting'], ['email', 'Email'], ['calendar', 'Calendar'], ['notifications', 'Notifications']], SET_TAB, function (t) { SET_TAB = t; SET_DRAFT = null; renderSettings() }))
  if (SET_TAB === 'calendar') return settingsCalendar(v)
  if (SET_TAB === 'notifications') return settingsNotifications(v)
  if (!SET_CFG) {
    v.appendChild(el('<div class="empty">Loading settings…</div>'))
    loadRawConfig().then(function (c) { SET_CFG = c; if (TAB === 'settings') renderSettings() }).catch(function (e) { toast(e.message || 'Could not load settings', 'err') })
    return
  }
  if (SET_TAB === 'highlighting') return settingsHighlighting(v)
  if (SET_TAB === 'email') return settingsEmail(v)
  settingsFields(v)
}
function setSaveBar(label, onSave) {
  var b = el('<button class="btn-gold" style="width:100%;margin-top:12px">' + esc(label) + '</button>')
  b.addEventListener('click', onSave)
  return b
}
function settingsFields(v) {
  if (!SET_DRAFT) SET_DRAFT = {
    labels: Object.assign({}, SET_CFG.eventFieldLabels || {}),
    hidden: (SET_CFG.eventFieldHidden || []).slice(), deleted: (SET_CFG.eventFieldDeleted || []).slice(),
    custom: (SET_CFG.customFields || []).map(function (f) { return { id: f.id, label: f.label } }), newLabel: '',
  }
  var d = SET_DRAFT
  var card = el('<div class="fin-card"><div class="pb-h" style="font-size:17px">Event detail fields</div><p class="fin-h" style="margin-bottom:10px">Rename, hide, delete, or add fields. Affects every project\'s Event details, here and on the Mac.</p></div>')
  EVENT_FIELD_DEFS.filter(function (f) { return d.deleted.indexOf(f[0]) < 0 }).forEach(function (f) {
    var shown = d.hidden.indexOf(f[0]) < 0
    var row = el('<div class="setf"><input class="field-input" placeholder="' + esc(f[1]) + '"><button class="setf-b' + (shown ? ' on' : '') + '">' + (shown ? 'Shown' : 'Hidden') + '</button>' +
      (ESSENTIAL_FIELDS[f[0]] ? '<span class="setf-core">Core</span>' : '<button class="setf-x" aria-label="Delete field">×</button>') + '</div>')
    var inp = row.querySelector('input'); inp.value = d.labels[f[0]] || ''
    inp.addEventListener('input', function () { d.labels[f[0]] = inp.value })
    row.querySelector('.setf-b').addEventListener('click', function () {
      var i = d.hidden.indexOf(f[0]); if (i >= 0) d.hidden.splice(i, 1); else d.hidden.push(f[0]); renderSettings()
    })
    var x = row.querySelector('.setf-x')
    if (x) x.addEventListener('click', function () { d.deleted.push(f[0]); renderSettings() })
    card.appendChild(row)
  })
  var removed = EVENT_FIELD_DEFS.filter(function (f) { return d.deleted.indexOf(f[0]) >= 0 })
  if (removed.length) {
    card.appendChild(el('<div class="fin-l" style="margin:12px 0 6px">Removed</div>'))
    removed.forEach(function (f) {
      var r = el('<div class="setf"><span class="wq">' + esc(f[1]) + '</span><button class="setf-b">Restore</button></div>')
      r.querySelector('button').addEventListener('click', function () { d.deleted = d.deleted.filter(function (x2) { return x2 !== f[0] }); renderSettings() })
      card.appendChild(r)
    })
  }
  card.appendChild(el('<div class="fin-l" style="margin:14px 0 6px">Custom fields</div>'))
  d.custom.forEach(function (cf, i) {
    var r = el('<div class="setf"><input class="field-input"><button class="setf-x" aria-label="Remove">×</button></div>')
    var inp = r.querySelector('input'); inp.value = cf.label
    inp.addEventListener('input', function () { cf.label = inp.value })
    r.querySelector('button').addEventListener('click', function () { d.custom.splice(i, 1); renderSettings() })
    card.appendChild(r)
  })
  var add = el('<div class="setf"><input class="field-input" placeholder="New field name"><button class="setf-b on">Add</button></div>')
  var ai = add.querySelector('input'); ai.value = d.newLabel
  ai.addEventListener('input', function () { d.newLabel = ai.value })
  add.querySelector('button').addEventListener('click', function () {
    var label = (d.newLabel || '').trim(); if (!label) return
    d.custom.push({ id: 'custom_' + Math.random().toString(36).slice(2, 9), label: label }); d.newLabel = ''; renderSettings()
  })
  card.appendChild(add)
  card.appendChild(el('<p class="fin-h">The values of custom fields still live on the Mac, so the phone shows their names only.</p>'))
  card.appendChild(setSaveBar('Save fields', function () {
    var labels = {}
    Object.keys(d.labels).forEach(function (k) { if (String(d.labels[k]).trim()) labels[k] = String(d.labels[k]).trim() })
    var custom = d.custom.filter(function (f) { return f.label.trim() }).map(function (f) { return { id: f.id, label: f.label.trim() } })
    var patch = { eventFieldLabels: labels, eventFieldHidden: d.hidden, eventFieldDeleted: d.deleted, customFields: custom }
    doWrite(saveConfigPatch(patch), 'Saved', function (merged) {
      SET_CFG = merged
      SNAP.eventFieldLabels = labels; SNAP.eventFieldHidden = d.hidden; SNAP.eventFieldDeleted = d.deleted; SNAP.customFields = custom
      SET_DRAFT = null; renderSettings()
    })
  }))
  v.appendChild(card)
}
function settingsHighlighting(v) {
  var opts = [['inquiry', 'Inquiry'], ['postcall', 'Post Call'], ['booked', 'Booked'], ['postshow', 'Post Show'], ['none', 'No highlight']]
  var def = function (u) { return u.role === 'first' ? 'inquiry' : u.role === 'booked' ? 'booked' : u.role === 'postshow' ? 'postshow' : 'postcall' }
  if (!SET_DRAFT) SET_DRAFT = Object.assign({}, SET_CFG.sectionHighlights || {})
  var card = el('<div class="fin-card"><div class="pb-h" style="font-size:17px">Project page highlighting</div><p class="fin-h" style="margin-bottom:10px">Which part of a project page lights up while the project sits in each pipeline category.</p></div>')
  ;(SNAP.structure.umbrellas || []).forEach(function (u) {
    var r = el('<div class="setf"><span class="wq">' + esc(u.label) + '</span><select class="field-input" style="max-width:150px"></select></div>')
    var sel = r.querySelector('select')
    opts.forEach(function (o) { sel.appendChild(el('<option value="' + o[0] + '">' + o[1] + '</option>')) })
    sel.value = SET_DRAFT[u.id] || def(u)
    sel.addEventListener('change', function () { SET_DRAFT[u.id] = sel.value })
    card.appendChild(r)
  })
  card.appendChild(setSaveBar('Save highlighting', function () {
    doWrite(saveConfigPatch({ sectionHighlights: SET_DRAFT }), 'Saved', function (merged) { SET_CFG = merged; SET_DRAFT = null; renderSettings() })
  }))
  v.appendChild(card)
}
function settingsEmail(v) {
  if (!SET_DRAFT) SET_DRAFT = { enabled: !!SET_CFG.signatureEnabled, html: String(SET_CFG.signatureHtml || '') }
  var d = SET_DRAFT
  var card = el('<div class="fin-card"><div class="pb-h" style="font-size:17px">Email signature</div><p class="fin-h" style="margin-bottom:10px">Added to the bottom of the emails you send from the CRM, on the phone and on the Mac.</p>' +
    '<label class="fin-check" style="color:var(--parchment);margin-bottom:10px"><input type="checkbox"> Append my signature</label>' +
    '<div class="sig-tools"><button data-c="bold"><b>B</b></button><button data-c="italic"><i>I</i></button><button data-c="underline"><u>U</u></button><button data-c="link">Link</button></div>' +
    '<div class="sig-edit" contenteditable="true"></div></div>')
  var cb = card.querySelector('input'); cb.checked = d.enabled
  cb.addEventListener('change', function () { d.enabled = cb.checked })
  var ed = card.querySelector('.sig-edit'); ed.innerHTML = d.html
  ed.addEventListener('input', function () { d.html = ed.innerHTML })
  card.querySelectorAll('.sig-tools button').forEach(function (b) {
    b.addEventListener('mousedown', function (e) { e.preventDefault() })
    b.addEventListener('click', function () {
      var c = b.getAttribute('data-c')
      if (c === 'link') { var u = prompt('Link address'); if (!u) return; if (!/^https?:|^mailto:|^tel:/i.test(u)) u = 'https://' + u; document.execCommand('createLink', false, u) }
      else document.execCommand(c)
      d.html = ed.innerHTML
    })
  })
  card.appendChild(setSaveBar('Save signature', function () {
    doWrite(saveConfigPatch({ signatureEnabled: d.enabled, signatureHtml: d.html }), d.enabled ? 'Saved. Your signature goes on emails you send.' : 'Saved. Signature is off.', function (merged) { SET_CFG = merged; SET_DRAFT = null; renderSettings() })
  }))
  v.appendChild(card)
}
function alertAgo(iso) {
  var t = Date.parse(iso); if (!isFinite(t)) return ''
  var mins = Math.max(0, Math.round((Date.now() - t) / 60000))
  if (mins < 1) return 'just now'
  if (mins < 60) return mins + ' min ago'
  var h = Math.round(mins / 60); if (h < 24) return h + ' hr ago'
  var dd = Math.round(h / 24); return dd + ' day' + (dd === 1 ? '' : 's') + ' ago'
}
function settingsCalendar(v) {
  if (!SET_ALERTS) {
    v.appendChild(el('<div class="empty">Loading calendar alerts…</div>'))
    Promise.all([
      sbCalendarAlertSettings(),
      phoneApi('alert-state').catch(function () { return { state: null } }),
    ]).then(function (r) { SET_ALERTS = r[0]; SET_ALERT_STATE = r[1].state; if (TAB === 'settings' && SET_TAB === 'calendar') renderSettings() })
      .catch(function (e) { toast(e.message || 'Could not load calendar alerts', 'err') })
    return
  }
  var st = SET_ALERT_STATE || {}
  var s2 = SET_ALERTS
  var cals = Object.keys(st.calendar_ids || {})
  var conn = el('<div class="fin-card"><div class="pb-h" style="font-size:17px">Google Calendar</div><p class="fin-h">The CRM puts your gigs on the Gigs calendar and timed tasks on Work. That sync runs from the Mac; the calendars the cloud can see are below.</p></div>')
  ;['Work', 'Gigs'].forEach(function (n) { conn.appendChild(el('<div class="setf"><span class="wq">' + n + '</span><span style="color:' + (cals.indexOf(n) >= 0 ? 'var(--green)' : 'var(--brass-bright)') + ';font-weight:600;font-size:12px">' + (cals.indexOf(n) >= 0 ? '✓ Found' : 'Not seen yet') + '</span></div>')) })
  v.appendChild(conn)

  var card = el('<div class="fin-card"><div class="pb-h" style="font-size:17px">Calendar alerts</div><p class="fin-h">Your phone gets a heads-up about your Google Calendar. This runs in the cloud every minute, so your laptop can be shut.</p></div>')
  var parts = []
  var lastRun = Date.parse(st.last_run_at || '')
  var stalled = isFinite(lastRun) && Date.now() - lastRun > 5 * 60000
  parts.push(st.last_run_at ? 'Checked ' + alertAgo(st.last_run_at) : 'Waiting for the first check')
  if (s2.digest_enabled) {
    if (st.last_digest_on === todayStr() && st.last_digest_at) parts.push('Morning schedule sent ' + new Date(st.last_digest_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }))
    else parts.push('Morning schedule goes out at ' + fmtTime(String(s2.digest_time || '').slice(0, 5)))
  }
  if (st.last_alert_at) parts.push('Last alert ' + alertAgo(st.last_alert_at))
  card.appendChild(el('<div class="tool-note" style="margin:10px 0"><span' + (stalled ? ' style="color:var(--red)"' : '') + '>' + esc(parts.join(' · ')) + (stalled ? '. The cloud check has stopped running.' : '') + '</span>' +
    (st.last_alert_text ? '<br><span class="faint">' + esc(st.last_alert_text) + '</span>' : '') +
    (st.fail_count > 0 && st.last_error ? '<br><span style="color:var(--red)">' + esc(st.fail_count === 1 ? 'The last check failed' : 'The last ' + st.fail_count + ' checks failed') + ': ' + esc(st.last_error) + '</span>' : '') + '</div>'))
  var change = function (patch) {
    Object.assign(s2, patch); Object.assign(SET_ALERT_PENDING, patch)
    clearTimeout(SET_ALERT_TIMER)
    SET_ALERT_TIMER = setTimeout(function () {
      var pend = SET_ALERT_PENDING; SET_ALERT_PENDING = {}
      doWrite(saveCalendarAlertSettings(pend), 'Saved')
    }, 600)
    renderSettings()
  }
  var block = function (title, blurb, key, fill) {
    var b = el('<div class="alert-block"><div class="ab-top"><div><b>' + esc(title) + '</b><p class="fin-h">' + esc(blurb) + '</p></div><label class="fin-check"><input type="checkbox"' + (s2[key] ? ' checked' : '') + '> ' + (s2[key] ? 'On' : 'Off') + '</label></div></div>')
    b.querySelector('input').addEventListener('change', function (e) { var o = {}; o[key] = e.target.checked; change(o) })
    if (s2[key]) { var inner = el('<div class="ab-in"></div>'); fill(inner); b.appendChild(inner) }
    card.appendChild(b)
  }
  var tick = function (box, label, on, onChange) {
    var t = el('<label class="fin-check" style="color:var(--parchment);display:flex;margin:6px 0"><input type="checkbox"' + (on ? ' checked' : '') + '> ' + esc(label) + '</label>')
    t.querySelector('input').addEventListener('change', function (e) { onChange(e.target.checked) })
    box.appendChild(t)
  }
  var toggleIn = function (list, item, on) { list = (list || []).filter(function (x) { return x !== item }); if (on) list.push(item); return list }
  block('New bookings and events', 'A heads-up when something new lands on your Work calendar.', 'new_event_enabled', function (box) {
    ;[['booking', 'TidyCal bookings'], ['invite', 'Invites from other people'], ['own', 'Events you add yourself']].forEach(function (k) {
      tick(box, k[1], (s2.new_event_kinds || []).indexOf(k[0]) >= 0, function (on) { change({ new_event_kinds: toggleIn(s2.new_event_kinds, k[0], on) }) })
    })
    box.appendChild(el('<p class="fin-h">You also hear when one of these is cancelled or moved. Tasks and gigs from the CRM keep their own reminders, and all-day events go in the morning schedule.</p>'))
  })
  block('Morning schedule', 'One message each morning with your day, in time order.', 'digest_enabled', function (box) {
    var t = el('<div class="setf"><span class="wq">Send at (Eastern time)</span><input type="time" class="field-input" style="max-width:130px"></div>')
    t.querySelector('input').value = String(s2.digest_time || '07:00').slice(0, 5)
    t.querySelector('input').addEventListener('change', function (e) { if (e.target.value) change({ digest_time: e.target.value }) })
    box.appendChild(t)
    var days = el('<div class="day-chips"></div>')
    ;['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach(function (dl, i) {
      var iso = i + 1, on = (s2.digest_days || []).indexOf(iso) >= 0
      var b = el('<button class="' + (on ? 'on' : '') + '">' + dl + '</button>')
      b.addEventListener('click', function () {
        if (on && (s2.digest_days || []).length === 1) { toast('Keep at least one day, or turn the morning schedule off.', 'err'); return }
        change({ digest_days: toggleIn(s2.digest_days, iso, !on).sort(function (a, c) { return a - c }) })
      })
      days.appendChild(b)
    })
    box.appendChild(days)
    var names = (cals.length ? cals : ['Work', 'Gigs']).concat(s2.digest_calendars || []).filter(function (x, i, a) { return a.indexOf(x) === i })
    names.forEach(function (n) {
      tick(box, n, (s2.digest_calendars || []).indexOf(n) >= 0, function (on) {
        if (!on && (s2.digest_calendars || []).length === 1) { toast('Keep at least one calendar, or turn the morning schedule off.', 'err'); renderSettings(); return }
        change({ digest_calendars: toggleIn(s2.digest_calendars, n, on) })
      })
    })
  })
  block('Before a meeting', 'A reminder shortly before each timed event on your Work calendar.', 'soon_enabled', function (box) {
    var r = el('<div class="setf"><span class="wq">Minutes before</span><select class="field-input" style="max-width:110px"></select></div>')
    var sel = r.querySelector('select')
    var choices = [5, 10, 15, 20, 30, 45, 60]
    if (choices.indexOf(Number(s2.soon_minutes)) < 0 && s2.soon_minutes) choices.push(Number(s2.soon_minutes))
    choices.sort(function (a, b) { return a - b }).forEach(function (m) { sel.appendChild(el('<option value="' + m + '">' + m + ' minutes</option>')) })
    sel.value = String(s2.soon_minutes || 15)
    sel.addEventListener('change', function () { change({ soon_minutes: Number(sel.value) }) })
    box.appendChild(r)
    tick(box, 'Skip events marked Free', !!s2.soon_skip_free, function (on) { change({ soon_skip_free: on }) })
  })
  v.appendChild(card)
}
function settingsNotifications(v) {
  var on = localStorage.getItem('mcrm_push') === '1'
  var card = el('<div class="fin-card"><div class="pb-h" style="font-size:17px">Notifications on this ' + (isNativeApp() ? 'phone' : 'device') + '</div>' +
    '<p class="fin-h">New inquiries, task reminders, proposal views and calendar alerts arrive here as notifications.</p>' +
    '<div class="setf" style="margin-top:10px"><span class="wq">Status</span><b style="color:' + (on ? 'var(--green)' : 'var(--brass-bright)') + '">' + (on ? 'On' : 'Not turned on here yet') + '</b></div></div>')
  var b = el('<button class="btn-gold" style="width:100%;margin-top:12px">' + (on ? 'Re-register this device' : 'Turn on notifications') + '</button>')
  b.addEventListener('click', function () { if (isNativeApp()) registerNativePush({ loud: true }); else enablePush() })
  card.appendChild(b)
  card.appendChild(el('<p class="fin-h" style="margin-top:10px">The Mac\'s own ntfy alerts are a separate switch on the Mac.</p>'))
  v.appendChild(card)
  if (widgetBridge()) v.appendChild(settingsWidgets())
}
// Home-screen widgets: whether they are connected, and a way to reconnect or cut them off. The key
// they use is read-only, but it does show task titles and client names, so it can be revoked here.
function settingsWidgets() {
  var wb = widgetBridge()
  var card = el('<div class="fin-card" style="margin-top:14px"><div class="pb-h" style="font-size:17px">Home-screen widgets</div>' +
    '<p class="fin-h">Tasks, gigs in the next 7 days, and unread client email. To add one, press and hold your home screen, tap Edit, then Add Widget, and choose Bloom CRM.</p>' +
    '<div class="setf" style="margin-top:10px"><span class="wq">Status</span><b class="wstat">Checking…</b></div></div>')
  var stat = card.querySelector('.wstat')
  wb.hasKey().then(function (r) {
    stat.textContent = r && r.has ? 'Connected' : 'Not connected'
    stat.style.color = r && r.has ? 'var(--green)' : 'var(--brass-bright)'
  }).catch(function () { stat.textContent = 'Unknown' })
  var row = el('<div class="addrow" style="margin-top:12px"><button class="btn-ghost">Disconnect</button><button class="btn-gold">Reconnect</button></div>')
  row.children[1].addEventListener('click', function () {
    connectWidgets(true).then(function (ok) { toast(ok ? 'Widgets connected' : 'Could not connect the widgets', ok ? undefined : 'err'); renderSettings() })
  })
  row.children[0].addEventListener('click', function () {
    if (!confirm('Disconnect the home-screen widgets?\n\nThey stop showing CRM data until you tap Reconnect.')) return
    doWrite(phoneApi('widget-revoke', {}).then(function () { return wb.clearKey() }), 'Widgets disconnected', function () { renderSettings() })
  })
  card.appendChild(row)
  return card
}


// ---------- Files (Library) ----------
//
// The Mac's Files page, on the phone (2026-10-23). The Mac keeps these documents in a folder on the
// MacBook (crm-files/), which the phone cannot reach, so the phone's copy lives in a PRIVATE Storage
// bucket, seeded with the Mac's three files on 2026-10-23. ⚠️ The Mac's Files page still reads its own
// folder, so a file added on one side does not appear on the other until the Mac is pointed at the
// bucket too (Michael's call; the Mac was deliberately left untouched).
var FILES = null
function fileSize(n) {
  n = Number(n) || 0
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB'
  return (n / 1024 / 1024).toFixed(1) + ' MB'
}
function openFileViewer(title, url, isPdf) {
  var sheet = el('<div class="sheet pdfsheet"><div class="sheet-card pdfcard"></div></div>')
  var card = sheet.querySelector('.sheet-card')
  var close = function () { sheet.remove() }
  var head = el('<div class="pdfhead"><span class="sheet-title" style="margin:0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span></div>')
  head.querySelector('.sheet-title').textContent = title
  var actions = el('<div style="display:flex;gap:8px;flex:none"></div>')
  var open = el('<a class="btn-ghost" style="padding:6px 12px" target="_blank">Open</a>'); open.href = url
  var done = el('<button class="btn-ghost" style="padding:6px 12px">Close</button>')
  done.addEventListener('click', close)
  actions.appendChild(open); actions.appendChild(done); head.appendChild(actions); card.appendChild(head)
  if (isPdf) { var frame = document.createElement('iframe'); frame.className = 'pdfframe'; frame.src = url; card.appendChild(frame) }
  else card.appendChild(el('<p class="fin-h" style="padding:20px">Tap Open to view this file.</p>'))
  sheet.addEventListener('click', function (e) { if (e.target === sheet) close() })
  document.body.appendChild(sheet)
}
function renderFiles() {
  var v = $('#view'); v.innerHTML = ''
  var up = el('<label class="fin-card files-up"><input type="file" multiple hidden><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg><b>Add files</b><span class="fin-h">Slide decks, PDFs, images, contracts. Up to 50 MB each.</span></label>')
  up.querySelector('input').addEventListener('change', function (e) {
    var files = [].slice.call(e.target.files || [])
    if (!files.length) return
    var tooBig = files.filter(function (f) { return f.size > 50 * 1024 * 1024 })
    if (tooBig.length) { toast(tooBig[0].name + ' is over 50 MB.', 'err'); return }
    toast('Uploading ' + files.length + ' file' + (files.length === 1 ? '' : 's') + '…')
    files.reduce(function (pr, f) { return pr.then(function () { return uploadFile(f) }) }, Promise.resolve())
      .then(function () { toast('Uploaded'); FILES = null; renderFiles() })
      .catch(function (err) { toast(err.message || 'Upload failed', 'err'); FILES = null; renderFiles() })
  })
  v.appendChild(up)
  if (!FILES) {
    v.appendChild(el('<div class="empty">Loading files…</div>'))
    listFiles().then(function (f) { FILES = f; if (TAB === 'files') renderFiles() }).catch(function (e) { toast(e.message || 'Could not load files', 'err') })
    return
  }
  if (!FILES.length) { v.appendChild(el('<div class="empty">No files yet.</div>')); return }
  var list = el('<div class="fin-card fin-list"></div>')
  FILES.forEach(function (f) {
    var ext = (f.name.split('.').pop() || '').toUpperCase().slice(0, 4)
    var when = f.updatedAt ? new Date(f.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''
    var row = el('<div class="fl-row"><span class="file-badge">' + esc(ext) + '</span><button class="fl-main file-open" style="text-align:left"><div class="fl-name">' + esc(f.name) + '</div><div class="fl-meta">' + esc(fileSize(f.size)) + (when ? ' · ' + esc(when) : '') + '</div></button>' +
      '<button class="taskdel" aria-label="Delete file"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button></div>')
    row.querySelector('.file-open').addEventListener('click', function () {
      fileUrl(f.name).then(function (u) { openFileViewer(f.name, u, /\.pdf$/i.test(f.name)) }).catch(function (e) { toast(e.message || 'Could not open', 'err') })
    })
    row.querySelector('.taskdel').addEventListener('click', function () {
      if (!confirm('Delete "' + f.name + '"? This removes it from the phone\'s Files.')) return
      doWrite(deleteFile(f.name), 'File deleted', function () { FILES = FILES.filter(function (x) { return x.name !== f.name }); renderFiles() })
    })
    list.appendChild(row)
  })
  v.appendChild(list)
}


// ---------- project page: parity with the Mac (2026-10-23) ----------
//
// Everything the Mac's project view does that the phone did not, each one a port of the named Mac
// component: event type (EventTypeSelect), the date-conflict flag (DateConflictFlag), Log a call
// (CallLogModal), the original inquiry (InitialInquiryModal), a calendar invite (CalendarInviteCard),
// the Booked-stage gates (GigTimesModal, DepositPaidModal), Post Show (tips, tip method, mileage),
// contact tagging when a client leaves the pipeline (ContactTagger), and an editable archive-reason
// list (ArchiveReasonModal). Same writes as the Mac, same activity-log wording.

// "18:30" -> "6:30 PM"; anything else is left exactly as typed. The Mac's to12h (src/format.ts).
function to12h(value) {
  var s2 = String(value || '').trim()
  var m = s2.match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return s2
  var h = parseInt(m[1], 10)
  if (h > 23) return s2
  var period = h >= 12 ? 'PM' : 'AM'
  h = h % 12; if (h === 0) h = 12
  return h + ':' + m[2] + ' ' + period
}
var TIME_FIELDS = { arrivalTime: 1, eventStartTime: 1, showStartTime: 1, leaveHomeTime: 1, backHomeTime: 1 }

function eventTypePill(type) {
  var t = type || 'Other'
  var c = EVENT_TYPE_COLOR[t] || '#858d97'
  return '<span class="etype" style="color:' + c + ';border-color:color-mix(in oklab,' + c + ' 40%, var(--line));background:color-mix(in oklab,' + c + ' 10%, transparent)">' + esc(t) + '</span>'
}

// A small sheet with a title, a scrolling body and a close button: the shape every new sheet uses.
function makeSheet(title, tall) {
  var sheet = el('<div class="sheet"><div class="sheet-card' + (tall ? ' sheet-tall' : '') + '"><div class="sheet-head"><div class="sheet-title"></div>' +
    '<button class="sheet-x" aria-label="Close"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button></div>' +
    '<div class="sheet-body"></div></div></div>')
  sheet.querySelector('.sheet-title').textContent = title
  var close = function () { sheet.remove() }
  sheet.querySelector('.sheet-x').addEventListener('click', close)
  sheet.addEventListener('click', function (e) { if (e.target === sheet) close() })
  document.body.appendChild(sheet)
  return { sheet: sheet, body: sheet.querySelector('.sheet-body'), close: close }
}

function openEventTypeSheet(p) {
  var sh = makeSheet('Event type')
  EVENT_TYPES.forEach(function (t) {
    var on = (p.eventType || '') === t
    var row = el('<button class="actrow' + (on ? ' on' : '') + '"><span class="ar-l">' + eventTypePill(t) + '</span>' + (on ? '<span class="ar-v">Current</span>' : '') + '</button>')
    row.addEventListener('click', function () {
      if (on) { sh.close(); return }
      doWrite(updateProjectField(p.id, 'eventType', t), 'Saved', function (r) { p.eventType = r.value; sh.close(); renderDetail(p.id, true) })
    })
    sh.body.appendChild(row)
  })
}

// ---- the date-conflict flag ----
// Same rule as the Mac (App.tsx): another live project on the same date, or anything on the Google
// Gigs calendar that day, and a date only counts when at least one project on it is still active.
function conflictsFor(p) {
  if (!p.eventDate || !/^\d{4}-\d{2}-\d{2}$/.test(p.eventDate) || (p.bucket !== 'active' && p.bucket !== 'completed')) return []
  var same = (SNAP.projects || []).filter(function (x) { return x.id !== p.id && x.eventDate === p.eventDate && (x.bucket === 'active' || x.bucket === 'completed') })
  var gigs = []
  var cache = CAL_EVENTS[p.eventDate.slice(0, 7)]
  if (cache && cache !== 'loading') gigs = (cache.events || []).filter(function (e) { return e.calendar === 'Gigs' && e.date === p.eventDate })
  if (!gigs.length && !same.some(function (x) { return x.bucket === 'active' }) && p.bucket !== 'active') return []
  return same.map(function (x) { return x.client }).concat(gigs.map(function (e) { return e.title + ' (Gigs calendar)' }))
}
// Make sure the Gigs calendar for this project's month is loaded, then repaint once it lands.
function ensureConflictMonth(p) {
  if (!p.eventDate || !/^\d{4}-\d{2}/.test(p.eventDate)) return
  var key = p.eventDate.slice(0, 7)
  if (CAL_EVENTS[key]) return
  loadCalMonth({ y: Number(key.slice(0, 4)), m: Number(key.slice(5, 7)) - 1 })
  var tries = 0
  var wait = setInterval(function () {
    tries++
    var c = CAL_EVENTS[key]
    if ((c && c !== 'loading') || tries > 40) {
      clearInterval(wait)
      if (c && c !== 'loading' && DETAIL_ID === p.id && conflictsFor(p).length) renderDetail(p.id, true)
    }
  }, 250)
}

// ---- Log a call ----
// The Mac's CallLogModal: did they answer; if not, was a voicemail left; if so, an optional note.
// Same three log lines as logCall() in crm-data-core.mjs.
function openLogCallSheet(p) {
  var sh = makeSheet('Log a call')
  var log = function (detail) {
    doWrite(addNote(p.id, 'Made a call. ' + detail), 'Call logged', function (r) { p.activityLog = r.activityLog; sh.close(); renderDetail(p.id, true) })
  }
  function step1() {
    sh.body.innerHTML = ''
    sh.body.appendChild(el('<p class="call-q">Did they answer?</p>'))
    var row = el('<div class="addrow"><button class="btn-ghost">No</button><button class="btn-gold">Yes</button></div>')
    row.children[0].addEventListener('click', stepNo)
    row.children[1].addEventListener('click', stepYes)
    sh.body.appendChild(row)
  }
  function stepNo() {
    sh.body.innerHTML = ''
    sh.body.appendChild(el('<p class="call-q">Left a voicemail?</p>'))
    var row = el('<div class="addrow"><button class="btn-ghost">No</button><button class="btn-gold">Yes</button></div>')
    row.children[0].addEventListener('click', function () { log('No answer, no voicemail left.') })
    row.children[1].addEventListener('click', function () { log('No answer, left a voicemail.') })
    sh.body.appendChild(row)
  }
  function stepYes() {
    sh.body.innerHTML = ''
    sh.body.appendChild(el('<p class="call-q">What did you talk about? (optional)</p>'))
    var ta = document.createElement('textarea'); ta.className = 'field-input'; ta.rows = 4
    sh.body.appendChild(ta)
    var row = el('<div class="addrow" style="margin-top:10px"><button class="btn-ghost">Skip</button><button class="btn-gold">Save note</button></div>')
    row.children[0].addEventListener('click', function () { log('They answered.') })
    row.children[1].addEventListener('click', function () { var n = ta.value.trim(); log('They answered.' + (n ? ' Talked about: ' + n : '')) })
    sh.body.appendChild(row)
    setTimeout(function () { ta.focus() }, 30)
  }
  step1()
}

// ---- the original inquiry ----
// The Mac's InitialInquiryModal: their message (editable), buttons back to the gig site the lead came
// from, and the website form exactly as they filled it in.
function openInitialInquirySheet(p) {
  var sh = makeSheet('Initial inquiry', true)
  sh.body.appendChild(el('<div class="fld-l">Their message</div>'))
  var ta = document.createElement('textarea'); ta.className = 'field-input'; ta.rows = 9; ta.value = p.initialInquiry || ''
  ta.placeholder = 'What they first sent, if anything was saved.'
  sh.body.appendChild(ta)
  var cur = p.initialInquiry || ''
  ta.addEventListener('blur', function () {
    if (ta.value === cur) return
    doWrite(updateProjectField(p.id, 'initialInquiry', ta.value), 'Saved', function (r) { p.initialInquiry = r.value; cur = r.value })
  })
  var links = el('<div class="inq-links"></div>')
  var urls = String(p.initialInquiry || '').match(/https?:\/\/[^\s)]+/g) || []
  urls.forEach(function (u) {
    var site = /gigsalad/i.test(u) ? 'GigSalad' : /thebash/i.test(u) ? 'The Bash' : /bark\.com/i.test(u) ? 'Bark' : ''
    if (!site) return
    var b = el('<button class="btn-ghost">Open this lead on ' + site + ' ↗</button>')
    b.addEventListener('click', function () { window.open(u, '_blank') })
    links.appendChild(b)
  })
  if (links.children.length) sh.body.appendChild(links)
  var formBox = el('<div><div class="empty" style="padding:14px 4px;text-align:left">Looking for a website form…</div></div>')
  sh.body.appendChild(formBox)
  loadInquiryForm(p.id).then(function (f) {
    formBox.innerHTML = ''
    if (!f || !f.fields.length) { formBox.appendChild(el('<p class="fin-h" style="margin-top:14px">No website form on file for this project.</p>')); return }
    formBox.appendChild(el('<div class="fld-l" style="margin-top:16px">Website form' + (f.submittedAt ? ' · ' + esc(new Date(f.submittedAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })) : '') + '</div>'))
    var kv = el('<div class="inq-kv"></div>')
    f.fields.forEach(function (x) { kv.appendChild(el('<div><span>' + esc(x.label) + '</span><b>' + esc(x.key === 'eventTime' ? to12h(x.value) : x.value) + '</b></div>')) })
    formBox.appendChild(kv)
  }).catch(function () { formBox.innerHTML = '<p class="fin-h">Could not load the website form.</p>' })
}

// ---- calendar invite ----
// The Mac's CalendarInviteCard: a Google Calendar invite on the Work calendar, emailed to whoever is
// listed. Sent from the cloud (phone-api calendar-invite), so the Mac can be off.
function openCalendarInviteSheet(p) {
  var sh = makeSheet('Calendar invite', true)
  var emails = []
  projectContactCards(p).forEach(function (c) { c.emails.forEach(function (e) { if (emails.indexOf(e) < 0) emails.push(e) }) })
  var f = el('<div class="fin-form">' +
    '<label>Title<input class="field-input" id="ci-title"></label>' +
    '<label>Date<input type="date" class="field-input" id="ci-date"></label>' +
    '<label class="fin-check" style="text-transform:none;letter-spacing:0;font-weight:500;color:var(--parchment)"><input type="checkbox" id="ci-allday"> All day</label>' +
    '<div class="ff-row" id="ci-timerow"><label>Start<input type="time" class="field-input" id="ci-start"></label><label>Length<select class="field-input" id="ci-dur"><option value="15">15 min</option><option value="30" selected>30 min</option><option value="45">45 min</option><option value="60">1 hour</option><option value="90">90 min</option></select></label></div>' +
    '<label>Invite (emails, comma separated)<textarea class="field-input" id="ci-who" rows="2"></textarea></label><p class="fin-h" id="ci-count"></p>' +
    '<label>Location (optional)<input class="field-input" id="ci-loc"></label>' +
    '<label>Notes (optional)<textarea class="field-input" id="ci-notes" rows="3"></textarea></label>' +
    '<button class="btn-gold" id="ci-send" style="width:100%;margin-top:6px">Send invite</button></div>')
  f.querySelector('#ci-title').value = 'Call with Michael Bloemeke'
  f.querySelector('#ci-date').value = /^\d{4}-\d{2}-\d{2}$/.test(p.eventDate || '') ? p.eventDate : todayStr()
  f.querySelector('#ci-start').value = '12:00'
  f.querySelector('#ci-who').value = emails.join(', ')
  var allDay = f.querySelector('#ci-allday')
  allDay.addEventListener('change', function () { f.querySelector('#ci-timerow').style.display = allDay.checked ? 'none' : '' })
  var who = f.querySelector('#ci-who'), count = f.querySelector('#ci-count')
  var parse = function () { return who.value.split(/[,;\s]+/).map(function (x) { return x.trim() }).filter(function (x) { return /.+@.+\..+/.test(x) }) }
  var sync = function () { var n = parse().length; count.textContent = n ? n + ' valid email' + (n === 1 ? '' : 's') + '. They get the invite by email.' : 'No valid emails yet. The event will only go on your Work calendar.' }
  who.addEventListener('input', sync); sync()
  f.querySelector('#ci-send').addEventListener('click', function () {
    var btn = f.querySelector('#ci-send'); btn.disabled = true; btn.textContent = 'Sending…'
    var start = f.querySelector('#ci-start').value
    doWrite(phoneApi('calendar-invite', {
      projectId: p.id, summary: f.querySelector('#ci-title').value, date: f.querySelector('#ci-date').value, allDay: allDay.checked,
      startTime: allDay.checked ? '' : to12h(start), durationMin: Number(f.querySelector('#ci-dur').value), attendees: parse(),
      location: f.querySelector('#ci-loc').value, description: f.querySelector('#ci-notes').value,
    }), 'Invite sent', function () {
      sh.close()
      addNoteLocalRefresh(p)
    }).catch(function () { btn.disabled = false; btn.textContent = 'Send invite' })
  })
  sh.body.appendChild(f)
}
// The server wrote an activity-log line; pull the project's log so the Notes tab shows it.
function addNoteLocalRefresh(p) {
  reloadProjectLog(p.id).then(function (log) { if (log) { p.activityLog = log; if (DETAIL_ID === p.id) renderDetail(p.id, true) } }).catch(function () {})
}

// ---- the Booked-stage gates ----
// Moving into a Booked stage on the Mac asks for Leave home / Back home first (GigTimesModal), then a
// received payment (DepositPaidModal), then moves. Same order here, each step a sheet that fixes the
// blocker in place instead of an error toast that sends him somewhere else to fix it.
function moveToStage(p, stage, after) {
  var booked = stageSetForRole('booked')
  var doMove = function () {
    doWrite(setStage(p.id, stage.id, SNAP.structure, SNAP.payments || []), 'Moved to ' + stage.name, function () {
      p.stageId = stage.id
      if (after) after()
      renderDetail(p.id, true)
    }).catch(function () {})
  }
  if (!booked[stage.id]) return doMove()
  var gatePayment = function () {
    if (receivedFor(p.id) > 0) return doMove()
    openDepositSheet(p, doMove)
  }
  if (!String(p.leaveHomeTime || '').trim() || !String(p.backHomeTime || '').trim()) openGigTimesSheet(p, gatePayment)
  else gatePayment()
}
function openGigTimesSheet(p, then) {
  var sh = makeSheet('Gig times')
  sh.body.appendChild(el('<p class="fin-h" style="margin:0 0 10px">When you leave the house and when you will be back. They block the calendar for the whole trip, not just the show.</p>'))
  var f = el('<div class="fin-form"><div class="ff-row"><label>Leave home<input class="field-input" id="gt-leave" placeholder="e.g. 3:45 PM"></label><label>Back home<input class="field-input" id="gt-back" placeholder="e.g. 9:30 PM"></label></div>' +
    '<button class="btn-gold" style="width:100%;margin-top:8px">Save and continue</button></div>')
  var lv = f.querySelector('#gt-leave'), bk = f.querySelector('#gt-back')
  lv.value = p.leaveHomeTime || ''; bk.value = p.backHomeTime || ''
  ;[lv, bk].forEach(function (i) { i.addEventListener('blur', function () { i.value = to12h(i.value) }) })
  f.querySelector('button').addEventListener('click', function () {
    var a = to12h(lv.value), b = to12h(bk.value)
    if (!a || !b) { toast('Add both times first.', 'err'); return }
    Promise.all([updateProjectField(p.id, 'leaveHomeTime', a), updateProjectField(p.id, 'backHomeTime', b)])
      .then(function () { p.leaveHomeTime = a; p.backHomeTime = b; sh.close(); then() })
      .catch(function (e) { toast(e.message || 'Could not save', 'err') })
  })
  sh.body.appendChild(f)
}
function openDepositSheet(p, then) {
  var sh = makeSheet('Log the deposit', true)
  sh.body.appendChild(el('<p class="fin-h" style="margin:0 0 10px">A Booked stage needs a received payment. Log it here and the move goes through.</p>'))
  var listBox = el('<div></div>')
  var go = el('<button class="btn-gold" style="width:100%;margin-top:12px">Mark deposit paid</button>')
  var draw = function () {
    listBox.innerHTML = ''
    var recv = receivedFor(p.id)
    listBox.appendChild(el('<p class="fin-h">' + (recv > 0 ? 'Received so far: <b>' + esc(money(recv)) + '</b>' : 'No received payment yet.') + '</p>'))
    go.disabled = !(recv > 0); go.style.opacity = go.disabled ? 0.45 : 1
  }
  sh.body.appendChild(listBox)
  sh.body.appendChild(addPaymentForm(p, draw))
  go.addEventListener('click', function () { if (go.disabled) return; sh.close(); then() })
  sh.body.appendChild(go)
  draw()
}

// ---- Post Show ----
// The Mac's Post Show section: tips (with arithmetic, "40+20"), how the tip came in, and the
// round-trip mileage that feeds the Finance page's mileage figures.
function postShowSection(p) {
  var wrap = el('<div class="fin-card ps-card"><div class="fin-cap">Post show</div><div class="ff-row"><label class="ps-f">Tips<input class="field-input" id="ps-tips" inputmode="decimal" placeholder="$ Add…"></label>' +
    '<label class="ps-f">Via<select class="field-input" id="ps-via"></select></label></div>' +
    '<label class="ps-f">Mileage (round-trip mi)<input class="field-input" id="ps-miles" placeholder="Add… (e.g. 42+42)"></label></div>')
  var tips = wrap.querySelector('#ps-tips'), via = wrap.querySelector('#ps-via'), miles = wrap.querySelector('#ps-miles')
  TIP_METHODS.forEach(function (m) { via.appendChild(el('<option>' + esc(m) + '</option>')) })
  tips.value = p.tips == null ? '' : String(p.tips)
  via.value = p.tipsMethod || 'Cash'
  miles.value = p.mileage == null ? '' : String(p.mileage)
  var saveNum = function (input, key) {
    input.addEventListener('blur', function () {
      input.value = evalNumberFormula(input.value)
      var cur = p[key] == null ? '' : String(p[key])
      if (input.value === cur) return
      doWrite(updateProjectField(p.id, key, input.value), 'Saved', function (r) { p[key] = r.value; input.value = r.value == null ? '' : String(r.value) })
        .catch(function () { input.value = cur })
    })
  }
  saveNum(tips, 'tips'); saveNum(miles, 'mileage')
  via.addEventListener('change', function () { doWrite(updateProjectField(p.id, 'tipsMethod', via.value), 'Saved', function (r) { p.tipsMethod = r.value }) })
  return wrap
}

// ---- contact tagging as a client leaves the pipeline (the Mac's ContactTagger) ----
function contactTagger(p) {
  var box = el('<div class="tagger"></div>')
  var cards = projectContactCards(p).filter(function (c) { return c.contact })
  if (!cards.length) return box
  box.appendChild(el('<div class="fld-l" style="margin-top:14px">Contacts on this project</div>'))
  box.appendChild(el('<p class="fin-h" style="margin:-2px 0 8px">Active means in the pipeline now. Yes / Maybe / No is the lasting call once they have left it.</p>'))
  cards.forEach(function (row) {
    var c = row.contact
    var item = el('<div class="tag-item"><b>' + esc(c.name || '(no name)') + '</b><div class="relrow" style="margin-top:6px"></div></div>')
    var rr = item.querySelector('.relrow')
    var paint = function () {
      rr.innerHTML = ''
      CONTACT_REL.forEach(function (r) {
        var on = c.relationship === r.v
        var b = el('<button class="relchip' + (on ? ' on' : '') + '"' + (on ? ' style="background:' + r.color + '"' : '') + '>' + r.label + '</button>')
        b.addEventListener('click', function () {
          var next = on ? '' : r.v
          doWrite(updateContact(c.id, { relationship: next }), null, function () { c.relationship = next; paint() })
        })
        rr.appendChild(b)
      })
    }
    paint()
    item.appendChild(tagEditor(c))
    box.appendChild(item)
  })
  return box
}

// Tag chips with a remove ×, an add box, and reuse suggestions from the shared tag library
// (crm_config.contactTags plus every tag already in use), the Mac's TagEditor.
function tagEditor(c) {
  var wrap = el('<div class="tagedit"></div>')
  var known = function () {
    var lib = ((SET_CFG && SET_CFG.contactTags) || (SNAP.config && SNAP.config.contactTags) || []).slice()
    ;(SNAP.contacts || []).forEach(function (x) { (x.tags || []).forEach(function (t) { if (lib.indexOf(t) < 0) lib.push(t) }) })
    return lib
  }
  var save = function (tags) { doWrite(updateContact(c.id, { tags: tags }), null, function () { c.tags = tags; draw() }) }
  var draw = function () {
    wrap.innerHTML = ''
    var chips = el('<div class="tagchips"></div>')
    ;(c.tags || []).forEach(function (t) {
      var ch = el('<span class="tagchip">' + esc(t) + '<button aria-label="Remove tag">×</button></span>')
      ch.querySelector('button').addEventListener('click', function () { save((c.tags || []).filter(function (x) { return x !== t })) })
      chips.appendChild(ch)
    })
    var inp = el('<input class="field-input tagin" placeholder="+ tag">')
    var commit = function () {
      var t = inp.value.trim(); if (!t) return
      if ((c.tags || []).indexOf(t) >= 0) { inp.value = ''; return }
      save((c.tags || []).concat([t]))
      var lib = known()
      if (lib.indexOf(t) < 0) saveConfigPatch({ contactTags: ((SNAP.config && SNAP.config.contactTags) || []).concat([t]) }).then(function (m) { if (SNAP.config) SNAP.config.contactTags = m.contactTags }).catch(function () {})
    }
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); commit() } })
    inp.addEventListener('blur', commit)
    chips.appendChild(inp)
    wrap.appendChild(chips)
    var sugg = known().filter(function (t) { return (c.tags || []).indexOf(t) < 0 }).slice(0, 12)
    if (sugg.length) {
      var sg = el('<div class="tagsugg"><span class="faint">Reuse:</span></div>')
      sugg.forEach(function (t) {
        var b = el('<button>' + esc(t) + '</button>')
        b.addEventListener('mousedown', function (e) { e.preventDefault() })
        b.addEventListener('click', function () { save((c.tags || []).concat([t])) })
        sg.appendChild(b)
      })
      wrap.appendChild(sg)
    }
  }
  draw()
  return wrap
}

// ---------- the Playbook (Library) ----------
//
// ⚠️ A MIRROR OF src/components/PlaybookPage.tsx ON THE MAC. Same words, same order, same three
// timelines, ported 2026-10-23 when Michael asked for the phone to have everything the Mac has. When
// the Mac page changes, change this too. It is a reading surface, not a workflow: no buttons, no
// writes. The source and authority notes live in the Mac file.
var PB_ACTOR = { You: '#2563eb', Them: '#64748b', Automatic: '#0e7490' }
var PB_BOOKED = [
  { when: 'Day 0', action: { title: 'They fill in the form', by: 'Them', detail: 'The thank-you page they land on IS the calendar.' },
    email: { title: 'Thanks for reaching out', by: 'Automatic', detail: 'Fires off the form, but from YOUR address and written as though you typed it. What happens next, how to grab a slot, promo video and reviews.' } },
  { when: 'Day 0, minutes later', action: { title: 'They book a slot', by: 'Them', detail: 'Only the next three days are offered.' },
    email: { title: 'Booking confirmation', by: 'Automatic', seenAs: 'Calendar', detail: 'This is the calendar invite itself, set up in TidyCal (2026-10-15): who it is with, the date and time, the number you call, the promo video link, and a reschedule link. Written about you, not from you.' } },
  { when: '24 hours before', email: { title: 'Call reminder', by: 'Automatic', seenAs: 'Calendar', detail: 'TidyCal sends ONE message for both reminders: the date and time, the number you call, the promo video, and the reviews.' } },
  { when: '1 hour before', email: { title: 'Call reminder', by: 'Automatic', seenAs: 'Calendar', detail: 'The same message as the day before.' } },
  { when: 'The call', action: { title: 'Sales call', by: 'You', detail: 'Book the follow-up before you hang up, on your hidden Follow-Up Call page in TidyCal (Booking types, then the open-in-new-tab icon), with their name and email. Get the name of the person they run it by.' } },
  { when: 'Within the hour', email: { title: 'The proposal page', by: 'You', detail: 'The event as discussed, the price you quoted, videos, reviews, the case study, and the follow-up date restated.' } },
  { when: '48 hours before the follow-up', email: { title: 'The testimonial bump', by: 'You', detail: 'One review that matches their event. Name the person they run it by, and restate the follow-up time at the close.' } },
  { when: '24 hours before', email: { title: 'Follow-up reminder', by: 'Automatic', seenAs: 'Calendar', detail: 'Same flavour, for the Follow-Up Call: the date and time, a reply-with-questions line, and the reviews.' } },
  { when: '1 hour before', email: { title: 'Follow-up reminder', by: 'Automatic', seenAs: 'Calendar', detail: 'The same message as the day before.' } },
  { when: 'The follow-up', action: { title: 'Follow-up call', by: 'You', detail: 'If they already said yes, keep it and run it as onboarding.' } },
]
var PB_NOT_BOOKED = [
  { when: 'Day 0', action: { title: 'Call, twice in a row', by: 'You', detail: 'Two calls back to back signals a real person rather than a scam.' },
    email: { title: 'Sorry you did not book a call', by: 'You', detail: 'A link straight back to the calendar.' } },
  { when: 'Day 1', action: { title: 'Call, voicemail, text', by: 'You', detail: 'Name the next attempt out loud: "I will try again tomorrow at this time."' },
    email: { title: 'People always ask about reviews', by: 'You', detail: 'A link to the reviews, and the calendar again.' } },
  { when: 'Day 2', action: { title: 'Call', by: 'You' }, email: { title: 'Reply and I will send you a link', by: 'You', detail: 'Short, and expecting a reply.' } },
  { when: 'Day 3', action: { title: 'Call', by: 'You' }, email: { title: 'The breakup', by: 'You', detail: 'Then the no or maybe pile.' } },
]
var PB_GONE_QUIET = [
  { when: '48 hours after', email: { title: 'A, B, C, D, E', by: 'You', detail: 'Reply with one letter. Customise the joke option to their actual event.' } },
  { when: 'Next day', email: { title: 'Who You Gonna Call?', by: 'You', detail: 'The Ghostbusters gag. This one pulls the most replies.' } },
  { when: 'Next day', email: { title: 'You Made A Great Call', by: 'You', detail: 'Written as their future self, after the event.' } },
  { when: 'Next day', email: { title: 'Is Everything Okay?', by: 'You', detail: '"I am starting to get worried. Were you eaten by a shark?" That is the whole body.' } },
  { when: 'Next day', email: { title: 'You Win', by: 'You', detail: '"You are the all-time champion of hide and seek."' } },
  { when: 'Next day', email: { title: 'It is Not You, It is Me', by: 'You', detail: 'The breakup. One more week, then archive.' } },
]
function pbPill(by) {
  return '<span class="pb-pill" style="color:' + PB_ACTOR[by] + ';border-color:color-mix(in oklab,' + PB_ACTOR[by] + ' 40%, var(--line))">' + esc(by) + '</span>'
}
function pbTimeline(moments) {
  var track = el('<div class="pb-track"></div>')
  moments.forEach(function (m) {
    var col = el('<div class="pb-col"></div>')
    var above = el('<div class="pb-above"></div>')
    if (m.action) above.appendChild(el('<div class="pb-blk"><div class="pb-bh"><b>' + esc(m.action.title) + '</b>' + pbPill(m.action.by) + '</div>' + (m.action.detail ? '<p>' + esc(m.action.detail) + '</p>' : '') + '</div>'))
    col.appendChild(above)
    var dot = m.email ? PB_ACTOR[m.email.by] : m.action ? PB_ACTOR[m.action.by] : 'var(--line-strong)'
    col.appendChild(el('<div class="pb-rail"><span class="pb-dot" style="background:' + dot + '"></span><span class="pb-when">' + esc(m.when) + '</span></div>'))
    var below = el('<div class="pb-below"></div>')
    if (m.email) below.appendChild(el('<div class="pb-blk' + (m.email.seenAs === 'Calendar' ? ' pb-cal' : '') + '"><div class="pb-bh"><b>' + esc(m.email.title) + '</b>' + pbPill(m.email.by) + '</div>' +
      (m.email.detail ? '<p>' + esc(m.email.detail) + '</p>' : '') + (m.email.seenAs === 'Calendar' ? '<p class="pb-calnote">They see this as calendar mail</p>' : '') + '</div>'))
    col.appendChild(below)
    track.appendChild(col)
  })
  var wrap = el('<div class="pb-scroll"></div>'); wrap.appendChild(track)
  return wrap
}
function pbSection(title, blurb) {
  var sec = el('<section class="pb-card"><h3 class="pb-h">' + esc(title) + '</h3>' + (blurb ? '<p class="pb-blurb">' + esc(blurb) + '</p>' : '') + '</section>')
  return sec
}
function pbGrid(items) {
  var g = el('<div class="pb-grid"></div>')
  items.forEach(function (it) { g.appendChild(el('<div class="pb-tile"><b>' + esc(it[0]) + '</b><p>' + esc(it[1]) + '</p></div>')) })
  return g
}
function renderPlaybook() {
  var v = $('#view'); v.innerHTML = ''
  var first = el('<section class="pb-card"><h2 class="pb-h pb-h1">Your business is a doctor\'s office</h2>' +
    '<p class="pb-blurb">That one idea is underneath the whole process. Nobody rings a doctor to say they are thinking about coming in about their foot. They book an appointment.</p>' +
    '<p class="pb-quote">"If it\'s not an official business, it\'s just some guy that does magic tricks, then I feel weird for pestering you, and I also feel weird for dropping you. But now both make sense. It\'s an official thing. Let me even annoy you because this is a business, and I want to know the answer. Or if you\'re not going to answer, okay, great. You\'re not a real client. I\'m dropping you."</p>' +
    '<p class="pb-src">Your own words, on Jonah\'s visit, 2026-09-03.</p></section>')
  v.appendChild(first)

  var bam = pbSection('BAM FAM, in one line', 'Book A Meeting From A Meeting. You never leave a call without the next one in the calendar, and you book it every single time, not just when the deal feels shaky.')
  bam.appendChild(pbGrid([
    ['Say it as a walkthrough, not a check-in', '"Let me put it all together in a proposal, and in three days let\'s go through it together. If there are any other decision makers, I would love to be there with them." The follow-up is a walkthrough of a document that does not exist yet, which is why it never feels like pestering.'],
    ['Never ask a yes/no question', '"So that you don\'t have to follow up with me endlessly, let\'s schedule a call after you\'ve spoken with them. Is this a chat later tonight kind of thing, or a later this week kind of thing?" Always A or B. Ask yes or no and you get a no.'],
    ['Book it close', 'Two or three days out, never two weeks. A tight gap is what keeps the number of follow-up emails down, which is the opposite of how it feels.'],
  ]))
  bam.appendChild(el('<p class="pb-src" style="margin-top:12px">It works even when the call never happens. Around thirty percent do not, and almost all of those people send an answer before cancelling. The date is a goalpost, not a meeting.</p>'))
  v.appendChild(bam)

  var booked = pbSection('The timeline, when they book', 'Ten moments from form fill to the follow-up call. Eight emails go out. Three read as coming from you and five read as calendar mail, and once this is set up you only send two of the eight by hand. Scroll sideways.')
  booked.appendChild(el('<div class="pb-legend">' +
    '<span><i style="background:' + PB_ACTOR.You + '"></i>You send it or you do it</span>' +
    '<span><i style="background:' + PB_ACTOR.Automatic + '"></i>The scheduler sends it</span>' +
    '<span><i style="background:' + PB_ACTOR.Them + '"></i>They do it</span>' +
    '<span class="pb-legend-note">Above the line, what happens. Below the line, the email that goes out.</span>' +
    '<span><i class="pb-legend-cal"></i>Blue means the client reads it as coming from the calendar, not from you</span></div>'))
  booked.appendChild(pbTimeline(PB_BOOKED))
  v.appendChild(booked)

  var nb = pbSection('When they do not book a slot', 'This used to be the default path. Once the calendar is on the thank-you page it becomes the exception, and it is a phone sequence with an email attached to each call. Every one of these emails links back to the same calendar page.')
  nb.appendChild(pbTimeline(PB_NOT_BOOKED))
  v.appendChild(nb)

  var gq = pbSection('When they go quiet after the call', 'One a day, in this order. The copy for all five Ghostbusters is already written, in Library/reference/ghostbuster-emails.txt. Two buckets only: valuable, or funny. A follow-up that is neither does not get sent.')
  gq.appendChild(pbTimeline(PB_GONE_QUIET))
  v.appendChild(gq)

  var rules = pbSection('Rules that apply to every email in the run')
  rules.appendChild(pbGrid([
    ['SPEAR', 'Short, personal, and expecting a reply. That last part is how you get answers rather than reads.'],
    ['The signature', 'The promo video and the reviews go in every single email. Jonah calls it a signature for a reason.'],
    ['Never naggy', '"Do you have any questions?" is dead. If they had questions they would have asked them. Send something useful or something funny.'],
    ['No fake scarcity', 'Only say the date is filling up if it actually is. Check the calendar first.'],
    ['Never guilt', 'Guilt has never moved anybody to action in a business setting. Not once.'],
    ['Make the no easy', 'A fast no is worth more than a slow maybe. It gets a dead lead out of the pipeline.'],
  ]))
  v.appendChild(rules)

  var ex = pbSection('The exceptions worth remembering')
  ex.appendChild(pbGrid([
    ['Weddings', 'They are booking a year and a half out and they will think about it forever. Run the same play, but get the couple together: "I would hate for you to say this is the thing you want, and then somebody else books it, because there are only so many Saturdays in December."'],
    ['Private events should be easier than corporate', 'They are usually booking two or three weeks out and there is no committee to consult.'],
    ['Sometimes the right call is no follow-up call at all', 'Karl Richardson, 2026-08-21: mid-decision with his wife, had asked to be pinged, and already apologising for being slow. A formal appointment would have added pressure. You left it open and set yourself a text instead. That judgement was right and the default should not override it.'],
    ['When they refuse the follow-up call', 'Do not fight it and do not chase. Send the proposal page and let them book off it if they want to.'],
  ]))
  v.appendChild(ex)

  v.appendChild(el('<section class="pb-card pb-foot"><p class="pb-blurb" style="margin:0">Sourced from Jonah Babins\'s visit, 3 to 5 September 2026, with mechanics from the upgraded 14 Magic Emails recording and two Win the Week calls. Where the visit disagrees with anything older, the visit wins.</p>' +
    '<p class="pb-src" style="margin-top:8px">This is a first pass covering the general process and the email timeline. It is meant to grow when the BAM FAM recordings land. The long-form versions live in sales.md and proposal-playbook.md.</p></section>'))
}

// ---------- Contacts ----------
function phoneMatch(c, f) {
  var digits = f.replace(/\D/g, '')
  if (digits.length < 3) return false
  return (c.phones || []).some(function (p) { return String(p).replace(/\D/g, '').indexOf(digits) >= 0 })
}
// Projects a contact is linked to (from the stored contact_links).
function linkedProjectsFor(c) {
  var links = SNAP.links || {}
  return (SNAP.projects || []).filter(function (p) { return (links[p.id] || []).indexOf(c.id) >= 0 })
}
function contactCard(c) {
  var rel = c.relationship
  var meta = [(c.emails || [])[0], (c.phones || [])[0]].filter(Boolean).join('  ·  ')
  // The Mac's row: tags and how many projects they are on.
  var n = linkedProjectsFor(c).length
  var extra = (c.tags || []).map(function (t) { return '<span class="tagchip tagchip-ro">' + esc(t) + '</span>' }).join('') +
    (n ? '<span class="clinks">' + n + (n === 1 ? ' project' : ' projects') + '</span>' : '')
  var b = el('<button class="card"><div class="row1"><span class="name">' +
    (rel ? '<span class="reldot" style="background:' + relColor(rel) + ';margin-right:7px"></span>' : '') +
    esc(c.name || '(no name)') + '</span>' +
    (c.type ? '<span class="fee" style="color:var(--faint);font-variant-numeric:normal;text-transform:capitalize">' + esc(c.type) + '</span>' : '') +
    '</div>' + (meta ? '<div class="meta">' + esc(meta) + '</div>' : '') +
    (extra ? '<div class="crow-extra">' + extra + '</div>' : '') + '</button>')
  b.addEventListener('click', function () { openContactSheet(c) })
  return b
}
var CONTACT_TYPE_FILTER = 'all'
function newContactFlow() {
  doWrite(createContact({ name: 'New contact', type: 'client' }), 'Contact added', function (row) {
    var c = { id: row.id, name: row.name, emails: [], phones: [], type: 'client', relationship: '', engagement: '', tags: [], notes: '' }
    SNAP.contacts = (SNAP.contacts || []).concat([c])
    if (TAB === 'contacts') renderContacts()
    openContactSheet(c)
  })
}
function renderContacts() {
  var v = $('#view'); v.innerHTML = ''
  var top = el('<div class="ctop"><input class="search" id="cq" placeholder="Search contacts…" /><button class="addbtn">+ New</button></div>')
  top.querySelector('.addbtn').addEventListener('click', newContactFlow)
  v.appendChild(top)
  // Two rows of filters, like the Mac: what kind of contact, then the relationship.
  var tchips = el('<div class="chips"></div>')
  ;[['all', 'All types'], ['client', 'Client'], ['vendor', 'Vendor'], ['associate', 'Associate'], ['other', 'Other']].forEach(function (f) {
    var b = el('<button class="chip' + (CONTACT_TYPE_FILTER === f[0] ? ' on' : '') + '">' + f[1] + '</button>')
    b.addEventListener('click', function () { CONTACT_TYPE_FILTER = f[0]; renderContacts() })
    tchips.appendChild(b)
  })
  v.appendChild(tchips)
  var chips = el('<div class="chips"></div>')
  ;[['all', 'All'], ['active', 'Active'], ['yes', 'Yes'], ['maybe', 'Maybe'], ['no', 'No']].forEach(function (f) {
    var b = el('<button class="chip' + (CONTACT_FILTER === f[0] ? ' on' : '') + '">' + f[1] + '</button>')
    b.addEventListener('click', function () { CONTACT_FILTER = f[0]; renderContacts() })
    chips.appendChild(b)
  })
  v.appendChild(chips)
  var list = el('<div id="clist"></div>')
  v.appendChild(list)
  var all = SNAP.contacts || []
  function draw(filter) {
    var f = (filter || '').toLowerCase().trim()
    var items = all.filter(function (c) {
      if (CONTACT_FILTER !== 'all' && c.relationship !== CONTACT_FILTER) return false
      if (CONTACT_TYPE_FILTER !== 'all' && c.type !== CONTACT_TYPE_FILTER) return false
      if (!f) return true
      var hay = (c.name + ' ' + (c.emails || []).join(' ') + ' ' + (c.tags || []).join(' ') + ' ' + (c.notes || '')).toLowerCase()
      return hay.indexOf(f) >= 0 || phoneMatch(c, f)
    })
    items.sort(function (a, b) { return (a.name || '').toLowerCase() < (b.name || '').toLowerCase() ? -1 : 1 })
    list.innerHTML = ''
    if (!items.length) { list.appendChild(el('<div class="empty">No matching contacts.</div>')); return }
    list.appendChild(sectionLabel((CONTACT_FILTER === 'all' ? 'All' : CONTACT_FILTER) + '  ·  ' + items.length + (items.length !== all.length ? ' of ' + all.length : '')))
    items.forEach(function (c) { list.appendChild(contactCard(c)) })
  }
  draw('')
  $('#cq').addEventListener('input', function (e) { draw(e.target.value) })
}
// One editable contact field, inline (email/phone/tag arrays are comma-joined). Saves via updateContact.
function contactField(c, field, label, kind, onSaved) {
  var isArr = field === 'emails' || field === 'phones' || field === 'tags'
  var cur = isArr ? (c[field] || []).join(', ') : (c[field] || '')
  var wrap = el('<div class="item kv-tap" style="cursor:pointer"></div>')
  // Two appends: el() returns ONE element, so a 'k' and 'v' pair in a single string silently lost the
  // value and every field on the contact sheet read blank (found 2026-10-23).
  wrap.appendChild(el('<div class="k">' + esc(label) + '</div>'))
  wrap.appendChild(el('<div class="v">' + (String(cur).trim() ? esc(cur) : '<span style="color:var(--faint)">Tap to add</span>') + '</div>'))
  wrap.addEventListener('click', function () {
    wrap.innerHTML = ''
    wrap.appendChild(el('<div class="k" style="margin-bottom:5px">' + esc(label) + '</div>'))
    var input = kind === 'textarea' ? document.createElement('textarea') : document.createElement('input')
    input.className = 'field-input'; input.value = cur; if (kind === 'textarea') input.rows = 3
    wrap.appendChild(input)
    var save = function () {
      var nv = input.value
      if (nv === cur) { onSaved(); return }
      var patch = {}; patch[field] = nv
      doWrite(updateContact(c.id, patch), 'Saved', function () {
        if (isArr) c[field] = nv.split(/[,;\n]/).map(function (s) { return s.trim() }).filter(Boolean)
        else c[field] = nv
        onSaved()
      }).catch(function () { onSaved() })
    }
    if (kind === 'textarea') {
      var bar = el('<div class="addrow" style="margin-top:8px"><button class="btn-ghost">Cancel</button><button class="btn-gold">Save</button></div>')
      bar.children[0].addEventListener('click', function (e) { e.stopPropagation(); onSaved() })
      bar.children[1].addEventListener('click', function (e) { e.stopPropagation(); save() })
      wrap.appendChild(bar)
    } else {
      input.addEventListener('blur', save)
    }
    setTimeout(function () { input.focus() }, 30)
  })
  return wrap
}
function openContactSheet(c) {
  var sheet = el('<div class="sheet"><div class="sheet-card"></div></div>')
  var card = sheet.querySelector('.sheet-card')
  var close = function () { sheet.remove() }
  function rebuild() {
    card.innerHTML = ''
    card.appendChild(el('<div class="sheet-title">' + esc(c.name || 'Contact') + (c.type ? ' <span style="font-size:12px;color:var(--faint);font-weight:400">· ' + esc(c.type) + '</span>' : '') + '</div>'))
    card.appendChild(el('<div class="k" style="margin:2px 0 5px">Relationship</div>'))
    var relrow = el('<div class="relrow"></div>')
    CONTACT_REL.forEach(function (r) {
      var on = c.relationship === r.v
      var b = el('<button class="relchip' + (on ? ' on' : '') + '"' + (on ? ' style="background:' + r.color + '"' : '') + '>' + r.label + '</button>')
      b.addEventListener('click', function () {
        var next = c.relationship === r.v ? '' : r.v
        doWrite(updateContact(c.id, { relationship: next }), 'Saved', function () { c.relationship = next; rebuild() })
      })
      relrow.appendChild(b)
    })
    card.appendChild(relrow)
    card.appendChild(el('<p class="fin-h" style="margin:6px 0 0">Active means in the pipeline now. Yes / Maybe / No is the lasting call once they have left it.</p>'))
    // Type, and for a vendor or associate how far it went (the Mac's ContactDetail).
    card.appendChild(el('<div class="k" style="margin:14px 0 5px">Type</div>'))
    var trow = el('<div class="relrow"></div>')
    ;['client', 'vendor', 'associate', 'other'].forEach(function (t) {
      var on = c.type === t
      var b = el('<button class="relchip' + (on ? ' on on-plain' : '') + '" style="text-transform:capitalize">' + t + '</button>')
      b.addEventListener('click', function () {
        if (on) return
        doWrite(updateContact(c.id, { type: t }), 'Saved', function () { c.type = t; rebuild() })
      })
      trow.appendChild(b)
    })
    card.appendChild(trow)
    if (c.type === 'vendor' || c.type === 'associate') {
      card.appendChild(el('<div class="k" style="margin:12px 0 5px">Engagement</div>'))
      var erow = el('<div class="relrow"></div>')
      ;[['emailed', 'Emailed only'], ['collaborated', 'Worked together']].forEach(function (e) {
        var on = c.engagement === e[0]
        var b = el('<button class="relchip' + (on ? ' on on-plain' : '') + '">' + e[1] + '</button>')
        b.addEventListener('click', function () {
          var next = on ? '' : e[0]
          doWrite(updateContact(c.id, { engagement: next }), 'Saved', function () { c.engagement = next; rebuild() })
        })
        erow.appendChild(b)
      })
      card.appendChild(erow)
    }
    card.appendChild(el('<div class="k" style="margin:14px 0 5px">Tags</div>'))
    card.appendChild(tagEditor(c))
    var email0 = (c.emails || [])[0], phone0 = (c.phones || [])[0]
    var act = el('<div class="contact" style="margin-top:12px"></div>')
    if (phone0) act.appendChild(el('<a href="tel:' + esc(phone0) + '">Call</a>'))
    if (phone0) act.appendChild(el('<a href="sms:' + esc(phone0) + '">Text</a>'))
    if (email0) act.appendChild(el('<a href="mailto:' + esc(email0) + '">Email</a>'))
    if (act.children.length) card.appendChild(act)
    var kv = el('<div class="kv" style="margin-top:10px"></div>')
    kv.appendChild(contactField(c, 'name', 'Name', 'text', rebuild))
    kv.appendChild(contactField(c, 'emails', 'Emails', 'text', rebuild))
    kv.appendChild(contactField(c, 'phones', 'Phones', 'text', rebuild))
    kv.appendChild(contactField(c, 'notes', 'Notes', 'textarea', rebuild))
    card.appendChild(kv)
    var linked = linkedProjectsFor(c)
    if (linked.length) {
      card.appendChild(el('<div class="k" style="margin:16px 0 6px">Linked projects · ' + linked.length + '</div>'))
      linked.forEach(function (p) {
        var pill = p.bucket === 'completed' ? 'done' : p.bucket === 'archived' ? 'arch' : ''
        var row = el('<button class="card" style="margin-bottom:7px"><div class="row1"><span class="name" style="font-size:14px">' + esc(p.client) + '</span><span class="pill ' + pill + '">' + esc(p.bucket) + '</span></div></button>')
        row.addEventListener('click', function () { close(); TAB = pageForBucket(p.bucket); renderDetail(p.id) })
        card.appendChild(row)
      })
    }
    var done = el('<button class="btn-gold" style="width:100%;margin-top:16px">Done</button>')
    done.addEventListener('click', function () { close(); if (TAB === 'contacts' && !DETAIL_ID) renderContacts() })
    card.appendChild(done)
    // Delete, like the Mac. Their project links go with them (the database cascades); the projects
    // themselves, and the names and emails stored on those projects, are untouched.
    var del = el('<button class="cmp-discard">Delete contact</button>')
    del.addEventListener('click', function () {
      var n = linked.length
      if (!confirm('Delete ' + (c.name || 'this contact') + '?\n\nThis permanently removes the contact' + (n ? ' and unlinks them from ' + n + (n === 1 ? ' project' : ' projects') : '') + '. The projects stay as they are.')) return
      doWrite(deleteContact(c.id), 'Contact deleted', function () {
        SNAP.contacts = (SNAP.contacts || []).filter(function (x) { return x.id !== c.id })
        if (SNAP.links) Object.keys(SNAP.links).forEach(function (pid) { SNAP.links[pid] = (SNAP.links[pid] || []).filter(function (id) { return id !== c.id }) })
        close()
        if (TAB === 'contacts' && !DETAIL_ID) renderContacts()
        else if (DETAIL_ID) renderDetail(DETAIL_ID, true)
      })
    })
    card.appendChild(del)
  }
  rebuild()
  sheet.addEventListener('click', function (e) { if (e.target === sheet) close() })
  document.body.appendChild(sheet)
}

function applySnapshot(s) {
  SNAP = s
  STAGE = {}
  ;(s.structure.umbrellas || []).forEach(function (u) { (u.stages || []).forEach(function (st) { STAGE[st.id] = { name: st.name, umbrella: u.label, color: u.color } }) })
}

// Resolves 'ok' | 'unauth' | 'error'. Reads everything LIVE from Supabase (loadEverything()).
function loadAndRender() {
  $('#updated').textContent = 'Refreshing…'
  return loadEverything().then(function (s) {
    applySnapshot(s)
    $('#updated').textContent = '' // the header shows the date; it only speaks up to say refreshing or offline
    DETAIL_ID = null // a full reload returns to the active tab
    render()
    updatePushButton()
    return 'ok'
  }).catch(function (e) {
    // A 401 / JWT error means the session is gone (expired + refresh failed) -> back to login.
    var msg = String((e && (e.message || e.error_description)) || e)
    if (e && (e.status === 401 || /jwt|not\s*authenticated|invalid.*token/i.test(msg))) return 'unauth'
    // Keep the last-loaded data on screen if we have it (graceful offline); else show the error.
    if (SNAP) { $('#updated').textContent = 'Offline · showing last data' }
    else { $('#view').innerHTML = '<div class="empty">Could not load data.<br>' + esc(msg) + '</div>'; $('#updated').textContent = 'Offline' }
    return 'error'
  })
}

// ---------- background auto-refresh (mirrors the desktop's focus + interval live refresh) ----------
// The desktop got auto-refresh; the phone did not, so a task made on the Mac didn't show on the phone
// until a manual pull. This re-pulls the same LIVE data loadAndRender uses, but NON-DISRUPTIVELY:
//   - it never touches DETAIL_ID (so it won't kick you out of an open project),
//   - it re-renders in place via refreshView() (keeps the open detail or current tab), and
//   - it SKIPS a tick entirely while a modal sheet / add-form is open or a field is focused, so an
//     in-progress edit is never clobbered (mirrors the desktop's modalOpen + isEditingActive guard).

// True while the user is actively typing in / focused on an editable field.
function isEditingActive() {
  var a = document.activeElement
  if (!a) return false
  var tag = a.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || a.isContentEditable === true
}
// True while a modal sheet or an inline add/edit form is on screen (a refresh mid-edit would lose it).
function editorOpen() {
  return !!document.querySelector('.sheet, .addform, .editing')
}
// One non-disruptive background pull. Skipped if we're not logged in, offline-with-no-data, or the
// user is mid-edit. Best-effort: any error is swallowed (the manual Refresh button surfaces real ones).
function backgroundRefresh() {
  if (!SNAP) return // not loaded yet / logged out: the normal load path handles the first fetch
  if (editorOpen() || isEditingActive()) return
  // Egress guard: ask the ~30-byte data_version sentinel first and skip the full reload when
  // nothing changed since our last load. On sentinel errors it reports changed, so worst case
  // is the old behavior, never a stale freeze.
  dataChangedSinceLastLoad().then(function (changed) {
    if (!changed) return
    doBackgroundReload()
  })
}
function doBackgroundReload() {
  loadEverything().then(function (s) {
    applySnapshot(s)
    $('#updated').textContent = '' // the header shows the date; it only speaks up to say refreshing or offline
    refreshView() // re-render the open detail or the active tab, in place (DETAIL_ID untouched)
    updatePushButton()
  }).catch(function () { /* keep whatever's on screen; the manual button reports errors */ })
}

// Set up the ~30s interval + focus/visibility triggers exactly once (the common case: Michael added a
// task on the Mac, then picks up his phone). Idempotent so re-entering the app doesn't stack timers.
var autoRefreshWired = false
function startAutoRefresh() {
  if (autoRefreshWired) return
  autoRefreshWired = true
  setInterval(backgroundRefresh, 30 * 1000)
  window.addEventListener('focus', backgroundRefresh)
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') backgroundRefresh()
  })
}

// ---------- home-screen widgets (native app only, 2026-10-24) ----------
//
// The iPhone widgets (ios-app/ios/App/BloomWidgets) read a small feed from the widget-feed function
// with a READ-ONLY widget key. The widgets cannot use this app's sign-in (refreshing it from their
// own process would sign the app out), so this signed-in app asks phone-api for a key once and hands
// it to them through the WidgetBridge plugin (App/WidgetBridge.swift), which keeps it in the App
// Group the widgets share. After that this file only does two things: tells the widgets to refresh
// when the CRM changes or the app goes to the background, and opens the right page when a widget is
// tapped (bloomcrm://tasks, gigs, inbox, project/<id>, project/<id>/email).
// Every call here is a no-op in a browser and in the PWA, which have no WidgetBridge.
var WIDGET_FEED_URL = 'https://yfmacqvcmkogvkcxfjkr.supabase.co/functions/v1/widget-feed'
var WIDGET_PENDING_LINK = null
var WIDGET_RELOAD_AT = 0
function widgetBridge() {
  if (!isNativeApp()) return null
  var C = window.Capacitor
  return (C.Plugins && C.Plugins.WidgetBridge) || (typeof C.registerPlugin === 'function' ? C.registerPlugin('WidgetBridge') : null)
}
function connectWidgets(force) {
  var wb = widgetBridge(); if (!wb) return Promise.resolve(false)
  return wb.hasKey().then(function (r) {
    if (r && r.has && !force) return true
    return phoneApi('widget-token', { label: 'iPhone widgets' }).then(function (res) {
      if (!res || !res.token) throw new Error('No widget key came back.')
      return wb.setKey({ key: res.token, url: WIDGET_FEED_URL }).then(function () { return true })
    })
  }).catch(function () { return false })
}
// Throttled: the widgets refetch on every reload, and a burst of edits should cost one fetch.
function reloadWidgets(now) {
  var wb = widgetBridge(); if (!wb) return
  if (!now && Date.now() - WIDGET_RELOAD_AT < 20000) return
  WIDGET_RELOAD_AT = Date.now()
  try { wb.reload() } catch (e) { /* a widget refresh is never worth an error */ }
}
function handleWidgetLink(url) {
  var m = /^bloomcrm:\/\/([^/?#]+)(?:\/([^/?#]+))?(?:\/([^/?#]+))?/.exec(String(url || ''))
  if (!m) return
  if (!SNAP) { WIDGET_PENDING_LINK = url; return }
  closeDrawer()
  document.querySelectorAll('.sheet').forEach(function (x) { if (!x.classList.contains('home-sheet')) x.remove() })
  var what = m[1], id = m[2] ? decodeURIComponent(m[2]) : '', sub = m[3] || ''
  if (what === 'project' && id) {
    var p = SNAP.projects.find(function (x) { return x.id === id })
    if (!p) { navigate('pipeline'); return }
    TAB = pageForBucket(p.bucket)
    PTAB = sub === 'email' ? 'email' : 'details'
    renderDetail(p.id)
    window.scrollTo(0, 0)
    return
  }
  if (what === 'gigs') { navigate('home'); openHomeSheet('gigs'); return }
  if (what === 'tasks' || what === 'inbox' || what === 'home') { navigate(what); return }
}
function wireWidgets() {
  var wb = widgetBridge(); if (!wb) return
  try { wb.addListener('link', function (e) { handleWidgetLink(e && e.url) }) } catch (e) { /* older shell */ }
  wb.takeLink().then(function (r) { if (r && r.url) handleWidgetLink(r.url) }).catch(function () {})
  // Leaving the app is when the home screen is about to be looked at, so that is when to refresh.
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') reloadWidgets(true) })
}

// ---------- push (notifications from this app) ----------
//
// TWO DELIVERY ROUTES, ONE UI. This file is the single source for both the PWA at
// michaelbloemeke.com/crm/ and the native iOS app (../ios-app wraps these same files with
// Capacitor). The native build is not a fork: it is this code, detecting at runtime that it is
// running inside a native shell and taking the APNs path instead of the Web Push path.
//
// Why native exists at all: iOS Web Push only works from a Home Screen install, silently dies if
// the icon is removed and re-added, and has a habit of losing permission across iOS updates.
// Michael, 2026-09-20, after notifications stopped: "this being a webapp just isn't cutting it."
//
// (WARNING) EVERYTHING BELOW MUST STAY BACKWARDS-SAFE. When window.Capacitor is undefined (always
// true in a browser and in the PWA) every branch here falls through to the original Web Push
// behaviour, unchanged.
function isNativeApp() {
  return !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform())
}
function nativePushPlugin() {
  return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.PushNotifications) || null
}
function pushSupported() {
  if (isNativeApp()) return !!nativePushPlugin()
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}
function updatePushButton() {
  var btn = $('#enable-push')
  if (!btn) return
  // Show the bell when push is usable, we have the VAPID key, and this device isn't already subscribed
  // (or permission hasn't been permanently denied). Once subscribed (localStorage flag), hide it. No
  // passcode gate anymore: the subscribe write is authenticated by the logged-in Supabase session.
  // The VAPID key and Notification.permission are Web Push concepts. Native has neither: iOS
  // owns the permission prompt and the plugin reports the result, so the bell shows until this
  // device has successfully registered once.
  var show = isNativeApp()
    ? pushSupported() && localStorage.getItem('mcrm_push') !== '1'
    : pushSupported() && VAPID_PUBLIC_KEY &&
      localStorage.getItem('mcrm_push') !== '1' && window.Notification && Notification.permission !== 'denied'
  btn.classList.toggle('hidden', !show)
}
function urlB64ToUint8(base64) {
  var pad = '='.repeat((4 - (base64.length % 4)) % 4)
  var b64 = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/')
  var raw = atob(b64)
  var arr = new Uint8Array(raw.length)
  for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i)
  return arr
}
// Turn on lock-screen notifications: ask permission, subscribe this device with pushManager, then
// UPSERT the subscription into Supabase's push_subscriptions (authenticated by the logged-in session).
// Handles "already subscribed" (reuse the existing subscription and just re-save it) and a denied /
// dismissed permission gracefully.
function enablePush() {
  if (isNativeApp()) return enableNativePush()
  if (!pushSupported()) {
    alert('To get notifications, add this app to your Home Screen first (Share, then Add to Home Screen), then open it from there and try again.')
    return
  }
  if (!VAPID_PUBLIC_KEY) {
    alert('Notifications are not set up yet (missing key).')
    return
  }
  Notification.requestPermission().then(function (perm) {
    if (perm !== 'granted') {
      updatePushButton() // if permanently denied, this hides the bell
      alert(perm === 'denied'
        ? 'Notifications are blocked for this app. Turn them back on in your phone Settings, then tap the bell again.'
        : 'Notifications were not allowed.')
      return
    }
    return navigator.serviceWorker.ready
      .then(function (reg) {
        // Reuse an existing subscription if this device already has one (avoids an InvalidStateError
        // from re-subscribing with the same key); otherwise create a fresh one.
        return reg.pushManager.getSubscription().then(function (existing) {
          return existing || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(VAPID_PUBLIC_KEY) })
        })
      })
      .then(function (sub) {
        return savePushSubscription(sub)
      })
      .then(function () {
        localStorage.setItem('mcrm_push', '1')
        updatePushButton()
        alert('Notifications are on. Alerts will show up here on your lock screen.')
      })
  }).catch(function (e) {
    alert('Could not turn on notifications: ' + ((e && e.message) || e))
  })
}

// Native (APNs) push. iOS hands back a device token rather than a Web Push subscription, so the
// token is stored in the SAME push_subscriptions table under an apns:// endpoint. That keeps one
// subscription list for the whole system: the server reads the endpoint scheme and picks its send
// path, and the PWA and the native app can both be registered at once while this beds in.
function enableNativePush() {
  registerNativePush({ loud: true })
}

// Register this device with APNs and store whatever token comes back.
//
// `loud` is the bell: it asks iOS for permission and reports the outcome to Michael. Without it
// this is the SILENT refresh that runs on every launch (see refreshNativePushToken), which must
// never put a dialog on screen.
//
// ⚠️ WHY THE SILENT REFRESH EXISTS, and why it is not optional here.
//
// An APNs device token is not permanent. iOS reissues it after a restore, sometimes after an
// update, and in practice after reinstalling the app. Apple's own guidance is to call
// registerForRemoteNotifications() on EVERY launch and send the server whatever token comes back.
//
// This app only ever registered when the bell was tapped, so a rotated token was invisible: the
// bell had already hidden itself (localStorage 'mcrm_push'), the database kept the dead token, and
// APNs answers a dead token with BadDeviceToken, which nobody sees. Notifications simply stopped,
// silently and permanently, until someone thought to tap a button that was no longer on screen.
// That is exactly what happened on 2026-09-20 ("I don't think I saw any notification after tapping
// the bell"), and it was diagnosed only by posting to both APNs hosts by hand.
//
// It matters much more now than it did then, because shipping an update to this app MEANS
// reinstalling it over a cable. Without this, every update Michael gets is a coin flip on whether
// his notifications survive it.
function registerNativePush(opts) {
  var loud = !!(opts && opts.loud)
  var Push = nativePushPlugin()
  if (!Push) {
    if (loud) alert('Notifications are not available in this build.')
    return
  }
  // The token arrives on an event, not as the return value of register(), so listen first.
  Push.addListener('registration', function (token) {
    var value = token && token.value
    if (!value) return
    saveNativePushToken(value)
      .then(function () {
        localStorage.setItem('mcrm_push', '1')
        updatePushButton()
        if (loud) alert('Notifications are on. Alerts will show up on your lock screen.')
      })
      .catch(function (e) {
        // A failed SILENT refresh must not nag. It is retried on the next launch, and the bell is
        // put back so there is still a way to fix it by hand.
        if (loud) alert('Could not save this device for notifications: ' + ((e && e.message) || e))
        else {
          console.warn('[push] silent token refresh failed:', (e && e.message) || e)
          localStorage.removeItem('mcrm_push')
          updatePushButton()
        }
      })
  })
  Push.addListener('registrationError', function (err) {
    if (loud) alert('iOS would not register this device for notifications: ' + JSON.stringify(err))
    else console.warn('[push] silent registration error:', JSON.stringify(err))
  })

  // checkPermissions on the silent path, requestPermissions on the loud one. The silent refresh
  // must never raise the system prompt: being asked "allow notifications?" out of nowhere, every
  // launch, because a background refresh decided to ask, is worse than no refresh at all.
  var ask = loud ? Push.requestPermissions() : Push.checkPermissions()
  ask
    .then(function (res) {
      if (!res || res.receive !== 'granted') {
        if (loud) alert('Notifications were not allowed. You can turn them on in Settings, then tap the bell again.')
        else {
          // He turned them off in Settings. Put the bell back so there is a way to turn them on.
          localStorage.removeItem('mcrm_push')
          updatePushButton()
        }
        return
      }
      return Push.register()
    })
    .catch(function (e) {
      if (loud) alert('Could not turn on notifications: ' + ((e && e.message) || e))
      else console.warn('[push] silent refresh could not start:', (e && e.message) || e)
    })
}

// Called on every launch of the native app, for a device that has already been registered once.
// Does nothing in the PWA (Web Push subscriptions do not rotate this way) and nothing for a device
// that has never opted in, which must be a deliberate tap on the bell.
function refreshNativePushToken() {
  if (!isNativeApp()) return
  if (localStorage.getItem('mcrm_push') !== '1') return
  registerNativePush({ loud: false })
}

// ---------- boot ----------
var wired = false
function wireUI() {
  if (wired) return
  wired = true
  var mb = $('#menu-btn'); if (mb) mb.addEventListener('click', openDrawer)
  var ds = $('#drawer-search'); if (ds) ds.addEventListener('click', function () { closeDrawer(); openSearch() })
  var bb = $('#back-btn'); if (bb) bb.addEventListener('click', goBack)
  var bd = $('#drawer-backdrop'); if (bd) bd.addEventListener('click', closeDrawer)
  document.querySelectorAll('#drawer-nav button').forEach(function (b) {
    b.addEventListener('click', function () { navigate(b.dataset.page) })
  })
  var dlo = $('#drawer-logout'); if (dlo) dlo.addEventListener('click', function () { closeDrawer(); doLogout() })
  $('#refresh').addEventListener('click', loadAndRender)
  var ep = $('#enable-push')
  if (ep) ep.addEventListener('click', enablePush)
  // (WARNING) NOT IN THE NATIVE APP. The worker caches assets so the PWA opens offline; inside the
  // native shell the assets are already on the device, so it adds nothing and actively hurts. It
  // would serve a cached copy of a previous build after an update, which is the most common way a
  // Capacitor app ends up stuck on stale code with no way for the user to clear it.
  if (!isNativeApp() && 'serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(function () {})
}

// Show the app, hide the login screen, and load live data.
function enterApp() {
  $('#login').classList.add('hidden')
  $('#app').classList.remove('hidden')
  wireUI()
  // Where he was last time (within a day), restored once the data is in.
  var saved = null
  try { saved = JSON.parse(localStorage.getItem('crm-last-loc') || 'null') } catch (e) { saved = null }
  if (saved && (!saved.at || Date.now() - saved.at > 24 * 3600e3)) saved = null
  if (saved && saved.tab && PAGE_TITLES[saved.tab] && !saved.detail) {
    TAB = saved.tab
    if (TAB === 'show') { if (saved.show) SHOW_ID = saved.show; else TAB = 'shows' }
  }
  wireWidgets()
  loadAndRender().then(function (r) {
    if (r === 'ok') {
      refreshUnreadMail() // the first count waits for the projects, or it would read a false 0
      connectWidgets(false).then(function () { reloadWidgets(true) })
      if (WIDGET_PENDING_LINK) { var wl = WIDGET_PENDING_LINK; WIDGET_PENDING_LINK = null; handleWidgetLink(wl); return }
    }
    if (r !== 'ok' || !saved || !saved.detail) return
    var p = (SNAP.projects || []).find(function (x) { return x.id === saved.detail })
    if (!p) return
    TAB = saved.tab && PAGE_TITLES[saved.tab] ? saved.tab : pageForBucket(p.bucket)
    if (saved.ptab) PTAB = saved.ptab
    renderDetail(p.id)
  })
  startAutoRefresh() // keep the phone's data live (interval + focus/visibility), like the desktop
  startMailCount()   // and the unread-mail badge on the drawer, on its own slower clock
  refreshNativePushToken() // iOS rotates APNs tokens; re-register every launch so one never goes stale
}

// Log out: end the Supabase session (clears the persisted token) and return to the login screen.
function doLogout() {
  signOut().then(function () {
    SNAP = null
    try { if (navigator.clearAppBadge) navigator.clearAppBadge() } catch (e) { /* noop */ }
    $('#app').classList.add('hidden')
    showLogin()
  })
}

// Wire + display the login screen. Email + password -> Supabase sign-in. Handles a wrong password
// gracefully. supabase-js persists the session, so this only runs when there is no active session.
var loginWired = false
function showLogin() {
  var login = $('#login'), email = $('#email'), pw = $('#password'), err = $('#loginerr'), btn = $('#signin-btn')
  login.classList.remove('hidden')
  if (!loginWired) {
    loginWired = true
    function attempt() {
      var e = (email.value || '').trim(), p = pw.value || ''
      if (!e || !p) { err.textContent = 'Enter your email and password.'; return }
      err.textContent = 'Signing in…'
      btn.disabled = true
      signIn(e, p).then(function () {
        err.textContent = ''
        pw.value = ''
        btn.disabled = false
        enterApp()
      }).catch(function (ex) {
        btn.disabled = false
        var m = String((ex && ex.message) || ex)
        err.textContent = /invalid login|credentials/i.test(m) ? 'Wrong email or password.' : ('Could not sign in: ' + m)
        pw.focus()
      })
    }
    btn.addEventListener('click', attempt)
    pw.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') attempt() })
    email.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') pw.focus() })
  }
  setTimeout(function () { if ($('#email')) $('#email').focus() }, 50)
}

// On load: if there's a persisted session, skip straight to the app; otherwise show login.
function boot() {
  getSession().then(function (session) {
    if (session) enterApp()
    else showLogin()
  }).catch(function () {
    showLogin()
  })
}

document.addEventListener('DOMContentLoaded', boot)
