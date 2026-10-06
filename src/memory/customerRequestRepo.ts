import type Database from 'better-sqlite3';
import { getDb } from './db';

export type CustomerRequestKind = 'appointment' | 'quotation';
export const REQUEST_STATUSES = ['pending', 'contacted', 'confirmed', 'rejected', 'cancelled', 'completed', 'closed'] as const;
export type CustomerRequestStatus = (typeof REQUEST_STATUSES)[number];

export interface RequestEvent {
  id: number;
  request_id: number;
  reference: string;
  old_status: string | null;
  new_status: string;
  actor: 'dashboard' | 'whatsapp' | 'system';
  actor_detail: string | null;
  created_at: string;
}

export interface CustomerRequest {
  id: number;
  reference: string;
  customer_id: number;
  wa_id: string;
  kind: CustomerRequestKind;
  payload: Record<string, string>;
  status: CustomerRequestStatus;
  created_at: string;
  updated_at: string;
}

interface Row extends Omit<CustomerRequest, 'payload'> {
  payload: string;
}

function toRequest(row: Row): CustomerRequest {
  let payload: Record<string, string> = {};
  try {
    const parsed: unknown = JSON.parse(row.payload);
    if (parsed && typeof parsed === 'object') payload = parsed as Record<string, string>;
  } catch {
    payload = {};
  }
  return { ...row, payload };
}

const PREFIX: Record<CustomerRequestKind, string> = { appointment: 'APT', quotation: 'INQ' };

/**
 * Stores a menu-collected request and returns it with a human-readable
 * reference (e.g. INQ-2026-4821) the customer can quote to staff.
 */
export function createCustomerRequest(
  input: { customerId: number; waId: string; kind: CustomerRequestKind; payload: Record<string, string> },
  db: Database.Database = getDb(),
): CustomerRequest {
  const year = new Date().getFullYear();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const reference = `${PREFIX[input.kind]}-${year}-${String(1000 + Math.floor(Math.random() * 9000))}`;
    try {
      const result = db
        .prepare(
          `INSERT INTO customer_requests (reference, customer_id, wa_id, kind, payload)
           VALUES (@reference, @customerId, @waId, @kind, @payload)`,
        )
        .run({ reference, customerId: input.customerId, waId: input.waId, kind: input.kind, payload: JSON.stringify(input.payload) });
      return toRequest(db.prepare('SELECT * FROM customer_requests WHERE id = ?').get(result.lastInsertRowid) as Row);
    } catch (error) {
      if (!String((error as Error).message).includes('UNIQUE')) throw error;
    }
  }
  throw new Error('Could not allocate a unique request reference');
}

export function listCustomerRequests(
  params: { kind?: CustomerRequestKind; status?: CustomerRequestStatus; limit?: number } = {},
  db: Database.Database = getDb(),
): CustomerRequest[] {
  const limit = Math.max(1, Math.min(params.limit ?? 50, 200));
  const where: string[] = [];
  if (params.kind) where.push('kind = @kind');
  if (params.status) where.push('status = @status');
  const rows = db
    .prepare(
      `SELECT * FROM customer_requests ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at DESC, id DESC LIMIT @limit`,
    )
    .all({ kind: params.kind, status: params.status, limit }) as Row[];
  return rows.map(toRequest);
}

export function getCustomerRequest(id: number, db: Database.Database = getDb()): CustomerRequest | undefined {
  const row = db.prepare('SELECT * FROM customer_requests WHERE id = ?').get(id) as Row | undefined;
  return row ? toRequest(row) : undefined;
}

export function getCustomerRequestByReference(reference: string, db: Database.Database = getDb()): CustomerRequest | undefined {
  const row = db.prepare('SELECT * FROM customer_requests WHERE reference = ?').get(reference.toUpperCase()) as Row | undefined;
  return row ? toRequest(row) : undefined;
}

/** Plain status write — use requestService.changeRequestStatus() for audited, notifying transitions. */
export function setCustomerRequestStatus(id: number, status: CustomerRequestStatus, db: Database.Database = getDb()): CustomerRequest | undefined {
  db.prepare(`UPDATE customer_requests SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, id);
  return getCustomerRequest(id, db);
}

export function insertRequestEvent(
  input: { requestId: number; reference: string; oldStatus: string | null; newStatus: string; actor: RequestEvent['actor']; actorDetail: string | null },
  db: Database.Database = getDb(),
): RequestEvent {
  const r = db
    .prepare(
      `INSERT INTO request_events (request_id, reference, old_status, new_status, actor, actor_detail)
       VALUES (@requestId, @reference, @oldStatus, @newStatus, @actor, @actorDetail)`,
    )
    .run(input);
  return db.prepare('SELECT * FROM request_events WHERE id = ?').get(r.lastInsertRowid) as RequestEvent;
}

export function listRequestEvents(requestId: number, db: Database.Database = getDb()): RequestEvent[] {
  return db.prepare('SELECT * FROM request_events WHERE request_id = ? ORDER BY id ASC').all(requestId) as RequestEvent[];
}

export function updateCustomerRequestStatus(
  id: number,
  status: CustomerRequestStatus,
  db: Database.Database = getDb(),
): CustomerRequest | undefined {
  db.prepare(`UPDATE customer_requests SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, id);
  const row = db.prepare('SELECT * FROM customer_requests WHERE id = ?').get(id) as Row | undefined;
  return row ? toRequest(row) : undefined;
}

export function countCustomerRequests(status: CustomerRequestStatus = 'pending', db: Database.Database = getDb()): number {
  return (db.prepare('SELECT COUNT(*) AS count FROM customer_requests WHERE status = ?').get(status) as { count: number }).count;
}
