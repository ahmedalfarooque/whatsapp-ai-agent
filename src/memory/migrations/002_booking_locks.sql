-- Database-backed idempotency/locking for Google Calendar bookings.
--
-- Two independent guarantees, enforced by SQLite's UNIQUE constraints
-- (atomic even under concurrent requests, since better-sqlite3 serializes
-- all writes through a single synchronous connection):
--
--   1. idempotency_key (per conversation + slot + summary): a genuine RETRY
--      of the same logical booking request — e.g. the customer's WhatsApp
--      client resends, or our own retry after a lost response — finds the
--      existing row instead of creating a second Google Calendar event.
--
--   2. slot_key (per calendar + exact start/end time): two DIFFERENT
--      customers racing for the same slot can both pass the earlier
--      check_availability call, but only one of them can win the INSERT
--      here — the loser is told the slot is taken *before* ever calling
--      the Google Calendar API, closing the check-then-act race window
--      that a freebusy re-check alone cannot fully close.
--
-- A row only survives with status='confirmed' (a real Google event exists).
-- 'pending' rows are held only for the duration of one in-flight attempt;
-- on failure/conflict the row is deleted so the slot/key is immediately
-- retryable. See src/calendar/booking.ts and src/memory/bookingLockRepo.ts.
CREATE TABLE IF NOT EXISTS booking_locks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_key TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed')),
  start_iso TEXT NOT NULL,
  end_iso TEXT NOT NULL,
  calendar_event_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_booking_locks_conversation ON booking_locks(conversation_id);
