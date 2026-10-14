# Unanswered messages, safe replay and the five-minute escalation

## What the customer sees when the assistant cannot answer
ONE automated message, labelled as automated, with at most three numbered choices (a callback, "Call us now" with the business's own
phone, and "Manage my callback request" only when one is open). The closed variant adds the next opening. Inside the same 10-minute window
nothing is repeated: no second notice, no second menu. The customer's question is recorded as *waiting for an AI answer*.

## Callbacks from WhatsApp
`1 Request a callback` asks one question: `1 as soon as possible` or `2 choose a date and time` (validated in the business time zone and
its hours). The contact method follows the customer's last choice (phone call unless they asked for a WhatsApp message before); the
appointment type is not asked. The request is saved before it is confirmed (reference `CB-…`); a repeat within two minutes is the same
request. `cancel` (or the manage choice) lists the customer's own open requests; choosing one offers **cancel** or **change the date and
time**, which moves the same request. The dashboard Callbacks page and its statuses are unchanged.

## Safe replay (table `pending_replies`, migration 028)
A text message that reaches the AI step is recorded (no text is copied; the words stay in `conversation_messages`). It becomes:
`answered`, `abandoned` (superseded / a person took over), `needs_staff`, `awaiting_ai` (no route worked), or `interrupted` (cut short by a
restart). A background pass every 2 minutes replays `awaiting_ai` / `interrupted` messages **only when**:

* an AI route is usable again (strict free-only and cooldowns already applied), and the message is under 6 hours old;
* nobody answered after it (the automated notice does not count), no person owns the customer, no tool ran after it,
  automatic AI replies are on, and the customer is not inside a guided flow;
* it is the customer's newest waiting message (one answer covers older ones), under 3 attempts, one replay at a time (atomic claim).

A replay that fails again sends nothing. A replay cut short by a restart goes to staff and is never repeated automatically. The answer
goes out through the account's own live WhatsApp socket. The dashboard (Providers → AI routing → *Unanswered messages and escalations*)
shows waiting / recovered / left-for-staff counts without any customer text.

## Five-minute escalation (table `escalations`)
A waiting message, or an unassigned "as soon as possible" callback, still unresolved five minutes later **while the business is open**
is escalated once: a ringing staff notification, a staff WhatsApp alert, and a voice-call record.

## Automatic voice call: disabled, and why
WhatsApp Web (Baileys) cannot place SIM or mobile-network calls; every telephony API charges per minute; no customer consent record or
zero-cost authorized path exists. The record says `unavailable` with that reason and **no call is ever placed**. No-cost alternatives:
staff are alerted immediately and call from the dashboard (opens the phone dialler); the customer can call the number shown to them.
A verified zero-cost path would be added in `src/escalation/voiceCall.ts` only, behind consent and a valid configured number.

## Local model
`qwen2.5` 1.5B / 3B on the Oracle host were measured with the lean prompt (`src/llm/localPrompt.ts`, ~700-1000 tokens): first token
13-40 s while the app was serving traffic, answers with garbled characters and unverifiable hours. They do **not** meet the latency /
quality bar, so the local route stays off. If enabled later, the router gives it the lean prompt and no tool schemas.
