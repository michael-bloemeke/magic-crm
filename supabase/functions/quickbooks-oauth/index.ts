// Connect the CRM to Michael's REAL QuickBooks company, over HTTPS.
//
// WHY THIS EXISTS. Going to production was blocked on one thing: Intuit will not accept a
// `http://localhost:5199/...` redirect URI for a production app, and localhost was all the Mac could
// offer. This function is a permanent HTTPS redirect target, so the app can be registered properly:
//
//   https://yfmacqvcmkogvkcxfjkr.supabase.co/functions/v1/quickbooks-oauth
//
// It also means the connection is not tied to his laptop being awake, which matches where the rest
// of the booking chain already lives.
//
// THE FLOW, two hops:
//
//   1. GET ?setup=<one-time token>   -> mints a `state`, 302s to Intuit's consent screen.
//   2. GET ?code=..&state=..&realmId=..  (Intuit sends him back here)
//                                    -> verifies state, swaps the code for tokens, and writes them
//                                       into quickbooks_config with environment='production'.
//
// SECURITY, because this endpoint is public and it writes the credentials that move real money:
//   - Hop 1 needs a one-time `setup_token` that expires. Michael gets it once, out of band. Without
//     it this endpoint will not start a flow, so nobody can farm consent screens with his client id.
//   - Hop 2 checks `state` against what hop 1 stored. This is the part that stops a stranger from
//     completing a handshake and bolting THEIR QuickBooks company onto his CRM, which would send his
//     clients' invoices into someone else's books.
//   - Both are single-use: the token and the state are cleared the moment the exchange succeeds.
//   - The client secret never leaves the server, and no token is ever put in a redirect or a page.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const AUTH_BASE = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const SCOPE = "com.intuit.quickbooks.accounting";

const db = () =>
  createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false },
  });

// A plain page rather than JSON: the only two humans who ever see this are Michael finishing the
// connection and someone who guessed the URL, and both are better served by a sentence than a blob.
const page = (title: string, body: string, status = 200) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<meta name="robots" content="noindex,nofollow"><title>${title}</title>` +
      `<style>body{font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0e1017;color:#e8e9ee;` +
      `display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px}` +
      `div{max-width:32rem}h1{font-size:20px;margin:0 0 12px}p{margin:0 0 10px;color:#b9bcc7}` +
      `code{background:#1b1e29;padding:2px 6px;border-radius:4px;font-size:14px}</style>` +
      `<div><h1>${title}</h1>${body}</div>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );

// Timing-safe-ish compare. These are high-entropy random strings so a plain !== would almost
// certainly be fine, but constant time costs nothing here.
function same(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const rand = (bytes = 24) =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes))))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const sb = db();

  // This function's own address, which must match the Redirect URI registered with Intuit EXACTLY,
  // character for character. Derived from the request rather than hardcoded so it cannot drift.
  const redirectUri = `${url.origin}${url.pathname}`;

  const { data: cfg, error: cfgErr } = await sb.from("quickbooks_config").select("*").eq("id", 1).single();
  if (cfgErr || !cfg) return page("Not configured", "<p>There is no QuickBooks configuration row to work with.</p>", 500);

  // --- Hop 1: start the handshake -----------------------------------------
  const setup = (url.searchParams.get("setup") || "").trim();
  if (setup) {
    const expires = cfg.setup_expires_at ? new Date(cfg.setup_expires_at).getTime() : 0;
    if (!cfg.setup_token || !same(setup, cfg.setup_token)) {
      return page("That link is not valid", "<p>Ask for a fresh setup link.</p>", 403);
    }
    if (expires < Date.now()) {
      return page("That link has expired", "<p>Setup links are short-lived on purpose. Ask for a fresh one.</p>", 403);
    }

    const state = rand();
    await sb.from("quickbooks_config").update({ oauth_state: state }).eq("id", 1);

    const params = new URLSearchParams({
      client_id: cfg.client_id,
      response_type: "code",
      scope: SCOPE,
      redirect_uri: redirectUri,
      state,
    });
    return new Response(null, {
      status: 302,
      headers: { Location: `${AUTH_BASE}?${params.toString()}`, "Cache-Control": "no-store" },
    });
  }

  // --- Hop 2: Intuit sends him back ---------------------------------------
  const code = (url.searchParams.get("code") || "").trim();
  const state = (url.searchParams.get("state") || "").trim();
  const realmId = (url.searchParams.get("realmId") || "").trim();

  if (!code) {
    // Includes the case where Intuit reports the user declined.
    const err = url.searchParams.get("error");
    if (err) return page("Connection cancelled", `<p>QuickBooks reported: <code>${err.replace(/[<>&]/g, "")}</code></p>`, 400);
    return page("Nothing to do here", "<p>This endpoint only handles the QuickBooks connection.</p>", 400);
  }
  if (!cfg.oauth_state || !same(state, cfg.oauth_state)) {
    return page(
      "That did not come from a link we issued",
      "<p>The security check failed, so nothing was changed. Start again with a fresh setup link.</p>",
      403,
    );
  }
  if (!realmId) return page("Missing company id", "<p>QuickBooks did not say which company to connect.</p>", 400);

  // Swap the one-time code for tokens. The client secret is used here and never leaves this server.
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${cfg.client_id}:${cfg.client_secret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }).toString(),
  });
  const tok = await res.json().catch(() => null);
  if (!res.ok || !tok?.refresh_token) {
    console.error("[quickbooks-oauth] token exchange failed", res.status, JSON.stringify(tok)?.slice(0, 300));
    return page(
      "QuickBooks refused the exchange",
      `<p>Status <code>${res.status}</code>. The usual cause is the Redirect URI registered with Intuit not matching this one exactly:</p>` +
        `<p><code>${redirectUri}</code></p>`,
      502,
    );
  }

  // Land it. environment flips to production here and nowhere else, so the CRM cannot be pointed at
  // real money by accident: it takes a completed consent screen against a real company.
  const { error: saveErr } = await sb.from("quickbooks_config").update({
    realm_id: realmId,
    refresh_token: tok.refresh_token,
    access_token: tok.access_token ?? null,
    access_expires_at: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString(),
    environment: "production",
    oauth_state: null,
    setup_token: null,
    setup_expires_at: null,
    updated_at: new Date().toISOString(),
  }).eq("id", 1);
  if (saveErr) {
    console.error("[quickbooks-oauth] could not save tokens:", saveErr.message);
    return page("Connected, but not saved", "<p>QuickBooks approved it but the credentials did not store. Try again.</p>", 500);
  }

  return page(
    "QuickBooks is connected",
    `<p>Connected to company <code>${realmId.replace(/[^0-9]/g, "")}</code> in <strong>production</strong>.</p>` +
      `<p>Invoices will now be raised against your real books, and the CRM will watch them for payment. You can close this tab.</p>`,
  );
});
