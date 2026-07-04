// Parity dump: prints a single deterministic JSON object with the app's four READ funnels'
// outputs, so the same read code can be compared across CRM_STORE=files and CRM_STORE=supabase.
//
// Under supabase we must prime the in-memory cache first (one await), because the read funnels
// are synchronous and serve from that cache. Under files nothing to init.
//
// Determinism: projects sorted by id, contacts sorted by id, links map keys sorted, structure
// object keys sorted, and ALL object keys sorted recursively before stringify. Run with Node 22:
//   CRM_STORE=files    /path/to/node22 supabase/dump-reads.mjs
//   CRM_STORE=supabase /path/to/node22 supabase/dump-reads.mjs

import { CRM_STORE, initStore } from '../crm-store.mjs'
import { loadAll, loadStructure } from '../crm-data-core.mjs'
import { loadContacts } from '../crm-contacts.mjs'
import { loadLinks } from '../crm-links.mjs'

if (CRM_STORE === 'supabase') await initStore()

// Recursively sort object keys so JSON.stringify is stable regardless of insertion order.
// Arrays keep their order (callers sort the arrays that need a canonical order explicitly).
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') {
    const out = {}
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k])
    return out
  }
  return v
}

const projects = loadAll().projects.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
const contacts = loadContacts().slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
// Links: a project's contact set is unordered (files stores insertion order; supabase returns
// contact_links rows in arbitrary order). Sort each array so equal sets compare equal. Key order
// is normalized by sortKeys below.
const rawLinks = loadLinks()
const links = {}
for (const [pid, ids] of Object.entries(rawLinks)) links[pid] = [...ids].sort()
const structure = loadStructure()

const out = sortKeys({
  projects,
  contacts,
  links,
  structure,
})

process.stdout.write(JSON.stringify(out))
