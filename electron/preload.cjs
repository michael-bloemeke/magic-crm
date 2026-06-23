// Preload: exposes a tiny, safe bridge to the renderer (the React app). The app calls
// window.crm.setBadge(n) to drive the macOS dock badge; window.crm.isElectron lets the UI
// know it's running inside the app vs a plain browser tab.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('crm', {
  isElectron: true,
  setBadge: (count) => ipcRenderer.send('set-badge', count),
})
