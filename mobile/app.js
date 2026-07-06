/* Magic CRM mobile. Logs in with Supabase Auth and reads LIVE data straight from the database (RLS
   lets the logged-in user read everything; the publishable key alone reads nothing). Login is
   once-per-device (supabase-js persists the session). Read-only for now: the view renders live data;
   writes are a later stage and slot into supabase-data.js behind the load*() functions.

   This file is an ES module (loaded with <script type="module">) so it can import the data layer. */

'use strict'

import {
  loadEverything, getSession, signIn, signOut, currentUserEmail,
  addTask, toggleTask, deleteTask, addNote, updateProjectField, addPayment, setStage,
  reloadPaymentsFinance,
} from './supabase-data.js'
import { VAPID_PUBLIC_KEY, PUSH_SUBSCRIBE_CODE } from './config.js'

var SNAP = null
var TAB = 'pipeline'
var STAGE = {} // stageId -> { name, umbrella, color }
var DETAIL_ID = null // when non-null, the detail view for this project is on screen (not a tab)

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
function renderPipeline() {
  DETAIL_ID = null
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
  DETAIL_ID = id
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

  // ---- stage picker (with the desktop gates) ----
  v.appendChild(sectionLabel('Stage'))
  v.appendChild(stagePicker(p))

  // ---- contacts (Call/Text/Email + inline edit) ----
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
  // Edit the project's contact fields (names/emails/phones on the PROJECT row; phones get normalized).
  var editContactBtn = el('<button class="btn-ghost" style="margin-top:8px;width:100%">Edit contact info</button>')
  editContactBtn.addEventListener('click', function () { openContactEditor(p) })
  v.appendChild(editContactBtn)

  // ---- event details (tap any row to edit; only the safe/allow-listed fields are editable) ----
  v.appendChild(sectionLabel('Event details'))
  v.appendChild(detailFieldsEditor(p))

  // ---- notes: the free-text project_notes field (editable) ----
  v.appendChild(sectionLabel('Notes'))
  v.appendChild(editableField(p, 'projectNotes', 'Notes', p.projectNotes || '', 'textarea', true))

  // ---- activity log + add a dated note entry ----
  v.appendChild(sectionLabel('Activity'))
  v.appendChild(addNoteBox(p))
  var logWrap = el('<div id="log-' + esc(p.id) + '"></div>')
  renderLog(logWrap, p)
  v.appendChild(logWrap)

  // ---- tasks for this project (toggle / delete / add) ----
  var thead = el('<div class="tabhead" style="margin-top:18px"><div class="section-label" style="margin:0"><span class="dot"></span>Tasks</div><button class="addbtn" id="add-ptask"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>Add</button></div>')
  v.appendChild(thead)
  var pFormSlot = el('<div></div>')
  v.appendChild(pFormSlot)
  thead.querySelector('#add-ptask').addEventListener('click', function () {
    if (pFormSlot.firstChild) { pFormSlot.innerHTML = ''; return }
    pFormSlot.appendChild(addTaskForm(p.id))
  })
  var ptasks = SNAP.tasks.filter(function (t) { return t.projectId === id && !t.done })
  ptasks.sort(function (a, b) { return (a.dueDate || '') < (b.dueDate || '') ? -1 : 1 })
  if (ptasks.length) ptasks.forEach(function (t) { v.appendChild(taskCard(t, false)) })
  else v.appendChild(el('<div class="empty" style="padding:12px">No open tasks.</div>'))

  // ---- payments: log a deposit / balance for this project ----
  var mhead = el('<div class="tabhead" style="margin-top:18px"><div class="section-label" style="margin:0"><span class="dot"></span>Payments</div><button class="addbtn" id="add-pay"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>Log payment</button></div>')
  v.appendChild(mhead)
  var payFormSlot = el('<div></div>')
  v.appendChild(payFormSlot)
  mhead.querySelector('#add-pay').addEventListener('click', function () {
    if (payFormSlot.firstChild) { payFormSlot.innerHTML = ''; return }
    payFormSlot.appendChild(addPaymentForm(p))
  })
  var pays = (SNAP.payments || []).filter(function (x) { return x.projectId === id })
    .sort(function (a, b) { return String(b.dateReceived || '').localeCompare(String(a.dateReceived || '')) })
  if (pays.length) {
    pays.forEach(function (pm) {
      var lbl = [pm.type, pm.method].filter(Boolean).join(' · ')
      v.appendChild(el('<div class="card" style="pointer-events:none"><div class="row1"><span class="name" style="font-size:14.5px">' + esc(money(pm.amount) || String(pm.amount)) + (pm.pending ? ' <span style="color:var(--faint);font-size:12px">(pending)</span>' : '') + '</span><span class="fee" style="color:var(--faint);font-variant-numeric:normal">' + esc(pm.dateReceived ? fmtShort(pm.dateReceived) : '') + '</span></div>' + (lbl ? '<div class="meta">' + esc(lbl) + '</div>' : '') + '</div>'))
    })
  } else v.appendChild(el('<div class="empty" style="padding:12px">No payments logged.</div>'))

  window.scrollTo(0, 0)
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

// A single editable field. Tapping the value turns it into an input/textarea; saving on blur (or the
// Save button for textareas) writes via updateProjectField and patches the project object in place.
// `field` is the camelCase key on the project AND the key updateProjectField expects.
function editableField(p, field, label, value, kind, fullCard) {
  var container = el('<div class="' + (fullCard ? 'card' : 'kv-edit') + '"></div>')
  var display = el('<div class="edit-display"><div class="k">' + esc(label) + '</div><div class="v">' + (String(value).trim() ? esc(value) : '<span style="color:var(--faint)">Tap to add</span>') + '</div><span class="pencil">✎</span></div>')
  container.appendChild(display)
  display.addEventListener('click', function () {
    container.innerHTML = ''
    var input = kind === 'textarea' ? document.createElement('textarea') : document.createElement('input')
    input.className = 'field-input'
    if (kind === 'date') input.type = 'date'
    if (kind === 'number') { input.type = 'text'; input.inputMode = 'decimal' }
    input.value = value == null ? '' : String(value)
    if (kind === 'textarea') input.rows = 4
    container.appendChild(el('<div class="k" style="margin-bottom:5px">' + esc(label) + '</div>'))
    container.appendChild(input)
    var save = function () {
      var nv = input.value
      if (nv === String(value == null ? '' : value)) { renderDetail(p.id); return }
      doWrite(updateProjectField(p.id, field, nv), 'Saved', function (r) {
        p[field] = r.value
        renderDetail(p.id)
      }).catch(function () { renderDetail(p.id) })
    }
    if (kind === 'textarea') {
      var bar = el('<div class="addrow" style="margin-top:8px"><button class="btn-ghost">Cancel</button><button class="btn-gold">Save</button></div>')
      bar.children[0].addEventListener('click', function () { renderDetail(p.id) })
      bar.children[1].addEventListener('click', save)
      container.appendChild(bar)
    } else {
      input.addEventListener('blur', save)
    }
    setTimeout(function () { input.focus() }, 30)
  })
  return container
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
function detailFieldsEditor(p) {
  var wrap = el('<div class="kv"></div>')
  EDITABLE_DETAIL_FIELDS.forEach(function (f) {
    var key = f[0]
    var val = key === 'projectName' ? (p.client || '') : (p[key] == null ? '' : p[key])
    var display = key === 'eventDate' && val ? fmtDate(val) : val
    var item = el('<div class="item kv-tap"><div class="k">' + esc(f[1]) + '</div><div class="v">' + (String(val).trim() ? esc(display) : '<span style="color:var(--faint)">Tap to add</span>') + '</div></div>')
    item.addEventListener('click', function () { openFieldSheet(p, key, f[1], f[2]) })
    wrap.appendChild(item)
  })
  return wrap
}

// A tiny modal sheet to edit one field (used by the event-details rows). Writes on Save.
function openFieldSheet(p, field, label, kind) {
  var curVal = field === 'projectName' ? (p.client || '') : (p[field] == null ? '' : String(p[field]))
  var sheet = el('<div class="sheet"><div class="sheet-card"></div></div>')
  var card = sheet.querySelector('.sheet-card')
  card.appendChild(el('<div class="sheet-title">' + esc(label) + '</div>'))
  var input = kind === 'textarea' ? document.createElement('textarea') : document.createElement('input')
  input.className = 'field-input'
  if (kind === 'date') input.type = 'date'
  input.value = curVal
  if (kind === 'textarea') input.rows = 4
  card.appendChild(input)
  if (field === 'contactPhones') card.appendChild(el('<div class="hint">Phone numbers get auto-formatted on save.</div>'))
  var bar = el('<div class="addrow" style="margin-top:12px"><button class="btn-ghost">Cancel</button><button class="btn-gold">Save</button></div>')
  var close = function () { sheet.remove() }
  bar.children[0].addEventListener('click', close)
  bar.children[1].addEventListener('click', function () {
    var nv = input.value
    if (nv === curVal) { close(); return }
    doWrite(updateProjectField(p.id, field, nv), 'Saved', function (r) {
      if (field === 'projectName') p.client = r.value
      else p[field] = r.value
      close()
      renderDetail(p.id)
    })
  })
  card.appendChild(bar)
  sheet.addEventListener('click', function (e) { if (e.target === sheet) close() })
  document.body.appendChild(sheet)
  setTimeout(function () { input.focus() }, 40)
}

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
function addPaymentForm(p) {
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
      // Refresh the ledger + finance so the Money tab and the stage gate see the new payment.
      reloadPaymentsFinance(SNAP.projects, SNAP.config).then(function (r) {
        SNAP.payments = r.payments
        SNAP.finance = r.finance
        renderDetail(p.id)
      }).catch(function () { renderDetail(p.id) })
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
    doWrite(Promise.all(writes), 'Contact updated', function () { close(); renderDetail(p.id) })
  })
  card.appendChild(bar)
  sheet.addEventListener('click', function (e) { if (e.target === sheet) close() })
  document.body.appendChild(sheet)
}

// A task row with a tap-to-toggle checkbox on the left, the title/meta in the middle (tapping the
// body opens the project when showProject), and a delete (x) on the right. Toggling checks it off
// (crm rule: done=true), which removes it from the open lists on the next render.
function taskCard(t, showProject) {
  var st = dueState(t.dueDate)
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
      refreshView()
    })
  })
  var del = c.querySelector('.taskdel')
  del.addEventListener('click', function (ev) {
    ev.stopPropagation()
    if (!confirm('Delete this task?')) return
    doWrite(deleteTask(t.id), 'Task deleted', function () {
      SNAP.tasks = SNAP.tasks.filter(function (x) { return x.id !== t.id })
      refreshView()
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
  var overdue = dated.filter(function (t) { return dueState(t.dueDate) === 'overdue' })
  var today = dated.filter(function (t) { return dueState(t.dueDate) === 'due' })
  var upcoming = dated.filter(function (t) { return !dueState(t.dueDate) })
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
  var c = el(
    '<button class="card">' +
      '<div class="row1"><span class="name" style="font-size:14.5px">' + esc(n.label || 'Update') + '</span>' +
      '<span class="fee" style="color:var(--faint);font-variant-numeric:normal">' + esc(timeAgo(n.createdAt)) + '</span></div>' +
      (n.projectName ? '<div class="meta">' + esc(n.projectName) + '</div>' : '') +
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
  setTabCount('count-alerts', alerts)
  setTabCount('count-tasks', due)
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
  if (TAB === 'pipeline') renderPipeline()
  else if (TAB === 'alerts') renderAlerts()
  else if (TAB === 'tasks') renderTasks()
  else if (TAB === 'money') renderMoney()
  updateCounts()
  document.querySelectorAll('nav.tabbar button').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === TAB) })
}

// ---------- data ----------
// Builds the STAGE lookup (stageId -> { name, umbrella, color }) from the pipeline structure, exactly
// as the old snapshot path did.
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

// ---------- web push (notifications from this app) ----------
function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}
function updatePushButton() {
  var btn = $('#enable-push')
  if (!btn) return
  // Show the bell only when push is usable AND the subscribe endpoint is wired (a passcode is set in
  // config.js). Until the deploy configures that, keep it hidden.
  var show = pushSupported() && VAPID_PUBLIC_KEY && PUSH_SUBSCRIBE_CODE &&
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
function enablePush() {
  if (!pushSupported()) {
    alert('To get notifications, add this app to your Home Screen first (Share, then Add to Home Screen), then open it from there and try again.')
    return
  }
  if (!VAPID_PUBLIC_KEY || !PUSH_SUBSCRIBE_CODE) {
    alert('Notifications are not set up yet on the server side.')
    return
  }
  Notification.requestPermission().then(function (perm) {
    if (perm !== 'granted') {
      alert('Notifications were not allowed.')
      return
    }
    return navigator.serviceWorker.ready
      .then(function (reg) {
        return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(VAPID_PUBLIC_KEY) })
      })
      .then(function (sub) {
        return fetch('./api/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: PUSH_SUBSCRIBE_CODE, subscription: sub }) })
      })
      .then(function (r) {
        if (!r.ok) throw new Error('register failed')
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
  document.querySelectorAll('nav.tabbar button').forEach(function (b) {
    b.addEventListener('click', function () { DETAIL_ID = null; TAB = b.dataset.tab; render(); window.scrollTo(0, 0) })
  })
  $('#refresh').addEventListener('click', loadAndRender)
  var ep = $('#enable-push')
  if (ep) ep.addEventListener('click', enablePush)
  var lo = $('#logout')
  if (lo) lo.addEventListener('click', doLogout)
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(function () {})
}

// Show the app, hide the login screen, and load live data.
function enterApp() {
  $('#login').classList.add('hidden')
  $('#app').classList.remove('hidden')
  wireUI()
  loadAndRender()
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
