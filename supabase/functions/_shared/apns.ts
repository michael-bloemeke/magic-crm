// APNs (Apple Push Notification service) sender, shared by notify-cron and inquiry.
//
// WHY THIS EXISTS. The phone app became a native iOS app on 2026-09-20 because iOS Web Push was too
// unreliable to run the business on: it only works from a Home Screen install, dies silently if the
// icon is removed and re-added, and loses permission across iOS updates. A native app talks to APNs
// instead, which is the mechanism every normal iPhone notification uses.
//
// ⚠️ THIS DOES NOT REPLACE WEB PUSH, IT SITS BESIDE IT. Both routes stay live. Device tokens live in
// the SAME `push_subscriptions` table under an `apns://<token>` endpoint, so every sender walks one
// list and branches on the scheme. That is what lets Michael keep getting alerts on the PWA while
// the native app is being proven, and it means a new notification type cannot accidentally support
// only one of the two.
//
// ⚠️ CLAUDE NEVER HANDLES THE PRIVATE KEY. `APNS_KEY_P8` is a Supabase function secret that Michael
// sets himself, exactly like GOOGLE_SA_KEY for the analytics function. Nothing here logs it.

export type ApnsPayload = { title: string; body: string; badge?: number; url?: string }

// The four things Apple needs. All are secrets/config, none are guessable from the code.
function apnsConfig() {
  const p8 = Deno.env.get("APNS_KEY_P8") ?? ""
  const keyId = Deno.env.get("APNS_KEY_ID") ?? ""
  const teamId = Deno.env.get("APNS_TEAM_ID") ?? ""
  const bundleId = Deno.env.get("APNS_BUNDLE_ID") ?? ""
  const configured = !!(p8 && keyId && teamId && bundleId)
  return { p8, keyId, teamId, bundleId, configured }
}

export function apnsConfigured(): boolean {
  return apnsConfig().configured
}

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

// A .p8 from Apple is a PEM-wrapped PKCS#8 block. Strip the armour and decode.
function pkcs8FromPem(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "")
  const raw = atob(body)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

// ⚠️ THE PROVIDER TOKEN IS CACHED ON PURPOSE. Apple rejects a provider token regenerated more than
// once every 20 minutes (TooManyProviderTokenUpdates) and expires one older than an hour. notify-cron
// runs EVERY MINUTE, so minting a fresh JWT per run would get the whole pipeline throttled off within
// the hour. Refreshed at 50 minutes, comfortably inside both limits.
let cachedJwt = { token: "", mintedAt: 0 }
const JWT_TTL_MS = 50 * 60 * 1000

async function providerToken(): Promise<string> {
  const { p8, keyId, teamId } = apnsConfig()
  if (cachedJwt.token && Date.now() - cachedJwt.mintedAt < JWT_TTL_MS) return cachedJwt.token

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8FromPem(p8),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  )
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "ES256", kid: keyId })))
  const claims = b64url(
    new TextEncoder().encode(JSON.stringify({ iss: teamId, iat: Math.floor(Date.now() / 1000) })),
  )
  const signingInput = `${header}.${claims}`
  // WebCrypto returns the raw r||s pair, which is exactly what JWS ES256 wants. No DER unwrapping.
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      new TextEncoder().encode(signingInput),
    ),
  )
  const token = `${signingInput}.${b64url(sig)}`
  cachedJwt = { token, mintedAt: Date.now() }
  return token
}

// ⚠️ SANDBOX vs PRODUCTION IS THE CLASSIC APNs TRAP. A build installed from Xcode gets a SANDBOX
// token; TestFlight and the App Store get PRODUCTION ones. The token itself looks identical, and
// sending to the wrong host returns 400 BadDeviceToken, which reads exactly like a corrupt token.
//
// Michael will be on an Xcode build first and TestFlight later, and both may be registered at once,
// so rather than making him track which is which we try production and fall back to sandbox on that
// one specific error. The winning host is remembered per token so the retry costs nothing after the
// first send.
const HOST_PROD = "https://api.push.apple.com"
const HOST_SANDBOX = "https://api.sandbox.push.apple.com"
const hostForToken = new Map<string, string>()

async function postOnce(host: string, token: string, jwt: string, body: string, bundleId: string) {
  const res = await fetch(`${host}/3/device/${token}`, {
    method: "POST",
    headers: {
      authorization: `bearer ${jwt}`,
      "apns-topic": bundleId,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json",
    },
    body,
  })
  let reason = ""
  if (!res.ok) {
    try { reason = (JSON.parse(await res.text()) as { reason?: string })?.reason ?? "" } catch { /* empty body */ }
  }
  return { status: res.status, reason }
}

/**
 * Send one payload to a list of APNs device tokens.
 * Returns how many were delivered and which tokens Apple says are dead (caller prunes them).
 * Never throws: one bad device must never take down a notification run.
 */
export async function sendApns(
  tokens: string[],
  payload: ApnsPayload,
): Promise<{ pushed: number; dead: string[] }> {
  const { bundleId, configured } = apnsConfig()
  if (!configured || !tokens.length) return { pushed: 0, dead: [] }

  let jwt: string
  try {
    jwt = await providerToken()
  } catch (e) {
    console.warn("[apns] could not mint a provider token:", e instanceof Error ? e.message : String(e))
    return { pushed: 0, dead: [] }
  }

  const body = JSON.stringify({
    aps: {
      alert: { title: payload.title, body: payload.body },
      sound: "default",
      ...(typeof payload.badge === "number" ? { badge: payload.badge } : {}),
    },
    ...(payload.url ? { url: payload.url } : {}),
  })

  const dead: string[] = []
  let pushed = 0

  await Promise.all(
    tokens.map(async (token) => {
      try {
        const first = hostForToken.get(token) ?? HOST_PROD
        let r = await postOnce(first, token, jwt, body, bundleId)

        // The sandbox/production fallback described above.
        if (r.status === 400 && r.reason === "BadDeviceToken") {
          const other = first === HOST_PROD ? HOST_SANDBOX : HOST_PROD
          r = await postOnce(other, token, jwt, body, bundleId)
          if (r.status === 200) hostForToken.set(token, other)
        } else if (r.status === 200) {
          hostForToken.set(token, first)
        }

        if (r.status === 200) {
          pushed++
          return
        }
        // 410 Unregistered means the app was deleted. 400 BadDeviceToken after BOTH hosts failed
        // means the token is genuinely not ours. Either way it will never work again, so prune it.
        if (r.status === 410 || (r.status === 400 && r.reason === "BadDeviceToken")) {
          dead.push(`apns://${token}`)
          return
        }
        console.warn(`[apns] send failed: ${r.status} ${r.reason}`)
      } catch (e) {
        // Network blips are swallowed, same as the web-push path: the next run retries.
        console.warn("[apns] send threw:", e instanceof Error ? e.message : String(e))
      }
    }),
  )

  return { pushed, dead }
}

/**
 * Split the rows of push_subscriptions into the two delivery routes.
 * An `apns://` endpoint is a native device token; anything else is a Web Push subscription.
 */
export function splitSubscriptions<T extends { endpoint: string }>(rows: T[]) {
  const apnsTokens: string[] = []
  const web: T[] = []
  for (const r of rows) {
    const ep = String(r?.endpoint ?? "")
    if (ep.startsWith("apns://")) apnsTokens.push(ep.slice("apns://".length))
    else if (ep) web.push(r)
  }
  return { apnsTokens, web }
}
