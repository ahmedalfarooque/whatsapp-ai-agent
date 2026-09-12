import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../../src/memory/db';
import { getOrCreateCustomer } from '../../../src/memory/customerRepo';
import { getOrCreateActiveConversation } from '../../../src/memory/conversationRepo';
import {
  acquireLock,
  confirmLock,
  markUncertain,
  releaseLock,
  reconcileUncertainAsConfirmed,
  reconcileUncertainAsNotBooked,
  findConfirmedByIdempotencyKey,
  buildIdempotencyKey,
  buildSlotKey,
} from '../../../src/memory/bookingLockRepo';

let db: Database.Database;
let conversationId: number;

beforeEach(() => {
  db = createTestDb();
  conversationId = getOrCreateActiveConversation(getOrCreateCustomer('15550001111', 'Alice', db).id, db).id;
});

const SLOT = { startISO: '2025-06-10T10:00:00.000-05:00', endISO: '2025-06-10T10:30:00.000-05:00' };
const idempotencyKey = buildIdempotencyKey(1, SLOT.startISO, SLOT.endISO, 'Consult — Alice');
const slotKey = buildSlotKey('primary', SLOT.startISO, SLOT.endISO);

function claim() {
  return acquireLock({ slotKey, idempotencyKey, conversationId, ...SLOT }, db);
}

describe('bookingLockRepo — state machine', () => {
  it('acquires a fresh lock as pending', () => {
    const result = claim();
    expect(result.acquired).toBe(true);
    if (result.acquired) expect(result.lock.status).toBe('pending');
  });

  it('a second claim for the same idempotency+slot while still pending reports duplicate_in_flight', () => {
    claim();
    const second = claim();
    expect(second.acquired).toBe(false);
    if (!second.acquired) expect(second.reason).toBe('duplicate_in_flight');
  });

  it('a different idempotency key for the same slot reports slot_taken', () => {
    claim();
    const differentRequestSameSlot = acquireLock(
      {
        slotKey,
        idempotencyKey: buildIdempotencyKey(2, SLOT.startISO, SLOT.endISO, 'Consult — Bob'),
        conversationId,
        ...SLOT,
      },
      db,
    );
    expect(differentRequestSameSlot.acquired).toBe(false);
    if (!differentRequestSameSlot.acquired) expect(differentRequestSameSlot.reason).toBe('slot_taken');
  });

  it('after confirmLock, a re-claim reports now_confirmed with the real event id', () => {
    const first = claim();
    if (!first.acquired) throw new Error('setup failed');
    confirmLock(first.lock.id, 'evt_real', db);

    const second = claim();
    expect(second.acquired).toBe(false);
    if (!second.acquired && second.reason === 'now_confirmed') {
      expect(second.lock.calendar_event_id).toBe('evt_real');
    } else {
      throw new Error(`expected now_confirmed, got ${JSON.stringify(second)}`);
    }
    expect(findConfirmedByIdempotencyKey(idempotencyKey, db)?.calendar_event_id).toBe('evt_real');
  });

  it('after markUncertain, a re-claim reports uncertain_retry and never clears on its own', () => {
    const first = claim();
    if (!first.acquired) throw new Error('setup failed');
    markUncertain(first.lock.id, db);

    const second = claim();
    expect(second.acquired).toBe(false);
    if (!second.acquired) expect(second.reason).toBe('uncertain_retry');

    // Confirm it's genuinely stuck — a third attempt behaves identically,
    // not "eventually available again".
    const third = claim();
    expect(third.acquired).toBe(false);
    if (!third.acquired) expect(third.reason).toBe('uncertain_retry');
  });

  it('releaseLock only removes a PENDING row — never an uncertain one', () => {
    const first = claim();
    if (!first.acquired) throw new Error('setup failed');
    markUncertain(first.lock.id, db);

    releaseLock(first.lock.id, db); // should be a no-op: row is 'uncertain', not 'pending'

    const stillThere = db.prepare('SELECT * FROM booking_locks WHERE id = ?').get(first.lock.id);
    expect(stillThere).toBeTruthy();
  });

  it('releaseLock removes a PENDING row, freeing both the slot and the idempotency key', () => {
    const first = claim();
    if (!first.acquired) throw new Error('setup failed');
    releaseLock(first.lock.id, db);

    const fresh = claim();
    expect(fresh.acquired).toBe(true);
  });

  it(
    'a stale PENDING row (older than the staleness threshold — e.g. left behind by a process crash) is ' +
      'reclassified to uncertain on the next claim attempt, rather than silently blocking forever or ' +
      'silently becoming available',
    () => {
      const first = claim();
      if (!first.acquired) throw new Error('setup failed');

      // Simulate a crash long ago: backdate updated_at well past the staleness window.
      const staleTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
      db.prepare('UPDATE booking_locks SET updated_at = ? WHERE id = ?').run(staleTimestamp, first.lock.id);

      const second = claim();
      expect(second.acquired).toBe(false);
      if (!second.acquired) expect(second.reason).toBe('uncertain_retry');

      const row = db.prepare('SELECT status FROM booking_locks WHERE id = ?').get(first.lock.id) as {
        status: string;
      };
      expect(row.status).toBe('uncertain');
    },
  );

  it('a recently-created PENDING row is NOT reclassified as stale (below the threshold)', () => {
    const first = claim();
    if (!first.acquired) throw new Error('setup failed');

    const second = claim();
    expect(second.acquired).toBe(false);
    if (!second.acquired) expect(second.reason).toBe('duplicate_in_flight');

    const row = db.prepare('SELECT status FROM booking_locks WHERE id = ?').get(first.lock.id) as {
      status: string;
    };
    expect(row.status).toBe('pending');
  });
});

describe('bookingLockRepo — admin reconciliation of uncertain bookings', () => {
  it('reconcileUncertainAsConfirmed transitions an uncertain lock to confirmed with the given event id', () => {
    const first = claim();
    if (!first.acquired) throw new Error('setup failed');
    markUncertain(first.lock.id, db);

    const changed = reconcileUncertainAsConfirmed(first.lock.id, 'evt_manually_found', db);
    expect(changed).toBe(true);

    const row = db.prepare('SELECT status, calendar_event_id FROM booking_locks WHERE id = ?').get(first.lock.id) as {
      status: string;
      calendar_event_id: string;
    };
    expect(row.status).toBe('confirmed');
    expect(row.calendar_event_id).toBe('evt_manually_found');
  });

  it('reconcileUncertainAsConfirmed is a no-op on a pending (not uncertain) lock', () => {
    const first = claim();
    if (!first.acquired) throw new Error('setup failed');

    const changed = reconcileUncertainAsConfirmed(first.lock.id, 'evt_should_not_apply', db);
    expect(changed).toBe(false);

    const row = db.prepare('SELECT status FROM booking_locks WHERE id = ?').get(first.lock.id) as { status: string };
    expect(row.status).toBe('pending');
  });

  it('reconcileUncertainAsConfirmed is a no-op on an already-confirmed lock', () => {
    const first = claim();
    if (!first.acquired) throw new Error('setup failed');
    confirmLock(first.lock.id, 'evt_real', db);

    const changed = reconcileUncertainAsConfirmed(first.lock.id, 'evt_attempted_overwrite', db);
    expect(changed).toBe(false);

    const row = db.prepare('SELECT calendar_event_id FROM booking_locks WHERE id = ?').get(first.lock.id) as {
      calendar_event_id: string;
    };
    expect(row.calendar_event_id).toBe('evt_real');
  });

  it('reconcileUncertainAsNotBooked deletes an uncertain lock, freeing its slot and idempotency key', () => {
    const first = claim();
    if (!first.acquired) throw new Error('setup failed');
    markUncertain(first.lock.id, db);

    const changed = reconcileUncertainAsNotBooked(first.lock.id, db);
    expect(changed).toBe(true);

    const row = db.prepare('SELECT * FROM booking_locks WHERE id = ?').get(first.lock.id);
    expect(row).toBeUndefined();

    // A fresh attempt for the exact same slot/idempotency key now succeeds.
    const retry = claim();
    expect(retry.acquired).toBe(true);
  });

  it('reconcileUncertainAsNotBooked is a no-op on a pending (not uncertain) lock — never silently deletes an in-flight attempt', () => {
    const first = claim();
    if (!first.acquired) throw new Error('setup failed');

    const changed = reconcileUncertainAsNotBooked(first.lock.id, db);
    expect(changed).toBe(false);

    const row = db.prepare('SELECT * FROM booking_locks WHERE id = ?').get(first.lock.id);
    expect(row).toBeDefined();
  });

  it('reconcileUncertainAsNotBooked is a no-op on an already-confirmed lock', () => {
    const first = claim();
    if (!first.acquired) throw new Error('setup failed');
    confirmLock(first.lock.id, 'evt_real', db);

    const changed = reconcileUncertainAsNotBooked(first.lock.id, db);
    expect(changed).toBe(false);

    const row = db.prepare('SELECT * FROM booking_locks WHERE id = ?').get(first.lock.id);
    expect(row).toBeDefined();
  });
});
