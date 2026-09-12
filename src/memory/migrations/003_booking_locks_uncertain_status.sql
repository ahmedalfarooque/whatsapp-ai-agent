-- Adds a third booking_locks status: 'uncertain' — an insert attempt whose
-- outcome could not be determined (network/timeout error, or a process
-- crash mid-call). Unlike a confirmed failure, an uncertain row is NEVER
-- auto-released: we cannot tell whether Google actually created the event,
-- so releasing it (allowing a fresh attempt) could create a real duplicate.
-- See src/calendar/booking.ts and src/memory/bookingLockRepo.ts.
--
-- SQLite has no ALTER TABLE ... DROP CONSTRAINT, so the CHECK constraint is
-- updated via the standard rebuild-and-copy pattern.
ALTER TABLE booking_locks RENAME TO booking_locks_pre_uncertain;

CREATE TABLE booking_locks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_key TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'uncertain')),
  start_iso TEXT NOT NULL,
  end_iso TEXT NOT NULL,
  calendar_event_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO booking_locks
  (id, slot_key, idempotency_key, conversation_id, status, start_iso, end_iso, calendar_event_id, created_at, updated_at)
SELECT id, slot_key, idempotency_key, conversation_id, status, start_iso, end_iso, calendar_event_id, created_at, updated_at
FROM booking_locks_pre_uncertain;

DROP TABLE booking_locks_pre_uncertain;

CREATE INDEX IF NOT EXISTS idx_booking_locks_conversation ON booking_locks(conversation_id);
