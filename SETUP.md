# Magic CRM — setup, backup & recovery

How the CRM is backed up, and exactly how to get running again on a new computer.

## The two repos (both PRIVATE on GitHub)

| Repo | Holds | Must live at |
|---|---|---|
| `magic-crm` | The app's code (this folder) + the static portal site (`portal/`) | `~/Desktop/Claude/magic-crm` |
| `The-Award-Winning-Magic-of-Michael-Bloemeke` | All business data: the CRM's JSON (`Project Records/`), plus pricing, voice, playbooks, templates, recordings | `~/Desktop/Claude/The Award-Winning Magic of Michael Bloemeke` |

URLs:
- `git@github.com:michael-bloemeke/magic-crm.git`
- `git@github.com:michael-bloemeke/The-Award-Winning-Magic-of-Michael-Bloemeke.git`

**The paths matter.** The app reads its data from the absolute path
`~/Desktop/Claude/The Award-Winning Magic of Michael Bloemeke/Project Records`. So the
data repo MUST be cloned into a folder with that exact spaced name (NOT the hyphenated
GitHub name), and the code repo into `~/Desktop/Claude/magic-crm`.

## How backup works (no thinking required)

- **Automatic:** while the CRM app is running, it commits + pushes both repos to GitHub
  on a timer (about 90 seconds after launch, then every 4 hours). Runs from the app's
  own process, which has the file access the CRM needs.
- **On demand:** double-click **`Backup to GitHub.command`** in this folder anytime
  (handy after Cowork has edited data while the app was closed).
- Both call `scripts/backup.sh`. It auto-commits any changes and pushes over SSH.
- Why not a system scheduler (launchd/cron)? macOS blocks background schedulers from
  the Desktop folder without granting broad "Full Disk Access," which we chose not to do.
  App-triggered backup avoids that entirely.

So: never lose more than the time since the app was last open. If a gig's data must be
safe immediately, hit the Backup command.

## Recover on a NEW computer

1. **Install tools:**
   - Node.js 20+ (nodejs.org)
   - GitHub Desktop (desktop.github.com) and sign in
   - Vercel CLI: `npm i -g vercel`, then `vercel login` (needed only to publish portals)
2. **Set up an SSH key for GitHub** (so backup can push headlessly):
   - `ssh-keygen -t ed25519 -C "magic-crm-backup" -f ~/.ssh/id_ed25519 -N ""`
   - Add `~/.ssh/id_ed25519.pub` at github.com/settings/ssh/new
3. **Clone both repos to the exact paths** (mind the spaced folder name):
   ```
   git clone git@github.com:michael-bloemeke/magic-crm.git "$HOME/Desktop/Claude/magic-crm"
   git clone git@github.com:michael-bloemeke/The-Award-Winning-Magic-of-Michael-Bloemeke.git "$HOME/Desktop/Claude/The Award-Winning Magic of Michael Bloemeke"
   ```
4. **Install deps:** `cd ~/Desktop/Claude/magic-crm && npm install`
5. **Run the app:** `npm run dev` (or double-click `Open Magic CRM.command`).
6. **Restore the things that are NOT in git (secrets / links, by design):**
   - **Gmail:** `gmail-credentials.json` + `gmail-token.json` are gitignored. Reconnect
     Gmail (see `COMMUNICATIONS-SETUP.md`) to restore email features.
   - **Vercel/portal:** the `.vercel` link and `portal/data/*.json` bundles are gitignored.
     Re-link by running a deploy from `portal/`, then **re-publish any active client
     portals** from the CRM (they regenerate; old secret links keep working once republished).

Everything else (all your client data, business docs, the code, the backup script) comes
back with the two clones.
