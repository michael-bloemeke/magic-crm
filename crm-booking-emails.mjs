// The four emails a booking sends, in Michael's own words.
//
// Taken verbatim from his Notion page "Booking Templates/Process" (2026-08-03). This module is the
// ONE place they live, so the wording can be changed here and every sender picks it up.
//
// THE SHAPE OF THE FLOW, and why the threading matters. Four emails, two threads:
//
//   thread A   1. Booking form      Michael sends this himself (a Gmail draft he reviews)
//              2. Contract          replies into A, with the signed PDF attached
//
//              4. Booking confirmed replies into A too, once the invoice is paid
//
//   thread B   3. Invoice           sent by QUICKBOOKS, not by us
//
// His reasoning: "i want to make things easier for them and not send a thousand separate email
// threads to their inbox".
//
// The invoice sits in its own thread because QuickBooks sends it, and Michael prefers that: it is
// one email carrying both the pay button and the PDF. The consequence is that we cannot reply into
// it, so the booking confirmation joins thread A instead. Still four emails and two threads: one
// conversation with Michael, plus the invoice.
//
// House rules that apply to every one of these: no em-dashes, and the voice is his, not a machine's.

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

// Their first name, or a warm fallback. The templates all open "Hi [Name],".
export function firstNameOf(project) {
  const fromContact = String(project?.contactNames || '').split(/[,;]/)[0].trim()
  const name = fromContact || String(project?.client || '').trim()
  return name.split(/\s+/)[0] || 'there'
}

// A real button, not a bare URL.
//
// Michael asked for this specifically. A raw link in an email reads as something to be suspicious
// of; a button reads as a thing to press. Built with a table and inline styles because that is the
// only markup Gmail, Outlook and Apple Mail all render the same way. The href is repeated as plain
// text underneath, because a handful of clients strip buttons entirely and a dead-end email is worse
// than an ugly one.
function button(href, label) {
  return [
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0">',
    '<tr><td align="center" bgcolor="#1b2339" style="border-radius:8px">',
    `<a href="${esc(href)}" style="display:inline-block;padding:14px 30px;font-family:Arial,Helvetica,sans-serif;`,
    'font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:8px">',
    `${esc(label)}</a>`,
    '</td></tr></table>',
  ].join('')
}

const WRAP_OPEN =
  '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#222">'
const WRAP_CLOSE = '</div>'
const p = (html) => `<p style="margin:0 0 14px">${html}</p>`

// ---------------------------------------------------------------------------
// THE SIGN-OFF. One block, every email, drafts included.
// ---------------------------------------------------------------------------
//
// ⚠️ THIS FIXES A REAL BUG, and the false belief behind it is worth stating plainly so nobody
// reintroduces it. Several of these templates used to end at "Thanks!" with a comment saying the
// name was omitted because a Gmail DRAFT picks up Michael's own signature. IT DOES NOT. Gmail
// inserts a signature when a human opens a NEW COMPOSE WINDOW in the interface. A draft created
// through the Gmail API arrives exactly as it was written, with nothing appended, whether it is
// sent by the cloud or opened and sent by hand. So every one of those drafts was reaching Michael
// unsigned and he was typing the block back in himself. Confirmed 2026-08-17 on the proposal email.
//
// Michael's format, and the line breaks are the point: a blank line after the body, then four lines
// hard against each other with no gaps between them.
//
//   Thanks!
//   Michael Bloemeke
//   michaelbloemeke.com
//   919-239-9898
//
// ⚠️ THE HTML VERSION MUST USE A REAL ANCHOR for the website. Left as a bare domain, Gmail
// auto-linkifies it and, having no anchor text to show, renders its own
// `google.com/url?q=...&source=gmail&ust=...` redirect as the VISIBLE text. That landed in a real
// draft on 2026-08-17. `<br>` between lines rather than separate <p> tags, because <p> margins
// would put the gaps back in.
//
// Michael expects this to be replaced by a designed signature card once he has a logo. Change it
// here and every sender picks it up.
// The closer defaults to "Thanks!", which is Michael's standard. A few of these templates already
// end on a warmer line lifted verbatim from his Notion page ("Thanks again, I'm looking forward to
// it!"). Those pass their own closer rather than stacking a second "Thanks!" underneath, which
// keeps his wording and still lands the contact block.
export const SIGNATURE_LINES = ['Michael Bloemeke', 'michaelbloemeke.com', '919-239-9898']

// For the plain-text part. The LAST element of a lines array, preceded by the usual '' separator
// that every other paragraph gets. It does NOT bring its own leading newline: doing that on top of
// the '' produced two blank lines before the sign-off instead of one.
export const signOffText = (closer = 'Thanks!') => [closer, ...SIGNATURE_LINES].join('\n')

// For the HTML part. One <p> so the four lines sit hard against each other; separate <p> tags would
// put the gaps back in.
export const signOffHtml = (closer = 'Thanks!') =>
  p([
    esc(closer),
    'Michael Bloemeke',
    '<a href="https://michaelbloemeke.com" style="color:#1b2339">michaelbloemeke.com</a>',
    '919-239-9898',
  ].join('<br>'))

// ---------------------------------------------------------------------------
// 0. The proposal  (sits BEFORE the booking flow, its own thread)
// ---------------------------------------------------------------------------
//
// The post-call email. It used to be a wall of text plus a 10.6 MB PDF deck, which bounced off
// corporate mail servers, named exactly one price, and forwarded badly to the person who actually
// decides. Now it is three sentences and a link.
//
// Deliberately SHORT. The page does the selling, and every sentence here is one the client reads
// instead of clicking. It also says "share it" out loud, because most of these deals are decided by
// someone who was not on the call.
//
// ⚠️ PLACEHOLDER WORDING. Michael is writing the real template (2026-08-07). Swap the copy here and
// every sender picks it up; nothing else needs to change.
export function proposalEmail({ project, url }) {
  const name = firstNameOf(project)
  // ⚠️ THE WORD "MAGICIAN" STAYS IN THIS SUBJECT LINE. Michael, 2026-08-22. It arrives days after a
  // phone call, often in a busy inbox, and often gets forwarded to somebody who was never on that
  // call. "Your proposal" tells neither of them what it is. Matches the rest of his subject lines,
  // which lead with "Magician Information".
  const subject = 'Magician Proposal'
  const text = [
    `Hi ${name},`,
    '',
    'Great talking with you. I put everything we went over on one page, along with a couple of options and some video so you can see what it looks like.',
    '',
    url,
    '',
    'Share it with anyone else who needs to see it, the link works for them too.',
    '',
    'Have a look and let me know which option fits. Any questions, just ask.',
    '',
    signOffText(),
  ].join('\n')
  const html = [
    WRAP_OPEN,
    p(`Hi ${esc(name)},`),
    p('Great talking with you. I put everything we went over on one page, along with a couple of options and some video so you can see what it looks like.'),
    button(url, 'Open your proposal'),
    p('Share it with anyone else who needs to see it, the link works for them too.'),
    p('Have a look and let me know which option fits. Any questions, just ask.'),
    signOffHtml(),
    WRAP_CLOSE,
  ].join('')
  return { subject, text, html }
}

// ---------------------------------------------------------------------------
// 1. Booking form  (thread A opens here)
// ---------------------------------------------------------------------------

export function bookingFormEmail({ project, url }) {
  const name = firstNameOf(project)
  const subject = 'Booking details'
  const text = [
    `Hi ${name},`,
    '',
    "Click the link below to fill out the booking form; It'll ask you to confirm a few event details and then the next page will be the performance agreement.",
    '',
    url,
    '',
    "It takes about two minutes. Once the form/agreement is submitted, you'll receive a copy for your records and an invoice.",
    "As soon as the invoice is paid, you'll be finalized in my calendar and we'll be good to go!",
    '',
    "Let me know if you have any questions, I'm always happy to answer!",
    '',
    signOffText(),
  ].join('\n')
  const html = [
    WRAP_OPEN,
    p(`Hi ${esc(name)},`),
    p("Click the button below to fill out the booking form; It'll ask you to confirm a few event details and then the next page will be the performance agreement."),
    button(url, 'Fill in your event details'),
    p("It takes about two minutes. Once the form/agreement is submitted, you'll receive a copy for your records and an invoice.<br>As soon as the invoice is paid, you'll be finalized in my calendar and we'll be good to go!"),
    p("Let me know if you have any questions, I'm always happy to answer!"),
    signOffHtml(),
    p(`<span style="font-size:12px;color:#888">If the button doesn't work, paste this into your browser:<br>${esc(url)}</span>`),
    WRAP_CLOSE,
  ].join('')
  return { subject, text, html }
}

// ---------------------------------------------------------------------------
// 2. Contract  (replies into thread A)
// ---------------------------------------------------------------------------

export function contractEmail({ project }) {
  const name = firstNameOf(project)
  const subject = 'Your Signed Agreement'
  const text = [
    `Hi ${name},`,
    '',
    'I just received the booking form and signature.',
    '',
    'Attached is a copy of the agreement you just signed, for your records. The first page is a copy of the event details you gave me, so hang on to it and let me know if anything changes between now and the day.',
    '',
    "The invoice should be arriving in a separate email shortly. Let me know if it doesn't come through. Once that invoice goes through, you'll be finalized in my calendar!",
    '',
    signOffText('Thanks again!'),
  ].join('\n')
  const html = [
    WRAP_OPEN,
    p(`Hi ${esc(name)},`),
    p('I just received the booking form and signature.'),
    p('Attached is a copy of the agreement you just signed, for your records. The first page is a copy of the event details you gave me, so hang on to it and let me know if anything changes between now and the day.'),
    p("The invoice should be arriving in a separate email shortly. Let me know if it doesn't come through. <u>Once that invoice goes through, you'll be finalized in my calendar!</u>"),
    signOffHtml('Thanks again!'),
    WRAP_CLOSE,
  ].join('')
  return { subject, text, html }
}

// ---------------------------------------------------------------------------
// 3. Invoice  (thread B opens here)
// ---------------------------------------------------------------------------

// QuickBooks sends the invoice itself, which is what Michael wants: one email carrying both the pay
// button and the PDF. The part we CAN customise per invoice is `CustomerMemo`, the "message on
// invoice" field, which the API accepts and which renders on the invoice the client receives.
// Verified against his sandbox on 2026-08-03 rather than assumed.
//
// So this is his "Accompanying the invoice" wording, as the memo. Kept well under QuickBooks'
// 1000-character limit.
export function invoiceMemo() {
  return [
    'The Invoice is attached, please remit payment at your earliest convenience.',
    'Thank you for your business, I appreciate it very much!!',
    '',
    "NOTE: Quickbooks does have a processing fee for online payment, so if you'd prefer to avoid that, I'm happy to do cash, check, PayPal, Venmo, CashApp, or Zelle. Just let me know.",
  ].join('\n')
}

// Kept for the case where the invoice is ever emailed from Gmail instead of by QuickBooks. Unused
// while QuickBooks does the sending.
export function invoiceEmail({ project, payUrl }) {
  const name = firstNameOf(project)
  const subject = 'Your Invoice'
  const text = [
    `Hi ${name},`,
    '',
    'The Invoice is attached, please remit payment at your earliest convenience.',
    'Thank you for your business, I appreciate it very much!!',
    '',
    ...(payUrl ? ['You can pay online here:', payUrl, ''] : []),
    "NOTE: Quickbooks does have a processing fee for online payment, so if you'd prefer to avoid that, I'm happy to do cash, check, PayPal, Venmo, CashApp, or Zelle. Just let me know.",
    '',
    signOffText(),
  ].join('\n')
  const html = [
    WRAP_OPEN,
    p(`Hi ${esc(name)},`),
    p('The Invoice is attached, please remit payment at your earliest convenience.<br>Thank you for your business, I appreciate it very much!!'),
    payUrl ? button(payUrl, 'Pay the invoice online') : '',
    p("NOTE: Quickbooks does have a processing fee for online payment, so if you'd prefer to avoid that, I'm happy to do cash, check, PayPal, Venmo, CashApp, or Zelle. Just let me know."),
    signOffHtml(),
    WRAP_CLOSE,
  ].join('')
  return { subject, text, html }
}

// ---------------------------------------------------------------------------
// 4. Booking confirmation  (replies into thread B, once the invoice is paid)
// ---------------------------------------------------------------------------

export function bookingConfirmedEmail({ project }) {
  const name = firstNameOf(project)
  const subject = 'Booking Confirmation'
  const text = [
    `Hi ${name},`,
    '',
    "I'm just letting you know that the signature and deposit went through which means that you are booked in my calendar and everything is good to go!",
    '',
    "I'll keep in touch as the date gets closer, but please don't hesitate to reach out if you have any questions.",
    '',
    signOffText("Thanks again, I'm looking forward to it!"),
  ].join('\n')
  const html = [
    WRAP_OPEN,
    p(`Hi ${esc(name)},`),
    p("I'm just letting you know that the signature and deposit went through which means that you are booked in my calendar and everything is good to go!"),
    p("I'll keep in touch as the date gets closer, but please don't hesitate to reach out if you have any questions."),
    signOffHtml("Thanks again, I'm looking forward to it!"),
    WRAP_CLOSE,
  ].join('')
  return { subject, text, html }
}
