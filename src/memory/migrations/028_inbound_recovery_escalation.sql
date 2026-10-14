-- Safe recovery of customer messages the assistant could not answer, and the five-minute escalation (additive; nothing existing changes).
--
-- pending_replies: one row per customer message that went to the AI path. It is opened when the message enters the AI step and settled
--   when it is answered ('answered'), superseded or no longer wanted ('abandoned'), left for a person ('needs_staff'), or could not be
--   answered because no AI route worked ('awaiting_ai'). A message whose processing was cut short is 'pending' and becomes 'interrupted'
--   at the next start. Only 'awaiting_ai' and 'interrupted' rows are ever replayed (src/replay/replayWorker.ts), once at a time ('replaying'),
--   within a few hours, never after a person or the assistant already answered, never after a tool ran. The customer's text itself stays in
--   `messages` (joined by whatsapp_message_id); nothing is copied here, so no extra customer content is stored.
CREATE TABLE IF NOT EXISTS pending_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  whatsapp_account_id INTEGER NOT NULL,
  customer_id INTEGER NOT NULL,
  conversation_id INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  wa_id TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'qr',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'awaiting_ai', 'interrupted', 'replaying', 'answered', 'abandoned', 'needs_staff')),
  attempts INTEGER NOT NULL DEFAULT 0,
  recovered INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_attempt_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  settled_at TEXT,
  UNIQUE (whatsapp_account_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_pending_replies_open ON pending_replies (status, created_at);
CREATE INDEX IF NOT EXISTS idx_pending_replies_customer ON pending_replies (customer_id, status);

-- escalations: a request nobody resolved within five minutes while the business was open. One row per request (ref_kind + ref_id), so a
--   request escalates once and a call is never repeated. voice_call_*: the outbound AI voice call is attempted only through a verified
--   zero-cost authorized path (src/escalation/voiceCall.ts); none exists today, so the status records 'unavailable' with the exact reason.
CREATE TABLE IF NOT EXISTS escalations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  whatsapp_account_id INTEGER NOT NULL,
  customer_id INTEGER,
  ref_kind TEXT NOT NULL CHECK (ref_kind IN ('pending_reply', 'followup')),
  ref_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  staff_notification_id INTEGER,
  voice_call_status TEXT NOT NULL DEFAULT 'not_attempted' CHECK (voice_call_status IN ('not_attempted', 'unavailable', 'skipped', 'placed', 'failed')),
  voice_call_detail TEXT,
  voice_call_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  UNIQUE (ref_kind, ref_id)
);
CREATE INDEX IF NOT EXISTS idx_escalations_account ON escalations (whatsapp_account_id, status, created_at);
