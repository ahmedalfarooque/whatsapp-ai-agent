# Changelog

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
