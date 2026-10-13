# Archived, not deleted

Kept for history; none of this is used by the application, the Oracle production deployment, the release scripts or the documentation.

- `vercel-preview/` — a Vercel serverless entry point (`api/index.ts`, `vercel.json`, the empty `public/` output directory). It was never the
  production target (its own header says so) and SQLite does not persist between serverless invocations. Production runs as a systemd service.
- `local-online-preview/` — `Start Online.cmd` + `start-online.ps1` + `preview-tunnel.cjs`: built and started the backend locally on port 3000 and
  exposed it through a localtunnel URL. Superseded by the production server and by `scripts/local-window.ps1` (the local window on production data).
  The `localtunnel` npm dependency it used is still listed in package.json; remove it with the next full release.

To restore anything: `git mv archive/<...> <original path>`.
