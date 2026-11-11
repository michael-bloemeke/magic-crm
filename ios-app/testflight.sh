#!/bin/zsh
# Build the phone app and upload it to TestFlight. Michael's phone updates over the air; no cable.
# Set up 2026-10-22. App Store Connect app: "Bloom CRM MB" (com.michaelbloemeke.crm, team YN4TUA399A).
# The build number is the timestamp, so every upload is newer than the last. Builds expire after 90
# days in TestFlight; any new upload resets that. THIS IS THE ONLY WAY THE PHONE APP SHIPS since
# 2026-11-11, when the web copy at michaelbloemeke.com/crm/ was removed at Michael's request.
set -e
# Without pipefail a failed xcodebuild is hidden by the grep after it, and the script printed "Uploaded
# build" after an upload that never happened (2026-10-24, Xcode signed out of the Apple account).
set -o pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.local/node22/bin:$PATH"
node build-www.mjs
npx cap sync ios
B=$(date +%Y%m%d%H%M)
rm -rf build/BloomCRM.xcarchive build/export
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release \
  -destination 'generic/platform=iOS' -archivePath build/BloomCRM.xcarchive \
  -allowProvisioningUpdates CURRENT_PROJECT_VERSION=$B archive | grep -E "ARCHIVE (SUCCEEDED|FAILED)|error:"
xcodebuild -exportArchive -archivePath build/BloomCRM.xcarchive -exportOptionsPlist ExportOptions.plist \
  -exportPath build/export -allowProvisioningUpdates | grep -E "Upload succeeded|EXPORT (SUCCEEDED|FAILED)|error"
echo "Uploaded build $B. It shows up in TestFlight after Apple finishes processing (usually 5 to 30 minutes)."
# There is no web copy of the phone app to fall back on (removed 2026-11-11), so an expired build means
# no phone app. This keeps one "Rebuild the phone app" task 60 days after the newest build.
node rebuild-reminder.mjs || echo "Note: the 'Rebuild the phone app' task could not be updated. The upload itself succeeded."
