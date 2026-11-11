import { saveGmailDraft, sendGmailDraft, type DraftFields } from './api'

// One composer's link to its Gmail draft. Both composers (the thread reply box and the "Write email"
// window) use it, so autosave, sending and discarding behave the same everywhere.
//
// Saves are DEBOUNCED and SERIALIZED: typing schedules a save, and saves run one at a time in order,
// so the first save's draft id is always known before the next one runs. Without that, two quick
// saves would both create a draft and leave a duplicate in Gmail.

export type DraftStatus =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: number }
  | { kind: 'error'; message: string }

const SAVE_DELAY_MS = 1200

export class DraftSession {
  draftId: string | undefined
  threadId: string | undefined
  private inReplyTo: string | undefined
  private references: string | undefined
  private pending: DraftFields | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private chain: Promise<void> = Promise.resolve()
  private onStatus: (s: DraftStatus) => void

  constructor(
    init: { draftId?: string; threadId?: string; inReplyTo?: string; references?: string },
    onStatus: (s: DraftStatus) => void,
  ) {
    this.draftId = init.draftId || undefined
    this.threadId = init.threadId || undefined
    this.inReplyTo = init.inReplyTo || undefined
    this.references = init.references || undefined
    this.onStatus = onStatus
  }

  private withIds(fields: DraftFields): DraftFields {
    return {
      ...fields,
      draftId: this.draftId,
      threadId: this.threadId,
      inReplyTo: this.inReplyTo,
      references: this.references,
    }
  }

  // Note the latest content and save it shortly, unless more typing arrives first.
  schedule(fields: DraftFields) {
    this.pending = fields
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flush(), SAVE_DELAY_MS)
    // Say so straight away: "Saved" must never show while an edit is still waiting to go up.
    this.onStatus({ kind: 'saving' })
  }

  // Save whatever is pending now. Resolves once every save queued so far has finished.
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const fields = this.pending
    this.pending = null
    if (fields) {
      this.chain = this.chain.then(async () => {
        this.onStatus({ kind: 'saving' })
        try {
          const r = await saveGmailDraft(this.withIds(fields))
          this.draftId = r.draftId
          // threadId is NOT adopted from the save: a new email's draft gets a thread of its own, and
          // treating that as "a reply" would change how it is sent.
          this.inReplyTo = r.inReplyTo || this.inReplyTo
          this.references = r.references || this.references
          this.onStatus({ kind: 'saved', at: Date.now() })
        } catch (e) {
          this.onStatus({ kind: 'error', message: e instanceof Error ? e.message : String(e) })
        }
      })
    }
    return this.chain
  }

  // Drop anything scheduled but not yet saved (used when the content is cleared or discarded).
  cancelPending() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending = null
  }

  // Send the email. The latest content goes with the send itself, so nothing typed after the last
  // autosave is lost; the draft (if one exists) is what Gmail sends, which moves it out of Drafts.
  async send(fields: DraftFields & { projectId?: string }) {
    this.cancelPending()
    await this.chain
    const r = await sendGmailDraft(this.withIds(fields))
    this.draftId = undefined
    return r
  }

  // Hand the draft id over (to be discarded with an Undo, by the caller) and forget it here. The last
  // keystrokes are saved first, so if the discard is undone the draft comes back exactly as it was.
  async release(): Promise<string | undefined> {
    await this.flush()
    const id = this.draftId
    this.draftId = undefined
    this.onStatus({ kind: 'idle' })
    return id
  }
}

// "Saved to Gmail drafts" / "Saving…" for the status line under a composer.
export function draftStatusText(s: DraftStatus): string {
  if (s.kind === 'saving') return 'Saving to Gmail drafts…'
  if (s.kind === 'saved') return 'Saved to Gmail drafts'
  if (s.kind === 'error') return `Not saved: ${s.message}`
  return ''
}

// True if an HTML body has real content (text, or a picture), ignoring empty tags.
export function htmlHasContent(html: string): boolean {
  if (/<(img|video|audio)\b/i.test(html)) return true
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim() !== ''
}
