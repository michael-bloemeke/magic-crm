// RETIRED 2026-11-11. Do not restore.
//
// This script used to copy the phone app into the Website repo (Website/crm/), which served it to
// any browser at michaelbloemeke.com/crm/. Michael had that web copy removed on 2026-11-11: "I don't
// want my app to be live for anyone to see, even if it does require a password." The folder was
// deleted from the Website repo (commit 26edb7c) and the address now returns "not found".
//
// THE PHONE APP NOW SHIPS ONE WAY ONLY: the native iPhone app, through TestFlight.
//
//   cd ~/Desktop/Claude/magic-crm/ios-app && ./testflight.sh
//
// That build carries its own copy of these files (ios-app/build-www.mjs), so nothing needs a website.
//
// ⚠️ Do NOT recreate Website/crm/, and do not publish these files anywhere public, unless Michael asks
// for it in so many words. The old copying code is in this file's git history if he ever does.
console.error(
  '\n  The web copy of the phone app was removed on 2026-11-11, at Michael\'s request.\n' +
  '  Nothing was copied. To update the phone, build the iPhone app instead:\n\n' +
  '    cd ~/Desktop/Claude/magic-crm/ios-app && ./testflight.sh\n',
)
process.exit(1)
