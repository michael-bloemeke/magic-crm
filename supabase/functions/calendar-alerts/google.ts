// Google Calendar for calendar-alerts. READ-ONLY by design: calendarList.list, events.list and
// events.get, all GETs. Nothing in this file can write to his calendar.
//
// It signs in with the SAME OAuth client and refresh token as the `gmail` and `gig-leads` functions
// (the `email_config` row). That token was granted the full calendar scope when the Mac connected,
// so no re-consent was needed. No imports, so it also runs under Node for the local checks.

import type { GEvent } from "./logic.ts";

export type OAuthCfg = { client_id: string; client_secret: string; refresh_token: string };

export class GoogleError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "GoogleError";
    this.status = status;
  }
}

const TIMEOUT_MS = 15_000;

// The access token lasts an hour. Kept between runs while the function stays warm, so a run every
// minute does not need a fresh token every minute.
let cached = { token: "", expiresAt: 0 };

export async function accessToken(cfg: OAuthCfg): Promise<string> {
  if (cached.token && Date.now() < cached.expiresAt - 60_000) return cached.token;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.client_id,
      client_secret: cfg.client_secret,
      refresh_token: cfg.refresh_token,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // deno-lint-ignore no-explicit-any
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || !j?.access_token) {
    throw new GoogleError(`Google sign-in failed (${res.status}${j?.error ? `: ${j.error}` : ""})`, res.status);
  }
  cached = { token: String(j.access_token), expiresAt: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  return cached.token;
}

// deno-lint-ignore no-explicit-any
async function gget(token: string, path: string, params: Record<string, unknown> = {}): Promise<any> {
  const u = new URL(`https://www.googleapis.com/calendar/v3/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
  }
  const res = await fetch(u, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) {
    let msg = "";
    try {
      msg = (await res.json())?.error?.message ?? "";
    } catch { /* no body */ }
    throw new GoogleError(`Google Calendar ${res.status}${msg ? `: ${msg}` : ""}`, res.status);
  }
  return await res.json();
}

// Every calendar in the account, by the name Michael SEES. A calendar he renamed in his list keeps
// its real title in `summary` and the new name in `summaryOverride` (his "Gigs" calendar is really
// "Social"), so the override wins. Same rule as crm-calendar.mjs.
export async function listCalendars(token: string): Promise<Array<{ id: string; name: string; primary: boolean }>> {
  const out: Array<{ id: string; name: string; primary: boolean }> = [];
  let pageToken: string | undefined;
  do {
    const r = await gget(token, "users/me/calendarList", { maxResults: 250, pageToken });
    for (const c of r.items ?? []) {
      out.push({ id: String(c.id), name: String(c.summaryOverride || c.summary || c.id).trim(), primary: !!c.primary });
    }
    pageToken = r.nextPageToken;
  } while (pageToken);
  return out;
}

// All pages of events.list. Ten pages of 2,500 is far beyond anything on his calendars; the cap is
// only there so a bad response can never loop forever.
export async function listEvents(token: string, calendarId: string, params: Record<string, unknown>): Promise<GEvent[]> {
  const out: GEvent[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const r = await gget(token, `calendars/${encodeURIComponent(calendarId)}/events`, { ...params, pageToken });
    for (const e of r.items ?? []) out.push(e as GEvent);
    pageToken = r.nextPageToken;
    pages++;
  } while (pageToken && pages < 10);
  return out;
}

// One event, fresh. Gone (404 / 410) comes back as null rather than an error.
export async function getEvent(token: string, calendarId: string, eventId: string): Promise<GEvent | null> {
  try {
    return (await gget(token, `calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`)) as GEvent;
  } catch (e) {
    if (e instanceof GoogleError && (e.status === 404 || e.status === 410)) return null;
    throw e;
  }
}
