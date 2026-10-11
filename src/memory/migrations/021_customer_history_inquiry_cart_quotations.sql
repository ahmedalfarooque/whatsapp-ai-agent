-- Customer history, the inquiry cart and the quotation lifecycle. ADDITIVE ONLY: new tables and new nullable / defaulted columns; no existing
-- row, column or index is changed, so every current customer, request, event, document and outbox row stays exactly as it is.
--
-- customers.email, company_name     optional profile details staff can fill in (never invented; NULL = unknown)
-- customer_requests.cart_id, source the inquiry-cart submission a request came from ('menu' for every request that already exists)
-- request_events.admin_user_id, reason  who (dashboard user) and why, for the status audit trail that already exists
--
-- inquiry_carts / inquiry_cart_items  the customer's working list. ONE open cart per customer (partial unique index). Submitting it creates a
--                       normal customer_requests row (kind 'quotation', reference INQ-yyyy-nnnn) and closes the cart: the request stays the
--                       single canonical record; the cart only keeps the items. quantity NULL = the customer did not state one.
-- quotation_versions / quotation_lines  the quotation CONTENT for a request. Money is stored in integer minor units (halalas): NULL means
--                       "not supplied", never zero. A version that has been sent is never edited: a change makes a new version.
-- customer_files        files received from / sent to a customer, in the SAME uploads folder and with the same validation as the business
--                       document store, but in their own table so a customer's file can never reach the business library, the AI context or
--                       a customer-visible list. customer_id NULL + status 'needs_review' = identity not certain, left for staff.
-- customer_notes        internal notes and follow-up reminders (never shown to customers).
-- notification_outbox.attachment_file_id  a file to send with the message (the quotation document); the outbox row is the delivery record.
ALTER TABLE customers ADD COLUMN email TEXT;
ALTER TABLE customers ADD COLUMN company_name TEXT;

ALTER TABLE customer_requests ADD COLUMN cart_id INTEGER;
ALTER TABLE customer_requests ADD COLUMN source TEXT NOT NULL DEFAULT 'menu';

ALTER TABLE request_events ADD COLUMN admin_user_id INTEGER;
ALTER TABLE request_events ADD COLUMN reason TEXT;

ALTER TABLE notification_outbox ADD COLUMN attachment_file_id INTEGER;

CREATE TABLE IF NOT EXISTS inquiry_carts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  whatsapp_account_id INTEGER NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'submitted', 'cancelled')),
  request_id INTEGER REFERENCES customer_requests(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_inquiry_carts_one_open_per_customer ON inquiry_carts (customer_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_inquiry_carts_account ON inquiry_carts (whatsapp_account_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS inquiry_cart_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cart_id INTEGER NOT NULL REFERENCES inquiry_carts(id) ON DELETE CASCADE,
  whatsapp_account_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  description TEXT NOT NULL,
  quantity INTEGER CHECK (quantity IS NULL OR (quantity >= 1 AND quantity <= 100000)),
  notes TEXT,
  source TEXT NOT NULL DEFAULT 'customer' CHECK (source IN ('customer', 'general')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- A removed item stays on record (never deleted) so the customer's timeline can show what was added and what was taken out.
  removed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_inquiry_cart_items_cart ON inquiry_cart_items (cart_id, position);

CREATE TABLE IF NOT EXISTS customer_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  whatsapp_account_id INTEGER NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  kind TEXT NOT NULL DEFAULT 'document' CHECK (kind IN ('document', 'image', 'video', 'audio', 'other')),
  purpose TEXT,
  original_name TEXT,
  stored_name TEXT UNIQUE,
  mime_type TEXT,
  extension TEXT,
  size_bytes INTEGER,
  sha256 TEXT,
  caption TEXT,
  conversation_id INTEGER,
  whatsapp_message_id TEXT,
  message_row_id INTEGER,
  request_id INTEGER,
  quotation_version_id INTEGER,
  status TEXT NOT NULL DEFAULT 'stored' CHECK (status IN ('stored', 'failed', 'too_large', 'unsupported', 'needs_review')),
  error TEXT,
  processing TEXT NOT NULL DEFAULT 'stored' CHECK (processing IN ('stored', 'text_extracted', 'extraction_failed', 'unsupported')),
  extracted_text TEXT,
  uploaded_by_admin_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_customer_files_customer ON customer_files (whatsapp_account_id, customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_customer_files_request ON customer_files (request_id);
-- One captured file per inbound WhatsApp message and account (a re-delivered message never stores the file twice).
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_files_inbound_message ON customer_files (whatsapp_account_id, whatsapp_message_id) WHERE direction = 'inbound' AND whatsapp_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS quotation_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  whatsapp_account_id INTEGER NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  request_id INTEGER NOT NULL REFERENCES customer_requests(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  quote_number TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'final', 'superseded')),
  currency TEXT,
  valid_until TEXT,
  subtotal_minor INTEGER,
  tax_rate_bp INTEGER,
  tax_minor INTEGER,
  total_minor INTEGER,
  customer_message TEXT,
  internal_note TEXT,
  file_id INTEGER REFERENCES customer_files(id),
  prepared_by_admin_id INTEGER,
  prepared_by_name TEXT,
  finalized_at TEXT,
  sent_outbox_id INTEGER,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (request_id, version)
);
CREATE INDEX IF NOT EXISTS idx_quotation_versions_account ON quotation_versions (whatsapp_account_id, request_id);

CREATE TABLE IF NOT EXISTS quotation_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES quotation_versions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  description TEXT NOT NULL,
  quantity_milli INTEGER CHECK (quantity_milli IS NULL OR quantity_milli > 0),
  unit_price_minor INTEGER CHECK (unit_price_minor IS NULL OR unit_price_minor >= 0),
  line_total_minor INTEGER
);
CREATE INDEX IF NOT EXISTS idx_quotation_lines_version ON quotation_lines (version_id, position);

CREATE TABLE IF NOT EXISTS customer_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  whatsapp_account_id INTEGER NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  request_id INTEGER,
  body TEXT NOT NULL,
  author_admin_id INTEGER,
  author_name TEXT,
  follow_up_at TEXT,
  follow_up_done_at TEXT,
  follow_up_done_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_customer_notes_customer ON customer_notes (whatsapp_account_id, customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_customer_notes_followup ON customer_notes (whatsapp_account_id, follow_up_at) WHERE follow_up_at IS NOT NULL AND follow_up_done_at IS NULL;
