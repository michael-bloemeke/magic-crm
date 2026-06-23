#!/bin/bash
# Double-click to open the Magic CRM as a native Mac app window (with the M dock icon + badge).
# It starts the local app server if needed and shows it in an Electron window instead of a browser.
# You can close this Terminal window once the app window appears.

cd "$(dirname "$0")" || exit 1
export PATH="$HOME/.local/node22/bin:$PATH"

# First run only: install the Electron app dependency if it's missing.
if [ ! -d "node_modules/electron" ]; then
  echo "First-time setup: installing the app wrapper (one-time, ~1-2 min)..."
  npm install
fi

echo "Opening the Magic CRM app..."
npm run app
