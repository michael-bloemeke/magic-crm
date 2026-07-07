// Public Supabase config for the Magic CRM phone app.
//
// These two values are SAFE to embed in client code. The publishable key is not a secret: it only
// works together with a logged-in user session, and every table is protected by row-level security
// (RLS) so the anon/publishable key on its own reads nothing. NEVER put the SECRET key here (that one
// bypasses RLS and lives only on the desktop / server side).
export const SUPABASE_URL = 'https://yfmacqvcmkogvkcxfjkr.supabase.co'
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_QxnnWa1SGJrCaS2XEQY3wA_Klw0HlHF'

// Web-push VAPID PUBLIC key (safe to embed; a public key by design). Used to subscribe this device to
// lock-screen notifications. Value taken from the desktop's push-vapid.json publicKey. This is the key
// the phone subscribes with; the Mac signs each push with the matching PRIVATE key. Do NOT rotate it
// without re-subscribing every device (existing subs would break). If ever rotated, update it here.
export const VAPID_PUBLIC_KEY = 'BJ-kKbuNb4748FiB5n4x2Y9f2B89QuyRMvxFt66iovJOG2xO1ADGCNA3srgky4UbZiISFrpquq5ae6AjWB86eoI'

// PUSH (2026-07-07): web-push SUBSCRIBE from the app is now Supabase-backed and login-authenticated.
// Tapping the bell requests Notification permission, subscribes via pushManager with VAPID_PUBLIC_KEY,
// and UPSERTs the subscription into the `push_subscriptions` table using the logged-in supabase-js
// session (RLS-gated; the anon key alone can't write). The old passcode-gated /api/subscribe is no
// longer used. The Mac reads push_subscriptions (crm-webpush.mjs) to deliver lock-screen push, so this
// replaces the separate ntfy path.
