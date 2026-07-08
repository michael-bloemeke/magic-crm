/* Service worker for Magic CRM mobile: offline shell cache + web push (push lands on the lock
   screen even with the app closed). The snapshot is network-first so it's always fresh when online
   and still available offline. */

// v9: phone auto-refresh (interval + focus/visibility live pull, guarded against mid-edit), Alerts now
// show a task's real title instead of "Task due", and a special high-priority new-inquiry alert with
// distinct styling. Bumping the cache name forces every client to drop the old shell on activate so the
// new app.js/supabase-data.js take effect.
// (v8 re-enabled in-app web-push subscribe on the Supabase login flow; v7 added writes; v6 was the
// passcode+snapshot -> Supabase login + live-reads switchover.)
var CACHE = 'mcrm-v9'
var SHELL = ['./', './index.html', './app.js', './config.js', './supabase-data.js', './manifest.webmanifest', './icon-192.png', './icon-512.png']

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
// cache only when offline. Cross-origin requests (the esm.sh supabase-js CDN import + the Supabase
// REST/auth API) are left entirely to the browser: they must always hit the network and must never be
// served from a stale cache, so we don't intercept them at all.
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
  var title = data.title || 'Magic CRM'
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
