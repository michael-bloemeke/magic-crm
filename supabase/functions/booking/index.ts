// Booking-form endpoint (always-on).
//
// The booking form lives on michaelbloemeke.com (Cloudflare Pages) and posts here. This function
// writes the client's answers straight into the `booking_submissions` table, which is the same
// database the CRM already reads. That means no relay, no polling a third party, and nothing that
// depends on Michael's Mac being awake.
//
// This replaces the old path (form on Vercel -> Vercel function -> Vercel Blob -> CRM polls the
// blob). That chain broke the moment the Blob store was suspended; this one has no such link.
//
// Security shape, deliberately narrow:
//   - The token in the URL is the ONLY credential. It is unguessable and issued per project.
//   - A token that doesn't match a known project is rejected, so this can't be used to create rows.
//   - GET is supported for one thing only: telling the page whether this token has already been
//     submitted, so it can show "thank you" instead of a second blank form. It never returns the
//     answers themselves.
//   - CORS is open because the form is on a different origin (the website) than Supabase.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, apikey, authorization",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

// Tokens are base64url and fixed-length-ish. Reject anything else before it reaches the database.
const validToken = (t: string) => !!t && t.length <= 100 && !/[^A-Za-z0-9_-]/.test(t);

const db = () =>
  createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const url = new URL(req.url);
  const sb = db();

  // --- Has this token already been used? (the page's one-time gate) ---
  if (req.method === "GET") {
    const token = (url.searchParams.get("token") || "").trim();
    if (!validToken(token)) return json({ error: "Invalid link." }, 400);
    const { data, error } = await sb
      .from("booking_submissions")
      .select("project_id")
      .eq("token", token)
      .maybeSingle();
    if (error) return json({ error: "Lookup failed." }, 500);
    return json({ submitted: !!data });
  }

  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Bad request." }, 400);
  }

  // Honeypot: bots fill hidden fields. Pretend success so they don't retry.
  if (body?._hp) return json({ ok: true });

  const token = String(body?.token || "").trim();
  if (!validToken(token)) return json({ error: "Invalid link." }, 400);

  // Cap counts and lengths so a malicious post can't write an enormous row.
  const answers = Array.isArray(body?.answers)
    ? (body.answers as unknown[]).slice(0, 50).map((a) => {
      const o = a as Record<string, unknown>;
      return {
        id: String(o?.id ?? "").slice(0, 100),
        value: String(o?.value ?? "").slice(0, 5000),
      };
    }).filter((a) => a.id)
    : [];
  if (!answers.length) return json({ error: "Nothing was filled in." }, 400);

  // The token must belong to a real project. The CRM stamps the token onto the project when it
  // issues the link, which is what makes this safe to expose: an unknown token writes nothing.
  const { data: project, error: lookupErr } = await sb
    .from("projects")
    .select("id")
    .eq("booking_token", token)
    .maybeSingle();
  if (lookupErr) return json({ error: "Lookup failed." }, 500);
  if (!project) return json({ error: "This link is no longer valid." }, 404);

  const { error: writeErr } = await sb.from("booking_submissions").upsert(
    {
      project_id: project.id,
      token,
      answers,
      submitted_at: new Date().toISOString(),
      seen: false,
    },
    { onConflict: "project_id" },
  );
  if (writeErr) return json({ error: "Could not save your answers." }, 500);

  return json({ ok: true });
});
