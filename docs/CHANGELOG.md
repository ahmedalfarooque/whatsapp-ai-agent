# Changelog

## 2026-10-18 — Add provider form: known providers fill themselves in, custom ones are validated before Save
* **Cause of `validation_failed: check baseUrl, models`:** the "Custom OpenAI-compatible" preset has no endpoint and no models by design, those two fields sat inside a collapsed "More options" block, and the form had no checks of its own, so the server's generic field list was the only feedback.
* Known providers (OpenRouter, Groq, Google AI Studio, Cerebras, Mistral) fill the endpoint and their documented free-tier models as soon as they are selected or recognised from the key. A custom provider opens the block, marks Endpoint address and Models as required and shows inline messages before Save; the server serves its own validation rules to the form and returns readable messages, so both sides always agree. No DeepSeek preset was added: its official API is pay-per-use and no free endpoint could be verified.
* Free-only is unchanged and enforced: a provider added here stays out of routing until its free tier is confirmed.

## 2026-10-18 — free-tier confirmation, cooldowns that survive a restart, router visibility (migration 031)
* **Cooldowns persist** (`ai_route_cooldowns`): a provider that just reported exhausted quota, rate limiting or an outage is not called again by a restarted process until its cooldown ends. Retries stay bounded (`AI_ROUTE_MAX_ATTEMPTS`, `AI_ROUTING_BUDGET_MS`); when every route is cooling the message goes to the existing fallback + recovery path with no further provider calls.
* **Free tier must be confirmed** for any non-OpenRouter provider (`ai_providers.free_confirmed`): under strict free-only mode an unconfirmed endpoint is never routed (its price cannot be verified from a public catalog). The Super Admin (shared providers) or the business (its own) confirms it with one button; changing a provider's endpoint resets the confirmation. OpenRouter prices still come from its public catalog. Existing providers are grandfathered as confirmed.
* Super Admin Settings shows the route the next message would use (name only) and the router's observed last answer / last failure category per provider (never a guessed balance).
* Rollback: `git checkout -B master 7131cbd`, `npm run build`, restart `whatsapp-ai-agent` (the new table and column are harmless if left).

## 2026-10-15 — Ollama removed; OpenRouter as the shared Default; customer record in the prompt
* **Ollama removed** from the application (provider kind, preset, built-in local route, lean local prompt, compact-prompt path, `OLLAMA_*` settings, dashboard strings) and from the production host (service, binaries, models, `.env` lines, evaluation files); migration 030. Evidence and rollback: `docs/LOCAL_INFERENCE_EVALUATION.md`. Every provider endpoint must now be HTTPS.
* **OpenRouter as the shared Default**: Super Admin Settings can add the OpenRouter key already saved on the server to the Default list as an ordinary provider (the key never leaves the server); it replaces the built-in OpenRouter route for chat. A status line says whether an eligible model is configured and tested.
* **/readiness** now reports per-business AI health (eligible routes, last hour) and degrades honestly when no route is usable.
* **Customer record**: the prompt carries a bounded, verified record of the customer who is writing (identity on record, requests and status, callbacks, files, their older messages, dated), from this business's own data only; staff-only notes are excluded.

## 2026-10-15 — Super Admin Settings and the simplified account AI list
* **Super Admin Settings** (profile menu, Super Admin only; API `/api/dashboard/super-admin/ai`): manage the shared **Default** providers
  (add with a name and an API key, test, turn on/off, edit, reorder, remove with confirmation). Keys encrypted and masked; never shown to a business.
* **Per-business routing order** (migration 029, `ai_account_routing`): Default is one entry in every business's list; each business reorders
  it with its own providers, switches Default off for itself, and the router follows the saved order. New businesses inherit Default.
* **Providers & Legacy API page**: the long AI form and routing tables are replaced by a compact list (name, status, ▲ ▼ / Test / Turn
  on-off / Edit / Remove) with a two-field form (API / Agent name, API configuration); diagnostics sit in one collapsed block; the OpenRouter
  model overrides moved under "Advanced". Arabic and phone layouts checked in a browser.
* Built-in OpenRouter priority 50 → 500 (shared providers come first inside Default). A local Ollama provider is created switched off.
* Evidence for the local model: `docs/LOCAL_INFERENCE_EVALUATION.md`.

## 2026-10-14 — one-message fallback, callbacks, safe replay, five-minute escalation (cf46b76)
See `docs/RECOVERY_AND_ESCALATION.md`.

## 2026-10-14 — central AI router (c3856f6, e097c42)
See `docs/AI_ASSISTANT.md`.
