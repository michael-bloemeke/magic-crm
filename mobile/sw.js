/* Service worker for Bloom CRM mobile: offline shell cache + web push (push lands on the lock
   screen even with the app closed). The snapshot is network-first so it's always fresh when online
   and still available offline. */

// v9: phone auto-refresh (interval + focus/visibility live pull, guarded against mid-edit), Alerts now
// show a task's real title instead of "Task due", and a special high-priority new-inquiry alert with
// distinct styling. Bumping the cache name forces every client to drop the old shell on activate so the
// new app.js/supabase-data.js take effect.
// (v8 re-enabled in-app web-push subscribe on the Supabase login flow; v7 added writes; v6 was the
// passcode+snapshot -> Supabase login + live-reads switchover.)
// v11: moved off Vercel to michaelbloemeke.com/crm/ (2026-08-03), plus the event-date booking gate.
// v12: Quote editable on the phone; contact fields suggest existing contacts.
// v13: contacts added on the phone are now REAL contact records with a project link, not loose text.
// v14: renamed to Bloom CRM; Event details rebuilt as full-size always-visible fields with an X.
// v15: supabase-js VENDORED. The app no longer executes code fetched from esm.sh on every open.
// v16: delete is now reversible (Deleted page, not permanent); proper Add-contact picker; the
// details panel no longer scrolls sideways.
// v17: a project can hold MULTIPLE contacts (add, not replace); New project uses the same contact
// picker instead of three free-text boxes; Completed / Archived / Deleted are their own pages rather
// than tabs on Pipeline, so soft-deleted projects finally have somewhere to be restored from.
// v18: Tasks, Booking and Payments are sections ON the project page instead of buttons that open a
// sheet. Only Event details still hides behind a button (too many fields to inline).
// v19: the project view is four tabs (Booking / Details / Tasks / Notes) with a shared header that
// carries the name, stage, contacts and Actions; stage and contact management moved into Actions.
// Also the whole app is relit: one light-grey scheme, matching the Mac, replacing "Indigo Nocturne".
// v20: the primary contact is the FIRST LINKED one, not whichever name matched the project's text
// field. That name test invented a second, undeletable contact card whenever the two differed. Every
// contact is removable now, primary included. Also the new Bloom CRM icon.
// v21: contact_links carries a position (0 = primary), so link order is deterministic instead of
// whatever Postgres returned, and adding a contact appends rather than reassigning the primary.
// v22: Indoors / Outdoors is a dropdown (Indoors / Outdoors / Both), matching the booking form.
// v23: alerts can be dismissed from the phone (swipe left -> Dismiss, with Undo in the toast).
// Opening an alert no longer counts as dealing with it.
// Bumping the cache name forces every client to drop the old shell on activate.
var CACHE = 'mcrm-v23'
var SHELL = [
  './', './index.html', './app.js', './config.js', './supabase-data.js',
  './manifest.webmanifest', './icon-192.png', './icon-512.png',
  // Vendored supabase-js + its Node shims. Part of the shell now: the app cannot start without them,
  // and they are ours rather than a CDN's, so they belong in the offline cache like everything else.
  './vendor/supabase-js.js', './vendor/node-process.js', './vendor/node-buffer.js',
  './vendor/node-events.js', './vendor/node-tty.js', './vendor/node-async_hooks.js',
]

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL) }).then(function () { return self.skipWaiting() }))
})

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE }).map(function (k) { return caches.delete(k) }))
    }).then(function () { return self.clients.claim() })
  )
})

// Network-first for our own app shell (so updates are always fresh when online), falling back to the
// cache only when offline. Cross-origin requests (now just the Supabase REST/auth API, since
// supabase-js is vendored) are left entirely to the browser: they must always hit the network and
// must never be served from a stale cache, so we don't intercept them at all.
self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return
  var url
  try { url = new URL(e.request.url) } catch (_) { return }
  if (url.origin !== self.location.origin) return // let CDN + Supabase calls pass through untouched
  e.respondWith(
    fetch(e.request)
      .then(function (r) {
        if (r && r.ok) {
          var copy = r.clone()
          caches.open(CACHE).then(function (c) { c.put(e.request, copy) }).catch(function () {})
        }
        return r
      })
      .catch(function () { return caches.match(e.request) }),
  )
})

// Web push: the Mac (or a cloud cron) sends a payload; show it on the lock screen.
self.addEventListener('push', function (e) {
  var data = {}
  try { data = e.data ? e.data.json() : {} } catch (_) { data = { body: e.data ? e.data.text() : '' } }
  var title = data.title || 'Bloom CRM'
  var opts = {
    body: data.body || '',
    icon: './icon-192.png',
    badge: './icon-192.png',
    tag: data.tag || undefined,
    data: { url: data.url || './' },
  }
  var jobs = [self.registration.showNotification(title, opts)]
  // Update the home-screen icon's number from the payload (works even with the app closed).
  if (typeof data.count === 'number' && navigator.setAppBadge) {
    jobs.push(data.count > 0 ? navigator.setAppBadge(data.count) : (navigator.clearAppBadge ? navigator.clearAppBadge() : Promise.resolve()))
  }
  e.waitUntil(Promise.all(jobs.map(function (p) { return Promise.resolve(p).catch(function () {}) })))
})

// Tapping a notification opens / focuses the app.
self.addEventListener('notificationclick', function (e) {
  e.notification.close()
  var url = (e.notification.data && e.notification.data.url) || './'
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (wins) {
      for (var i = 0; i < wins.length; i++) { if ('focus' in wins[i]) return wins[i].focus() }
      if (self.clients.openWindow) return self.clients.openWindow(url)
    })
  )
})
