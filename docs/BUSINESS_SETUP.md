# Business setup, isolation, database audit and rollback

One application, one login, one database. Every WhatsApp account is a separate
business. This document covers how a business is set up from the dashboard, how
isolation is enforced, what the database looks like after migrations 015/016,
and — separately — how to roll back **code** and **data** in production.

## 1. Setting up a business (`#/accounts/<id>`)

| Tab | What it does |
|---|---|
| Business information | English/Arabic name, category, description, address, Google Maps link, location notes, opening hours (incl. Friday, days, time zone), contact phone/e-mail. Saved per account; unset stays unset ("Not provided") — a new business never inherits another business's hours, maps link or contact. |
| Business links | Any number of public URLs (website, Instagram, Facebook, TikTok, LinkedIn, YouTube, Google Maps, menu page, other). Add / edit / categorise / remove. **Read** fetches the public page (SSRF-safe: no private/loopback/metadata addresses, redirects re-checked, size/time capped). A page that cannot be read shows **Unavailable** with the reason (login wall, 403/404, DNS, certificate…); nothing is guessed. |
| PDFs & images | Account-scoped uploads under `data/accounts/<id>/uploads/` (random file names, extension + MIME + signature checks, 10 MB cap). PDFs get their text layer extracted (`pdf-parse`); scanned PDFs report "no readable text" (no OCR). Images keep a caption and purpose (logo, product, service, catalogue, promo, menu, storefront, certificate…). Each file shows type, processing status, upload date, view/download, delete. |
| Analyze & Generate | Reads **only this account's** profile, readable links, PDF text, image captions/purposes and existing offers, and prepares a **draft**. Nothing is live until it is applied. |
| WhatsApp menu | The menu structure of the business (≤ 9 entries, sub-menus, platform actions). Editable by hand; texts live in the Manual Reply Editor ("Business Menu"). |
| Manage account | Disable / enable, and **Delete** (typed `DELETE`). The original business (account 1) cannot be deleted. |

### Analyze & Generate — what is generated and why it cannot be invented

Draft content: introduction / short / detailed description (EN + AR), hours,
location, contact, services, products, categories/brands/colours, prices, offers,
FAQs, appointment / quotation / hand-off / out-of-hours text, a **category-driven
menu**, WhatsApp replies (main menu + one page per menu entry), and AI knowledge
entries.

Two layers, both grounded:

1. **Rule-based extractor** (always on): reads headings (Services, Products, Offers,
   FAQ, Policies, Opening hours, Contact…), bullet/table/"name — price" lines and
   Q/A pairs. Every item is a literal line of a source and keeps that line as
   `evidence`.
2. **AI extraction** (optional, OpenRouter): its JSON is schema-checked and every
   fact must carry a verbatim quote that is found in the cited source; a price must
   appear in that source; contact details must occur literally. Anything else is
   dropped and counted in the draft's warnings. If the AI is unavailable (not
   configured, mock mode, API error) the draft falls back to rules and says so.

Anything the sources do not state stays **null → "Not provided"** and is listed
under *Not provided / not found*. Offers are never published by the generator:
they are created as **draft offers** with `price_status = on_request` (a price
quoted by the source is noted in the description for staff to verify).

### Menu generation

`classifyBusiness(category, name)` → salon · clinic · restaurant · paint · auto ·
retail · generic. `buildMenu` picks the entries that profile suggests **and whose
content exists** (e.g. a paint store gets Products / Brands / Colours / Offers /
Price inquiry / Quote / Location / Contact / Talk to team only when brands/colours
and prices were found). The structure is stored per account in `account_menus`;
the original business keeps its built-in menu (`menuStatic.ts`). Appointment and
quotation flows of other businesses collect generic fields (name, service, date,
time, notes / name, service, details) — not car make/model/year.

### Apply modes

| Mode | Effect |
|---|---|
| Save as draft | Stages replies as **unpublished drafts** and offers as draft offers. Customers/AI see nothing new. |
| Merge (recommended) | Fills empty profile fields; refreshes replies you never edited (edited ones receive the generated text only as an unpublished draft); refreshes generated knowledge blocks unless a person edited them by hand; replaces the menu only if it was never customised. Text outside generated blocks is never touched. |
| Replace existing | Overwrites profile fields, knowledge files (**backed up first**), replies and menu. Requires typing `REPLACE`. |

Knowledge written by the generator sits in
`<!-- setup:begin v1 hash=… -->…<!-- setup:end -->` blocks (hash of the generated
text). A block whose hash no longer matches was edited by hand and is left alone
by Merge.

## 2. Isolation guarantees (and how they are tested)

* **Request scope** — every dashboard route runs in the account named by
  `X-Whatsapp-Account` (or in the path for `/accounts/:id/…`); the server validates
  existence (404) and per-user permission (403, `admin_account_access`). The browser's
  id is never trusted on its own.
* **Data** — customers, conversations, requests, outbox, activity, documents/images,
  offers, templates, settings, automation, menu, links, drafts all carry the account.
  Ids from another business resolve to "not found".
* **Files** — uploads `data/accounts/<id>/uploads/` (legacy shared files stay
  readable through the account-scoped row); WhatsApp session
  `data/accounts/<id>/baileys-auth/`; knowledge `knowledge/accounts/<id>/`.
* **AI context** — `buildSystemPrompt` uses only that account's profile, offers,
  documents, links and knowledge. Fixed leaks: `env.BUSINESS_PHONE/EMAIL`, the
  original business's confirmed Google Maps link, env opening hours and
  Rowad-Alfa-worded reply templates are used **only** for account 1.
* **Calendar tools** — Google Calendar is configured once, for the original
  business. `check_availability` / `book_appointment` are offered **only** to
  account 1's AI; other businesses take appointment requests through the menu flow.
* **WhatsApp** — one Baileys connection object per account; operator commands and
  dedupe keys are namespaced per account.
* Tests: `tests/unit/accounts/*`, `tests/unit/setup/*`, `tests/unit/automation/menuConfig.test.ts`,
  `tests/integration/accounts.e2e.test.ts`, `tests/integration/setup.e2e.test.ts`.

## 3. Database audit (migrations 015 and 016)

Run on a backup copy of the local `data/app.db` (read-only):

* `integrity_check = ok`, `foreign_key_check` = no violations, no orphan rows in any
  account-scoped table, no triggers/views, WAL mode.
* **015** (unchanged): created `whatsapp_accounts`, `admin_account_access`; rebuilt
  `business_settings`, `automation_settings` (`id` = account id), `reply_templates`
  (PK `(whatsapp_account_id, key)`), `customers` (`UNIQUE(whatsapp_account_id, wa_id)`)
  with `foreign_keys=off` and verified `foreign_key_check`; added
  `whatsapp_account_id INTEGER NOT NULL DEFAULT 1` + an index to conversations,
  customer_requests, notification_outbox, reply_activity, business_documents, offers.
* **016** (new, additive): `business_settings.contact_phone/contact_email`,
  `business_documents.purpose/caption/processing_error`, tables `business_links`,
  `setup_drafts`, `account_menus` — each with `whatsapp_account_id NOT NULL` and
  `REFERENCES whatsapp_accounts(id) ON DELETE CASCADE`, no default.

Findings (documented, not silently changed):

1. Tables extended by `ALTER TABLE … ADD COLUMN … DEFAULT 1` have no foreign key to
   `whatsapp_accounts` (SQLite cannot add one that way) and a code path that forgot to
   set the account would write into account 1. All repositories take an explicit id or
   the request context; tests assert this. The 016 tables avoid both problems.
2. Child tables (`conversation_messages`, `booking_sessions`, `booking_locks`,
   `request_events`) have no `ON DELETE CASCADE`; account deletion removes children
   first, in one transaction (tested, including rollback on failure).
3. `whatsapp_accounts.phone_number` is not unique — pairing the same number to two
   accounts is a configuration error that is not blocked by the schema.
4. Shared by design: `admin_users`, `admin_sessions`, `credential_overrides`,
   `whatsapp_lid_map` (LID↔phone), `webhook_events` (ids are namespaced per account),
   `whatsapp_connection` (Meta Cloud API config, original business only).

## 4. Deleting a business

Order: refuse account 1 and anything but the exact word `DELETE` → disable the
account (nothing can restart it) → log the phone out / close the socket / forget the
connection → one DB transaction deleting children before parents → only then remove
`data/accounts/<id>/` (session + uploads) and `knowledge/accounts/<id>/` (incl. backups).
If the DB step fails nothing is removed (the account stays disabled and unlinked — retry
the delete). Other accounts, admin users and shared tables are untouched.

## 5. Rollback strategy (code ≠ database)

`git checkout <old commit>` restores **code only**. After migration 015/016 the SQLite
file has a newer schema and data, and the old code is not guaranteed to run on it
(015 rebuilt four tables; the old code does `WHERE id = 1`, so it sees only account 1's
rows and silently ignores every other business's data). Treat code and data as two separate rollbacks.

**Before deploying (mandatory backups, all on the server, not in git):**

1. Stop writes: `systemctl stop whatsapp-ai-agent` (or `docker compose stop app`).
2. SQLite: `sqlite3 data/app.db ".backup 'backup/app-<date>.db'"` **or** copy `app.db`,
   `app.db-wal`, `app.db-shm` together while stopped.
3. WhatsApp sessions: `tar czf backup/baileys-<date>.tgz data/baileys-auth data/accounts/*/baileys-auth`
   (these ARE the WhatsApp logins; keep them private).
4. Uploads: `tar czf backup/uploads-<date>.tgz data/uploads data/accounts/*/uploads`.
5. Knowledge: `tar czf backup/knowledge-<date>.tgz knowledge` (includes `knowledge/accounts/`).
6. Record the schema state: `sqlite3 data/app.db "select id from schema_migrations order by id desc limit 3"`.

**Rollback cases**

| Situation | Action |
|---|---|
| Bug found before any new data was created | Stop service → restore `app-<date>.db` (+ remove `-wal/-shm`) → check out the old commit → `npm ci && npm run build` → start. |
| Bug found after businesses/uploads/menus were created | Do **not** restore the old DB blindly (it loses that data). Roll forward with a fix, or restore the backup **and** re-create the new businesses' data from the later backups of `data/accounts/*`, `knowledge/accounts/*`. |
| Only the new UI/feature is wrong | Redeploy the previous *build* but keep the new database: 015/016 are additive for the original business, and the old code reads account 1 normally (other businesses stay invisible until you roll forward). Do not run old code against a database where businesses ≥ 2 are live and customers are messaging them: their WhatsApp sockets would not start and messages would go unanswered. |
| Uploaded-file rollback | Restore `uploads-<date>.tgz`; DB rows reference random names, so the DB and file backups must be from the same moment. |
| Knowledge rollback | Restore `knowledge-<date>.tgz`; dashboard saves also keep timestamped copies in `knowledge/**/.backups/`. Generated blocks are replaceable by re-applying a draft. |
| Baileys session rollback | Restore `baileys-<date>.tgz` with the service stopped. A session restored after WhatsApp rotated its keys may be rejected (code 401) and need a new QR scan. |

Migrations are forward-only by design (`schema_migrations`); there is no down-migration.
The application does **not** back up the database before migrating — the manual backup in
step 2 above is the only safety net, so take it every time and keep it until the release is verified.

## 6. Production deployment plan (not executed)

1. Backups (§5). 2. `git pull` the reviewed commit; `npm ci`; `npm run build`.
3. `systemctl restart whatsapp-ai-agent` — migrations 015/016 run at boot.
4. Verify: `/health`, `/readiness`, dashboard sidebar shows account 1 **connected**
   with no re-pairing, `foreign_key_check` clean.
5. Create each additional business, scan **its** QR with **its** phone, run
   Analyze & Generate, review, apply (Merge).
6. Watch logs for `[WA-INBOUND]` per account for the first messages.

## 7. Operational notes

- **PDFs uploaded before PDF text extraction existed** keep `processing = unsupported` and are
  listed under *Sources we could not read* until you open Business setup → PDFs & images →
  **Re-read text**. Nothing re-reads them automatically; the file itself is untouched.
- **`openrouter/free`** is OpenRouter's auto-router: every call may land on a different free
  model (occasionally a classifier that returns an empty reply). For consistent replies pin a
  specific chat model in Settings → AI. Credentials entered in the dashboard take precedence over
  `.env`; use the dashboard's **Test connection** to confirm which one is live.

## 8. Dashboard UI: what is core and what is optional

**Core (required by the multi-account + business-setup feature; ships with it):**
`dashboard/pages-accounts.js`, `dashboard/pages-setup.js`, the account switcher and
`X-Whatsapp-Account` plumbing in `dashboard/app.js`, the sidebar account list / "Add WhatsApp
account" / scope chip in `dashboard/index.html`, the tenancy wording and account-aware reply
preview in `dashboard/pages-automation.js`, and in `dashboard/theme.css` the token set (§1–§2),
the account switcher, "WhatsApp accounts" and "Business setup workspace" blocks and the
responsive rules the setup page relies on (the setup CSS is written against the new tokens, so
the token layer cannot be split out without rewriting it).

**Optional redesign groundwork (present, harmless, not finished):** the flat dashboard overview
in place of the marketing hero, the hairline KPI strip, the skip link, and the mobile off-canvas
navigation drawer (`#nav-toggle` / `#nav-scrim`). **Not done:** replacing text glyphs with an SVG
icon sprite, per-page polish, and a full detector/accessibility pass. These can be continued or
reverted independently of the setup feature — nothing in the backend depends on them.
