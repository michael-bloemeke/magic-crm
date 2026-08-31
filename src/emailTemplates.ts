import type { SmartField } from './smartFields'

// The email template library, grouped into the folders that show as submenus in the picker:
//
//   Ghostbusters            the numbered follow-ups from the Notion "Ghostbusters" page
//   14 Magic Emails         the Notion "14 Magic Emails" sequence
//   Old HoneyBook Templates the ones worth keeping from the HoneyBook archive
//
// Three conventions run through all of them:
//
//  1. ONLY the name autofills. [Name] / [First Name] / [NAME] (and the bare "X" the 14 Magic Emails
//     use as a stand-in) become the client's first name the moment a template is picked, because
//     that substitution is always right. Every OTHER placeholder is kept EXACTLY as it reads in
//     Notion and shown RED in the composer, so Michael replaces it with words that actually fit and
//     can see at a glance what is still outstanding. That includes the {{curly}} Calendly tags in
//     the pre-call reminders: they come from a different system, so they are left to him.
//
//  2. GIFs are embedded, not linked. Each <img> carries data-crm-gif="<slug>" pointing at the local
//     /api/email-gif route so it animates while writing; at send time crm-email-render swaps the src
//     for a cid: reference and ships the actual bytes inline. Files live in magic-crm/email-gifs/.
//
//  3. The wording is PORTED, not rewritten. The 14 Magic Emails still say Jonah Babins, Toronto
//     Magic Company and Canadian pricing, because that is what they say in Notion and Michael is
//     rewriting them himself. They are here so they are to hand, not because they are ready to send.

export type EmailTemplate = {
  id: string
  /** Shown in the submenu, matching the heading in Notion. */
  name: string
  subject: string
  /** Body HTML for the rich editor. */
  body: string
  /** Set when the subject is not in Notion and had to be written; surfaced nowhere, kept as a note. */
  subjectAuthored?: boolean
  /** Set when the copy still refers to Jonah / Toronto Magic Company and must be rewritten first. */
  needsRewrite?: boolean
}

export type TemplateGroup = {
  id: string
  name: string
  templates: EmailTemplate[]
}

const field = (key: SmartField['key'], label: string) =>
  `<span class="merge-field" data-field="${key}" contenteditable="false">[${label}]</span>`
/** A red write-in placeholder. The text is wrapped in brackets, as these read in Notion. */
const note = (text: string) => `<span class="merge-field" data-note="true" contenteditable="false">[${text}]</span>`
/** A red write-in shown VERBATIM, for placeholders that carry their own delimiters ({{like_this}}). */
const raw = (text: string) => `<span class="merge-field" data-note="true" contenteditable="false">${text}</span>`

const NAME = field('firstName', 'Client first name')

// An embedded GIF. `w` is the file's real pixel width so it is never upscaled; max-width keeps it
// inside narrow mobile mail clients.
const gif = (slug: string, w: number, alt: string) =>
  `<p style="margin:0 0 12px 0"><img src="/api/email-gif/${slug}" data-crm-gif="${slug}" alt="${alt}" width="${w}" style="width:${w}px;max-width:100%;height:auto;border:0" /></p>`

const H = (text: string) => `<p><strong><u>${text}</u></strong></p>`

export const NO_TEMPLATE = ''

// --- Ghostbusters -----------------------------------------------------------
// The NUMBERED templates only. The unfinished ones at the bottom of that Notion page (Jurassic
// Park, I've Ruled Out Aliens, Snacks, Worth A Try) have no GIF chosen yet and are left out.
const GHOSTBUSTERS: EmailTemplate[] = [
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

// --- 14 Magic Emails --------------------------------------------------------
// Ported verbatim from the Notion page of the same name. Several still carry Jonah Babins / Toronto
// Magic Company / Canadian pricing and are flagged needsRewrite; a few had no subject line at all in
// Notion, so one was written here (subjectAuthored) because the composer requires a subject to send.
const MAGIC_14: EmailTemplate[] = [
  {
    id: 'm14-auto-good-lead',
    name: '1a. Auto Email (Good Lead)',
    subject: 'Thanks for reaching out about your event',
    body:
      `<p>Hi ${NAME},</p>` +
      `<p>Thanks for reaching out to Michael Bloemeke about ${note('Event Type')} on ${note('Event Date')}.</p>` +
      `<p>My job is simple: make your guests say "that was the best part of the night" and make you look like the hero who booked it.</p>` +
      H("Here's what happens next:") +
      `<p>Book a quick planning call</p>` +
      `<p>If you haven't already grabbed a spot, use this link now to choose a time that works for you: ${note('BOOKING LINK')}</p>` +
      `<p>On this short call we'll:</p>` +
      `<ul><li>Confirm your date, timing, and guest count</li>` +
      `<li>Recommend the right style of magic (strolling, show, or combo)</li>` +
      `<li>Give you clear pricing options so you can make a decision fast</li></ul>` +
      H("When you'll hear from me:") +
      `<p>I'll contact you by phone and email using the details you submitted.<br>` +
      `If you inquired on a weekend, expect to hear from me by Monday.</p>` +
      `<p>To help me prep, just hit reply and answer this in 1-2 sentences:<br>` +
      `<em>What's the most important thing you want your guests saying about the event the next day?</em></p>` +
      `<p>Looking forward to helping you create something unforgettable!</p>`,
  },
  {
    id: 'm14-auto-bad-lead',
    name: '1a. Auto Email (Bad Lead)',
    subject: 'I’ve got you covered!',
    body:
      `<p>Quick thing before I send options:</p>` +
      `<p>A) I specialize in premium ${note('EVENT TYPE')} magic. I personally perform and manage your event entertainment. This is a white-glove, fully customized experience with myself personally. Most clients invest $750-$2,500 for their ${note('EVENT TYPE')} experience (most events are at the lower end of that range).</p>` +
      `<p>If that's a fit, reply YES and I’ll send you a video and schedule a call to see how I can help.</p>` +
      `<p>B) If that's out of range, I can introduce you to independent magicians in the $300-$500 range. I don't perform, manage, or guarantee their work: I’m just making the intro so you're not starting from scratch.</p>` +
      `<p>If that's more of a fit for you, reply BUDGET and I'll make the intro!</p>`,
  },
  {
    id: 'm14-scheduling',
    name: '2. Scheduling Email',
    subject: 'Let’s chat!',
    body:
      `<p>Hey ${NAME},</p>` +
      `<p>Michael here - Thanks for reaching out, you're in good hands!</p>` +
      `<p>I have some quick questions about your ${note('Event')} to see if it's a fit!</p>` +
      `<p>I will call you around 12:00 PM EST Today ${note('Or some other reasonable time')}, let me know if that works.</p>` +
      `<p>Looking forward to learning more about your event!</p>` +
      `<p>PS. If you haven't seen it yet, click here ${note('embed link')} to watch my promo video, or click here ${note('embed link')} to check out the brochure.</p>`,
  },
  {
    id: 'm14-call-confirmation',
    name: '2a. Confirmation Email',
    subject: 'You’re confirmed!',
    body:
      `<p>Hey ${NAME},</p>` +
      `<p>Michael here, thanks for the inquiry about your event.</p>` +
      `<p>Just sending you a quick personal note that you booked a time to chat at ${note('call time')}. And it's confirmed!</p>` +
      `<p>Please click here ${note('embed link')} to watch our promo video before the call, so you're prepared!</p>`,
  },
  {
    id: 'm14-proposal',
    name: '3. Proposal Email',
    subject: 'Proposal',
    needsRewrite: true,
    body:
      `<p>Hey ${NAME},</p>` +
      `<p>Just sending my notes from our call over so you have it all in one place.</p>` +
      `<p><u>Here's what I'm working with:</u> a holiday party for around 100 people including plus ones, cocktail style, no assigned seating, food stations and an open bar, with the DJ taking over later in the night. Michael wants people mingling instead of stuck in their departments, the quieter folks included, and he wants the room genuinely excited to be there rather than feeling like they have to show up. Classy is the bar. And the dream is that everyone's dancing by the end of the night. After last year's line dancing, you're after something that fits a bigger office and still feels a little outside the box. ${note('This paragraph is an example. replace it with actual event details')}</p>` +
      `<p><u>My recommendation is ${note('performance style')}:</u> he works the room through the whole cocktail and food portion of the night, group to group, pulling people into magic that happens right in their hands. A group of two becomes a group of five, everyone walks away with something to talk about, and it quietly does the introductions for you. By the time the DJ takes over, the shy ones are out of their shells and the plus ones have made a few friends, so they actually want to stay and dance. It's sharp and dressed for the room, not a guy in a sparkly jacket, which is exactly the classy Michael's after. ${note('This paragraph is also an example. replace this with the relevant performance style details. Also, since I don’t have a VA yet, make sure to use first person and not third person')}</p>` +
      H('Check out my work:') +
      `<p>Promo Video<br>Slide Deck<br>300+ five star reviews<br>${note('any other links or videos that I should send. also, make sure to embed links to the above as well')}</p>` +
      H('Case Study:') +
      `<p>One that lines up well with your night: I did CDW's employee party at the El Mocambo, also food stations and mingling instead of a sit-down dinner. The case study walks through what the roaming magic looked like and how it landed. ${note('Obviously replace this with my own relevant case study and include a link to it. often I wont have one published that fits, in which case, this section can be excluded from the email')}</p>` +
      H('Pricing:') +
      `<p>Full event mingling with Jonah across the whole night, 7 to 10: $5,000 + HST<br>` +
      `Cocktail hour mingling, 90 minutes: $3,500 + HST<br>` +
      `${note('Just like all the other sections, replace this with details relevant to myself and the specific client/event')}</p>` +
      `<p>Reply to confirm this landed and I'll make sure you're all set, and I will see you and the team ${note('Call Time')}.</p>` +
      `<p>I had a great time on the call and is excited for this one.</p>`,
  },
  {
    id: 'm14-testimonial-bump',
    name: '4. Testimonial Bump (FU1)',
    subject: 'One more thing before our call',
    subjectAuthored: true,
    needsRewrite: true,
    body:
      `<p>One more thing to pass along before you and I talk it through ahead of Wednesday's call.</p>` +
      `<p>Here's a review from another company that booked me for their holiday party, same idea as yours with mingling through the social part of the night:</p>` +
      `<p>"We hired The Toronto Magic Company for our Company Holiday Party. Jonah arrived on time and mixed and mingled with our guests doing up close small group magic and set the tone for the evening. Bursts of laughter and AWE could be heard throughout cocktail hour. Jonah is a true professional, he is engaging and fresh, and he knows how to handle a crowd. A HUGE SUCCESS!! We loved him so much we hired him for a personal private event."</p>` +
      `<p>-Giovanna Battistella, Zavida Coffee</p>` +
      `<p>I’m looking forward to Wednesday at 3. See you then!</p>`,
  },
  {
    id: 'm14-abcde',
    name: '5. ABCDE Email',
    subject: 'Short one',
    subjectAuthored: true,
    needsRewrite: true,
    body:
      `<p>Hey ${NAME},</p>` +
      `<p>Short one. Thought you'd like this from another planner who booked Jonah for a client holiday party, same full event mingling we talked about:</p>` +
      `<p>"Jonah Babins performed his mingling magic at my company's client holiday party in November 2025. He did an absolutely amazing job for three straight hours, leaving our guests either dumbfounded or stunned. Our clients and our company's leaders were very impressed. Laughter followed Jonah everywhere he went, and I wholeheartedly recommend him for your corporate event."</p>` +
      `<p>-George Haim, Foyston &amp; Associates</p>` +
      `<p>Reply with one letter so we know where you're at:</p>` +
      `<p>A) We're in! Ready to move forward, please send next steps.<br>` +
      `B) Not a fit for this event, but let's keep in touch for the future.<br>` +
      `C) Still deciding, give me a few more days to talk it through with Michael.<br>` +
      `D) Michael has gotten obsessed with magic and is doing the show himself.<br>` +
      `E) Other.</p>`,
  },
  {
    id: 'm14-shark',
    name: '6. Shark (or other ghostbuster)',
    subject: 'Have you been eaten by a shark?',
    subjectAuthored: true,
    body: `<p>Hey ${NAME},</p><p>Have you been eaten by a shark?</p>`,
  },
  {
    id: 'm14-breakup',
    name: '7. Breakup Email',
    subject: 'Taking you out of my calendar',
    subjectAuthored: true,
    body:
      `<p>Hey ${NAME},</p>` +
      `<p>Hope you're doing well!</p>` +
      `<p>I haven't heard back from you, so I'll assume that you went in a different direction for entertainment at your upcoming ${note('event')}.</p>` +
      `<p>I'm going to release the penciled slot from the calendar.</p>` +
      `<p>If I got this wrong, just hit reply and let me know!</p>`,
  },
  {
    id: 'm14-pre-call-reminder',
    name: '8 & 9. Pre-Call Reminders',
    // Same email, sent 24 hours before and 1 hour before. The {{tags}} are Calendly's.
    subject: 'Reminder: Event Strategy Call at {{event_time}} on {{event_date}} with Jonah Babins',
    needsRewrite: true,
    body:
      `<p>Hey ${raw('{{invitee_full_name}}')},</p>` +
      `<p>We can't wait to connect and start planning something amazing for your event!</p>` +
      `<p>While you wait, take a peek at the our two performers videos : Ben Train and Jonah Babins</p>` +
      `<p>See you at ${raw('{{event_time}}')} on ${raw('{{event_date}}')}.</p>` +
      `<p>Jonah or Ben will call you on the number you provided!</p>` +
      `<p>Speak soon!</p>`,
  },
  {
    id: 'm14-bamfam-reminder',
    name: '10 & 11. BAMFAM Reminders',
    // Same email, sent 24 hours before and 1 hour before. The {{tags}} are Calendly's.
    subject: 'Reminder: {{event_name}} with {{my_name}} at {{event_time}} on {{event_date}}',
    needsRewrite: true,
    body:
      `<p>Hi ${raw('{{invitee_full_name}}')},</p>` +
      `<p>This is a friendly reminder that your ${raw('{{event_name}}')} with ${raw('{{my_name}}')} is at ${raw('{{event_time}}')} on ${raw('{{event_date}}')}.</p>` +
      `<p>If you have any questions about your event before the call, please email info@torontomagiccompany.com and sam will be happy to help!</p>`,
  },
]

// --- Old HoneyBook Templates ------------------------------------------------
// The ones Michael picked out of the HoneyBook archive. Post Call Email is deliberately excluded,
// as are the contract/invoice accompaniment and the empty stubs at the bottom of that page.
// Notion has TWO headings both called "Follow Up #2"; the second is the later, more urgent one, so
// it is filed here as Follow Up #3.
const HONEYBOOK: EmailTemplate[] = [
  {
    id: 'hb-initial-inquiry',
    name: 'Initial Inquiry',
    subject: 'Thanks For Reaching Out!',
    body:
      `<p>Hi ${NAME},</p>` +
      `<p>Thanks so much for reaching out! I would love to hop on a quick call and discuss details. Do you have a couple of minutes?</p>` +
      `<p>Thanks!</p>`,
  },
  {
    id: 'hb-inquiry-followup',
    name: 'Inquiry Follow Up',
    subject: 'Following Up on Your Inquiry',
    body:
      `<p>Hi ${NAME},</p>` +
      `<p>Just following up regarding your inquiry. I’d love to hop on a call and discuss details. Do you have a couple minutes today or tomorrow?</p>` +
      `<p>Thanks!</p>`,
  },
  {
    id: 'hb-followup',
    name: 'Follow Up',
    subject: 'Following Up',
    body:
      `<p>Hi ${NAME},</p>` +
      `<p>Just checking in to see if there’s anything I can answer for you about performing for your event or if you’re ready to book.</p>` +
      `<p>Thanks!</p>`,
  },
  {
    id: 'hb-followup-2',
    name: 'Follow Up #2',
    subject: 'Have you come to a decision?',
    body:
      `<p>Hi ${NAME},</p>` +
      `<p>Have you been able to come to a decision about the event? I'd love to get you in my calendar!<br>` +
      `Let me know if you have any questions.</p>` +
      `<p>Thanks!</p>`,
  },
  {
    id: 'hb-followup-3',
    name: 'Follow Up #3',
    subject: 'Have you come to a decision?',
    body:
      `<p>Hi ${NAME},</p>` +
      `<p>I've been receiving a lot of inquiries and want to check on you first. Were you able to come to a decision about the event?</p>` +
      `<p>Let me know if you have any questions.</p>` +
      `<p>Thanks!</p>`,
  },
  {
    id: 'hb-breakup',
    name: 'Break Up',
    subject: 'Taking you out of my calendar',
    body:
      `<p>Hi ${NAME},</p>` +
      `<p>I hope you're doing well! I haven't heard back from you, so I'll assume you went in a different direction for entertainment at your upcoming event. I'm going to release the penciled slot from the calendar.</p>` +
      `<p><strong><u>If I got this wrong, hit reply and let me know!</u></strong></p>` +
      gif('honeybook-breakup', 400, 'Breakup') +
      `<p>Thanks!</p>`,
  },
  {
    id: 'hb-booking-confirmation',
    name: 'Booking Confirmation',
    subject: 'Booking Confirmation',
    body:
      `<p>Hi ${NAME},</p>` +
      `<p>I'm just letting you know that the signature and deposit went through which means that you are booked in my calendar and everything is good to go!</p>` +
      `<p>I'll keep in touch as the date gets closer, but please don't hesitate to reach out if you have any questions.</p>` +
      `<p>Thanks again, I'm looking forward to it!</p>`,
  },
  {
    id: 'hb-two-week-checkin',
    name: '2-Week Check In',
    subject: 'Almost Here!',
    body:
      `<p>Hi ${NAME},</p>` +
      `<p>The event is coming up, I'm looking forward to it! Just wanted to send a quick check in to see how things are and make sure that everything is still good to go on your end for ${note('Project date, time, and location')}. As always, please don't hesitate to reach out if you need anything.</p>` +
      `<p>Thanks!</p>`,
  },
]

export const TEMPLATE_GROUPS: TemplateGroup[] = [
  { id: 'ghostbusters', name: 'Ghostbusters', templates: GHOSTBUSTERS },
  { id: 'magic-14', name: '14 Magic Emails', templates: MAGIC_14 },
  { id: 'honeybook', name: 'Old HoneyBook Templates', templates: HONEYBOOK },
]

/** Every template, flattened. */
export const EMAIL_TEMPLATES: EmailTemplate[] = TEMPLATE_GROUPS.flatMap((g) => g.templates)

export function findTemplate(id: string): EmailTemplate | undefined {
  return EMAIL_TEMPLATES.find((t) => t.id === id)
}
