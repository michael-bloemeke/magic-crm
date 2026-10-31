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
// v24: the Alerts badge no longer counts tasks. A due task is counted once, on Tasks; the app icon
// is Tasks + Alerts.
// v25 (2026-09-21): the phone stops needing the laptop. Michael: "make it so that there's nothing
// that I need my laptop for."
//   - Project Details opens FIRST and leads with a day-of card: date + countdown, arrival / event /
//     show times, the venue address as a one-tap route into Maps, and the day-of contact with
//     Call / Text / Email. Missing fields are called out rather than omitted.
//   - What the client sent back: the completed booking form's answers as readable text, plus the
//     signed performance agreement PDF, both on the Details tab.
//   - Tasks are editable: tap one to retitle, reschedule (Today / Tomorrow / +1 week / Clear) or
//     delete, on the Tasks page and inside a project. Completed tasks are reachable again.
//   - EMAIL. Read and send from the phone with the Mac off, through a new `gmail` Edge Function:
//     an Inbox page, a per-project Email tab, a composer, and an unread badge on the drawer.
//   - A Proposals page: every proposal and booking form, its state, and its view count. Every link
//     opened from the CRM is a PREVIEW and never counts as a client view.
//   - Pipeline cards show how far off the event is, how many tasks are due, and whether that client
//     has unread mail waiting.
//   - Fixed: the Quote could not actually be saved from the phone (it was in the edit form but not
//     in the writable-column allow-list, so it threw on blur). Arrival time was missing entirely.
//   - Fixed: the Quote READ back-to-front. total_fee_text is a companion for values that are not
//     numbers, but the phone preferred it whenever it was non-empty, so five projects that have
//     both columns populated showed "Quote: Not set" on a project with a quote. Number wins now,
//     matching the Proposals page, the backup exporter and verify-phone-read.
//   - Fixed: New project now asks where the lead came from and stores it. booking_source was
//     hardcoded null here, so the one app used to log a gig-site lead in the moment left the one
//     field Stats needs to attribute it empty. (Logged as open in magic-crm.md since 2026-08-24.)
//   - Fixed: the app now re-registers with APNs on EVERY launch, as Apple asks, instead of only
//     when the bell is tapped. iOS rotates device tokens, the bell hides itself once used, and a
//     dead token fails silently, so notifications could stop for good with nothing on screen to
//     explain it. Shipping an update to the native app means reinstalling it, so this is the
//     difference between notifications surviving an update and not.
// v26 (2026-09-21), both from Michael after using v25:
//   - THE INBOX IS NOT A MAILBOX. It was pulling his entire Gmail inbox. It now shows only mail
//     sent to or from a contact on an ACTIVE project, matching how the desktop CRM has always
//     worked: "I don't want things like Bark updates or GigSalad or any of that nonsense." The
//     unread badge counts the same thing, so it reads what is actually waiting on him instead of
//     201. Rows name the CLIENT, never Michael, because the newest message in a live thread is
//     usually his own reply.
//   - PROPOSALS OPEN INSIDE THE CRM. Preview used to hand off to Firefox. It now frames the real
//     page in a full-screen pane with a Back button, the same as PreviewPage.tsx on the Mac.
// Bumping the cache name forces every client to drop the old shell on activate.
// v28 (2026-10-24): the Show Builder page, and showbuilder-core.js joins the shell.
// v29 (2026-10-24): "On my plate" under the Home tiles (the home_list table, shared with the Mac).
// v30 (2026-10-31): "On my plate" becomes an outline (rename, reorder, indent); homelist-core.js joins the shell.
var CACHE = 'mcrm-v30'
var SHELL = [
  './', './index.html', './app.js', './config.js', './supabase-data.js',
  './manifest.webmanifest', './icon-192.png', './icon-512.png', './damask.webp', './email-templates.js', './showbuilder-core.js', './homelist-core.js',
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
