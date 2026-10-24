// Headless exercise of mobile/app.js under jsdom.
//
// app.js is an ES module that imports the Supabase data layer. Rather than reach the network, the
// import line is rewritten to pull from a STUB module with the same exported names, so every render
// function runs against known data and every write is recorded instead of performed. The real
// index.html supplies the real DOM and the real CSS class names, so a render that targets an
// element that does not exist fails here the same way it would on the phone.
import fs from 'node:fs'
import path from 'node:path'
import { JSDOM } from '../../node_modules/jsdom/lib/api.js'

const MOB = new URL('..', import.meta.url).pathname
const OUT = process.argv[2]

const html = fs.readFileSync(path.join(MOB, 'index.html'), 'utf8')
  .replace(/<script type="module"[^>]*><\/script>/g, '')
  .replace(/<script type="module">[\s\S]*?<\/script>/g, '')

const dom = new JSDOM(html, { url: 'https://michaelbloemeke.com/crm/', pretendToBeVisual: true })
const { window } = dom
for (const k of ['window', 'document', 'navigator', 'location', 'localStorage', 'sessionStorage', 'HTMLElement', 'Node', 'Element', 'getComputedStyle', 'CustomEvent', 'Event']) {
  // navigator is a getter-only global in Node 22, so it has to be redefined rather than assigned.
  Object.defineProperty(globalThis, k, { value: k === 'window' ? window : window[k], configurable: true, writable: true })
}
globalThis.alert = () => {}
globalThis.confirm = () => true
// Node's own timers, NOT jsdom's: assigning window.setTimeout onto globalThis makes jsdom's
// implementation call itself forever. setInterval is neutered so the app's auto-refresh and the
// mail poller cannot keep the process alive.
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}
window.scrollTo = () => {}
globalThis.scrollTo = () => {}

let src = fs.readFileSync(path.join(MOB, 'app.js'), 'utf8')
// Every name app.js imports from the data layer, read off its own import statement, so a new import
// can never be forgotten here. Names the stub does not define get a harmless resolving default.
const IMPORTED = (src.match(/import\s*\{([\s\S]*?)\}\s*from\s*'\.\/supabase-data\.js'/) || ['', ''])[1]
  .split(',').map((x) => x.trim()).filter(Boolean)
src = src.replace(/import\s*\{[\s\S]*?\}\s*from\s*'\.\/supabase-data\.js'\n?/, '')
         .replace(/import\s*\{[^}]*\}\s*from\s*'\.\/config\.js'\n?/, '')
         // The template library is plain data, so the test loads the real one rather than a stub.
         .replace("from './email-templates.js'", "from '../email-templates.js'")
         .replace("from './showbuilder-core.js'", "from '../showbuilder-core.js'")
// boot() fires on DOMContentLoaded and would go to the network; the harness drives the render
// functions directly instead, so that listener is dropped.
src = src.replace("document.addEventListener('DOMContentLoaded', boot)", "")
const tail = [
  "export const __app = {",
  "  render, renderDetail, renderInbox, renderTasks, navigate, detailsTab, dayOfCard, emailTab,",
  "  submittedSection, openCompose, openTaskEditor, mapsLinks, fmtTime, countdownText,",
  "  fmtPhoneDisplay, projectEmails, mailWhen, updateCounts, refreshUnreadMail, taskCard, mailRow,",
  "  renderProposals, proposalCard, openPreview, copyText, renderPipeline, projectCard,",
  "  buildClientMailQueries, activeProjectEmails, openContactSheet, openSearch, openScheduleSheet,",
  "  handleWidgetLink, connectWidgets, forgetReadHere: () => { READ_HERE = {} }, mailForget, alertCard, getPtab: () => PTAB, getSnap: () => SNAP, setSnapRaw: (s) => { SNAP = s },",
  "  renderHome, openHomeSheet, goBack, homeData, getNav: () => NAV_STACK, getTab: () => TAB, getDetail: () => DETAIL_ID,",
  "  bookingTab, proposalSection, emailToProjectIndex, openNewProject,",
  "  refreshNativePushToken, registerNativePush, updatePushButton,",
  "  setSnap: (s) => { SNAP = s }, setTab: (t) => { TAB = t },",
  "  renderBuilder, renderBShow, openBShow, sbFlushEdit, sbEditor, sbNodeSheet, sbLoad, getSB: () => SB,",
  "  setSbView: (v) => { SB_VIEW = v }, setSbTab: (v) => { SB_TAB = v }, setSbDraft: (d) => { SB_EDIT = !!d; SB_DRAFT = d },",
  "  setPtab: (t) => { PTAB = t }, setDetail: (d) => { DETAIL_ID = d },",
  "  getPtab: () => PTAB, getStage: () => STAGE, setStageMap: (m) => { STAGE = m },",
  "}",
].join("\n")
const header = "import { STUB } from './stub.mjs'\n" +
  "const __S = new Proxy(STUB, { get: (t, k) => (k in t ? t[k] : (...a) => Promise.resolve({ ok: true })) })\n" +
  "const { " + [...new Set([...STUBNAMES().split(',').map((x) => x.trim()), ...IMPORTED])].filter((n) => n !== 'VAPID_PUBLIC_KEY').concat(['VAPID_PUBLIC_KEY']).join(', ') + " } = __S\n"
fs.writeFileSync(OUT, header + src + "\n" + tail + "\n")

function STUBNAMES() {
  return [
    'loadEverything','dataChangedSinceLastLoad','getSession','signIn','signOut','currentUserEmail',
    'addTask','updateTask','toggleTask','deleteTask','addNote','updateProjectField','addPayment','setStage',
    'reloadPaymentsFinance','savePushSubscription','saveNativePushToken',
    'createProject','archiveProject','completeProject','restoreProject','deleteProject','LEAD_SOURCES',
    'updateContact','loadContacts','linkOrCreateContact','unlinkContact','loadLinks','setNotificationSeen',
    'loadBookingProgress','loadContractVariants','readyToBookOnPhone','resetBookingOnPhone','agreementPdfUrl',
    'gmailList','gmailThread','gmailMarkRead','gmailUnread','sendEmail','loadProposalsOverview','VAPID_PUBLIC_KEY',
  ].join(', ')
}
