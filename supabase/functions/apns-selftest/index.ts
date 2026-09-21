// TEMPORARY. Proves the APNs credentials authenticate with Apple, without needing a real device.
//
// It sends to a syntactically valid but fake device token. The response tells us which half of the
// setup is right:
//   400 BadDeviceToken      -> the KEY, KEY ID and TEAM ID are all correct. Apple authenticated us
//                             and is only objecting to the made-up device. This is the PASS case.
//   403 InvalidProviderToken-> the key, key id or team id do not match. Auth failed.
//   403 ExpiredProviderToken-> clock skew or a stale cached JWT.
//
// Delete this function once push is working.
import { sendApns, apnsConfigured } from "../_shared/apns.ts";

Deno.serve(async () => {
  const json = (o: unknown, s = 200) =>
    new Response(JSON.stringify(o, null, 2), { status: s, headers: { "Content-Type": "application/json" } });

  if (!apnsConfigured()) {
    return json({ ok: false, reason: "APNs secrets are not all set", configured: false });
  }

  // 64 hex characters: the right SHAPE for a device token, but not a real device.
  const fake = "0".repeat(64);
  const r = await sendApns([fake], { title: "self test", body: "self test" });

  // sendApns swallows errors by design (one bad device must never break a run), so it reports the
  // outcome rather than throwing. A fake token landing in `dead` means Apple accepted our auth and
  // rejected only the device, which is exactly what we want to see here.
  return json({
    ok: true,
    configured: true,
    pushed: r.pushed,
    deadCount: r.dead.length,
    verdict: r.dead.length === 1
      ? "PASS - Apple authenticated the key and rejected only the fake device token"
      : "INCONCLUSIVE - check the function logs for the APNs reason string",
  });
});
