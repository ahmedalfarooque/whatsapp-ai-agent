# Static dashboard releases (dashboard/, docs/, tests/ only)

The dashboard is plain static files. The Node app serves them straight from the repository checkout
(`dist/dashboard/router.js`: `dashboardDir = <checkout>/dashboard`, `express.static`), behind Caddy
(`reverse_proxy 127.0.0.1:3000`, no file server, no CDN). A fast-forward of the server checkout therefore changes the live UI
with **no build and no restart**. Anything that touches `src/`, migrations, package files, credentials or sessions is NOT a static
release and must use the full procedure (backup, rehearsal on a copy, build, restart, fingerprints).

## Facts the workflow depends on (verified on the server, 2026-10-12)
| Item | Value |
| --- | --- |
| Checkout / served assets | `/home/ubuntu/whatsapp-ai-agent` and its `dashboard/` (not a symlink) |
| systemd unit | `whatsapp-ai-agent`, `WorkingDirectory` = the checkout, `ExecStart=/usr/bin/node …/dist/index.js` |
| App port | 3000 only. **3005 belongs to an unrelated project and is never touched** |
| Backups root | `/home/ubuntu/whatsapp-backups`, owned `root:root` (755): the deploy user cannot create folders in it directly |
| Privilege | `ubuntu` has passwordless sudo; the script uses it for **one** `install -d` of the new, timestamped backup folder only |
| Cache | `Cache-Control: public, max-age=0` with ETag, so browsers revalidate; a 404 on `tokens.css` means the file is not on the server |

## Running it
`scripts/deploy-static-ui.ps1` (local launcher) → streams `scripts/deploy-static-ui.sh` over ssh.

```powershell
# 1. read-only: every server-side precondition, writes nothing
pwsh scripts/deploy-static-ui.ps1 -Base 277499d -Target <commit> -CheckOnly
# 2. the release
pwsh scripts/deploy-static-ui.ps1 -Base 277499d -Target <commit>
```
`pwsh scripts/release.ps1 [-Apply]` wraps this launcher (validation, base read from production, typecheck/lint/tests/build, check-only, release, independent verification, failure report);
`pwsh scripts/release-status.ps1` is the read-only three-way commit report. See `docs/ENVIRONMENTS_AND_RELEASES.md`.
After the fast-forward the server script writes `dashboard/build-info.json` (`commit`, `fullCommit`, `branch`, `releasedAt`, `environment: "production"`; ignored by Git, never part of a release
diff) and the post-release proof reads it back through the public URL; rollback rewrites it for the restored commit. The dashboard footer shows it as `Build <commit> · Production`.
`-DryRun` only validates the local side. The launcher resolves the repository from its own location (never the current directory),
requires branch `master`, local `master` == `origin/master` == `-Target`, exactly one copy of the script, and that the script on disk is
byte-identical to the copy committed in `-Target`.

## What the server script checks before the first write (`ABORT[step]` on any failure)
port guard (never 3005; app port 3000; service `whatsapp-ai-agent`) · absolute, non-symlink repository root that is the git toplevel with the expected origin and branch `master` ·
live HEAD == `--base` and no tracked changes · `origin/master` == `--target` and a fast-forward · every changed file inside `dashboard/`, `docs/`, `tests/` or one of a short list of text and tool files (`AGENTS.md`, `.gitignore`, `.project-sync/PROJECT.md` and `COWORK.md`, `scripts/deploy-static-ui.*`, `scripts/env-report.cjs`, `scripts/build-info.cjs`, `scripts/dev-proxy.cjs`, `scripts/release.ps1`, `scripts/release-status.ps1`; none of them is loaded by the app) ·
`dashboard/index.html` and `tokens.css` exist in the target and every `/dashboard/*.css|js` referenced by `index.html` exists in the target, none of them removed ·
backup root exists, has space for 3x the data being copied, and is writable directly or via non-interactive sudo.

Then: service active, health 200, exactly one listener on 3000 → fingerprints → **backup** (sqlite `.backup`, copy of `dashboard/` and `knowledge/`; integrity check,
non-empty, `diff -r` of the dashboard copy) → `git merge --ff-only <target>` → proof: health/readiness, every referenced asset 200 locally **and** through the public URL,
removed files 404, the public `/dashboard/` HTML references every asset, listener counts on 3000/3005 unchanged, service active, and the fingerprints (Super Admin row, credential rows, knowledge, WhatsApp
sessions, uploads, code, account statuses, pid) identical. If any proof fails the script performs the documented rollback itself and exits non-zero.

## Rollback
```bash
cd /home/ubuntu/whatsapp-ai-agent && git checkout --detach 277499d    # static files only, no restart
git checkout master                                                    # returns to the release later
```
The backup (`/home/ubuntu/whatsapp-backups/pre-ui-redesign-<timestamp>/`) holds the previous `dashboard/`, `knowledge/` and a consistent copy of `app.db`.

## Tests
`tests/unit/deploy/staticUiDeploy.test.ts` runs the script against disposable local git repositories (no production access): correct release, wrong live commit, wrong target, dirty checkout,
wrong repository/origin/relative or missing path, port 3005 / other port / other service, out-of-scope files, missing `tokens.css`, dangling asset reference, invalid backup root or data path,
insufficient space, the new tool scripts being accepted while backend/data/other scripts are refused, the build stamp, plus the apply path with stubbed server tools (verified backup, fast-forward, asset proof, and automatic rollback when a check fails). Needs Git Bash or bash on PATH.

See also `docs/ENVIRONMENTS_AND_RELEASES.md` for what is (and must not be) shared between a developer machine, production and GitHub.
