# Production Checklist

Work through this before/while going live. See `README.md` for the detailed
steps behind each item.

## Meta WhatsApp Cloud API

- [ ] Meta developer account + app created, WhatsApp product added
- [ ] WhatsApp Business phone number configured, `WHATSAPP_PHONE_NUMBER_ID` set
- [ ] Permanent/system-user access token generated (not the short-lived test token), `WHATSAPP_ACCESS_TOKEN` set
- [ ] `META_APP_SECRET` set from App Settings → Basic
- [ ] `WHATSAPP_VERIFY_TOKEN` chosen and set in both `.env` and the Meta webhook config screen
- [ ] Webhook Callback URL registered as `https://<domain>/webhook` and verification succeeded
- [ ] Subscribed to the `messages` webhook field
- [ ] Sent a real test WhatsApp message and received a real reply end-to-end

## OpenRouter

- [ ] `OPENROUTER_API_KEY` set (real key, not the test placeholder)
- [ ] `OPENROUTER_MODEL` set to the model you intend to run in production
- [ ] Confirmed the account has sufficient credit/rate limit for expected volume

## Google Calendar

- [ ] Google Cloud project created, Calendar API enabled
- [ ] Service account created, JSON key downloaded
- [ ] `GOOGLE_CLIENT_EMAIL` / `GOOGLE_PRIVATE_KEY` set from that key
- [ ] Target calendar shared with the service account email, "Make changes to events" permission granted
- [ ] `GOOGLE_CALENDAR_ID` set to the correct calendar id
- [ ] Manually verified `check_availability` against the real calendar returns correct free slots
- [ ] Manually verified a real booking appears on the calendar with correct time and timezone

## Business knowledge

- [ ] `knowledge/business.md` replaced with real business info (no "EXAMPLE"/"PLACEHOLDER" text remaining)
- [ ] `knowledge/services.md` replaced with real services and pricing
- [ ] `knowledge/policies.md` replaced with real policies
- [ ] `knowledge/faq.md` replaced with real FAQs
- [ ] `knowledge/booking.json` reviewed and matches which services actually require booking

## Application / infrastructure

- [ ] `.env` created on the VPS with all real production values (never committed to git)
- [ ] `DASHBOARD_MASTER_KEY` generated (`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`) and set in `.env` — required in every environment, the app refuses to boot without it
- [ ] First dashboard admin account created via `/dashboard` immediately after first deploy (setup is permanently refused after the first admin exists)
- [ ] `DOMAIN` set and DNS A/AAAA record for it points at the VPS
- [ ] `docker compose build` succeeds
- [ ] `docker compose up -d` runs cleanly; `docker compose logs -f app` shows no startup errors
- [ ] `https://<domain>/health` returns `{"status":"ok"}`
- [ ] `https://<domain>/readiness` returns `{"status":"ready"}`
- [ ] `./data` directory bind-mount confirmed persistent (restart the container, confirm conversation history survives)
- [ ] Duplicate webhook protection verified (resend the same message id, confirm no duplicate reply)
- [ ] Restart/reset command verified in a live WhatsApp conversation
- [ ] `npm test` passes locally / in CI before each deploy
- [ ] `npm run build` (TypeScript build) passes with no errors
- [ ] `docker compose build` (Docker build) passes with no errors
- [ ] Backup procedure tested at least once (copy `data/app.db`, confirm restore works)
- [ ] Log output reviewed to confirm no secrets (tokens, keys, signatures) ever appear in plaintext

## Security

- [ ] `.env`, `secrets/*.json` are gitignored and were never committed
- [ ] Webhook signature verification confirmed rejecting an unsigned/tampered request
- [ ] Rate limiting on `/webhook` confirmed active (`RATE_LIMIT_PER_MINUTE`)
- [ ] Ran `npm audit` and reviewed/addressed anything critical/high
- [ ] Confirmed `/api/dashboard/*` (other than `/auth/status|setup|login`) returns 401 without a session cookie
- [ ] Have a documented plan for who holds the dashboard admin password, and know the `npm run rotate-master-key` procedure before it's ever needed under pressure
- [ ] Reviewed any `uncertain` bookings in the dashboard before go-live traffic ramps up — none should exist on a fresh deploy, but confirm the reconciliation flow (Bookings page) is understood by whoever operates the account
