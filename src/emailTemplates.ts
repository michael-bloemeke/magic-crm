import { type SmartField } from './smartFields'

// The Ghostbuster follow-up library, ported from the Notion "Ghostbusters" page (Email Templates ->
// Ghostbusters). Only the NUMBERED templates on that page are here; the unfinished ones at the
// bottom (Jurassic Park, I've Ruled Out Aliens, Snacks, Worth A Try) have no GIF chosen yet and are
// deliberately left out. Picking one fills the subject and the message; the message is then just
// normal editor content, so it can be edited freely before sending.
//
// Two conventions matter here:
//
//  1. Placeholders are merge-field CHIPS, the same ones the "Insert field" dropdown produces. The
//     rule is deliberate and narrow: ONLY the name placeholders autofill. [Name] / [First Name] /
//     [NAME] become the client's first name the moment the template is picked, because that is the
//     one substitution that is always right. Every OTHER bracket stays exactly as it reads in
//     Notion ([the event], [Event], [decision maker]) and is highlighted RED in the composer, so
//     Michael replaces it himself with the words that actually fit and can see at a glance that it
//     still needs doing. Auto-filling those produced wrong-sounding sentences ("after the Wedding"),
//     which is worse than an obvious blank.
//
//  2. GIFs are NOT giphy links. Each <img> carries data-crm-gif="<slug>" and points at the local
//     /api/email-gif/<slug> route so it animates in the composer. At send time crm-email-render
//     swaps that src for a cid: reference and ships the actual GIF bytes as an inline attachment,
//     so the recipient sees the moving picture embedded in the body, not a URL, and it does not
//     depend on Giphy being up or on the client loading remote images. The files live in
//     magic-crm/email-gifs/ and are the source of truth.

export type EmailTemplate = {
  id: string
  /** Shown in the dropdown, matching the numbered heading in Notion. */
  name: string
  subject: string
  /** Body HTML for the rich editor. */
  body: string
}

const field = (key: SmartField['key'], label: string) =>
  `<span class="merge-field" data-field="${key}" contenteditable="false">[${label}]</span>`
const note = (text: string) => `<span class="merge-field" data-note="true" contenteditable="false">[${text}]</span>`

const NAME = field('firstName', 'Client first name')

// An embedded GIF. `w` is the file's real pixel width so it is never upscaled; max-width keeps it
// inside narrow mobile mail clients.
const gif = (slug: string, w: number, alt: string) =>
  `<p style="margin:0 0 12px 0"><img src="/api/email-gif/${slug}" data-crm-gif="${slug}" alt="${alt}" width="${w}" style="width:${w}px;max-width:100%;height:auto;border:0" /></p>`

export const NO_TEMPLATE = ''

export const EMAIL_TEMPLATES: EmailTemplate[] = [
  {
    id: 'who-you-gonna-call',
    name: '1. Who You Gonna Call',
    subject: 'Who You Gonna Call?',
    body:
      `<p>Hey ${NAME},</p>` +
      `<p>I’ve reached out a few times, and at this point I’m starting to wonder if your inbox is haunted.<br>` +
      `If you’re still looking for entertainment, I ain’t afraid of no ghosts.<br>` +
      `If not, no worries. Just let me know. 😉</p>` +
      gif('who-you-gonna-call', 480, 'Ghostbusters'),
  },
  {
    id: 'back-to-the-future',
    name: '2. Back to the Future',
    subject: 'You Made A Great Call',
    body:
      `<p>Hello ${NAME},</p>` +
      `<p>This is your future self writing from after ${note('the event')}.</p>` +
      `<p>We hired Michael and it was a certified banger. You got a standing ovation. Janet from accounting cried tears of joy.</p>` +
      `<p>This timeline is thriving.</p>` +
      `<p>Do not ruin this. Reply to Michael now. The fate of our ${note('event')} depends on it.</p>` +
      `<p>-${NAME} from The Future</p>` +
      gif('back-to-the-future', 448, 'Back to the Future'),
  },
  {
    id: 'shark',
    name: '3. Shark',
    subject: 'Is everything okay?',
    body:
      `<p>Hey ${NAME},</p>` +
      `<p>I haven't heard back and I'm worried about you.<br>` +
      `If you've been attacked by a shark, that's totally understandable, happens to the best of us. But if not, I'd love to confirm you in the calendar!</p>` +
      gif('shark', 375, 'Shark') +
      `<p>Thanks!</p>`,
  },
  {
    id: 'you-win',
    name: '4. You Win',
    subject: 'You Win',
    body:
      `<p>Alright, ${NAME}, It’s official. You are the all-time champion of Hide and Seek. I’ve been trying a while and still can’t find you so I guess it’s time to throw in the towel.</p>` +
      `<p>No hard feelings. If you're still planning your event, I'm still here and would love to help.<br>` +
      `If not, congrats on the clean getaway 🏆</p>` +
      gif('you-win', 480, 'You win'),
  },
  {
    id: 'breakup',
    name: '5. Breakup',
    subject: 'It’s Not You, It’s Me',
    body:
      `<p>Hey ${NAME}...</p>` +
      `<p>I think we need to talk.</p>` +
      `<p>I’ve reached out so many times, but my therapist says I can’t keep giving 100% to a one-sided relationship.<br>` +
      `You deserve someone who checks all your boxes, and maybe that’s not me. Maybe you’ve already found someone else… Maybe it was never meant to be...</p>` +
      `<p>But I want you to know: I’ll always treasure what we almost had. Those early moments, when I saw your lead come in, they meant something to me.</p>` +
      `<p>But this is goodbye.<br>` +
      `No more calls. No more emails. Just me… standing in the rain with a deck of cards and a broken heart.</p>` +
      `<p>If you ever change your mind, I’ll be here. Until we meet again...</p>` +
      gif('breakup', 500, 'Breakup'),
  },
  {
    id: 'search-party',
    name: '6. Search Party',
    subject: 'Search Party Update',
    body:
      `<p>Hey ${NAME},</p>` +
      `<p>I've assembled the search party! I'm confident that you're still out there somewhere. Once you get found, let’s connect and we can lock down that ${note('Event')}!</p>` +
      gif('search-party', 250, 'Search party'),
  },
  {
    id: 'gif-only',
    name: '7. GIF Only',
    subject: 'Still Waiting to Hear Back From You…',
    body: gif('gif-only', 480, 'Still waiting'),
  },
  {
    id: 'abcde',
    name: '8. ABCDE',
    subject: 'Short One',
    body:
      `<p>Hi ${NAME},</p>` +
      `<p>Short one. Just reply with one letter so I know where things stand:</p>` +
      `<p>A) We're in, send next steps.<br>` +
      `B) Not a fit for this one, but let's keep in touch.<br>` +
      `C) Still deciding, give me a few more days to talk it over with ${note('decision maker')}.<br>` +
      `D) Craig from accounting got obsessed with magic and is doing the show himself.<br>` +
      `D) Magic sucks. You Suck. Screw off magic boy.<br>` +
      `D) We’ve decided to hire a face painter instead<br>` +
      `E) Other</p>` +
      `<p>Thanks!</p>`,
  },
  {
    id: 'carrier-pigeons',
    name: '9. Carrier Pigeons',
    subject: 'Should I be using Pigeons?',
    body:
      `<p>Hey ${NAME},</p>` +
      `<p>At this point I'm considering switching to carrier pigeons, but I figured I'd try another email first. Are you all still looking at magic for ${note('the event')}? Let me know either way.</p>` +
      gif('carrier-pigeons', 223, 'Carrier pigeon') +
      `<p>Thanks!</p>`,
  },
  {
    id: 'magic-trick',
    name: '10. Magic Trick',
    subject: 'Did my email do a magic trick?',
    body:
      `<p>Hi ${NAME},</p>` +
      `<p>Starting to think my last email vanished, which as a magician I respect. But also mildly inconvenient if you're still planning ${note('the event')}.</p>` +
      `<p>Happy to help. If not, no worries, just let me know either way.</p>` +
      gif('magic-trick', 200, 'Disappearing act') +
      `<p>Thanks!</p>`,
  },
  {
    id: 'i-thought-i-was-the-magician',
    name: '11. I Thought I Was the Magician',
    subject: 'I Thought I was the Magician',
    body:
      `<p>Hi ${NAME},</p>` +
      `<p>I thought I was a good magician, but it seems like you’ve got a great disappearing act yourself!</p>` +
      gif('magic-trick', 200, 'Disappearing act'),
  },
]

export function findTemplate(id: string): EmailTemplate | undefined {
  return EMAIL_TEMPLATES.find((t) => t.id === id)
}
