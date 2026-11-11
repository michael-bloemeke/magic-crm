// Runs at the end of testflight.sh, after a successful upload. Keeps ONE open task on the Tasks page:
// "Rebuild the phone app", due 60 days after the newest build.
//
// WHY. A TestFlight build stops opening 90 days after it was uploaded, and since 2026-11-11 there is
// no web copy of the phone app to fall back on (Michael had michaelbloemeke.com/crm/ removed). So a
// quiet stretch with no phone changes would end with the app refusing to open on his phone. Every
// upload pushes this one task 60 days out, so it only ever comes due when no build has gone up for
// two months, and it leaves 30 days of room.
//
// It is an ordinary task row, not a recurring schedule: `task_schedules` has no "every 60 days", and
// a monthly nag would be noise while builds are going up every week. He can tick or delete it like
// any other task; the next upload makes a fresh one.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const c = JSON.parse(fs.readFileSync(path.join(DIR, '..', 'supabase-credentials.json'), 'utf8'))
const sb = createClient(c.url, c.secretKey, { auth: { persistSession: false } })

const PREFIX = 'Rebuild the phone app'
const pad = (n) => String(n).padStart(2, '0')
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const plus = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return d }
const expires = plus(90).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
const title = `${PREFIX} (its TestFlight build expires ${expires})`
const dueDate = iso(plus(60))

const { data: open, error } = await sb.from('tasks').select('id').eq('done', false).like('title', PREFIX + '%').order('created_at')
if (error) throw new Error(error.message)
if (open.length) {
  // notified_at is cleared so the reminder fires again on the new date.
  const { error: e } = await sb.from('tasks').update({ title, due_date: dueDate, due_time: '', notified_at: null }).eq('id', open[0].id)
  if (e) throw new Error(e.message)
} else {
  const { error: e } = await sb.from('tasks').insert({ id: crypto.randomUUID(), project_id: '', title, due_date: dueDate, due_time: '', done: false, created_at: new Date().toISOString() })
  if (e) throw new Error(e.message)
}
console.log(`Task "${PREFIX}" is now due ${dueDate}. This build expires ${expires}.`)
