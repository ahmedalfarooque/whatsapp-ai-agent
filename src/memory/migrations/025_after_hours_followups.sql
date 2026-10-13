-- After-hours experience, customer follow-up requests (callbacks / staff messages), per-business appointment types, a durable job
-- schedule and staff notifications. Additive only: every existing business keeps its values and inherits the shared defaults.
--
-- business_settings (all NULL/default = the shared behaviour; every business, existing or future, is independent):
--   weekly_hours             JSON {"1":[["09:00","13:00"],["16:00","20:00"]], ... "7":[]} (ISO weekday → open intervals, local time). NULL = derive
--                            from business_hours_start/end + business_days (+ friday_hours_*). Lets a business have different daily schedules
--                            and split shifts without touching the older columns.
--   closures                 JSON [{"from":"2026-10-20","to":"2026-10-21","label":"Holiday"}] — whole days the business is closed (local dates).
--   after_hours_enabled      1 = outside the configured hours a customer is told the business is closed, given the hours and next opening,
--                            and offered the follow-up choices (once per conversation window). 0 = off. Nothing is said when hours are unknown.
--   direct_call_enabled      1 = while open, the configured contact phone is offered as "call us now".
--   callback_window_minutes  how long after the agreed callback time the "Call customer" action stays enabled (default 30).
--   reminder_lead_minutes    staff reminder this many minutes before the agreed time (0 = at the time).
--   reminder_repeat_minutes  repeat an unacknowledged reminder every N minutes ...
--   reminder_max_attempts    ... at most this many times.
--   response_time_promise    optional text ("within one working day"); promised to customers ONLY when set.
--   open_router_audio_model  NULL = voice notes are not transcribed (the customer is told so). A model id = transcribe through OpenRouter.
ALTER TABLE business_settings ADD COLUMN weekly_hours TEXT;
ALTER TABLE business_settings ADD COLUMN closures TEXT;
ALTER TABLE business_settings ADD COLUMN after_hours_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE business_settings ADD COLUMN direct_call_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE business_settings ADD COLUMN callback_window_minutes INTEGER NOT NULL DEFAULT 30;
ALTER TABLE business_settings ADD COLUMN reminder_lead_minutes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE business_settings ADD COLUMN reminder_repeat_minutes INTEGER NOT NULL DEFAULT 5;
ALTER TABLE business_settings ADD COLUMN reminder_max_attempts INTEGER NOT NULL DEFAULT 3;
ALTER TABLE business_settings ADD COLUMN response_time_promise TEXT;
ALTER TABLE business_settings ADD COLUMN open_router_audio_model TEXT;

-- When the customer last received the after-hours notice (so it is not repeated within one conversation window; survives restarts).
ALTER TABLE customers ADD COLUMN after_hours_notified_at TEXT;

-- The appointment / enquiry types a business offers inside "request a callback" and "request a WhatsApp message". Administrators edit them
-- per business; the four generic ones below are only a starting point and are seeded for every existing business (new businesses get them
-- from ensureAppointmentTypes()).
CREATE TABLE IF NOT EXISTS account_appointment_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  whatsapp_account_id INTEGER NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  label_en TEXT NOT NULL,
  label_ar TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (whatsapp_account_id, key)
);
INSERT OR IGNORE INTO account_appointment_types (whatsapp_account_id, key, label_en, label_ar, sort_order)
  SELECT a.id, t.key, t.label_en, t.label_ar, t.sort_order FROM whatsapp_accounts a,
    (SELECT 'consultation' AS key, 'Consultation' AS label_en, 'استشارة' AS label_ar, 1 AS sort_order
     UNION ALL SELECT 'service_enquiry', 'Service enquiry', 'استفسار عن خدمة', 2
     UNION ALL SELECT 'product_enquiry', 'Product enquiry', 'استفسار عن منتج', 3
     UNION ALL SELECT 'quotation_discussion', 'Quotation discussion', 'مناقشة عرض سعر', 4) t;

-- A customer's request to be contacted: a phone callback or a WhatsApp message from staff, at an agreed time or as soon as staff are
-- available. One row per request; rescheduling updates the row (never a duplicate active task). All times are UTC ISO strings; the
-- business timezone is stored so the dashboard shows the time the customer agreed to.
CREATE TABLE IF NOT EXISTS followup_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  whatsapp_account_id INTEGER NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  conversation_id INTEGER,
  reference TEXT NOT NULL UNIQUE,
  contact_method TEXT NOT NULL CHECK (contact_method IN ('call', 'whatsapp')),
  appointment_type_key TEXT,
  appointment_type_label TEXT,
  requested_at TEXT,
  timezone TEXT NOT NULL,
  asap INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('pending', 'scheduled', 'eligible', 'assigned', 'completed', 'cancelled', 'overdue')),
  eligible_at TEXT,
  window_end_at TEXT,
  assigned_admin_id INTEGER,
  customer_note TEXT,
  outcome TEXT,
  outcome_note TEXT,
  source TEXT NOT NULL DEFAULT 'customer' CHECK (source IN ('customer', 'staff', 'ai')),
  reminder_attempts INTEGER NOT NULL DEFAULT 0,
  last_notified_at TEXT,
  completed_at TEXT,
  cancelled_at TEXT,
  cancelled_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_followup_requests_account_status ON followup_requests (whatsapp_account_id, status, requested_at);
CREATE INDEX IF NOT EXISTS idx_followup_requests_customer ON followup_requests (customer_id, status);

CREATE TABLE IF NOT EXISTS followup_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  followup_id INTEGER NOT NULL REFERENCES followup_requests(id) ON DELETE CASCADE,
  whatsapp_account_id INTEGER NOT NULL,
  event TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('customer', 'staff', 'system')),
  actor_admin_id INTEGER,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_followup_events_followup ON followup_events (followup_id, id);

-- Durable, restart-safe job schedule (reminders, eligibility, overdue checks). A job is identified by its dedupe key, so re-scheduling the
-- same thing twice is a no-op; cancelling a request cancels its jobs. The in-process scheduler runs due rows and records the outcome.
CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  whatsapp_account_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  ref_kind TEXT NOT NULL,
  ref_id INTEGER NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  run_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'cancelled', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  payload TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  ran_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_due ON scheduled_jobs (status, run_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_ref ON scheduled_jobs (ref_kind, ref_id, status);

-- Persistent, actionable staff notifications shown in the dashboard (bell, Human Support Queue). admin_user_id NULL = everyone with
-- access to the business. ring = 1 asks the dashboard to sound an alert when the notification is first shown.
CREATE TABLE IF NOT EXISTS staff_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  whatsapp_account_id INTEGER NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  admin_user_id INTEGER,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  followup_id INTEGER,
  customer_id INTEGER,
  ring INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('unread', 'read', 'resolved')),
  dedupe_key TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  read_at TEXT,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_staff_notifications_account_status ON staff_notifications (whatsapp_account_id, status, id);
