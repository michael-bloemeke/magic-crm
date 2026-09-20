// Copies the phone app's web assets into ios-app/www/, which is what Capacitor packages into the
// native binary.
//
// WHY A COPY RATHER THAN POINTING CAPACITOR AT ../mobile:
//   1. `npx cap sync` copies the ENTIRE webDir. Pointing it at ../mobile would drag in node_modules
//      and any native build output the moment either folder grew one.
//   2. The native shell needs two deliberate differences from the PWA (below), and doing that with a
//      copy step keeps ../mobile byte-for-byte the thing that ships to michaelbloemeke.com/crm/.
//
// The file list is the SAME allowlist sync-to-website.mjs uses, for the same reason: an explicit
// list cannot accidentally ship something. Keep the two in step.
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'mobile')
const WWW = join(HERE, 'www')

// Byte-for-byte from ../mobile. `sw.js` and the manifest are deliberately NOT here: see below.
const FILES = [
  'index.html',
  'app.js',
  'config.js',
  'supabase-data.js',
  'icon-192.png',
  'icon-512.png',
  'vendor/supabase-js.js',
  'vendor/node-process.js',
  'vendor/node-buffer.js',
  'vendor/node-events.js',
  'vendor/node-tty.js',
  'vendor/node-async_hooks.js',
]

if (!existsSync(SRC)) {
  console.error('[ios-app] cannot find ../mobile. Run this from magic-crm/ios-app.')
  process.exit(1)
}

// Start clean so a file deleted from ../mobile cannot linger inside the app binary.
rmSync(WWW, { recursive: true, force: true })
mkdirSync(WWW, { recursive: true })

for (const name of FILES) {
  const from = join(SRC, name)
  if (!existsSync(from)) {
    console.error(`[ios-app] missing source file: mobile/${name}`)
    process.exit(1)
  }
  const to = join(WWW, name)
  mkdirSync(dirname(to), { recursive: true })
  writeFileSync(to, readFileSync(from))
}

// The service worker and the web manifest are deliberately absent from FILES above.
//
// sw.js caches assets so the PWA can open offline. Inside the native shell the assets are already
// on the device, so it adds nothing and actively hurts: it would serve a cached copy of a previous
// build after an update, which is the most common way a Capacitor app gets stuck on stale code with
// no way for the user to clear it.
//
// app.js does NOT need patching to match. It checks `isNativeApp()` at runtime and skips both the
// service-worker registration and the Web Push path on its own, which is what lets ../mobile stay
// the single source for the PWA and the native app. This assertion is here so that if someone
// removes that guard later, the build fails loudly instead of shipping an app that silently
// registers a worker for a file that is not in the bundle.
const appJs = readFileSync(join(WWW, 'app.js'), 'utf8')
if (!appJs.includes('isNativeApp()') || !appJs.includes("!isNativeApp() && 'serviceWorker' in navigator")) {
  console.error('[ios-app] mobile/app.js is missing its native guard. Refusing to build a bundle')
  console.error('          that would register ./sw.js, which is not shipped. See app.js.')
  process.exit(1)
}

console.log(`[ios-app] www/ built: ${FILES.length} files from ../mobile (service worker excluded, native guard verified)`)
