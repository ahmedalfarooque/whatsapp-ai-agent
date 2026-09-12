import type Database from 'better-sqlite3';
import { getDb } from './db';

export interface BookingLock {
  id: number;
  slot_key: string;
  idempotency_key: string;
  conversation_id: number;
  status: 'pending' | 'confirmed' | 'uncertain';
  start_iso: string;
  end_iso: string;
  calendar_event_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * How long a 'pending' row is allowed to sit unresolved before we treat it
 * as stale. This does NOT release the row (that could enable a duplicate
 * Google Calendar event if the original request is still in flight or
 * actually succeeded) — it only relabels it 'uncertain' so a retry gets an
 * honest "needs manual reconciliation" signal instead of a misleading
 * "someone else is booking this right now, try again shortly". Comfortably
 * longer than every external call timeout in this app (WhatsApp/OpenRouter/
 * Google are all <= 30s), so a row only reaches this age if something (a
 * crash, a hang) truly went wrong, never as part of normal operation.
 */
const STALE_PENDING_MS = 5 * 60 * 1000;

/** SQLite's `datetime('now')` returns "YYYY-MM-DD HH:MM:SS" (UTC, no zone marker). */
function parseSqliteUtcTimestamp(ts: string): number {
  return Date.parse(`${ts.replace(' ', 'T')}Z`);
}

function isStalePending(lock: BookingLock): boolean {
  const ageMs = Date.now() - parseSqliteUtcTimestamp(lock.updated_at);
  return ageMs > STALE_PENDING_MS;
}

/** Deterministic key for "is this the exact same logical booking request as before?" */
export function buildIdempotencyKey(
  conversationId: number,
  startISO: string,
  endISO: string,
  summary: string,
): string {
  return `${conversationId}|${startISO.trim()}|${endISO.trim()}|${summary.trim()}`;
}

/** Deterministic key for "is this exact calendar slot already taken/being taken?" */
export function buildSlotKey(calendarId: string, startISO: string, endISO: string): string {
  return `${calendarId.trim()}|${startISO.trim()}|${endISO.trim()}`;
}

export function findConfirmedByIdempotencyKey(
  idempotencyKey: string,
  db: Database.Database = getDb(),
): BookingLock | undefined {
  return db
    .prepare("SELECT * FROM booking_locks WHERE idempotency_key = ? AND status = 'confirmed'")
    .get(idempotencyKey) as BookingLock | undefined;
}

export type AcquireLockResult =
  | { acquired: true; lock: BookingLock }
  /** A concurrent (or earlier) attempt for this EXACT logical request already succeeded — use its event, don't call Google again. */
  | { acquired: false; reason: 'now_confirmed'; lock: BookingLock }
  /** This exact logical request previously ended in an ambiguous/unknown outcome (or a stale in-flight attempt was just reclassified as such). Must NOT be retried automatically. */
  | { acquired: false; reason: 'uncertain_retry'; lock: BookingLock }
  /** This exact logical request is genuinely being attempted right now elsewhere — safe to ask the customer to wait a moment. */
  | { acquired: false; reason: 'duplicate_in_flight' }
  /** A DIFFERENT logical request already holds (or is holding) this exact calendar slot. */
  | { acquired: false; reason: 'slot_taken' };

/**
 * Atomically tries to claim both the idempotency key and the slot key for a
 * new 'pending' booking attempt via a single INSERT — SQLite enforces the
 * UNIQUE constraints atomically (this one statement IS the entire race
 * protection; nothing here is a separate check-then-insert). On failure, a
 * best-effort lookup classifies *why* purely for a more honest caller-facing
 * message — it never affects whether Google gets called.
 */
export function acquireLock(
  params: {
    slotKey: string;
    idempotencyKey: string;
    conversationId: number;
    startISO: string;
    endISO: string;
  },
  db: Database.Database = getDb(),
): AcquireLockResult {
  try {
    const result = db
      .prepare(
        `INSERT INTO booking_locks
          (slot_key, idempotency_key, conversation_id, status, start_iso, end_iso)
         VALUES (@slot_key, @idempotency_key, @conversation_id, 'pending', @start_iso, @end_iso)`,
      )
      .run({
        slot_key: params.slotKey,
        idempotency_key: params.idempotencyKey,
        conversation_id: params.conversationId,
        start_iso: params.startISO,
        end_iso: params.endISO,
      });

    const lock = db
      .prepare('SELECT * FROM booking_locks WHERE id = ?')
      .get(result.lastInsertRowid) as BookingLock;
    return { acquired: true, lock };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('UNIQUE constraint failed')) throw error;

    const byIdempotencyKey = db
      .prepare('SELECT * FROM booking_locks WHERE idempotency_key = ?')
      .get(params.idempotencyKey) as BookingLock | undefined;

    if (byIdempotencyKey) {
      if (byIdempotencyKey.status === 'confirmed') {
        return { acquired: false, reason: 'now_confirmed', lock: byIdempotencyKey };
      }
      if (byIdempotencyKey.status === 'uncertain') {
        return { acquired: false, reason: 'uncertain_retry', lock: byIdempotencyKey };
      }
      // status === 'pending'
      if (isStalePending(byIdempotencyKey)) {
        markUncertain(byIdempotencyKey.id, db);
        return {
          acquired: false,
          reason: 'uncertain_retry',
          lock: { ...byIdempotencyKey, status: 'uncertain' },
        };
      }
      return { acquired: false, reason: 'duplicate_in_flight' };
    }

    // The idempotency_key was free, so the collision must be on slot_key —
    // a different logical request already holds (or held) this exact slot.
    return { acquired: false, reason: 'slot_taken' };
  }
}

export function confirmLock(
  id: number,
  calendarEventId: string,
  db: Database.Database = getDb(),
): void {
  db.prepare(
    "UPDATE booking_locks SET status = 'confirmed', calendar_event_id = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(calendarEventId, id);
}

/**
 * Marks a lock 'uncertain' — its outcome (did Google actually create the
 * event or not?) could not be determined. This is a terminal, non-releasing
 * state: neither the slot nor the idempotency key becomes available again
 * automatically. A human needs to check the real calendar and reconcile.
 */
export function markUncertain(id: number, db: Database.Database = getDb()): void {
  db.prepare("UPDATE booking_locks SET status = 'uncertain', updated_at = datetime('now') WHERE id = ?").run(
    id,
  );
}

/**
 * Releases a pending lock — ONLY safe to call when the attempt's outcome is
 * definitely known to have failed (a confirmed rejection from Google, or a
 * pre-Google failure like a freebusy re-check conflict). Never call this for
 * an ambiguous outcome — use markUncertain instead.
 */
export function releaseLock(id: number, db: Database.Database = getDb()): void {
  db.prepare("DELETE FROM booking_locks WHERE id = ? AND status = 'pending'").run(id);
}

/**
 * Admin reconciliation: an admin has manually checked the real Google
 * Calendar and confirmed the event DOES exist. Records the real event id
 * they found — this function never calls Google itself, it only records a
 * human's out-of-band finding, so it carries none of the duplicate-creation
 * risk an automated retry would. Only operates on a row that is actually
 * 'uncertain' — a no-op (0 rows affected) on any other status, so a stale
 * dashboard view can't silently corrupt an already-resolved booking.
 */
export function reconcileUncertainAsConfirmed(
  id: number,
  calendarEventId: string,
  db: Database.Database = getDb(),
): boolean {
  const result = db
    .prepare(
      "UPDATE booking_locks SET status = 'confirmed', calendar_event_id = ?, updated_at = datetime('now') WHERE id = ? AND status = 'uncertain'",
    )
    .run(calendarEventId, id);
  return result.changes > 0;
}

/**
 * Admin reconciliation: an admin has manually checked the real Google
 * Calendar and confirmed the event does NOT exist. Deletes the lock row
 * entirely, freeing both its slot_key and idempotency_key so a legitimate
 * new booking attempt for that slot/request can proceed. Only ever deletes
 * a row that is 'uncertain' — never touches 'pending' (use releaseLock,
 * which is for confirmed-failure paths, not manual reconciliation) or
 * 'confirmed' rows.
 */
export function reconcileUncertainAsNotBooked(id: number, db: Database.Database = getDb()): boolean {
  const result = db.prepare("DELETE FROM booking_locks WHERE id = ? AND status = 'uncertain'").run(id);
  return result.changes > 0;
}

export interface BookingListItem extends BookingLock {
  customerLabel: string | null;
  waId: string;
}

const MAX_PAGE_SIZE = 100;

/**
 * Admin/dashboard listing of real bookings. `booking_locks` — not
 * `booking_sessions` — is the actual source of truth for confirmed
 * appointments (see src/calendar/booking.ts); `booking_sessions` is a
 * separate, currently-unused table reserved for future multi-turn
 * slot-filling and is never written to by the real booking flow.
 */
export function listBookingLocks(
  params: { status?: BookingLock['status']; limit?: number; offset?: number } = {},
  db: Database.Database = getDb(),
): { items: BookingListItem[]; total: number } {
  const limit = Math.max(1, Math.min(params.limit ?? 25, MAX_PAGE_SIZE));
  const offset = Math.max(0, params.offset ?? 0);
  const whereClause = params.status ? 'WHERE bl.status = @status' : '';
  const args = params.status ? { status: params.status } : {};

  const total = (
    db.prepare(`SELECT COUNT(*) AS count FROM booking_locks bl ${whereClause}`).get(args) as {
      count: number;
    }
  ).count;

  const items = db
    .prepare(
      `SELECT bl.*, cu.display_name AS customerLabel, cu.wa_id AS waId
       FROM booking_locks bl
       JOIN conversations c ON c.id = bl.conversation_id
       JOIN customers cu ON cu.id = c.customer_id
       ${whereClause}
       ORDER BY bl.start_iso DESC
       LIMIT @limit OFFSET @offset`,
    )
    .all({ ...args, limit, offset }) as BookingListItem[];

  return { items, total };
}
