# Environments, data and releases

Three things are easy to confuse and must be kept apart: **source code** (Git), **configuration** (`.env`) and **runtime data** (the database, uploaded files and the
WhatsApp session). Only the first one is ever released. The other two exist separately on every machine and are never copied between machines or to GitHub.

## What lives where

| Thing | Local development checkout | Production (Oracle server) | GitHub |
| --- | --- | --- | --- |
| Source code | `D:\PROJECTS\WhatsApp AI Agent` (any branch) | `/home/ubuntu/whatsapp-ai-agent`, always a commit of `master` | `ahmedalfarooque/whatsapp-ai-agent` (`master` = production baseline) |
| Configuration (`.env`, API keys, master key) | its own `.env` (ignored by Git) | its own `.env` on the server | **never** (only `.env.example`) |
| Database | `data/app.db` (a development database, created 2026-10-07: 2 test businesses) | `/home/ubuntu/whatsapp-data/app.db` (the real businesses and customers) | **never** |
| WhatsApp session | `data/baileys-auth/` if you pair a development number | `/home/ubuntu/whatsapp-data/baileys-auth/` | **never** |
| Uploads, knowledge per account | `data/uploads`, `data/accounts`, `knowledge/accounts` | the same names under the server data directory and checkout | **never** |
| Backups | `D:\PROJECTS\_BACKUPS\whatsapp-ai-agent\` | `/home/ubuntu/whatsapp-backups/` | **never** |

A **local backend** (`http://localhost:3000`, `npm start`) has its own database, so it legitimately lists **different accounts, customers and connection states** from
`https://whatsapp.alfarooque.com`: two unpaired businesses locally and four connected ones in production is the expected result of two databases, not lost data
(proved by read-only audits of both on 2026-10-12: production unchanged, local `data/app.db` an independent development database created 2026-10-07).
Because that difference is confusing, there is a second, supported way to look at the product locally that shows **production's own records** (next section).
Either way, every page tells you which one you are on (the build line in the footer and, off production, the banner above the page), and
`node scripts/env-report.cjs` (read-only) names the branch and commit, the database file a local backend would open, its migration level, its accounts and their status, and
whether a WhatsApp session directory exists on this machine.

## One authoritative source for the code, one for the data

* **Code**: GitHub `master` is the only canonical source. A release is a fast-forward of the server checkout to a commit of `master`; nothing else changes the code in production.
  GitHub having a commit does **not** mean production runs it: only production's own checkout, the build stamp it publishes and the files it serves count
  (`pwsh scripts/release-status.ps1` reads all three, read-only, and says `IN SYNC` / `PRODUCTION BEHIND` / `UNKNOWN`).
* **Data**: production's database, behind production's authenticated backend, is the only authoritative copy of the businesses, customers and connection states. Nothing is
  exported, mirrored or snapshotted into other environments, and production alone owns the live WhatsApp sessions.

### The one local command: `npm run dev` (the local window, `scripts/dev.cjs` → `scripts/dev-proxy.cjs`)

From the checkout root (`D:\PROJECTS\WhatsApp AI Agent` on the owner's machine) **`npm run dev`** starts the one supported local application and opens the browser on
the port it chose. Port order: **3000, then 3100, 3200, 3300, 3400**; **3005 is never probed, bound or opened** (another project). For each candidate the launcher first
identifies what already listens there through its `/dashboard/build-info.json`: a window of **this checkout** (the stamp names this repository root) is **reused** — the
browser opens on it and the command exits, so running `npm run dev` twice never produces two instances; a window of another checkout, the legacy isolated backend or
any unrelated program is reported with its PID and left alone, and the next port is tried. A port is taken only by binding it, so two launchers started at the same
moment cannot both win: the loser re-identifies the winner and reuses it. The window runs **in the launcher's own process** — Ctrl+C stops exactly that, nothing is
spawned, and a failed start closes the server before exiting non-zero, so nothing is ever orphaned.

It prints: repository root and commit (+ uncommitted-change count), entry point and PID, the chosen port and the order it came from, the build commit the window
serves, the data source (`https://whatsapp.alfarooque.com`, read through production's own login and permissions), the mode (`read-only` / `business-data`), the
environment (`local-ui`, no local database, no local WhatsApp session), production's `/health` result, and the URL. The URL is **`http://localhost:<port>/dashboard`**;
the window redirects it to `http://workspace.localhost:<port>/dashboard`, a loopback name every browser resolves without a hosts-file entry, and serves data only on
that name, so the production session cookie is scoped to it and never reaches another local web app on any port.

```bash
npm run dev                           # read-only window on production's data (the normal case)
npm run dev -- --write-business-data  # the approved business-content writes go to production; connections, sending, users, keys stay blocked
npm run dev -- --no-open              # do not open the browser
npm run dev -- --port 3200            # exactly this port (never 3005)
npm run dev -- --status               # report what is on the candidate ports and exit; nothing is started
```

If no candidate can be used it prints `NO PORT AVAILABLE` with one line per port (who holds it) and exits 1 without starting or stopping anything.
When production cannot be reached the proxy answers `502 upstream_unreachable` and the dashboard shows "The application server cannot be reached" with
**Retry**; it never falls back to local data (there is none in this mode) and never shows the first-run setup form. The `.claude/launch.json` preview
configuration is `dev` (the same command with `--no-open`, previewed at `http://localhost:3000`).

Sign in with your normal production account. The proxy serves the dashboard files from **this checkout** (so your uncommitted UI work is what you see) and forwards the
`/api/dashboard/...` calls to production's backend over HTTPS. The four businesses, their company information and their **live** connection status are therefore production's, read
through production's own login, permissions and per-account isolation. There is no local database and no local WhatsApp session in this mode, and nothing is copied.

What it refuses, regardless of who is signed in (see `decide()` in the script and `tests/unit/deploy/devProxy.test.ts`): starting, pairing, enabling, disabling, creating or deleting a WhatsApp
account or session; showing a pairing QR code; sending any WhatsApp message (replies, take-over, quotation send, notification retry); users, passwords, credentials, API keys and system settings; and
**every** write unless `--write-business-data` is given, in which case only the business-content operations in `BUSINESS_WRITES`. It listens on `127.0.0.1` only, serves only the host
`workspace.localhost:<port>` (so the session cookie never reaches another local app; `localhost`/`127.0.0.1` on the same port are redirected there, any other host gets 421), never logs
request or response bodies, and refuses port 3005. A banner above every page says `Local window · Data: PRODUCTION (live) …` so a production record is never mistaken for test data.

Stopping: Ctrl+C in the terminal that runs `npm run dev`. Recovery when production is down: leave the window running, fix production (section "Releases" / the server), press Retry.
Recovery when a port is held by a crashed window of this checkout: it no longer answers `build-info.json`, so the launcher reports the PID and moves to the next port; end that
process yourself if you want the port back — the launcher never terminates anything.

### LEGACY: isolated local backend (own database) — not part of the normal workflow

`npm run legacy:isolated-backend` (`tsx watch src/index.ts`, or `npm run build && npm start`) with a local `.env` runs the backend itself on **this machine's** `data/app.db`, with its
own test accounts and sessions and **no production data**. It is kept for backend work that needs a disposable database (migrations, pipeline tests with the mock providers); it is
not reachable from `npm run dev`, and its banner says `LEGACY isolated local environment · Own local database, NOT production data · The supported application is "npm run dev"`.
It takes port 3000 if free; `npm run dev` then identifies it there and uses 3100 instead. Never pair a production WhatsApp number on it.

### Live sync of accounts and connection states

Every dashboard (production itself and the local window alike) re-reads `/api/dashboard/accounts` every **10 s while the tab is visible** and every
**60 s while hidden**, refreshes at once when the tab becomes visible again, doubles the delay after each failure (up to 2 min) and resets on success, and
applies a response only when it is newer than the last one applied (`generatedAt`). The footer shows `Live · synced N s ago`, `Stale — …` (no good sync for
30 s) or `Sync error — …, retrying`; the sidebar list, the header identity and the Accounts page redraw themselves when the inventory or a state
changes. So a business created, disabled, renamed, paired or disconnected on production appears in the local window within one interval; nothing is
copied and nothing flows back. The server has no push channel; this is bounded polling, not instantaneous.

### Which one is which

| You see | It is |
| --- | --- |
| Footer `Build 2ebc5bd · Production`, no banner | production |
| Banner `Local window · UI from commit … · Data: PRODUCTION (live), read-only` | the proxy: this checkout's UI on production's data |
| Banner `LEGACY isolated local environment · Own local database, NOT production data` | the legacy local backend (`npm run legacy:isolated-backend`) |
| Footer `Build <commit> · LEGACY isolated local environment` + banner naming `npm run dev` | a legacy local backend whose stamp the server generated itself (no release file) |
| Footer `Build: not stamped` | a release made before build stamps existed (the next release adds the stamp) |

The stamp is `dashboard/build-info.json`, written by the release script on the server (and by the proxy for itself), never committed. The same commit shown on two environments means they run the same code.

Rules that follow from this:

* **Never** copy production's database or `baileys-auth` to a developer machine, and never run the same WhatsApp number from two machines (WhatsApp disconnects one of them and
  can log the number out). For local WhatsApp testing use a separate development number paired only on that machine.
* **Never** copy a local database over production, and never "synchronise" the two. There is no bidirectional sync and none must be added.
* Business data changes happen in the product (dashboard) or in reviewed, backed-up migrations. A frontend release never migrates or edits data.
* If production data is needed for diagnosis, look at it read-only (counts, statuses, hashes) as the audit scripts do. Do not export customer content.

## Setting up a local development environment (without touching production)

1. `git clone https://github.com/ahmedalfarooque/whatsapp-ai-agent.git` (or `git pull` in the existing folder) and `npm ci`.
2. Copy `.env.example` to `.env` and set a **local** `DATABASE_PATH` (default `./data/app.db`), a local `DASHBOARD_MASTER_KEY` generated for this machine, and your own provider
   keys or the mock providers. Never reuse production secrets.
3. `npm run build && npm start` (or the dev command). The first start creates an empty database and applies the migrations; create the local Super Admin through the setup screen.
4. Run `node scripts/env-report.cjs` and check that it names the database you expect.
5. Optional: pair a **development** WhatsApp number from *WhatsApp Connection*. Do not pair a production number.

To get a copy of the *shape* of production data for testing, use fabricated or anonymised data. A local database is never refreshed from production.

## Branches

* `master` is the production baseline: the commit that is, or is about to be, deployed. It only moves forward (fast-forward or reviewed merge). No force-push, no history rewrite.
* Work happens on a branch (`redesign/...`, `fix/...`), with tests green, then merges to `master`. Old redesign branches stay for reference; they are not deleted by routine cleanup.
* A local branch that someone else created (for example `claude/...`) is left alone unless its owner says otherwise.
* One writer at a time per checkout: follow `.project-sync/PROTOCOL.md` (writer lock, checkpoint, finish).

## Release procedure (code only)

A *static* release changes only `dashboard/`, `docs/`, `tests/`, a few text files and the deploy/release/proxy scripts; it needs no build, restart or migration (details and the
server facts in `docs/DEPLOYMENT_STATIC_UI.md`). Anything that touches `src/`, migrations, packages or configuration is a **full release**: `scripts/release-full.sh`, run on
the server (or streamed to it over ssh), with `--check-only` first. It verifies the repository, branch, base, target and fast-forward, takes a verified backup
(`/home/ubuntu/whatsapp-backups/pre-full-release-<ts>`: database `.backup` + integrity, accounts/, baileys-auth/, uploads/, knowledge/, .env), fast-forwards, runs
`npm ci` only when package files changed, builds, restarts **only** `whatsapp-ai-agent`, waits for health, and proves health/readiness/public URL, one listener on 3000
and 3005 untouched, the applied migrations, and that the admin, credential, account, customer, message, upload, knowledge and WhatsApp-identity fingerprints are
unchanged — rolling back to the base commit by itself if any proof fails. Migrations run at boot by the application; the script never executes SQL on the live
database. Rehearse a migration first on a `/tmp` copy of the database (a `.backup` of it) with the archived target source, as described in the handoffs.

```powershell
# from the canonical checkout — the ONE command: reads the base from production (live HEAD, checked against the stamp), takes the target from
# master == origin/master, stages the script and runs the rehearsal (--check-only, writes nothing); -Apply then runs the release itself.
pwsh scripts/release-full.ps1                   # rehearsal
pwsh scripts/release-full.ps1 -Apply            # rehearsal, then the release
# what it does by hand (the production-deploy gate applies to the agent; the owner runs these). The script is staged to a file first because a
# script fed to `bash -s` over stdin is cut short by children that read stdin (npm, systemctl) — the run would end silently after the restart.
# release-full.sh runs ON the server only: `bash scripts/release-full.sh --check-only` on Windows aborts by design (no hashes, not the server).
Get-Content -Raw scripts\release-full.sh | ssh -i $env:USERPROFILE\.ssh\oracle-whatsapp-ai.key ubuntu@130.110.112.192 "tr -d '\r' > /tmp/release-full.sh"
ssh -i $env:USERPROFILE\.ssh\oracle-whatsapp-ai.key ubuntu@130.110.112.192 "bash /tmp/release-full.sh --base <live> --target <commit> --check-only"
ssh -i $env:USERPROFILE\.ssh\oracle-whatsapp-ai.key ubuntu@130.110.112.192 "bash /tmp/release-full.sh --base <live> --target <commit>"
pwsh scripts/release-status.ps1    # afterwards: checkout, stamp and served files must all name the released commit
``` There is no auto-deploy: a release is something the owner runs, and the permission gate in front of production is respected, not bypassed.

**The single command** (run from the canonical checkout, on `master` == `origin/master`):

```powershell
pwsh scripts/release.ps1            # rehearsal: validates, reads production's live commit, typecheck + lint + tests + build, guarded check-only; releases nothing
pwsh scripts/release.ps1 -Apply     # the same, then the release through the guarded launcher, then an independent verification
pwsh scripts/release-status.ps1     # any time, read-only: local / GitHub / production commits, build stamp, served-file comparison
```

`release.ps1` takes the *base* from production itself (its checkout's `HEAD` over a read-only ssh command), never from memory, and refuses if production is not an ancestor of
`master`. It reports success only after `release-status.ps1` finds production's checkout, published stamp and served files on the released commit; otherwise it prints (and saves in the temp
folder) a failure report with the failing step, the reason and the rollback hint. The numbered steps below are what it automates; they remain valid by hand.

1. **Verify locally**: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, and look at the rendered result (both themes, Arabic, phone) on a *disposable* database.
2. **Merge** the branch to `master` (fast-forward) and push (no force). The release target is that exact commit.
3. **Audit production read-only**: the live commit, health, the accounts and their connection states, file counts and fingerprints of the session, uploads and knowledge
   directories, and the newest backup's integrity. Record them.
4. **Check-only**: `pwsh scripts/deploy-static-ui.ps1 -Base <live commit> -Target <master commit> -CheckOnly`. It validates the repository, branch, commits, file scope, referenced assets
   and the backup destination and writes nothing. If it fails, fix the cause; never edit the check to pass.
5. **Release**: the same command without `-CheckOnly`. It takes a verified backup (database, dashboard, knowledge), fast-forwards the server checkout, proves the served assets,
   health, ports (3000 as before, 3005 untouched) and that accounts, sessions, uploads, credentials, knowledge and code fingerprints are unchanged, and rolls back by itself if a check fails.
6. **Verify live**: the deployed commit, `/health`, `/readiness`, the CSS/JS the page loads, then open the dashboard in a browser (hard refresh) in both themes.
7. **Record**: the commit, the backup directory printed by the script and the verification results go into the project-sync handoff.

Rollback: `cd /home/ubuntu/whatsapp-ai-agent && git checkout --detach <previous commit>` (static files only, no restart); `git checkout master` returns to the release.
The database is not part of a static rollback because a static release never changes it.

## What is deliberately different between environments

For the **legacy isolated local backend**: database contents, accounts, customers, conversations, connection statuses, `.env` values, WhatsApp sessions, uploads, per-account knowledge files, logs and backups.
`node scripts/env-report.cjs` and the production audit show these; none of them is a defect. The **local window** (proxy) differs from production in exactly one way: the UI files come from your checkout.

## What is never copied, anywhere

Databases, `baileys-auth*` and any WhatsApp session state, `.env` and keys, uploads, per-account knowledge, customer data, cookies and tokens. Not between machines, not into Git, not into logs.
The local window reads production through production's own login; it stores no data and no cookie that works anywhere but `workspace.localhost`.

## How to tell which repository and database are active

`git rev-parse --show-toplevel` and `git remote get-url origin` (must be `ahmedalfarooque/whatsapp-ai-agent`); `node scripts/env-report.cjs` for the database a local backend opens; the footer build line and the
banner in the browser; `pwsh scripts/release-status.ps1` for the three commits. The project root named at the top of `AGENTS.md` is the only checkout that releases from.

## What must never be committed or published

`.env` files, databases (`*.db`, `-wal`, `-shm`), `data/baileys-auth*`, `data/whatsapp-session`, `data/uploads`, `data/accounts`, `knowledge/accounts`, backups, customer
data, API keys, `Open Router.docx` and similar local notes (listed in `.gitignore`). Before a push, `git status` and `git diff --stat` are read; `git add -A` is not used.

## Housekeeping policy

* Nothing under `data/`, the server data directory, `knowledge/accounts`, uploads or any backup is deleted by cleanup. Old local files there (`*.bak-*`, `baileys-auth.corrupt-*`,
  `baileys-auth.loggedout-*`, `*-smoke.db`, logs) are ignored by Git, harmless, and kept until their owner decides.
* `Rowad Alfa_AI Agent/` is an unrelated subtree and is never modified by this project's work.
* Generated output (`dist/`, `node_modules/`, `coverage/`) is not tracked; it is rebuilt.
* Stale path references in older handoffs (for example the former `C:\Websites\WhatsApp AI Agent`) are history; the current canonical checkout is named at the top of `AGENTS.md`.
