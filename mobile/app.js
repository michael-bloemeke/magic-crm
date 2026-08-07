/* Bloom CRM mobile. Logs in with Supabase Auth and reads LIVE data straight from the database (RLS
   lets the logged-in user read everything; the publishable key alone reads nothing). Login is
   once-per-device (supabase-js persists the session). Read-only for now: the view renders live data;
   writes are a later stage and slot into supabase-data.js behind the load*() functions.

   This file is an ES module (loaded with <script type="module">) so it can import the data layer. */

'use strict'

import {
  loadEverything, dataChangedSinceLastLoad, getSession, signIn, signOut, currentUserEmail,
  addTask, toggleTask, deleteTask, addNote, updateProjectField, addPayment, setStage,
  reloadPaymentsFinance, savePushSubscription,
  createProject, archiveProject, completeProject, restoreProject, deleteProject,
  updateContact, loadContacts, linkOrCreateContact, unlinkContact, loadLinks,
  loadBookingProgress, loadContractVariants, readyToBookOnPhone, resetBookingOnPhone, agreementPdfUrl,
} from './supabase-data.js'
import { VAPID_PUBLIC_KEY } from './config.js'

var SNAP = null
var TAB = 'home' // current page (drawer destination)
var CONTACT_FILTER = 'all' // contacts page relationship filter
var COLLAPSED = {} // pipeline section label -> collapsed? (persists per session)
var STAGE = {} // stageId -> { name, umbrella, color }
var DETAIL_ID = null // when non-null, the detail view for this project is on screen (not a tab)

var PAGE_TITLES = {
  home: 'Home', pipeline: 'Pipeline', completed: 'Completed', archived: 'Archived', deleted: 'Deleted',
  contacts: 'Contacts', tasks: 'Tasks', alerts: 'Alerts', money: 'Money',
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
  ['eventSummary', 'Description'], ['eventDate', 'Event date'], ['eventStartTime', 'Event start'],
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
  var sheet = el(
    '<div class="sheet"><div class="sheet-card">' +
      '<div class="sheet-title">New project</div>' +
      '<input class="field-input" id="np-name" placeholder="Project / client name  *" />' +
      '<div class="addrow" style="margin-top:8px"><select class="field-input" id="np-type">' + typeOpts + '</select>' +
      '<select class="stagesel" id="np-stage">' + stageOpts + '</select></div>' +
      '<div class="addrow"><input class="field-input" id="np-date" type="date" /><input class="field-input" id="np-fee" inputmode="decimal" placeholder="Fee" /></div>' +
      '<input class="field-input" id="np-loc" placeholder="Location" style="margin-top:8px" />' +
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
  var c = el(
    '<button class="card' + (accent ? ' accented' : '') + '">' +
      '<div class="row1"><span class="name">' + esc(p.client) + '</span><span class="fee">' + esc(money(p.totalFee)) + '</span></div>' +
      '<div class="meta">' + esc([p.eventType, p.eventDate ? fmtDate(p.eventDate) : ''].filter(Boolean).join('  ·  ')) + '</div>' +
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
var PROJECT_TABS = [
  ['booking', 'Booking', '<path d="M5 3h11l4 4v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M15 3v5h5"/><path d="M9 13h6M9 17h4"/>'],
  ['details', 'Details', '<path d="M4 5h16M4 12h16M4 19h10"/>'],
  ['tasks', 'Tasks', '<path d="M9 11l3 3L20 6"/><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/>'],
  ['notes', 'Notes', '<path d="M4 4h16v12l-4 4H4z"/><path d="M20 16h-4v4"/>'],
]
var PTAB = 'booking' // which tab of the project view is showing

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

// The contacts on a project, resolved for display. The linked records are the truth; a project whose
// contact was only ever typed in as text (older ones, or built on the Mac before links existed)
// still has a primary worth showing, so fall back to the project's own fields.
function projectContactCards(p) {
  var linked = contactsForProject(p)
  var primaryName = String(p.contactNames || '').trim()
  var hasLinkedPrimary = linked.some(function (c) { return String(c.name || '').trim().toLowerCase() === primaryName.toLowerCase() })
  var cards = linked.map(function (c) {
    return {
      id: c.id,
      contact: c,
      name: c.name || '(no name)',
      emails: (c.emails || []).filter(Boolean),
      phones: (c.phones || []).filter(Boolean),
      primary: !!primaryName && String(c.name || '').trim().toLowerCase() === primaryName.toLowerCase(),
    }
  })
  if (primaryName && !hasLinkedPrimary) {
    cards.unshift({
      id: '',
      contact: null,
      name: primaryName,
      emails: (p.contactEmails || '').split(/[,;]/).map(function (s) { return s.trim() }).filter(Boolean),
      phones: (p.contactPhones || '').split(/[,;]/).map(function (s) { return s.trim() }).filter(Boolean),
      primary: true,
    })
  }
  cards.sort(function (a, b) { return (b.primary ? 1 : 0) - (a.primary ? 1 : 0) })
  return cards
}

// ---- the four tabs ----

// Booking: the send flow plus the money. What is left once stage, contacts, details, tasks and notes
// each have a home of their own.
function bookingTab(p) {
  var wrap = el('<div></div>')
  wrap.appendChild(bookingSection(p))
  wrap.appendChild(paymentsSection(p))
  return wrap
}

// Details: EVERY event field, including the blank ones, which are called out in red. A field you
// have not filled is the thing you most need to see, and a list that silently omits them cannot
// tell you what is missing. Editing stays behind a button: twenty live inputs on a phone is a
// minefield of accidental edits.
function detailsTab(p) {
  var wrap = el('<div></div>')
  wrap.appendChild(sectionLabel('Event details'))
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
      // Only a linked contact has a join row to delete. A text-only primary is edited in Event details.
      if (row.id) {
        var x = el('<button class="cc-x" aria-label="Remove from project"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button>')
        x.addEventListener('click', function () { detachContactFromProject(p, row.contact, rebuild) })
        head.appendChild(x)
      }
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
    var input = kind === 'textarea' ? document.createElement('textarea') : document.createElement('input')
    input.className = 'field-input'
    input.value = cur
    if (kind === 'date') input.type = 'date'
    if (kind === 'money') input.inputMode = 'decimal'
    if (kind === 'textarea') input.rows = 3
    input.placeholder = 'Not set'
    // Save on blur only, and only when it actually changed. Saving per keystroke would fire a write
    // for every letter typed on a phone keyboard.
    input.addEventListener('blur', function () {
      var nv = input.value
      if (nv === cur) return
      doWrite(updateProjectField(p.id, key, nv), 'Saved', function (r) {
        if (key === 'projectName') p.client = r.value; else p[key] = r.value
        cur = r.value == null ? '' : String(r.value)
        input.value = cur
        dirty = true
      }).catch(function () { input.value = cur })
    })
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
  ['eventStartTime', 'Event start', 'text'],
  ['showStartTime', 'Show start', 'text'],
  ['eventLocation', 'Location', 'text'],
  ['venueType', 'Venue type', 'text'],
  ['indoorsOrOutdoors', 'Indoors / Outdoors', 'text'],
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
  var hasPrimary = !!String(p.contactNames || '').trim()
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
      if (!hasPrimary) {
        // First person on the project becomes the primary.
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
// If the one being removed IS the primary, the next remaining contact is promoted into the project's
// contact fields. Leaving a project with contacts attached but a stale name in contact_names would
// send the next contract to somebody who is no longer on the job.
function detachContactFromProject(p, contact, after) {
  if (!confirm('Remove ' + (contact.name || 'this contact') + ' from "' + p.client + '"?\n\nThey stay in your Contacts, they are just no longer on this project.')) return
  var redraw = after || function () { if (DETAIL_ID === p.id) renderDetail(p.id, true) }
  var wasPrimary = String(p.contactNames || '').trim().toLowerCase() === String(contact.name || '').trim().toLowerCase()
  doWrite(
    unlinkContact(p.id, contact.id).then(function () {
      forgetLinkLocally(p.id, contact.id)
      if (!wasPrimary) return
      var next = contactsForProject(p)[0]
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
  if (showProject) {
    var body = c.querySelector('.taskbody')
    body.addEventListener('click', function () { renderDetail(t.projectId) })
  }
  return c
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
  if (!open.length) { v.appendChild(el('<div class="empty">No open tasks. Nice.</div>')); return }
  if (overdue.length) { v.appendChild(sectionLabel('Overdue · ' + overdue.length)); overdue.forEach(function (t) { v.appendChild(taskCard(t, true)) }) }
  if (today.length) { v.appendChild(sectionLabel('Today · ' + today.length)); today.forEach(function (t) { v.appendChild(taskCard(t, true)) }) }
  if (upcoming.length) { v.appendChild(sectionLabel('Upcoming · ' + upcoming.length)); upcoming.forEach(function (t) { v.appendChild(taskCard(t, true)) }) }
  if (nodate.length) { v.appendChild(sectionLabel('No due date · ' + nodate.length)); nodate.forEach(function (t) { v.appendChild(taskCard(t, true)) }) }
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
  return c
}
function renderAlerts() {
  var v = $('#view'); v.innerHTML = ''
  var ns = (SNAP.notifications || []).slice().sort(function (a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')) })
  if (!ns.length) { v.appendChild(el('<div class="empty">No new alerts. You\'re all caught up.</div>')); return }
  v.appendChild(sectionLabel('New alerts · ' + ns.length))
  ns.forEach(function (n) { v.appendChild(alertCard(n)) })
  v.appendChild(el('<p class="empty" style="padding:14px 10px 0">Alerts clear when you address them in the desktop app.</p>'))
}

function dueCount() {
  var t = todayStr()
  return (SNAP && SNAP.tasks ? SNAP.tasks : []).filter(function (x) { return !x.done && x.dueDate && x.dueDate <= t }).length
}
function setTabCount(id, n) {
  var e = $('#' + id); if (!e) return
  if (n > 0) { e.textContent = n > 99 ? '99+' : String(n); e.classList.remove('hidden') } else e.classList.add('hidden')
}
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
  // Number on the home-screen app icon = new alerts + tasks needing attention.
  try {
    if (navigator.setAppBadge) {
      var total = alerts + due
      if (total > 0) navigator.setAppBadge(total)
      else if (navigator.clearAppBadge) navigator.clearAppBadge()
    }
  } catch (e) { /* badge unsupported */ }
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
  var earned = (SNAP.finance && SNAP.finance.thisMonth && SNAP.finance.thisMonth.earned) || 0
  var alerts = (SNAP.notifications || []).length

  v.appendChild(el('<div class="greeting">' + esc(greetingText()) +
    '<span class="sub2">' + esc(new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })) + '</span></div>'))

  var grid = el('<div class="statgrid"></div>')
  grid.appendChild(statCard(money(earned) || '$0', 'Earned this month', 'money', 's-money'))
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

// ---------- web push (notifications from this app) ----------
function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}
function updatePushButton() {
  var btn = $('#enable-push')
  if (!btn) return
  // Show the bell when push is usable, we have the VAPID key, and this device isn't already subscribed
  // (or permission hasn't been permanently denied). Once subscribed (localStorage flag), hide it. No
  // passcode gate anymore: the subscribe write is authenticated by the logged-in Supabase session.
  var show = pushSupported() && VAPID_PUBLIC_KEY &&
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
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(function () {})
}

// Show the app, hide the login screen, and load live data.
function enterApp() {
  $('#login').classList.add('hidden')
  $('#app').classList.remove('hidden')
  wireUI()
  loadAndRender()
  startAutoRefresh() // keep the phone's data live (interval + focus/visibility), like the desktop
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
