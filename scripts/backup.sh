#!/bin/bash
# Backs up the Magic CRM code repo and the business data repo to GitHub. Commits
# anything new (the data changes constantly), then pushes over SSH. Safe to run
# anytime: it does nothing when there's nothing to commit or push.
#
# Run automatically by the app while it's running (see crm-data-plugin.mjs), and
# on demand via "Backup to GitHub.command".
set -u

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

repos=(
  "$HOME/Desktop/Claude/magic-crm"
  "$HOME/Desktop/Claude/The Award-Winning Magic of Michael Bloemeke"
)

for repo in "${repos[@]}"; do
  name="$(basename "$repo")"
  if [ ! -d "$repo/.git" ]; then
    log "skip (not a git repo): $name"
    continue
  fi
  git -C "$repo" add -A
  if ! git -C "$repo" diff --cached --quiet; then
    git -C "$repo" commit -q -m "Auto-backup $(date '+%Y-%m-%d %H:%M')" && log "committed changes: $name"
  fi
  if git -C "$repo" push -q; then
    log "pushed: $name"
  else
    log "PUSH FAILED: $name"
  fi
done
