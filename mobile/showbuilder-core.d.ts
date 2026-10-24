// Types for showbuilder-core.js, for the Mac's TypeScript (src/showbuilder/ShowCanvas.tsx imports
// cleanShow). The phone loads the .js directly and never reads this file; it is not published.
export type CleanShow = {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  showProps: string[]
  nodes: { id: string; type: string; position: { x: number; y: number }; data: Record<string, unknown> }[]
  edges: { id: string; source: string; target: string; sourceHandle?: string; targetHandle?: string }[]
}
export function cleanShow(raw: unknown): CleanShow
export function normalizeDoc(kind: string, raw: unknown): Record<string, unknown>
export function sortDocs<T>(kind: string, docs: T[]): T[]
export const KINDS: string[]
