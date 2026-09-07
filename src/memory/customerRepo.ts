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
