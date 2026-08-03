/* Magic CRM mobile. Logs in with Supabase Auth and reads LIVE data straight from the database (RLS
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
  updateContact,
  loadBookingProgress, loadContractVariants, readyToBookOnPhone,
} from './supabase-data.js'
import { VAPID_PUBLIC_KEY } from './config.js'

var SNAP = null
var TAB = 'home' // current page (drawer destination)
var BUCKET = 'active' // which pipeline segment is showing: 'active' | 'completed' | 'archived'
var CONTACT_FILTER = 'all' // contacts page relationship filter
var COLLAPSED = {} // pipeline section label -> collapsed? (persists per session)
var STAGE = {} // stageId -> { name, umbrella, color }
var DETAIL_ID = null // when non-null, the detail view for this project is on screen (not a tab)

var PAGE_TITLES = { home: 'Home', pipeline: 'Pipeline', contacts: 'Contacts', tasks: 'Tasks', alerts: 'Alerts', money: 'Money' }

// Contact relationship options (mirrors src/contacts.ts RELATIONSHIP_OPTIONS; FISM colors).
var CONTACT_REL = [
  { v: 'active', label: 'Active', color: '#38ccda' },
  { v: 'yes', label: 'Yes', color: '#46d189' },
  { v: 'maybe', label: 'Maybe', color: '#f4b65c' },
  { v: 'no', label: 'No', color: '#f26d63' },
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

// Event detail fields, in desktop order, with label overrides / hidden / deleted applied + customs.
var EVENT_FIELDS = [
  ['eventSummary', 'Description'], ['eventDate', 'Event date'], ['eventStartTime', 'Event start'],
  ['showStartTime', 'Show start'], ['totalFee', 'Quote'], ['numberOfGuests', 'Guest Count'],
  ['ageOfGuests', 'Guest ages'], ['eventLocation', 'Location'], ['venueType', 'Venue type'],
  ['indoorsOrOutdoors', 'Indoors / Outdoors'], ['performanceStyle', 'Performance'],
  ['av', 'AV'], ['vips', 'VIPs'], ['bookingSource', 'Booking source'],
]
function fieldRows(p) {
  var labels = SNAP.eventFieldLabels || {}, hidden = SNAP.eventFieldHidden || [], deleted = SNAP.eventFieldDeleted || []
  var rows = []
  EVENT_FIELDS.forEach(function (f) {
    var id = f[0]
    if (hidden.indexOf(id) >= 0 || deleted.indexOf(id) >= 0) return
    var val = id === 'totalFee' ? money(p.totalFee) : (id === 'eventDate' ? fmtDate(p.eventDate) : p[id])
    if (val == null || String(val).trim() === '') return
    rows.push({ k: labels[id] || f[1], v: val })
  })
  ;(SNAP.customFields || []).forEach(function (cf) {
    var v = (SNAP.customValues[p.id] || {})[cf.id]
    if (v && String(v).trim()) rows.push({ k: cf.label, v: v })
  })
  return rows
}
function stageInfo(id) { return STAGE[id] || { name: '', umbrella: '', color: 'var(--brass)' } }

// ---------- views ----------
// Count projects per bucket for the segmented control.
function bucketCounts() {
  var c = { active: 0, completed: 0, archived: 0 }
  ;(SNAP && SNAP.projects ? SNAP.projects : []).forEach(function (p) { if (c[p.bucket] != null) c[p.bucket]++ })
  return c
}

function renderPipeline() {
  DETAIL_ID = null
  var v = $('#view')
  v.innerHTML = ''
  var pt = $('#pagetitle'); if (pt) pt.textContent = 'Pipeline'

  // Segmented bucket switch: Active / Completed / Archived (with live counts). Completed + Archived
  // are the history the phone was previously blind to.
  var counts = bucketCounts()
  var seg = el('<div class="seg"></div>')
  ;[['active', 'Active'], ['completed', 'Completed'], ['archived', 'Archived']].forEach(function (b) {
    var btn = el('<button' + (BUCKET === b[0] ? ' class="on"' : '') + '>' + b[1] + '<span class="segn">' + counts[b[0]] + '</span></button>')
    btn.addEventListener('click', function () { if (BUCKET !== b[0]) { BUCKET = b[0]; renderPipeline() } })
    seg.appendChild(btn)
  })
  v.appendChild(seg)

  v.appendChild(el('<input class="search" id="q" placeholder="Search ' + BUCKET + ' projects…" />'))
  var list = el('<div id="plist"></div>')
  v.appendChild(list)

  var pool = SNAP.projects.filter(function (p) { return p.bucket === BUCKET })
  function draw(filter) {
    var f = (filter || '').toLowerCase().trim()
    var items = pool.filter(function (p) {
      if (!f) return true
      return (p.client + ' ' + (p.eventLocation || '') + ' ' + (p.eventType || '') + ' ' + (p.contactNames || '')).toLowerCase().indexOf(f) >= 0
    })
    list.innerHTML = ''
    if (!items.length) { list.appendChild(el('<div class="empty">No matching projects.</div>')); return }
    if (BUCKET === 'active') drawActive(list, items)
    else drawRecords(list, items)
  }
  draw('')
  $('#q').addEventListener('input', function (e) { draw(e.target.value) })
  ensureFab() // the "New project" button belongs to the pipeline tab
}

// A phone-palette color per umbrella (the structure's own colors are desktop CSS vars, unavailable
// here). Keyed by role, then by position, so the sections stay visually distinct in the app palette.
function umbrellaColor(u, i) {
  var byRole = { first: '#38ccda', booked: '#46d189', postshow: '#c885e8' }
  if (u && u.role && byRole[u.role]) return byRole[u.role]
  var ramp = ['#38ccda', '#f4b65c', '#46d189', '#c885e8', '#7d8cff']
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
function drawRecords(list, items) {
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
      '<input class="field-input" id="np-cname" placeholder="Contact name" style="margin-top:8px" />' +
      '<div class="addrow"><input class="field-input" id="np-cemail" inputmode="email" placeholder="Contact email" /><input class="field-input" id="np-cphone" inputmode="tel" placeholder="Contact phone" /></div>' +
      '<textarea class="field-input" id="np-notes" rows="2" placeholder="Notes" style="margin-top:8px"></textarea>' +
      '<div class="addrow" style="margin-top:14px"><button class="btn-ghost" id="np-cancel">Cancel</button><button class="btn-gold" id="np-save">Create project</button></div>' +
    '</div></div>'
  )
  var close = function () { sheet.remove() }
  sheet.querySelector('#np-cancel').addEventListener('click', close)
  sheet.addEventListener('click', function (e) { if (e.target === sheet) close() })
  sheet.querySelector('#np-cphone').addEventListener('blur', function (e) { /* light hint; server normalizes on save */ })
  sheet.querySelector('#np-save').addEventListener('click', function () {
    var name = sheet.querySelector('#np-name').value.trim()
    if (!name) { toast('Enter a project name.', 'err'); return }
    var input = {
      clientName: name,
      eventType: sheet.querySelector('#np-type').value,
      stageId: sheet.querySelector('#np-stage').value,
      eventDate: sheet.querySelector('#np-date').value,
      totalFee: sheet.querySelector('#np-fee').value,
      eventLocation: sheet.querySelector('#np-loc').value,
      contactNames: sheet.querySelector('#np-cname').value,
      contactEmails: sheet.querySelector('#np-cemail').value,
      contactPhones: sheet.querySelector('#np-cphone').value,
      projectNotes: sheet.querySelector('#np-notes').value,
    }
    doWrite(createProject(input, SNAP.structure), 'Project created', function (proj) {
      SNAP.projects.push(proj)
      close()
      BUCKET = 'active'
      renderDetail(proj.id)
    })
  })
  document.body.appendChild(sheet)
  setTimeout(function () { var e = sheet.querySelector('#np-name'); if (e) e.focus() }, 40)
}
function sectionLabel(text) { return el('<div class="section-label"><span class="dot"></span>' + esc(text) + '</div>') }
// The status pill for a project card, by bucket: active -> its stage; completed -> "Done · <date>";
// archived -> the archive reason (or "Archived").
function cardPill(p) {
  if (p.bucket === 'completed') {
    var d = p.completedDate || p.eventDate
    return { text: 'Done' + (d ? '  ·  ' + fmtShort(d) : ''), cls: 'done' }
  }
  if (p.bucket === 'archived') return { text: p.archiveReason || 'Archived', cls: 'arch' }
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
    p.activityLog = r.activityLog
    renderDetail(p.id)
  })
}

// Permanent delete (project + its tasks / payments / mileage). Confirm-gated, no undo.
function doDelete(p) {
  if (!confirm('Delete "' + p.client + '" permanently?\n\nThis removes the project and its tasks, payments, and mileage. There is no undo.')) return
  doWrite(deleteProject(p.id), 'Deleted', function () {
    SNAP.projects = SNAP.projects.filter(function (x) { return x.id !== p.id })
    SNAP.tasks = (SNAP.tasks || []).filter(function (t) { return t.projectId !== p.id })
    SNAP.payments = (SNAP.payments || []).filter(function (pm) { return pm.projectId !== p.id })
    DETAIL_ID = null
    renderPipeline()
  })
}

// A small top-bar "panel" chip (Notes / Activity / Actions).
function panelChip(label, svgInner, onClick) {
  var b = el('<button class="panelchip"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' + svgInner + '</svg><span>' + esc(label) + '</span></button>')
  b.addEventListener('click', onClick)
  return b
}
// A full-width row button that opens a panel, with an optional right-aligned hint (count / total).
function panelRow(label, hint, onClick) {
  var b = el('<button class="panelrow"><span class="pr-label">' + esc(label) + '</span>' + (hint ? '<span class="pr-hint">' + esc(hint) + '</span>' : '') + '<svg class="pr-chev" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></button>')
  b.addEventListener('click', onClick)
  return b
}
// Compact, read-only summary of a project's key facts (shown inline; full editing is in the panel).
function eventSummary(p) {
  var rows = []
  if (p.eventDate) rows.push(['Date', fmtDate(p.eventDate)])
  if (p.eventLocation) rows.push(['Location', p.eventLocation])
  if (p.numberOfGuests) rows.push(['Guests', p.numberOfGuests])
  if (p.venueType) rows.push(['Venue', p.venueType])
  if (p.performanceStyle) rows.push(['Performance', p.performanceStyle])
  if (p.eventDescription) rows.push(['Description', p.eventDescription])
  if (!rows.length) return el('<div class="empty" style="padding:6px 2px;text-align:left">No details yet. Tap below to add.</div>')
  var kv = el('<div class="kv"></div>')
  rows.forEach(function (r) { kv.appendChild(el('<div class="item"><div class="k">' + esc(r[0]) + '</div><div class="v">' + esc(r[1]) + '</div></div>')) })
  return kv
}

function renderDetail(id, keepScroll) {
  var p = SNAP.projects.find(function (x) { return x.id === id }); if (!p) return renderPipeline()
  DETAIL_ID = id
  removeFab()
  var v = $('#view'); v.innerHTML = ''
  var pt = $('#pagetitle'); if (pt) pt.textContent = p.client || 'Project'
  var back = el('<button class="back"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>Pipeline</button>')
  back.addEventListener('click', renderPipeline)
  v.appendChild(back)
  var si = stageInfo(p.stageId)
  v.appendChild(el(
    '<div class="detail-head"><div class="client">' + esc(p.client) + '</div>' +
    '<div class="line">' + esc([p.eventType, si.name].filter(Boolean).join('  ·  ')) + '</div>' +
    (p.totalFee != null && p.totalFee !== '' ? '<div class="line" style="color:var(--brass-bright);margin-top:6px">' + esc(money(p.totalFee)) + '</div>' : '') +
    (p.bucket !== 'active' ? '<div class="statusline" style="margin-top:8px">' + esc(statusText(p)) + '</div>' : '') +
    '</div>'
  ))

  // ---- top panel bar: Notes / Activity / Actions (Actions holds Complete·Archive·Delete·Restore) ----
  var bar = el('<div class="panelbar"></div>')
  bar.appendChild(panelChip('Notes', '<path d="M4 7h16M4 12h11M4 17h14"/>', function () { openNotesPanel(p) }))
  bar.appendChild(panelChip('Activity', '<path d="M3 12h4l2.5 7 5-14 2.5 7h4"/>', function () { openActivityPanel(p) }))
  bar.appendChild(panelChip('Actions', '<circle cx="12" cy="5" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.5" fill="currentColor" stroke="none"/>', function () { openActionsPanel(p) }))
  v.appendChild(bar)

  // ---- stage picker (with the desktop gates) — active projects only, kept inline (core action) ----
  if (p.bucket === 'active') {
    v.appendChild(sectionLabel('Stage'))
    v.appendChild(stagePicker(p))
  }

  // ---- contact: kept inline (Call / Text / Email is a primary phone action) ----
  var emails = (p.contactEmails || '').split(/[,;]/).map(function (s) { return s.trim() }).filter(Boolean)
  var phones = (p.contactPhones || '').split(/[,;]/).map(function (s) { return s.trim() }).filter(Boolean)
  v.appendChild(sectionLabel('Contact'))
  var contactCard = el('<div class="card" style="pointer-events:none"></div>')
  contactCard.appendChild(el('<div class="name" style="font-size:14.5px">' + esc(p.contactNames || '(no name)') + '</div>'))
  if (emails.length) contactCard.appendChild(el('<div class="meta">' + esc(emails.join(', ')) + '</div>'))
  if (phones.length) contactCard.appendChild(el('<div class="meta">' + esc(phones.join(', ')) + '</div>'))
  v.appendChild(contactCard)
  var actions = el('<div class="contact"></div>')
  if (phones[0]) actions.appendChild(el('<a href="tel:' + esc(phones[0]) + '">Call</a>'))
  if (phones[0]) actions.appendChild(el('<a href="sms:' + esc(phones[0]) + '">Text</a>'))
  if (emails[0]) actions.appendChild(el('<a href="mailto:' + esc(emails[0]) + '">Email</a>'))
  if (actions.children.length) v.appendChild(actions)
  var editContactBtn = el('<button class="btn-ghost" style="margin-top:8px;width:100%">Edit contact info</button>')
  editContactBtn.addEventListener('click', function () { openContactEditor(p) })
  v.appendChild(editContactBtn)

  // ---- details: compact inline summary, full editing behind a panel ----
  v.appendChild(sectionLabel('Details'))
  v.appendChild(eventSummary(p))
  v.appendChild(panelRow('Edit all details', '', function () { openDetailsPanel(p) }))

  // ---- booking workflow (phase-organized email cards + document placeholders) ----
  v.appendChild(panelRow('Emails & booking', bookingHint(p), function () { openBookingPanel(p) }))

  // ---- tasks + payments: panel buttons with at-a-glance hints ----
  var openTasks = SNAP.tasks.filter(function (t) { return t.projectId === id && !t.done }).length
  v.appendChild(panelRow('Tasks', openTasks ? openTasks + ' open' : 'None', function () { openTasksPanel(p) }))
  var recv = receivedFor(id)
  var pend = (SNAP.payments || []).some(function (x) { return x.projectId === id && x.pending })
  v.appendChild(panelRow('Payments', recv ? money(recv) + ' received' + (pend ? ' · pending' : '') : (pend ? 'Pending' : 'None logged'), function () { openPaymentsPanel(p) }))

  if (!keepScroll) window.scrollTo(0, 0)
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
  { key: 'none', label: 'Sent' },
  { key: 'viewed', label: 'Viewed' },
  { key: 'submitted', label: 'Details in' },
  { key: 'signed', label: 'Signed' },
]

// One-line summary for the collapsed Booking row.
function bookingHint(p) {
  var g = BOOKING_PROGRESS[p.id]
  if (!g) return ''
  if (!g.linkOut) return 'Not sent'
  if (g.stage === 'signed') return 'Signed' + (g.signedName ? ' by ' + g.signedName : '')
  if (g.stage === 'submitted') return 'Details in, not signed'
  if (g.stage === 'viewed') return 'Viewed, nothing back'
  return 'Sent, not viewed'
}

// Cache of live booking progress per project, filled when a project detail opens.
var BOOKING_PROGRESS = {}
function refreshBookingProgress(projectId, then) {
  loadBookingProgress(projectId)
    .then(function (g) { BOOKING_PROGRESS[projectId] = g; if (then) then(g) })
    .catch(function () { /* leave the row blank rather than break the page */ })
}

// The booking sheet: the two gated fields, live progress, and the one button.
function openBookingPanel(p) {
  var sheet = el('<div class="sheet"><div class="sheet-card"></div></div>')
  var card = sheet.querySelector('.sheet-card')
  var close = function () { sheet.remove(); if (DETAIL_ID === p.id) renderDetail(p.id, true) }
  card.appendChild(el('<div class="sheet-title">Booking</div>'))

  var style = String(p.performanceStyle || '').trim()
  var fee = Number(p.totalFee)
  var ready = !!style && !!fee && !isNaN(fee) && fee > 0

  // The two facts the client reads on the agreement. Blank means they'd be looking at a literal
  // "[Performance scope]" on the document they're about to sign.
  var gate = el('<div class="bk-gate' + (ready ? '' : ' bad') + '"></div>')
  gate.appendChild(el('<div class="bk-gate-t">' + (ready ? 'Goes on the agreement' : 'Fill both to send the booking form') + '</div>'))
  gate.appendChild(el('<div class="k">Performance style</div><div class="v">' + (style ? esc(style) : '<span class="miss">Not set</span>') + '</div>'))
  gate.appendChild(el('<div class="k" style="margin-top:8px">Quote</div><div class="v">' + (ready ? esc(money(fee)) : '<span class="miss">Not set</span>') + '</div>'))
  if (!ready) gate.appendChild(el('<div class="hint" style="margin-top:8px">Edit these in Event details.</div>'))
  card.appendChild(gate)

  var body = el('<div></div>')
  card.appendChild(body)

  function draw(g) {
    body.innerHTML = ''
    if (g && g.linkOut) {
      var idx = BOOKING_STEPS.findIndex(function (x) { return x.key === g.stage })
      var bar = el('<div class="bk-prog"></div>')
      BOOKING_STEPS.forEach(function (st, i) {
        var seg = el('<div class="bk-seg' + (i <= idx ? (i === BOOKING_STEPS.length - 1 ? ' done' : ' on') : '') + '"><span class="bk-bar"></span><span class="bk-lab">' + esc(st.label) + '</span></div>')
        bar.appendChild(seg)
      })
      body.appendChild(bar)
      if (g.variant) body.appendChild(el('<div class="hint" style="margin-top:8px">Sent with the <b>' + esc(variantLabel(g.variant)) + '</b> agreement.</div>'))
      if (g.stage === 'signed') body.appendChild(el('<div class="hint" style="margin-top:4px">Their signed copy and the invoice were sent automatically.</div>'))
    } else {
      body.appendChild(el('<div class="hint" style="margin-top:10px">They fill in the event details, sign the agreement, and get invoiced without you touching anything.</div>'))
    }

    var btn = el('<button class="btn-gold" style="width:100%;margin-top:14px"' + (ready ? '' : ' disabled') + '>' + (g && g.linkOut ? 'Resend booking form' : 'Ready to book') + '</button>')
    btn.addEventListener('click', function () { pickVariantThen(p, btn) })
    body.appendChild(btn)
    if (!ready) body.appendChild(el('<div class="hint" style="margin-top:6px">Add a performance style and a quote first.</div>'))

    var done = el('<button class="btn-ghost" style="width:100%;margin-top:8px">Close</button>')
    done.addEventListener('click', close)
    body.appendChild(done)
  }

  draw(BOOKING_PROGRESS[p.id])
  refreshBookingProgress(p.id, draw)

  sheet.addEventListener('click', function (e) { if (e.target === sheet) close() })
  document.body.appendChild(sheet)
}

// Remembered so a label can be shown without another round-trip.
var CONTRACT_VARIANTS = []
function variantLabel(id) {
  var v = CONTRACT_VARIANTS.find(function (x) { return x.variant === id })
  return v ? v.label : id
}

// Choosing WHICH agreement. Two taps rather than one, on purpose: which contract a client signs is
// not a thing to get wrong by muscle memory, and swapping it is the reason a resend exists.
function pickVariantThen(p, btn) {
  btn.disabled = true
  btn.textContent = 'Loading…'
  loadContractVariants()
    .then(function (vs) {
      CONTRACT_VARIANTS = vs
      btn.disabled = false
      btn.textContent = 'Ready to book'
      var sheet = el('<div class="sheet"><div class="sheet-card"></div></div>')
      var card = sheet.querySelector('.sheet-card')
      var close = function () { sheet.remove() }
      card.appendChild(el('<div class="sheet-title">Which agreement?</div>'))
      if (!vs.length) {
        card.appendChild(el('<div class="hint">No contract templates have been published yet. Open the Mac app once and they will appear here.</div>'))
      }
      vs.forEach(function (v) {
        var b = el('<button class="emailcard" style="flex-direction:column;align-items:flex-start;gap:2px"><span class="ec-title">' + esc(v.label) + '</span><span class="hint" style="margin:0">' + esc(v.hint || '') + '</span></button>')
        b.addEventListener('click', function () { close(); sendBooking(p, v) })
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
      btn.textContent = 'Ready to book'
      toast(e.message || 'Could not load the agreements', 'err')
    })
}

// Issue the form and hand back the link. No email is sent: the phone has no Gmail drafting by
// design, so this copies the URL for Michael to send however he likes.
function sendBooking(p, variant) {
  toast('Preparing…')
  readyToBookOnPhone(p, variant.variant)
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
  var stack = el('<div class="actstack"></div>')
  if (p.bucket === 'active') {
    var comp = el('<button class="btn-gold" style="width:100%">Complete project</button>')
    comp.addEventListener('click', function () { close(); openCompleteSheet(p) })
    var arch = el('<button class="btn-ghost" style="width:100%">Archive project</button>')
    arch.addEventListener('click', function () { close(); openArchiveSheet(p) })
    stack.appendChild(comp); stack.appendChild(arch)
  } else {
    var rest = el('<button class="btn-gold" style="width:100%">Return to pipeline</button>')
    rest.addEventListener('click', function () { close(); doRestore(p) })
    stack.appendChild(rest)
  }
  var del = el('<button class="btn-danger">Delete permanently</button>')
  del.addEventListener('click', function () { close(); doDelete(p) })
  stack.appendChild(del)
  card.appendChild(stack)
  var cancel = el('<button class="btn-ghost" style="width:100%;margin-top:12px">Close</button>')
  cancel.addEventListener('click', close)
  card.appendChild(cancel)
  sheet.addEventListener('click', function (e) { if (e.target === sheet) close() })
  document.body.appendChild(sheet)
}

// Notes: the free-text project_notes field.
function openNotesPanel(p) {
  var sheet = el('<div class="sheet"><div class="sheet-card"></div></div>')
  var card = sheet.querySelector('.sheet-card')
  var close = function () { sheet.remove() }
  card.appendChild(el('<div class="sheet-title">Notes</div>'))
  var ta = document.createElement('textarea'); ta.className = 'field-input'; ta.rows = 8; ta.value = p.projectNotes || ''; ta.placeholder = 'Notes about this project…'
  card.appendChild(ta)
  var bar = el('<div class="addrow" style="margin-top:12px"><button class="btn-ghost">Close</button><button class="btn-gold">Save</button></div>')
  bar.children[0].addEventListener('click', close)
  bar.children[1].addEventListener('click', function () {
    var nv = ta.value
    if (nv === (p.projectNotes || '')) { close(); return }
    doWrite(updateProjectField(p.id, 'projectNotes', nv), 'Saved', function (r) { p.projectNotes = r.value; close() })
  })
  card.appendChild(bar)
  sheet.addEventListener('click', function (e) { if (e.target === sheet) close() })
  document.body.appendChild(sheet)
}

// Activity: add a dated note + read the activity log.
function openActivityPanel(p) {
  var sheet = el('<div class="sheet"><div class="sheet-card"></div></div>')
  var card = sheet.querySelector('.sheet-card')
  var close = function () { sheet.remove() }
  card.appendChild(el('<div class="sheet-title">Activity</div>'))
  card.appendChild(addNoteBox(p))
  var logWrap = el('<div id="log-' + esc(p.id) + '"></div>')
  renderLog(logWrap, p)
  card.appendChild(logWrap)
  var done = el('<button class="btn-ghost" style="width:100%;margin-top:12px">Close</button>')
  done.addEventListener('click', close)
  card.appendChild(done)
  sheet.addEventListener('click', function (e) { if (e.target === sheet) close() })
  document.body.appendChild(sheet)
}

// One editable project field, inline within a panel (mirrors contactField but writes a project field).
function projectFieldRow(p, key, label, kind, onSaved) {
  var cur = key === 'projectName' ? (p.client || '') : (p[key] == null ? '' : String(p[key]))
  var disp = (key === 'eventDate' && cur) ? fmtDate(cur) : cur
  var wrap = el('<div class="item kv-tap" style="cursor:pointer"></div>')
  wrap.appendChild(el('<div class="k">' + esc(label) + '</div><div class="v">' + (String(cur).trim() ? esc(disp) : '<span style="color:var(--faint)">Tap to add</span>') + '</div>'))
  wrap.addEventListener('click', function () {
    wrap.innerHTML = ''
    wrap.appendChild(el('<div class="k" style="margin-bottom:5px">' + esc(label) + '</div>'))
    var input = kind === 'textarea' ? document.createElement('textarea') : document.createElement('input')
    input.className = 'field-input'; if (kind === 'date') input.type = 'date'; input.value = cur; if (kind === 'textarea') input.rows = 3
    wrap.appendChild(input)
    var save = function () {
      var nv = input.value
      if (nv === cur) { onSaved(); return }
      doWrite(updateProjectField(p.id, key, nv), 'Saved', function (r) {
        if (key === 'projectName') p.client = r.value; else p[key] = r.value
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

// Details: all the editable event fields.
function openDetailsPanel(p) {
  var sheet = el('<div class="sheet"><div class="sheet-card"></div></div>')
  var card = sheet.querySelector('.sheet-card')
  var close = function () { sheet.remove(); renderDetail(p.id, true) }
  function rebuild() {
    card.innerHTML = ''
    card.appendChild(el('<div class="sheet-title">Edit details</div>'))
    var kv = el('<div class="kv"></div>')
    EDITABLE_DETAIL_FIELDS.forEach(function (f) { kv.appendChild(projectFieldRow(p, f[0], f[1], f[2], rebuild)) })
    card.appendChild(kv)
    var done = el('<button class="btn-gold" style="width:100%;margin-top:14px">Done</button>')
    done.addEventListener('click', close)
    card.appendChild(done)
  }
  rebuild()
  sheet.addEventListener('click', function (e) { if (e.target === sheet) close() })
  document.body.appendChild(sheet)
}

// Tasks for this project (toggle / delete / add).
function openTasksPanel(p) {
  var sheet = el('<div class="sheet"><div class="sheet-card"></div></div>')
  var card = sheet.querySelector('.sheet-card')
  var close = function () { sheet.remove(); renderDetail(p.id, true) }
  function rebuild() {
    card.innerHTML = ''
    var head = el('<div class="tabhead" style="margin:0 0 8px"><div class="sheet-title" style="margin:0">Tasks</div><button class="addbtn" id="pt-add"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>Add</button></div>')
    card.appendChild(head)
    var slot = el('<div></div>'); card.appendChild(slot)
    head.querySelector('#pt-add').addEventListener('click', function () {
      if (slot.firstChild) { slot.innerHTML = ''; return }
      slot.appendChild(addTaskForm(p.id, function () { rebuild() }))
    })
    var ptasks = SNAP.tasks.filter(function (t) { return t.projectId === p.id && !t.done })
    ptasks.sort(function (a, b) { return (a.dueDate || '') < (b.dueDate || '') ? -1 : 1 })
    if (ptasks.length) ptasks.forEach(function (t) { card.appendChild(taskCard(t, false, rebuild)) })
    else card.appendChild(el('<div class="empty" style="padding:12px">No open tasks.</div>'))
    var done = el('<button class="btn-ghost" style="width:100%;margin-top:12px">Close</button>')
    done.addEventListener('click', close)
    card.appendChild(done)
  }
  rebuild()
  sheet.addEventListener('click', function (e) { if (e.target === sheet) close() })
  document.body.appendChild(sheet)
}

// Payments for this project (log deposit / balance / pending).
function openPaymentsPanel(p) {
  var sheet = el('<div class="sheet"><div class="sheet-card"></div></div>')
  var card = sheet.querySelector('.sheet-card')
  var close = function () { sheet.remove(); renderDetail(p.id, true) }
  function rebuild() {
    card.innerHTML = ''
    var head = el('<div class="tabhead" style="margin:0 0 8px"><div class="sheet-title" style="margin:0">Payments</div><button class="addbtn" id="pay-add"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>Log</button></div>')
    card.appendChild(head)
    var slot = el('<div></div>'); card.appendChild(slot)
    head.querySelector('#pay-add').addEventListener('click', function () {
      if (slot.firstChild) { slot.innerHTML = ''; return }
      slot.appendChild(addPaymentForm(p, function () { rebuild() }))
    })
    var pays = (SNAP.payments || []).filter(function (x) { return x.projectId === p.id })
      .sort(function (a, b) { return String(b.dateReceived || '').localeCompare(String(a.dateReceived || '')) })
    if (pays.length) {
      pays.forEach(function (pm) {
        var lbl = [pm.type, pm.method].filter(Boolean).join(' · ')
        card.appendChild(el('<div class="card" style="pointer-events:none"><div class="row1"><span class="name" style="font-size:14.5px">' + esc(money(pm.amount) || String(pm.amount)) + (pm.pending ? ' <span style="color:var(--faint);font-size:12px">(pending)</span>' : '') + '</span><span class="fee" style="color:var(--faint);font-variant-numeric:normal">' + esc(pm.dateReceived ? fmtShort(pm.dateReceived) : '') + '</span></div>' + (lbl ? '<div class="meta">' + esc(lbl) + '</div>' : '') + '</div>'))
      })
    } else card.appendChild(el('<div class="empty" style="padding:12px">No payments logged.</div>'))
    var done = el('<button class="btn-ghost" style="width:100%;margin-top:12px">Close</button>')
    done.addEventListener('click', close)
    card.appendChild(done)
  }
  rebuild()
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

// The stage <select>: shows every stage grouped by umbrella. On change, calls setStage with the
// desktop gates (Post Show blocked; Booked needs a received payment). If a gate throws, the select
// snaps back to the current stage and the error is toasted.
function stagePicker(p) {
  var wrap = el('<div class="card" style="pointer-events:auto"></div>')
  var sel = document.createElement('select')
  sel.className = 'stagesel'
  ;(SNAP.structure.umbrellas || []).forEach(function (u) {
    var og = document.createElement('optgroup')
    og.label = u.label
    ;(u.stages || []).forEach(function (st) {
      var o = document.createElement('option')
      o.value = st.id
      o.textContent = st.name
      if (st.id === p.stageId) o.selected = true
      og.appendChild(o)
    })
    sel.appendChild(og)
  })
  var prev = p.stageId
  sel.addEventListener('change', function () {
    var next = sel.value
    if (next === prev) return
    doWrite(setStage(p.id, next, SNAP.structure, SNAP.payments || []), 'Moved to ' + stageName(next), function () {
      p.stageId = next
      prev = next
      renderDetail(p.id) // refresh the header stage label; pipeline grouping updates on next visit
    }).catch(function () {
      sel.value = prev // gate blocked -> revert the dropdown
    })
  })
  wrap.appendChild(sel)
  return wrap
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
        '<select class="field-input" id="pay-method"><option value="">Method…</option><option>Online (HB)</option><option>Cash</option><option>Check</option><option>PayPal</option><option>Venmo</option><option>CashApp</option><option>Zelle</option></select>' +
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

// A modal sheet to edit the project's contact fields (names / emails / phones on the project row).
// Phones are normalized on save (formatPhoneField), matching the desktop.
function openContactEditor(p) {
  var sheet = el('<div class="sheet"><div class="sheet-card"></div></div>')
  var card = sheet.querySelector('.sheet-card')
  card.appendChild(el('<div class="sheet-title">Edit contact</div>'))
  card.appendChild(el('<div class="k" style="margin-bottom:4px">Names</div>'))
  var nameIn = document.createElement('input'); nameIn.className = 'field-input'; nameIn.value = p.contactNames || ''
  card.appendChild(nameIn)
  card.appendChild(el('<div class="k" style="margin:10px 0 4px">Emails</div>'))
  var emIn = document.createElement('input'); emIn.className = 'field-input'; emIn.value = p.contactEmails || ''
  card.appendChild(emIn)
  card.appendChild(el('<div class="k" style="margin:10px 0 4px">Phones</div>'))
  var phIn = document.createElement('input'); phIn.className = 'field-input'; phIn.value = p.contactPhones || ''
  card.appendChild(phIn)
  card.appendChild(el('<div class="hint">Phone numbers get auto-formatted on save.</div>'))
  var bar = el('<div class="addrow" style="margin-top:12px"><button class="btn-ghost">Cancel</button><button class="btn-gold">Save</button></div>')
  var close = function () { sheet.remove() }
  bar.children[0].addEventListener('click', close)
  bar.children[1].addEventListener('click', function () {
    // Write each changed field (names/emails as-is; phones normalized by updateProjectField).
    var writes = []
    if (nameIn.value !== (p.contactNames || '')) writes.push(updateProjectField(p.id, 'contactNames', nameIn.value).then(function (r) { p.contactNames = r.value }))
    if (emIn.value !== (p.contactEmails || '')) writes.push(updateProjectField(p.id, 'contactEmails', emIn.value).then(function (r) { p.contactEmails = r.value }))
    if (phIn.value !== (p.contactPhones || '')) writes.push(updateProjectField(p.id, 'contactPhones', phIn.value).then(function (r) { p.contactPhones = r.value }))
    if (!writes.length) { close(); return }
    doWrite(Promise.all(writes), 'Contact updated', function () { close(); renderDetail(p.id, true) })
  })
  card.appendChild(bar)
  sheet.addEventListener('click', function (e) { if (e.target === sheet) close() })
  document.body.appendChild(sheet)
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
  if (TAB === 'home') renderHome()
  else if (TAB === 'pipeline') renderPipeline()
  else if (TAB === 'contacts') renderContacts()
  else if (TAB === 'tasks') renderTasks()
  else if (TAB === 'alerts') renderAlerts()
  else if (TAB === 'money') renderMoney()
  var title = $('#pagetitle'); if (title) title.textContent = PAGE_TITLES[TAB] || 'Magic CRM'
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
        row.addEventListener('click', function () { close(); BUCKET = p.bucket; TAB = 'pipeline'; renderDetail(p.id) })
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
