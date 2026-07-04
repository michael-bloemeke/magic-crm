// Smoke test for crm-store.mjs read helpers against the live Supabase data. Read-only. Run:
//   node supabase/test-store.mjs
import * as store from '../crm-store.mjs'

const projects = await store.getAllProjects()
const contacts = await store.getContacts()
const linksMap = await store.getLinksMap()
const meta = await store.getPipelineMeta()

console.log('CRM_STORE flag:', store.CRM_STORE, '(default files; helpers still callable directly)')
console.log('projects:', projects.length)
console.log('contacts:', contacts.length)
console.log('projects with >=1 linked contact:', Object.keys(linksMap).length)
console.log('pipeline structure umbrellas:', meta.structure?.umbrellas?.length, '| flow_layout present:', !!meta.flow_layout)

const shahil = projects.find((p) => p.id === 'shahil-amin')
console.log('\nSample raw project row (snake_case, as normalize() expects):')
console.log('  id:', shahil?.id, '| client_name:', shahil?.client_name, '| stage_id:', shahil?.stage_id)
console.log('  total_fee:', shahil?.total_fee, '| bucket:', shahil?.bucket, '| links_seeded:', shahil?.links_seeded)
console.log('  activity_log is array:', Array.isArray(shahil?.activity_log), '| first entry:', shahil?.activity_log?.[0]?.slice(0, 60))

// Find a project that's seeded but has zero contacts (the resurrection-bug case).
const seededEmpty = projects.find((p) => p.links_seeded && !linksMap[p.id])
console.log('\nSeeded-but-empty project (would be re-seeded without the flag):', seededEmpty ? seededEmpty.id : '(none)')

const c = contacts.find((x) => x.name === 'Shahil Amin')
console.log('\nSample contact row:')
console.log('  name:', c?.name, '| emails:', JSON.stringify(c?.emails), '| type:', c?.type, '| relationship:', c?.relationship)
console.log('  created_at:', c?.created_at)
console.log('\nAll read helpers OK.')
