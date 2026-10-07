# COWORK_MASTER_HANDOFF.md

Generated: 2026-09-17, by Claude Code, session bc3fe8cf-9ff1-48ff-a898-3c649dbb8cea.
Purpose: let Claude Cowork continue this exact project without the owner re-explaining it.
Everything below was verified directly against the live filesystem, database, running
process, and real Meta Graph API calls during this pass — not copied from old reports
unless explicitly marked as historical. Where something could not be verified, it is
marked **NOT VERIFIED**. No secret value appears anywhere in this document.

---

## 1. Project Identity

**Rowad Alfa Auto Care WhatsApp AI Agent** — a production Node.js/TypeScript backend that
answers WhatsApp customers bilingually (Arabic/English), guides them through a menu of
Car Audio / Car Accessories / Car Care / Prices & Enquiries / Location & Hours, and
falls through to an OpenRouter-backed LLM for free-text questions grounded in a
markdown/JSON knowledge base. It also books appointments against a real Google Calendar
when Calendar credentials are supplied (currently not — see §10, §23).

## 2. Canonical Project Root

`C:\Websites\WhatsApp AI Agent` — the one and only live checkout. Do **not** create or
use a git worktree for this project (explicit standing rule). A sibling folder
`Rowad Alfa_AI Agent` and other unrelated projects exist elsewhere on this machine —
never inspect, copy from, or modify them under this task.

## 3. Architecture

```
Meta WhatsApp Cloud API
   │ webhook (GET verify / POST inbound events)
   ▼
[HTTPS tunnel or reverse proxy] ──▶ Node.js/Express app ──▶ SQLite (data/app.db)
                                        │
                                        ├─▶ OpenRouter (LLM + tool calling)
                                        └─▶ Google Calendar (availability/booking) — currently mock, see §10
```

Every inbound WhatsApp message: HMAC-SHA256 signature verified → acknowledged `200`
immediately → customer resolved by `wa_id` → **language/menu gate** (new in commit
`1beafa4`, see §12) → if free text and not a menu keyword, LLM tool-calling loop runs
(can call `check_availability`/`book_appointment`) → reply sent back over WhatsApp,
full turn persisted in SQLite.

`createApp()` (`src/app.ts`) is a pure Express app builder with no `.listen()` call,
reused by both the local/VPS entrypoint (`src/index.ts`) and a Vercel serverless
entrypoint (`api/index.ts`) — see §22.

## 4. Repository Structure

```
src/
  automation/   NEW — bilingual menu/language pure logic (menu.ts)
  config/       env validation, constants, business settings, secret store, effective-config
  dashboard/    admin auth, router (all /api/dashboard/* routes), whatsappSync, static assets
  webhook/      Meta signature verification, verify handshake, payload parsing, router
  whatsapp/     WhatsApp Cloud API client (send text + interactive messages), mock client, types
  pipeline/     message processing orchestration (processInboundMessage.ts), idempotency, per-customer locking
  memory/       SQLite connection, migrations (10 files), repositories
  llm/          OpenRouter client, system prompt builder, tool-calling loop
  tools/        check_availability / book_appointment tool implementations
  calendar/     Google Calendar auth, timezone helpers, availability, booking
  knowledge/    knowledge-base loader (loads every .md/.json in knowledge/ verbatim into the system prompt)
  restart/      restart-keyword detection
  health/       /health and /readiness endpoints
  utils/        retry/timeout helpers
knowledge/      business knowledge files — mixed real/placeholder, see §13 (IMPORTANT)
dashboard/      static HTML/JS/CSS for the admin dashboard (served at /dashboard)
tests/          unit + integration tests, 38 files, 297 tests, all external services mocked
.project-sync/  multi-AI coordination protocol — see §33
scripts/        project-sync.cjs, rotateMasterKey.ts, copyAssets.js
api/index.ts    Vercel serverless entrypoint (not the primary deployment target currently)
data/app.db     the live SQLite database — also contains leftover smoke-test DB files
                (dashboard-built-smoke.db, dashboard-smoke.db, dev-smoke.db and their
                -shm/-wal siblings) from earlier manual testing sessions; harmless, not
                referenced by the app, left in place per "no unrelated cleanup"
secrets/        empty — mounted read-only for an optional Google service-account key
                file; the app currently reads Google credentials from env vars directly,
                not a file, so this directory is unused
```

## 5. Application Entry Points

- `src/index.ts` — the real entrypoint for local dev (`npm run dev`, tsx watch) and
  production (`npm start` → `node dist/index.js`). Logs `"Production mode: using real
  WhatsApp, OpenRouter, and Google Calendar providers"` when `NODE_ENV=production`.
- `api/index.ts` — Vercel serverless wrapper around the same `createApp()`. Historical
  Vercel/Supabase deployment work exists (`vercel.json`, `@supabase/ssr` and
  `@supabase/supabase-js` in `package.json` dependencies) but this path is **not the
  current production target** — the user explicitly deprioritized it in favor of
  getting the existing app live via a local process + HTTPS tunnel. Treat the Supabase
  dependencies as inert until/unless that migration is explicitly resumed.

## 6. Dashboard Architecture

Admin web UI at `/dashboard` (root `/` redirects there), backed entirely by
`src/dashboard/router.ts` (`/api/dashboard/*`). Scrypt-hashed admin password, DB-backed
sessions (`admin_sessions` table, 12h sliding / 7-day hard cap, httpOnly/SameSite
cookies). First-run setup creates exactly one admin account, permanently refused after.
Every `/api/dashboard/*` route except `auth/status|setup|login` returns 401 without a
valid session — **verified this pass**: `curl http://localhost:3000/api/dashboard/system`
→ `{"error":"unauthenticated"}`.

Dashboard sections: Dashboard (summary), Customers, Conversations, Bookings, Knowledge
(view/edit with automatic timestamped backups), Services, AI, Integrations (WhatsApp/
OpenRouter/Google credential entry + masked display + real Test-connection calls),
Logs, System, Settings, Project Sync.

Credentials entered here are stored in `credential_overrides` (AES-256-GCM, key derived
from `DASHBOARD_MASTER_KEY`) and take precedence over `.env` for that one key via
`getEffectiveCredential()` — **but `src/config/env.ts`'s boot-time
production-required-credential check reads raw `.env` only, never the dashboard
override store.** This is by design (a documented architectural decision, not a bug):
the dashboard override system is a runtime rotation layer on top of an already-valid
`.env`-based boot, not a way to boot production with an empty `.env`. See §10 for why
this currently means Google Calendar stays mocked despite a WhatsApp-only credential
being present.

## 7. WhatsApp Architecture

- `src/webhook/verifySignature.ts` — HMAC-SHA256, timing-safe compare. **Verified this
  pass**: a GET `/webhook` request with a deliberately wrong verify token returns `403`
  through the live tunnel (real app response, not a tunnel interstitial).
- `src/webhook/parseInboundPayload.ts` — flattens Meta's nested payload; as of commit
  `1beafa4` also extracts `interactiveId` from `button_reply`/`list_reply` interactive
  messages, not just plain text.
- `src/whatsapp/client.ts` — real Graph API sender: `sendTextMessage`,
  `sendInteractiveMessage` (button and list interactive payloads), `markMessageAsRead`.
  Non-idempotent sends (a real message) never retry on ambiguous network errors, only
  on definite 429/5xx.
- `src/whatsapp/mockClient.ts` — mirror mock implementations used only when
  `env.shouldUseMockProviders` is true (i.e. `NODE_ENV !== 'production'`).
- `src/pipeline/idempotency.ts` — per-`wa_id` async queue serializing concurrent
  deliveries; `webhook_events` table with `INSERT OR IGNORE` on Meta's message id
  prevents duplicate processing of a redelivered webhook.

## 8. Meta Configuration

Production identifiers (as supplied by the project owner, cross-checked against the
live database and a real Graph API call this pass):

| Field | Value | Verified how |
|---|---|---|
| Business Portfolio ID | 1224750927398962 | as supplied, not independently re-queried this pass |
| Meta App name/ID | Rowad Alfa Auto Care / 1081311474652506 | confirmed as a subscribed app on the production WABA (Graph API `GET {waba}/subscribed_apps`, this pass) |
| Production WABA | Rowad Alfa car accessories / 1388480302719892 | `whatsapp_connection.last_sync_detail` in the live DB says `"Connected to +966 55 819 0545 on WABA 1388480302719892."`, and the subscription check above targeted this exact WABA ID successfully |
| Production phone | +966 55 819 0545 | same `last_sync_detail` string, and `display_phone_number` column, both in the live DB |
| Production Phone Number ID | 937660752766640 | stored as `WHATSAPP_PHONE_NUMBER_ID` in `credential_overrides` (value not read/printed — presence and key name only) |

**Test assets that must never be used** (do not substitute for the above): test WABA
`1707015207029392`, test Phone Number ID `1283942041472893`, test phone
`+1 555-174-4788`.

## 9. OpenRouter Configuration

`business_settings.open_router_model` in the live DB = **`openrouter/free`** (verified
this pass by direct query). `credential_overrides` contains an `OPENROUTER_API_KEY`
entry (key presence only, value never read). `src/llm/openRouterClient.ts` is the real
HTTP client; `src/llm/mockOpenRouterClient.ts` backs tests and non-production runs.
Do not introduce a paid/alternate LLM provider — this is an explicit standing
constraint from the project owner.

## 10. Calendar Configuration

**Currently MOCK, not real** — verified this pass by reading `src/config/env.ts`:

```
shouldUseMockCalendarProviders =
  raw.NODE_ENV !== 'production' || !raw.GOOGLE_CLIENT_EMAIL || !raw.GOOGLE_PRIVATE_KEY
```

`.env` on this machine has **no** `GOOGLE_CLIENT_EMAIL` or `GOOGLE_PRIVATE_KEY` line at
all (confirmed by grep this pass). `credential_overrides` does contain a
`GOOGLE_CLIENT_EMAIL` entry, but — per §6 — the boot-time mock/real switch only ever
consults raw `.env`, never the dashboard override store, so this override currently has
no effect on which Calendar provider is active. **This is consistent with the project's
own documented architecture decision** (`.project-sync/PROJECT.md`: "Production requires
WhatsApp and OpenRouter credentials. Google Calendar may remain unavailable/mock when
its production credentials are absent.") — not a regression, but real bookings are
**not currently possible**; `check_availability`/`book_appointment` will operate against
the mock provider until real `GOOGLE_PRIVATE_KEY`/`GOOGLE_CLIENT_EMAIL`/
`GOOGLE_CALENDAR_ID` are added to `.env` and the process restarted (a dashboard-only
override is not sufficient for this one check).

## 11. Database

SQLite at `data/app.db`, `better-sqlite3` driver, WAL mode, foreign keys on. Migrations
run automatically at boot from `src/memory/migrations/*.sql`, tracked in
`schema_migrations`. **Current migration state (verified this pass, all 10 applied):**
`001_init`, `002_booking_locks`, `003_booking_locks_uncertain_status`,
`004_business_settings`, `005_admin_users`, `006_admin_sessions`,
`007_credential_overrides`, `008_whatsapp_connection`, `009_business_settings_openrouter_model`,
`010_customer_language` (new in commit `1beafa4` — adds `customers.language`, nullable).

Core tables: `customers`, `conversations`, `conversation_messages`, `booking_sessions`,
`booking_locks`, `webhook_events`, `business_settings` (id=1 singleton),
`admin_users`, `admin_sessions`, `credential_overrides`, `whatsapp_connection` (id=1
singleton). Live row counts this pass: `admin_users` = 1, `customers` = 0 (no real
customer has messaged the bot yet — see §26).

## 12. Customer Automation

Implemented in commit `1beafa4`, verified present in the current codebase and covered
by `tests/unit/automation/menu.test.ts` (14 tests) and
`tests/unit/pipeline/processInboundMessage.test.ts` (14 tests), all passing this pass.

Flow, gated ahead of the AI loop in `src/pipeline/processInboundMessage.ts`:
1. `customers.language` is `NULL` for a new/reset customer → the app always sends the
   language-selection interactive buttons (`src/automation/menu.ts:MENU_IDS.LANG_EN /
   LANG_AR`) before anything else, on every inbound message, until a language is chosen
   (button tap, or a bare "english"/"عربي" text fallback).
2. On selection: `setCustomerLanguage()` persists it; a localized welcome is sent —
   customer name if known, business name from `getBusinessSettings().businessName`
   (currently `null` in the DB → falls back to `.env`'s `BUSINESS_NAME`, which is
   **not set** in `.env` on this machine → defaults to the literal string `"The
   Business"`, see §26 blocker), and the exact Google Maps link
   `https://share.google/QdtvbcoaAlyxfDNZl` (hard-coded as `GOOGLE_MAPS_LINK` in
   `src/automation/menu.ts` — do not change this URL, it is a business fact, not a
   placeholder).
3. Main menu (interactive list, stable IDs): Car Audio, Car Accessories, Car Care,
   Prices & Enquiries, Location & Hours.
4. Selecting a category sends a short localized prompt + "Main Menu"/"Change language"
   navigation buttons — deliberately does **not** try to answer the question itself
   (that stays the AI's job, grounded in `knowledge/`, so no fabricated content can
   enter through the menu layer).
5. Any free text that isn't a menu/change-language keyword bypasses the menu entirely
   and reaches the existing AI agent loop unchanged.
6. `restart`/`reset` (configurable keyword) clears the booking session, ends the
   conversation, starts a fresh one, **and now also clears `customers.language` back to
   NULL** — restart returns the customer to the language-selection gate.
7. `buildSystemPrompt()` takes an optional `language` argument and instructs the model
   to always reply in that language once selected.

## 13. Knowledge Base

`src/knowledge/loader.ts` loads **every** `.md`/`.json` file directly under `knowledge/`
verbatim into the system prompt — there is no per-file filtering. **Current state
(verified this pass, real content, not from an old report):**

| File | Status |
|---|---|
| `knowledge/business.md` | **REAL** — Rowad Alfa Auto Care, phone +966 55 819 0545, Google Maps link, three category names. No invented street address, hours, or granular details (explicitly says so). |
| `knowledge/services.md` | **REAL but sparse** — states the three categories exist, explicitly says no item-level prices have been supplied yet, and instructs the AI to say so rather than invent one. |
| `knowledge/policies.md` | **STILL PLACEHOLDER** — literally marked `<!-- EXAMPLE / PLACEHOLDER CONTENT -->` with a fabricated "24 hours notice" cancellation policy. This is being loaded into the live system prompt right now. |
| `knowledge/faq.md` | **STILL PLACEHOLDER** — marked EXAMPLE, contains a fake "Do you offer refunds?" Q&A. |
| `knowledge/booking.json` | **STILL PLACEHOLDER** — `servicesRequiringBooking: ["Example Consultation", "Example Deep Dive"]`, informational only (not enforced by code per its own `_comment`), but still concatenated into the system prompt verbatim. |

**This is a real, currently-live risk**: the AI's system prompt right now contains a
mix of real Rowad Alfa facts and fabricated example policies/FAQ/booking text in the
same context. The system prompt's own honesty rules ("only answer using knowledge...
never invent") should in principle stop the model from presenting the placeholder text
as real, but the placeholder text is not visually distinguished from the real text once
concatenated — the safest fix is for the business owner to either replace
`policies.md`/`faq.md`/`booking.json` with real content or delete/empty them (an empty
knowledge file is explicitly handled — the loader logs and skips), not to leave
fabricated content in the live prompt. **Not previously flagged this explicitly in any
prior session's report — flagging now.**

## 14. Security

- Helmet security headers; `X-Powered-By` absent (documented, not re-verified this pass).
- Rate limiting on `/webhook` and dashboard auth endpoints (`express-rate-limit`).
- HMAC-SHA256 webhook signature verification with timing-safe comparison — **verified
  this pass** via a live wrong-token GET returning 403 through the current tunnel.
- AES-256-GCM encrypted credential store, key derived (HKDF) from `DASHBOARD_MASTER_KEY`,
  required in every environment.
- Scrypt password hashing, database-backed sessions, httpOnly/SameSite cookies.
- Structured logging (pino) with automatic secret redaction and WhatsApp-number masking.
- System prompt (`src/llm/buildSystemPrompt.ts`) contains an explicit prompt-injection
  defense clause: customer text that looks like an instruction override is treated as
  conversation content, never as a new instruction.
- **Never** print/log/commit: `WHATSAPP_ACCESS_TOKEN`, `META_APP_SECRET`,
  `WHATSAPP_VERIFY_TOKEN`, `OPENROUTER_API_KEY`, `GOOGLE_PRIVATE_KEY`, admin passwords,
  session tokens. This document does not contain any of them — only key *names* and
  non-secret status.

## 15. Authentication

Covered in §6. `admin_users` currently has exactly 1 row (verified this pass) — the
first-run setup has already been completed on this machine; a fresh Cowork session
cannot re-run setup and does not have the existing admin password (never requested,
never stored anywhere in this repo or `.project-sync`).

## 16. Booking Reliability

`booking_locks` table + `reconcileUncertainAsConfirmed`/`reconcileUncertainAsNotBooked`
repo functions back a dashboard reconciliation flow for `uncertain` bookings (a booking
attempt where the app couldn't confirm whether Google actually created the event — a
connection-failure case, never silently reported as success or failure). Both
reconciliation actions are pure record-keeping — neither ever calls Google itself. This
subsystem is currently **inert** because Calendar is mocked (§10) — no real booking has
been attempted against a real calendar on this deployment.

## 17. Tests

38 test files under `tests/unit/` and `tests/integration/`. All external services
(WhatsApp Graph API, OpenRouter, Google Calendar) are mocked in tests — `npm test`
requires no real credentials. `.env` was temporarily renamed during this pass's test run
(a known, documented mitigation — real `.env` values leak into `dotenv.config()` during
some test imports otherwise) and restored immediately after; this does not affect the
running server, which does not re-read `.env` after boot.

## 18. Current Test Count

**297 passing, 0 failing, 38 files** — ran directly this pass (not copied from an old
report). Includes the new `tests/unit/automation/menu.test.ts` and
`tests/unit/pipeline/processInboundMessage.test.ts` added in commit `1beafa4`.

## 19. Typecheck/Lint/Build Status

All three ran this pass, all clean:
- `npm run typecheck` (`tsc --noEmit`) — 0 errors
- `npm run lint` (`eslint . --ext .ts`) — 0 errors, 0 warnings
- `npm run build` (`tsc -p tsconfig.json && node scripts/copyAssets.js`) — succeeded,
  `dist/` produced, migrations copied including the new `010_customer_language.sql`

## 20. Runtime Status

**Currently running** (started this pass — it had stopped since the previous session,
confirmed by `curl` failing with connection-refused before restart). Started via
`node dist/index.js` in the foreground-detached (`nohup ... &`) pattern used throughout
this project's history; log line confirms: `"Production mode: using real WhatsApp,
OpenRouter, and Google Calendar providers"` (Calendar's real-vs-mock split happens
per-provider inside that "real" branch — see §10 for why Calendar itself is still
mocked despite this log line). `GET /health` → `{"status":"ok"}`, `GET /readiness` →
`{"status":"ready"}`, both verified this pass against `http://localhost:3000`.

**No orchestration/process-manager is configured** (no PM2, no systemd unit, no Docker
container currently running) — if this Node process dies (crash, reboot, terminal
closed), nothing restarts it automatically. This is a real operational gap for anything
resembling "production" beyond a manual dev-style run. **NOT VERIFIED**: whether any of
the several other stray `node.exe` processes found running on this machine during this
pass are related to this project or something else entirely — they were not on port
3000 and were not touched.

## 21. Docker Status

`Dockerfile`, `docker-compose.yml`, `nginx/Caddyfile`, `.dockerignore` all exist and
were reviewed by a prior session (multi-stage build, non-root user, `HEALTHCHECK`
against `/health`, exec-form `CMD`, bind-mounted `./data`, read-only `./secrets`).
**`docker compose build`/`up` has never been executed successfully in any session on
this machine** — Docker Desktop's engine was unavailable in every prior attempt. **NOT
VERIFIED this pass either** — Docker was not touched, per "do not perform unrelated
work" and because the current path to a live webhook (local process + tunnel) does not
require it. This remains the single largest unverified piece of the production path if
the intended real deployment target is a VPS via Docker rather than this local machine.

## 22. Deployment Status

Two theoretical paths exist in the repo, neither is the currently-active one:
- **Docker + Caddy on a VPS** — described in `README.md` §9, never executed (§21).
- **Vercel serverless** (`api/index.ts`, `vercel.json`) — a prior session found Vercel's
  zero-config Express detection silently dropped `dashboard/index.html`/`styles.css`
  from the deployed bundle, an unresolved CLI defect; this path was not pursued further
  and is not the current target.

**Actual current path**: this exact Windows machine, running `node dist/index.js`
directly (or `npm run dev` during active development), exposed to the public internet
via a free `localtunnel` HTTPS tunnel that must be manually restarted and
re-registered with both the dashboard and Meta every time it dies (it dies
unpredictably — this has happened at least 4 times across the last three sessions).
**This is not a durable production deployment** — it depends on this machine staying on,
this specific Node process staying alive, and a free tunnel service that has no
uptime guarantee. Getting onto a real always-on host (the VPS/Docker path, or a fixed
resolved fix for the Vercel static-asset issue) is the largest unresolved
production-readiness gap, independent of any application code correctness.

## 23. Production Configuration Status

Verified directly against the live DB and `.env` this pass:

| Credential | Present in `credential_overrides` (dashboard) | Present in raw `.env` |
|---|---|---|
| `WHATSAPP_ACCESS_TOKEN` | Yes | placeholder only (by design — see README §11's explanation of the dashboard-override architecture) |
| `WHATSAPP_PHONE_NUMBER_ID` | Yes | placeholder only |
| `WHATSAPP_VERIFY_TOKEN` | Yes | placeholder only |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | Yes | n/a (dashboard-only field) |
| `META_APP_SECRET` | Yes | placeholder only |
| `OPENROUTER_API_KEY` | Yes | placeholder only |
| `GOOGLE_CLIENT_EMAIL` | Yes | **absent** |
| `GOOGLE_PRIVATE_KEY` | **absent** | **absent** |
| `GOOGLE_CALENDAR_ID` | **absent** | **absent** |
| `BUSINESS_NAME` | n/a | **absent** (defaults to `"The Business"` — see §26) |
| `NODE_ENV` | n/a | `production` (confirmed) |

A real `syncWhatsapp()` Graph API call was executed this pass (not from cache/history)
and returned success, confirming the WhatsApp token/WABA/phone combination is valid
**right now**, not just historically.

## 24. Meta/WABA Subscription Status

**Verified this pass** with a real `GET {waba}/subscribed_apps` Graph API call: the
production app **Rowad Alfa Auto Care (1081311474652506) is subscribed** to production
WABA **1388480302719892**, alongside one other app ("Business Agent",
1143680903703001, unrelated, not touched). A prior session found this subscription
missing and added it via a real `POST {waba}/subscribed_apps` call — this pass confirms
it is still present.

## 25. Webhook Status

**Currently misconfigured — the dashboard's saved webhook URL points at a dead tunnel.**

- `whatsapp_connection.webhook_url` in the live DB = `https://gold-pans-like.loca.lt/webhook`,
  `sync_status = 'live'`, last synced at 2026-09-17 06:46:42 — this proves the human
  dashboard-save + Meta-callback-update + Sync-WhatsApp steps from the previous
  session's instructions **were completed** by the user since the last handoff.
- However, `https://gold-pans-like.loca.lt` is **dead** — verified this pass with 3
  retries returning `503`. Free `localtunnel` sessions do not survive indefinitely; this
  one died sometime between the last pass and this one.
- A **fresh tunnel was started this pass** and verified against the real running app
  (not a tunnel interstitial page): `GET /health` → `200`, `GET /webhook` with a
  deliberately wrong verify token → `403`. New verified URL:

  **`https://some-parrots-check.loca.lt/webhook`**

- This new URL has **not** been saved into the dashboard or Meta's callback
  configuration — per the standing rule, the webhook URL is only ever set by the human
  through the dashboard UI and Meta's own developer console; this agent has no
  browser/admin session to do it on their behalf, and the URL must never be
  hardcoded into source code or auto-discovered.

## 26. Known Blockers

1. **Webhook URL is stale (dead tunnel currently registered).**
   Problem: `whatsapp_connection.webhook_url` = `https://gold-pans-like.loca.lt/webhook`,
   confirmed dead (503).
   Component: dashboard `Integrations → WhatsApp Business` page + Meta App →
   WhatsApp → Configuration → Webhook.
   Verify: `curl https://gold-pans-like.loca.lt/health` (expect failure/503).
   Fix: human — open `http://localhost:3000/dashboard`, Integrations, set Webhook URL
   to `https://some-parrots-check.loca.lt/webhook`, Save Configuration; then in the
   Meta Developer App set the same Callback URL with the existing Verify Token, Verify
   and Save, confirm `messages` field subscribed; then click Sync WhatsApp in the
   dashboard.
   Type: **Meta dashboard + application dashboard UI (human-only)**.

2. **No real end-to-end WhatsApp message has ever been sent/received on this deployment.**
   Problem: `customers` table has 0 rows — no real customer has ever messaged the bot.
   Component: the entire real inbound path, unverifiable without a real phone.
   Verify: `SELECT COUNT(*) FROM customers` (currently 0).
   Fix: human — once §26.1 is resolved, send "Hello" or "مرحبا" from a real phone to
   +966 55 819 0545 and confirm the full chain: language buttons → welcome → menu →
   free-text AI answer, observed in the dashboard's Conversations page or server logs.
   Type: **human action, requires a real phone** — cannot be simulated or assumed.

3. **`BUSINESS_NAME` is not set anywhere, so the welcome message currently says "The
   Business", not "Rowad Alfa Auto Care".**
   Problem: `business_settings.business_name` is `NULL` in the DB, and `.env` has no
   `BUSINESS_NAME` line, so `env.ts`'s zod default (`'The Business'`) is what
   `getBusinessSettings().businessName` returns — this value is used directly in the
   bilingual welcome message (`src/automation/menu.ts:buildWelcomeText`).
   Component: `.env` or the dashboard Settings page (`business_settings.business_name`).
   Verify: `SELECT business_name FROM business_settings WHERE id=1` (currently NULL);
   `grep BUSINESS_NAME .env` (currently absent).
   Fix: either add `BUSINESS_NAME=Rowad Alfa Auto Care` to `.env` and restart, or set it
   from the dashboard Settings page (takes effect immediately, no restart).
   Type: **configuration** (either `.env` edit + restart, or a dashboard action).

4. **`knowledge/policies.md`, `knowledge/faq.md`, `knowledge/booking.json` are still
   placeholder content and are loaded verbatim into the live system prompt right now.**
   Problem: see §13 — a fabricated 24-hour cancellation policy and a fake refund FAQ
   are currently part of what the AI sees as "business knowledge".
   Component: the three files listed, loaded by `src/knowledge/loader.ts`.
   Verify: `head knowledge/policies.md` / `knowledge/faq.md` / `knowledge/booking.json`
   — all three still contain the literal string `EXAMPLE`.
   Fix: either replace with real Rowad Alfa content, or empty them (loader handles an
   empty file safely) so no fabricated policy/FAQ content reaches the model.
   Type: **content/configuration**, requires real business facts from the owner —
   do not invent replacement content.

5. **Google Calendar is mocked; no real booking capability exists yet.**
   Problem: see §10 — `.env` lacks `GOOGLE_CLIENT_EMAIL`/`GOOGLE_PRIVATE_KEY`.
   Component: `.env`, `src/config/env.ts`'s `shouldUseMockCalendarProviders`.
   Verify: `grep GOOGLE_ .env` (currently only whatever is checked into
   `credential_overrides`, which this specific boot check ignores).
   Fix: add real `GOOGLE_CLIENT_EMAIL`/`GOOGLE_PRIVATE_KEY`/`GOOGLE_CALENDAR_ID` to
   `.env` (not just the dashboard override) and restart the process; share the target
   calendar with the service account email first.
   Type: **external infrastructure (Google Cloud) + `.env` configuration + restart**.
   Note: this is explicitly **not required** to get real WhatsApp text/menu automation
   working — only affects the booking tool specifically.

6. **This machine's process has no supervisor; nothing restarts it if it dies.**
   Problem: see §20/§22 — a manually-started `node dist/index.js` with no PM2/systemd/
   Docker wrapper is the entire current production runtime.
   Component: deployment/ops, not application code.
   Verify: no `pm2 list`/systemd unit/Docker container currently associated with this
   app (Docker specifically confirmed absent — §21).
   Fix: either finish the Docker/VPS path (§21/§22) or, as a stopgap, wrap the current
   process in a supervisor (PM2, NSSM as a Windows service, or similar) on this machine.
   Type: **server/infrastructure**.

## 27. Known Risks

- Free `localtunnel` sessions die unpredictably (observed 4+ times across recent
  sessions) — every death breaks the live webhook silently until someone notices and
  restarts it. Not a code defect; an inherent property of using a free ephemeral
  tunnel instead of a real domain/host.
- The knowledge-base mixing of real and placeholder content (§13/§26.4) is a
  reputational risk if a real customer asks about cancellation policy or refunds before
  it's fixed — the system prompt's honesty rules should prevent outright fabrication,
  but this has not been tested against a real adversarial customer question.
- `data/app.db` has several leftover smoke-test database files sitting alongside it
  (§4) — harmless (unreferenced by the app) but could confuse a future operator poking
  around `data/`.
- `package.json` carries `@supabase/ssr`/`@supabase/supabase-js` dependencies and
  `vercel.json` from an explicitly-deprioritized migration plan — these are currently
  unused dead weight, not wired into any active code path; removing them was never
  requested and is out of scope for this handoff, but a future cleanup pass should
  confirm they're still genuinely unused before removing.

## 28. Required Changes

None required in application source code to reach "real WhatsApp text/menu automation
working" — the code is complete and tested (§17–19). The required changes are entirely
configuration/content/infrastructure, enumerated exactly in §26.

## 29. Required External Configuration

- A durable public HTTPS endpoint for the webhook (replace the free tunnel with a real
  domain + host, or accept the tunnel's unreliability as a known limitation for now).
- `BUSINESS_NAME` in `.env` or the dashboard Settings page.
- Real content for `knowledge/policies.md`, `knowledge/faq.md`, `knowledge/booking.json`.
- (Optional, only for booking) Real Google Cloud service account credentials in `.env`
  and calendar sharing.
- (Optional, for durability) A process supervisor or the Docker/VPS path completed.

## 30. Exact Production Activation Procedure

1. Confirm the app is running: `curl http://localhost:3000/health` → expect
   `{"status":"ok"}`. If not running: `cd "C:\Websites\WhatsApp AI Agent" && npm run
   build && node dist/index.js` (or `npm run dev` for a watch-mode dev run).
2. Confirm/start a tunnel: `npx localtunnel --port 3000`, note the printed URL, verify
   with `curl <url>/health` (expect 200, not a tunnel interstitial or 503).
3. Dashboard → Integrations → WhatsApp Business → set Webhook URL to `<tunnel-url>/webhook`
   → Save Configuration.
4. Meta Developer App (Rowad Alfa Auto Care) → WhatsApp → Configuration → Webhook → set
   the same Callback URL, same existing Verify Token → Verify and Save → confirm
   `messages` field is subscribed.
5. Dashboard → Integrations → click **Sync WhatsApp** → confirm it reports Connected/Live.
6. Fix §26.3 (`BUSINESS_NAME`) and §26.4 (placeholder knowledge files) before any real
   customer traffic, to avoid the bot introducing itself as "The Business" or citing a
   fabricated cancellation policy.
7. Send a real WhatsApp message ("Hello" or "مرحبا") from a real phone to
   +966 55 819 0545. Confirm in the dashboard's Conversations page or
   `node dist/index.js`'s log output that the message was received, processed, and
   replied to.
8. Only after step 7 has genuinely happened, it is correct to describe the system as
   "live" — not before.

## 31. Verification Procedure

```bash
npm test           # expect 297/297 passing
npm run typecheck   # expect 0 errors
npm run lint         # expect 0 errors/warnings
npm run build         # expect dist/ produced cleanly
curl http://localhost:3000/health      # expect {"status":"ok"}
curl http://localhost:3000/readiness    # expect {"status":"ready"}
curl -w '%{http_code}' <tunnel-url>/health   # expect 200, not a tunnel page
```
For any credential/Graph API verification without exposing secrets, use a short one-off
`tsx` script that imports `getEffectiveCredential` from `src/config/effectiveConfig.ts`
and only logs Graph API response status/non-secret fields — delete the script
immediately after use (see prior session handoffs for the exact pattern; this pass used
and deleted `scripts/_tmpCheckSub3.ts`).

## 32. Rollback Procedure

- **Code**: `git log --oneline` shows a clean linear history; `git revert <sha>` or
  `git reset --hard <known-good-sha>` (only with explicit user confirmation — never
  run a destructive git command unprompted) is safe since every commit here left
  tests/typecheck/lint/build green.
- **Database**: no automated backup exists yet (`PRODUCTION_CHECKLIST.md`'s "Backup
  procedure tested at least once" item is still unchecked). Before any risky DB
  operation, copy `data/app.db` (and its `-shm`/`-wal` siblings) aside first.
- **Credential rotation**: `npm run rotate-master-key` exists for `DASHBOARD_MASTER_KEY`
  rotation specifically (`scripts/rotateMasterKey.ts`, documented in `README.md` §11b) —
  never just edit `.env`'s `DASHBOARD_MASTER_KEY` and restart, existing overrides would
  become permanently unreadable.

## 33. Current Project-Sync State

`.project-sync/PROTOCOL.md` defines the multi-AI coordination protocol: read state,
acquire a writer lock (`node scripts/project-sync.cjs start <Agent> "<task>"
<session-id>`) before any mutation, checkpoint/finish with a `report.json` containing
`summary`/`reason`/`tests`/`nextSteps`. `.project-sync/COWORK.md` documents the intended
Cowork folder-binding paragraph but states plainly: **"native activation remains
pending, not silently inferred"** — i.e. it is NOT VERIFIED that Cowork's native folder
instructions are actually wired up yet; this document exists specifically to make that
gap moot by being self-contained. No writer lock was held by anyone else at the start
of this pass (`"writer": null` in `node scripts/project-sync.cjs check` output).

## 34. Files Changed Recently

Per `git log` (§36) and this pass's live inspection — the most recent commit,
`1beafa4`, added: `src/automation/menu.ts`, `src/memory/migrations/010_customer_language.sql`,
`tests/unit/automation/menu.test.ts`, `tests/unit/pipeline/processInboundMessage.test.ts`,
and modified `src/llm/buildSystemPrompt.ts`, `src/memory/customerRepo.ts`,
`src/pipeline/processInboundMessage.ts`, `src/webhook/parseInboundPayload.ts`,
`src/whatsapp/{client,mockClient,types}.ts`, `knowledge/business.md`,
`knowledge/services.md`, plus several existing test files. This document
(`COWORK_MASTER_HANDOFF.md`) is new, created this pass. No other source files were
modified in this pass — this was a verification/documentation pass only.

## 35. Git Status

At the time of writing (working tree, not yet re-checked after this file is added):
```
 M .project-sync/state.json
 M package-lock.json          (pre-existing, unattributed — @supabase deps, §27)
 M package.json                (same as above)
?? .codex/config.toml          (pre-existing, inspected for secrets — none found)
?? .project-sync/handoffs/*.json  (prior session handoffs)
?? "Open Router.docx"          (pre-existing, untracked — never inspected/committed)
```
`package.json`/`package-lock.json`'s modifications are **not from this session** and
were left untouched, per the standing rule to preserve unknown-owned changes rather
than overwrite or claim authorship.

## 36. Git Commits Relevant to Current State

```
1beafa4  Add bilingual (Arabic/English) WhatsApp menu automation   <- current HEAD
d469943  Record project-sync handoff for the Save Configuration persistence fix
7d5926c  Fix WhatsApp Save Configuration rejecting blank secret fields
9ec76fb  Record project-sync handoff for the end-to-end WhatsApp/dashboard fix pass
17ead11  Surface a clear message when the dashboard can't reach the server at all
81b1ef2  Record project-sync handoff for the WhatsApp form autofill fix
a5ec295  Stop browser password managers from autofilling the WhatsApp setup form
270168e  Add dashboard admin auth, encrypted credential overrides, and editable business settings
0aff91a  Add booking idempotency locks, real integration hardening, multi-AI project-sync coordination, and a functional admin dashboard
82c293d  Add safe local dev mode: mock providers, production-only credential validation
6789d53  Initial implementation: production-ready WhatsApp AI agent
```

## 37. Final Definition of Done

The application code is done — tested, typechecked, linted, built, and its bilingual
automation is architecturally complete (§12, §17–19). "Done" for the **project as a
whole** additionally requires, in order: (1) a webhook URL that stays alive and
registered (§26.1), (2) one real observed WhatsApp round trip (§26.2), (3)
`BUSINESS_NAME` fixed (§26.3), (4) the three placeholder knowledge files replaced or
emptied (§26.4). Calendar/booking (§26.5) and a durable process supervisor / real host
(§26.6) are real gaps but are **not required** for "real WhatsApp AI agent answering
real customers" — they only gate the appointment-booking tool and long-term uptime
respectively. Do not describe this system as "live" or "production-ready" until items
1–4 above are each independently verified, not assumed.
