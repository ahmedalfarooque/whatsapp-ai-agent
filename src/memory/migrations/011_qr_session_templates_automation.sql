-- Linked-device (QR) WhatsApp session state. Single row; the phone number is
-- whatever number actually scanned the QR code — never configured by hand.
CREATE TABLE IF NOT EXISTS whatsapp_qr_session (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  phone_number TEXT,
  jid TEXT,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  connected_at TEXT,
  disconnected_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO whatsapp_qr_session (id) VALUES (1);

-- Editable bilingual reply templates. default_* is the shipped text and is
-- never modified by the dashboard; draft_* is the unpublished edit; live_* is
-- the only column the WhatsApp reply resolver reads.
CREATE TABLE IF NOT EXISTS reply_templates (
  key TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  title_ar TEXT NOT NULL,
  title_en TEXT NOT NULL,
  default_ar TEXT NOT NULL,
  default_en TEXT NOT NULL,
  draft_ar TEXT,
  draft_en TEXT,
  live_ar TEXT NOT NULL,
  live_en TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published',
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS automation_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  auto_replies_enabled INTEGER NOT NULL DEFAULT 1,
  rule_replies_enabled INTEGER NOT NULL DEFAULT 1,
  ai_replies_enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO automation_settings (id) VALUES (1);

ALTER TABLE customers ADD COLUMN automation_paused INTEGER NOT NULL DEFAULT 0;
ALTER TABLE customers ADD COLUMN paused_at TEXT;
ALTER TABLE customers ADD COLUMN pause_reason TEXT;
ALTER TABLE customers ADD COLUMN last_menu_options TEXT;

CREATE TABLE IF NOT EXISTS reply_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER,
  wa_id TEXT,
  channel TEXT NOT NULL,
  kind TEXT NOT NULL,
  template_key TEXT,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reply_activity_created ON reply_activity (created_at DESC);
