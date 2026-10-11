# Human handoff, staff takeover and the unified inbox

A customer can ask for a real person, and an authorised staff member can take the conversation over from the dashboard. While a
person owns the conversation the assistant stays silent for that customer. This is enforced on the server in the message pipeline,
not by hiding buttons.

**Not included (separate, later task): notification delivery.** Nothing alerts staff when a customer asks for a person: no SMS,
call, push, e-mail or chat alert, and no new provider. Staff look at **Human Support Queue** in the dashboard.

## States

```
AI_ACTIVE ──request──▶ HUMAN_REQUESTED ──accept──▶ HUMAN_ACTIVE ──resolve──▶ RESOLVED ──return──▶ AI_ACTIVE
```

| State | Assistant answers? | Meaning |
|---|---|---|
| `AI_ACTIVE` | yes | normal operation (also the end state of a handoff row) |
| `HUMAN_REQUESTED` | no | the customer (or the assistant, or the menu) asked for a person; waiting for staff |
| `HUMAN_ACTIVE` | no | a staff member (`assigned_admin_id`) owns the conversation |
| `RESOLVED` | no | staff finished; the assistant stays quiet until the conversation is explicitly returned to it |

`human_handoffs` (migration `020_human_handoffs.sql`, additive) holds one row per handoff of one customer of one WhatsApp account.
A unique index allows **one open handoff per customer**, so a repeated request only updates `request_count` / `last_requested_at`
(even when two requests race). `human_handoff_events` is the audit trail (who did what, when); `human_handoff_messages` holds the
replies staff typed, one row per client message id. Customers already paused before this version become `HUMAN_REQUESTED`
handoffs; the older `customers.automation_paused` flag is kept in step and is still honoured.

## How a customer asks

`src/handoff/intent.ts` (`detectHumanHandoffIntent`) is one pure decision, tested on its own. It understands English and Arabic from
the words around a request, not a fixed phrase list: a request cue (speak, want, connect, أبغى, أريد …) close to a person noun, with
negations, third parties, thanks, jobs and look-alikes ("real estate agent", "contact person", "someone to manage my property")
ruled out. The old exact keywords (`agent`, `human`, `موظف`, `خدمة العملاء` …) still work everywhere. Inside a guided request
(name, date, notes …) only the exact keywords count, so an answer is never mistaken for a request. Menu option "Talk to our team"
and the assistant's own `request_human_handoff` tool (for phrasing the detector does not catch) create the same handoff.

The customer gets the existing hand-over message once. Asking again only updates the handoff.

## Silence is enforced in three places

1. `processInboundMessage` checks the handoff first: a held customer gets no menu, template or AI reply (their messages are still stored).
2. After the AI call returns, ownership is read again from the database **before anything is stored or sent**: an answer written while
   staff pressed "take over" is dropped (also when the model call failed).
3. Every outbound template send re-checks, so a takeover pressed between two bubbles of one reply stops the rest.

A customer who is only *waiting* can leave by asking for the menu or starting over. One a person is *handling* cannot take the
conversation back; only staff can return it. After `RESOLVED` a new request reopens the handoff for staff.

## Staff

Dashboard → **Human Support Queue**: waiting / in progress / resolved, **Accept**, **Open**, **Return to AI**. The conversation page
shows the handoff state and a **Take over this conversation** button. The handoff page shows the history, lets the owner reply, and
has **Mark resolved** and **Return to AI**.

| Action | Needs |
|---|---|
| see the queue and a handoff | `support` (view) |
| accept, resolve, return, take over | `support` (edit) |
| act on a conversation another person owns | `support` (manage) |
| read the chat history | `conversations` (view) |
| reply to the customer | `support` (edit) + `conversations` (view), and being the owner (or `support` manage) |

No privilege is added to any role: the existing features and levels are used as they are. Everything is scoped to the selected
account; a handoff id from another account is "not found".

API (all under `/api/dashboard`): `GET /handoffs?state=waiting|active|resolved|open`, `GET /handoffs/:id`,
`POST /handoffs/:id/accept|resolve|return-to-ai|reply`, `POST /customers/:id/take-over`. The older
`POST /customers/:id/pause|resume` now run through the same rules.

### Replies

`POST /handoffs/:id/reply` with `{ text, clientMessageId }` (1–4000 characters; the id is 8–64 letters, digits, `-`, `_`).
It sends through the existing connection of that account (the linked-device QR socket, or the Cloud API for a Meta account). The same
`clientMessageId` twice is one message. A message is stored in the conversation, and reported `sent`, only after the connection accepted
it. A failure is `failed` (502/503) and may be retried with the same id; a send whose outcome is unknown is never sent a second time.

## Unified inbox (Conversations)

**Dashboard → Conversations** is the one place for every conversation of the selected WhatsApp account, whoever is handling it (the
assistant, waiting for staff, a staff member, resolved). It reads the existing `customers`, `conversations`, `conversation_messages` and
`human_handoffs` tables (no new table, no migration); every action is the existing handoff action above.

- **List** (`GET /api/dashboard/inbox`): one row per customer with name, masked number, latest message preview (who sent it: customer,
  AI, automatic reply or staff), time, handling state, handler, and "Awaiting reply". Newest activity first; "Waiting for staff first"
  and the Waiting chip (with a count) make customers waiting for a person easy to find. Search (name or number, Arabic digits
  accepted), filters (all / waiting / with staff / AI active / resolved / awaiting reply), assignee (me / unassigned) and paging
  (25 per page, 100 maximum) are all done by the server in two queries, scoped to the selected account.
- **Conversation** (`GET /api/dashboard/inbox/customers/:id`): the customer's messages across their conversations, newest 50 with
  "Load earlier messages", each labelled Customer / AI assistant / Automatic reply / Staff — name; media shown as its kind plus
  caption. Staff reply, accept, resolve, return to AI and take over are the handoff buttons, with the same ownership and permission
  rules. A staff reply shows **Sent** (accepted by the WhatsApp connection) — WhatsApp delivered/read receipts are not stored, so none
  is shown, and the page says so. The model has no per-user read marker, so there is no unread counter: "Awaiting reply" means the
  customer's message is the latest in the thread.
- **Refresh**: the page asks `GET /api/dashboard/inbox/pulse` (one tiny query) every 6 seconds and reloads the list and the open
  conversation (only messages newer than the last one it has, merged without duplicates) only when something changed. Hidden tabs make
  no requests; after a failure it backs off (12 s, 24 s … 60 s), shows "Connection problem — retrying" with a Retry button, and a
  "Reconnected" note when it recovers. This is polling, not a push channel: updates arrive within a few seconds, not instantly.
- **Permissions**: needs `conversations` (view). The full customer number is added only for `customers` (view), staff names and the
  assignee filter only for `support` (view); actions need what the handoff section lists. Another account's customer is "not found",
  indistinguishable from one that does not exist.
- Old links keep working: `#/conversations/<conversation id>` and `#/handoffs/<id>` open the customer's conversation.
## Compatibility

QR sessions are not touched: no rescan, no re-pairing, no change to Baileys or to the Meta webhook path. Existing accounts keep
their settings, history and AI configuration; the menu, templates and AI are unchanged for customers who are not held.
