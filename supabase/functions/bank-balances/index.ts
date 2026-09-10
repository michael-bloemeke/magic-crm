// Read-only bank balances for the CRM Finance page.
//
// WHAT THIS IS. Michael wanted one thing and only one thing: a number on the Finance page saying how
// much money is sitting in each of his Coastal Federal Credit Union buckets. No transactions, no
// spending history, no transfers, no deposits. This function does exactly that and nothing else.
//
// WHY IT GOES THROUGH YNAB RATHER THAN THE BANK. Coastal publishes no consumer API. The bank is
// reachable only through an aggregator, and Michael already has one: YNAB, which links Coastal via
// Plaid. So the chain is Coastal -> Plaid -> YNAB -> this function -> the CRM. Building a second,
// direct Plaid integration would mean applying for Plaid production access as a business and paying
// for it, to duplicate a connection that already exists.
//
// WHY IT IS AN EDGE FUNCTION AND NOT A FETCH IN THE APP. The CRM front end is a React bundle in a
// browser, so any token in it is readable by anyone who opens dev tools. The YNAB personal access
// token lives ONLY as the Supabase secret YNAB_TOKEN. This function reads it, calls YNAB, and hands
// the CRM three numbers. The token never reaches the browser and never reaches the repo.
//
// WHAT THE TOKEN CAN DO, honestly. A YNAB personal access token is not read-only at the API level:
// YNAB's own API has write endpoints (it can create transactions in the YNAB budget). It CANNOT
// touch the bank. YNAB holds a read-only Plaid link to Coastal, so there is no path from this token
// to moving, withdrawing or depositing real money. The worst case for a leaked token is someone
// scribbling in the budget, and Michael can revoke it in one click from YNAB's account settings.
// This function only ever issues GETs.
//
// SET THE SECRET (Michael does this himself, and the token must never be pasted into a chat):
//   npx supabase secrets set YNAB_TOKEN=<token> --project-ref yfmacqvcmkogvkcxfjkr
// Optionally pin a budget if he ever has more than one:
//   npx supabase secrets set YNAB_BUDGET_ID=<uuid> --project-ref yfmacqvcmkogvkcxfjkr
//
// Until YNAB_TOKEN exists this returns { ok: true, connected: false }, which the Finance page
// renders as a clean "not connected yet" card rather than an error. Same contract as the sibling
// `website-analytics` function.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

const YNAB = "https://api.ynab.com/v1";

// YNAB returns money in milliunits: 1234560 is $1,234.56. Integer cents, then back to a float, so
// a half-cent of floating point error can never show up on screen as a wrong dollar figure.
const fromMilliunits = (m: number): number => Math.round((Number(m) || 0) / 10) / 100;

type YnabAccount = {
  id: string;
  name: string;
  type: string;
  on_budget: boolean;
  closed: boolean;
  deleted: boolean;
  balance: number;
  cleared_balance: number;
  uncleared_balance: number;
  last_reconciled_at: string | null;
};

async function ynabGet(path: string, token: string): Promise<any> {
  const res = await fetch(`${YNAB}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 401) throw new Error("YNAB rejected the token (401). It may have been revoked or mistyped.");
  if (res.status === 429) throw new Error("YNAB rate limit hit (429). It allows 200 requests per hour per token.");
  if (!res.ok) throw new Error(`YNAB ${path} returned ${res.status}`);
  const body = await res.json();
  return body?.data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const generatedAt = new Date().toISOString();
  const token = Deno.env.get("YNAB_TOKEN");

  // No secret set yet. This is a normal state, not a failure, and the UI has a card for it.
  if (!token) {
    return json({
      ok: true,
      connected: false,
      generatedAt,
      accounts: [],
      reason: "YNAB_TOKEN is not set. Set it as a Supabase secret to switch this on.",
    });
  }

  try {
    // Resolve the budget. YNAB accepts the literal "last-used", but an explicit id is pinned when
    // YNAB_BUDGET_ID is set so a second budget can never silently swap which accounts are shown.
    let budgetId = Deno.env.get("YNAB_BUDGET_ID") || "";
    let budgetName = "";
    if (!budgetId) {
      const data = await ynabGet("/budgets", token);
      const budgets = (data?.budgets || []) as { id: string; name: string }[];
      if (!budgets.length) {
        return json({ ok: true, connected: false, generatedAt, accounts: [], reason: "The YNAB token works but the account has no budgets." });
      }
      budgetId = budgets[0].id;
      budgetName = budgets[0].name || "";
      if (budgets.length > 1) {
        // Worth surfacing rather than guessing quietly: the CRM shows this so the wrong budget
        // cannot be displayed for months without anyone noticing.
        budgetName += ` (${budgets.length} budgets found, showing the first)`;
      }
    }

    const data = await ynabGet(`/budgets/${budgetId}/accounts`, token);
    const raw = (data?.accounts || []) as YnabAccount[];

    // Closed and deleted accounts are dropped. Everything else is returned as-is: no name matching,
    // no hardcoded list of which three buckets to show. That means when Michael adds Magic Income to
    // the Coastal link in YNAB, it appears here on its own with no code change.
    const accounts = raw
      .filter((a) => !a.deleted && !a.closed)
      .map((a) => ({
        id: a.id,
        name: a.name,
        type: a.type,
        onBudget: a.on_budget,
        // The headline figure. `cleared` is what the bank itself says; `balance` includes
        // transactions entered in YNAB that have not hit the bank yet, so the two can disagree.
        cleared: fromMilliunits(a.cleared_balance),
        balance: fromMilliunits(a.balance),
        uncleared: fromMilliunits(a.uncleared_balance),
        lastReconciledAt: a.last_reconciled_at,
      }))
      .sort((a, b) => b.cleared - a.cleared);

    return json({
      ok: true,
      connected: true,
      generatedAt,
      budgetName,
      accounts,
      total: Math.round(accounts.reduce((s, a) => s + a.cleared, 0) * 100) / 100,
    });
  } catch (e) {
    // Never throw at the UI. Return the shape it already renders, carrying the reason.
    return json({
      ok: true,
      connected: false,
      generatedAt,
      accounts: [],
      reason: String((e as Error)?.message || e),
    });
  }
});
