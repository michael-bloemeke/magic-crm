// Phase 1 Supabase setup + import: projects, contacts, contact_links, pipeline_meta.
// NON-DESTRUCTIVE to the live CRM: only READS the Project Records JSON and writes to Supabase.
// Idempotent: drops + recreates these four tables and re-imports every run. Safe to re-run while
// nothing else depends on the tables yet. Reads keys from ../supabase-credentials.json (gitignored).
//
// Run:  node supabase/import-phase1.mjs

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(DIR, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const RECORDS = '/Users/michaelbloemeke/Desktop/claude/The Award-Winning Magic of Michael Bloemeke/Project Records'

const creds = JSON.parse(fs.readFileSync(path.join(REPO, 'supabase-credentials.json'), 'utf8'))
const { url, projectRef, publishableKey, secretKey, accessToken } = creds

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}
function num(v) {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}
function t(v) {
  return v === undefined ? null : v
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
const DDL = `
drop table if exists contact_links cascade;
drop table if exists projects cascade;
drop table if exists contacts cascade;
drop table if exists pipeline_meta cascade;

create table projects (
  id text primary key,
  client_name text not null,
  project_name text,
  bucket text not null default 'active',
  stage_id text,
  event_type text,
  event_date text,
  event_location text,
  venue_type text,
  indoors_or_outdoors text,
  arrival_time text,
  event_start_time text,
  show_start_time text,
  number_of_guests text,
  age_of_guests text,
  performance_style text,
  total_fee numeric,
  tips numeric,
  tips_method text,
  mileage numeric,
  vips text,
  av text,
  contact_names text,
  contact_emails text,
  contact_phones text,
  booking_source text,
  event_summary text,
  event_description text,
  project_notes text,
  how_it_went text,
  assets text,
  status text,
  flags jsonb not null default '[]',
  activity_log jsonb not null default '[]',
  archive_reason text,
  why_archived text,
  completed_date text,
  links_seeded boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table projects enable row level security;

create table contacts (
  id uuid primary key,
  name text,
  emails jsonb not null default '[]',
  phones jsonb not null default '[]',
  type text,
  relationship text,
  engagement text,
  tags jsonb not null default '[]',
  notes text,
  created_at timestamptz,
  updated_at timestamptz
);
alter table contacts enable row level security;

create table contact_links (
  project_id text not null references projects(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  primary key (project_id, contact_id)
);
alter table contact_links enable row level security;

create table pipeline_meta (
  id int primary key default 1,
  structure jsonb,
  flow_layout jsonb,
  updated_at timestamptz not null default now(),
  constraint pipeline_meta_singleton check (id = 1)
);
alter table pipeline_meta enable row level security;
`

// ---------- 2. Gather data ----------
const pipeline = readJson(path.join(RECORDS, 'crm-pipeline.json'), {})
const stages = pipeline.stages || {}

// A project is "seeded" (its contact links were initialized) if it has ANY entry in crm-links.json,
// even an empty array. Preserve that flag so the app never re-seeds and resurrects a deleted contact.
const seededSet = new Set(Object.keys(readJson(path.join(RECORDS, 'crm-links.json'), {}).links || {}))

// project bucket files
const files = fs.readdirSync(RECORDS)
const bucketFiles = [
  ['active-projects.json', 'active'],
  ...files.filter((f) => /^completed-\d{4}\.json$/.test(f)).map((f) => [f, 'completed']),
  ...files.filter((f) => /^archived-\d{4}\.json$/.test(f)).map((f) => [f, 'archived']),
]

const byId = new Map()
const dupes = []
for (const [file, bucket] of bucketFiles) {
  const parsed = readJson(path.join(RECORDS, file), {})
  const list = parsed.projects || (Array.isArray(parsed) ? parsed : [])
  for (const p of list) {
    const id = slug(p.client_name)
    if (!id) continue
    if (byId.has(id)) { dupes.push(`${id} (${file})`); continue }
    byId.set(id, {
      id,
      client_name: p.client_name,
      project_name: t(p.project_name),
      bucket,
      stage_id: stages[id] || null,
      event_type: t(p.event_type),
      event_date: t(p.event_date),
      event_location: t(p.event_location),
      venue_type: t(p.venue_type),
      indoors_or_outdoors: t(p.indoors_or_outdoors),
      arrival_time: t(p.arrival_time),
      event_start_time: t(p.event_start_time),
      show_start_time: t(p.show_start_time),
      number_of_guests: t(p.number_of_guests),
      age_of_guests: t(p.age_of_guests),
      performance_style: t(p.performance_style),
      total_fee: num(p.total_fee),
      tips: num(p.tips),
      tips_method: t(p.tips_method),
      mileage: num(p.mileage),
      vips: t(p.vips),
      av: t(p.av),
      contact_names: t(p.contact_names),
      contact_emails: t(p.contact_emails),
      contact_phones: t(p.contact_phones),
      booking_source: t(p.booking_source),
      event_summary: t(p.event_summary),
      event_description: t(p.event_description),
      project_notes: t(p.project_notes),
      how_it_went: t(p.how_it_went),
      assets: t(p.assets),
      status: t(p.status),
      flags: Array.isArray(p.flags) ? p.flags : [],
      activity_log: Array.isArray(p.activity_log) ? p.activity_log : [],
      archive_reason: t(p.archive_reason),
      why_archived: t(p.why_archived),
      completed_date: t(p.completed_date),
      links_seeded: seededSet.has(id),
    })
  }
}
const projects = [...byId.values()]

const contactsRaw = readJson(path.join(RECORDS, 'crm-contacts.json'), {}).contacts || []
const contacts = contactsRaw.map((c) => ({
  id: c.id,
  name: t(c.name),
  emails: Array.isArray(c.emails) ? c.emails : [],
  phones: Array.isArray(c.phones) ? c.phones : [],
  type: t(c.type),
  relationship: t(c.relationship),
  engagement: t(c.engagement),
  tags: Array.isArray(c.tags) ? c.tags : [],
  notes: t(c.notes),
  created_at: t(c.createdAt),
  updated_at: t(c.updatedAt),
}))

const linksRaw = readJson(path.join(RECORDS, 'crm-links.json'), {}).links || {}
const projectIds = new Set(projects.map((p) => p.id))
const contactIds = new Set(contacts.map((c) => c.id))
const links = []
const skippedLinks = []
for (const [projectId, ids] of Object.entries(linksRaw)) {
  for (const contactId of ids || []) {
    if (projectIds.has(projectId) && contactIds.has(contactId)) links.push({ project_id: projectId, contact_id: contactId })
    else skippedLinks.push(`${projectId} -> ${contactId}`)
  }
}

const pipelineMeta = [{ id: 1, structure: pipeline.structure || null, flow_layout: pipeline.flowLayout || null }]

// ---------- 3. Execute ----------
console.log('Project ref:', projectRef)
console.log(`Gathered: ${projects.length} projects, ${contacts.length} contacts, ${links.length} links`)
if (dupes.length) console.log('Duplicate project slugs skipped:', dupes.join(', '))
if (skippedLinks.length) console.log(`Orphan links skipped (${skippedLinks.length}):`, skippedLinks.slice(0, 10).join(', '), skippedLinks.length > 10 ? '...' : '')

console.log('\nCreating tables...')
await sql(DDL)
console.log('  tables created (projects, contacts, contact_links, pipeline_meta) with RLS enabled.')

// PostgREST caches the schema; after DDL it needs a reload to see the new tables.
await sql("notify pgrst, 'reload schema';")
process.stdout.write('Waiting for data API to see the new tables')
let ready = false
for (let i = 0; i < 25; i++) {
  const res = await fetch(`${url}/rest/v1/projects?select=links_seeded&limit=1`, { headers: { apikey: secretKey, Authorization: `Bearer ${secretKey}` } })
  if (res.ok) { ready = true; break }
  process.stdout.write('.')
  await sleep(1000)
  if (i === 6) await sql("notify pgrst, 'reload schema';")
}
console.log(ready ? ' ready.' : ' timed out (will try inserting anyway).')

console.log('Inserting...')
console.log('  projects:', await insert('projects', projects))
console.log('  contacts:', await insert('contacts', contacts))
console.log('  contact_links:', await insert('contact_links', links))
console.log('  pipeline_meta:', await insert('pipeline_meta', pipelineMeta))

// ---------- 4. Verify from the DB ----------
const counts = await sql(
  `select 'projects' as t, count(*) from projects
   union all select 'contacts', count(*) from contacts
   union all select 'contact_links', count(*) from contact_links
   union all select 'pipeline_meta', count(*) from pipeline_meta
   union all select 'active projects', count(*) from projects where bucket='active'
   order by 1;`
)
console.log('\nVerified in Supabase:')
for (const r of counts) console.log(`  ${r.t}: ${r.count}`)
console.log('\nDone.')
