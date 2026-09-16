CREATE TABLE IF NOT EXISTS whatsapp_connection (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  webhook_url TEXT,
  sync_status TEXT NOT NULL DEFAULT 'not_configured',
  last_sync_at TEXT,
  last_sync_detail TEXT,
  display_phone_number TEXT,
  waba_name TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO whatsapp_connection (id) VALUES (1);
