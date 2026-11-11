import { createContext } from 'react'

// One thing a project shares its event date with: another CRM project (it has a projectId, so its
// name can be clicked to open it) or a Google "Gigs" calendar entry (a title only, nothing to open).
export type ConflictPartner = { name: string; projectId?: string }

// Built once in App.tsx (dateConflictInfo) and read by DateConflictFlag, so every card, row, and
// header can NAME the clash, and open the other project, without each list handing that down.
export const DateConflictContext = createContext<{
  info: Map<string, ConflictPartner[]>
  open: (projectId: string) => void
}>({ info: new Map(), open: () => {} })
