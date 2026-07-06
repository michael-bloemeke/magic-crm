// Public Supabase config for the Magic CRM phone app.
//
// These two values are SAFE to embed in client code. The publishable key is not a secret: it only
// works together with a logged-in user session, and every table is protected by row-level security
// (RLS) so the anon/publishable key on its own reads nothing. NEVER put the SECRET key here (that one
// bypasses RLS and lives only on the desktop / server side).
export const SUPABASE_URL = 'https://yfmacqvcmkogvkcxfjkr.supabase.co'
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_QxnnWa1SGJrCaS2XEQY3wA_Klw0HlHF'

// Web-push VAPID PUBLIC key (safe to embed; a public key by design). Used to subscribe this device to
// lock-screen notifications. The snapshot used to carry this; now it's a constant. Value taken from
// the desktop's push-vapid.json publicKey. If the key is ever rotated, update it here.
export const VAPID_PUBLIC_KEY = 'BJ-kKbuNb4748FiB5n4x2Y9f2B89QuyRMvxFt66iovJOG2xO1ADGCNA3srgky4UbZiISFrpquq5ae6AjWB86eoI'

// The web-push /api/subscribe function is still passcode-gated (it authorizes against the snapshot
// blob, which is unrelated to Supabase auth). This is the same passcode the desktop uploads; it only
// authorizes registering a push subscription, nothing else. Leave '' to keep the "Enable push" button
// hidden until the deploy wires it up.
export const PUSH_SUBSCRIBE_CODE = ''
