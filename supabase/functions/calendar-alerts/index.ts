// CALENDAR ALERTS: Michael's phone hears about his Google Calendar. Built 2026-10-16 at his request:
// "go ahead and add anything that you need to add to the CRM to make sure that the CRM notifies me".
//
// Runs every minute off pg_cron (job `calendar-alerts`), whether or not the Mac is on:
//   1. NEW EVENT. Reads what changed on the Work calendar since the last run. An event that is new
//      to us, starts in the future, was made in the last 24 hours, and is a kind he switched on
//      (default: TidyCal bookings and invites from other people) gets one push. One push per
//      recurring series.
//   2. CANCELLED OR MOVED. An event that was announced and is then cancelled or moved gets one push.
//      A move also re-arms the starting-soon push for the new time.
//   3. STARTING SOON. A set number of minutes before a timed event (default 10), one push, after a
//      fresh check with Google so a last-minute cancellation wins.
//   4. MORNING SCHEDULE. At the time he picked (default 7:00 AM, every day), one push titled "Today"
//      listing the day from the calendars he picked (default Work and Gigs).
//   5. If Google cannot be reached three runs in a row, one push a day saying so.
//
// WHICH EVENTS COUNT (logic.ts, classify):
//   TidyCal booking = new + soon + morning. Invite from someone else = all three. Something he adds
//   himself = soon + morning (new is off by default). CRM tasks and gigs ("Synced from Magic CRM")
//   = morning only, because tasks already have their own alarms. Added by Gmail = soon + morning.
//   All-day = a morning line only. Free events count unless he ticks "skip Free". Declined or
//   cancelled = nothing, except the cancellation push for one that was announced.
//
// SPOTTING A TIDYCAL BOOKING. Checked against his real test booking of 2026-10-16: TidyCal writes the
// event into Work as Michael, with the client as a guest, `source.url` set to
// https://tidycal.com/b/<id>/<booking>/confirmation and a tidycal.com "Reschedule or cancel" link in
// the description. Either marker is enough.
//
// WHAT IT NEVER DOES: write to Google Calendar (calendarList.list, events.list and events.get only),
// create tasks or projects, write bell notifications, or set a badge.
//
// TABLES. `calendar_alert_settings` is the one row Michael edits (Settings, Calendar tab, desktop
// CRM). `calendar_alert_state` and `calendar_events` are this function's bookkeeping, service-role
// only, and deliberately WITHOUT the bump_data_version trigger: they change every minute, and that
// trigger would make both apps reload every table every minute (the July egress problem).
//
// MODES (POST body): {} = normal run. {"dry": true} = do the reading and report what WOULD be sent,
// writing nothing. {"seed": true} = record everything on the calendar silently (go-live; a normal
// run also seeds itself if it never has). {"test": "digest"} = send today's schedule titled
// "Today (test)" without using up the day.
//
// AUTH: the `x-cron-secret` header must match push_config.cron_secret, like gig-leads. Deployed with
// --no-verify-jwt, also like gig-leads, so that header is the only way in.
// TIME: everything is America/New_York.
import { createClient } from "jsr:@supabase/supabase-js@2";
import * as L from "./logic.ts";
import { accessToken, getEvent, GoogleError, listCalendars, listEvents, type OAuthCfg } from "./google.ts";
import { makePusher } from "../_shared/push.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const MIN = 60_000;
const DAY = 86_400_000;
const POLL_BACK = DAY; // events that ended up to a day ago
const POLL_AHEAD = 180 * DAY; // up to 180 days ahead
const OVERLAP = 2 * MIN; // each run re-reads the two minutes before the last one
const MAX_WATERMARK_AGE = 20 * DAY; // Google refuses an updatedMin it thinks is too old
const CALENDARS_REFRESH = DAY; // calendar ids are looked up again once a day
const PRUNE_AFTER = 30 * DAY; // rows are forgotten 30 days after the event ends
const FAILS_BEFORE_ALERT = 3;

const NO_STAMPS = { announced_at: null, announced_start: null, reminded_at: null, reminded_start: null, cancel_alerted_at: null };

const iso = (ms: number) => new Date(ms).toISOString();
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);
const msOf = (s: string | null | undefined) => Date.parse(String(s ?? ""));

function chunks<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

type Sent = { type: string; title: string; body: string; pushed?: number };
type DigestResult = L.Digest & { missing: string[] };

// Today's schedule from the chosen calendars. Each list is fresh from Google, never from the table.
async function buildToday(
  token: string,
  calIds: Record<string, string>,
  workId: string,
  settings: L.Settings,
  today: string,
): Promise<DigestResult> {
  const dayStart = L.easternDayStartMs(today);
  const dayEnd = L.easternDayStartMs(L.addDaysISO(today, 1));
  const sources: L.DigestSource[] = [];
  const missing: string[] = [];
  for (const name of settings.digestCalendars) {
    const id = calIds[name];
    if (!id) {
      missing.push(name);
      continue;
    }
    const events = await listEvents(token, id, {
      timeMin: iso(dayStart),
      timeMax: iso(dayEnd),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 250,
    });
    sources.push({ calendarId: id, isWork: id === workId, events });
  }
  return { ...L.buildDigest(sources, dayStart, dayEnd), missing };
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: pc } = await sb
    .from("push_config")
    .select("cron_secret,vapid_public,vapid_private,vapid_subject,app_url")
    .eq("id", 1)
    .single();
  if (!pc?.cron_secret || (req.headers.get("x-cron-secret") ?? "") !== pc.cron_secret) {
    return json({ ok: false, error: "Forbidden" }, 403);
  }

  let opts: { dry?: boolean; seed?: boolean; test?: string } = {};
  try {
    opts = await req.json();
  } catch { /* empty body = normal run */ }
  const dry = opts?.dry === true;

  const nowMs = Date.now();
  const nowIso = iso(nowMs);
  const today = L.easternDateISO(nowMs);

  const [setRes, stateRes] = await Promise.all([
    sb.from("calendar_alert_settings").select("*").eq("id", 1).maybeSingle(),
    sb.from("calendar_alert_state").select("*").eq("id", 1).maybeSingle(),
  ]);
  if (stateRes.error) return json({ ok: false, error: `calendar_alert_state: ${stateRes.error.message}` }, 500);
  const settings = L.settingsFromRow(setRes.data);
  // deno-lint-ignore no-explicit-any
  const state: any = stateRes.data ?? {};

  const pusher = makePusher(sb, pc);
  const sent: Sent[] = [];
  const last: { alert: Sent | null } = { alert: null };
  async function deliver(type: string, t: L.PushText, key: string): Promise<void> {
    const s: Sent = { type, title: t.title, body: t.body };
    sent.push(s);
    if (dry) return;
    // No count: a calendar alert is not a task or a bell item, so it must not move the app icon.
    const r = await pusher.send({ title: t.title, body: t.body, tag: `cal-${type}-${key}`.slice(0, 80) });
    s.pushed = r.pushed;
    last.alert = s;
  }

  const report: Record<string, unknown> = {
    mode: dry ? "dry" : opts?.seed ? "seed" : opts?.test ? `test:${opts.test}` : "run",
    at: nowIso,
  };
  const statePatch: Record<string, unknown> = {};
  let failed: string | null = null;

  try {
    const { data: ec, error: ecErr } = await sb
      .from("email_config")
      .select("client_id,client_secret,refresh_token")
      .eq("id", 1)
      .single();
    if (ecErr || !ec?.refresh_token) throw new Error("Google is not connected (email_config has no refresh token).");
    const token = await accessToken(ec as OAuthCfg);

    // Calendar ids by the name he sees, looked up again once a day so a rename or a recreated
    // calendar heals itself.
    let calIds: Record<string, string> =
      state.calendar_ids && typeof state.calendar_ids === "object" ? { ...state.calendar_ids } : {};
    const resolvedAt = msOf(state.calendars_resolved_at);
    if (!calIds.Work || !Number.isFinite(resolvedAt) || nowMs - resolvedAt > CALENDARS_REFRESH || opts?.seed) {
      calIds = {};
      for (const c of await listCalendars(token)) if (!(c.name in calIds)) calIds[c.name] = c.id;
      statePatch.calendar_ids = calIds;
      statePatch.calendars_resolved_at = nowIso;
    }
    const workId = calIds.Work;
    if (!workId) throw new Error('There is no calendar named "Work" in the Google account.');

    // TEST: today's schedule as "Today (test)". Changes nothing and does not use up the day.
    if (opts?.test === "digest") {
      const d = await buildToday(token, calIds, workId, settings, today);
      report.digest = d;
      await deliver("digest-test", { title: "Today (test)", body: d.body }, today);
      return json({ ok: true, ...report, sent });
    }

    // ---- 1 + 2. What changed on Work since the last run ----
    const seeding = opts?.seed === true || !state.seeded_at;
    const params: Record<string, unknown> = {
      timeMin: iso(nowMs - POLL_BACK),
      timeMax: iso(nowMs + POLL_AHEAD),
      singleEvents: true,
      showDeleted: true,
      maxResults: 2500,
    };
    const wm = msOf(state.watermark);
    if (!seeding && Number.isFinite(wm) && nowMs - wm < MAX_WATERMARK_AGE) params.updatedMin = iso(wm - OVERLAP);
    let events: L.GEvent[];
    try {
      events = await listEvents(token, workId, params);
    } catch (e) {
      // 410 = updatedMin too old. Read the whole window instead: every step below is idempotent, so
      // a full read only costs time.
      if (e instanceof GoogleError && e.status === 410 && params.updatedMin) {
        delete params.updatedMin;
        events = await listEvents(token, workId, params);
      } else throw e;
    }
    report.polled = events.length;
    report.since = params.updatedMin ?? null;

    const live: L.Row[] = [];
    const goneIds: string[] = [];
    for (const e of events) {
      if (!e?.id) continue;
      if (e.status === "cancelled") {
        // A deleted event is only guaranteed to carry its id, so it never overwrites what we know.
        goneIds.push(e.id);
        continue;
      }
      const row = L.toRow(workId, e);
      if (row.start_at) live.push(row);
    }

    // What we already know about these events.
    const existing = new Map<string, L.Stored>();
    for (const ids of chunks([...new Set([...live.map((r) => r.event_id), ...goneIds])], 100)) {
      const { data, error } = await sb.from("calendar_events").select("*").eq("calendar_id", workId).in("event_id", ids);
      if (error) throw new Error(`calendar_events read failed: ${error.message}`);
      for (const r of (data ?? []) as L.Stored[]) existing.set(r.event_id, r);
    }

    // Decide before writing anything.
    const fresh = new Map<string, L.Row>(); // one per series: its earliest new instance
    const moves: Array<{ row: L.Row; was: L.Stored }> = [];
    const cancels: L.Stored[] = [];
    for (const row of live) {
      const was = existing.get(row.event_id);
      if (!was) {
        if (!seeding && L.announceable(row, settings, nowMs)) {
          const k = row.ical_uid || row.event_id;
          const cur = fresh.get(k);
          if (!cur || msOf(row.start_at) < msOf(cur.start_at)) fresh.set(k, row);
        }
        continue;
      }
      if (seeding || !was.announced_at || was.cancel_alerted_at) continue;
      if (row.all_day || row.self_response === "declined" || !(msOf(row.start_at) > nowMs)) continue;
      const before = msOf(was.announced_start ?? was.start_at);
      if (Number.isFinite(before) && before !== msOf(row.start_at)) moves.push({ row, was });
    }
    if (!seeding) {
      for (const id of goneIds) {
        const was = existing.get(id);
        if (!was?.announced_at || was.cancel_alerted_at) continue;
        if (!(msOf(was.announced_start ?? was.start_at) > nowMs)) continue; // a past event, nothing to say
        cancels.push(was);
      }
    }

    // A series announced on an earlier run is never announced again.
    const announcedSeries = new Set<string>();
    const uids = [...fresh.values()].map((r) => r.ical_uid).filter((u): u is string => !!u);
    for (const part of chunks(uids, 100)) {
      const { data, error } = await sb.from("calendar_events").select("ical_uid").in("ical_uid", part).not("announced_at", "is", null);
      if (error) throw new Error(`calendar_events read failed: ${error.message}`);
      for (const r of (data ?? []) as Array<{ ical_uid: string }>) announcedSeries.add(r.ical_uid);
    }

    // Record what Google says. The stamps are never in this payload, so refreshing an event can
    // never re-arm a push that already went out.
    if (!dry) {
      for (const part of chunks(live, 500)) {
        const { error } = await sb
          .from("calendar_events")
          .upsert(part.map((r) => ({ ...r, last_seen_at: nowIso })), { onConflict: "calendar_id,event_id" });
        if (error) throw new Error(`calendar_events write failed: ${error.message}`);
      }
      for (const part of chunks(goneIds.filter((id) => existing.has(id)), 100)) {
        const { error } = await sb
          .from("calendar_events")
          .update({ status: "cancelled", last_seen_at: nowIso })
          .eq("calendar_id", workId)
          .in("event_id", part);
        if (error) throw new Error(`calendar_events write failed: ${error.message}`);
      }
    }

    // GO-LIVE SEED: everything already on the calendar is recorded without a sound. Upcoming events
    // of the kinds he wants announced are marked as known, so a later cancellation or move of a
    // booking that existed before go-live still reaches him.
    if (seeding) {
      const known = new Map<string, L.Row>();
      for (const r of live) {
        if (!L.announceKindOk(r, settings, nowMs)) continue;
        const k = r.ical_uid || r.event_id;
        const cur = known.get(k);
        if (!cur || msOf(r.start_at) < msOf(cur.start_at)) known.set(k, r);
      }
      if (!dry) {
        for (const r of known.values()) {
          const { error } = await sb
            .from("calendar_events")
            .update({ announced_at: nowIso, announced_start: r.start_at })
            .eq("calendar_id", workId)
            .eq("event_id", r.event_id)
            .is("announced_at", null);
          if (error) throw new Error(`calendar_events write failed: ${error.message}`);
        }
        statePatch.seeded_at = nowIso;
      }
      report.seeded = {
        events: live.length,
        alreadyKnown: [...known.values()].map((r) => `${L.labelFor(r)}, ${L.whenLabel(msOf(r.start_at), nowMs)}`),
      };
    }

    // New events. Claimed with a conditional update, so two overlapping runs cannot both send.
    for (const row of fresh.values()) {
      if (row.ical_uid && announcedSeries.has(row.ical_uid)) continue;
      if (!dry) {
        const { data, error } = await sb
          .from("calendar_events")
          .update({ announced_at: nowIso, announced_start: row.start_at })
          .eq("calendar_id", workId)
          .eq("event_id", row.event_id)
          .is("announced_at", null)
          .select("event_id");
        if (error) throw new Error(`calendar_events claim failed: ${error.message}`);
        if (!data?.length) continue; // another run got there first
      }
      await deliver("new", L.newEventPush(row, nowMs), row.event_id);
    }

    // Cancelled, once per series.
    const cancelSeen = new Set<string>();
    for (const was of cancels) {
      const k = was.ical_uid || was.event_id;
      if (cancelSeen.has(k)) continue;
      cancelSeen.add(k);
      if (!dry) {
        const { data, error } = await sb
          .from("calendar_events")
          .update({ cancel_alerted_at: nowIso })
          .eq("calendar_id", workId)
          .eq("event_id", was.event_id)
          .is("cancel_alerted_at", null)
          .select("event_id");
        if (error) throw new Error(`calendar_events claim failed: ${error.message}`);
        if (!data?.length) continue;
      }
      await deliver("cancel", L.cancelPush(was, nowMs), was.event_id);
    }

    // Moved, once per series. Compare-and-swap on the start that was announced, and clear the
    // reminder so the starting-soon push fires again at the new time.
    const moveSeen = new Set<string>();
    for (const { row, was } of moves) {
      const k = row.ical_uid || row.event_id;
      if (moveSeen.has(k)) continue;
      moveSeen.add(k);
      if (!dry) {
        let q = sb
          .from("calendar_events")
          .update({ announced_start: row.start_at, reminded_at: null, reminded_start: null })
          .eq("calendar_id", workId)
          .eq("event_id", row.event_id);
        q = was.announced_start ? q.eq("announced_start", was.announced_start) : q.is("announced_start", null);
        const { data, error } = await q.select("event_id");
        if (error) throw new Error(`calendar_events claim failed: ${error.message}`);
        if (!data?.length) continue;
      }
      await deliver("moved", L.movedPush(row, was, nowMs), row.event_id);
    }

    report.changes = { live: live.length, gone: goneIds.length, new: fresh.size, moved: moves.length, cancelled: cancels.length };

    // ---- 3. Starting soon ----
    if (!seeding && settings.soonEnabled) {
      const { data: cands, error } = await sb
        .from("calendar_events")
        .select("*")
        .eq("calendar_id", workId)
        .neq("status", "cancelled")
        .eq("all_day", false)
        .gt("start_at", nowIso)
        .lte("start_at", iso(nowMs + settings.soonMinutes * MIN))
        .in("kind", L.SOON_KINDS);
      if (error) throw new Error(`calendar_events read failed: ${error.message}`);
      const candidates = new Map<string, L.Stored>();
      for (const c of (cands ?? []) as L.Stored[]) candidates.set(c.event_id, c);
      if (dry) {
        // A dry run wrote nothing above, so this minute's new or changed events are not in the table
        // yet. Add them here so the report matches what a real run would send.
        for (const row of live) candidates.set(row.event_id, { ...NO_STAMPS, ...existing.get(row.event_id), ...row });
      }
      const soon: string[] = [];
      for (const c of candidates.values()) {
        if (!L.soonEligible(c, settings, nowMs)) continue;
        // Ask Google once more right before speaking: a cancellation in the last minute must win.
        const liveEvent = await getEvent(token, workId, c.event_id);
        if (!liveEvent || liveEvent.status === "cancelled") {
          if (!dry) {
            await sb.from("calendar_events").update({ status: "cancelled", last_seen_at: nowIso })
              .eq("calendar_id", workId).eq("event_id", c.event_id);
          }
          continue;
        }
        const fromGoogle = L.toRow(workId, liveEvent);
        if (!dry && msOf(fromGoogle.start_at) !== msOf(c.start_at)) {
          await sb.from("calendar_events").update({ ...fromGoogle, last_seen_at: nowIso })
            .eq("calendar_id", workId).eq("event_id", c.event_id);
        }
        const merged: L.Stored = { ...c, ...fromGoogle };
        if (!L.soonEligible(merged, settings, nowMs)) continue;
        if (!dry) {
          let q = sb
            .from("calendar_events")
            .update({ reminded_at: nowIso, reminded_start: merged.start_at })
            .eq("calendar_id", workId)
            .eq("event_id", c.event_id);
          q = c.reminded_start ? q.eq("reminded_start", c.reminded_start) : q.is("reminded_start", null);
          const { data, error: claimErr } = await q.select("event_id");
          if (claimErr) throw new Error(`calendar_events claim failed: ${claimErr.message}`);
          if (!data?.length) continue;
        }
        soon.push(c.event_id);
        await deliver("soon", L.soonPush(merged, nowMs), c.event_id);
      }
      report.soon = soon.length;
    }

    // ---- 4. Morning schedule ----
    if (!seeding) {
      const due = L.digestDue(settings, state.last_digest_on, nowMs);
      if (due || dry) {
        const d = await buildToday(token, calIds, workId, settings, today);
        report.digest = { due, ...d };
        if (due) {
          let claimed = dry;
          if (!dry) {
            // Claim the day first, so a slow run and the next one cannot both send it.
            let q = sb.from("calendar_alert_state").update({ last_digest_on: today, last_digest_at: nowIso }).eq("id", 1);
            q = state.last_digest_on ? q.eq("last_digest_on", state.last_digest_on) : q.is("last_digest_on", null);
            const { data, error } = await q.select("id");
            if (error) throw new Error(`calendar_alert_state claim failed: ${error.message}`);
            claimed = !!data?.length;
          }
          if (claimed) await deliver("digest", { title: "Today", body: d.body }, today);
        }
      }
    }

    if (!dry) {
      statePatch.watermark = nowIso; // everything changed before this run began has been read
      statePatch.last_ok_at = nowIso;
      statePatch.fail_count = 0;
      statePatch.last_error = null;
    }
  } catch (e) {
    failed = errText(e);
    report.error = failed;
    console.error("[calendar-alerts]", failed);
  }

  // ---- 5. Three failures in a row: tell him, at most once a day ----
  if (failed && !dry && !opts?.test) {
    const fails = (Number(state.fail_count) || 0) + 1;
    statePatch.fail_count = fails;
    statePatch.last_error = failed;
    statePatch.last_error_at = nowIso;
    if (fails >= FAILS_BEFORE_ALERT && String(state.last_fail_alert_on ?? "") < today) {
      let q = sb.from("calendar_alert_state").update({ last_fail_alert_on: today }).eq("id", 1);
      q = state.last_fail_alert_on ? q.eq("last_fail_alert_on", state.last_fail_alert_on) : q.is("last_fail_alert_on", null);
      const { data } = await q.select("id");
      if (data?.length) await deliver("failing", L.failPush(state.last_ok_at, nowMs), today);
    }
  }

  if (!dry && !opts?.test) {
    statePatch.last_run_at = nowIso;
    statePatch.updated_at = nowIso;
    if (last.alert) {
      statePatch.last_alert_at = nowIso;
      statePatch.last_alert_text = `${last.alert.title}: ${last.alert.body.replace(/\n/g, " / ")}`.slice(0, 300);
    }
    const { error } = await sb.from("calendar_alert_state").update(statePatch).eq("id", 1);
    if (error) report.stateError = error.message;
    // Housekeeping: forget events 30 days after they end.
    const { error: pruneErr } = await sb.from("calendar_events").delete().lt("end_at", iso(nowMs - PRUNE_AFTER));
    if (pruneErr) report.pruneError = pruneErr.message;
  }

  return json({ ok: !failed, ...report, sent });
});
