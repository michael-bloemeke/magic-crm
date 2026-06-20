#!/bin/bash
# Double-click this file to open the Magic CRM.
# It starts the local app server (if it isn't already running) and opens it in your browser.
# Keep the Terminal window that appears open while you're using the app.
# To stop the app: close that Terminal window, or press Control-C in it.

cd "$(dirname "$0")" || exit 1

# Use the newer Node (Vite needs it; the system one is too old).
export PATH="$HOME/.local/node22/bin:$PATH"

PORT=5199
URL="http://localhost:$PORT"

# If a WORKING server is already up (the data API returns 200), just open it.
# We check /api/projects, not just "/", so a stale/broken process that answers
# with errors doesn't fool us into opening a dead page.
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$URL/api/projects" 2>/dev/null)
if [ "$CODE" = "200" ]; then
  echo "Magic CRM is already running. Opening it in your browser..."
  open "$URL"
  exit 0
fi

# Something may be stuck on the port (e.g. a leftover server from before a
# restart or a folder move). Clear it so we can start cleanly.
STALE=$(lsof -ti tcp:"$PORT" 2>/dev/null)
if [ -n "$STALE" ]; then
  echo "Clearing a stuck server on port $PORT..."
  kill -9 $STALE 2>/dev/null
  sleep 1
fi

echo "Starting the Magic CRM..."
echo "Your browser will open automatically in a moment."
echo "Leave this window open while you use the app. Close it (or press Control-C) to stop."
echo ""

npm run dev -- --port "$PORT" --strictPort --open
