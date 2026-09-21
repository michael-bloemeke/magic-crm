import { STUB } from './stub.mjs'
const { loadEverything, dataChangedSinceLastLoad, getSession, signIn, signOut, currentUserEmail, addTask, updateTask, toggleTask, deleteTask, addNote, updateProjectField, addPayment, setStage, reloadPaymentsFinance, savePushSubscription, saveNativePushToken, createProject, archiveProject, completeProject, restoreProject, deleteProject, LEAD_SOURCES, updateContact, loadContacts, linkOrCreateContact, unlinkContact, loadLinks, setNotificationSeen, loadBookingProgress, loadContractVariants, readyToBookOnPhone, resetBookingOnPhone, agreementPdfUrl, gmailList, gmailThread, gmailMarkRead, gmailUnread, sendEmail, loadProposalsOverview, VAPID_PUBLIC_KEY } = STUB
/* Bloom CRM mobile. Logs in with Supabase Auth and reads LIVE data straight from the database (RLS
   lets the logged-in user read everything; the publishable key alone reads nothing). Login is
   once-per-device (supabase-js persists the session). Read-only for now: the view renders live data;
   writes are a later stage and slot into supabase-data.js behind the load*() functions.

   This file is an ES module (loaded with <script type="module">) so it can import the data layer. */

'use strict'


var SNAP = null
var TAB = 'home' // current page (drawer destination)
var CONTACT_FILTER = 'all' // contacts page relationship filter
var COLLAPSED = {} // pipeline section label -> collapsed? (persists per session)
var STAGE = {} // stageId -> { name, umbrella, color }
var DETAIL_ID = null // when non-null, the detail view for this project is on screen (not a tab)

var PAGE_TITLES = {
  home: 'Home', pipeline: 'Pipeline', completed: 'Completed', archived: 'Archived', deleted: 'Deleted',
  contacts: 'Contacts', tasks: 'Tasks', alerts: 'Alerts', money: 'Money', inbox: 'Inbox',
  proposals: 'Proposals',
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
  return '$' + Math.round(Number(n)).toLocaleString('en-US')
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
  var list = el('<div id="plist"></div>')
  v.appendChild(list)

  function draw(filter) {
    var f = (filter || '').toLowerCase().trim()
    var items = pool.filter(function (p) {
      if (!f) return true
      return (p.client + ' ' + (p.eventLocation || '') + ' ' + (p.eventType || '') + ' ' + (p.contactNames || '')).toLowerCase().indexOf(f) >= 0
    })
    list.innerHTML = ''
    if (!items.length) {
      list.appendChild(el('<div class="empty">' + esc(f ? 'No matching projects.' : o.emptyText || 'Nothing here.') + '</div>'))
      return
    }
    if (bucket === 'active') drawActive(list, items)
    else drawRecords(list, items, bucket)
  }
  draw('')
  $('#q').addEventListener('input', function (e) { draw(e.target.value) })
}

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

// Active projects: one collapsible, color-coded section per pipeline umbrella, in structure order.
function drawActive(list, items) {
  var groups = {}
  items.forEach(function (p) {
    var si = stageInfo(p.stageId)
    var key = si.umbrella || 'Other'
    ;(groups[key] = groups[key] || []).push(p)
  })
  var umbrellas = SNAP.structure.umbrellas || []
  var order = umbrellas.map(function (u) { return u.label })
  Object.keys(groups).forEach(function (k) { if (order.indexOf(k) < 0) order.push(k) })
  order.forEach(function (label, i) {
    var g = groups[label]; if (!g || !g.length) return
    var u = umbrellas.find(function (x) { return x.label === label })
    list.appendChild(stageSection(label, umbrellaColor(u, i), g))
  })
}

// A collapsible pipeline section: a colored header (tinted by the section color) + count + chevron,
// with the projects (each carrying a matching colored left edge) below. Collapse persists per session.
function stageSection(label, color, projects) {
  var wrap = el('<div class="psection"></div>')
  var head = el('<button class="psection-head"><span class="psection-bar"></span><span class="psection-name">' + esc(label) + '</span><span class="psection-count">' + projects.length + '</span><span class="psection-chev"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></span></button>')
  head.style.setProperty('--sec', color)
  var body = el('<div class="psection-body"></div>')
  projects.forEach(function (p) { body.appendChild(projectCard(p, color)) })
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

// Completed / archived records: newest first by event date (fallback completed date), grouped by year.
function drawRecords(list, items, bucket) {
  // Deleted is ordered by WHEN IT WAS DELETED, newest first, and not grouped by year: what matters
  // on that page is how much of the 30-day window is left, not when the event was.
  if (bucket === 'deleted') {
    items.slice().sort(function (a, b) {
      var ad = a.deletedAt || '', bd = b.deletedAt || ''
      return bd < ad ? -1 : bd > ad ? 1 : 0
    }).forEach(function (p) { list.appendChild(projectCard(p)) })
    return
  }
  var sorted = items.slice().sort(function (a, b) {
    var ad = a.eventDate || a.completedDate || ''
    var bd = b.eventDate || b.completedDate || ''
    return bd < ad ? -1 : bd > ad ? 1 : 0
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
  var meta = [p.eventType, p.eventDate ? fmtDate(p.eventDate) : ''].filter(Boolean).join('  ·  ')

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

  var c = el(
    '<button class="card' + (accent ? ' accented' : '') + '">' +
      '<div class="row1"><span class="name">' + esc(p.client) + '</span><span class="fee">' + esc(money(p.totalFee)) + '</span></div>' +
      '<div class="meta">' + esc(meta) + (cd ? '<span class="cdown' + (soon ? ' soon' : '') + '">' + esc(cd) + '</span>' : '') + '</div>' +
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
  var payLine = el('<div class="payline"></div>'); card.appendChild(payLine)
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
  var reasons = (SNAP.config && SNAP.config.archiveReasons) || []
  var sheet = el('<div class="sheet"><div class="sheet-card"></div></div>')
  var card = sheet.querySelector('.sheet-card')
  card.appendChild(el('<div class="sheet-title">Archive ' + esc(p.client) + '</div>'))
  card.appendChild(el('<div class="hint" style="margin:-4px 0 10px">Removes it from the pipeline. You can return it anytime.</div>'))
  var sel = document.createElement('select'); sel.className = 'field-input'
  sel.appendChild(el('<option value="">Reason (optional)…</option>'))
  reasons.forEach(function (r) { var o = document.createElement('option'); o.value = r; o.textContent = r; sel.appendChild(o) })
  card.appendChild(sel)
  var otherIn = document.createElement('input'); otherIn.className = 'field-input'; otherIn.placeholder = 'Reason'; otherIn.style.marginTop = '8px'; otherIn.style.display = 'none'
  card.appendChild(otherIn)
  sel.addEventListener('change', function () {
    var isOther = sel.value === 'Other'
    otherIn.style.display = isOther ? 'block' : 'none'
    if (isOther) setTimeout(function () { otherIn.focus() }, 20)
  })
  var bar = el('<div class="addrow" style="margin-top:14px"><button class="btn-ghost">Cancel</button><button class="btn-gold">Archive</button></div>')
  var close = function () { sheet.remove() }
  bar.children[0].addEventListener('click', close)
  bar.children[1].addEventListener('click', function () {
    var reason = sel.value === 'Other' ? otherIn.value.trim() : sel.value
    doWrite(archiveProject(p.id, reason), 'Archived', function (r) {
      p.bucket = 'archived'; p.stageId = ''; p.archiveReason = r.archiveReason || reason || ''
      p.activityLog = r.activityLog
      close(); renderDetail(p.id)
    })
  })
  card.appendChild(bar)
  sheet.addEventListener('click', function (e) { if (e.target === sheet) close() })
  document.body.appendChild(sheet)
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
  var p = SNAP.projects.find(function (x) { return x.id === id }); if (!p) return renderPipeline()
  DETAIL_ID = id
  removeFab()
  var v = $('#view'); v.innerHTML = ''
  var pt = $('#pagetitle'); if (pt) pt.textContent = p.client || 'Project'
  // Back goes to the page this project actually lives on, not always Pipeline: opening a completed
  // project and being dumped into the active board on the way out is disorienting.
  var backPage = pageForBucket(p.bucket)
  var back = el('<button class="back"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>' + esc(PAGE_TITLES[backPage] || 'Pipeline') + '</button>')
  back.addEventListener('click', function () { navigate(backPage) })
  v.appendChild(back)

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

  var meta = [p.eventType, p.eventDate ? fmtDate(p.eventDate) : ''].filter(Boolean).join('  ·  ')
  if (meta) head.appendChild(el('<div class="phead-meta">' + esc(meta) + '</div>'))

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
      line.appendChild(el('<div class="phead-cn">' + esc(row.name) + (row.primary && linked.length > 1 ? '<span class="cc-primary">Primary</span>' : '') + '</div>'))
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
  wrap.appendChild(bookingSection(p))
  wrap.appendChild(paymentsSection(p))
  return wrap
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
  var wrap = el('<div></div>')
  var body = el('<div></div>')

  function draw(data) {
    var r = (data.items || []).find(function (x) { return x.projectId === p.id })
    if (!r) return // no proposal for this client; say nothing rather than add an empty section
    body.innerHTML = ''
    body.appendChild(sectionLabel('Proposal'))
    var card = el('<div class="card" style="pointer-events:auto"></div>')
    var chips = el('<div class="phead-chips" style="margin-top:0"></div>')
    chips.appendChild(el('<span class="pill ' + propStateClass(r.state) + '" style="margin:0">' + esc(propStateLabel(r.state)) + '</span>'))
    chips.appendChild(el('<span class="propviews">' + r.views + (r.views === 1 ? ' view' : ' views') + '</span>'))
    card.appendChild(chips)
    card.appendChild(el('<div class="hint">' + esc(r.lastViewedAt ? 'Last opened ' + timeAgo(r.lastViewedAt) : r.views ? 'Opened, but no timestamp recorded.' : 'They have not opened it yet.') + '</div>'))
    if (r.state !== 'live') card.appendChild(el('<div class="hint">' + esc(r.stateReason) + '</div>'))
    var acts = el('<div class="do-actions" style="margin-top:11px"></div>')
    if (r.openUrl) {
      var view = el('<button class="do-go">Preview</button>')
      view.addEventListener('click', function () {
        openPreview({ src: r.openUrl, publicUrl: r.url, title: r.projectName, backLabel: p.client })
      })
      acts.appendChild(view)
    }
    var copy = el('<button class="do-alt">Copy link</button>')
    copy.addEventListener('click', function () { copyText(r.url, 'Client link copied') })
    acts.appendChild(copy)
    card.appendChild(acts)
    body.appendChild(card)
  }

  if (PROP_CACHE) draw(PROP_CACHE)
  else {
    loadProposalsOverview()
      .then(function (d) { PROP_CACHE = d; if (DETAIL_ID === p.id) draw(d) })
      .catch(function () { /* the proposal row is a nice-to-have; the booking flow below is not */ })
  }
  wrap.appendChild(body)
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
      '<div class="v">' + (r.empty ? 'Not set' : esc(r.v)) + '</div></div>'
    ))
  })
  wrap.appendChild(kv)
  if (missing) wrap.appendChild(el('<div class="hint" style="margin-top:8px">' + missing + (missing === 1 ? ' field is' : ' fields are') + ' still blank.</div>'))
  var edit = el('<button class="btn-gold" style="width:100%;margin-top:14px">Edit details</button>')
  edit.addEventListener('click', function () { openDetailsPanel(p) })
  wrap.appendChild(edit)
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
        wrap.appendChild(el('<div class="card" style="pointer-events:none"><div class="row1"><span class="name" style="font-size:14.5px">' + esc(money(pm.amount) || String(pm.amount)) + (pm.pending ? ' <span style="color:var(--faint);font-size:12px">(pending)</span>' : '') + '</span><span class="fee" style="color:var(--faint);font-variant-numeric:normal">' + esc(pm.dateReceived ? fmtShort(pm.dateReceived) : '') + '</span></div>' + (lbl ? '<div class="meta">' + esc(lbl) + '</div>' : '') + '</div>'))
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
    gate.appendChild(el('<div class="k">Performance style</div><div class="v">' + (style ? esc(style) : '<span class="miss">Not set</span>') + '</div>'))
    gate.appendChild(el('<div class="k" style="margin-top:8px">Quote</div><div class="v">' + (feeOk ? esc(money(fee)) : '<span class="miss">Not set</span>') + '</div>'))
    gate.appendChild(el('<div class="k" style="margin-top:8px">Event date</div><div class="v">' + (dateOk ? esc(fmtDate(eventDate)) : '<span class="miss">Not set</span>') + '</div>'))
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
    ;(u.stages || []).forEach(function (s) {
      var on = s.id === p.stageId
      var row = el('<button class="actrow' + (on ? ' on' : '') + '"><span class="ar-l">' + esc(s.name) + '</span>' + (on ? '<span class="ar-v">Current</span>' : '') + '</button>')
      row.addEventListener('click', function () {
        if (on) { close(); return }
        // The desktop gates live in setStage (Post Show blocked, Booked needs a received payment).
        // A blocked move throws and is toasted; the sheet stays open so he can pick something else.
        doWrite(setStage(p.id, s.id, SNAP.structure, SNAP.payments || []), 'Moved to ' + s.name, function () {
          p.stageId = s.id
          close()
          renderDetail(p.id, true)
        }).catch(function () {})
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

  EDITABLE_DETAIL_FIELDS.forEach(function (f) {
    var key = f[0], label = f[1], kind = f[2]
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
    var save = function () {
      var nv = input.value
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
  var lines = Array.isArray(p.activityLog) ? p.activityLog : []
  if (!lines.length) { wrap.appendChild(el('<div class="empty" style="padding:10px">No activity yet.</div>')); return }
  lines.slice(0, 20).forEach(function (line) {
    wrap.appendChild(el('<div class="log">' + esc(typeof line === 'string' ? line : (line && line.text) || JSON.stringify(line)) + '</div>'))
  })
}

// The allow-listed editable event fields, in a sensible order. Each maps a camelCase project key to a
// label + input kind. Only SAFE fields (never client_name).
var EDITABLE_DETAIL_FIELDS = [
  ['projectName', 'Display name', 'text'],
  ['eventDate', 'Event date', 'date'],
  // Arrival time. Present in the desktop's EVENT_FIELDS since the beginning and missing from the
  // phone's until 2026-09-21, which meant the one time that decides when Michael leaves the house
  // was the one time he could not read or set from his phone.
  ['arrivalTime', 'Arrival time', 'text'],
  ['eventStartTime', 'Event start', 'text'],
  ['showStartTime', 'Show start', 'text'],
  ['eventLocation', 'Location', 'text'],
  ['venueType', 'Venue type', 'text'],
  // Fixed choices, matching BOOKING_FIELDS in crm-booking-form.mjs and src/eventFields.ts. The
  // client picks from this same list on the booking form and the answer writes straight onto the
  // project, so the two lists have to stay identical.
  ['indoorsOrOutdoors', 'Indoors / Outdoors', 'select', ['Indoors', 'Outdoors', 'Both']],
  ['numberOfGuests', 'Guest count', 'text'],
  ['ageOfGuests', 'Guest ages', 'text'],
  ['performanceStyle', 'Performance', 'text'],
  // The QUOTE. Missing from this list until 2026-08-05, which meant the phone blocked "Ready to book"
  // on a field the phone gave you no way to fill: the booking gate said "edit these in Event details"
  // and Event details did not offer it. Sits next to Performance because those two are the pair that
  // the client actually reads on the agreement.
  ['totalFee', 'Quote', 'money'],
  ['av', 'AV', 'text'],
  ['vips', 'VIPs', 'text'],
  ['bookingSource', 'Booking source', 'text'],
  ['eventDescription', 'Description', 'textarea'],
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
        '<select class="field-input" id="pay-method"><option value="">Method…</option><option>QuickBooks invoice</option><option>HoneyBook</option><option>Cash</option><option>Check</option><option>PayPal</option><option>Venmo</option><option>CashApp</option><option>Zelle</option></select>' +
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
        (t.dueDate ? '<span class="pill ' + (st || '') + '">' + (st === 'overdue' ? 'Overdue · ' : st === 'due' ? 'Due today' : 'Due ') + (st === 'due' ? '' : esc(fmtShort(t.dueDate))) + '</span>' : '') +
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
  var open = SNAP.tasks.filter(function (t) { return !t.done })
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
  v.appendChild(doneSection(SNAP.tasks.filter(function (t) { return t.done }), true))
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
  v.insertBefore(el('<div class="hint" style="margin:0 2px 4px">Everyone on your active projects. Nothing else.</div>'), list)
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
      go.addEventListener('click', function () { close(); navigate(pageForBucket(project.bucket)); renderDetail(project.id) })
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
// Plain text, on purpose. The send function turns blank lines into paragraphs and single newlines
// into <br>, so what he types on a phone keyboard is what the client reads. No formatting toolbar
// to fat-finger, no HTML to get wrong one-handed.
function openCompose(opts) {
  var o = opts || {}
  var project = o.project || null
  var sheet = el(
    '<div class="sheet"><div class="sheet-card sheet-tall">' +
      '<div class="sheet-head"><div class="sheet-title">' + (o.threadId ? 'Reply' : 'New email') + '</div>' +
      '<button class="sheet-x" aria-label="Close">' +
      '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>' +
      '</button></div><div class="sheet-body"></div>' +
    '</div></div>'
  )
  var body = sheet.querySelector('.sheet-body')
  var close = function () { sheet.remove() }
  sheet.querySelector('.sheet-x').addEventListener('click', close)
  sheet.addEventListener('click', function (e) { if (e.target === sheet) close() })

  var to = document.createElement('input')
  to.className = 'search'; to.type = 'email'; to.placeholder = 'To'
  to.value = o.to || ''
  to.autocapitalize = 'off'; to.autocorrect = 'off'
  body.appendChild(el('<div class="do-l" style="margin-bottom:6px">To</div>'))
  body.appendChild(to)

  // Every address on the project, one tap each. Typing an email address on a phone is the single
  // most annoying thing in this whole app, and he already has these people in the CRM.
  if (project) {
    var addrs = projectEmails(project)
    if (addrs.length) {
      var chips = el('<div class="do-actions" style="flex-wrap:wrap;margin-top:8px"></div>')
      addrs.forEach(function (a) {
        var c = el('<button class="do-alt" style="flex:0 1 auto;padding:7px 11px;font-size:12px">' + esc(a) + '</button>')
        c.addEventListener('click', function () { to.value = a })
        chips.appendChild(c)
      })
      body.appendChild(chips)
    }
  }

  var subj = document.createElement('input')
  subj.className = 'search'; subj.placeholder = 'Subject'
  subj.value = o.subject || ''
  body.appendChild(el('<div class="do-l" style="margin:14px 0 6px">Subject</div>'))
  body.appendChild(subj)

  var msg = document.createElement('textarea')
  msg.className = 'field-input'; msg.rows = 10
  msg.value = o.body || ''
  body.appendChild(el('<div class="do-l" style="margin:14px 0 6px">Message</div>'))
  body.appendChild(msg)

  var bar = el('<div class="addrow" style="margin-top:14px"><button class="btn-ghost">Cancel</button><button class="btn-gold">Send</button></div>')
  bar.children[0].addEventListener('click', close)
  var send = bar.children[1]
  send.addEventListener('click', function () {
    var t = to.value.trim(), sj = subj.value.trim(), bd = msg.value
    if (!/.+@.+\..+/.test(t)) { toast('Add a valid recipient.', 'err'); return }
    if (!sj) { toast('Add a subject.', 'err'); return }
    if (!bd.trim()) { toast('The message is empty.', 'err'); return }
    // Disabled while in flight. A cloud send is a second or two on a phone network, and a second
    // tap would be a second email in the client's inbox.
    send.disabled = true
    send.textContent = 'Sending…'
    sendEmail({ to: t, subject: sj, body: bd, projectId: project ? project.id : '', kind: 'custom' })
      .then(function () {
        toast('Email sent')
        mailForget()
        // The reply settles the thread, so it is no longer unread. Failing to mark it is not worth
        // failing the send over: the email is gone either way.
        if (o.threadId) gmailMarkRead(o.threadId).catch(function () {})
        close()
        if (o.after) o.after()
      })
      .catch(function (e) {
        send.disabled = false
        send.textContent = 'Send'
        toast(e.message || 'Could not send.', 'err')
      })
  })
  body.appendChild(bar)
  document.body.appendChild(sheet)
  setTimeout(function () { (o.to ? msg : to).focus() }, 60)
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

function renderMoney() {
  var v = $('#view'); v.innerHTML = ''
  var f = SNAP.finance
  if (!f) { v.appendChild(el('<div class="empty">No finance data.</div>')); return }
  var tm = f.thisMonth || {}
  var goal = Number(f.monthlyGoal) || 0
  var earned = Number(tm.earned) || 0
  var pct = goal > 0 ? Math.min(100, Math.round((earned / goal) * 100)) : 0
  v.appendChild(el(
    '<div class="stat"><div class="cap">This month booked</div><div class="big">' + esc(money(earned)) + '</div>' +
    (goal > 0 ? '<div class="bar"><span style="width:' + pct + '%"></span></div><div class="cap" style="margin-top:8px">' + pct + '% of ' + esc(money(goal)) + ' goal</div>' : '') +
    '</div>'
  ))
  v.appendChild(el('<div class="stat"><div class="cap">Received this month</div><div class="big">' + esc(money(tm.received || 0)) + '</div></div>'))
  if (f.expectedRemaining != null) v.appendChild(el('<div class="stat"><div class="cap">Expected rest of year</div><div class="big">' + esc(money(f.expectedRemaining)) + '</div></div>'))
  if (tm.earnedItems && tm.earnedItems.length) {
    v.appendChild(sectionLabel('Booked this month'))
    tm.earnedItems.forEach(function (it) {
      v.appendChild(el('<div class="card" style="pointer-events:none"><div class="row1"><span class="name" style="font-size:14.5px">' + esc(it.name) + '</span><span class="fee">' + esc(money(it.amount)) + '</span></div></div>'))
    })
  }
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
  if (!ns.length) { v.appendChild(el('<div class="empty">No new alerts. You\'re all caught up.</div>')); return }
  v.appendChild(sectionLabel('New alerts · ' + ns.length))
  ns.forEach(function (n) { v.appendChild(alertCard(n)) })
  v.appendChild(el('<p class="empty" style="padding:14px 10px 0">Swipe an alert left to dismiss it. Opening one leaves it here.</p>'))
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
var MAIL_COUNT_MS = 5 * 60 * 1000
var mailCountTimer = null
function refreshUnreadMail() {
  // The badge counts EXACTLY what the Inbox page shows: unread mail from someone on an active
  // project. It used to count the whole Gmail inbox, which read 201 and meant nothing, because 201
  // is mostly Bark and GigSalad notifications rather than anyone waiting on a reply.
  var queries = buildClientMailQueries('is:unread')
  if (!queries.length) { UNREAD_MAIL = 0; UNREAD_BY_PROJECT = {}; setTabCount('nav-badge-inbox', 0); return Promise.resolve() }
  return gmailUnread(queries)
    .then(function (r) {
      UNREAD_MAIL = r.count
      setTabCount('nav-badge-inbox', r.count)
      // The same fetch also answers "which clients are waiting on me", which is the version of this
      // question that is actually useful on the pipeline. Matching happens here, against contacts
      // the phone already holds, so it costs nothing extra.
      var ix = emailToProjectIndex()
      var by = {}
      r.threads.forEach(function (t) {
        if (!t.unread) return
        var pid = ix[t.fromEmail] || (t.to || []).map(function (e) { return ix[e] }).filter(Boolean)[0] || ''
        if (pid) by[pid] = (by[pid] || 0) + 1
      })
      UNREAD_BY_PROJECT = by
      // Repaint only the list pages, and only when nothing is being typed into or edited: a
      // background repaint that throws away a half-written search box is worse than a stale mark.
      if (!DETAIL_ID && !isEditingActive() && !editorOpen() && (TAB === 'pipeline' || TAB === 'home')) render()
    })
    .catch(function () { /* a mail hiccup must never break the CRM; leave the marks as they were */ })
}
function startMailCount() {
  if (mailCountTimer) return
  refreshUnreadMail()
  mailCountTimer = setInterval(function () {
    if (!document.hidden) refreshUnreadMail()
  }, MAIL_COUNT_MS)
}

function render() {
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
  else if (TAB === 'money') renderMoney()
  var title = $('#pagetitle'); if (title) title.textContent = PAGE_TITLES[TAB] || 'Bloom CRM'
  updateCounts()
  updateDrawerActive()
}

// ---------- drawer navigation ----------
function openDrawer() { var d = $('#drawer'); if (d) { d.classList.remove('hidden'); updateDrawerActive() } }
function closeDrawer() { var d = $('#drawer'); if (d) d.classList.add('hidden') }
function updateDrawerActive() {
  document.querySelectorAll('#drawer-nav button').forEach(function (b) { b.classList.toggle('on', b.dataset.page === TAB) })
}
function navigate(page) {
  DETAIL_ID = null
  TAB = page
  closeDrawer()
  render()
  window.scrollTo(0, 0)
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
function statCard(n, label, page, cls) {
  var c = el('<button class="statcard ' + (cls || '') + '"><div class="n">' + esc(n) + '</div><div class="l">' + esc(label) + '</div></button>')
  c.addEventListener('click', function () { navigate(page) })
  return c
}
function renderHome() {
  var v = $('#view'); v.innerHTML = ''
  var today = todayStr()
  var open = (SNAP.tasks || []).filter(function (t) { return !t.done })
  var overdue = open.filter(function (t) { return dueState(t.dueDate, t.dueTime) === 'overdue' })
  var dueToday = open.filter(function (t) { return dueState(t.dueDate, t.dueTime) === 'due' })
  var end7 = addDays(today, 7)
  var gigs = (SNAP.projects || []).filter(function (p) {
    return p.bucket === 'active' && p.eventDate && p.eventDate >= today && p.eventDate <= end7
  }).sort(function (a, b) { return a.eventDate < b.eventDate ? -1 : 1 })
  var alerts = (SNAP.notifications || []).length

  v.appendChild(el('<div class="greeting">' + esc(greetingText()) +
    '<span class="sub2">' + esc(new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })) + '</span></div>'))

  var grid = el('<div class="statgrid"></div>')
  // Unread mail took the money tile, 2026-09-21. Michael: "I don't expect to use the finance page
  // on my phone", and in the same breath, "I want to be able to see notifications when I have
  // unread emails." Money is still a tap away in the drawer; this tile now answers a question he
  // asked for. It reads 0 until the five-minute poll has run once, which is honest: it is a count
  // of what the app has actually seen.
  grid.appendChild(statCard(String(UNREAD_MAIL), 'Unread email', 'inbox', 's-mail'))
  grid.appendChild(statCard(String(overdue.length), 'Overdue tasks', 'tasks', 's-over'))
  grid.appendChild(statCard(String(dueToday.length), 'Due today', 'tasks', 's-due'))
  grid.appendChild(statCard(String(gigs.length), 'Gigs next 7 days', 'pipeline', 's-gigs'))
  v.appendChild(grid)

  var attention = overdue.concat(dueToday)
  if (attention.length) {
    v.appendChild(sectionLabel('Needs attention · ' + attention.length))
    attention.forEach(function (t) { v.appendChild(taskCard(t, true)) })
  }
  if (gigs.length) {
    v.appendChild(sectionLabel('Next 7 days · ' + gigs.length))
    gigs.forEach(function (p) { v.appendChild(projectCard(p)) })
  }
  if (!attention.length && !gigs.length) {
    v.appendChild(el('<div class="empty" style="padding:38px 10px">Nothing needs you right now. Enjoy it.</div>'))
  }
  if (alerts) {
    v.appendChild(sectionLabel('Alerts'))
    var ac = el('<button class="card"><div class="row1"><span class="name" style="font-size:14.5px">' + alerts + ' new alert' + (alerts > 1 ? 's' : '') + '</span><span class="fee" style="color:var(--faint);font-variant-numeric:normal">View</span></div></button>')
    ac.addEventListener('click', function () { navigate('alerts') })
    v.appendChild(ac)
  }
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
  var b = el('<button class="card"><div class="row1"><span class="name">' +
    (rel ? '<span class="reldot" style="background:' + relColor(rel) + ';margin-right:7px"></span>' : '') +
    esc(c.name || '(no name)') + '</span>' +
    (c.type ? '<span class="fee" style="color:var(--faint);font-variant-numeric:normal">' + esc(c.type) + '</span>' : '') +
    '</div>' + (meta ? '<div class="meta">' + esc(meta) + '</div>' : '') + '</button>')
  b.addEventListener('click', function () { openContactSheet(c) })
  return b
}
function renderContacts() {
  var v = $('#view'); v.innerHTML = ''
  v.appendChild(el('<input class="search" id="cq" placeholder="Search contacts…" />'))
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
      if (!f) return true
      var hay = (c.name + ' ' + (c.emails || []).join(' ') + ' ' + (c.tags || []).join(' ')).toLowerCase()
      return hay.indexOf(f) >= 0 || phoneMatch(c, f)
    })
    items.sort(function (a, b) { return (a.name || '').toLowerCase() < (b.name || '').toLowerCase() ? -1 : 1 })
    list.innerHTML = ''
    if (!items.length) { list.appendChild(el('<div class="empty">No matching contacts.</div>')); return }
    list.appendChild(sectionLabel((CONTACT_FILTER === 'all' ? 'All' : CONTACT_FILTER) + '  ·  ' + items.length))
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
  wrap.appendChild(el('<div class="k">' + esc(label) + '</div><div class="v">' + (String(cur).trim() ? esc(cur) : '<span style="color:var(--faint)">Tap to add</span>') + '</div>'))
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
    kv.appendChild(contactField(c, 'tags', 'Tags', 'text', rebuild))
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
    done.addEventListener('click', close)
    card.appendChild(done)
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
    $('#updated').textContent = 'Updated ' + timeAgo(s.generatedAt)
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
    $('#updated').textContent = 'Updated ' + timeAgo(s.generatedAt)
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
  loadAndRender()
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



export const __app = {
  render, renderDetail, renderInbox, renderTasks, navigate, detailsTab, dayOfCard, emailTab,
  submittedSection, openCompose, openTaskEditor, mapsLinks, fmtTime, countdownText,
  fmtPhoneDisplay, projectEmails, mailWhen, updateCounts, refreshUnreadMail, taskCard, mailRow,
  renderProposals, proposalCard, openPreview, copyText, renderPipeline, projectCard,
  buildClientMailQueries, activeProjectEmails,
  bookingTab, proposalSection, emailToProjectIndex, openNewProject,
  refreshNativePushToken, registerNativePush, updatePushButton,
  setSnap: (s) => { SNAP = s }, setTab: (t) => { TAB = t },
  setPtab: (t) => { PTAB = t }, setDetail: (d) => { DETAIL_ID = d },
  getPtab: () => PTAB, getStage: () => STAGE, setStageMap: (m) => { STAGE = m },
}
