// Live website analytics endpoint for the CRM "Website" page (Live Feed tab).
//
// Pulls REAL data from Google, server-side, using a service-account credential that lives ONLY as
// the Supabase secret GOOGLE_SA_KEY (the whole downloaded SA JSON, pasted in as one secret). It:
//   1. Signs a short-lived RS256 JWT with the SA private key and exchanges it at Google's token
//      endpoint for an access token (scopes: analytics.readonly + webmasters.readonly).
//   2. GA4 Data API (property GA4_PROPERTY_ID): a realtime report ("right now") + a batch of
//      last-7/28-day reports (visitors, sources, locations, devices, top pages).
//   3. Search Console API (site GSC_SITE_URL): top search queries (with the ~2-3 day data lag).
//   4. Counts recent website form submissions from the `inquiries` table for the conversions panel.
// It returns ONE JSON blob shaped to the CRM's Live Feed panels.
//
// Public endpoint (verify_jwt=false), matching the sibling `inquiry` function: the CRM calls it
// without a user session. It only ever RETURNS aggregate, anonymized analytics (no PII), and reads
// nothing the caller supplies. Per-section failures are isolated so one bad call never blanks the
// whole dashboard.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

const PROPERTY_ID = Deno.env.get("GA4_PROPERTY_ID") || "544954858";
const SITE_URL = Deno.env.get("GSC_SITE_URL") || "sc-domain:michaelbloemeke.com";
const GA_SCOPES = [
  "https://www.googleapis.com/auth/analytics.readonly",
  "https://www.googleapis.com/auth/webmasters.readonly",
].join(" ");

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

/* ---------------------------- Service-account auth ---------------------------- */

// base64url without padding, from raw bytes.
function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlStr(s: string): string {
  return b64url(new TextEncoder().encode(s));
}

// PEM (PKCS#8) -> ArrayBuffer of DER bytes.
function pemToDer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

// Cache the access token across invocations within a warm isolate.
let tokenCache: { token: string; exp: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (tokenCache && tokenCache.exp - 60 > Date.now() / 1000) return tokenCache.token;

  const raw = Deno.env.get("GOOGLE_SA_KEY");
  if (!raw) throw new Error("GOOGLE_SA_KEY secret is not set");
  let sa: { client_email?: string; private_key?: string };
  try {
    sa = JSON.parse(raw);
  } catch {
    throw new Error("GOOGLE_SA_KEY is not valid JSON (paste the whole downloaded key file)");
  }
  if (!sa.client_email || !sa.private_key) {
    throw new Error("GOOGLE_SA_KEY is missing client_email / private_key");
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: sa.client_email,
    scope: GA_SCOPES,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${b64urlStr(JSON.stringify(header))}.${b64urlStr(JSON.stringify(claims))}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)),
  );
  const assertion = `${unsigned}.${b64url(sig)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`token exchange failed: ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
  }
  tokenCache = { token: data.access_token, exp: now + (data.expires_in || 3600) };
  return data.access_token;
}

/* ------------------------------- GA4 helpers -------------------------------- */

type Report = { rows?: Array<{ dimensionValues?: { value: string }[]; metricValues?: { value: string }[] }> };

const num = (v: string | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// Map a GA4 report into [{dims:[...], metrics:[...]}] rows for easy consumption.
function rowsOf(r: Report | undefined): { d: string[]; m: number[] }[] {
  return (r?.rows ?? []).map((row) => ({
    d: (row.dimensionValues ?? []).map((x) => x.value),
    m: (row.metricValues ?? []).map((x) => num(x.value)),
  }));
}

async function batchRunReports(token: string, requests: unknown[]): Promise<Report[]> {
  const res = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${PROPERTY_ID}:batchRunReports`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requests }),
    },
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`GA4 batch failed: ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
  return (data.reports ?? []) as Report[];
}

async function runRealtime(token: string, body: unknown): Promise<Report> {
  const res = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${PROPERTY_ID}:runRealtimeReport`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`GA4 realtime failed: ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
  return data as Report;
}

// Report request builders (relative dates: "NdaysAgo".."today").
const D7 = [{ startDate: "6daysAgo", endDate: "today" }];
const D28 = [{ startDate: "27daysAgo", endDate: "today" }];
const metric = (name: string) => ({ name });
const dim = (name: string) => ({ name });
const byMetricDesc = (name: string) => [{ metric: { metricName: name }, desc: true }];

/* ------------------------------ Section builders ---------------------------- */

const SUMMARY_METRICS = ["totalUsers", "sessions", "newUsers", "averageSessionDuration", "screenPageViews"];

function summaryRow(r: Report | undefined) {
  const m = rowsOf(r)[0]?.m ?? [];
  return {
    users: m[0] ?? 0,
    sessions: m[1] ?? 0,
    newUsers: m[2] ?? 0,
    avgSessionDuration: Math.round(m[3] ?? 0), // seconds
    pageViews: m[4] ?? 0,
  };
}

// Search Console needs explicit YYYY-MM-DD dates (no relative strings).
function ymd(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 86400000);
  return d.toISOString().slice(0, 10);
}

async function searchConsole(token: string) {
  const res = await fetch(
    `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(SITE_URL)}/searchAnalytics/query`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        startDate: ymd(30),
        endDate: ymd(3), // ~2-3 day reporting lag
        dimensions: ["query"],
        rowLimit: 20,
      }),
    },
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`Search Console failed: ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
  const rows = (data.rows ?? []) as Array<{ keys: string[]; clicks: number; impressions: number; ctr: number; position: number }>;
  let clicks = 0, impressions = 0;
  for (const r of rows) { clicks += r.clicks || 0; impressions += r.impressions || 0; }
  return {
    startDate: ymd(30),
    endDate: ymd(3),
    totals: {
      clicks,
      impressions,
      ctr: impressions ? clicks / impressions : 0,
      queries: rows.length,
    },
    queries: rows.map((r) => ({
      query: r.keys?.[0] ?? "",
      clicks: r.clicks || 0,
      impressions: r.impressions || 0,
      ctr: r.ctr || 0,
      position: r.position || 0,
    })),
  };
}

// Website form submissions (leads) from the inquiries table, bucketed by age.
// deno-lint-ignore no-explicit-any
async function leadCounts(sb: any) {
  const { data, error } = await sb.from("inquiries").select("data");
  if (error) throw new Error(`inquiries read failed: ${error.message}`);
  const now = Date.now();
  let last7 = 0, last28 = 0;
  for (const row of data ?? []) {
    const at = row?.data?.submittedAt;
    if (!at) continue;
    const t = Date.parse(at);
    if (!Number.isFinite(t)) continue;
    const ageDays = (now - t) / 86400000;
    if (ageDays <= 7) last7++;
    if (ageDays <= 28) last28++;
  }
  return { last7, last28 };
}

/* ---------------------------------- Server ---------------------------------- */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const out: Record<string, unknown> = { ok: true, generatedAt: new Date().toISOString(), property: PROPERTY_ID };
  const errors: string[] = [];

  let token: string;
  try {
    token = await getAccessToken();
  } catch (e) {
    // No credential yet (Michael hasn't set GOOGLE_SA_KEY) -> a clean "not connected" signal.
    return json({
      ok: false,
      connected: false,
      error: e instanceof Error ? e.message : String(e),
      generatedAt: new Date().toISOString(),
    });
  }
  out.connected = true;

  // --- Realtime ("right now"): total + by city + by page. Best-effort. ---
  try {
    const [total, cities, pages] = await Promise.all([
      runRealtime(token, { metrics: [metric("activeUsers")] }),
      runRealtime(token, { dimensions: [dim("city")], metrics: [metric("activeUsers")], limit: 10 }),
      runRealtime(token, { dimensions: [dim("unifiedScreenName")], metrics: [metric("activeUsers")], limit: 10 }),
    ]);
    out.realtime = {
      activeUsers: rowsOf(total)[0]?.m[0] ?? 0,
      byCity: rowsOf(cities).map((r) => ({ city: r.d[0] || "(unknown)", users: r.m[0] })),
      byPage: rowsOf(pages).map((r) => ({ page: r.d[0] || "(unknown)", users: r.m[0] })),
    };
  } catch (e) {
    out.realtime = null;
    errors.push(`realtime: ${e instanceof Error ? e.message : String(e)}`);
  }

  // --- Batched reports (visitors / sources / locations / devices / pages). ---
  try {
    const batchA = await batchRunReports(token, [
      { dateRanges: D7, metrics: SUMMARY_METRICS.map(metric) },
      { dateRanges: D28, metrics: SUMMARY_METRICS.map(metric) },
      { dateRanges: D28, dimensions: [dim("date")], metrics: [metric("totalUsers")], orderBys: [{ dimension: { dimensionName: "date" } }] },
      { dateRanges: D28, dimensions: [dim("sessionDefaultChannelGroup")], metrics: [metric("sessions"), metric("totalUsers")], orderBys: byMetricDesc("sessions"), limit: 10 },
      { dateRanges: D28, dimensions: [dim("sessionSource")], metrics: [metric("sessions"), metric("totalUsers")], orderBys: byMetricDesc("sessions"), limit: 10 },
    ]);
    const [sum7, sum28, trend, channels, sources] = batchA;

    out.visitors = {
      last7: summaryRow(sum7),
      last28: summaryRow(sum28),
      trend: rowsOf(trend).map((r) => ({ date: r.d[0], users: r.m[0] })),
    };
    out.sources = {
      channels: rowsOf(channels).map((r) => ({ channel: r.d[0] || "(other)", sessions: r.m[0], users: r.m[1] })),
      top: rowsOf(sources).map((r) => ({ source: r.d[0] || "(direct)", sessions: r.m[0], users: r.m[1] })),
    };
  } catch (e) {
    out.visitors = null;
    out.sources = null;
    errors.push(`reports-a: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    const batchB = await batchRunReports(token, [
      { dateRanges: D28, dimensions: [dim("country"), dim("region"), dim("city")], metrics: [metric("totalUsers")], orderBys: byMetricDesc("totalUsers"), limit: 25 },
      { dateRanges: D28, dimensions: [dim("deviceCategory")], metrics: [metric("totalUsers")], orderBys: byMetricDesc("totalUsers") },
      { dateRanges: D28, dimensions: [dim("browser")], metrics: [metric("totalUsers")], orderBys: byMetricDesc("totalUsers"), limit: 8 },
      { dateRanges: D28, dimensions: [dim("operatingSystem")], metrics: [metric("totalUsers")], orderBys: byMetricDesc("totalUsers"), limit: 8 },
      { dateRanges: D28, dimensions: [dim("pagePath")], metrics: [metric("screenPageViews"), metric("averageSessionDuration")], orderBys: byMetricDesc("screenPageViews"), limit: 12 },
    ]);
    const [loc, devices, browsers, os, pages] = batchB;

    // Location: cities come straight from the rows; countries are aggregated from them.
    const locRows = rowsOf(loc);
    const countryTotals = new Map<string, number>();
    for (const r of locRows) countryTotals.set(r.d[0] || "(unknown)", (countryTotals.get(r.d[0] || "(unknown)") ?? 0) + r.m[0]);
    out.locations = {
      countries: [...countryTotals.entries()].sort((a, b) => b[1] - a[1]).map(([country, users]) => ({ country, users })),
      cities: locRows.map((r) => ({ city: r.d[2] || "(unknown)", region: r.d[1] || "", country: r.d[0] || "", users: r.m[0] })),
    };
    out.devices = {
      categories: rowsOf(devices).map((r) => ({ device: r.d[0] || "(unknown)", users: r.m[0] })),
      browsers: rowsOf(browsers).map((r) => ({ browser: r.d[0] || "(unknown)", users: r.m[0] })),
      os: rowsOf(os).map((r) => ({ os: r.d[0] || "(unknown)", users: r.m[0] })),
    };
    out.pages = rowsOf(pages).map((r) => ({ path: r.d[0], views: r.m[0], avgTime: Math.round(r.m[1] ?? 0) }));
  } catch (e) {
    out.locations = null;
    out.devices = null;
    out.pages = null;
    errors.push(`reports-b: ${e instanceof Error ? e.message : String(e)}`);
  }

  // --- Search Console (top queries). Best-effort; has a 2-3 day lag. ---
  try {
    out.search = await searchConsole(token);
  } catch (e) {
    out.search = null;
    errors.push(`search: ${e instanceof Error ? e.message : String(e)}`);
  }

  // --- Conversions & leads (website form submissions from the CRM). ---
  try {
    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const leads = await leadCounts(sb);
    // deno-lint-ignore no-explicit-any
    const v = out.visitors as any;
    const users7 = v?.last7?.users ?? 0;
    const users28 = v?.last28?.users ?? 0;
    out.conversions = {
      leads7: leads.last7,
      leads28: leads.last28,
      rate7: users7 ? leads.last7 / users7 : null,
      rate28: users28 ? leads.last28 / users28 : null,
    };
  } catch (e) {
    out.conversions = null;
    errors.push(`conversions: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (errors.length) out.errors = errors;
  return json(out);
});
