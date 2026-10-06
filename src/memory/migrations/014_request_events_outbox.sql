-- Two-way appointment / quotation workflow.
-- request_events: audit trail of every status transition (who, when, what was notified).
-- notification_outbox: every WhatsApp notification we owe (business alert, customer
-- confirmation …) with idempotency key, delivery state and retry bookkeeping, so a
-- dashboard action never blocks on WhatsApp and a disconnected session never loses a message.
CREATE TABLE IF NOT EXISTS request_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL,
  reference TEXT NOT NULL,
  old_status TEXT,
  new_status TEXT NOT NULL,
  actor TEXT NOT NULL,            -- dashboard | whatsapp | system
  actor_detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_request_events_request ON request_events (request_id, id);

CREATE TABLE IF NOT EXISTS notification_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,             -- business_new_request | business_status | customer_status | operator_result
  request_id INTEGER,
  target_jid TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | sent | failed
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  message_id TEXT,
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON notification_outbox (status, next_attempt_at);

-- Optional dedicated staff number for alerts; empty = the linked business number's own chat.
ALTER TABLE business_settings ADD COLUMN staff_whatsapp_number TEXT;
