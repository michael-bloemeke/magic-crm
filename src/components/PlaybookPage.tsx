// THE PLAYBOOK: what happens, in what order, from the moment a form comes in.
//
// Michael asked for this on 2026-10-13, the night the thank-you-page calendar was being built:
// "I want to know the exact timeline of exactly what I'm sending and when... from the time somebody
// books a call or fills out the form and books a call to when I send reminder emails, to when we
// actually get on the call, to when I get on the follow-up call."
//
// ⚠️ SOURCE AND AUTHORITY. Everything here comes from Jonah Babins's visit to the house,
// 2026-09-03 to 09-05 (`Plaud recordings/Mastermind/09-03 Jonah's Visit to my House-transcript.txt`
// and its siblings), with mechanics filled in from the upgraded 14 Magic Emails recording and two
// Win the Week calls. Michael's own ruling: where the visit disagrees with any older Mastermind
// material, THE VISIT WINS. It is the highest authority in this file.
//
// This is a FIRST PASS on purpose. Michael is recording dedicated Mastermind videos on BAM FAM to
// hand over, and this page is meant to grow when they land. It deliberately covers the general
// process and the email timeline only, not every corner of the business.
//
// ⚠️ IT IS A READING SURFACE, NOT A WORKFLOW. No buttons, no state, no writes. Jonah's single most
// important sentence from that visit was "it's a leads problem, not a CRM problem", and the point of
// this page is to hold the process still so it can be followed, not to become another system to
// maintain. Resist adding controls to it.

// ---------------------------------------------------------------------------
// THE MODEL: one column per moment in time.
//
// Michael, 2026-10-13: "I want a horizontal timeline. Actions can go above the line. And then the
// emails that are going out, whether automatic or ones that I manually send, should go below the
// lines... I want just the exact emails that I am going to send that I expect to send every single
// time... And also don't group multiple emails together."
//
// So two rules govern this data and they are the whole point of the page:
//
//   1. ONE EMAIL PER BLOCK. No "reminders" block covering three sends. If three emails go out, that
//      is three columns. He is configuring a scheduler off this page and needs the count to be real.
//   2. NO OPTIONS. Every email listed here goes out every single time. Anything conditional,
//      judgement-based or "you could also" belongs in the notes below the timeline, not on it.
// ---------------------------------------------------------------------------

type Moment = {
  when: string
  // Above the line: something a person does. Omit when the moment is only an email.
  action?: { title: string; by: 'You' | 'Them'; detail?: string }
  // Below the line: exactly one email. Omit when the moment is only an action.
  //
  // `by` is who actually sends it, which tells Michael what work he has. `seenAs` is who the CLIENT
  // thinks it came from, which is a different question and the one he asked for on 2026-10-14:
  // "if the client is supposed to see that email as having come from the calendar, then I want you
  // to make that block highlighted a light blue... regardless of whether it actually is or if it's
  // some Claude coded AI email that I have running on a schedule."
  //
  // The two genuinely differ. The thanks-for-reaching-out email fires automatically off the form,
  // but it goes from his own address and reads as though he typed it, so it is NOT blue.
  //
  // ⚠️ WHAT DECIDES `seenAs: 'Calendar'`: TidyCal sends from ITS OWN email address with Michael's
  // name as the display name (reply-to is his). So the client sees his name but a scheduler
  // address, and the content is plainly a system email. Those read as calendar mail. Checked
  // against TidyCal's docs 2026-10-14.
  email?: { title: string; by: 'You' | 'Automatic'; seenAs?: 'Calendar'; detail?: string }
}

const ACTOR = {
  You: 'var(--color-brass)',
  Them: 'var(--color-umb-inquiry)',
  Automatic: 'var(--color-umb-postcall)',
} as const

// The path when they book, which is the one that should happen every time.
//
// ⚠️ TWO REMINDERS PER CALL, 24 HOURS AND 1 HOUR. This is MICHAEL'S system, not Jonah's.
//
// Jonah runs three (24h, 1h, 10m) on Calendly, and says so at 00:41:02 of the 09-03 visit
// transcript for both calls. Michael chose TidyCal on 2026-10-14 knowing it caps reminders at TWO
// per booking type: "I don't mind only having two reminders instead of three. A day before and an
// hour before is perfectly acceptable."
//
// So this page shows what he will actually send. **Do not "correct" it back to three** against the
// transcript: the gap is a decision, and the reasoning is in magic-crm.md.
const BOOKED: Moment[] = [
  {
    when: 'Day 0',
    action: { title: 'They fill in the form', by: 'Them', detail: 'The thank-you page they land on IS the calendar.' },
    email: { title: 'Thanks for reaching out', by: 'Automatic', detail: 'Fires off the form, but from YOUR address and written as though you typed it. What happens next, how to grab a slot, promo video and reviews.' },
  },
  {
    when: 'Day 0, minutes later',
    action: { title: 'They book a slot', by: 'Them', detail: 'Only the next three days are offered.' },
    email: { title: 'Booking confirmation', by: 'Automatic', seenAs: 'Calendar', detail: 'This is the calendar invite itself, set up in TidyCal (2026-10-15): who it is with, the date and time, the number you call, the promo video link, and a reschedule link. Written about you, not from you.' },
  },
  { when: '24 hours before', email: { title: 'Call reminder', by: 'Automatic', seenAs: 'Calendar', detail: 'TidyCal sends ONE message for both reminders: the date and time, the number you call, the promo video, and the reviews.' } },
  { when: '1 hour before', email: { title: 'Call reminder', by: 'Automatic', seenAs: 'Calendar', detail: 'The same message as the day before.' } },
  {
    when: 'The call',
    action: { title: 'Sales call', by: 'You', detail: 'Book the follow-up before you hang up, on your hidden Follow-Up Call page in TidyCal (Booking types, then the open-in-new-tab icon), with their name and email. Get the name of the person they run it by.' },
  },
  {
    when: 'Within the hour',
    email: { title: 'The proposal page', by: 'You', detail: 'The event as discussed, the price you quoted, videos, reviews, the case study, and the follow-up date restated.' },
  },
  {
    when: '48 hours before the follow-up',
    email: { title: 'The testimonial bump', by: 'You', detail: 'One review that matches their event. Name the person they run it by, and restate the follow-up time at the close.' },
  },
  { when: '24 hours before', email: { title: 'Follow-up reminder', by: 'Automatic', seenAs: 'Calendar', detail: 'Same flavour, for the Follow-Up Call: the date and time, a reply-with-questions line, and the reviews.' } },
  { when: '1 hour before', email: { title: 'Follow-up reminder', by: 'Automatic', seenAs: 'Calendar', detail: 'The same message as the day before.' } },
  {
    when: 'The follow-up',
    action: { title: 'Follow-up call', by: 'You', detail: 'If they already said yes, keep it and run it as onboarding.' },
  },
]

// They saw the calendar and closed the tab. Daily phone contact, and every email pushes them back
// to the same calendar page.
const NOT_BOOKED: Moment[] = [
  {
    when: 'Day 0',
    action: { title: 'Call, twice in a row', by: 'You', detail: 'Two calls back to back signals a real person rather than a scam.' },
    email: { title: 'Sorry you did not book a call', by: 'You', detail: 'A link straight back to the calendar.' },
  },
  {
    when: 'Day 1',
    action: { title: 'Call, voicemail, text', by: 'You', detail: 'Name the next attempt out loud: "I will try again tomorrow at this time."' },
    email: { title: 'People always ask about reviews', by: 'You', detail: 'A link to the reviews, and the calendar again.' },
  },
  {
    when: 'Day 2',
    action: { title: 'Call', by: 'You' },
    email: { title: 'Reply and I will send you a link', by: 'You', detail: 'Short, and expecting a reply.' },
  },
  {
    when: 'Day 3',
    action: { title: 'Call', by: 'You' },
    email: { title: 'The breakup', by: 'You', detail: 'Then the no or maybe pile.' },
  },
]

// After the follow-up call, when they have gone quiet. One a day, and they are named emails with
// copy already written, not a menu to choose from.
const GONE_QUIET: Moment[] = [
  { when: '48 hours after', email: { title: 'A, B, C, D, E', by: 'You', detail: 'Reply with one letter. Customise the joke option to their actual event.' } },
  { when: 'Next day', email: { title: 'Who You Gonna Call?', by: 'You', detail: 'The Ghostbusters gag. This one pulls the most replies.' } },
  { when: 'Next day', email: { title: 'You Made A Great Call', by: 'You', detail: 'Written as their future self, after the event.' } },
  { when: 'Next day', email: { title: 'Is Everything Okay?', by: 'You', detail: '"I am starting to get worried. Were you eaten by a shark?" That is the whole body.' } },
  { when: 'Next day', email: { title: 'You Win', by: 'You', detail: '"You are the all-time champion of hide and seek."' } },
  { when: 'Next day', email: { title: 'It is Not You, It is Me', by: 'You', detail: 'The breakup. One more week, then archive.' } },
]

function Pill({ by }: { by: 'You' | 'Them' | 'Automatic' }) {
  return (
    <span
      className="rounded-full border px-1.5 py-px text-[9.5px] font-semibold"
      style={{ color: ACTOR[by], borderColor: `color-mix(in oklab, ${ACTOR[by]} 40%, var(--color-line))` }}
    >
      {by}
    </span>
  )
}

// ⚠️ THE RAIL IS BUILT FROM EACH COLUMN'S OWN TOP BORDER, not one absolutely positioned line. The
// columns then carry the rail with them when the track scrolls sideways, so it cannot drift out of
// register with the dots the way an overlaid line does.
function HorizontalTimeline({ moments }: { moments: Moment[] }) {
  return (
    <div className="board-scroll -mx-1 overflow-x-auto px-1 pb-2">
      <div className="flex min-w-max">
        {moments.map((m, i) => (
          <div key={i} className="flex w-[232px] shrink-0 flex-col px-1.5">
            {/* Above the line: what a person does. */}
            <div className="flex min-h-[112px] flex-col justify-end">
              {m.action && (
                <div className="rounded-xl border border-line bg-surface p-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-[13px] font-semibold leading-snug text-parchment">{m.action.title}</p>
                    <Pill by={m.action.by} />
                  </div>
                  {m.action.detail && <p className="mt-1 text-[11.5px] leading-snug text-muted">{m.action.detail}</p>}
                </div>
              )}
            </div>

            {/* The line itself, with the moment's label sitting on it.
                `-mx-1.5` cancels the column's own horizontal padding so the border spans the FULL
                column width. Without it every column boundary leaves a 6px notch and the rail reads
                as a row of dashes rather than one continuous line. */}
            <div className="relative -mx-1.5 my-2 border-t-2 border-line-strong px-1.5 pt-3">
              <span
                className="absolute -top-[7px] left-1/2 h-3 w-3 -translate-x-1/2 rounded-full border-2 border-surface-2"
                style={{ backgroundColor: m.email ? ACTOR[m.email.by] : m.action ? ACTOR[m.action.by] : 'var(--color-line-strong)' }}
                aria-hidden
              />
              <p className="text-center text-[10px] font-semibold uppercase tracking-[0.1em] text-faint">{m.when}</p>
            </div>

            {/* Below the line: exactly one email, never a group.
                Light blue = the CLIENT reads it as calendar mail. Plain = they read it as from
                Michael, whether or not a machine actually sent it. */}
            <div className="min-h-[124px]">
              {m.email && (
                <div
                  className="rounded-xl border p-3"
                  style={
                    m.email.seenAs === 'Calendar'
                      ? {
                          backgroundColor: 'color-mix(in oklab, var(--color-umb-postcall) 10%, var(--color-surface))',
                          borderColor: 'color-mix(in oklab, var(--color-umb-postcall) 32%, var(--color-line))',
                        }
                      : { backgroundColor: 'var(--color-surface)', borderColor: 'var(--color-line)' }
                  }
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-[13px] font-semibold leading-snug text-parchment">{m.email.title}</p>
                    <Pill by={m.email.by} />
                  </div>
                  {m.email.detail && <p className="mt-1 text-[11.5px] leading-snug text-muted">{m.email.detail}</p>}
                  {m.email.seenAs === 'Calendar' && (
                    <p className="mt-1.5 text-[10.5px] font-semibold" style={{ color: 'var(--color-umb-postcall)' }}>
                      They see this as calendar mail
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function Legend() {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-[11.5px] text-muted">
      <span className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: ACTOR.You }} />
        You send it or you do it
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: ACTOR.Automatic }} />
        The scheduler sends it
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: ACTOR.Them }} />
        They do it
      </span>
      <span className="text-faint">Above the line, what happens. Below the line, the email that goes out.</span>
      <span className="flex items-center gap-1.5">
        <span
          className="h-3 w-5 rounded border"
          style={{
            backgroundColor: 'color-mix(in oklab, var(--color-umb-postcall) 10%, var(--color-surface))',
            borderColor: 'color-mix(in oklab, var(--color-umb-postcall) 32%, var(--color-line))',
          }}
        />
        Blue means the client reads it as coming from the calendar, not from you
      </span>
    </div>
  )
}

// ⚠️ EVERY SECTION SITS ON ITS OWN SURFACE, AND THAT IS NOT DECORATION.
//
// The `.brand-ground` navy is a BAND at the top of the page, not the page itself: measured
// 2026-10-13, its bottom edge is about 600px tall and it scrolls away, so everything below the first
// screen is on the light body background. Section headings were written as `text-parchment`, which
// the brand ground redefines to near-white, and they turned invisible the moment they scrolled past
// the band. This page is long enough that most of it lives down there.
//
// Wrapping each section in a surface makes it self-contained: the token reset on `bg-surface*` gives
// it dark text on light, so contrast no longer depends on where the section happens to sit, or on
// what the ground does next.
function Section({ title, blurb, children }: { title: string; blurb?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-surface-2/50 p-5">
      <h3 className="font-display text-[19px] text-parchment">{title}</h3>
      {blurb && <p className="mb-4 mt-1 max-w-3xl text-[13px] leading-relaxed text-muted">{blurb}</p>}
      <div className={blurb ? '' : 'mt-4'}>{children}</div>
    </section>
  )
}

export function PlaybookPage() {
  return (
    // ⚠️ THE PAGE OWNS ITS OWN SCROLLER. Every page in this app does; nothing above it scrolls.
    // The wrapper this sits in is `h-screen overflow-hidden`, and the band inside it is about 600px
    // tall with `overflow: visible`, so a page that forgets this simply gets CLIPPED: the content is
    // all there, laid out and measurable, and the wheel does nothing. This page shipped that way on
    // 2026-10-13 and Michael could only see the first two sections.
    //
    // `board-scroll h-full overflow-y-auto px-8 pb-12` is the convention, matching FinancePage,
    // ProposalsPage, ContactsPage and the rest. Keep the padding too: without px-8 the content runs
    // into the sidebar.
    <div className="board-scroll h-full space-y-9 overflow-y-auto px-8 pb-12">
      <div className="rounded-2xl border border-line bg-surface-2/50 p-5">
        <h2 className="font-display text-[21px] text-parchment">Your business is a doctor's office</h2>
        <p className="mt-2 max-w-3xl text-[13.5px] leading-relaxed text-muted">
          That one idea is underneath the whole process. Nobody rings a doctor to say they are thinking about coming in
          about their foot. They book an appointment.
        </p>
        <p className="mt-3 max-w-3xl border-l-2 pl-3 text-[13.5px] italic leading-relaxed text-parchment" style={{ borderColor: 'var(--color-brass-dim)' }}>
          "If it's not an official business, it's just some guy that does magic tricks, then I feel weird for pestering
          you, and I also feel weird for dropping you. But now both make sense. It's an official thing. Let me even
          annoy you because this is a business, and I want to know the answer. Or if you're not going to answer, okay,
          great. You're not a real client. I'm dropping you."
        </p>
        <p className="mt-2 text-[12px] text-faint">Your own words, on Jonah's visit, 2026-09-03.</p>
      </div>

      <Section
        title="BAM FAM, in one line"
        blurb="Book A Meeting From A Meeting. You never leave a call without the next one in the calendar, and you book it every single time, not just when the deal feels shaky."
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {[
            {
              h: 'Say it as a walkthrough, not a check-in',
              p: '"Let me put it all together in a proposal, and in three days let\'s go through it together. If there are any other decision makers, I would love to be there with them." The follow-up is a walkthrough of a document that does not exist yet, which is why it never feels like pestering.',
            },
            {
              h: 'Never ask a yes/no question',
              p: '"So that you don\'t have to follow up with me endlessly, let\'s schedule a call after you\'ve spoken with them. Is this a chat later tonight kind of thing, or a later this week kind of thing?" Always A or B. Ask yes or no and you get a no.',
            },
            {
              h: 'Book it close',
              p: 'Two or three days out, never two weeks. A tight gap is what keeps the number of follow-up emails down, which is the opposite of how it feels.',
            },
          ].map((c) => (
            <div key={c.h} className="rounded-xl border border-line bg-surface p-4">
              <p className="text-[14px] font-semibold text-parchment">{c.h}</p>
              <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{c.p}</p>
            </div>
          ))}
        </div>
        <p className="mt-3 max-w-3xl text-[12.5px] leading-relaxed text-faint">
          It works even when the call never happens. Around thirty percent do not, and almost all of those people send
          an answer before cancelling. The date is a goalpost, not a meeting.
        </p>
      </Section>

      <Section
        title="The timeline, when they book"
        blurb="Ten moments from form fill to the follow-up call. Eight emails go out. Three read as coming from you and five read as calendar mail, and once this is set up you only send two of the eight by hand. Scroll sideways."
      >
        <Legend />
        <HorizontalTimeline moments={BOOKED} />
      </Section>

      <Section
        title="When they do not book a slot"
        blurb="This used to be the default path. Once the calendar is on the thank-you page it becomes the exception, and it is a phone sequence with an email attached to each call. Every one of these emails links back to the same calendar page."
      >
        <HorizontalTimeline moments={NOT_BOOKED} />
      </Section>

      <Section
        title="When they go quiet after the call"
        blurb="One a day, in this order. The copy for all five Ghostbusters is already written, in Library/reference/ghostbuster-emails.txt. Two buckets only: valuable, or funny. A follow-up that is neither does not get sent."
      >
        <HorizontalTimeline moments={GONE_QUIET} />
      </Section>

      <Section title="Rules that apply to every email in the run">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {[
            ['SPEAR', 'Short, personal, and expecting a reply. That last part is how you get answers rather than reads.'],
            ['The signature', 'The promo video and the reviews go in every single email. Jonah calls it a signature for a reason.'],
            ['Never naggy', '"Do you have any questions?" is dead. If they had questions they would have asked them. Send something useful or something funny.'],
            ['No fake scarcity', 'Only say the date is filling up if it actually is. Check the calendar first.'],
            ['Never guilt', 'Guilt has never moved anybody to action in a business setting. Not once.'],
            ['Make the no easy', 'A fast no is worth more than a slow maybe. It gets a dead lead out of the pipeline.'],
          ].map(([h, p]) => (
            <div key={h} className="rounded-xl border border-line bg-surface p-3.5">
              <p className="text-[13.5px] font-semibold text-parchment">{h}</p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-muted">{p}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section title="The exceptions worth remembering">
        <div className="space-y-3">
          {[
            [
              'Weddings',
              'They are booking a year and a half out and they will think about it forever. Run the same play, but get the couple together: "I would hate for you to say this is the thing you want, and then somebody else books it, because there are only so many Saturdays in December."',
            ],
            [
              'Private events should be easier than corporate',
              'They are usually booking two or three weeks out and there is no committee to consult.',
            ],
            [
              'Sometimes the right call is no follow-up call at all',
              'Karl Richardson, 2026-08-21: mid-decision with his wife, had asked to be pinged, and already apologising for being slow. A formal appointment would have added pressure. You left it open and set yourself a text instead. That judgement was right and the default should not override it.',
            ],
            [
              'When they refuse the follow-up call',
              'Do not fight it and do not chase. Send the proposal page and let them book off it if they want to.',
            ],
          ].map(([h, p]) => (
            <div key={h} className="rounded-xl border border-line bg-surface p-4">
              <p className="text-[14px] font-semibold text-parchment">{h}</p>
              <p className="mt-1.5 max-w-3xl text-[13px] leading-relaxed text-muted">{p}</p>
            </div>
          ))}
        </div>
      </Section>

      <div className="rounded-2xl border border-line bg-surface-2/40 p-4">
        <p className="text-[13px] leading-relaxed text-muted">
          Sourced from Jonah Babins's visit, 3 to 5 September 2026, with mechanics from the upgraded 14 Magic Emails
          recording and two Win the Week calls. Where the visit disagrees with anything older, the visit wins.
        </p>
        <p className="mt-2 text-[12.5px] leading-relaxed text-faint">
          This is a first pass covering the general process and the email timeline. It is meant to grow when the BAM FAM
          recordings land. The long-form versions live in <span className="text-muted">sales.md</span> and{' '}
          <span className="text-muted">proposal-playbook.md</span>.
        </p>
      </div>
    </div>
  )
}
