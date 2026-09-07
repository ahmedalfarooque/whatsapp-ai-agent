import type Database from 'better-sqlite3';
import { getDb } from './db';
import { BOOKING_STATUS } from '../config/constants';

export interface BookingSession {
  id: number;
  conversation_id: number;
  status: 'in_progress' | 'confirmed' | 'abandoned';
  service_type: string | null;
  preferred_date: string | null;
  preferred_time: string | null;
  duration_minutes: number | null;
  customer_name: string | null;
  calendar_event_id: string | null;
  updated_at: string;
}

export function getOrCreateBookingSession(
  conversationId: number,
  db: Database.Database = getDb(),
): BookingSession {
  const existing = db
    .prepare('SELECT * FROM booking_sessions WHERE conversation_id = ?')
    .get(conversationId) as BookingSession | undefined;
  if (existing) return existing;

  const result = db
    .prepare('INSERT INTO booking_sessions (conversation_id, status) VALUES (?, ?)')
    .run(conversationId, BOOKING_STATUS.IN_PROGRESS);

  return db
    .prepare('SELECT * FROM booking_sessions WHERE id = ?')
    .get(result.lastInsertRowid) as BookingSession;
}

export interface BookingSlotsPatch {
  serviceType?: string;
  preferredDate?: string;
  preferredTime?: string;
  durationMinutes?: number;
  customerName?: string;
  calendarEventId?: string;
  status?: BookingSession['status'];
}

export function updateBookingSession(
  conversationId: number,
  patch: BookingSlotsPatch,
  db: Database.Database = getDb(),
): BookingSession {
  getOrCreateBookingSession(conversationId, db);

  const fields: string[] = [];
  const values: Record<string, unknown> = { conversation_id: conversationId };

  if (patch.serviceType !== undefined) {
    fields.push('service_type = @service_type');
    values.service_type = patch.serviceType;
  }
  if (patch.preferredDate !== undefined) {
    fields.push('preferred_date = @preferred_date');
    values.preferred_date = patch.preferredDate;
  }
  if (patch.preferredTime !== undefined) {
    fields.push('preferred_time = @preferred_time');
    values.preferred_time = patch.preferredTime;
  }
  if (patch.durationMinutes !== undefined) {
    fields.push('duration_minutes = @duration_minutes');
    values.duration_minutes = patch.durationMinutes;
  }
  if (patch.customerName !== undefined) {
    fields.push('customer_name = @customer_name');
    values.customer_name = patch.customerName;
  }
  if (patch.calendarEventId !== undefined) {
    fields.push('calendar_event_id = @calendar_event_id');
    values.calendar_event_id = patch.calendarEventId;
  }
  if (patch.status !== undefined) {
    fields.push('status = @status');
    values.status = patch.status;
  }

  if (fields.length > 0) {
    fields.push("updated_at = datetime('now')");
    db.prepare(
      `UPDATE booking_sessions SET ${fields.join(', ')} WHERE conversation_id = @conversation_id`,
    ).run(values);
  }

  return db
    .prepare('SELECT * FROM booking_sessions WHERE conversation_id = ?')
    .get(conversationId) as BookingSession;
}

export function clearBookingSession(
  conversationId: number,
  db: Database.Database = getDb(),
): void {
  db.prepare('DELETE FROM booking_sessions WHERE conversation_id = ?').run(conversationId);
}
