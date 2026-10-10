# Connect WhatsApp with a QR code (Baileys linked device)

The active WhatsApp channel is a **linked device**, exactly like WhatsApp Web:
the server opens a WebSocket session to WhatsApp using
[`@whiskeysockets/baileys`](https://github.com/WhiskeySockets/Baileys), shows a
QR code in the dashboard, and the phone that scans it becomes the agent number.
No Meta developer account, WABA, phone-number ID, access token, webhook, app
secret or business verification is involved. No browser/Puppeteer/Chromium is
used on the server.

## Connecting

1. Start the server (`npm run build && npm start`, or `npm run dev`). On boot it
   restores a saved session if one exists; otherwise it starts pairing so a QR
   is ready as soon as you open the dashboard.
2. Sign in to `/dashboard` and open **WhatsApp Connection**.
3. On the phone: WhatsApp → Settings (⋮ on Android) → **Linked devices** →
   **Link a device** → scan the code. The page polls and moves through
   *Waiting for scan → Connecting → Connected* on its own.
4. The **Active number** shown is read from the authenticated session
   (`sock.user.id`), never typed in or hard-coded. Log out & unlink, then scan
   with another phone, and that number becomes the agent number instead.

QR codes rotate roughly every 20–60 s; after five unscanned codes the
connection stops and the page shows **QR code expired — Refresh QR**.

## What happens to messages

```
messages.upsert (Baileys, type "notify")
  → skip fromMe / groups / status@broadcast / undecryptable stubs
  → resolveIdentity(): replyJid = key.remoteJid AS RECEIVED; customer = phone JID
      (key.senderPn, or the LID→phone pairing stored in whatsapp_lid_map)
  → claimWebhookEvent("qr:<message id>")        ← duplicate protection (retries, re-deliveries)
  → messages older than 10 min (offline backlog after a reconnect) are stored as
    "suppressed" and never auto-answered
  → processInboundMessage(...)                  ← the shared pipeline
       store inbound → automation settings → human-handoff pause → restart ("restart", "00")
       → guided menu router (menuRouter.ts) → free text → AI
  → every reply bubble is stored in the conversation, then sent through the
    same socket (replyTransport) to replyJid
```

### Why the reply address is never rewritten

WhatsApp now addresses many personal chats by an opaque **LID** (`…@lid`) and
only sometimes attaches the phone JID as `key.senderPn`. Baileys keys the
Signal session by the address a message arrived on. Replying to the *phone*
JID instead opens a second session: the customer's next message then fails
with `Bad MAC`, WhatsApp retries it 6-7 s later (the "delay"), the retry has
no `senderPn` (so a second customer record appeared), and eventually the
phone shows "Waiting for this message". So: **reply to `remoteJid` exactly**,
and use `senderPn` / `whatsapp_lid_map` only to identify the customer.

### Guided menu

Numbers route by the customer's `menu_state` (MAIN_MENU, SUBMENU_*,
APPOINTMENT_STEP_n, QUOTATION_STEP_n, AWAITING_LANGUAGE_SWITCH). The option
number → action table lives in `src/automation/menuRouter.ts`; **all
customer-facing text lives in the editable templates** and is sent verbatim —
the sender adds no option lists or footers. Arabic-Indic numerals are
normalised. Universal commands: `0`/menu/القائمة/back/greetings → main menu;
language/اللغة → language switch; agent/موظف → human handoff; restart/00 →
full reset. Free text that is not a number or command goes to the AI.

These three behaviours apply to **every** business (the original one, the
second one, and any added later) — they live in the shared pipeline, not in a
per-business setting:

- **Change language is always on the main menu.** The main menu is rendered
  with a permanent line `0️⃣ 🌐 Change language` / `0️⃣ 🌐 تغيير اللغة` in the
  customer's language (`src/templates/languageOption.ts`, applied by the one
  shared renderer, so the dashboard preview matches). Sending `0` on the main
  menu opens the language choice; in a sub-menu or a flow `0` still means "back
  to the main menu". The words `language` / `تغيير اللغة` work from anywhere.
  Switching only changes the language: the conversation and its history are kept.
- **Only plain text is answered.** A voice note, audio, photo, video, document
  or file of any kind, sticker, location, contact, reaction, poll or edit gets
  **no automatic reply at all** — no apology, no menu, no AI
  (`src/whatsapp/messageKind.ts` classifies Baileys payloads, including
  disappearing and view-once wrappers). Media is stored in the conversation as
  `[voice]`, `[image] caption` … for staff, who can still reply by hand. A caption
  under a photo is shown to staff but is not answered as customer text.
- **Free text is understood by the AI.** Anything that is not a menu number,
  command, catalogue pick or flow answer goes to the AI with that business's own
  profile, knowledge, documents, offers, catalogues and menu. A new customer's
  first message that is a real question (a question mark, or three or more
  words) is answered in the language it was written in instead of being stopped
  at the language prompt; greetings and fragments keep the welcome.
- **Web search** (`web_search` tool) lets the assistant look up *current public*
  information when the business's own sources do not answer. Source order:
  business profile and data → knowledge and documents → catalogues and linked
  official pages → web → general knowledge. It is never used for the business's
  own prices, stock, hours, phone, address or offers. The query is stripped of
  e-mail addresses and phone numbers; the search page and every result page are
  read through the same guarded fetcher as business links (public hosts only,
  private/internal/metadata addresses refused); each business is rate limited.
  Set `WEB_SEARCH_ENABLED=false` to switch it off everywhere. The default search
  source is the public Bing results page; swap the provider in
  `src/tools/webSearch.ts` (`setWebSearchProvider`) to use a paid search API.

## Connection page actions (dashboard → WhatsApp Connection)

| Button | Does | Never does |
|---|---|---|
| **Connect** | Opens the socket when nothing is running (QR appears in a few seconds). | — |
| **Refresh QR Code** | Drops the *pairing* socket and opens a new one → fresh QR. When already connected it only reports "already connected". | Log out, delete credentials, open a second socket. |
| **Refresh Status** | Re-reads the backend state (phase, number, owner pid, socket generation). | Generate a QR or touch the session. |
| **Retry Connection** | Shown only when reconnecting/disconnected/error/stuck: cancels the pending backoff and reopens ONE socket with the saved session. | Reset the database or auth store. |
| **Log out & unlink** | Confirmation-gated: `sock.logout()` + delete `data/baileys-auth`; a different phone can then scan. | — |

States shown: Not connected · Preparing session · QR code ready — waiting for scan · QR expired · Pairing / connecting · Connected · Reconnecting · Disconnected · Logged out — authentication required · Connection error. WhatsApp routinely closes idle sockets with code **428**; the first reconnect is attempted after 1 s (backoff only if it keeps failing). Code **515** right after a scan is normal ("restart required") and is shown as *Pairing*, not as an error. The Baileys version lookup is capped at 5 s so the page can never sit on "Preparing session" because of a slow network call.

Diagnostics (runtime panel + `GET /api/dashboard/whatsapp/qr → diagnostics`): pid, port, working directory, socket generation, active socket count, auth-store owner pid (`data/baileys-auth.owner.json`), last QR event, last connection event, last disconnect code, socket-open time, drops in the last 10 minutes (`networkUnstable` once there are 3), and where the WhatsApp Web version came from. Credentials are never included.

### Unstable network (codes 408 / 428 every minute or two)

Code **408** = no data from WhatsApp for 25 s (keep-alive lost); **428** = the server/TCP path closed the socket. Both are network-level; the saved session is still valid. Each close schedules exactly one reconnect (1 s, then 3 s → 60 s backoff). Three or more closes within 10 minutes flip `diagnostics.networkUnstable` and the page says so instead of "routine". On a reconnect the WhatsApp Web version is taken from `data/baileys-version.json` (last fetched value) instead of a GitHub round-trip, so a flapping network cannot add a 5 s stall per reconnect. Messages that arrive while the socket is down are delivered by WhatsApp on reconnect and answered normally (backlog older than 10 minutes is stored but not auto-answered).

### Code 401 (loggedOut)

WhatsApp itself invalidated the device (removed from the phone's Linked devices, or server-side). The credentials cannot be reused, so `data/baileys-auth/` is **moved** to `data/baileys-auth.loggedout-<timestamp>/` (last three kept, never copied elsewhere), the identity is cleared and the page shows **Logged out — authentication required** with last error `logged_out_by_whatsapp_401`. A new QR scan is the only way back; the code never decides this on its own.

**Ports:** this app = `http://localhost:3000`. `localhost:3005` is the separate Antigravity/reference application — never used to verify this app.

## Multiple WhatsApp accounts (businesses)

One application, one login, one database, one server — any number of
WhatsApp accounts. Each account is a separate business with its own linked
number, Baileys session, QR code, business profile, automation flags,
templates, customers, conversations, requests, offers, documents, knowledge
files and notification outbox. Nothing is shared between accounts except the
admin login, the WhatsApp Web version cache and the LID↔phone map (which is
a property of WhatsApp identities, not of a business).

- **Sidebar → WhatsApp Accounts** lists every account with its status
  (Connected · Connecting · QR required · Disconnected · Disabled · Error).
  Clicking one switches the whole dashboard to that business; the selection
  is remembered in the browser and sent on every request as the
  `X-Whatsapp-Account` header, which the server validates (unknown → 404,
  not permitted → 403). Requests without the header land on the original
  business (account 1), so older clients keep working.
- **Manage Accounts** creates a business (English/Arabic name, category),
  edits it, enables/disables it (disable closes the socket but keeps the
  saved session), and opens its connection page to scan its own QR.
- Account 1 is the original business: its session stays in
  `data/baileys-auth/`, its knowledge in `knowledge/`. Every other account
  uses `data/accounts/<id>/baileys-auth/` and `knowledge/accounts/<id>/`
  (both runtime data, gitignored). Migration 015 moved all existing rows
  under account 1 without changing their values; no re-pairing is needed.
- Each account's socket reconnects, handles 401/515, refreshes its QR and
  logs out independently. A message arriving on account B's socket is
  processed inside account B's context and answered through B's socket;
  staff alerts for B go to B's own number. Operator commands (`CONFIRM
  APT-…`) typed from a business phone act only on that business's requests.
- `admin_account_access` restricts an admin to specific accounts; an admin
  with no rows sees every account (today's single-owner behaviour).
- The numbered menu structure is per business: account 1 keeps its built-in
  structure (`menuStatic.ts`); every other business has its own menu
  (`account_menus`, edited in **Set up business → WhatsApp menu** or generated by
  Analyze & Generate) and starts from neutral reply wording — never from another
  company's text. See `docs/BUSINESS_SETUP.md`.
- Deleting a business (typed `DELETE`; never account 1) logs its phone out and
  removes its rows, `data/accounts/<id>/` and `knowledge/accounts/<id>/`.

### Offers: pictures and files reach the customer as real media

When a customer opens the **Offers** option (every business's menu routes to the same offers template), the offers text is sent
first. After it, each currently visible offer's **image** is sent as a real WhatsApp **image** and its **supporting file** as a real
WhatsApp **document**, one after another, each captioned with the offer title in the customer's language. Nothing is a link or a
path in the text, and the same Baileys connection that received the message carries the media.

- **What is sent:** only offers that are published, inside their validity window, customer-visible, and not draft, finished,
  archived or deleted — the same filter as the offers text. Files are looked up only among **that business's own** documents
  (`src/offers/offerFiles.ts`), so one business can never send, attach or preview another's file, whatever id is typed.
- **Saving an offer** now refuses an attachment that is another business's, internal or AI-only, archived, or (in the image slot)
  not a picture, and the Offers form shows why. An attachment that did not change is not re-checked, so older offers stay editable.
- **Safety at send time:** the stored file must exist, not be empty or over 16 MB, and match its type (PDF, PNG, JPG, WEBP, Office
  signatures); the storage path is confined to the business's uploads folder. A file that fails is skipped with a log line (offer and
  document ids only, never a path) and an activity-log entry; the offer text has already been sent and the other files still go.
- **Limits:** at most 12 files per request; any left out are reported as `over_limit`, never dropped silently. A file used by two
  offers is sent once. The Meta Cloud API connection cannot carry media: the text is delivered and a single note is logged.
- **Storage:** uploads live in the data folder next to the database (`<data>/uploads` for the original business,
  `<data>/accounts/<id>/uploads` for each other business), outside Git, and survive restarts and deployments.

### Which number is bound to which business

The number is never typed in: when a scan completes, the application reads the
signed-in identity from the live Baileys socket (`user.id`, falling back to the
saved credentials) and stores the normalised number, the JID and the display
name on **that** account's row. A LID-only identity is resolved to a phone
number through the stored LID mapping; without a mapping the number stays
unknown rather than guessed.

- A connection that opens **without** an identity is not marked connected and
  does not answer messages; it reconnects.
- One number belongs to one business. If a fresh scan completes with a number
  another business already holds (compared by phone number and by JID with the
  linked-device suffix removed), the new device is unlinked, only that account's
  new credentials are moved aside (`baileys-auth.duplicate-number-<time>`), the
  account shows **Connection error** with the reason, and nothing reconnects.
  The other business is not touched. Refresh QR and scan with the right phone.
- A saved session that reconnects with its recorded identity is never torn down
  by this check.

## Session files

Credentials live in `data/baileys-auth/` next to the SQLite database
(`useMultiFileAuthState`). They are the WhatsApp login for the linked number:
gitignored, never returned by any API, never copied between machines. Logging
out from the dashboard calls `sock.logout()` and deletes the folder. If
WhatsApp reports `loggedOut` (code 401), the folder is archived as
`data/baileys-auth.loggedout-<timestamp>/` and the dashboard shows **Logged
out**. Transient closes reconnect with exponential backoff (1 s, then 3 s → 60 s).

## Editable replies

Every automated message is a row in `reply_templates` with `default_*`,
`draft_*` and `live_*` columns. **Manual Reply Editor** saves drafts, publishes,
discards or resets; the reply resolver reads `live_*` only, so drafts are never
sent. The preview panel calls `POST /api/dashboard/templates/:key/preview`,
which runs the same renderer as the live sender and returns the follow-up
bubble the router always sends next (e.g. `invalid_option` → `main_menu`).
On boot, `ensureTemplateDefaults` upgrades the shipped *default* text and moves
*live* text only when it still equals the previous default; customised text
and drafts are never touched. Shipped defaults are the Rowad Alfa content
from the original Antigravity project, without numeric prices
(zero-fabricated-pricing rule): price options ask for vehicle details instead.

## Runtime requirements

- A persistent Node.js process (this PC, a VPS, Docker). Not Vercel/serverless.
- Writable `data/` for SQLite and `baileys-auth/`.
- Outbound HTTPS/WebSocket access to WhatsApp servers.
- `NODE_ENV=production` with the existing `.env`; OpenRouter is still required
  for AI replies (menu rules work without it).

Unofficial WhatsApp Web clients are not a Meta-approved onboarding path;
WhatsApp may change compatibility. The legacy Meta Cloud API code remains
under **Providers & Legacy API** but is not the active channel.

## Verification

`npm test`, `npm run typecheck`, `npm run lint`, `npm run build` cover the
connection lifecycle (Baileys mocked), JID/number extraction, duplicate
suppression, draft/live isolation and automatic-reply routing. Scanning the QR
with a real phone and sending a real message cannot be automated and must be
done manually.

## Appointment / quotation requests — two-way workflow

1. Customer completes main-menu 7 (appointment) or prices 4 (quotation) → row in `customer_requests` (APT-/INQ- reference), customer gets the confirmation template, and a **staff alert** is queued to the linked business number's own chat (or `staffWhatsappNumber` from Business Profile) with the full details and the reply commands.
2. Status changes go through ONE service (`src/requests/requestService.ts`): dashboard dropdown (Appointments page), operator WhatsApp command (`CONFIRM APT-2026-3777`, `REJECT`, `CANCEL`, `COMPLETE`, Arabic `تأكيد / رفض / إلغاء / إكمال`), or system. Every change writes `request_events` (old → new, actor, time).
3. The customer is told about each status **once** (idempotency key request+status) using the editable templates `request_confirmed / request_rejected / request_cancelled / request_status_update`, in their language, to the chat address they last wrote from (an `@lid` stays `@lid`).
4. All WhatsApp notifications go through `notification_outbox` (pending → sent/failed, attempts, next retry). Delivery never blocks the dashboard; the outbox is flushed after every change, every 30 s, and right after the session reconnects. Failed rows can be retried from the Appointments page.
5. Operator commands are accepted only from the business account itself (`key.fromMe`); a customer typing the same text is ordinary input. Repeated commands are answered with "already …" and never re-notify the customer.

`GET /api/dashboard/requests` returns each request with its events and notification states; `GET /api/dashboard/notifications`, `POST /api/dashboard/notifications/flush` and `POST /api/dashboard/notifications/:id/retry` manage the outbox.
