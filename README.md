# WhatsApp AI Agent

A production-ready WhatsApp customer assistant: answers questions from your
business knowledge, remembers conversations, checks real Google Calendar
availability, books appointments, and runs on your own VPS behind HTTPS.

- **WhatsApp:** Meta WhatsApp Cloud API (webhook-based)
- **AI:** OpenRouter (any supported model, swappable via env var)
- **Memory:** SQLite (customers, conversations, messages, booking sessions)
- **Business knowledge:** Markdown/JSON files in `knowledge/`
- **Appointments:** Google Calendar API (service account)
- **Deployment:** Docker + docker-compose + Caddy (automatic HTTPS)

---

## 1. Architecture

```
Meta WhatsApp Cloud API
   │ webhook (GET verify / POST inbound events)
   ▼
Caddy (HTTPS, Let's Encrypt) ──▶ Node.js/Express app ──▶ SQLite (memory)
                                        │
                                        ├─▶ OpenRouter (LLM + tool calling)
                                        └─▶ Google Calendar (availability/booking)
```

Every inbound WhatsApp message:
1. Is verified (HMAC signature) and acknowledged with `200` immediately.
2. Is matched to a customer by their WhatsApp number (no manual ID needed).
3. Is checked against a restart keyword ("restart"/"reset").
4. Is run through an LLM tool-calling loop that can call `check_availability`
   and `book_appointment` against your real Google Calendar.
5. Gets a reply sent back over WhatsApp, and the full turn persisted in
   SQLite so conversation memory survives restarts.

See [`src/`](src) for the full module layout, or the plan this was built
from for design rationale.

## 2. Requirements

- Node.js 20+
- A VPS with Docker + Docker Compose installed, and a domain pointed at it
- A Meta developer account with a WhatsApp Cloud API app
- An OpenRouter API key
- A Google Cloud service account with the Calendar API enabled

## 3. Local development

> **Ports.** This application (API + dashboard + WhatsApp linked-device runtime) listens on **http://localhost:3000** (`PORT`). Anything on **localhost:3005** is the separate Antigravity/reference application and is not part of this project — do not use it for health checks, logs, or verification of this app.


```bash
npm install
cp .env.example .env      # fill in real or test values, see section 4
npm run dev                # tsx watch — auto-restarts on file changes
```

Run the test suite (fully mocked — no real credentials needed):

```bash
npm test
```

Typecheck, lint, and production build:

```bash
npm run typecheck
npm run lint
npm run build && npm start
```

## 4. Environment variables

Copy `.env.example` to `.env` and fill in every value. All required
variables are validated at startup (`src/config/env.ts`) — the app refuses
to start with a clear error if any are missing.

| Variable | Purpose |
|---|---|
| `WHATSAPP_CONNECTION_METHOD` | `qr` (default) for the direct WhatsApp Web / QR connection (no Meta credentials needed, see `docs/QR_CONNECTION.md`), or `meta` for the Meta WhatsApp Cloud API (see §5) |
| `WHATSAPP_ACCESS_TOKEN` | Meta Graph API token (see §5). Required in production only when `WHATSAPP_CONNECTION_METHOD=meta` |
| `WHATSAPP_PHONE_NUMBER_ID` | Your WhatsApp Business phone number ID (Meta mode only) |
| `WHATSAPP_VERIFY_TOKEN` | A string you choose; entered in the Meta webhook config (Meta mode only) |
| `META_APP_SECRET` | Used to validate incoming webhook signatures (Meta mode only) |
| `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` | LLM provider + model (see §6) |
| `GOOGLE_CLIENT_EMAIL` / `GOOGLE_PRIVATE_KEY` / `GOOGLE_CALENDAR_ID` | Service account + target calendar (see §7) |
| `BUSINESS_NAME`, `BUSINESS_TIMEZONE`, `BUSINESS_HOURS_START/END`, `BUSINESS_DAYS` | Business context used in the system prompt and availability calculation |
| `BOOKING_DURATION_MINUTES`, `BOOKING_BUFFER_MINUTES` | Default appointment length and buffer around existing events |
| `RESTART_KEYWORDS` | Comma-separated words that reset a conversation |
| `DOMAIN` | Your real domain, for Caddy's automatic HTTPS |
| `DASHBOARD_MASTER_KEY` | Required in **every** environment (dev/test/production) — encrypts the dashboard's credential-override store and gates dashboard sessions. Generate once with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. See below for the supported rotation procedure — do not just edit `.env` and restart, existing overrides would become unreadable. |

**Never commit `.env` or any real credential.** `.gitignore` already
excludes it.

Business-facing settings (hours, timezone, restart keywords, welcome/
fallback messages, cancellation policy, etc.) can also be edited live from
the dashboard's Settings page (§14) without restarting — a dashboard edit
overrides the `.env` value for that field only; clearing it there reverts
to `.env`. `BUSINESS_NAME`/`BUSINESS_TIMEZONE`/etc. in `.env` remain the
fallback and the seed values for a fresh install.

## 5. Setting up Meta WhatsApp Cloud API

This section applies only when `WHATSAPP_CONNECTION_METHOD=meta`. The default
`qr` transport needs none of it — see `docs/QR_CONNECTION.md`.

1. Create an app at [developers.facebook.com](https://developers.facebook.com/apps) → add the **WhatsApp** product.
2. Under **WhatsApp → API Setup**, note your **Phone number ID** and generate
   a token (start with the temporary token for testing; create a **System
   User** with a permanent token before going to production).
3. Under **App Settings → Basic**, copy the **App Secret** into
   `META_APP_SECRET`.
4. Deploy the app first (§9) so you have a live HTTPS URL, then under
   **WhatsApp → Configuration**, set:
   - **Callback URL:** `https://<your-domain>/webhook`
   - **Verify token:** the same value as `WHATSAPP_VERIFY_TOKEN`
   - Subscribe to the **messages** webhook field.
5. Send a WhatsApp message to your test number to confirm delivery.

## 6. Setting up OpenRouter

1. Create an account and API key at [openrouter.ai/keys](https://openrouter.ai/keys).
2. Set `OPENROUTER_API_KEY`. Set `OPENROUTER_MODEL` to any model id
   OpenRouter supports (e.g. `openai/gpt-4o-mini`, `anthropic/claude-3.5-sonnet`)
   — no code changes needed to switch models.

## 7. Setting up Google Calendar

1. In Google Cloud Console, create (or reuse) a project, enable the
   **Google Calendar API**, and create a **Service Account**.
2. Create a JSON key for that service account. Copy `client_email` into
   `GOOGLE_CLIENT_EMAIL` and `private_key` into `GOOGLE_PRIVATE_KEY` (keep
   the `\n` sequences as-is in the `.env` file — the app converts them to
   real newlines at startup).
3. Open the Google Calendar you want to use, **Settings and sharing →
   Share with specific people**, add the service account's email with
   **"Make changes to events"** permission.
4. Set `GOOGLE_CALENDAR_ID` to that calendar's ID (its email address, or
   `primary` if it's the service account's own calendar — usually you'll
   use a real business calendar's ID, found under that calendar's settings).

The app will never guess availability — it only reports slots the Calendar
API actually confirms as free, and re-checks immediately before booking to
avoid double-booking races.

## 8. Business knowledge

Everything the AI knows about your business lives in `knowledge/*.md` and
`*.json` — **not** in the source code. Edit these freely:

- `knowledge/business.md` — name, address, contact, hours
- `knowledge/services.md` — services and pricing
- `knowledge/policies.md` — cancellation/payment/other policies
- `knowledge/faq.md` — frequently asked questions
- `knowledge/booking.json` — which services require booking

The shipped files are clearly marked **EXAMPLE / PLACEHOLDER** — replace
them with your real business information before going live. The system
prompt (`src/llm/buildSystemPrompt.ts`) explicitly instructs the AI to only
use what's in these files and never invent prices, services, or policies.
After editing, redeploy/restart the app to pick up the changes (files are
loaded once at boot).

## 9. Deploying to a VPS with Docker

1. Point your domain's DNS **A record** at the VPS's IP address.
2. On the VPS, install Docker + Docker Compose, then clone this repo.
3. Create `.env` from `.env.example` with real production values, and set
   `DOMAIN=your-real-domain.com`.
4. Put your Google service account JSON key at `./secrets/` if you prefer
   file-based loading (the current build reads the key value directly from
   `GOOGLE_PRIVATE_KEY`/`GOOGLE_CLIENT_EMAIL` env vars, so this is optional
   — the directory is provided and mounted read-only for future use or if
   you adapt the code to read a key file instead).
5. Build and start:
   ```bash
   docker compose build
   docker compose up -d
   ```
6. Check logs:
   ```bash
   docker compose logs -f app
   docker compose logs -f caddy
   ```
7. Confirm HTTPS is live: `curl https://your-domain.com/health` should
   return `{"status":"ok"}`. Caddy obtains the certificate automatically on
   first request — this can take a few seconds.
8. Now go back to §5 step 4 and register the webhook URL with Meta.

### Persistent storage

The SQLite database lives at `./data/app.db` on the host (bind-mounted into
the container at `/app/data`), so conversation history survives container
restarts and rebuilds.

## 10. Operating the service

**Logs:**
```bash
docker compose logs -f app
```
Logs are structured JSON (pino) with request IDs, masked WhatsApp numbers,
operation names, and error categories — no secrets are ever logged (tokens,
keys, and signature headers are redacted).

**Restart the service:**
```bash
docker compose restart app
```

**Backup the database:**
```bash
docker compose exec app sh -c "cp /app/data/app.db /app/data/app.db.bak"
# or, from the host, since it's bind-mounted:
cp ./data/app.db ./data/app.db.$(date +%Y%m%d).bak
```

**Restore a backup:**
```bash
docker compose stop app
cp ./data/app.db.20250101.bak ./data/app.db
docker compose start app
```

**Update the application:**
```bash
git pull
docker compose build app
docker compose up -d app
```

**Health/readiness (used by Docker's HEALTHCHECK and can be probed manually):**
- `GET /health` — liveness (process is up)
- `GET /readiness` — readiness (database is reachable)

## 11. Restart / reset behavior

A customer can send `restart` or `reset` (configurable via
`RESTART_KEYWORDS`) at any time to start a fresh conversation. This ends
their current conversation and starts a new one — full history is retained
in the database for audit purposes, it's just no longer used as active
context for the AI.

## 11a. Admin dashboard

Visit `/dashboard` (root `/` redirects there). On first visit with no admin
account yet, you'll be prompted to create one (username + a password of at
least 12 characters) — this is only possible once; every later attempt is
refused. Logging in sets an httpOnly session cookie (12-hour sliding
expiry, 7-day hard cap). The dashboard is reachable in every environment,
including production, but every page and API route behind it requires that
authenticated session.

From the dashboard you can:
- View real customers, conversations, and bookings. `uncertain` bookings
  (the system couldn't confirm whether Google actually created the event —
  see the booking-reliability notes in `FINAL_STATUS.md`) can be manually
  reconciled from the Bookings page: **"Mark confirmed…"** records a real
  Google Calendar event ID you found by manually checking the calendar
  (never calls Google itself — it only records your finding), and **"Mark
  not booked"** releases the slot for a fresh attempt once you've manually
  confirmed no event exists. Neither action ever creates, retries, or
  queries anything on Google's side — the safety of the whole booking
  system rests on a human actually looking at the real calendar first.
- **Log out everywhere** (Settings page) revokes every active dashboard
  session at once (including your own) if you suspect a session or device
  was compromised.
- View and edit the allowlisted knowledge files (with automatic timestamped
  backups before every save).
- View and edit business-facing **Settings** (hours, timezone, restart
  keywords, welcome/fallback messages, cancellation policy, supported
  languages) — takes effect immediately, no restart, and can be reset
  per-field back to the `.env` value.
- View and set **credential overrides** for the WhatsApp/OpenRouter/Google
  keys under **Integrations**, without touching `.env` or restarting.
  Entered values are AES-256-GCM encrypted at rest (key derived from
  `DASHBOARD_MASTER_KEY`) and never returned to the browser — only a masked
  preview (`sk-t…7890`). Each credential has a real **Test connection**
  button that makes one bounded, real API call to confirm it actually
  works (WhatsApp: phone-number metadata; OpenRouter: `/auth/key`; Google:
  `calendars.get`) — the dashboard never claims "Connected" without one of
  these succeeding, and opening the page itself never calls any provider.

### Connecting the real WhatsApp number from the dashboard (no code edits)

The Integrations page also shows a **WhatsApp webhook** panel with the exact
callback URL Meta needs — computed live from the request that loaded the
page, so it can never drift from the actual `/webhook` route the app
implements. To go from a fresh deploy to a live connection:

1. Log in to `/dashboard` and open **Integrations**.
2. Enter your real `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`,
   `WHATSAPP_VERIFY_TOKEN`, and `META_APP_SECRET` and **Save** each.
3. Click **Test connection** on the WhatsApp row — this makes one real,
   bounded call to the Graph API to confirm the token and phone number ID
   actually work, and records a timestamped last-check result you can
   revisit later without re-testing.
4. Copy the **Webhook URL** shown in the WhatsApp webhook panel and, in
   Meta's App → WhatsApp → Configuration screen, set it as the **Callback
   URL** together with the same verify-token value from step 2, then click
   **Verify and save** — Meta calls this exact URL to complete the GET
   handshake.
5. Subscribe to the **messages** field, then send a WhatsApp message to
   your business number from a real phone.
6. Confirm the message appears processed (check `docker compose logs app`,
   or the dashboard's Conversations page) and that a reply arrives back on
   WhatsApp.

Until step 6 has actually happened with a real message, do not describe the
system as "live" — a successful Test connection or a verified webhook only
means configuration is correct, not that a real message has completed the
full round trip.

A dashboard credential override always takes precedence over `.env` for
that one key; clearing the override reverts to `.env`. Production's
startup-time required-credential check (`src/config/env.ts`) is
intentionally untouched by this — it still validates raw `.env` only, so a
production deployment must ship with valid real credentials in `.env` to
boot at all. The dashboard's override store is a **runtime rotation
mechanism on top of an already-valid deployment**, not a way to boot
production with an empty `.env`.

## 11b. Rotating DASHBOARD_MASTER_KEY

If the key needs to change (suspected compromise, routine security hygiene),
never just edit `.env` and restart — every existing credential override
would become permanently unreadable (fail closed, not a silent data loss —
`getSecret` would throw rather than return garbage). Instead:

1. Generate a new key: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
2. Stop the app (rotation must run uncontended against the same database file).
3. With the **current** `DASHBOARD_MASTER_KEY` still in `.env`, run:
   `NEW_DASHBOARD_MASTER_KEY=<the new key> npm run rotate-master-key`
   This decrypts every stored credential override under the old key and
   re-encrypts it under the new one, in one transaction — nothing is
   written until every row has decrypted successfully.
4. Update `DASHBOARD_MASTER_KEY` in `.env` to the new value.
5. Restart the app.

If you have no credential overrides configured (common for a dev/staging
setup that only uses `.env`-sourced credentials), the script reports there
is nothing to rotate and you can just update `.env` and restart directly.

## 12. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Meta webhook verification fails | `WHATSAPP_VERIFY_TOKEN` mismatch between `.env` and the Meta dashboard, or the callback URL isn't reachable over HTTPS yet |
| `401` on incoming webhook POSTs | `META_APP_SECRET` is wrong, or you're testing with a payload that wasn't signed with it |
| Agent replies with a generic error message | Check `docker compose logs app` — likely an OpenRouter/Google Calendar API failure; the specific error is logged (not shown to the customer) |
| Booking always reports a conflict | Check the target Google Calendar actually has the service account shared with edit access, and `GOOGLE_CALENDAR_ID` is correct |
| No reply ever arrives | Check `WHATSAPP_ACCESS_TOKEN` validity and `WHATSAPP_PHONE_NUMBER_ID`; check `docker compose logs app` for `failed to send WhatsApp text message` |
| Conversation memory seems lost after redeploy | Confirm `./data` is actually bind-mounted (check `docker compose config`) and not accidentally left as an anonymous volume |

## 13. Project structure

```
src/
  config/       env validation, constants
  webhook/      Meta signature verification, verify handshake, payload parsing, router
  whatsapp/     WhatsApp Cloud API client (send messages)
  pipeline/     message processing orchestration, idempotency, per-customer locking
  memory/       SQLite connection, migrations, repositories
  llm/          OpenRouter client, system prompt, tool-calling loop
  tools/        check_availability / book_appointment tool implementations
  calendar/     Google Calendar auth, timezone helpers, availability, booking
  knowledge/    knowledge-base loader
  restart/      restart-keyword detection
  health/       /health and /readiness endpoints
  utils/        retry/timeout helpers
knowledge/      business knowledge files (edit these, not code)
tests/          unit + integration tests (all external services mocked)
```
# Working with multiple AI apps

Codex and Claude Code read the shared instructions in `AGENTS.md` / `CLAUDE.md`.
Run `npm run sync:check` for the latest writer, handoff and unexplained changes.
See [.project-sync/PROTOCOL.md](.project-sync/PROTOCOL.md) for start/checkpoint/finish
commands and [.project-sync/COWORK.md](.project-sync/COWORK.md) for Cowork folder binding.
Only one participating agent writes at a time; all use this same live checkout.
Run `npm run sync:test` to verify the helper. Cowork native instruction activation and
a fresh Claude Code session remain unverified; local hook simulations pass.
