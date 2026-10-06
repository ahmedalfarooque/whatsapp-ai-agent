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
