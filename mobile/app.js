/* Magic CRM mobile (read-only). Renders a snapshot the Mac syncs to the cloud. No write paths.
   Local dev: served at /m/, reads /api/snapshot. Deployed: reads ./snapshot.json next to the app. */

'use strict'

// The passcode is verified server-side: it's sent to /api/snapshot, which only returns data when it
// matches. Locally (dev server, no function) the snapshot route ignores the code so preview is open.
var CODE = ''
var SNAP = null
var TAB = 'pipeline'
var STAGE = {} // stageId -> { name, umbrella, color }

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
function dueState(dateStr) {
  if (!dateStr) return null
  var t = todayStr()
  if (dateStr < t) return 'overdue'
  if (dateStr === t) return 'due'
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
function renderPipeline() {
  var v = $('#view')
  var active = SNAP.projects.filter(function (p) { return p.bucket === 'active' })
  v.innerHTML = ''
  v.appendChild(el('<input class="search" id="q" placeholder="Search clients, venues…" />'))
  var list = el('<div id="plist"></div>')
  v.appendChild(list)
  function draw(filter) {
    var f = (filter || '').toLowerCase().trim()
    var items = active.filter(function (p) {
      if (!f) return true
      return (p.client + ' ' + (p.eventLocation || '') + ' ' + (p.eventType || '')).toLowerCase().indexOf(f) >= 0
    })
    // group by umbrella in structure order
    list.innerHTML = ''
    if (!items.length) { list.appendChild(el('<div class="empty">No matching projects.</div>')); return }
    var order = (SNAP.structure.umbrellas || []).map(function (u) { return u.id })
    var groups = {}
    items.forEach(function (p) {
      var si = stageInfo(p.stageId)
      var key = si.umbrella || 'Other'
      ;(groups[key] = groups[key] || []).push(p)
    })
    var seen = {}
    ;(SNAP.structure.umbrellas || []).forEach(function (u) {
      var g = groups[u.label]; if (!g) return
      seen[u.label] = true
      list.appendChild(sectionLabel(u.label + '  ·  ' + g.length))
      g.forEach(function (p) { list.appendChild(projectCard(p)) })
    })
    Object.keys(groups).forEach(function (k) { if (!seen[k]) { list.appendChild(sectionLabel(k)); groups[k].forEach(function (p) { list.appendChild(projectCard(p)) }) } })
  }
  draw('')
  $('#q').addEventListener('input', function (e) { draw(e.target.value) })
}
function sectionLabel(text) { return el('<div class="section-label"><span class="dot"></span>' + esc(text) + '</div>') }
function projectCard(p) {
  var si = stageInfo(p.stageId)
  var c = el(
    '<button class="card">' +
      '<div class="row1"><span class="name">' + esc(p.client) + '</span><span class="fee">' + esc(money(p.totalFee)) + '</span></div>' +
      '<div class="meta">' + esc([p.eventType, p.eventDate ? fmtDate(p.eventDate) : ''].filter(Boolean).join('  ·  ')) + '</div>' +
      (si.name ? '<span class="pill">' + esc(si.name) + '</span>' : '') +
    '</button>'
  )
  c.addEventListener('click', function () { renderDetail(p.id) })
  return c
}

function renderDetail(id) {
  var p = SNAP.projects.find(function (x) { return x.id === id }); if (!p) return renderPipeline()
  var v = $('#view'); v.innerHTML = ''
  var back = el('<button class="back"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>Pipeline</button>')
  back.addEventListener('click', renderPipeline)
  v.appendChild(back)
  var si = stageInfo(p.stageId)
  v.appendChild(el(
    '<div class="detail-head"><div class="client">' + esc(p.client) + '</div>' +
    '<div class="line">' + esc([p.eventType, si.name].filter(Boolean).join('  ·  ')) + '</div>' +
    (p.totalFee != null && p.totalFee !== '' ? '<div class="line" style="color:var(--brass-bright);margin-top:6px">' + esc(money(p.totalFee)) + '</div>' : '') +
    '</div>'
  ))

  // contacts
  var emails = (p.contactEmails || '').split(/[,;]/).map(function (s) { return s.trim() }).filter(Boolean)
  var phones = (p.contactPhones || '').split(/[,;]/).map(function (s) { return s.trim() }).filter(Boolean)
  if (p.contactNames || emails.length || phones.length) {
    v.appendChild(sectionLabel('Contact'))
    if (p.contactNames) v.appendChild(el('<div class="card" style="pointer-events:none">' + esc(p.contactNames) + '</div>'))
    var actions = el('<div class="contact"></div>')
    if (phones[0]) actions.appendChild(el('<a href="tel:' + esc(phones[0]) + '">Call</a>'))
    if (phones[0]) actions.appendChild(el('<a href="sms:' + esc(phones[0]) + '">Text</a>'))
    if (emails[0]) actions.appendChild(el('<a href="mailto:' + esc(emails[0]) + '">Email</a>'))
    if (actions.children.length) v.appendChild(actions)
  }

  // event details
  var rows = fieldRows(p)
  if (rows.length) {
    v.appendChild(sectionLabel('Event details'))
    var kv = el('<div class="kv"></div>')
    rows.forEach(function (r) { kv.appendChild(el('<div class="item"><div class="k">' + esc(r.k) + '</div><div class="v">' + esc(r.v) + '</div></div>')) })
    v.appendChild(kv)
  }

  // notes
  if (p.projectNotes && p.projectNotes.trim()) {
    v.appendChild(sectionLabel('Notes'))
    v.appendChild(el('<div class="card" style="pointer-events:none;white-space:pre-wrap">' + esc(p.projectNotes) + '</div>'))
  }

  // tasks for this project
  var tasks = SNAP.tasks.filter(function (t) { return t.projectId === id && !t.done })
  if (tasks.length) {
    v.appendChild(sectionLabel('Open tasks'))
    tasks.sort(function (a, b) { return (a.dueDate || '') < (b.dueDate || '') ? -1 : 1 })
    tasks.forEach(function (t) { v.appendChild(taskCard(t, false)) })
  }

  // activity log
  if (Array.isArray(p.activityLog) && p.activityLog.length) {
    v.appendChild(sectionLabel('Activity'))
    var wrap = el('<div></div>')
    p.activityLog.slice(0, 15).forEach(function (line) { wrap.appendChild(el('<div class="log">' + esc(typeof line === 'string' ? line : (line && line.text) || JSON.stringify(line)) + '</div>')) })
    v.appendChild(wrap)
  }
  window.scrollTo(0, 0)
}

function taskCard(t, showProject) {
  var st = dueState(t.dueDate)
  var pName = ''
  if (showProject) { var pr = SNAP.projects.find(function (x) { return x.id === t.projectId }); pName = pr ? pr.client : t.projectId }
  var c = el(
    '<button class="card">' +
      '<div class="name" style="font-size:14.5px">' + esc(t.title || 'Task') + '</div>' +
      (showProject ? '<div class="meta">' + esc(pName) + '</div>' : '') +
      (t.dueDate ? '<span class="pill ' + (st || '') + '">' + (st === 'overdue' ? 'Overdue · ' : st === 'due' ? 'Due today' : 'Due ') + (st === 'due' ? '' : esc(fmtShort(t.dueDate))) + '</span>' : '') +
    '</button>'
  )
  if (showProject) c.addEventListener('click', function () { renderDetail(t.projectId) })
  else c.style.pointerEvents = 'none'
  return c
}

function renderTasks() {
  var v = $('#view'); v.innerHTML = ''
  var open = SNAP.tasks.filter(function (t) { return !t.done && t.dueDate })
  open.sort(function (a, b) { return a.dueDate < b.dueDate ? -1 : 1 })
  var overdue = open.filter(function (t) { return dueState(t.dueDate) === 'overdue' })
  var today = open.filter(function (t) { return dueState(t.dueDate) === 'due' })
  var upcoming = open.filter(function (t) { return !dueState(t.dueDate) })
  if (!open.length) { v.appendChild(el('<div class="empty">No open tasks with due dates. Nice.</div>')); return }
  if (overdue.length) { v.appendChild(sectionLabel('Overdue · ' + overdue.length)); overdue.forEach(function (t) { v.appendChild(taskCard(t, true)) }) }
  if (today.length) { v.appendChild(sectionLabel('Today · ' + today.length)); today.forEach(function (t) { v.appendChild(taskCard(t, true)) }) }
  if (upcoming.length) { v.appendChild(sectionLabel('Upcoming · ' + upcoming.length)); upcoming.forEach(function (t) { v.appendChild(taskCard(t, true)) }) }
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

function render() {
  if (TAB === 'pipeline') renderPipeline()
  else if (TAB === 'tasks') renderTasks()
  else if (TAB === 'money') renderMoney()
  document.querySelectorAll('nav.tabbar button').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === TAB) })
}

// ---------- data ----------
// Tries the deployed passcode-gated function first; 401 = wrong code; 404 = local dev (the dev
// server's open /api/snapshot route, which ignores the code) so previewing on the Mac stays easy.
function fetchSnapshot() {
  var q = CODE ? '?code=' + encodeURIComponent(CODE) : ''
  return fetch('./api/snapshot' + q, { cache: 'no-store' }).then(function (r) {
    if (r.status === 401) { var e = new Error('unauthorized'); e.unauth = true; throw e }
    if (r.status === 404) return fetch('/api/snapshot', { cache: 'no-store' }).then(function (r2) { return r2.json() })
    if (!r.ok) throw new Error('http ' + r.status)
    return r.json()
  })
}
function applySnapshot(s) {
  SNAP = s
  STAGE = {}
  ;(s.structure.umbrellas || []).forEach(function (u) { (u.stages || []).forEach(function (st) { STAGE[st.id] = { name: st.name, umbrella: u.label, color: u.color } }) })
}
// Resolves 'ok' | 'unauth' | 'error'.
function loadAndRender() {
  $('#updated').textContent = 'Refreshing…'
  return fetchSnapshot().then(function (s) {
    applySnapshot(s)
    $('#updated').textContent = 'Updated ' + timeAgo(s.generatedAt)
    render()
    return 'ok'
  }).catch(function (e) {
    if (e && e.unauth) return 'unauth'
    $('#view').innerHTML = '<div class="empty">Could not load data.<br>' + esc(String((e && e.message) || e)) + '</div>'
    $('#updated').textContent = 'Offline'
    return 'error'
  })
}

// ---------- boot ----------
var wired = false
function wireUI() {
  if (wired) return
  wired = true
  document.querySelectorAll('nav.tabbar button').forEach(function (b) {
    b.addEventListener('click', function () { TAB = b.dataset.tab; render(); window.scrollTo(0, 0) })
  })
  $('#refresh').addEventListener('click', loadAndRender)
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(function () {})
}

function unlock() {
  var lock = $('#lock'), pin = $('#pin'), err = $('#pinerr'), btn = $('#unlock-btn')
  // Stays logged in across launches (localStorage). The data is gated server-side; the phone itself
  // is the outer lock. To sign out, clear site data.
  var saved = localStorage.getItem('mcrm_code')
  if (saved) {
    CODE = saved
    lock.classList.add('hidden')
    wireUI()
    loadAndRender()
    return
  }
  lock.classList.remove('hidden')
  pin.focus()
  // Explicit submit (no guessing the passcode length): the Unlock button or Enter.
  function attempt() {
    var v = (pin.value || '').trim()
    if (!v) return
    err.textContent = 'Checking…'
    CODE = v
    loadAndRender().then(function (res) {
      if (res === 'ok') {
        localStorage.setItem('mcrm_code', CODE)
        err.textContent = ''
        lock.classList.add('hidden')
        wireUI()
      } else if (res === 'unauth') {
        err.textContent = 'Wrong passcode'
        pin.value = ''
        CODE = ''
        pin.focus()
      } else {
        err.textContent = 'Could not connect. Try again.'
      }
    })
  }
  btn.addEventListener('click', attempt)
  pin.addEventListener('keydown', function (e) { if (e.key === 'Enter') attempt() })
}

document.addEventListener('DOMContentLoaded', unlock)
