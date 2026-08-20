import { google } from 'googleapis'
import fs from 'node:fs'
import { initStore, getCachedCalendarMap } from './crm-store.mjs'
await initStore()
const map = getCachedCalendarMap() || {}
const tok = JSON.parse(fs.readFileSync('./google-token.json','utf8'))
const cred = JSON.parse(fs.readFileSync('./google-credentials.json','utf8'))
const c = cred.installed || cred.web
const oa = new google.auth.OAuth2(c.client_id, c.client_secret, c.redirect_uris?.[0])
oa.setCredentials(tok)
const cal = google.calendar({ version: 'v3', auth: oa })
const cals = await cal.calendarList.list({ maxResults: 250 })
const gigs = (cals.data.items||[]).find(x => (x.summary||'').trim() === 'Gigs')
const res = await cal.events.list({ calendarId: gigs.id, timeMin:'2025-11-01T00:00:00Z', timeMax:'2025-12-31T00:00:00Z', singleEvents:true, maxResults:2500 })
const trackedId = (map.projects||{})['marsha']
console.log('map says marsha ->', trackedId)
for (const e of res.data.items||[]) {
  if (!/marsha/i.test(e.summary||'')) continue
  console.log('---')
  console.log('  id      :', e.id, e.id === trackedId ? '  <== TRACKED (the one the CRM manages)' : '  <== untracked')
  console.log('  title   :', e.summary)
  console.log('  start   :', JSON.stringify(e.start))
  console.log('  created :', e.created, ' updated:', e.updated)
  console.log('  desc    :', String(e.description||'').replace(/\n/g,' | ').slice(0,150))
}
