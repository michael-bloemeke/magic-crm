// Fake data layer. Every read returns fixtures; every write records the call and resolves.
export const CALLS = []
export const SHOW_ROWS = []
const rec = (name) => (...args) => { CALLS.push({ name, args }); return Promise.resolve({ ok: true }) }

export const FIXTURE_THREADS = [
  { id: 'm1', threadId: 'th1', from: 'Sarah Whitfield', fromEmail: 'sarah@duke.edu', to: ['michael@michaelbloemeke.com'],
    subject: 'Re: Magic for the gala', date: '', ts: Date.now() - 3600e3, snippet: 'That sounds perfect, what time would you arrive?', unread: true, labels: ['UNREAD'] },
  { id: 'm2', threadId: 'th2', from: 'GigSalad', fromEmail: 'leads@gigsalad.com', to: ['michael@michaelbloemeke.com'],
    subject: 'New lead', date: '', ts: Date.now() - 86400e3 * 3, snippet: 'A new lead is waiting', unread: false, labels: [] },
  { id: 'm3', threadId: 'th3', from: 'Michael Bloemeke', fromEmail: 'michael@michaelbloemeke.com', to: ['sarah@duke.edu'],
    subject: 'Re: Booking details', date: '', ts: Date.now() - 7200e3, snippet: 'Here are the details we discussed', unread: false, labels: [] },
]

export const STUB = {
  // phone-api: only the proposal status the project card reads; everything else resolves ok.
  phoneApi: (action, body = {}) => {
    CALLS.push({ name: 'phoneApi', args: [action, body] })
    if (action === 'proposal-status') {
      if (body.projectId === 'sarah-whitfield') return Promise.resolve({ ok: true, exists: true, status: 'live', state: 'live', stateReason: 'Up now. The link works.',
        url: 'https://michaelbloemeke.com/proposal/?t=ABC', openUrl: 'https://michaelbloemeke.com/proposal/?t=ABC&preview=1', headline: 'Gala', gaps: [],
        views: 6, firstViewedAt: '2026-09-11T10:00:00Z', lastViewedAt: '2026-09-18T10:00:00Z', expiresAt: '', emailDraftedAt: '2026-09-10T11:00:00Z', packageCount: 2 })
      return Promise.resolve({ ok: true, exists: false, status: 'none', gaps: [], views: 0 })
    }
    return Promise.resolve({ ok: true })
  },
  EXPENSE_CADENCES: ['monthly', 'quarterly', 'yearly', 'weekly', 'one-time'],
  loadEverything: () => Promise.resolve({}),
  dataChangedSinceLastLoad: () => Promise.resolve(false),
  getSession: () => Promise.resolve(null),
  signIn: rec('signIn'), signOut: rec('signOut'),
  currentUserEmail: () => Promise.resolve('michael@michaelbloemeke.com'),
  addTask: (t) => { CALLS.push({ name: 'addTask', args: [t] }); return Promise.resolve({ id: 'newtask', ...t, done: false }) },
  updateTask: rec('updateTask'), toggleTask: rec('toggleTask'), deleteTask: rec('deleteTask'),
  addNote: rec('addNote'),
  updateProjectField: (id, col, v) => { CALLS.push({ name: 'updateProjectField', args: [id, col, v] }); return Promise.resolve({ ok: true, id, field: col, value: v }) },
  addPayment: rec('addPayment'), setStage: rec('setStage'),
  reloadPaymentsFinance: () => Promise.resolve({}),
  savePushSubscription: rec('savePushSubscription'), saveNativePushToken: rec('saveNativePushToken'),
  LEAD_SOURCES: ['Google/Web', 'Bark', 'The Bash', 'GigSalad', 'In Person', 'Referral', 'Instagram/TikTok', 'Other'],
  createProject: (input) => { CALLS.push({ name: 'createProject', args: [input] }); return Promise.resolve({ id: 'new-project', client: input.clientName, bucket: 'active', stageId: 'inquiry', activityLog: [] }) }, archiveProject: rec('archiveProject'),
  completeProject: rec('completeProject'), restoreProject: rec('restoreProject'), deleteProject: rec('deleteProject'),
  updateContact: rec('updateContact'), loadContacts: () => Promise.resolve([]),
  linkOrCreateContact: rec('linkOrCreateContact'), unlinkContact: rec('unlinkContact'),
  loadLinks: () => Promise.resolve({}), setNotificationSeen: rec('setNotificationSeen'),
  loadBookingProgress: (pid) => Promise.resolve({
    stage: 'signed', viewedAt: '2026-09-10T14:02:00Z', submittedAt: '2026-09-12T09:15:00Z',
    signedAt: '2026-09-12T09:20:00Z', signedName: 'Sarah Whitfield', variant: 'standard', linkOut: true,
    answers: [
      { id: 'event_summary', value: 'A 250-guest black tie gala in the Washington Duke ballroom.' },
      { id: 'venue_address', value: '3001 Cameron Blvd, Durham, NC 27705' },
      { id: 'show_start_time', value: '20:30' },
      { id: 'av', value: 'House PA, wireless handheld available.' },
      { id: 'invoice_to', value: 'Duke University Alumni Association' },
      { id: 'brand_new_question', value: 'an id with no label mapping' },
      { id: 'vips', value: '   ' },
    ],
  }),
  loadContractVariants: () => Promise.resolve([{ variant: 'standard', label: 'Standard' }]),
  readyToBookOnPhone: rec('readyToBookOnPhone'), resetBookingOnPhone: rec('resetBookingOnPhone'),
  agreementPdfUrl: () => Promise.resolve('blob:fake'),
  gmailList: ({ q }) => { CALLS.push({ name: 'gmailList', args: [q] }); return Promise.resolve(FIXTURE_THREADS) },
  gmailThread: (id) => { CALLS.push({ name: 'gmailThread', args: [id] }); return Promise.resolve({
    threadId: id, subject: 'Re: Magic for the gala',
    messages: [{ id: 'm1', from: 'Sarah Whitfield', fromEmail: 'sarah@duke.edu', to: ['michael@michaelbloemeke.com'],
      subject: 'Re: Magic for the gala', ts: Date.now() - 3600e3, unread: true,
      body: 'That sounds perfect.\nWhat time would you arrive?' }] }) },
  gmailMarkRead: rec('gmailMarkRead'),
  gmailUnread: (q) => { CALLS.push({ name: 'gmailUnread', args: [q] }); return Promise.resolve({ count: 7, threads: FIXTURE_THREADS }) },
  sendEmail: (a) => { CALLS.push({ name: 'sendEmail', args: [a] }); return Promise.resolve({ ok: true }) },
  loadRawConfig: () => Promise.resolve({ signatureEnabled: true, signatureHtml: 'Michael Bloemeke<div>michaelbloemeke.com</div>' }),
  // Shows: a tiny in-memory table, so the page can be driven end to end.
  loadShows: () => { CALLS.push({ name: 'loadShows', args: [] }); return Promise.resolve(SHOW_ROWS.map((x) => JSON.parse(JSON.stringify(x)))) },
  createShow: (name) => { CALLS.push({ name: 'createShow', args: [name] }); const s = { id: 'show-' + (SHOW_ROWS.length + 1), name, setList: [], packingList: [], createdAt: '', updatedAt: '' }; SHOW_ROWS.push(s); return Promise.resolve(JSON.parse(JSON.stringify(s))) },
  updateShow: (id, patch) => {
    CALLS.push({ name: 'updateShow', args: [id, patch] })
    const s = SHOW_ROWS.find((x) => x.id === id)
    if (patch.name != null) s.name = patch.name
    if (patch.setList) s.setList = patch.setList.filter((x) => String(x.text).trim()).map((x) => ({ id: x.id, text: String(x.text).trim() }))
    if (patch.packingList) s.packingList = patch.packingList.filter((x) => x.type === 'blank' || String(x.text).trim()).map((x) => ({ ...x, text: x.type === 'blank' ? '' : String(x.text).trim() }))
    return Promise.resolve(JSON.parse(JSON.stringify(s)))
  },
  setPacked: (id, itemId, done) => { CALLS.push({ name: 'setPacked', args: [id, itemId, done] }); const s = SHOW_ROWS.find((x) => x.id === id); s.packingList = s.packingList.map((x) => (x.id === itemId ? { ...x, done } : x)); return Promise.resolve(JSON.parse(JSON.stringify(s))) },
  uncheckAllPacked: (id) => { CALLS.push({ name: 'uncheckAllPacked', args: [id] }); const s = SHOW_ROWS.find((x) => x.id === id); s.packingList = s.packingList.map((x) => ({ ...x, done: false })); return Promise.resolve(JSON.parse(JSON.stringify(s))) },
  deleteShow: (id) => { CALLS.push({ name: 'deleteShow', args: [id] }); const i = SHOW_ROWS.findIndex((x) => x.id === id); if (i >= 0) SHOW_ROWS.splice(i, 1); return Promise.resolve() },
  saveComposeDraft: (a) => { CALLS.push({ name: 'saveComposeDraft', args: [a] }); return Promise.resolve(a.id || 'draft-1') },
  deleteDraft: rec('deleteDraft'),
  loadProjectDrafts: (id) => { CALLS.push({ name: 'loadProjectDrafts', args: [id] }); return Promise.resolve(id === 'sarah-whitfield' ? [
    { id: 'draft-9', projectId: id, kind: 'custom', to: ['sarah@duke.edu'], subject: 'Quick question', body: '<p>Half written</p>', format: 'html', threadId: '', threadSubject: '', attachments: [], updatedAt: '2026-10-22T15:00:00Z' },
  ] : []) },
  loadProposalsOverview: () => { CALLS.push({ name: 'loadProposalsOverview', args: [] }); return Promise.resolve({
    items: [
      { projectId: 'sarah-whitfield', projectName: 'Sarah Whitfield', eventType: 'Gala', eventDate: '2026-10-04',
        totalFee: 2500, bucket: 'active', state: 'live', stateReason: 'Up now. The link works.',
        outcome: 'open', outcomeLabel: 'In play', outcomeNote: '',
        url: 'https://michaelbloemeke.com/proposal/?t=ABC',
        openUrl: 'https://michaelbloemeke.com/proposal/?t=ABC&preview=1',
        views: 6, firstViewedAt: '2026-09-11T10:00:00Z', lastViewedAt: '2026-09-18T10:00:00Z', expiresAt: '', createdAt: '2026-09-10T10:00:00Z' },
      { projectId: 'lost-one', projectName: 'Vijay Rao', eventType: 'Wedding', eventDate: '2026-06-01',
        totalFee: 1800, bucket: 'archived', state: 'down', stateReason: 'Down because the project was archived.',
        outcome: 'lost', outcomeLabel: 'Fell through', outcomeNote: 'Went with a band',
        url: 'https://michaelbloemeke.com/proposal/?t=DEF',
        openUrl: 'https://michaelbloemeke.com/proposal/?t=DEF&preview=1&k=SECRETKEY',
        views: 2, firstViewedAt: '', lastViewedAt: '2026-06-02T10:00:00Z', expiresAt: '', createdAt: '2026-05-01T10:00:00Z' },
      { projectId: 'never-read', projectName: 'Venus Myles', eventType: '', eventDate: '',
        totalFee: '', bucket: 'active', state: 'live', stateReason: 'Up now. The link works.',
        outcome: 'open', outcomeLabel: 'In play', outcomeNote: '',
        url: 'https://michaelbloemeke.com/proposal/?t=GHI',
        openUrl: 'https://michaelbloemeke.com/proposal/?t=GHI&preview=1',
        views: 0, firstViewedAt: '', lastViewedAt: '', expiresAt: '', createdAt: '2026-09-19T10:00:00Z' },
    ],
    bookings: [
      { projectId: 'sarah-whitfield', projectName: 'Sarah Whitfield', bucket: 'active',
        outcome: 'open', outcomeLabel: 'In play', outcomeNote: '', eventType: 'Gala', eventDate: '2026-10-04',
        totalFee: 2500, sentAt: '2026-09-12T10:00:00Z',
        openUrl: 'https://michaelbloemeke.com/book/?t=XYZ&preview=1',
        url: 'https://michaelbloemeke.com/book/?t=XYZ',
        views: 3, firstViewedAt: '', lastViewedAt: '2026-09-12T11:00:00Z', variant: 'standard' },
    ],
    samples: { proposal: 'https://michaelbloemeke.com/proposal/?demo=1', booking: 'https://michaelbloemeke.com/book/?demo=1' },
  }) },
  VAPID_PUBLIC_KEY: 'x',
}
