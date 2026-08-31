import type { EmailAttachment } from './api'

// Small helpers shared by the attachment UI and the sent-email receipt. They live outside
// EmailAttachments.tsx so that file only exports a component and Fast Refresh keeps working.

/** A stable identity for an attachment chip: uploads key on their id, Files items on their name. */
export function attachKey(a: EmailAttachment): string {
  return `${a.source}:${a.id || a.name}`
}

export function fmtSize(bytes: number): string {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
