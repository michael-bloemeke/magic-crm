import { useEffect, useMemo, useState } from 'react'
import {
  loadConfig,
  loadContacts,
  loadLinks,
  saveConfig,
  updateContact,
  type Contact,
  type Relationship,
} from '../api'
import type { Project } from '../pipeline'
import { contactsForProject } from '../contacts'
import { RelationshipChips } from './RelationshipChips'
import { TagEditor } from './TagEditor'

// Shown inside the archive/complete dialogs: the client(s) on this project, with
// their relationship (Active/Yes/Maybe/No) and tags, editable on the spot. This
// is the moment a client leaves the pipeline, so it's where Michael reassigns
// 'active' to a durable yes/no/maybe and adds any tags. Loading contacts also
// triggers the server-side auto-sync, so a brand-new project's contact exists.

export function ContactTagger({ project }: { project: Project }) {
  const [contacts, setContacts] = useState<Contact[] | null>(null)
  const [knownTags, setKnownTags] = useState<string[]>([])

  useEffect(() => {
    let live = true
    Promise.all([loadContacts(), loadLinks(), loadConfig().catch(() => null)])
      .then(([all, links, config]) => {
        if (!live) return
        setContacts(contactsForProject(project, all, links))
        const used = all.flatMap((c) => c.tags)
        const lib = config?.contactTags ?? []
        setKnownTags(dedupe([...lib, ...used]))
      })
      .catch(() => live && setContacts([]))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id])

  const patch = (id: string, fields: Partial<Contact>) => {
    setContacts((prev) => (prev ? prev.map((c) => (c.id === id ? { ...c, ...fields } : c)) : prev))
    updateContact({ id, ...fields }).catch(() => {})
  }

  const registerTag = (tag: string) => {
    setKnownTags((prev) => (prev.some((t) => t.toLowerCase() === tag.toLowerCase()) ? prev : [...prev, tag]))
    loadConfig()
      .then((cfg) => saveConfig({ contactTags: [...(cfg.contactTags ?? []), tag] }))
      .catch(() => {})
  }

  const heading = useMemo(
    () => (contacts && contacts.length > 1 ? 'Clients' : 'Client'),
    [contacts],
  )

  if (contacts == null) {
    return <p className="text-[12px] text-faint">Loading client…</p>
  }
  if (contacts.length === 0) {
    return <p className="text-[12px] text-faint">No linked contact found for this project.</p>
  }

  return (
    <div className="space-y-4">
      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-faint">{heading}</p>
      {contacts.map((c) => (
        <div key={c.id} className="space-y-2 rounded-xl border border-line bg-surface-2/40 p-3">
          <p className="text-[13.5px] text-parchment">{c.name}</p>
          <RelationshipChips value={c.relationship} onChange={(v: Relationship) => patch(c.id, { relationship: v })} />
          <TagEditor
            tags={c.tags}
            knownTags={knownTags}
            onChange={(tags) => patch(c.id, { tags })}
            onNewTag={registerTag}
          />
        </div>
      ))}
    </div>
  )
}

function dedupe(arr: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of arr) {
    const s = String(raw).trim()
    if (!s) continue
    const k = s.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(s)
  }
  return out
}
