-- migrate: foreign_keys=off
-- Multi-account / multi-business support. Additive and backward-safe:
--   * whatsapp_accounts is the new first-class entity; account 1 is created
--     from the existing single business (business_settings row 1 +
--     whatsapp_qr_session row 1) and keeps the existing auth directory.
--   * Tables with a hard "single row" or "single key" constraint are rebuilt
--     (same columns, same values, same ids) so they can hold one row per
--     account. SQLite cannot drop a CHECK/UNIQUE constraint in place.
--   * Every other business-owned table gets whatsapp_account_id DEFAULT 1,
--     so all existing rows belong to account 1 without touching their values.
-- The runner disables foreign keys around this file (see db.ts) because the
-- rebuilt tables are referenced by others; it verifies foreign_key_check
-- afterwards.

CREATE TABLE IF NOT EXISTS whatsapp_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  name_ar TEXT,
  business_category TEXT,
  connection_method TEXT NOT NULL DEFAULT 'qr',          -- qr | meta
  -- Relative to the data directory (dirname of DATABASE_PATH). Account 1 keeps
  -- the legacy 'baileys-auth'; new accounts use 'accounts/<id>/baileys-auth'.
  auth_dir TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  -- Linked-device identity + last known session state (moved from whatsapp_qr_session).
  phone_number TEXT,
  jid TEXT,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  connected_at TEXT,
  disconnected_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Account 1 = the existing business. Identity copied from the legacy session row.
INSERT OR IGNORE INTO whatsapp_accounts (id, name, name_ar, business_category, auth_dir, phone_number, jid, display_name, status, connected_at, disconnected_at, last_error)
SELECT 1,
       COALESCE((SELECT business_name FROM business_settings WHERE id = 1), 'Rowad Alfa Auto Care'),
       (SELECT business_name_ar FROM business_settings WHERE id = 1),
       (SELECT business_category FROM business_settings WHERE id = 1),
       'baileys-auth',
       s.phone_number, s.jid, s.display_name, COALESCE(s.status, 'idle'), s.connected_at, s.disconnected_at, s.last_error
FROM whatsapp_qr_session s WHERE s.id = 1;
-- Defensive: a database whose legacy session row is somehow missing still gets account 1.
INSERT OR IGNORE INTO whatsapp_accounts (id, name, auth_dir)
VALUES (1, COALESCE((SELECT business_name FROM business_settings WHERE id = 1), 'Rowad Alfa Auto Care'), 'baileys-auth');

-- Per-user account permissions. No rows for an admin = access to every account
-- (today's behaviour); rows present = restricted to those accounts.
CREATE TABLE IF NOT EXISTS admin_account_access (
  admin_user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  whatsapp_account_id INTEGER NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'manager',                   -- owner | manager | agent
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (admin_user_id, whatsapp_account_id)
);

-- ---- business_settings: id = whatsapp account id (drop the CHECK (id = 1)) ----
CREATE TABLE business_settings_v15 (
  id INTEGER PRIMARY KEY,
  business_name TEXT,
  business_timezone TEXT,
  business_hours_start TEXT,
  business_hours_end TEXT,
  business_days TEXT,
  booking_duration_minutes INTEGER,
  booking_buffer_minutes INTEGER,
  restart_keywords TEXT,
  conversation_history_limit INTEGER,
  welcome_message TEXT,
  fallback_message TEXT,
  cancellation_policy TEXT,
  human_escalation_info TEXT,
  supported_languages TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  open_router_model TEXT,
  business_name_ar TEXT,
  business_category TEXT,
  description_ar TEXT,
  description_en TEXT,
  address_ar TEXT,
  address_en TEXT,
  google_maps_url TEXT,
  latitude REAL,
  longitude REAL,
  friday_hours_start TEXT,
  friday_hours_end TEXT,
  location_notes_ar TEXT,
  location_notes_en TEXT,
  logo_document_id INTEGER,
  staff_whatsapp_number TEXT
);
INSERT INTO business_settings_v15 SELECT
  id, business_name, business_timezone, business_hours_start, business_hours_end, business_days,
  booking_duration_minutes, booking_buffer_minutes, restart_keywords, conversation_history_limit,
  welcome_message, fallback_message, cancellation_policy, human_escalation_info, supported_languages,
  updated_at, open_router_model, business_name_ar, business_category, description_ar, description_en,
  address_ar, address_en, google_maps_url, latitude, longitude, friday_hours_start, friday_hours_end,
  location_notes_ar, location_notes_en, logo_document_id, staff_whatsapp_number
FROM business_settings;
DROP TABLE business_settings;
ALTER TABLE business_settings_v15 RENAME TO business_settings;

-- ---- automation_settings: id = whatsapp account id ----
CREATE TABLE automation_settings_v15 (
  id INTEGER PRIMARY KEY,
  auto_replies_enabled INTEGER NOT NULL DEFAULT 1,
  rule_replies_enabled INTEGER NOT NULL DEFAULT 1,
  ai_replies_enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO automation_settings_v15 SELECT id, auto_replies_enabled, rule_replies_enabled, ai_replies_enabled, updated_at FROM automation_settings;
DROP TABLE automation_settings;
ALTER TABLE automation_settings_v15 RENAME TO automation_settings;

-- ---- reply_templates: one template set per account ----
CREATE TABLE reply_templates_v15 (
  whatsapp_account_id INTEGER NOT NULL DEFAULT 1,
  key TEXT NOT NULL,
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
  updated_by TEXT,
  PRIMARY KEY (whatsapp_account_id, key)
);
INSERT INTO reply_templates_v15 (whatsapp_account_id, key, category, title_ar, title_en, default_ar, default_en, draft_ar, draft_en, live_ar, live_en, status, sort_order, updated_at, updated_by)
SELECT 1, key, category, title_ar, title_en, default_ar, default_en, draft_ar, draft_en, live_ar, live_en, status, sort_order, updated_at, updated_by FROM reply_templates;
DROP TABLE reply_templates;
ALTER TABLE reply_templates_v15 RENAME TO reply_templates;

-- ---- customers: the same phone number may message several businesses ----
CREATE TABLE customers_v15 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wa_id TEXT NOT NULL,
  display_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  language TEXT,
  automation_paused INTEGER NOT NULL DEFAULT 0,
  paused_at TEXT,
  pause_reason TEXT,
  last_menu_options TEXT,
  menu_state TEXT,
  flow_data TEXT,
  reply_jid TEXT,
  whatsapp_account_id INTEGER NOT NULL DEFAULT 1,
  UNIQUE (whatsapp_account_id, wa_id)
);
INSERT INTO customers_v15 (id, wa_id, display_name, created_at, updated_at, language, automation_paused, paused_at, pause_reason, last_menu_options, menu_state, flow_data, reply_jid, whatsapp_account_id)
SELECT id, wa_id, display_name, created_at, updated_at, language, automation_paused, paused_at, pause_reason, last_menu_options, menu_state, flow_data, reply_jid, 1 FROM customers;
DROP TABLE customers;
ALTER TABLE customers_v15 RENAME TO customers;
CREATE INDEX IF NOT EXISTS idx_customers_account ON customers (whatsapp_account_id, updated_at DESC);

-- ---- account column on every other business-owned table (existing rows -> account 1) ----
ALTER TABLE conversations ADD COLUMN whatsapp_account_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_conversations_account ON conversations (whatsapp_account_id, status);
ALTER TABLE customer_requests ADD COLUMN whatsapp_account_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_customer_requests_account ON customer_requests (whatsapp_account_id, created_at DESC);
ALTER TABLE notification_outbox ADD COLUMN whatsapp_account_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_outbox_account ON notification_outbox (whatsapp_account_id, status);
ALTER TABLE reply_activity ADD COLUMN whatsapp_account_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_reply_activity_account ON reply_activity (whatsapp_account_id, created_at DESC);
ALTER TABLE business_documents ADD COLUMN whatsapp_account_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_business_documents_account ON business_documents (whatsapp_account_id, status);
ALTER TABLE offers ADD COLUMN whatsapp_account_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_offers_account ON offers (whatsapp_account_id, status, deleted_at);
