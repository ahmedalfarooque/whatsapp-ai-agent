-- Per-business catalogue library (ADDITIVE: two new tables, no existing table is altered).
--   * account_features: add-on capabilities switched on for one specific business. The original business
--     (account 1) can never have one — enforced in code (src/accounts/accountFeatures.ts).
--   * account_catalogues: the customer-facing PDF catalogues of a business. The file itself is a normal
--     business_documents row (account-scoped folder, hash, extracted text); this row adds the catalogue
--     metadata: display title, page count, order and whether customers may be offered it.
CREATE TABLE IF NOT EXISTS account_features (
  whatsapp_account_id INTEGER NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  feature TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (whatsapp_account_id, feature)
);

CREATE TABLE IF NOT EXISTS account_catalogues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  whatsapp_account_id INTEGER NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  document_id INTEGER NOT NULL UNIQUE REFERENCES business_documents(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  page_count INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_account_catalogues_account_order ON account_catalogues(whatsapp_account_id, sort_order, id);
