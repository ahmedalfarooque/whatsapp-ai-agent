-- Business setup per WhatsApp account (additive; migration 015 is NOT modified).
--   * business_settings gains contact fields (everything else already lives there).
--   * business_documents gains purpose/caption (document type, image purpose) and
--     an extraction error, so PDFs and images share the one account-scoped store.
--   * business_links: any number of public URLs per account, each with its own
--     fetch status/text so "unreachable" is a first-class, visible state.
--   * setup_drafts: "Analyze & Generate" output. A draft never changes live
--     content by itself; applying it is a separate, explicit step.
--   * account_menus: the guided WhatsApp menu of a business (accounts without a
--     row use the shared generic menu; account 1 keeps the built-in structure).
-- The new tables CASCADE from whatsapp_accounts so deleting a business can never
-- leave orphaned setup data behind.

ALTER TABLE business_settings ADD COLUMN contact_phone TEXT;
ALTER TABLE business_settings ADD COLUMN contact_email TEXT;

ALTER TABLE business_documents ADD COLUMN purpose TEXT;
ALTER TABLE business_documents ADD COLUMN caption TEXT;
ALTER TABLE business_documents ADD COLUMN processing_error TEXT;

CREATE TABLE IF NOT EXISTS business_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  whatsapp_account_id INTEGER NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'other',            -- website | instagram | facebook | tiktok | linkedin | youtube | google_maps | menu | other
  label TEXT,
  url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',        -- pending | ok | unavailable
  http_status INTEGER,
  error TEXT,
  title TEXT,
  content_text TEXT,
  content_sha256 TEXT,
  fetched_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (whatsapp_account_id, url)
);
CREATE INDEX IF NOT EXISTS idx_business_links_account ON business_links (whatsapp_account_id);

CREATE TABLE IF NOT EXISTS setup_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  whatsapp_account_id INTEGER NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'draft',          -- draft | applied | discarded
  generator TEXT NOT NULL DEFAULT 'rules',       -- rules | ai
  model TEXT,
  sources_json TEXT NOT NULL DEFAULT '{}',
  content_json TEXT NOT NULL,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  apply_json TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  applied_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_setup_drafts_account ON setup_drafts (whatsapp_account_id, id DESC);

CREATE TABLE IF NOT EXISTS account_menus (
  whatsapp_account_id INTEGER PRIMARY KEY REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  config_json TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',         -- generated | manual
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
