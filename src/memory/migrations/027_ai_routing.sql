-- Multi-provider AI routing (additive). Every business keeps today's behaviour (the built-in OpenRouter key and its own models) until an
-- administrator adds providers; the routing layer (src/llm/aiRouter.ts) tries ONE eligible route after another within a bounded budget.
--
-- ai_providers: an AI provider endpoint with its own key. whatsapp_account_id NULL = shared by every business (existing and future);
--   a row with an account id belongs to that business only. Keys are stored AES-GCM encrypted under the dashboard master key (the same
--   framing as credential_overrides; see src/config/secretStore.ts) and are never returned to the browser.
--   kind: 'openrouter' (OpenRouter; free models are recognised from the public catalog), 'openai_compatible' (Groq, Google AI Studio,
--   Cerebras, Mistral, ... any /v1/chat/completions endpoint), 'ollama' (a local Ollama on this host or a private network, no key).
--   models / vision_models / audio_models: comma-separated model ids for each task, in order of preference.
--   free_tier: the administrator's declaration that this key is a free tier with no billing attached (1) — in strict free-only mode a
--   provider declared as paid (0) is never used, and an OpenRouter model is used only when the catalog prices it at 0.
--   supports_tools: 0 = this provider cannot do tool calling, so it is never given a request that needs tools (no silent degradation).
CREATE TABLE IF NOT EXISTS ai_providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  whatsapp_account_id INTEGER,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('openrouter', 'openai_compatible', 'ollama')),
  base_url TEXT NOT NULL,
  key_ciphertext TEXT,
  models TEXT NOT NULL DEFAULT '',
  vision_models TEXT NOT NULL DEFAULT '',
  audio_models TEXT NOT NULL DEFAULT '',
  free_tier INTEGER NOT NULL DEFAULT 1,
  supports_tools INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 100,
  timeout_ms INTEGER NOT NULL DEFAULT 20000,
  notes TEXT,
  last_test_at TEXT,
  last_test_ok INTEGER,
  last_test_detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER
);
CREATE INDEX IF NOT EXISTS ai_providers_account ON ai_providers (whatsapp_account_id, enabled, priority);

-- ai_route_log: one row per route attempt (success, failure or skip) so staff can see which provider/model answered, how fast, and why
-- a route was not used. No prompt, key or customer text is ever stored here. Pruned to the last 14 days by the router.
CREATE TABLE IF NOT EXISTS ai_route_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  whatsapp_account_id INTEGER NOT NULL,
  task TEXT NOT NULL,
  provider_id INTEGER,
  provider_name TEXT NOT NULL,
  model TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'failed', 'skipped')),
  category TEXT,
  http_status INTEGER,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ai_route_log_account_time ON ai_route_log (whatsapp_account_id, created_at);

-- Per-business routing switches (shared defaults; a new business inherits them):
--   ai_free_only         1 = strict free-only: a route that may cost money is never used (fail-closed). Default ON.
--   ai_failover_enabled  1 = after a route fails, the next eligible route is tried at once (within the routing budget). Default ON.
ALTER TABLE business_settings ADD COLUMN ai_free_only INTEGER NOT NULL DEFAULT 1;
ALTER TABLE business_settings ADD COLUMN ai_failover_enabled INTEGER NOT NULL DEFAULT 1;
