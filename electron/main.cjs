// Electron main process for the Bloom CRM.
//
// Stage 1 packaging: wrap the EXISTING local app (the Vite dev server + its data API) in a
// native macOS window with the brass "M" dock icon and a dock badge that mirrors unread items.
// It reuses the same server the "Open Bloom CRM.command" starts (node22 + `npm run dev` on 5199),
// so behavior is identical to today, just in an app window instead of a browser tab.
//
// If a server is already running on :5199 (e.g. you launched the .command), we attach to it and
// do NOT kill it on quit. If not, we start one and stop it when the app quits.
//
// Stage 2 (later) = a fully self-contained, double-clickable .app via electron-builder, which
// needs the data API bundled to run without the repo/node22. Not done yet.

const { app, BrowserWindow, ipcMain, nativeImage, screen, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const http = require('http')
const { spawn } = require('child_process')

const PORT = 5199
const BASE_URL = `http://localhost:${PORT}`
// In dev the repo is one level up from electron/. Once packaged into Bloom CRM.app, __dirname is
// inside the app bundle, so point at the real repo on disk (the data API + node_modules live there).
// Override with MAGIC_CRM_ROOT if the repo ever moves.
//
// The folder moved on 2026-11-15, from ~/Desktop/Claude/magic-crm to ~/Desktop/Claude/Business/Bloom CRM,
// and this still named the old one until 2026-11-23. Nothing broke only because a server was already
// running, so the app never had to start one. The first existing folder wins, newest location first.
const REPO_HOMES = [
  path.join(os.homedir(), 'Desktop', 'Claude', 'Business', 'Bloom CRM'),
  path.join(os.homedir(), 'Desktop', 'Claude', 'magic-crm'),
]
const ROOT = app.isPackaged
  ? process.env.MAGIC_CRM_ROOT || REPO_HOMES.find((p) => fs.existsSync(path.join(p, 'package.json'))) || REPO_HOMES[0]
  : path.join(__dirname, '..')
const NODE22_BIN = path.join(os.homedir(), '.local', 'node22', 'bin')

let serverProc = null
let win = null

// ---- Links from outside the app ---------------------------------------------------------------
//
// The CRM writes one link into the notes of every calendar event it makes for a project, in the
// app's own link type: the "bloomcrm" scheme, then project/<id> (projectLink in crm-calendar.mjs).
// The phone app has answered that link since the widgets. This is the Mac's half: clicking it in the
// Calendar app brings Bloom CRM to the front on that project, starting the app first if it is closed.
//
// Two things make it work, and both are needed:
//   1. The app's Info.plist lists the scheme, which is how macOS knows to hand the link to this app.
//      That comes from "protocols" in package.json's build settings, so it only exists in the BUILT
//      app (npm run dist), not under "npm run app".
//   2. The "open-url" handler below, which must be registered before the app is ready, because a
//      link that starts the app arrives before any window exists.
//
// The link is held until the page says it is listening ("links-ready"), then passed to it. The page
// (App.tsx) opens the project.
const LINK_SCHEME = 'bloomcrm'
let pendingLink = null
let pageListening = false

function parseLink(url) {
  const m = /^bloomcrm:\/\/([^/?#]+)(?:\/([^/?#]+))?(?:\/([^/?#]+))?/i.exec(String(url || ''))
  if (!m) return null
  let id = m[2] || ''
  try {
    id = decodeURIComponent(id)
  } catch {
    /* keep it as written */
  }
  return { what: m[1].toLowerCase(), id, sub: m[3] || '' }
}

// Bring the main window in front of whatever he was looking at (the Calendar app, usually).
function showMainWindow() {
  if (!win || win.isDestroyed()) createWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  app.focus({ steal: true })
}

function handleLink(link) {
  if (!link) return
  pendingLink = link
  if (!app.isReady() || !serverChecked) return // still starting: flushed once the page is listening
  showMainWindow()
  flushLink()
}

function flushLink() {
  if (!pendingLink || !pageListening || !win || win.isDestroyed()) return
  const link = pendingLink
  pendingLink = null
  win.webContents.send('open-link', link)
}

// False until the first ensureServer() has finished, so a link that starts the app does not open a
// window before the server is there to fill it.
let serverChecked = false

app.on('open-url', (event, url) => {
  event.preventDefault()
  handleLink(parseLink(url))
})

// True only if the data API answers 200 (not just any process on the port).
function ping() {
  return new Promise((resolve) => {
    const req = http.get(`${BASE_URL}/api/projects`, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on('error', () => resolve(false))
    req.setTimeout(1500, () => {
      req.destroy()
      resolve(false)
    })
  })
}

async function waitForServer(timeoutMs = 60000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await ping()) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

// Attach to a running server, or start one (node22 + npm run dev), like the .command does.
async function ensureServer() {
  if (await ping()) return true
  serverProc = spawn(path.join(NODE22_BIN, 'npm'), ['run', 'dev', '--', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    env: { ...process.env, PATH: `${NODE22_BIN}:${process.env.PATH || ''}` },
    detached: true, // own process group, so we can stop the whole tree (npm -> vite)
    stdio: 'ignore',
  })
  serverProc.unref()
  return waitForServer()
}

function stopServer() {
  if (serverProc && serverProc.pid) {
    try {
      process.kill(-serverProc.pid) // kill the process group we started
    } catch {
      // already gone
    }
    serverProc = null
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    title: 'Bloom CRM',
    // Matches --color-canvas in src/index.css, so the window does not flash a dark panel
    // before the app paints.
    backgroundColor: '#eef0f3',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs') },
  })
  win.loadURL(BASE_URL)

  // A reload or a closed window means the page is not listening for links until it says so again.
  const thisWin = win
  thisWin.webContents.on('did-start-navigation', (e, _url, isInPlace, isMainFrame) => {
    // Newer Electron puts these on the event; older passed them as arguments. Read whichever is there.
    const mainFrame = typeof e.isMainFrame === 'boolean' ? e.isMainFrame : isMainFrame
    const samePage = typeof e.isSameDocument === 'boolean' ? e.isSameDocument : isInPlace
    if (mainFrame && !samePage) pageListening = false
  })
  thisWin.on('closed', () => {
    if (win === thisWin) {
      win = null
      pageListening = false
    }
  })

  // Anything the app opens in a new window (proposal pages, invoice PDFs, Google Calendar links)
  // fills the screen instead of landing in Electron's small default child window.
  //
  // Michael, 2026-09-09: "I want it to be zoomed in, so it just covers the four corners of my
  // screen. I don't want a whole new screen that I have to swipe to." So this deliberately sizes
  // the window to the display's WORK AREA rather than calling maximize() or setFullScreen(true):
  // workArea already excludes the menu bar and the dock, and it keeps the window in the current
  // Space, so there is nothing to swipe to. A proposal page at that width is also what the client
  // actually sees, which is the point.
  win.webContents.setWindowOpenHandler(({ url }) => {
    // Gig-site lead links (the "Open this lead on GigSalad / The Bash / Bark" button in the
    // Initial inquiry popup) open in his DEFAULT BROWSER (Firefox), where he is logged in to those
    // sites. Michael, 2026-10-12: a new tab there, not an in-app window and not a viewer inside the
    // CRM (an in-CRM <webview> was built and removed the same day as too complicated).
    try {
      const host = new URL(url).hostname
      if (/(^|\.)(gigsalad\.com|thebash\.com|bark\.com)$/i.test(host)) {
        shell.openExternal(url)
        return { action: 'deny' }
      }
    } catch {
      /* not a URL: fall through to the normal in-app window */
    }
    const display = screen.getDisplayMatching(win.getBounds())
    const { x, y, width, height } = display.workArea
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        x,
        y,
        width,
        height,
        // The proposal page is near-black; a light flash before it paints looks broken.
        backgroundColor: url.includes('/proposal/') ? '#0b0f1a' : '#eef0f3',
        webPreferences: { nodeIntegration: false, contextIsolation: true },
      },
    }
  })
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin' && app.dock) {
    const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'))
    if (!icon.isEmpty()) app.dock.setIcon(icon)
  }
  // Claim the link type for this app. macOS reads it from the built app's Info.plist; this also makes
  // this copy the one that answers if an older build is still registered somewhere on the disk.
  if (app.isPackaged) app.setAsDefaultProtocolClient(LINK_SCHEME)
  const ok = await ensureServer()
  serverChecked = true
  createWindow()
  if (!ok) {
    win.loadURL(
      'data:text/html,' +
        encodeURIComponent(
          '<body style="font-family:-apple-system,sans-serif;background:#eef0f3;color:#14171b;padding:48px;line-height:1.6">' +
            "<h2>Couldn't start the Bloom CRM server.</h2>" +
            '<p>Make sure node22 is installed at ~/.local/node22 and try again, or start it with the “Open Bloom CRM.command”.</p></body>',
        ),
    )
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// The renderer pushes the unread/notification count here; macOS shows it on the dock icon.
ipcMain.on('set-badge', (_e, count) => {
  app.setBadgeCount(Number(count) > 0 ? Math.floor(Number(count)) : 0)
})

// The page says it is ready to take links (App.tsx, through preload.cjs). Only the main window counts:
// proposal and invoice windows have no preload and never send this.
ipcMain.on('links-ready', (e) => {
  if (!win || win.isDestroyed() || e.sender !== win.webContents) return
  pageListening = true
  flushLink()
})

app.on('before-quit', stopServer)
app.on('window-all-closed', () => {
  // macOS apps usually stay in the dock when the window closes; quit elsewhere.
  if (process.platform !== 'darwin') {
    stopServer()
    app.quit()
  }
})
