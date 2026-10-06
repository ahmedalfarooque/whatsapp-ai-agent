import type Database from 'better-sqlite3';
import { getDb } from './db';

export type CustomerLanguage = 'en' | 'ar';

export interface Customer {
  id: number;
  wa_id: string;
  display_name: string | null;
  language: CustomerLanguage | null;
  automation_paused: number;
  paused_at: string | null;
  pause_reason: string | null;
  last_menu_options: string | null;
  /** Guided-menu position: MAIN_MENU, SUBMENU_*, APPOINTMENT_STEP_n, QUOTATION_STEP_n, AWAITING_LANGUAGE_SWITCH — null = no menu context yet. */
  menu_state: string | null;
  /** JSON blob of answers collected so far in a multi-step flow. */
  flow_data: string | null;
  /** Chat address (may be an opaque @lid) the customer last wrote from; replies go back there. */
  reply_jid: string | null;
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

/** Persists the customer's chosen menu language (or clears it back to unset with null). */
export function setCustomerLanguage(
  customerId: number,
  language: CustomerLanguage | null,
  db: Database.Database = getDb(),
): Customer {
  db.prepare(
    "UPDATE customers SET language = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(language, customerId);

  return db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId) as Customer;
}

/** Pauses automation for one customer (human takes over). Idempotent. */
export function pauseCustomerAutomation(
  customerId: number,
  reason: string,
  db: Database.Database = getDb(),
): Customer {
  db.prepare(
    `UPDATE customers SET automation_paused = 1, paused_at = datetime('now'), pause_reason = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(reason, customerId);
  return db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId) as Customer;
}

export function resumeCustomerAutomation(customerId: number, db: Database.Database = getDb()): Customer {
  db.prepare(
    `UPDATE customers SET automation_paused = 0, paused_at = NULL, pause_reason = NULL, updated_at = datetime('now') WHERE id = ?`,
  ).run(customerId);
  return db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId) as Customer;
}

export interface PausedCustomer {
  id: number;
  wa_id: string;
  display_name: string | null;
  language: CustomerLanguage | null;
  paused_at: string | null;
  pause_reason: string | null;
  lastMessage: string | null;
  lastMessageAt: string | null;
}

/** Customers currently waiting for a human — the support queue. */
export function listPausedCustomers(db: Database.Database = getDb()): PausedCustomer[] {
  return db
    .prepare(
      `SELECT cu.id, cu.wa_id, cu.display_name, cu.language, cu.paused_at, cu.pause_reason,
              (SELECT m.content FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id
                WHERE c.customer_id = cu.id AND m.role = 'user' ORDER BY m.id DESC LIMIT 1) AS lastMessage,
              (SELECT MAX(m.created_at) FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id
                WHERE c.customer_id = cu.id) AS lastMessageAt
       FROM customers cu WHERE cu.automation_paused = 1 ORDER BY cu.paused_at DESC`,
    )
    .all() as PausedCustomer[];
}

/** Remembers the option IDs of the last numbered menu so "2" can be mapped back to a stable ID. */
export function setLastMenuOptions(customerId: number, ids: string[], db: Database.Database = getDb()): void {
  db.prepare('UPDATE customers SET last_menu_options = ? WHERE id = ?').run(JSON.stringify(ids), customerId);
}

export function getLastMenuOptions(customerId: number, db: Database.Database = getDb()): string[] {
  const row = db.prepare('SELECT last_menu_options FROM customers WHERE id = ?').get(customerId) as
    | { last_menu_options: string | null }
    | undefined;
  if (!row?.last_menu_options) return [];
  try {
    const parsed: unknown = JSON.parse(row.last_menu_options);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
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

/** Moves the customer through the guided menu; flowData replaces the collected answers (null clears them). */
export function setCustomerMenuState(
  customerId: number,
  state: string | null,
  flowData: Record<string, string> | null = null,
  db: Database.Database = getDb(),
): Customer {
  db.prepare("UPDATE customers SET menu_state = ?, flow_data = ?, updated_at = datetime('now') WHERE id = ?").run(
    state,
    flowData ? JSON.stringify(flowData) : null,
    customerId,
  );
  return db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId) as Customer;
}

export function getCustomerFlowData(customer: Pick<Customer, 'flow_data'>): Record<string, string> {
  if (!customer.flow_data) return {};
  try {
    const parsed: unknown = JSON.parse(customer.flow_data);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Remembers the chat address the customer last wrote from (phone JID or @lid). */
export function setCustomerReplyJid(customerId: number, replyJid: string, db: Database.Database = getDb()): void {
  db.prepare('UPDATE customers SET reply_jid = ? WHERE id = ? AND (reply_jid IS NULL OR reply_jid <> ?)').run(replyJid, customerId, replyJid);
}
