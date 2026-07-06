// Phase 2 Supabase setup + import: the remaining CRM data files.
// NON-DESTRUCTIVE to the live CRM: only READS the Project Records JSON and writes to Supabase.
// The app still reads these JSON files; this is schema + import only (a later step repoints the app).
//
// Tables created here (none overlap Phase 1's projects/contacts/contact_links/pipeline_meta):
//   Typed-column tables (real columns mirroring the record fields, arrays/nested -> jsonb):
//     payments, expenses, tasks, emails, templates, notifications, text_markers, mileage_trips
//   jsonb round-trip tables (faithful preservation of nested / per-project-keyed / config shapes):
//     invoices, contracts, questionnaires, portals, recipients, inquiries, calendar_map,
//     crm_config (single row), crm_settings (single row: mileage ratePerMile + questionnaire default template)
//
// Idempotent: drops + recreates ONLY these Phase 2 tables and re-imports every run.
// Reads keys from ../supabase-credentials.json (gitignored).
//
// Run:  node supabase/import-phase2.mjs           (dry gather + refuse, like Phase 1)
//       CONFIRM_RESET=yes node supabase/import-phase2.mjs   (actually build + import)

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(DIR, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const RECORDS = '/Users/michaelbloemeke/Desktop/claude/The Award-Winning Magic of Michael Bloemeke/Project Records'

const creds = JSON.parse(fs.readFileSync(path.join(REPO, 'supabase-credentials.json'), 'utf8'))
const { url, projectRef, secretKey, accessToken } = creds

// --- helpers ---
function num(v) {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}
// Companion-text guard: if a value is present but NOT a clean number, keep the original string
// so we never silently drop a "TBD (...)"-style note (the Phase 1 fee-note trap).
function numText(v) {
  if (v === null || v === undefined || v === '') return null
  return num(v) === null ? String(v) : null
}
function t(v) {
  return v === undefined ? null : v
}
function bool(v) {
  return v === undefined ? null : !!v
}
function arr(v) {
  return Array.isArray(v) ? v : []
}
function readJson(file, fb) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fb }
}

// --- Management API: run arbitrary SQL (DDL) with the personal access token ---
async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  const body = await res.text()
  if (!res.ok) throw new Error(`SQL failed (${res.status}): ${body}`)
  try { return JSON.parse(body) } catch { return body }
}

// --- PostgREST: bulk insert rows into a table with the secret key (bypasses RLS) ---
async function insert(table, rows) {
  if (!rows.length) return 0
  let done = 0
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200)
    const res = await fetch(`${url}/rest/v1/${table}`, {
      method: 'POST',
      headers: {
        apikey: secretKey,
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(chunk),
    })
    if (!res.ok) throw new Error(`Insert ${table} failed (${res.status}): ${await res.text()}`)
    done += chunk.length
  }
  return done
}

// ---------- 1. Schema ----------
// snake_case columns for the flat record files; jsonb for arrays/nested + the per-project/config files.
const DDL = `
drop table if exists payments cascade;
drop table if exists expenses cascade;
drop table if exists tasks cascade;
drop table if exists emails cascade;
drop table if exists templates cascade;
drop table if exists notifications cascade;
drop table if exists text_markers cascade;
drop table if exists mileage_trips cascade;
drop table if exists invoices cascade;
drop table if exists contracts cascade;
drop table if exists questionnaires cascade;
drop table if exists portals cascade;
drop table if exists recipients cascade;
drop table if exists inquiries cascade;
drop table if exists calendar_map cascade;
drop table if exists crm_config cascade;
drop table if exists crm_settings cascade;

-- Received/pending payments (crm-payments.json). amount is always numeric in the data;
-- amount_text is a defensive companion for any future non-numeric value (never coerce to null).
create table payments (
  id uuid primary key,
  project_id text,
  amount numeric,
  amount_text text,
  date_received text,
  pending boolean,
  type text,
  method text,
  note text,
  created_at timestamptz
);
alter table payments enable row level security;

-- Recurring expenses (crm-expenses.json). Empty at import; typed per its _meta shape.
create table expenses (
  id text primary key,
  name text,
  amount numeric,
  amount_text text,
  cadence text,
  category text,
  note text,
  created_at timestamptz
);
alter table expenses enable row level security;

-- CRM tasks (crm-tasks.json).
create table tasks (
  id uuid primary key,
  project_id text,
  title text,
  due_date text,
  due_time text,
  done boolean,
  created_at timestamptz
);
alter table tasks enable row level security;

-- Composed per-project emails (crm-emails.json). to/attachments preserved as jsonb.
create table emails (
  id uuid primary key,
  project_id text,
  kind text,
  "to" jsonb not null default '[]',
  subject text,
  body text,
  status text,
  format text,
  attachments jsonb not null default '[]',
  thread_id text,
  thread_subject text,
  created_at timestamptz,
  updated_at timestamptz,
  sent_at text
);
alter table emails enable row level security;

-- Email templates (crm-templates.json). id is a slug string, not a uuid.
create table templates (
  id text primary key,
  name text,
  subject text,
  body text,
  format text,
  updated_at timestamptz
);
alter table templates enable row level security;

-- Unseen status notifications (crm-notifications.json).
create table notifications (
  id text primary key,
  project_id text,
  kind text,
  source_id text,
  seen boolean,
  created_at timestamptz
);
alter table notifications enable row level security;

-- Manual SMS/text sent flags (crm-text-markers.json). No natural id; keyed by (project_id, kind).
create table text_markers (
  project_id text not null,
  kind text not null,
  sent boolean,
  date text,
  updated_at timestamptz,
  primary key (project_id, kind)
);
alter table text_markers enable row level security;

-- Mileage trips (crm-mileage.json trips[]). Empty at import; miles gets a companion text guard.
create table mileage_trips (
  id uuid primary key,
  date text,
  miles numeric,
  miles_text text,
  purpose text,
  project_id text,
  created_at timestamptz
);
alter table mileage_trips enable row level security;

-- Per-project QuickBooks invoice refs (crm-invoices.json). jsonb round-trip, one row per project key.
create table invoices (
  project_id text primary key,
  data jsonb not null
);
alter table invoices enable row level security;

-- Per-project contract versions (crm-contracts.json). Value is an ARRAY of versions -> jsonb.
create table contracts (
  project_id text primary key,
  versions jsonb not null
);
alter table contracts enable row level security;

-- Per-project questionnaire config + responses (crm-questionnaire.json questionnaires{}).
create table questionnaires (
  project_id text primary key,
  data jsonb not null
);
alter table questionnaires enable row level security;

-- Per-project portal settings (crm-portal.json portals{}).
create table portals (
  project_id text primary key,
  data jsonb not null
);
alter table portals enable row level security;

-- Per-project document signers / bill-to (crm-recipients.json recipients{}).
create table recipients (
  project_id text primary key,
  data jsonb not null
);
alter table recipients enable row level security;

-- HoneyBook inquiry imports + dismissals (crm-inquiries.json inquiries{}). Keyed by relay inquiry id.
create table inquiries (
  id text primary key,
  data jsonb not null
);
alter table inquiries enable row level security;

-- Project/task -> calendar event id map (crm-calendar-map.json). Single row holding the three maps.
create table calendar_map (
  id int primary key default 1,
  calendars jsonb not null default '{}',
  projects jsonb not null default '{}',
  tasks jsonb not null default '{}',
  constraint calendar_map_singleton check (id = 1)
);
alter table calendar_map enable row level security;

-- Single settings object (crm-config.json, minus _meta). Faithful jsonb round-trip in one row.
create table crm_config (
  id int primary key default 1,
  data jsonb not null,
  constraint crm_config_singleton check (id = 1)
);
alter table crm_config enable row level security;

-- Misc settings that live at the top of otherwise record-array files:
--   mileage ratePerMile, and the questionnaire default template.
create table crm_settings (
  id int primary key default 1,
  mileage_rate_per_mile numeric,
  questionnaire_template jsonb,
  constraint crm_settings_singleton check (id = 1)
);
alter table crm_settings enable row level security;
`

// ---------- 2. Gather data ----------
const paymentsRaw = arr(readJson(path.join(RECORDS, 'crm-payments.json'), {}).payments)
const payments = paymentsRaw.map((p) => ({
  id: p.id,
  project_id: t(p.projectId),
  amount: num(p.amount),
  amount_text: numText(p.amount),
  date_received: t(p.dateReceived),
  pending: p.pending === undefined ? null : !!p.pending,
  type: t(p.type),
  method: t(p.method),
  note: t(p.note),
  created_at: t(p.createdAt),
}))

const expensesRaw = arr(readJson(path.join(RECORDS, 'crm-expenses.json'), {}).expenses)
const expenses = expensesRaw.map((e) => ({
  id: e.id,
  name: t(e.name),
  amount: num(e.amount),
  amount_text: numText(e.amount),
  cadence: t(e.cadence),
  category: t(e.category),
  note: t(e.note),
  created_at: t(e.createdAt),
}))

const tasksRaw = arr(readJson(path.join(RECORDS, 'crm-tasks.json'), {}).tasks)
const tasks = tasksRaw.map((k) => ({
  id: k.id,
  project_id: t(k.projectId),
  title: t(k.title),
  due_date: t(k.dueDate),
  due_time: t(k.dueTime),
  done: bool(k.done),
  created_at: t(k.createdAt),
}))

const emailsRaw = arr(readJson(path.join(RECORDS, 'crm-emails.json'), {}).emails)
const emails = emailsRaw.map((e) => ({
  id: e.id,
  project_id: t(e.projectId),
  kind: t(e.kind),
  to: arr(e.to),
  subject: t(e.subject),
  body: t(e.body),
  status: t(e.status),
  format: t(e.format),
  attachments: arr(e.attachments),
  thread_id: t(e.threadId),
  thread_subject: t(e.threadSubject),
  created_at: t(e.createdAt),
  updated_at: t(e.updatedAt),
  sent_at: t(e.sentAt),
}))

const templatesRaw = arr(readJson(path.join(RECORDS, 'crm-templates.json'), {}).templates)
const templates = templatesRaw.map((tm) => ({
  id: tm.id,
  name: t(tm.name),
  subject: t(tm.subject),
  body: t(tm.body),
  format: t(tm.format),
  updated_at: t(tm.updatedAt),
}))

const notificationsRaw = arr(readJson(path.join(RECORDS, 'crm-notifications.json'), {}).events)
const notifications = notificationsRaw.map((n) => ({
  id: n.id,
  project_id: t(n.projectId),
  kind: t(n.kind),
  source_id: t(n.sourceId),
  seen: bool(n.seen),
  created_at: t(n.createdAt),
}))

const markersRaw = arr(readJson(path.join(RECORDS, 'crm-text-markers.json'), {}).markers)
const textMarkers = markersRaw.map((m) => ({
  project_id: t(m.projectId),
  kind: t(m.kind),
  sent: bool(m.sent),
  date: t(m.date),
  updated_at: t(m.updatedAt),
}))

const mileageFile = readJson(path.join(RECORDS, 'crm-mileage.json'), {})
const mileageTrips = arr(mileageFile.trips).map((tr) => ({
  id: tr.id,
  date: t(tr.date),
  miles: num(tr.miles),
  miles_text: numText(tr.miles),
  purpose: t(tr.purpose),
  project_id: t(tr.projectId),
  created_at: t(tr.createdAt),
}))

// per-project-keyed / nested -> one row per key, jsonb payload
function keyedRows(obj, keyCol, valCol) {
  return Object.entries(obj || {}).map(([k, v]) => ({ [keyCol]: k, [valCol]: v }))
}
const invoices = keyedRows(readJson(path.join(RECORDS, 'crm-invoices.json'), {}).invoices, 'project_id', 'data')
const contracts = keyedRows(readJson(path.join(RECORDS, 'crm-contracts.json'), {}).contracts, 'project_id', 'versions')
const questionnaireFile = readJson(path.join(RECORDS, 'crm-questionnaire.json'), {})
const questionnaires = keyedRows(questionnaireFile.questionnaires, 'project_id', 'data')
const portals = keyedRows(readJson(path.join(RECORDS, 'crm-portal.json'), {}).portals, 'project_id', 'data')
const recipients = keyedRows(readJson(path.join(RECORDS, 'crm-recipients.json'), {}).recipients, 'project_id', 'data')
const inquiries = keyedRows(readJson(path.join(RECORDS, 'crm-inquiries.json'), {}).inquiries, 'id', 'data')

const calFile = readJson(path.join(RECORDS, 'crm-calendar-map.json'), {})
const calendarMap = [{ id: 1, calendars: calFile.calendars || {}, projects: calFile.projects || {}, tasks: calFile.tasks || {} }]

// crm-config.json: everything except the _meta doc block, faithfully into one jsonb row.
const configFile = readJson(path.join(RECORDS, 'crm-config.json'), {})
const { _meta: _cfgMeta, ...configData } = configFile
const crmConfig = [{ id: 1, data: configData }]

// Loose settings that ride on top of record-array files.
const crmSettings = [{
  id: 1,
  mileage_rate_per_mile: num(mileageFile.ratePerMile),
  questionnaire_template: questionnaireFile.template || null,
}]

// ---------- 3. Execute ----------
console.log('Project ref:', projectRef)
console.log('Gathered (records -> table):')
const gathered = [
  ['payments', payments], ['expenses', expenses], ['tasks', tasks], ['emails', emails],
  ['templates', templates], ['notifications', notifications], ['text_markers', textMarkers],
  ['mileage_trips', mileageTrips], ['invoices', invoices], ['contracts', contracts],
  ['questionnaires', questionnaires], ['portals', portals], ['recipients', recipients],
  ['inquiries', inquiries], ['calendar_map', calendarMap], ['crm_config', crmConfig],
  ['crm_settings', crmSettings],
]
for (const [name, rows] of gathered) console.log(`  ${name}: ${rows.length}`)

// Report any non-numeric-in-numeric values we caught (so a silent-loss case surfaces loudly).
const traps = []
for (const p of payments) if (p.amount_text) traps.push(`payment ${p.id}: amount="${p.amount_text}"`)
for (const e of expenses) if (e.amount_text) traps.push(`expense ${e.id}: amount="${e.amount_text}"`)
for (const m of mileageTrips) if (m.miles_text) traps.push(`mileage ${m.id}: miles="${m.miles_text}"`)
console.log(traps.length
  ? `\nNon-numeric values preserved in companion text columns (${traps.length}):\n  ${traps.join('\n  ')}`
  : '\nNumeric-trap scan: no non-numeric values found in any numeric field.')

// Guard: this DROPS + rebuilds the Phase 2 tables from the files. Require explicit opt-in
// (matches Phase 1). Safe now since nothing depends on these tables yet, but keep the discipline.
if (process.env.CONFIRM_RESET !== 'yes') {
  console.error('\nRefusing to run: this DROPS and rebuilds the Phase 2 Supabase tables from the JSON files.')
  console.error('To build + import:  CONFIRM_RESET=yes node supabase/import-phase2.mjs')
  process.exit(1)
}

console.log('\nCreating tables...')
await sql(DDL)
console.log('  tables created with RLS enabled.')

// PostgREST caches the schema; after DDL it needs a reload to see the new tables.
await sql("notify pgrst, 'reload schema';")
process.stdout.write('Waiting for data API to see the new tables')
let ready = false
for (let i = 0; i < 25; i++) {
  const res = await fetch(`${url}/rest/v1/payments?select=id&limit=1`, { headers: { apikey: secretKey, Authorization: `Bearer ${secretKey}` } })
  if (res.ok) { ready = true; break }
  process.stdout.write('.')
  await sleep(1000)
  if (i === 6) await sql("notify pgrst, 'reload schema';")
}
console.log(ready ? ' ready.' : ' timed out (will try inserting anyway).')

console.log('Inserting...')
for (const [name, rows] of gathered) {
  console.log(`  ${name}:`, await insert(name, rows))
}

// ---------- 4. Verify from the DB ----------
const countSql = gathered
  .map(([name], i) => `${i === 0 ? '' : 'union all '}select '${name}' as t, count(*) from ${name}`)
  .join('\n') + '\norder by 1;'
const counts = await sql(countSql)
const dbCounts = Object.fromEntries(counts.map((r) => [r.t, Number(r.count)]))
const srcCounts = Object.fromEntries(gathered.map(([name, rows]) => [name, rows.length]))

console.log('\nVerified in Supabase (db vs source):')
let mismatch = false
for (const [name] of gathered) {
  const ok = dbCounts[name] === srcCounts[name]
  if (!ok) mismatch = true
  console.log(`  ${name}: db=${dbCounts[name]} source=${srcCounts[name]} ${ok ? 'OK' : 'MISMATCH'}`)
}

// Spot-check one record per typed/keyed table round-trips a couple of fields.
async function getOne(table, selectCols, filter) {
  const res = await fetch(`${url}/rest/v1/${table}?select=${selectCols}&${filter}`, {
    headers: { apikey: secretKey, Authorization: `Bearer ${secretKey}` },
  })
  if (!res.ok) throw new Error(`spot-check ${table} failed: ${await res.text()}`)
  return (await res.json())[0]
}
console.log('\nSpot-checks (a couple of fields round-trip from the file):')
if (payments.length) {
  const p0 = payments[0]
  const got = await getOne('payments', 'id,amount,date_received', `id=eq.${p0.id}`)
  console.log(`  payments[0] ${p0.id}: amount ${got.amount}==${p0.amount} && date ${got.date_received}==${p0.date_received} -> ${Number(got.amount) === p0.amount && got.date_received === p0.date_received}`)
}
if (tasks.length) {
  const k0 = tasks[0]
  const got = await getOne('tasks', 'id,title,done', `id=eq.${k0.id}`)
  console.log(`  tasks[0] ${k0.id}: title="${got.title}"==="${k0.title}" && done ${got.done}==${k0.done} -> ${got.title === k0.title && got.done === k0.done}`)
}
if (emails.length) {
  const e0 = emails[0]
  const got = await getOne('emails', 'id,subject,status', `id=eq.${e0.id}`)
  console.log(`  emails[0] ${e0.id}: subject match ${got.subject === e0.subject} && status ${got.status}==${e0.status}`)
}
if (invoices.length) {
  const i0 = invoices[0]
  const got = await getOne('invoices', 'project_id,data', `project_id=eq.${i0.project_id}`)
  console.log(`  invoices[0] ${i0.project_id}: invoiceId ${got.data.invoiceId}==${i0.data.invoiceId} && total ${got.data.total}==${i0.data.total} -> ${got.data.invoiceId === i0.data.invoiceId && got.data.total === i0.data.total}`)
}
if (portals.length) {
  const p0 = portals[0]
  const got = await getOne('portals', 'project_id,data', `project_id=eq.${p0.project_id}`)
  console.log(`  portals[0] ${p0.project_id}: token match ${got.data.token === p0.data.token} && published ${got.data.published}==${p0.data.published}`)
}
{
  const got = await getOne('crm_settings', 'mileage_rate_per_mile,questionnaire_template', 'id=eq.1')
  console.log(`  crm_settings: ratePerMile ${got.mileage_rate_per_mile}==${crmSettings[0].mileage_rate_per_mile} && template present ${got.questionnaire_template != null}`)
}
{
  const got = await getOne('calendar_map', 'projects,tasks', 'id=eq.1')
  const pn = Object.keys(got.projects || {}).length, tn = Object.keys(got.tasks || {}).length
  console.log(`  calendar_map: projects ${pn}==${Object.keys(calFile.projects || {}).length} && tasks ${tn}==${Object.keys(calFile.tasks || {}).length}`)
}

console.log(mismatch ? '\nDONE WITH MISMATCHES — review above.' : '\nDone. All counts match.')
