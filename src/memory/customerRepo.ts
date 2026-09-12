import type Database from 'better-sqlite3';
import { getDb } from './db';

export interface Customer {
  id: number;
  wa_id: string;
  display_name: string | null;
  created_at: string;
  updated_at: string;
}

/** Normalizes a WhatsApp wa_id to a consistent digits-only form for lookups. */
export function normalizeWaId(waId: string): string {
  return waId.replace(/[^\d]/g, '');
}

export function getOrCreateCustomer(
  waId: string,
  displayName: string | undefined,
  db: Database.Database = getDb(),
): Customer {
  const normalized = normalizeWaId(waId);
  const existing = db
    .prepare('SELECT * FROM customers WHERE wa_id = ?')
    .get(normalized) as Customer | undefined;

  if (existing) {
    if (displayName && displayName !== existing.display_name) {
      db.prepare(
        "UPDATE customers SET display_name = ?, updated_at = datetime('now') WHERE id = ?",
      ).run(displayName, existing.id);
      return { ...existing, display_name: displayName };
    }
    return existing;
  }

  const result = db
    .prepare('INSERT INTO customers (wa_id, display_name) VALUES (?, ?)')
    .run(normalized, displayName ?? null);

  return db
    .prepare('SELECT * FROM customers WHERE id = ?')
    .get(result.lastInsertRowid) as Customer;
}

export function getCustomerByWaId(
  waId: string,
  db: Database.Database = getDb(),
): Customer | undefined {
  return db
    .prepare('SELECT * FROM customers WHERE wa_id = ?')
    .get(normalizeWaId(waId)) as Customer | undefined;
}

export interface CustomerListItem extends Customer {
  conversationCount: number;
  bookingCount: number;
  lastInteractionAt: string | null;
}

const MAX_PAGE_SIZE = 100;

/**
 * Admin/dashboard listing — bounded, optionally filtered by a search term
 * matched against wa_id or display_name. Never returns more than
 * MAX_PAGE_SIZE rows regardless of what the caller asks for.
 */
export function listCustomers(
  params: { search?: string; limit?: number; offset?: number } = {},
  db: Database.Database = getDb(),
): { items: CustomerListItem[]; total: number } {
  const limit = Math.max(1, Math.min(params.limit ?? 25, MAX_PAGE_SIZE));
  const offset = Math.max(0, params.offset ?? 0);
  const search = params.search?.trim();
  const whereClause = search ? 'WHERE cu.wa_id LIKE @term OR cu.display_name LIKE @term' : '';
  const term = search ? `%${search}%` : undefined;

  const total = (
    db
      .prepare(`SELECT COUNT(*) AS count FROM customers cu ${whereClause}`)
      .get(term ? { term } : {}) as { count: number }
  ).count;

  const items = db
    .prepare(
      `SELECT cu.*,
              (SELECT COUNT(*) FROM conversations c WHERE c.customer_id = cu.id) AS conversationCount,
              (SELECT COUNT(*) FROM booking_locks bl
                 JOIN conversations c2 ON c2.id = bl.conversation_id
                WHERE c2.customer_id = cu.id AND bl.status = 'confirmed') AS bookingCount,
              (SELECT MAX(m.created_at) FROM conversation_messages m
                 JOIN conversations c3 ON c3.id = m.conversation_id
                WHERE c3.customer_id = cu.id) AS lastInteractionAt
       FROM customers cu
       ${whereClause}
       ORDER BY COALESCE(lastInteractionAt, cu.created_at) DESC
       LIMIT @limit OFFSET @offset`,
    )
    .all({ term, limit, offset } as Record<string, unknown>) as CustomerListItem[];

  return { items, total };
}

export function getCustomerById(id: number, db: Database.Database = getDb()): CustomerListItem | undefined {
  return db
    .prepare(
      `SELECT cu.*,
              (SELECT COUNT(*) FROM conversations c WHERE c.customer_id = cu.id) AS conversationCount,
              (SELECT COUNT(*) FROM booking_locks bl
                 JOIN conversations c2 ON c2.id = bl.conversation_id
                WHERE c2.customer_id = cu.id AND bl.status = 'confirmed') AS bookingCount,
              (SELECT MAX(m.created_at) FROM conversation_messages m
                 JOIN conversations c3 ON c3.id = m.conversation_id
                WHERE c3.customer_id = cu.id) AS lastInteractionAt
       FROM customers cu WHERE cu.id = ?`,
    )
    .get(id) as CustomerListItem | undefined;
}
