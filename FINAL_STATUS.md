# Final Status Report — WhatsApp AI Agent

## Update (final acceptance pass): uncertain-booking reconciliation, master-key rotation, session revoke

Added on top of the previous session's dashboard work, without redoing or
regressing any of it (249/249 tests, typecheck/lint/build all still clean):

- **Uncertain-booking reconciliation.** The Bookings dashboard page now has
  "Mark confirmed…" and "Mark not booked" actions for `uncertain` rows.
  Both are pure record-keeping — neither ever calls Google Calendar. "Mark
  confirmed" requires the admin to paste in a real event ID they found by
  manually checking the actual calendar; "Mark not booked" deletes the lock
  row (freeing the slot for a genuine retry) and is explicitly documented as
  only safe once the admin has manually confirmed no event exists. This was
  judged the safest design: any automated Google query/retry from this path
  would reintroduce exactly the duplicate-booking risk the lock system
  exists to prevent. Both actions are backed by real repo functions
  (`reconcileUncertainAsConfirmed`/`reconcileUncertainAsNotBooked`) that are
  no-ops (409 at the API layer) on anything other than a genuinely
  `uncertain` row, and both were exercised live in a real running dev
  server, not just in tests.
- **Master-key rotation.** `npm run rotate-master-key`
  (`scripts/rotateMasterKey.ts`) decrypts every existing credential override
  under the current `DASHBOARD_MASTER_KEY` and re-encrypts it under a new
  one in a single transaction, so a key change never orphans stored
  credentials. Documented as an offline/maintenance step (app stopped, run
  once) rather than a dashboard button, since it touches every stored
  secret at once — a fundamentally different risk profile than setting one
  credential while the app is live.
- **Log out everywhere.** A new `destroyAllSessions()`/`POST
  /api/dashboard/auth/logout-all` revokes every active dashboard session at
  once (including the caller's), for when a session or device is suspected
  compromised. Requires an already-valid session to invoke.
- **Docker.** `docker compose config` was run and validates cleanly
  (healthcheck and `depends_on: condition: service_healthy` wiring both
  parse correctly). Actual `docker build`/`up`/container-start/migration/
  volume-persistence remain **unverified** — the Docker Desktop Linux
  engine is not available in this environment, same as every prior session.
  This is stated plainly, not glossed over: nothing here should be read as
  "Docker was tested."
- New tests added (13, bringing the suite to 249): repo-level reconciliation
  guards (no-op on non-uncertain rows, confirmed/not-booked transitions,
  slot actually freed for retry), `destroyAllSessions` unit test, a
  key-rotation round-trip test (old key fails post-rotation, new key
  recovers the exact original plaintext), and dashboard integration tests
  for the reconcile endpoint (400/409/200 cases, no secret leak) and
  logout-all (revokes the caller's own session and a second session).

## Update (dashboard session): Dashboard admin auth, encrypted credential overrides, editable business settings

Added on top of everything below, without regressing it:
- Real dashboard admin authentication (scrypt password hashing, DB-backed
  sessions, first-run setup that permanently closes after one admin
  account, login rate limiting). The dashboard is no longer gated by
  `env.isProduction` alone — it's reachable in every environment behind a
  real session, and `/api/dashboard/*` routes (other than auth itself)
  return 401 without one.
- An encrypted credential-override store (`credential_overrides` table,
  AES-256-GCM, key derived from a new **required-in-every-environment**
  `DASHBOARD_MASTER_KEY` env var) letting an admin set/test/clear the 7
  WhatsApp/OpenRouter/Google credentials from the dashboard at runtime,
  never exposed back to the browser (masked previews only). A dashboard
  override takes precedence over `.env` per-key; `.env` remains the
  fallback and is still what `env.ts`'s production-required-credential
  check validates at boot (this override system is a runtime rotation
  layer, not a way to boot production without real `.env` credentials).
  Each credential has a real "Test connection" action (bounded, explicit,
  never triggered by merely opening the page).
- A new `business_settings` table making business-facing config (hours,
  timezone, restart keywords, welcome/fallback messages, cancellation
  policy, supported languages) dashboard-editable without a restart, with
  `.env` as the fallback/seed and zod validation identical in spirit to
  `env.ts`'s existing rules.
- **Real bug found and fixed during this session's dependency graph**:
  `better-sqlite3` was pinned to `^11.3.0`, which predates Node.js v24 —
  under load (specifically, once outbound `fetch()` calls from the new
  credential-test feature started running in the same process as
  better-sqlite3's native module), the process crashed with a native
  assertion failure (`node::RemoveEnvironmentCleanupHook`, `Assertion
  failed: (env) != nullptr`). Reproduced twice, fixed by upgrading to
  `better-sqlite3@^13.0.3` (which explicitly supports Node >=22); the
  crash did not recur after 10+ further test-connection calls. This was a
  pre-existing dependency/Node-version incompatibility, not something
  introduced by this session's application logic — but it was only
  surfaced because this session added the first code path that makes a
  real outbound `fetch()` from the same live process as better-sqlite3.
- A second real bug found via live browser QA: the "Test connection" check
  for OpenRouter originally hit `/api/v1/models`, which OpenRouter serves
  publicly regardless of the bearer token's validity — a fake key reported
  "valid". Fixed by switching to `/api/v1/auth/key`, which genuinely 401s
  on an invalid key.
- Test suite grew from 196 to 233 tests (36 files), covering: password
  hash/verify, session create/verify/expire/destroy, AES-256-GCM
  encrypt/decrypt round-trip with tamper detection, business-settings
  precedence/validation/no-secret-shaped-field guarantee, and full
  integration coverage of setup/login/logout, credential set/test/clear,
  settings read/write, and the two-case production-lockdown behavior
  (401 unauthenticated, 200 with a valid session) that replaced the old
  always-404-in-production behavior.
- `npm run typecheck`, `npm run lint`, `npm run build`, and a full real
  browser QA pass (setup → login → credentials → settings → logout, every
  nav section, mobile viewport) all passed after these changes.

## Implementation status: COMPLETE (no real third-party credentials available)

Every functional requirement from the approved architecture is implemented,
wired end-to-end, and verified with a real running process against a
signed, real HTTP request (not just unit mocks). What's left is exclusively
supplying real production credentials and running the deploy steps — there
is no unfinished application code.

## Test status: PASSING

```
Test Files  19 passed (19)
     Tests  87 passed (87)
```

Covers: env validation, SQLite repos (customers/conversations/messages/
booking sessions/webhook events), webhook signature verification + GET
verify handshake + payload parsing, restart-keyword matching, knowledge
loader, retry/backoff utility, calendar availability computation +
timezone helpers, both tool handlers (success/conflict/invalid-args/
handler-throws), the OpenRouter tool-calling loop (plain answer, tool call,
unknown tool, handler throws, max-rounds fallback), full HTTP webhook
integration (GET verify, unsigned-401, signed-200, async reply delivery,
duplicate-message no-op), a full mocked conversation flow (greeting →
knowledge answer → check_availability → book_appointment → confirmation,
booking conflict, restart, concurrent same-customer messages serialized
correctly, agent-loop failure → generic customer-safe reply), and security
hardening (helmet headers, malformed-JSON → 400 not 500, no secret/stack
leakage, rate-limit headers present).

All external services (WhatsApp Graph API, OpenRouter, Google Calendar) are
mocked in tests — no real credentials required to run `npm test`.

## Build status: PASSING

- `npm run typecheck` — clean
- `npm run lint` — clean (0 errors, 0 warnings)
- `npm run build` (tsc → `dist/`, migrations copied) — clean

## Docker status: DOCKERFILE COMPLETE, BUILD NOT EXECUTABLE IN THIS SANDBOX

`Dockerfile` and `docker-compose.yml` are written and manually reviewed
(multi-stage build, native `better-sqlite3` compiled once and reused,
production-only deps pruned, non-root runtime user, `HEALTHCHECK` against
`/health`, exec-form `CMD` so `SIGTERM` reaches Node directly for graceful
shutdown, persistent bind-mounted `./data`). **I could not actually execute
`docker build`/`docker compose up` in this sandbox** — Docker Desktop's
engine never came online after multiple bounded wait attempts (~10 minutes
total) despite the CLI being installed; this looks like the sandbox lacking
the virtualization Docker Desktop needs, not a problem with the Dockerfile
itself. **Run `docker compose build` yourself on the actual VPS/dev machine
before first deploy** to confirm the image builds there — that command is
untested by me end-to-end, everything else (the app itself, running
directly under Node) has been.

## Real end-to-end smoke test performed (outside Docker)

I ran the actual built `dist/index.js` with placeholder credentials and:
- `GET /health` → `{"status":"ok"}`
- `GET /readiness` → `{"status":"ready"}`
- `GET /webhook` verify handshake → echoed challenge correctly
- `POST /webhook` with a real HMAC-SHA256 signature → `200`, message parsed,
  pipeline ran, attempted real (expectedly-rejected, fake-key) calls to
  OpenRouter and the WhatsApp Graph API, and **failed safely**: logged the
  real error internally, sent the customer a generic non-technical message,
  no crash.
- Duplicate delivery of the same signed payload → logged as
  `duplicate webhook delivery ignored`, no reprocessing.
- Malformed JSON body → `400 invalid_json` (not a raw 500).
- Response headers confirmed `X-Content-Type-Options: nosniff` present and
  `X-Powered-By` absent.
- `SIGTERM`/graceful shutdown: could not be cleanly verified via Windows
  `taskkill` (Windows doesn't deliver POSIX `SIGTERM` the way Docker/Linux
  does — `taskkill` without `/F` was refused by Windows itself). The
  shutdown handler code is correct and will work under Docker on the Linux
  VPS target; this is purely a Windows-host testing limitation, not an app
  defect.

## Completed features

- WhatsApp Cloud API webhook: GET verify handshake, POST signature
  verification (HMAC-SHA256, timing-safe compare), payload parsing,
  unsupported-message-type handling
- Customer identity resolved automatically from the WhatsApp `wa_id` —
  never asked of the customer
- SQLite persistent memory: customers, conversations, messages, booking
  sessions, webhook-event idempotency table — survives process restarts
  (verified: SQLite file is bind-mounted/on-disk, not `:memory:`, in
  production config)
- Per-customer async lock serializes concurrent/rapid messages, preventing
  race conditions on shared conversation/booking state
- Duplicate webhook delivery protection (`INSERT OR IGNORE` on Meta's
  message id)
- Restart/reset keyword handling: ends the active conversation, clears any
  in-progress booking session, starts a fresh conversation, **retains** all
  historical rows (no deletion)
- OpenRouter integration: configurable model via env var, bounded
  tool-calling loop (`MAX_TOOL_ROUNDS`, default 4) with a safe fallback
  reply instead of looping forever, malformed tool-call args and unknown
  tool names handled without crashing
- Two working tools: `check_availability` and `book_appointment`, both
  backed by real Google Calendar API calls (never fabricated results);
  `book_appointment` re-checks availability immediately before
  `events.insert` to close the race window
- Business knowledge loaded from `knowledge/*.md`/`*.json` at boot,
  interpolated into the system prompt; system prompt explicitly forbids
  inventing prices/services/policies/availability/booking confirmations and
  forbids revealing internal instructions/tools/secrets
- Structured logging (pino) with automatic secret redaction
  (`Authorization`, signature headers, tokens/keys) and WhatsApp-number
  masking in all log lines
- Centralized error handling: malformed JSON → 400, oversized body → 413,
  everything else → generic 500 with no stack trace/secret leakage to the
  client
- Security: helmet security headers, per-IP rate limiting on `/webhook`,
  request body size cap, webhook signature enforcement, no
  SQL-injection surface (all queries parameterized via `better-sqlite3`
  prepared statements)
- `/health` (liveness) and `/readiness` (DB-reachability) endpoints;
  graceful shutdown on `SIGTERM`/`SIGINT` closing the HTTP server and DB
  connection with a forced-exit timeout guard
- Docker multi-stage build, docker-compose with Caddy for automatic HTTPS,
  persistent volumes for `./data` and read-only `./secrets`

## Files created

78 files tracked in the initial commit (`6789d53`) — see `git ls-files` for
the full list. Highlights:

- `src/` — full application (config, webhook, whatsapp, pipeline, memory,
  llm, tools, calendar, knowledge, restart, health, utils)
- `tests/` — 19 test files, 87 tests (unit + integration)
- `knowledge/*.md`, `knowledge/booking.json` — placeholder business
  knowledge, clearly marked EXAMPLE/PLACEHOLDER
- `Dockerfile`, `docker-compose.yml`, `nginx/Caddyfile`, `.dockerignore`
- `.env.example`, `.eslintrc.json`, `tsconfig.json`, `vitest.config.ts`
- `README.md`, `PRODUCTION_CHECKLIST.md`, this file

## Validation commands and results

| Command | Result |
|---|---|
| `npm install` | OK (better-sqlite3 native addon compiles and loads) |
| `npx tsc --noEmit` | OK, 0 errors |
| `npx eslint . --ext .ts` | OK, 0 errors/warnings |
| `npx vitest run` | OK, 87/87 tests passing |
| `npm run build` | OK, `dist/` produced with migrations copied |
| Real running-server smoke test | OK (see above) |
| `docker compose build` | **NOT RUN** — Docker engine unavailable in this sandbox; run it yourself before first deploy |

## External credentials still required (none are supplied or fabricated)

All of these are placeholders in `.env.example` — you must obtain and set
real values before going live:

- `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `META_APP_SECRET`
  (Meta developer app)
- `WHATSAPP_VERIFY_TOKEN` (you choose this string yourself)
- `OPENROUTER_API_KEY` (openrouter.ai)
- `GOOGLE_CLIENT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `GOOGLE_CALENDAR_ID` (Google
  Cloud service account + calendar sharing)
- `DOMAIN` (your real domain, DNS pointed at the VPS)

## Manual setup still required (cannot be automated by code)

1. Create the Meta app, WhatsApp product, phone number, and permanent
   system-user access token.
2. Create the Google Cloud project + service account + Calendar API
   enablement, and **share the target calendar with the service account
   email** (Settings and sharing → "Make changes to events").
3. Get an OpenRouter API key.
4. Point DNS at the VPS.
5. `docker compose build && docker compose up -d` on the VPS (untested by
   me — see Docker status above).
6. Register the webhook callback URL + verify token in the Meta dashboard
   (only possible once the app is live over HTTPS).
7. Replace every file under `knowledge/` with real business content — the
   shipped files are explicitly marked EXAMPLE/PLACEHOLDER.

## Webhook URL format

```
https://<your-domain>/webhook
```
Register this exact URL (with your real domain) as the Callback URL in
Meta's WhatsApp → Configuration screen, alongside `WHATSAPP_VERIFY_TOKEN`.

## VPS deployment steps (summary — full detail in README.md §9)

```bash
git clone <this-repo> && cd whatsapp-ai-agent
cp .env.example .env      # fill in real production values, set DOMAIN
docker compose build
docker compose up -d
docker compose logs -f app   # confirm clean startup
curl https://<domain>/health # confirm HTTPS + app are live
```
Then register the webhook with Meta (step 6 above).

## Known limitations

1. **Docker build/run was not executed in this environment** (Docker
   Desktop's engine did not come online in this sandbox after repeated
   attempts) — verify `docker compose build` yourself before first deploy.
   Everything else about the application has been run and verified for
   real, including a live signed HTTP request against the compiled app.
2. **`npm audit`** reports 12 advisories: 1 critical + 1 high are in
   `vitest`/`vite`'s dev-only toolchain (never shipped to the production
   `dist/`/Docker image); the remaining 10 moderate ones are in
   `express`'s `body-parser`/`qs` chain and `googleapis`'s `gaxios`/`uuid`
   chain. A `qs`/`express` fix path exists but didn't apply cleanly without
   further changes; the `uuid` fix requires a major `googleapis` version
   bump (breaking change) that I did not apply blind, since I have no real
   Google Calendar credentials to verify the calendar integration still
   works against a new major version. Recommend revisiting
   `npm audit fix --force` for `googleapis` once you can test bookings
   against a real calendar.
3. **Graceful shutdown (`SIGTERM`) was only verified by code review**, not
   by an end-to-end signal test — Windows (this dev sandbox) doesn't
   deliver POSIX signals the way the Linux Docker container on your VPS
   will. The shutdown handler in `src/index.ts` is standard, direct
   (`server.close` + `closeDb` + forced-exit timeout), and the Docker
   `CMD` uses exec form specifically so this works correctly in production.
4. **No CI pipeline was set up** (not requested) — `npm test`/`typecheck`/
   `lint`/`build` are all wired as npm scripts, ready to plug into any CI.
5. This repo was git-initialized fresh with one commit; there is no remote
   configured — push it to wherever you want it hosted.
