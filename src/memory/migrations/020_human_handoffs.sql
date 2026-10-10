-- Human handoff and staff takeover. ADDITIVE ONLY: three new tables; no existing column or row is changed except that customers who
-- are ALREADY paused (the old "human support" flag) get a matching handoff row so nothing is lost or forgotten.
--
-- human_handoffs        one row per handoff of ONE customer of ONE WhatsApp account. state:
--                         HUMAN_REQUESTED  the customer asked for a person (or the assistant/staff did on their behalf); waiting for staff
--                         HUMAN_ACTIVE     a staff member (assigned_admin_id) owns the conversation
--                         RESOLVED         staff finished; the assistant stays quiet until someone returns the conversation to the AI
--                         AI_ACTIVE        the conversation went back to the assistant (terminal state of the row)
--                       At most ONE row per customer is not AI_ACTIVE (the unique index below), so a repeated request updates that row
--                       (request_count, last_requested_at) instead of creating another one, even when two requests race.
-- human_handoff_events  the audit trail: every state change with who did it (customer, assistant, staff, system) and when.
-- human_handoff_messages  the replies staff typed in the dashboard, one row per client-supplied id (idempotent: a retry or a
--                       double click never sends twice) with the outcome of the send. Never contains credentials.
CREATE TABLE IF NOT EXISTS human_handoffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  whatsapp_account_id INTEGER NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  conversation_id INTEGER,
  state TEXT NOT NULL CHECK (state IN ('HUMAN_REQUESTED', 'HUMAN_ACTIVE', 'RESOLVED', 'AI_ACTIVE')),
  source TEXT NOT NULL DEFAULT 'customer' CHECK (source IN ('customer', 'menu', 'ai', 'staff', 'migrated')),
  reason TEXT,
  request_count INTEGER NOT NULL DEFAULT 1,
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  assigned_admin_id INTEGER,
  accepted_at TEXT,
  resolved_at TEXT,
  resolved_by INTEGER,
  returned_at TEXT,
  returned_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_human_handoffs_one_open_per_customer ON human_handoffs (customer_id) WHERE state <> 'AI_ACTIVE';
CREATE INDEX IF NOT EXISTS idx_human_handoffs_account_state ON human_handoffs (whatsapp_account_id, state, last_requested_at DESC);

CREATE TABLE IF NOT EXISTS human_handoff_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  handoff_id INTEGER NOT NULL REFERENCES human_handoffs(id) ON DELETE CASCADE,
  whatsapp_account_id INTEGER NOT NULL,
  event TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('customer', 'assistant', 'staff', 'system')),
  actor_admin_id INTEGER,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_human_handoff_events_handoff ON human_handoff_events (handoff_id, id);

CREATE TABLE IF NOT EXISTS human_handoff_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  handoff_id INTEGER NOT NULL REFERENCES human_handoffs(id) ON DELETE CASCADE,
  whatsapp_account_id INTEGER NOT NULL,
  client_message_id TEXT NOT NULL,
  staff_admin_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  provider_message_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (handoff_id, client_message_id)
);

-- Customers that are paused today (waiting for a person) become HUMAN_REQUESTED handoffs: they stay in the queue, nothing changes for them.
INSERT INTO human_handoffs (whatsapp_account_id, customer_id, conversation_id, state, source, reason, requested_at, last_requested_at)
SELECT cu.whatsapp_account_id, cu.id,
       (SELECT MAX(c.id) FROM conversations c WHERE c.customer_id = cu.id),
       'HUMAN_REQUESTED', 'migrated', cu.pause_reason,
       COALESCE(cu.paused_at, datetime('now')), COALESCE(cu.paused_at, datetime('now'))
FROM customers cu
WHERE cu.automation_paused = 1;

INSERT INTO human_handoff_events (handoff_id, whatsapp_account_id, event, from_state, to_state, actor_type, detail)
SELECT h.id, h.whatsapp_account_id, 'migrated', NULL, 'HUMAN_REQUESTED', 'system', 'Customer was already waiting for a person before handoffs existed'
FROM human_handoffs h WHERE h.source = 'migrated';
