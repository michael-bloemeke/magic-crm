// Parity dump for the FINANCE + TASKS read funnels: prints a single deterministic JSON object with
// loadPayments() / loadExpenses() / loadMileage() (crm-finance.mjs) and loadTasks() (crm-data-core),
// so the same read code can be compared across CRM_STORE=files and CRM_STORE=supabase.
//
// Under supabase we prime the in-memory cache first (one await); the read funnels are synchronous and
// serve from it. Under files nothing to init.
//
// Determinism: arrays sorted by id, and ALL object keys sorted recursively before stringify.
//
// NOTE on unrecoverable file/DB shape differences (documented, mirrored on BOTH sides so equal
// CONTENT compares equal, exactly like dump-reads.mjs sorts link arrays and verify-backup treats an
// absent key as an empty value):
//   - payments: the files omit `pending`/`method` on some historical rows; the DB stores them as
//     null. The app's own writer (addPayment) always emits pending=false + method="" for those, so we
//     canonicalize both sides to that (pending -> !!pending, method -> String(method||"")).
//   - createdAt: some file rows are already in Postgres offset/microsecond form (from prior nightly
//     backups); the DB returns offset form. isoZ() collapses both to the identical JS "...Z" instant.
//   - dueTime: loadTasks() already normalizes this identically in both backends (normalizeTime).
//
// Run with Node 22:
//   CRM_STORE=files    /path/to/node22 supabase/dump-finance-tasks.mjs
//   CRM_STORE=supabase /path/to/node22 supabase/dump-finance-tasks.mjs

import { CRM_STORE, initStore } from '../crm-store.mjs'
import { loadTasks } from '../crm-data-core.mjs'
import { loadPayments, loadExpenses, loadMileage } from '../crm-finance.mjs'

if (CRM_STORE === 'supabase') await initStore()

// Same isoZ the read paths use: collapse any timestamp text to the JS toISOString() "...Z" form so
// offset/microsecond forms in the files compare equal to the DB's offset form.
function isoZ(v) {
  const s = String(v ?? '').trim()
  if (!s) return ''
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? s : d.toISOString()
}

// Canonicalize a payment to the app-writer shape (fills the historically-absent pending/method), so
// files rows that predate those fields compare equal to the always-populated supabase read.
function canonPayment(p) {
  return {
    id: p.id,
    projectId: p.projectId == null ? '' : String(p.projectId),
    amount: p.amount,
    dateReceived: p.dateReceived == null ? '' : String(p.dateReceived),
    pending: !!p.pending,
    type: p.type == null ? 'deposit' : String(p.type),
    method: p.method == null ? '' : String(p.method),
    note: p.note == null ? '' : String(p.note),
    createdAt: isoZ(p.createdAt),
  }
}
function canonExpense(e) {
  return {
    id: e.id,
    name: e.name == null ? '' : String(e.name),
    amount: e.amount,
    cadence: e.cadence == null ? 'monthly' : String(e.cadence),
    category: e.category == null ? '' : String(e.category),
    note: e.note == null ? '' : String(e.note),
    createdAt: isoZ(e.createdAt),
  }
}
function canonTrip(t) {
  return {
    id: t.id,
    date: t.date == null ? '' : String(t.date),
    miles: t.miles,
    purpose: t.purpose == null ? '' : String(t.purpose),
    projectId: t.projectId == null ? '' : String(t.projectId),
    createdAt: isoZ(t.createdAt),
  }
}
function canonTask(t) {
  return {
    id: t.id,
    projectId: t.projectId == null ? '' : String(t.projectId),
    title: t.title == null ? '' : String(t.title),
    dueDate: t.dueDate == null ? '' : String(t.dueDate),
    dueTime: t.dueTime == null ? '' : String(t.dueTime),
    done: !!t.done,
    createdAt: isoZ(t.createdAt),
  }
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') {
    const out = {}
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k])
    return out
  }
  return v
}

const byId = (arr) => arr.slice().sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0))

const mileage = loadMileage()
const out = sortKeys({
  payments: byId(loadPayments().map(canonPayment)),
  expenses: byId(loadExpenses().map(canonExpense)),
  mileage: {
    ratePerMile: mileage.ratePerMile,
    trips: byId((mileage.trips || []).map(canonTrip)),
  },
  tasks: byId(loadTasks().map(canonTask)),
})

process.stdout.write(JSON.stringify(out))
