-- Per-business AI routing order (additive; nothing existing changes).
--
-- ai_account_routing: the ordered list of AI entries one business routes through. An entry is either the single "Default" entry
--   (entry_key 'default' = the shared provider pool the Super Admin manages, i.e. ai_providers rows with whatsapp_account_id NULL, plus the
--   server's built-in OpenRouter / local routes) or one of the business's OWN providers ('provider:<id>'). `position` decides the order the
--   router tries them (lowest first); `enabled` = 0 switches an entry off for this business only. Shared providers are never listed here:
--   they live inside Default, so a global change reaches every business without touching any business's own order.
-- Existing businesses get Default first, then their own providers by their old priority — the order the router used until now.
CREATE TABLE IF NOT EXISTS ai_account_routing (
  whatsapp_account_id INTEGER NOT NULL,
  entry_key TEXT NOT NULL,
  position INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER,
  PRIMARY KEY (whatsapp_account_id, entry_key)
);
CREATE INDEX IF NOT EXISTS idx_ai_account_routing_order ON ai_account_routing (whatsapp_account_id, position);

INSERT OR IGNORE INTO ai_account_routing (whatsapp_account_id, entry_key, position)
SELECT id, 'default', 1 FROM whatsapp_accounts;

INSERT OR IGNORE INTO ai_account_routing (whatsapp_account_id, entry_key, position)
SELECT p.whatsapp_account_id, 'provider:' || p.id,
       1 + (SELECT COUNT(*) FROM ai_providers q WHERE q.whatsapp_account_id = p.whatsapp_account_id AND (q.priority < p.priority OR (q.priority = p.priority AND q.id <= p.id)))
FROM ai_providers p WHERE p.whatsapp_account_id IS NOT NULL;
