import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../../src/memory/db';
import { getOrCreateCustomer } from '../../../src/memory/customerRepo';
import { getOrCreateActiveConversation } from '../../../src/memory/conversationRepo';
import {
  getOrCreateBookingSession,
  updateBookingSession,
  clearBookingSession,
} from '../../../src/memory/bookingSessionRepo';

let db: Database.Database;
let conversationId: number;

beforeEach(() => {
  db = createTestDb();
  const customerId = getOrCreateCustomer('15551234567', 'Alice', db).id;
  conversationId = getOrCreateActiveConversation(customerId, db).id;
});

describe('booking session state', () => {
  it('creates an in_progress session on first access', () => {
    const session = getOrCreateBookingSession(conversationId, db);
    expect(session.status).toBe('in_progress');
  });

  it('persists partial slot-filling data across calls (multi-turn booking)', () => {
    updateBookingSession(conversationId, { serviceType: 'Consultation' }, db);
    updateBookingSession(conversationId, { preferredDate: '2025-01-15' }, db);
    const session = updateBookingSession(conversationId, { customerName: 'Alice' }, db);

    expect(session.service_type).toBe('Consultation');
    expect(session.preferred_date).toBe('2025-01-15');
    expect(session.customer_name).toBe('Alice');
  });

  it('marks a session confirmed and stores the calendar event id', () => {
    const session = updateBookingSession(
      conversationId,
      { status: 'confirmed', calendarEventId: 'evt_123' },
      db,
    );
    expect(session.status).toBe('confirmed');
    expect(session.calendar_event_id).toBe('evt_123');
  });

  it('clears the booking session (e.g. on restart)', () => {
    updateBookingSession(conversationId, { serviceType: 'Consultation' }, db);
    clearBookingSession(conversationId, db);
    const fresh = getOrCreateBookingSession(conversationId, db);
    expect(fresh.service_type).toBeNull();
  });
});
