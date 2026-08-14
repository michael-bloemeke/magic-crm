// Leads: enquiries that have NOT yet earned a place in the pipeline.
//
// Mostly GigSalad, The Bash and Bark, sometimes Instagram or an in-person conversation. A project
// in the pipeline means Michael is actually working it; a lead is someone he still has to reach.
// Keeping them apart stops the pipeline from filling with marketplace noise that has never had a
// reply, which is what makes the pipeline's own counts meaningful.
//
// A lead LEAVES this page in one of two ways, and NEITHER destroys the row:
//   convertLead()  -> creates the real project, stamps converted_at + converted_project_id
//   archiveLead()  -> stamps archived_at, optionally after saving the person as a contact
//
// Nothing is hard-deleted on purpose. Michael's reason (2026-08-07): "i do want to save the contact
// information of all these leads even if they never get on the phone so that I can add them to my
// mailing list and out reach." A lead that went nowhere is still a name, an email and a source.

import { sb } from './crm-store.mjs'
import { createProject } from './crm-data-core.mjs'
import { addContact, loadContacts } from './crm-contacts.mjs'

export const LEAD_SOURCES = ['gigsalad', 'the-bash', 'bark', 'other']
export const LEAD_SOURCE_LABELS = {
  gigsalad: 'GigSalad',
  'the-bash': 'The Bash',
  bark: 'Bark',
  other: 'Other',
}

const str = (v) => (v == null ? '' : String(v))
const clean = (v) => str(v).trim()
// A date field is either a real YYYY-MM-DD or empty. Anything else is a typo, and storing it would
// quietly break sorting and the follow-up check.
const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(clean(v)) ? clean(v) : '')
const source = (v) => (LEAD_SOURCES.includes(clean(v).toLowerCase()) ? clean(v).toLowerCase() : 'other')

function fromRow(r) {
  return {
    id: str(r.id),
    title: str(r.title),
    source: str(r.source),
    leadDate: str(r.lead_date),
    followUpDate: str(r.follow_up_date),
    name: str(r.name),
    email: str(r.email),
    phone: str(r.phone),
    notes: str(r.notes),
    convertedAt: str(r.converted_at),
    convertedProjectId: str(r.converted_project_id),
    archivedAt: str(r.archived_at),
    contactId: str(r.contact_id),
    createdAt: str(r.created_at),
  }
}

// The open board: everything not yet converted or archived. Newest lead first, because a marketplace
// enquiry goes cold fast and the top of this list is the work.
export async function loadLeads() {
  const { data, error } = await sb()
    .from('leads')
    .select('*')
    .is('converted_at', null)
    .is('archived_at', null)
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data || []).map(fromRow)
}

export async function addLead(input = {}) {
  const row = {
    title: clean(input.title),
    source: source(input.source),
    lead_date: date(input.leadDate) || new Date().toISOString().slice(0, 10),
    follow_up_date: date(input.followUpDate),
    name: clean(input.name),
    email: clean(input.email),
    phone: clean(input.phone),
    notes: str(input.notes),
  }
  const { data, error } = await sb().from('leads').insert(row).select('*').single()
  if (error) throw error
  return fromRow(data)
}

const FIELD_MAP = {
  title: 'title',
  source: 'source',
  leadDate: 'lead_date',
  followUpDate: 'follow_up_date',
  name: 'name',
  email: 'email',
  phone: 'phone',
  notes: 'notes',
}

export async function updateLead(id, patch = {}) {
  if (!id) throw new Error('lead id is required')
  const row = { updated_at: new Date().toISOString() }
  for (const [k, col] of Object.entries(FIELD_MAP)) {
    if (!(k in patch)) continue
    if (col === 'source') row[col] = source(patch[k])
    else if (col.endsWith('_date')) row[col] = date(patch[k])
    else if (col === 'notes') row[col] = str(patch[k])
    else row[col] = clean(patch[k])
  }
  const { data, error } = await sb().from('leads').update(row).eq('id', id).select('*').single()
  if (error) throw error
  return fromRow(data)
}

// Find an existing contact by email before making a new one. Without this, converting three leads
// from the same person produces three near-identical contacts, which is exactly the mess the
// contact cleanup on 2026-08-06 had to undo by hand.
function findContactByEmail(email) {
  const e = clean(email).toLowerCase()
  if (!e) return null
  return (
    loadContacts().find((c) => (c.emails || []).some((x) => String(x).trim().toLowerCase() === e)) || null
  )
}

// Save the person behind a lead as a real contact, so they can go on the mailing list. Returns the
// contact (existing or new). The lead's SOURCE goes in the contact's notes, never in the name:
// a contact's name is only ever the person's name.
export async function contactFromLead(lead) {
  const name = clean(lead?.name)
  if (!name) throw new Error('This lead has no name, so there is nothing to save as a contact.')
  const existing = findContactByEmail(lead.email)
  if (existing) return { contact: existing, reused: true }
  const label = LEAD_SOURCE_LABELS[source(lead.source)] || 'Other'
  const contact = await addContact({
    name,
    type: 'client',
    emails: clean(lead.email) ? [clean(lead.email)] : [],
    phones: clean(lead.phone) ? [clean(lead.phone)] : [],
    relationship: 'maybe',
    notes: `Lead from ${label}${clean(lead.leadDate) ? ` on ${clean(lead.leadDate)}` : ''}. Never booked.`,
  })
  return { contact, reused: false }
}

// Clear a lead off the board. keepContact saves them for outreach first.
export async function archiveLead(id, { keepContact = false } = {}) {
  if (!id) throw new Error('lead id is required')
  const { data: found, error: readErr } = await sb().from('leads').select('*').eq('id', id).maybeSingle()
  if (readErr) throw readErr
  if (!found) throw new Error('Lead not found.')
  const lead = fromRow(found)

  let contact = null
  let reused = false
  if (keepContact && lead.name) {
    const r = await contactFromLead(lead)
    contact = r.contact
    reused = r.reused
  }

  const patch = { archived_at: new Date().toISOString(), updated_at: new Date().toISOString() }
  if (contact) patch.contact_id = contact.id
  const { error } = await sb().from('leads').update(patch).eq('id', id)
  if (error) throw error
  return { ok: true, id, contact, reused }
}

// Promote a lead into a real project. The caller has already collected whatever was missing, so
// everything here is a straight write; the lead is stamped rather than deleted so the trail from
// "GigSalad enquiry" to "booked job" survives.
//
// The contact is created and linked too: a project that starts life with a real contact record
// behaves the same as one built by hand, which is what makes "Ready to book" work later.
export async function convertLead(id, input = {}) {
  if (!id) throw new Error('lead id is required')
  const { data: found, error: readErr } = await sb().from('leads').select('*').eq('id', id).maybeSingle()
  if (readErr) throw readErr
  if (!found) throw new Error('Lead not found.')
  const lead = fromRow(found)

  const clientName = clean(input.clientName) || clean(lead.title) || clean(lead.name)
  if (!clientName) throw new Error('A project name is required.')

  const project = await createProject({
    clientName,
    eventType: clean(input.eventType),
    eventDate: date(input.eventDate),
    eventLocation: clean(input.eventLocation),
    totalFee: clean(input.totalFee),
    contactNames: clean(input.name) || clean(lead.name),
    contactEmails: clean(input.email) || clean(lead.email),
    contactPhones: clean(input.phone) || clean(lead.phone),
    // Where it came from is a real CRM field, so it does not have to live in prose.
    bookingSource: LEAD_SOURCE_LABELS[source(lead.source)] || 'Other',
    projectNotes: str(input.notes ?? lead.notes),
  })

  // Best effort: a join-table hiccup must not make a successful conversion look like a failure.
  let contact = null
  try {
    const r = await contactFromLead({ ...lead, name: clean(input.name) || lead.name })
    contact = r.contact
    const { addLink } = await import('./crm-store.mjs')
    await addLink(project.id, contact.id)
  } catch (e) {
    console.error('[crm-leads] could not link a contact for the converted lead:', e?.message || e)
  }

  const { error } = await sb()
    .from('leads')
    .update({
      converted_at: new Date().toISOString(),
      converted_project_id: project.id,
      contact_id: contact ? contact.id : null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
  if (error) throw error

  return { ok: true, id, project, contact }
}
