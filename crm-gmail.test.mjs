// Regression test for unsent-draft handling in crm-gmail.mjs buildThread().
//
// The bug this guards: a Gmail draft carries a To header and lives in the mailbox with the DRAFT
// label, so a to:/from: thread search returns it like real mail and the CRM rendered it as a message
// the client had received. On the pane Michael uses to check what a client actually got, a phantom
// sent message is worse than a missing one.
//
// Fixture-based on purpose: drafts come and go, so there is not always a real one in the mailbox to
// test against, and this must keep working when there are none.
//
// Run it:  node crm-gmail.test.mjs      (exits non-zero on failure)
import { buildThread } from './crm-gmail.mjs'

const ME = 'michael@michaelbloemeke.com'
const CLIENT = 'client@example.com'

// Minimal shape of what threads.get(format:'full') returns for one message.
function msg({ id, from, to, date, body, labels }) {
  return {
    id,
    internalDate: String(Date.parse(date)),
    labelIds: labels,
    snippet: body,
    payload: {
      headers: [
        { name: 'From', value: from },
        { name: 'To', value: to },
        { name: 'Subject', value: 'Test subject' },
      ],
      mimeType: 'text/plain',
      body: { data: Buffer.from(body, 'utf8').toString('base64url') },
    },
  }
}

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

// --- Case 1: a thread with real sent mail AND an unsent draft reply -----------
// This is the case that must NOT lose the real messages (why we don't use -in:draft).
const mixed = buildThread(
  {
    data: {
      id: 't1',
      messages: [
        msg({ id: 'm1', from: `Michael <${ME}>`, to: CLIENT, date: '2026-07-21T15:00:00Z', body: 'Real sent one', labels: ['SENT'] }),
        msg({ id: 'm2', from: `Client <${CLIENT}>`, to: ME, date: '2026-07-22T15:00:00Z', body: 'Client replied', labels: ['INBOX', 'UNREAD'] }),
        msg({ id: 'm3', from: `Michael <${ME}>`, to: CLIENT, date: '2026-07-31T15:00:00Z', body: 'Unsent ghostbuster [INSERT GIF]', labels: ['DRAFT'] }),
      ],
    },
  },
  ME,
)

check('mixed thread keeps all 3 messages', mixed.messages.length, 3)
check('real messages are not flagged as drafts', mixed.messages.slice(0, 2).map((m) => !!m.isDraft), [false, false])
check('the draft IS flagged', mixed.messages[2].isDraft, true)
check('the draft has NO send date', mixed.messages[2].date, '')
check('real messages keep their dates', mixed.messages.slice(0, 2).map((m) => m.date), ['Jul 21, 2026', 'Jul 22, 2026'])
check('thread lastDate comes from the last SENT message, not the draft', mixed.lastDate, 'Jul 22, 2026')
check('thread lastTs comes from the last SENT message', mixed.lastTs, Date.parse('2026-07-22T15:00:00Z'))
check('thread flags that a draft is waiting', mixed.hasDraft, true)
check('unread count counts only the real unread message', mixed.unread, 1)

// --- Case 2: a thread that is ONLY an unsent draft ---------------------------
const draftOnly = buildThread(
  {
    data: {
      id: 't2',
      messages: [
        msg({ id: 'm1', from: `Michael <${ME}>`, to: CLIENT, date: '2026-07-31T15:00:00Z', body: 'Never sent', labels: ['DRAFT'] }),
      ],
    },
  },
  ME,
)
check('draft-only thread still returns (not dropped)', draftOnly.messages.length, 1)
check('draft-only thread flags the draft', draftOnly.hasDraft, true)
check('draft-only thread shows no send date', draftOnly.lastDate, '')
check('draft-only thread has no unread', draftOnly.unread, 0)

// --- Case 3: a normal thread with no drafts is completely unchanged ----------
const clean = buildThread(
  {
    data: {
      id: 't3',
      messages: [
        msg({ id: 'm1', from: `Michael <${ME}>`, to: CLIENT, date: '2026-07-21T15:00:00Z', body: 'Hello', labels: ['SENT'] }),
        msg({ id: 'm2', from: `Client <${CLIENT}>`, to: ME, date: '2026-07-29T15:00:00Z', body: 'Hi back', labels: ['INBOX'] }),
      ],
    },
  },
  ME,
)
check('clean thread has no draft flag', clean.hasDraft, false)
check('clean thread lastDate unchanged', clean.lastDate, 'Jul 29, 2026')
check('clean thread messages carry dates', clean.messages.map((m) => m.date), ['Jul 21, 2026', 'Jul 29, 2026'])

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
