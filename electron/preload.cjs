// Preload: exposes a tiny, safe bridge to the renderer (the React app). The app calls
// window.crm.setBadge(n) to drive the macOS dock badge; window.crm.isElectron lets the UI
// know it's running inside the app vs a plain browser tab.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('crm', {
  isElectron: true,
  setBadge: (count) => ipcRenderer.send('set-badge', count),
  // Links from outside the app (a calendar event's "Open in Bloom CRM" link, 2026-11-23). The page
  // passes a function; it is called with { what, id, sub } for each link, e.g. what "project" and the
  // project's id. Registering also tells the app the page is ready, so a link that STARTED the app is
  // handed over as soon as there is someone to take it. Returns a function that stops listening.
  onOpenLink: (cb) => {
    const fn = (_e, link) => cb(link)
    ipcRenderer.on('open-link', fn)
    ipcRenderer.send('links-ready')
    return () => ipcRenderer.removeListener('open-link', fn)
  },
})
