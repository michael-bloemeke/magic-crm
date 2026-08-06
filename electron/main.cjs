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

const { app, BrowserWindow, ipcMain, nativeImage } = require('electron')
const path = require('path')
const os = require('os')
const http = require('http')
const { spawn } = require('child_process')

const PORT = 5199
const BASE_URL = `http://localhost:${PORT}`
// In dev the repo is one level up from electron/. Once packaged into Bloom CRM.app, __dirname is
// inside the app bundle, so point at the real repo on disk (the data API + node_modules live there).
// Override with MAGIC_CRM_ROOT if the repo ever moves.
const ROOT = app.isPackaged
  ? process.env.MAGIC_CRM_ROOT || path.join(os.homedir(), 'Desktop', 'Claude', 'magic-crm')
  : path.join(__dirname, '..')
const NODE22_BIN = path.join(os.homedir(), '.local', 'node22', 'bin')

let serverProc = null
let win = null

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
    backgroundColor: '#17130f',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs') },
  })
  win.loadURL(BASE_URL)
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin' && app.dock) {
    const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'))
    if (!icon.isEmpty()) app.dock.setIcon(icon)
  }
  const ok = await ensureServer()
  createWindow()
  if (!ok) {
    win.loadURL(
      'data:text/html,' +
        encodeURIComponent(
          '<body style="font-family:-apple-system,sans-serif;background:#17130f;color:#e6c590;padding:48px;line-height:1.6">' +
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

app.on('before-quit', stopServer)
app.on('window-all-closed', () => {
  // macOS apps usually stay in the dock when the window closes; quit elsewhere.
  if (process.platform !== 'darwin') {
    stopServer()
    app.quit()
  }
})
