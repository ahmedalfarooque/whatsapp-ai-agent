-- Business profile & location (editable from the dashboard; one authoritative
-- resolver feeds WhatsApp templates, the dashboard, the preview and the AI).
ALTER TABLE business_settings ADD COLUMN business_name_ar TEXT;
ALTER TABLE business_settings ADD COLUMN business_category TEXT;
ALTER TABLE business_settings ADD COLUMN description_ar TEXT;
ALTER TABLE business_settings ADD COLUMN description_en TEXT;
ALTER TABLE business_settings ADD COLUMN address_ar TEXT;
ALTER TABLE business_settings ADD COLUMN address_en TEXT;
ALTER TABLE business_settings ADD COLUMN google_maps_url TEXT;
ALTER TABLE business_settings ADD COLUMN latitude REAL;
ALTER TABLE business_settings ADD COLUMN longitude REAL;
ALTER TABLE business_settings ADD COLUMN friday_hours_start TEXT;
ALTER TABLE business_settings ADD COLUMN friday_hours_end TEXT;
ALTER TABLE business_settings ADD COLUMN location_notes_ar TEXT;
ALTER TABLE business_settings ADD COLUMN location_notes_en TEXT;
ALTER TABLE business_settings ADD COLUMN logo_document_id INTEGER;

-- Uploaded business materials (PDF/PPTX/DOCX/HTML/images/text). Files live
-- under data/uploads/<stored_name>; the table holds metadata only.
CREATE TABLE IF NOT EXISTS business_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  extension TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  title TEXT,
  visibility TEXT NOT NULL DEFAULT 'internal',      -- internal | ai_knowledge | customer
  status TEXT NOT NULL DEFAULT 'active',            -- active | archived
  processing TEXT NOT NULL DEFAULT 'stored',        -- stored | text_extracted | unsupported
  extracted_text TEXT,
  uploaded_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Offers & discounts. Numeric prices are stored ONLY when price_status is
-- 'verified'; otherwise customers see "Price on request".
CREATE TABLE IF NOT EXISTS offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title_ar TEXT NOT NULL,
  title_en TEXT NOT NULL,
  description_ar TEXT NOT NULL DEFAULT '',
  description_en TEXT NOT NULL DEFAULT '',
  category TEXT,
  related_item TEXT,
  price_status TEXT NOT NULL DEFAULT 'on_request',  -- verified | on_request | contact
  original_price REAL,
  promotional_price REAL,
  discount_percent REAL,
  currency TEXT NOT NULL DEFAULT 'SAR',
  starts_at TEXT,
  ends_at TEXT,
  image_document_id INTEGER,
  document_id INTEGER,
  terms_ar TEXT,
  terms_en TEXT,
  visibility TEXT NOT NULL DEFAULT 'customer',      -- customer | internal
  status TEXT NOT NULL DEFAULT 'draft',             -- draft | published | finished | archived
  priority INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  updated_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_offers_status ON offers (status, deleted_at);
