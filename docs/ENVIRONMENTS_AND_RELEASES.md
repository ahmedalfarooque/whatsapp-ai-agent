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

So `http://localhost:3000` and `https://whatsapp.alfarooque.com` legitimately show **different accounts, customers and connection states**: they are different databases.
Seeing two unpaired businesses locally and four connected ones in production is correct, not a sign of lost data. What should match is the **code version** you are
looking at, and that is what `node scripts/env-report.cjs` (read-only) tells you: the branch and commit, the database file it would open, its migration level, its accounts and
their status, and whether a WhatsApp session directory exists on this machine.

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

A *static* release changes only `dashboard/`, `docs/`, `tests/`, a few text files and the two deploy scripts; it needs no build, restart or migration (details and the
server facts in `docs/DEPLOYMENT_STATIC_UI.md`). Anything that touches `src/`, migrations, packages or configuration is a full release with its own rehearsal, build and restart
and is not covered by the static launcher.

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

Database contents, accounts, customers, conversations, connection statuses, `.env` values, WhatsApp sessions, uploads, per-account knowledge files, logs and backups.
`node scripts/env-report.cjs` and the production audit show these; none of them is a defect.

## What must never be committed or published

`.env` files, databases (`*.db`, `-wal`, `-shm`), `data/baileys-auth*`, `data/whatsapp-session`, `data/uploads`, `data/accounts`, `knowledge/accounts`, backups, customer
data, API keys, `Open Router.docx` and similar local notes (listed in `.gitignore`). Before a push, `git status` and `git diff --stat` are read; `git add -A` is not used.

## Housekeeping policy

* Nothing under `data/`, the server data directory, `knowledge/accounts`, uploads or any backup is deleted by cleanup. Old local files there (`*.bak-*`, `baileys-auth.corrupt-*`,
  `baileys-auth.loggedout-*`, `*-smoke.db`, logs) are ignored by Git, harmless, and kept until their owner decides.
* `Rowad Alfa_AI Agent/` is an unrelated subtree and is never modified by this project's work.
* Generated output (`dist/`, `node_modules/`, `coverage/`) is not tracked; it is rebuilt.
* Stale path references in older handoffs (for example the former `C:\Websites\WhatsApp AI Agent`) are history; the current canonical checkout is named at the top of `AGENTS.md`.
