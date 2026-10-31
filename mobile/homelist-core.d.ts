// Types for homelist-core.js, for the Mac's TypeScript (src/components/HomePage.tsx). The phone loads
// the .js directly and never reads this file; it is not published.
export type PlateItem = { id: string; text: string; createdAt: string; position: number | null; depth: number }
export type PlateLayout = { id: string; position: number | null; depth: number }
export const MAX_DEPTH: number
export function sortItems<T extends PlateItem>(items: T[]): T[]
export function normalize<T extends PlateItem>(items: T[]): T[]
export function blockEnd(items: PlateItem[], i: number): number
export function canIndent(items: PlateItem[], id: string): boolean
export function indent<T extends PlateItem>(items: T[], id: string): T[]
export function canOutdent(items: PlateItem[], id: string): boolean
export function outdent<T extends PlateItem>(items: T[], id: string): T[]
export function canMoveUp(items: PlateItem[], id: string): boolean
export function moveUp<T extends PlateItem>(items: T[], id: string): T[]
export function canMoveDown(items: PlateItem[], id: string): boolean
export function moveDown<T extends PlateItem>(items: T[], id: string): T[]
export function insertAfter<T extends PlateItem>(items: T[], id: string | null, item: T): T[]
export function removeItem<T extends PlateItem>(items: T[], id: string): T[]
export function rename<T extends PlateItem>(items: T[], id: string, text: string): T[]
export function withPositions<T extends PlateItem>(items: T[]): T[]
export function layoutChanges(before: PlateItem[], after: PlateItem[]): PlateLayout[]
