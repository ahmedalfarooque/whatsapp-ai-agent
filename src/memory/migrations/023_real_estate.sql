-- Real estate add-on (account feature "real_estate"). ADDITIVE ONLY: four new tables, no existing table is changed or rebuilt.
-- Every row carries whatsapp_account_id, so a business only ever reads its own projects and leads (the feature is enabled for one business only).
--
-- real_estate_projects: the business's VERIFIED project records, entered by staff in the dashboard. Nothing is seeded. A project is shown to
--   customers only while published = 1 AND archived = 0; nothing about a project is stated that is not in its record.
-- real_estate_leads: one qualified buyer / seller / investor enquiry per customer and kind. The partial unique index below allows exactly ONE
--   open (status <> 'closed') lead per customer and kind, so another message updates the enquiry instead of creating a duplicate.
-- real_estate_lead_projects: the projects a lead showed interest in.
-- real_estate_lead_events: the audit trail of a lead (who changed what, when) — never message content.

CREATE TABLE IF NOT EXISTS real_estate_projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  whatsapp_account_id INTEGER NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  name_en TEXT NOT NULL,
  name_ar TEXT,
  city TEXT,
  district TEXT,
  property_type TEXT,
  stage TEXT CHECK (stage IS NULL OR stage IN ('upcoming', 'under_construction', 'completed', 'sold_out', 'other')),
  summary_en TEXT,
  summary_ar TEXT,
  brochure_document_id INTEGER REFERENCES business_documents(id) ON DELETE SET NULL,
  published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_re_projects_account ON real_estate_projects (whatsapp_account_id, published, archived);

CREATE TABLE IF NOT EXISTS real_estate_leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  whatsapp_account_id INTEGER NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  reference TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('buyer', 'seller', 'investor', 'general')),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'qualified', 'awaiting_info', 'assigned', 'follow_up', 'closed')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'high')),
  language TEXT,
  summary TEXT,
  details TEXT NOT NULL DEFAULT '{}',          -- JSON object of short text answers (property_type, city, budget, …), validated in code
  needs_staff INTEGER NOT NULL DEFAULT 0 CHECK (needs_staff IN (0, 1)),
  documents_status TEXT NOT NULL DEFAULT 'not_requested' CHECK (documents_status IN ('not_requested', 'requested', 'received', 'reviewed')),
  consent_note TEXT,
  assigned_admin_id INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  next_action TEXT,
  follow_up_at TEXT,
  source TEXT NOT NULL DEFAULT 'assistant',    -- assistant | staff
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT,
  UNIQUE (whatsapp_account_id, reference)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_re_leads_one_open ON real_estate_leads (whatsapp_account_id, customer_id, kind) WHERE status <> 'closed';
CREATE INDEX IF NOT EXISTS idx_re_leads_account_status ON real_estate_leads (whatsapp_account_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_re_leads_customer ON real_estate_leads (whatsapp_account_id, customer_id);

CREATE TABLE IF NOT EXISTS real_estate_lead_projects (
  lead_id INTEGER NOT NULL REFERENCES real_estate_leads(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES real_estate_projects(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (lead_id, project_id)
);

CREATE TABLE IF NOT EXISTS real_estate_lead_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES real_estate_leads(id) ON DELETE CASCADE,
  whatsapp_account_id INTEGER NOT NULL,
  actor TEXT NOT NULL,                         -- assistant | staff:<admin id> | system
  event TEXT NOT NULL,                         -- created | updated | status | assigned | note
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_re_lead_events_lead ON real_estate_lead_events (lead_id, id);
