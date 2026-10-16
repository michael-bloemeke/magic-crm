// Pure logic for calendar-alerts: Eastern time, sorting Google events into kinds, and the wording of
// every push. NO IMPORTS on purpose, so the same file runs in the edge function (Deno) and under
// Node 22 for the local tests (`node --experimental-strip-types`). Keep the syntax erasable: no
// enums, no namespaces, no constructor parameter properties.
//
// Push wording rules (Michael's): 12-hour Eastern times, plain words, and no em dash or en dash
// anywhere, including inside event titles that arrive with one (clean() swaps them for a hyphen).

export const EASTERN = "America/New_York";

// Every event the CRM writes carries this line in its description (crm-calendar.mjs, CRM_MARKER).
// Those are his CRM tasks and gigs: tasks already have their own alarms, so they never get a
// new-event or starting-soon push here. They do appear in the morning schedule.
export const CRM_MARKER = "Synced from Magic CRM";

// Michael's own addresses. A guest at one of these is Michael, not someone else.
export const MICHAEL_EMAILS = ["michael@michaelbloemeke.com", "mchlbloemeke@gmail.com"];

// booking = TidyCal (or another booking tool), invite = someone else's event he is on,
// own = something he added himself, gmail = added by Gmail (flights, reservations), crm = the CRM's.
export type Kind = "booking" | "invite" | "own" | "gmail" | "crm";
// The kinds Michael can switch on for the "new event" push. Gmail and CRM events never get one.
export const ANNOUNCE_KINDS: Kind[] = ["booking", "invite", "own"];
// The kinds that get a "starting soon" push.
export const SOON_KINDS: Kind[] = ["booking", "invite", "own", "gmail"];

export type Guest = { name: string; email: string };

// The fields we read from a Google Calendar event resource.
export type GEvent = {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  created?: string;
  updated?: string;
  iCalUID?: string;
  recurringEventId?: string;
  eventType?: string;
  transparency?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
  organizer?: { email?: string; displayName?: string; self?: boolean };
  creator?: { email?: string; displayName?: string; self?: boolean };
  attendees?: Array<{
    email?: string;
    displayName?: string;
    self?: boolean;
    organizer?: boolean;
    resource?: boolean;
    responseStatus?: string;
  }>;
  source?: { url?: string; title?: string };
  hangoutLink?: string;
  conferenceData?: { conferenceSolution?: { name?: string } };
};

// One row of calendar_events, Google-side fields only (what toRow builds from an event).
export type Row = {
  calendar_id: string;
  event_id: string;
  ical_uid: string | null;
  recurring_event_id: string | null;
  title: string;
  start_at: string | null;
  end_at: string | null;
  all_day: boolean;
  start_date: string | null;
  status: string;
  transparency: string;
  event_type: string;
  kind: Kind;
  self_response: string | null;
  location: string | null;
  guests: Guest[];
  html_link: string | null;
  meeting: string | null;
  g_created: string | null;
  g_updated: string | null;
};

// A stored row also carries the stamps that make every push happen exactly once.
export type Stored = Row & {
  announced_at: string | null;
  announced_start: string | null;
  reminded_at: string | null;
  reminded_start: string | null;
  cancel_alerted_at: string | null;
};

export type Settings = {
  newEventEnabled: boolean;
  newEventKinds: string[];
  digestEnabled: boolean;
  digestTime: string; // "HH:MM", 24-hour, Eastern
  digestDays: number[]; // ISO days, 1 = Monday ... 7 = Sunday
  digestCalendars: string[]; // calendar names as Michael sees them
  soonEnabled: boolean;
  soonMinutes: number;
  soonSkipFree: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  newEventEnabled: true,
  newEventKinds: ["booking", "invite"],
  digestEnabled: true,
  digestTime: "07:00",
  digestDays: [1, 2, 3, 4, 5, 6, 7],
  digestCalendars: ["Work", "Gigs"],
  soonEnabled: true,
  soonMinutes: 10,
  soonSkipFree: false,
};

// deno-lint-ignore no-explicit-any
export function settingsFromRow(r: any): Settings {
  if (!r) return { ...DEFAULT_SETTINGS };
  const kinds = Array.isArray(r.new_event_kinds) ? r.new_event_kinds.map(String) : DEFAULT_SETTINGS.newEventKinds;
  const days = Array.isArray(r.digest_days) ? r.digest_days.map(Number) : DEFAULT_SETTINGS.digestDays;
  const cals = Array.isArray(r.digest_calendars) ? r.digest_calendars.map(String) : DEFAULT_SETTINGS.digestCalendars;
  const mins = Math.round(Number(r.soon_minutes));
  return {
    newEventEnabled: r.new_event_enabled !== false,
    newEventKinds: kinds.filter((k: string) => (ANNOUNCE_KINDS as string[]).includes(k)),
    digestEnabled: r.digest_enabled !== false,
    digestTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(r.digest_time ?? "")) ? String(r.digest_time) : "07:00",
    digestDays: days.filter((n: number) => n >= 1 && n <= 7),
    digestCalendars: cals.map((s: string) => s.trim()).filter(Boolean),
    soonEnabled: r.soon_enabled !== false,
    soonMinutes: Number.isFinite(mins) && mins >= 1 && mins <= 120 ? mins : 10,
    soonSkipFree: r.soon_skip_free === true,
  };
}

// ---------------------------------------------------------------------------------------------
// America/New_York time, DST-correct with no library (same approach as notify-cron).
// ---------------------------------------------------------------------------------------------

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ISO_DOW: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const pad = (n: number) => String(n).padStart(2, "0");

const PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: EASTERN,
  weekday: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export type EasternParts = { y: number; mo: number; d: number; h: number; mi: number; s: number; wd: string; isoDow: number };

export function easternParts(ms: number): EasternParts {
  const parts = PARTS.formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  let h = Number(get("hour"));
  if (h === 24) h = 0; // Intl can emit 24 for midnight
  const wd = get("weekday");
  return {
    y: Number(get("year")),
    mo: Number(get("month")),
    d: Number(get("day")),
    h,
    mi: Number(get("minute")),
    s: Number(get("second")),
    wd,
    isoDow: ISO_DOW[wd] ?? 0,
  };
}

// Minutes that New York is BEHIND UTC at a UTC instant. EDT = 240, EST = 300.
function nyOffsetMinutes(atUtcMs: number): number {
  const p = easternParts(atUtcMs);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return Math.round((atUtcMs - asUtc) / 60000);
}

// A New York wall-clock time to the UTC instant it denotes.
export function nyWallClockToUtcMs(y: number, mo: number, d: number, h: number, mi: number): number {
  const naive = Date.UTC(y, mo - 1, d, h, mi, 0);
  const guess = naive + nyOffsetMinutes(naive) * 60000;
  return naive + nyOffsetMinutes(guess) * 60000;
}

export function easternDateISO(ms: number): string {
  const p = easternParts(ms);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
}

export function addDaysISO(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// Midnight Eastern at the start of a YYYY-MM-DD day, as a UTC instant.
export function easternDayStartMs(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return nyWallClockToUtcMs(y, m, d, 0, 0);
}

// 14:05 Eastern -> "2:05 PM". Built by hand: Intl puts a narrow no-break space before PM.
export function timeLabel(ms: number): string {
  const p = easternParts(ms);
  return `${p.h % 12 === 0 ? 12 : p.h % 12}:${pad(p.mi)} ${p.h < 12 ? "AM" : "PM"}`;
}

// "Thu Oct 22"
export function dayLabel(ms: number): string {
  const p = easternParts(ms);
  return `${p.wd} ${MONTHS_SHORT[p.mo - 1]} ${p.d}`;
}

// "today at 2:00 PM", "tomorrow at 2:00 PM", or "Thu Oct 22 at 2:00 PM".
export function whenLabel(ms: number, nowMs: number): string {
  const day = easternDateISO(ms);
  const today = easternDateISO(nowMs);
  const on = day === today ? "today" : day === addDaysISO(today, 1) ? "tomorrow" : dayLabel(ms);
  return `${on} at ${timeLabel(ms)}`;
}

// ---------------------------------------------------------------------------------------------
// Reading an event
// ---------------------------------------------------------------------------------------------

// Plain text for a push: dashes become hyphens, whitespace collapses, long titles are cut.
// (Calendar spam arrives with a whole paragraph as its title.)
export function clean(s: unknown, max = 90): string {
  let t = String(s ?? "").replace(/[‒–—―−]/g, "-").replace(/\s+/g, " ").trim();
  if (t.length > max) t = t.slice(0, max - 3).trimEnd() + "...";
  return t;
}

export function isMichael(email?: string): boolean {
  return MICHAEL_EMAILS.includes(String(email ?? "").trim().toLowerCase());
}

export function isCrm(e: GEvent): boolean {
  return String(e.description ?? "").includes(CRM_MARKER);
}

function hostOf(url?: string): string {
  try {
    return new URL(String(url ?? "")).hostname.toLowerCase();
  } catch {
    return "";
  }
}

// TidyCal writes the booking into Michael's calendar as Michael, with the client as a guest. Two
// markers, both verified on the real booking of 2026-10-16: `source.url` is
// https://tidycal.com/b/<id>/<booking>/confirmation, and the description carries the tidycal.com
// "Reschedule or cancel" link.
export function isTidyCal(e: GEvent): boolean {
  const host = hostOf(e.source?.url);
  return host === "tidycal.com" || host.endsWith(".tidycal.com") || /tidycal\.com/i.test(String(e.description ?? ""));
}

// People on the event other than Michael (no rooms, no group calendars).
export function guestsOf(e: GEvent): Guest[] {
  return (e.attendees ?? [])
    .filter((a) => !a.self && !a.resource && !isMichael(a.email) && !/@group\.calendar\.google\.com$/i.test(String(a.email ?? "")))
    .map((a) => ({ name: clean(a.displayName ?? "", 60), email: String(a.email ?? "").trim() }));
}

export function selfResponse(e: GEvent): string | null {
  return (e.attendees ?? []).find((a) => a.self)?.responseStatus ?? null;
}

export function classify(e: GEvent): Kind {
  if (isCrm(e)) return "crm";
  if (isTidyCal(e)) return "booking";
  if (e.eventType === "fromGmail") return "gmail";
  // Someone else organised it and Michael is on it. (Google only sends `self` when it is true.)
  if (e.organizer && !e.organizer.self && !isMichael(e.organizer.email)) return "invite";
  // Any other booking tool writes the event the same way TidyCal does: as Michael, with the client
  // as a guest, and its own link in `source`. Google's own sources (Gmail) are not bookings.
  const host = hostOf(e.source?.url);
  if (host && !/(^|\.)google\.com$/.test(host) && guestsOf(e).length > 0) return "booking";
  return "own";
}

// "+1 919-239-9898" and similar: TidyCal puts the client's phone number in the location.
export function looksLikePhone(s: string): boolean {
  const t = String(s ?? "").trim();
  return /^\+?[\d\s().-]+$/.test(t) && (t.match(/\d/g) ?? []).length >= 7;
}

function meetingName(e: GEvent): string | null {
  const name = e.conferenceData?.conferenceSolution?.name;
  if (name) return clean(name, 40);
  return e.hangoutLink ? "Google Meet" : null;
}

function toIso(s?: string): string | null {
  const ms = Date.parse(String(s ?? ""));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function toRow(calendarId: string, e: GEvent): Row {
  const allDay = !!e.start?.date && !e.start?.dateTime;
  let startAt: string | null = null;
  let endAt: string | null = null;
  if (allDay) {
    startAt = new Date(easternDayStartMs(String(e.start?.date))).toISOString();
    endAt = e.end?.date ? new Date(easternDayStartMs(String(e.end.date))).toISOString() : startAt;
  } else {
    startAt = toIso(e.start?.dateTime);
    endAt = toIso(e.end?.dateTime) ?? startAt;
  }
  return {
    calendar_id: calendarId,
    event_id: e.id,
    ical_uid: e.iCalUID ?? null,
    recurring_event_id: e.recurringEventId ?? null,
    title: String(e.summary ?? "").slice(0, 500),
    start_at: startAt,
    end_at: endAt,
    all_day: allDay,
    start_date: allDay ? String(e.start?.date) : null,
    status: e.status ?? "confirmed",
    transparency: e.transparency ?? "opaque",
    event_type: e.eventType ?? "default",
    kind: classify(e),
    self_response: selfResponse(e),
    location: e.location ? String(e.location).slice(0, 500) : null,
    guests: guestsOf(e).slice(0, 10),
    html_link: e.htmlLink ?? null,
    meeting: meetingName(e),
    g_created: toIso(e.created),
    g_updated: toIso(e.updated),
  };
}

// What the push calls the event. A TidyCal booking reads "Event Strategy Call with Jane Doe": the
// booking type from the title plus the client's name from the guest list, so it names the client
// whichever name TidyCal put after "with".
export function labelFor(r: { kind: string; title: string; guests: Guest[] }): string {
  const title = clean(r.title) || "(no title)";
  if (r.kind !== "booking") return title;
  const g = (r.guests ?? []).find((x) => x.name || x.email);
  const who = g ? g.name || g.email : "";
  if (!who) return title;
  const base = clean(r.title).replace(/\s+with\s+.+$/i, "").trim() || title;
  return clean(`${base} with ${who}`);
}

// ---------------------------------------------------------------------------------------------
// Which events get which push
// ---------------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;

function ms(s: string | null | undefined): number {
  return Date.parse(String(s ?? ""));
}

// "New" means made in the last day. An invite he has not answered also counts if it changed in the
// last day, because Google keeps the organiser's original creation time on an invite added later.
export function isFresh(r: Row, nowMs: number): boolean {
  const created = ms(r.g_created);
  if (Number.isFinite(created) && nowMs - created <= DAY_MS) return true;
  const updated = ms(r.g_updated);
  return r.kind === "invite" && r.self_response === "needsAction" && Number.isFinite(updated) && nowMs - updated <= DAY_MS;
}

// Could this event be announced at all (ignoring freshness)? Used by the run and by the go-live seed.
export function announceKindOk(r: Row, s: Settings, nowMs: number): boolean {
  return (
    s.newEventEnabled &&
    (ANNOUNCE_KINDS as string[]).includes(r.kind) &&
    s.newEventKinds.includes(r.kind) &&
    r.status !== "cancelled" &&
    !r.all_day &&
    r.event_type === "default" &&
    r.self_response !== "declined" &&
    ms(r.start_at) > nowMs
  );
}

export function announceable(r: Row, s: Settings, nowMs: number): boolean {
  return announceKindOk(r, s, nowMs) && isFresh(r, nowMs);
}

// Starting soon: timed, live, not declined, a kind that gets it, within the window, not yet
// reminded for THIS start time (a moved event is reminded again at its new time).
export function soonEligible(r: Stored, s: Settings, nowMs: number): boolean {
  const start = ms(r.start_at);
  if (!s.soonEnabled || r.all_day || r.status === "cancelled") return false;
  if (!(SOON_KINDS as string[]).includes(r.kind)) return false;
  if (r.event_type !== "default" && r.event_type !== "fromGmail") return false;
  if (r.self_response === "declined") return false;
  if (s.soonSkipFree && r.transparency === "transparent") return false;
  if (!(start > nowMs && start <= nowMs + s.soonMinutes * 60_000)) return false;
  return !(r.reminded_start && ms(r.reminded_start) === start);
}

// Morning schedule: switched on, a chosen day, inside the three hours after the chosen time, and
// not sent yet today. Three hours so a run missed at 7:00 still goes out, but never at bedtime.
export function digestDue(s: Settings, lastDigestOn: string | null | undefined, nowMs: number): boolean {
  if (!s.digestEnabled) return false;
  const p = easternParts(nowMs);
  const today = `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
  if (!s.digestDays.includes(p.isoDow)) return false;
  if (lastDigestOn && String(lastDigestOn).slice(0, 10) >= today) return false;
  const [h, m] = s.digestTime.split(":").map(Number);
  const start = h * 60 + m;
  const now = p.h * 60 + p.mi;
  return now >= start && now < Math.min(start + 180, 1440);
}

// ---------------------------------------------------------------------------------------------
// Push wording
// ---------------------------------------------------------------------------------------------

export type PushText = { title: string; body: string };

const NEW_TITLES: Record<string, string> = { booking: "New booking", invite: "New invite", own: "New event" };

export function newEventPush(r: Row, nowMs: number): PushText {
  return { title: NEW_TITLES[r.kind] ?? "New event", body: `${labelFor(r)}, ${whenLabel(ms(r.start_at), nowMs)}` };
}

export function cancelPush(r: Stored, nowMs: number): PushText {
  const when = ms(r.announced_start ?? r.start_at);
  return {
    title: r.kind === "booking" ? "Booking cancelled" : "Event cancelled",
    body: `${labelFor(r)}, ${Number.isFinite(when) ? whenLabel(when, nowMs) : "date unknown"}`,
  };
}

export function movedPush(r: Row, was: Stored, nowMs: number): PushText {
  const before = ms(was.announced_start ?? was.start_at);
  return {
    title: r.kind === "booking" ? "Booking moved" : "Event moved",
    body: `${labelFor(r)}, now ${whenLabel(ms(r.start_at), nowMs)}` +
      (Number.isFinite(before) ? ` (was ${whenLabel(before, nowMs)})` : ""),
  };
}

// The second line of a starting-soon push: how to reach the meeting.
export function whereLine(r: { location: string | null; meeting: string | null }): string {
  const loc = clean(r.location ?? "", 80);
  if (loc && looksLikePhone(loc)) return `Call ${loc}`;
  if (loc) return `At ${loc}`;
  if (r.meeting) return `On ${r.meeting}`;
  return "";
}

export function soonPush(r: Stored | Row, nowMs: number): PushText {
  const start = ms(r.start_at);
  const mins = Math.max(0, Math.round((start - nowMs) / 60_000));
  const where = whereLine(r);
  return {
    title: mins <= 0 ? "Starting now" : `Starting in ${mins} min`,
    body: `${timeLabel(start)} ${labelFor(r)}` + (where ? `\n${where}` : ""),
  };
}

export function failPush(lastOkAt: string | null | undefined, nowMs: number): PushText {
  const ok = ms(lastOkAt);
  return {
    title: "Calendar alerts can't reach Google",
    body: (Number.isFinite(ok) ? `Last good check ${whenLabel(ok, nowMs)}. ` : "") +
      "The error is on the Calendar tab of Settings in the CRM.",
  };
}

// ---------------------------------------------------------------------------------------------
// Morning schedule
// ---------------------------------------------------------------------------------------------

// The first clear time in a free-text field ("Show 1 at 11:15 AM, Show 2 at 12:35 PM" -> 11:15 AM).
// Same rules as parseTime in crm-calendar.mjs: only a token with am/pm or an HH:MM colon counts.
export function firstTime(raw: string): string | null {
  const s = String(raw ?? "").toLowerCase();
  if (!s.trim() || /^\s*(tbd|to be determined|unknown|n\/?a|none)\b/.test(s)) return null;
  let h = -1;
  let m = 0;
  const ap = s.match(/(\d{1,2})(?::([0-5]\d))?\s*([ap])\.?\s?m\.?/);
  if (ap) {
    h = Number(ap[1]);
    m = ap[2] ? Number(ap[2]) : 0;
    if (ap[3] === "p" && h < 12) h += 12;
    else if (ap[3] === "a" && h === 12) h = 0;
  } else {
    const hm = s.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
    if (!hm) return null;
    h = Number(hm[1]);
    m = Number(hm[2]);
  }
  if (h < 0 || h > 23 || m > 59) return null;
  return `${h % 12 === 0 ? 12 : h % 12}:${pad(m)} ${h < 12 ? "AM" : "PM"}`;
}

// A booked CRM gig is a busy block from Leave home to Back home, so its start IS the time he
// leaves: "3:30 PM Leave for Anna Leonard, show 5:00 PM".
export function leaveForText(e: GEvent): string {
  const name = clean(String(e.summary ?? "").replace(/\s+·\s+[^·]*$/, "")) || "the gig";
  const showLine = String(e.description ?? "").split("\n").find((l) => /^show start:/i.test(l.trim()));
  const show = showLine ? firstTime(showLine.replace(/^\s*show start:/i, "")) : null;
  return `Leave for ${name}${show ? `, show ${show}` : ""}`;
}

export type DigestSource = { calendarId: string; isWork: boolean; events: GEvent[] };
export type Digest = { body: string; lines: string[]; count: number };

const MAX_TIMED_LINES = 12;

export function buildDigest(sources: DigestSource[], dayStartMs: number, dayEndMs: number): Digest {
  const allDay: string[] = [];
  const timed: Array<{ at: number; text: string }> = [];
  const seen = new Set<string>();
  for (const src of sources) {
    for (const e of src.events) {
      if (e.status === "cancelled") continue;
      if (selfResponse(e) === "declined") continue;
      if (e.eventType === "workingLocation" || e.eventType === "focusTime") continue;
      const crm = isCrm(e);
      // An unbooked gig is all-day, free and prefixed "Inquiry:". It may never happen.
      if (crm && /^\s*inquiry:/i.test(String(e.summary ?? ""))) continue;
      const key = e.iCalUID || e.id;
      if (seen.has(key)) continue; // the same meeting on two calendars
      seen.add(key);
      if (e.start?.date && !e.start?.dateTime) {
        const label = clean(e.summary) || "(no title)";
        if (!allDay.includes(label)) allDay.push(label);
        continue;
      }
      const at = Date.parse(String(e.start?.dateTime ?? ""));
      if (!Number.isFinite(at) || at < dayStartMs || at >= dayEndMs) continue; // started yesterday
      let text: string;
      if (crm && !src.isWork) text = leaveForText(e); // a booked gig on the Gigs calendar
      else if (crm) text = clean(e.summary) || "Task"; // a timed CRM task on Work
      else text = labelFor({ kind: classify(e), title: String(e.summary ?? ""), guests: guestsOf(e) });
      timed.push({ at, text: `${timeLabel(at)} ${text}` });
    }
  }
  timed.sort((a, b) => a.at - b.at);
  const lines: string[] = [];
  if (allDay.length) lines.push(clean(`All day: ${allDay.join(", ")}`, 160));
  for (const t of timed.slice(0, MAX_TIMED_LINES)) lines.push(t.text);
  if (timed.length > MAX_TIMED_LINES) lines.push(`+${timed.length - MAX_TIMED_LINES} more`);
  return {
    body: lines.length ? lines.join("\n") : "Nothing on your calendar today.",
    lines,
    count: allDay.length + timed.length,
  };
}
