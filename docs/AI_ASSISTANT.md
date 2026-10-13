# The AI assistant: how a free-text message is answered

A customer's message reaches the assistant only when the guided menu has no rule for it (a number, a menu word, a language word, a
greeting or a request for a person are handled by the menu). Everything below is per account (business); nothing is shared between accounts
except the OpenRouter key.

## What the assistant is given (the system prompt)

Built fresh for every message from **this account's** data, in this order of authority:

1. the business profile (name, address, hours, phone, Google Maps, links) and current published offers;
2. the account's knowledge files (`knowledge/` for account 1, `knowledge/accounts/<id>/` for the others);
3. the account's uploaded documents and catalogues (the catalogue search tool, only for accounts with the library);
4. the official pages linked in the profile;
5. web search for genuinely current public information (never for the business's own prices, stock, hours, contacts or offers);
6. general knowledge only when it does not conflict with the above.

Knowledge files that are placeholders, example text or almost empty are given to the model behind a **NOT VERIFIED** warning (and shown as
*Placeholder* on the Knowledge page), so they are never stated as facts. The prompt also carries the current date and time in the business's
timezone and the reply rules (answer first, WhatsApp length, language, one follow-up question at most, no invented prices / stock / hours /
listings / policies, hand over to staff when the answer is not in the sources).

## Memory

- The model sees **one conversation**: the active conversation of this customer in this business. The same phone number talking to two
  businesses is two customers with two conversations; one customer never sees another's messages.
- Size bound: the latest `CONVERSATION_HISTORY_LIMIT` messages (default 20). Age bound: nothing older than `CONVERSATION_MEMORY_HOURS` (default
  72 h) is sent. Nothing is deleted by these bounds; the stored conversation stays in the dashboard.
- Only the real turns are replayed (customer messages and the assistant's answers). Past tool rounds are not replayed: the provider rejects a
  `tool` message without its original `tool_calls`, which used to make every later message of a conversation that had used a tool fail.
- What a customer said earlier is *context*, not a verified fact about the business; only the sources above are facts.
- Typing a restart keyword (default `restart`, `reset`, `start over`) ends the conversation and starts an empty one.

## Tools and limits

Tools offered per account: calendar check/booking (account 1 only), catalogue search (accounts with the library), web search (switchable with
`WEB_SEARCH_ENABLED`), and hand-over to staff (all). For every call:

- the arguments are validated against the tool's own schema before the handler runs; a malformed call returns "did not complete" to the model;
- an identical repeated call is answered from the first result and never executed twice;
- a tool that fails returns "the action did NOT complete" (no internal detail), and the prompt forbids claiming a booking, request or message
  succeeded unless the tool said so;
- a tool that is not offered to the account is refused, whatever the model asks for;
- the loop is bounded: `MAX_TOOL_ROUNDS` (default 4) and one time budget `AI_LOOP_TIMEOUT_MS` (default 60 s) shared by every provider call and
  retry.

Web search keeps its protections: public hosts only (DNS answers checked when connecting), redirects followed manually (max 4), size and time
caps, a per-account rate limit, personal data removed from the query, results treated as untrusted text.

## When the provider fails

A failed answer is never presented as a success: HTTP 200 with no text, a malformed body, a refused model (400-404), a rate limit or provider
error (after at most 2 retries; an empty answer is retried once), an exhausted tool-round cap or time budget. The customer receives the existing
neutral fallback message (and the human-hold rules still apply); the activity log records `AI failed; fallback sent (category, HTTP status,
model)`; the status pill turns red. Logs never contain the key, the prompt or the customer's words.

## Reply language (shared by every business)

The assistant answers in the language of the customer's **latest** message — Arabic, English, Malayalam, Hindi, Urdu, Chinese, French, Tagalog
or any other — and switches whenever the customer switches. A mixed message is answered in the main language of the question; brand, product,
model and place names, codes, part and phone numbers are never translated. The language a customer picks from the menu (`customers.language`,
`ar`/`en`) only selects the **menu and template texts**; it never locks the assistant's reply language (it used to: a customer who chose English
and then wrote Malayalam got English). The decision is made in `src/llm/language.ts` (`decideReplyLanguage`, script-based detection, no model
call) and written into the prompt as a `REPLY LANGUAGE:` line. A business that must always reply in one language sets
`business_settings.ai_reply_language` (Providers page, "Reply language override"); leaving it empty — the default for every new business — keeps
the shared rule.

## Pictures a customer sends

A photo is answered only after an image-capable model has looked at the actual picture: `src/llm/vision.ts` downloads the bytes once (the same
download also keeps the file for staff), sends them as a data URL to the account's **vision model** (`business_settings.open_router_vision_model`,
default `OPENROUTER_VISION_MODEL`) with a fixed analyst prompt, and stores the structured report (subject, identification, confidence, evidence,
visible text, uncertainties, clarifying question) beside the customer's message as a hidden `image_analysis` row. That report is the assistant's
only knowledge of the picture, in that turn and in follow-up questions ("and for the front bumper?") — the picture is never analysed twice. The
prompt's picture rules apply to every business: identify before advising, never recommend vehicle- or model-specific parts for a vehicle not
identified with high confidence, ask the clarifying question when year/trim/part number matters, never claim compatibility was verified, copy
codes and numbers exactly, and never guess a picture that was not analysed. If the download, the model, a timeout or a rate limit fails, the
stored note says the picture was NOT analysed and the assistant tells the customer it could not open it (one reply, nothing invented). Pictures
sent inside a guided request, while staff hold the customer, or with the assistant off are stored and not answered, as before. Documents, voice
notes and video are unchanged (stored for staff only). The mock provider never pretends to see a picture.

"Save & Test AI" on the Providers page probes the vision model with a 1x1 image and says whether it accepts pictures; the activity log records
`picture analysed in N s (model, confidence)` or `picture not analysed (reason)` and the total answer time for every AI reply.

## Every message ends in a recorded outcome

Each inbound message is claimed once (`webhook_events`, per account), serialised per customer, and leaves the pipeline as one of: replied
(`ai` / `rule` / `human_handoff` activity), intentionally suppressed (with the reason), or failed with the reason. Voice notes, audio, video, files,
stickers, locations and contacts cannot be read by the assistant: the customer is told so **once per 6 hours** with the editable
`unsupported_message` template (blank the template on the Templates page to switch this off for a business); further such messages in the window are
recorded as suppressed, never acknowledged again, and none of them ever reaches the AI or the menu. Pictures take the vision path above. At boot,
events claimed before a restart but never finished are marked failed ("interrupted by a restart") and an error row is written to the activity log,
so a cut-off message is visible to staff instead of silent. `/readiness` reports every enabled account's connection state (`degraded` when one
cannot receive messages) and the worker heartbeat (last inbound / last processed, per account), so "up but not working" is visible without logs.

## Models

The model is stored per account (`business_settings.open_router_model`). It must support tool calling **and**, if your OpenRouter account
enforces Zero Data Retention, have a ZDR-qualified tool-capable endpoint (see `docs/KNOWLEDGE_FILES.md`). Verified with this installation's key
and tool payloads: `openai/gpt-4.1-mini`, `google/gemini-2.5-flash`, `anthropic/claude-haiku-4.5`. `openai/gpt-4o-mini` and, intermittently,
`openrouter/free` are refused. Change a model on the Providers page (leave the key empty); never turn ZDR off to make a model work.

## How quality was checked

Each account was evaluated through the real pipeline (prompt builder, knowledge loader, agent loop, provider client) on a copy of the
production database, in English, Arabic and mixed messages: greeting plus question, hours and parking, price questions, booking, follow-up,
complaint (hand-over), catalogue colour advice, delivery/warranty, licence and commission questions. Pass = a non-empty grounded answer, a
clarifying question, a correct hand-over, or an honest "not available, here is the team" — never an invented price, stock, hour, policy,
listing or return, and never another account's fact. Provider success is not WhatsApp delivery: no message was sent to a customer.
