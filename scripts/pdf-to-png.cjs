#!/usr/bin/env node
// PDF pages -> PNG, using the Chromium PDF engine Electron already bundles. No Homebrew, no
// downloads, nothing installed. Offscreen, so nothing appears on screen.
//
//   ./node_modules/.bin/electron scripts/pdf-to-png.cjs <dir-of-pdfs> <outdir>
//
// It renders PAGE ONE of every PDF in the input folder. To do a multi-page file, split it first:
// see splitPdf() at the bottom, which writes one single-page PDF per page by rewriting only the
// /Pages tree and padding with spaces, so every byte offset (and the original xref) stays valid.
//
// FOUR THINGS THAT BIT, kept so nobody re-discovers them:
//  1. Navigating to file.pdf#page=N does NOT change page, even in a brand new window. Chromium
//     restores the document at page one, so you silently get page one N times. Split the file.
//  2. PageDown via sendInputEvent does nothing to an offscreen window; it never takes focus.
//  3. capturePage() on a timer yields blank ~21 KB frames. Offscreen paints when it is ready, so
//     capture from the 'paint' event and keep the largest frame.
//  4. Destroying the last window quits the app by default, which ends the loop after one file.
// honour #page=N, so the pages are separated at the file level instead.
// Under plain node there is no Electron app object; the file is then just a library exposing
// splitPdf(). The rendering half only runs when launched through the electron binary.
const electron = (() => { try { return require('electron') } catch { return {} } })()
const { app, BrowserWindow } = electron
if (app) run()
function run() {
const path = require('node:path'); const fs = require('node:fs')
const [dir, outdir] = process.argv.slice(2).filter((a) => !a.startsWith('--'))
app.commandLine.appendSwitch('disable-gpu'); app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})
const shoot = (pdf) => new Promise((resolve) => {
  const win = new BrowserWindow({ width: 1600, height: 900, show: false,
    webPreferences: { plugins: true, offscreen: true, sandbox: false } })
  let best = null, done = false
  const finish = () => { if (done) return; done = true; try { win.destroy() } catch {} ; resolve(best) }
  win.webContents.on('paint', (_e, _d, img) => { const b = img.toPNG(); if (!best || b.length > best.length) best = b })
  win.webContents.setFrameRate(12)
  win.loadURL(`file://${path.resolve(pdf)}#zoom=page-fit&toolbar=0&navpanes=0`)
  setTimeout(finish, 5500)
})
app.whenReady().then(async () => {
  fs.mkdirSync(outdir, { recursive: true })
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.pdf')).sort()) {
    const buf = await shoot(path.join(dir, f))
    const out = path.join(outdir, f.replace('.pdf', '.png'))
    if (buf && buf.length > 80_000) { fs.writeFileSync(out, buf); console.log(f, Math.round(buf.length/1024), 'KB') }
    else console.log(f, 'FAILED')
  }
  app.quit()
})

}

// --- Splitting a multi-page PDF -------------------------------------------------------------
// Run this first (with plain node) when the source is multi-page. It rewrites ONLY the /Pages tree
// and pads the replacement with spaces so the file length, every byte offset, and the original xref
// table all stay valid. No PDF library needed.
//
//   node -e "require('./scripts/pdf-to-png.cjs').splitPdf('deck.pdf','split')"
function splitPdf(src, outdir) {
  const fs2 = require('node:fs'), path2 = require('node:path')
  const data = fs2.readFileSync(src)
  const m = /\/Type\s*\/Pages([\s\S]{0,900}?)>>/.exec(data.toString('latin1'))
  const seg = data.toString('latin1').slice(m.index, m.index + m[0].length)
  const kids = /\/Kids\s*\[([\s\S]*?)\]/.exec(seg)
  const cnt = /\/Count\s+(\d+)/.exec(seg)
  const refs = [...kids[1].matchAll(/(\d+)\s+0\s+R/g)].map((x) => x[1])
  fs2.mkdirSync(outdir, { recursive: true })
  refs.forEach((r, i) => {
    const out = Buffer.from(data)
    const ks = m.index + kids.index + kids[0].indexOf('[') + 1
    const ke = ks + kids[1].length
    const rep = `${r} 0 R`.padEnd(ke - ks, ' ')
    out.write(rep, ks, 'latin1')
    const cs = m.index + cnt.index + cnt[0].indexOf(cnt[1])
    out.write('1'.padEnd(cnt[1].length, ' '), cs, 'latin1')
    fs2.writeFileSync(path2.join(outdir, `page${String(i + 1).padStart(2, '0')}.pdf`), out)
  })
  return refs.length
}
module.exports = { splitPdf }
