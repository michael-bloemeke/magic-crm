// Proposal actions for the phone: a port of the Mac's crm-proposals.mjs (ensureProposal,
// proposalGaps, publishProposal, retireProposal, resetProposalViews, proposalStatus,
// draftProposalEmail) and the proposal email in crm-booking-emails.mjs. The `proposals` table is
// service-role only, which is why these live server-side rather than in the phone's data layer.
//
// Same rows, same activity-log lines, same email (subject, body and signature) as the Mac, so a
// proposal started on one can be published from the other. Seed data comes from proposal-seed.ts,
// which is GENERATED from crm-proposals.mjs and must not be edited by hand.
// deno-lint-ignore-file no-explicit-any
import { REVIEW_BANK, PHOTO_SETS, CLIENT_LOGOS, DEFAULT_VIDEO_ID } from './proposal-seed.ts'

type SB = any
const SITE = 'https://michaelbloemeke.com'
const TIMEZONE = 'America/New_York'
export const proposalUrl = (token: string) => `${SITE}/proposal/?t=${token}`

function newToken(): string {
  const bytes = new Uint8Array(18)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function defaultExpiry(eventDate: string): string | null {
  const base = /^\d{4}-\d{2}-\d{2}$/.test(String(eventDate || '')) ? new Date(eventDate + 'T12:00:00') : new Date()
  if (Number.isNaN(base.getTime())) return null
  base.setDate(base.getDate() + 90)
  return base.toISOString()
}
function normaliseType(t: string): string {
  const k = String(t || '').toLowerCase().trim().replace(/\s+/g, '-')
  if ((REVIEW_BANK as any)[k]) return k
  if (/wedding/.test(k)) return 'wedding'
  if (/holiday|christmas/.test(k)) return 'holiday-party'
  if (/bachelor/.test(k)) return 'bachelorette'
  if (/corporate|company|business|gala|fundrais/.test(k)) return 'corporate'
  return 'private'
}
async function appendLog(sb: SB, projectId: string, text: string) {
  const { data: p } = await sb.from('projects').select('activity_log').eq('id', projectId).maybeSingle()
  if (!p) return
  const day = new Date().toLocaleDateString('en-US', { timeZone: TIMEZONE, month: 'long', day: 'numeric', year: 'numeric' })
  await sb.from('projects').update({ activity_log: [`${day}: ${text}`, ...(p.activity_log || [])], updated_at: new Date().toISOString() }).eq('id', projectId)
}
async function loadProject(sb: SB, projectId: string) {
  const { data } = await sb.from('projects').select('id,bucket,event_type,event_date,event_start_time,show_start_time,contact_names,contact_emails,project_name,client_name').eq('id', projectId).maybeSingle()
  return data
}
async function loadRow(sb: SB, projectId: string) {
  const { data, error } = await sb.from('proposals').select('*').eq('project_id', projectId).maybeSingle()
  if (error) throw new Error(error.message)
  return data
}

function ambiguousTime(v: string): boolean {
  const bare = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim())
  if (!bare) return false
  const h = Number(bare[1])
  return h >= 1 && h <= 11
}
function gapsOf(row: any, project: any): string[] {
  const gaps: string[] = []
  if (!String(row.recommendation || '').trim()) gaps.push('the recommendation narrative')
  if (!Array.isArray(row.packages) || !row.packages.length) gaps.push('at least one package')
  if (Array.isArray(row.packages) && row.packages.some((p: any) => !p.name || !p.price)) gaps.push('a name and price on every package')
  if (!Array.isArray(row.reviews) || !row.reviews.length) gaps.push('at least one review')
  if (!Array.isArray(row.clients) || !row.clients.length) gaps.push('the client logo wall')
  if (project) {
    if (ambiguousTime(project.event_start_time)) gaps.push(`AM or PM on the event start time ("${project.event_start_time}")`)
    if (ambiguousTime(project.show_start_time)) gaps.push(`AM or PM on the show start time ("${project.show_start_time}")`)
  }
  return gaps
}
function stateOf(row: any, project: any): { state: string; reason: string } {
  if (row.status === 'draft') return { state: 'draft', reason: 'Never published.' }
  if (row.status === 'retired') return { state: 'down', reason: 'Taken down by hand.' }
  const bucket = project?.bucket
  if (bucket !== 'active' && bucket !== 'completed') {
    return { state: 'down', reason: bucket === 'archived' ? 'Down because the project was archived.' : 'Down because the project left the pipeline.' }
  }
  const expires = row.expires_at ? Date.parse(row.expires_at) : NaN
  if (!Number.isNaN(expires) && expires < Date.now()) return { state: 'expired', reason: 'Past its expiry date.' }
  return { state: 'live', reason: 'Up now. The link works.' }
}

export async function proposalStatus(sb: SB, projectId: string) {
  const row = await loadRow(sb, projectId)
  if (!row) return { ok: true, exists: false, status: 'none', gaps: [], views: 0 }
  const project = await loadProject(sb, projectId)
  const { state, reason } = stateOf(row, project)
  const { data: pk } = await sb.from('push_config').select('preview_key').eq('id', 1).maybeSingle()
  const url = proposalUrl(row.token)
  const openUrl = state === 'live' ? `${url}&preview=1` : pk?.preview_key ? `${url}&preview=1&k=${encodeURIComponent(pk.preview_key)}` : ''
  return {
    ok: true, exists: true, status: row.status, state, stateReason: reason, url, openUrl,
    headline: row.headline || '', gaps: gapsOf(row, project), views: row.view_count ?? 0,
    firstViewedAt: row.first_viewed_at || '', lastViewedAt: row.last_viewed_at || '', expiresAt: row.expires_at || '',
    emailDraftedAt: row.email_drafted_at || '', packageCount: Array.isArray(row.packages) ? row.packages.length : 0,
  }
}

// "Start a proposal": the same seeded draft the Mac's ensureProposal makes.
export async function proposalStart(sb: SB, projectId: string) {
  const existing = await loadRow(sb, projectId)
  if (existing) return proposalStatus(sb, projectId)
  const project = await loadProject(sb, projectId)
  if (!project) throw new Error(`No project "${projectId}".`)
  const type = normaliseType(project.event_type)
  const row = {
    project_id: projectId, token: newToken(), status: 'draft', event_type: type, hero_line: '', recommendation: '', packages: [],
    reviews: (REVIEW_BANK as any)[type] || REVIEW_BANK.private, clients: CLIENT_LOGOS,
    photos: (PHOTO_SETS as any)[type] || PHOTO_SETS.private, video_id: DEFAULT_VIDEO_ID, expires_at: defaultExpiry(project.event_date),
  }
  const { error } = await sb.from('proposals').insert(row)
  if (error) throw new Error(error.message)
  return proposalStatus(sb, projectId)
}

export async function proposalRetire(sb: SB, projectId: string) {
  const { error } = await sb.from('proposals').update({ status: 'retired', updated_at: new Date().toISOString() }).eq('project_id', projectId)
  if (error) throw new Error(error.message)
  await appendLog(sb, projectId, 'Proposal page retired.')
  return proposalStatus(sb, projectId)
}

export async function proposalResetViews(sb: SB, projectId: string) {
  const { error } = await sb.from('proposals').update({ view_count: 0, first_viewed_at: null, last_viewed_at: null, nudge_task_created_at: null, updated_at: new Date().toISOString() }).eq('project_id', projectId)
  if (error) throw new Error(error.message)
  try { await sb.from('notifications').delete().eq('kind', 'proposal-viewed').eq('project_id', projectId).eq('seen', false) } catch { /* best effort, as on the Mac */ }
  return proposalStatus(sb, projectId)
}

// ---- the proposal email, exactly as crm-booking-emails.mjs writes it ----
const escH = (s: string) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[c])
const pH = (html: string) => `<p style="margin:0 0 14px">${html}</p>`
function buttonH(href: string, label: string) {
  return ['<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0">',
    '<tr><td align="center" bgcolor="#1b2339" style="border-radius:8px">',
    `<a href="${escH(href)}" style="display:inline-block;padding:14px 30px;font-family:Arial,Helvetica,sans-serif;`,
    'font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:8px">',
    `${escH(label)}</a>`, '</td></tr></table>'].join('')
}
const WRAP_OPEN = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#222">'
const SIGNATURE_LINES = ['Michael Bloemeke', 'michaelbloemeke.com', '919-239-9898']
const signOffText = () => ['Thanks!', ...SIGNATURE_LINES].join('\n')
const signOffHtml = () => pH(['Thanks!', 'Michael Bloemeke', '<a href="https://michaelbloemeke.com" style="color:#1b2339">michaelbloemeke.com</a>', '919-239-9898'].join('<br>'))
function firstNameOf(project: any) {
  const fromContact = String(project?.contact_names || '').split(/[,;]/)[0].trim()
  const name = fromContact || String(project?.project_name || project?.client_name || '').trim()
  return name.split(/\s+/)[0] || 'there'
}
export function proposalEmail(project: any, url: string) {
  const name = firstNameOf(project)
  const subject = 'Magician Proposal'
  const text = [`Hi ${name},`, '', 'Great talking with you. I put everything we went over on one page, along with a couple of options and some video so you can see what it looks like.',
    '', url, '', 'Share it with anyone else who needs to see it, the link works for them too.', '', 'Have a look and let me know which option fits. Any questions, just ask.', '', signOffText()].join('\n')
  const html = [WRAP_OPEN, pH(`Hi ${escH(name)},`),
    pH('Great talking with you. I put everything we went over on one page, along with a couple of options and some video so you can see what it looks like.'),
    buttonH(url, 'Open your proposal'), pH('Share it with anyone else who needs to see it, the link works for them too.'),
    pH('Have a look and let me know which option fits. Any questions, just ask.'), signOffHtml(), '</div>'].join('')
  return { subject, text, html }
}
async function clientEmailFor(sb: SB, project: any): Promise<string> {
  const direct = String(project?.contact_emails || '').split(/[,;]/)[0].trim()
  if (direct) return direct
  const { data: links } = await sb.from('contact_links').select('contact_id,position').eq('project_id', project.id).order('position', { ascending: true })
  for (const l of links || []) {
    const { data: c } = await sb.from('contacts').select('emails').eq('id', l.contact_id).maybeSingle()
    const list = Array.isArray(c?.emails) ? c.emails : String(c?.emails || '').split(/[,;]/)
    const email = list.map((e: string) => String(e || '').trim()).find(Boolean)
    if (email) return email
  }
  return ''
}
const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)))
export function mime(to: string, subject: string, text: string, html: string): string {
  const boundary = 'crm_' + crypto.randomUUID().replace(/-/g, '')
  const wrap = (s: string) => b64(s).replace(/.{1,76}/g, '$&\r\n').trim()
  return [
    'From: "Michael Bloemeke" <michael@michaelbloemeke.com>',
    `To: ${to}`,
    `Subject: =?UTF-8?B?${b64(subject)}?=`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', wrap(text),
    `--${boundary}`, 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', wrap(html),
    `--${boundary}--`, '',
  ].join('\r\n')
}

// Leaves a Gmail DRAFT, never sends. Same as the Mac's draftProposalEmail.
export async function proposalDraftEmail(sb: SB, projectId: string, googleToken: () => Promise<string>) {
  const project = await loadProject(sb, projectId)
  if (!project) throw new Error(`No project "${projectId}".`)
  const row = await loadRow(sb, projectId)
  if (!row) throw new Error('No proposal for this project yet.')
  if (row.status !== 'live') throw new Error('Publish the proposal before drafting the email, or the link in it will be dead.')
  const to = await clientEmailFor(sb, project)
  if (!to) throw new Error('No client email on this project. Add one to the project or its linked contact.')
  const url = proposalUrl(row.token)
  const { subject, text, html } = proposalEmail(project, url)
  const raw = b64(mime(to, subject, text, html)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const token = await googleToken()
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: { raw } }),
  })
  const body: any = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Gmail ${res.status}: ${body?.error?.message || 'could not create the draft'}`)
  await sb.from('proposals').update({ email_drafted_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('project_id', projectId)
  await appendLog(sb, projectId, 'Proposal email drafted in Gmail. Not sent.')
  return { ok: true, to, url, threadId: body?.message?.threadId || '' }
}

export async function proposalPublish(sb: SB, projectId: string, googleToken: () => Promise<string>) {
  const row = await loadRow(sb, projectId)
  if (!row) throw new Error('No proposal for this project yet. Start one first.')
  const project = await loadProject(sb, projectId)
  const gaps = gapsOf(row, project)
  if (gaps.length) throw new Error(`Not ready to publish. Still needs: ${gaps.join(', ')}.`)
  const { error } = await sb.from('proposals').update({ status: 'live', updated_at: new Date().toISOString() }).eq('project_id', projectId)
  if (error) throw new Error(error.message)
  await appendLog(sb, projectId, 'Proposal page published.')
  // The Mac publishes and drafts the email in one click, in that order, so the link in the draft can
  // never be dead. Same here; a failed draft does not undo the publish.
  let draft: any = null, draftError = ''
  try { draft = await proposalDraftEmail(sb, projectId, googleToken) } catch (e) { draftError = String((e as Error)?.message || e) }
  return { ...(await proposalStatus(sb, projectId)), draft, draftError }
}
