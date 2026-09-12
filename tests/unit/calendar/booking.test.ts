import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';

// tests/setup.ts sets NODE_ENV=test globally, which makes
// env.shouldUseMockProviders true (see src/config/env.ts) — correct for
// the rest of the suite, but this file specifically tests the REAL
// createEvent logic (against a mocked googleClient), so force that one
// flag off while keeping every other env value from the real test config.
vi.mock('../../../src/config/env', async () => {
  const actual = await vi.importActual<typeof import('../../../src/config/env')>(
    '../../../src/config/env',
  );
  return { ...actual, env: { ...actual.env, shouldUseMockProviders: false } };
});

const freebusyQuery = vi.fn().mockResolvedValue({ data: { calendars: {} } });
const eventsInsert = vi.fn();

vi.mock('../../../src/calendar/googleClient', () => ({
  getCalendarClient: () => ({
    freebusy: { query: freebusyQuery },
    events: { insert: eventsInsert },
  }),
}));

// createEvent reaches the DB through the module-level getDb() singleton (via
// bookingLockRepo's default param), so point that singleton at a fresh
// in-memory database for this file specifically.
vi.mock('../../../src/memory/db', async () => {
  const actual = await vi.importActual<typeof import('../../../src/memory/db')>(
    '../../../src/memory/db',
  );
  const testDb = actual.createTestDb();
  return { ...actual, getDb: () => testDb };
});

import { createEvent } from '../../../src/calendar/booking';
import { getDb } from '../../../src/memory/db';
import { getOrCreateCustomer } from '../../../src/memory/customerRepo';
import { getOrCreateActiveConversation } from '../../../src/memory/conversationRepo';

let db: Database.Database;
let conversationAId: number;
let conversationBId: number;

const SLOT = { startISO: '2025-06-10T10:00:00.000-05:00', endISO: '2025-06-10T10:30:00.000-05:00' };

beforeEach(() => {
  vi.clearAllMocks();
  freebusyQuery.mockResolvedValue({ data: { calendars: {} } });
  db = getDb();
  db.exec('DELETE FROM booking_locks; DELETE FROM conversations; DELETE FROM customers;');
  conversationAId = getOrCreateActiveConversation(getOrCreateCustomer('15550000001', 'Alice', db).id, db).id;
  conversationBId = getOrCreateActiveConversation(getOrCreateCustomer('15550000002', 'Bob', db).id, db).id;
});

describe('createEvent — booking idempotency and concurrency', () => {
  it('creates a real event on the first call', async () => {
    eventsInsert.mockResolvedValue({ data: { id: 'evt_1', htmlLink: 'https://cal/1' } });

    const result = await createEvent({ conversationId: conversationAId, summary: 'Consult — Alice', ...SLOT });

    expect(result.success).toBe(true);
    expect(eventsInsert).toHaveBeenCalledOnce();
    if (result.success) expect(result.eventId).toBe('evt_1');
  });

  it('a retry of the exact same logical request returns the cached event and never calls Google again', async () => {
    eventsInsert.mockResolvedValue({ data: { id: 'evt_1', htmlLink: 'https://cal/1' } });

    const first = await createEvent({ conversationId: conversationAId, summary: 'Consult — Alice', ...SLOT });
    const second = await createEvent({ conversationId: conversationAId, summary: 'Consult — Alice', ...SLOT });

    expect(eventsInsert).toHaveBeenCalledOnce(); // NOT twice
    expect(second.success).toBe(true);
    if (first.success && second.success) {
      expect(second.eventId).toBe(first.eventId);
    }
  });

  it('two DIFFERENT customers racing for the exact same slot: only one succeeds, the other gets a conflict without calling Google', async () => {
    eventsInsert.mockResolvedValue({ data: { id: 'evt_1', htmlLink: 'https://cal/1' } });

    const [resultA, resultB] = await Promise.all([
      createEvent({ conversationId: conversationAId, summary: 'Consult — Alice', ...SLOT }),
      createEvent({ conversationId: conversationBId, summary: 'Consult — Bob', ...SLOT }),
    ]);

    const successes = [resultA, resultB].filter((r) => r.success);
    const conflicts = [resultA, resultB].filter((r) => !r.success);
    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(eventsInsert).toHaveBeenCalledOnce(); // the loser never reached Google at all
  });

  it('concurrent IDENTICAL retries of the same request: only one calls Google, the other is told to back off (not a second event)', async () => {
    eventsInsert.mockResolvedValue({ data: { id: 'evt_1', htmlLink: 'https://cal/1' } });

    const [first, second] = await Promise.all([
      createEvent({ conversationId: conversationAId, summary: 'Consult — Alice', ...SLOT }),
      createEvent({ conversationId: conversationAId, summary: 'Consult — Alice', ...SLOT }),
    ]);

    expect(eventsInsert).toHaveBeenCalledTimes(1);
    // Exactly one of the two concurrent identical calls reflects the real
    // outcome; the other observes the in-flight attempt and reports a
    // (harmless, retryable) conflict rather than double-booking.
    const outcomes = [first, second];
    expect(outcomes.filter((r) => r.success)).toHaveLength(1);
  });

  it('a CONFIRMED Google rejection (clean 4xx) releases the lock, so a fresh attempt for the same slot can succeed afterwards', async () => {
    const confirmedRejection = Object.assign(new Error('Bad Request'), { response: { status: 400 } });
    eventsInsert.mockRejectedValueOnce(confirmedRejection);

    await expect(
      createEvent({ conversationId: conversationAId, summary: 'Consult — Alice', ...SLOT }),
    ).rejects.toThrow('Bad Request');

    eventsInsert.mockResolvedValueOnce({ data: { id: 'evt_2', htmlLink: 'https://cal/2' } });
    const retry = await createEvent({ conversationId: conversationAId, summary: 'Consult — Alice', ...SLOT });

    expect(retry.success).toBe(true);
    if (retry.success) expect(retry.eventId).toBe('evt_2');
  });

  it(
    'an AMBIGUOUS outcome (network error/timeout on insert) is marked uncertain — NOT released, NOT retried ' +
      'automatically, and never reported as success or a clean failure',
    async () => {
      const timeoutError = new DOMException('The operation was aborted', 'AbortError');
      eventsInsert.mockRejectedValueOnce(timeoutError);

      const first = await createEvent({ conversationId: conversationAId, summary: 'Consult — Alice', ...SLOT });

      expect(first.success).toBe(false);
      expect('uncertain' in first && first.uncertain).toBe(true);
      expect(eventsInsert).toHaveBeenCalledOnce();

      // A second attempt at the exact same logical request must NOT call
      // Google again — the outcome of the first attempt is still unknown.
      const second = await createEvent({ conversationId: conversationAId, summary: 'Consult — Alice', ...SLOT });

      expect(eventsInsert).toHaveBeenCalledOnce(); // still just once
      expect(second.success).toBe(false);
      expect('uncertain' in second && second.uncertain).toBe(true);

      // The slot itself must also stay locked against a DIFFERENT customer —
      // we don't know if it's actually booked or not, so it can't be handed out.
      const otherCustomerAttempt = await createEvent({
        conversationId: conversationBId,
        summary: 'Consult — Bob',
        ...SLOT,
      });
      expect(otherCustomerAttempt.success).toBe(false);
      expect(eventsInsert).toHaveBeenCalledOnce(); // still just once — never reached Google
    },
  );

  it('a 5xx Google error is treated as ambiguous (not a confirmed failure) — same safety as a network error', async () => {
    const serverError = Object.assign(new Error('Internal Server Error'), { response: { status: 500 } });
    eventsInsert.mockRejectedValueOnce(serverError);

    const result = await createEvent({ conversationId: conversationAId, summary: 'Consult — Alice', ...SLOT });

    expect(result.success).toBe(false);
    expect('uncertain' in result && result.uncertain).toBe(true);
  });

  it('a 429 (rate limited) Google error is treated as ambiguous, not a confirmed failure', async () => {
    const rateLimited = Object.assign(new Error('Too Many Requests'), { response: { status: 429 } });
    eventsInsert.mockRejectedValueOnce(rateLimited);

    const result = await createEvent({ conversationId: conversationAId, summary: 'Consult — Alice', ...SLOT });

    expect(result.success).toBe(false);
    expect('uncertain' in result && result.uncertain).toBe(true);
  });

  it('releases the lock when the final freebusy re-check finds a conflict, never calling events.insert', async () => {
    freebusyQuery.mockResolvedValueOnce({
      data: { calendars: { primary: { busy: [{ start: SLOT.startISO, end: SLOT.endISO }] } } },
    });

    const result = await createEvent({ conversationId: conversationAId, summary: 'Consult — Alice', ...SLOT });

    expect(result.success).toBe(false);
    expect('conflict' in result && result.conflict).toBe(true);
    expect(eventsInsert).not.toHaveBeenCalled();

    // slot must be free again afterwards for a genuinely new attempt
    eventsInsert.mockResolvedValueOnce({ data: { id: 'evt_3', htmlLink: 'https://cal/3' } });
    const retry = await createEvent({ conversationId: conversationAId, summary: 'Consult — Alice', ...SLOT });
    expect(retry.success).toBe(true);
  });

  it('a different slot or different summary for the same conversation is treated as a new, independent booking', async () => {
    eventsInsert
      .mockResolvedValueOnce({ data: { id: 'evt_1', htmlLink: 'https://cal/1' } })
      .mockResolvedValueOnce({ data: { id: 'evt_2', htmlLink: 'https://cal/2' } });

    const first = await createEvent({ conversationId: conversationAId, summary: 'Consult — Alice', ...SLOT });
    const second = await createEvent({
      conversationId: conversationAId,
      summary: 'Consult — Alice',
      startISO: '2025-06-11T10:00:00.000-05:00',
      endISO: '2025-06-11T10:30:00.000-05:00',
    });

    expect(eventsInsert).toHaveBeenCalledTimes(2);
    expect(first.success && second.success).toBe(true);
    if (first.success && second.success) {
      expect(second.eventId).not.toBe(first.eventId);
    }
  });

  it('two different customers booking two different slots concurrently both succeed — no false contention', async () => {
    eventsInsert
      .mockResolvedValueOnce({ data: { id: 'evt_a', htmlLink: 'https://cal/a' } })
      .mockResolvedValueOnce({ data: { id: 'evt_b', htmlLink: 'https://cal/b' } });

    const [resultA, resultB] = await Promise.all([
      createEvent({ conversationId: conversationAId, summary: 'Consult — Alice', ...SLOT }),
      createEvent({
        conversationId: conversationBId,
        summary: 'Consult — Bob',
        startISO: '2025-06-10T14:00:00.000-05:00',
        endISO: '2025-06-10T14:30:00.000-05:00',
      }),
    ]);

    expect(eventsInsert).toHaveBeenCalledTimes(2);
    expect(resultA.success).toBe(true);
    expect(resultB.success).toBe(true);
  });
});
