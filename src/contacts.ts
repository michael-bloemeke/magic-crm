import type { Contact, ProjectLinks, Relationship } from './api'
import type { Project } from './pipeline'

// Shared contact metadata + project-linking helpers, used by the Contacts page,
// the contact drawer, and the archive/complete dialogs so they all agree.

// Relationship options in display order. 'active' (blue) = in the pipeline now;
// yes/no/maybe are the durable post-pipeline dispositions.
export const RELATIONSHIP_OPTIONS: { v: Exclude<Relationship, ''>; label: string; color: string }[] = [
  { v: 'active', label: 'Active', color: '#0e7490' },
  { v: 'yes', label: 'Yes', color: 'var(--color-umb-booked)' },
  // Amber, not the accent: the accent is now blue and would have collided with "Active".
  { v: 'maybe', label: 'Maybe', color: '#b45309' },
  { v: 'no', label: 'No', color: '#dc2626' },
]

export const REL_COLOR: Record<string, string> = Object.fromEntries(
  RELATIONSHIP_OPTIONS.map((o) => [o.v, o.color]),
)

// All filter values for the Contacts list (including "all").
export const REL_FILTER_VALUES: (Relationship | 'all')[] = ['all', 'active', 'yes', 'maybe', 'no']

// The contacts attached to a single project, from the explicit stored links
// (links[projectId] = contact ids). Order follows the stored link order.
export function contactsForProject(project: Project, contacts: Contact[], links: ProjectLinks): Contact[] {
  const ids = links[project.id] || []
  const byId = new Map(contacts.map((c) => [c.id, c]))
  return ids.map((id) => byId.get(id)).filter((c): c is Contact => !!c)
}

// The projects a contact is attached to (reverse lookup over the same links).
export function linkedProjectsFor(contact: Contact, projects: Project[], links: ProjectLinks): Project[] {
  return projects.filter((p) => (links[p.id] || []).includes(contact.id))
}
