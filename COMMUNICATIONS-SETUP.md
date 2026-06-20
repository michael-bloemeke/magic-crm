# Communications tab - going live

The Communications tab is built and working on DEMO data. To switch it to your
real Gmail and real Claude drafting, two one-time things are needed. Nothing
sends without you clicking Send.

## What the tab does now (demo)
- Shows sample conversations per project, filtered to that project's contact emails.
- "Draft with Claude" fills a reply (currently a built-in sample in your voice).
- "Send" / "Save to Gmail drafts" are simulated (nothing leaves the app).

Code lives in `crm-comms.mjs` (server) + `src/components/CommunicationsTab.tsx` (UI).
Flip `isGmailConnected()` / `isClaudeConnected()` in `crm-comms.mjs` once the
below is in place, and replace the demo builders with the real API calls.

## 1. Real emails + sending (Gmail API)
1. Go to console.cloud.google.com, create a free project (e.g. "Magic CRM").
2. Enable the **Gmail API** for that project.
3. Configure the **OAuth consent screen**: External, app name "Magic CRM",
   your business email as support + developer contact. Add yourself
   (michael@michaelbloemeke.com) as a **Test user** (keeps it in testing mode,
   no Google verification needed for personal use).
4. Create an **OAuth client ID** (type: Web application). Add redirect URI
   `http://localhost:5199/api/gmail/callback`. Save the Client ID + Client secret.
5. Scopes we'll request: `gmail.modify` (read threads + mark as read), `gmail.compose`
   and `gmail.send` (send / save drafts). You'll see an "unverified app" screen once;
   click through (it's your own app). Note: `gmail.modify` replaced the original
   `gmail.readonly` when mark-as-read was added (2026-06-17), so reconnect once to
   grant it.
6. Give me the Client ID + secret. I'll wire the one-time sign-in, store the
   refresh token locally, and swap the demo threads for a real Gmail search by
   each project's contacts.

## 2. Claude writes the drafts (Anthropic API)
1. Get an API key at console.anthropic.com (Settings > API Keys).
2. Give it to me (or drop it in a local `.env` in `~/Desktop/Claude/magic-crm`).
3. I'll have the server send the project record + the email thread + your
   `voice.md`, templates, and `CLAUDE.md` to Claude, so drafts come back in
   your voice. Small cost per draft (pennies).

## Guardrail
Read-first and review-always. The draft is shown to you; it only sends when you
click Send. "Save to Gmail drafts" lets you do the final review inside Gmail if
you prefer. This keeps your rule: never send to a client without your approval.
