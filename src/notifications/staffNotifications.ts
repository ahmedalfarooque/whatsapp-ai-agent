import type Database from 'better-sqlite3';
import { getDb } from '../memory/db';

/**
 * Persistent staff notifications (table staff_notifications, migration 025): what the dashboard bell and the Human Support Queue show.
 * A row belongs to ONE business and optionally to one staff member (admin_user_id NULL = everyone who may open that business). It stays
 * until it is read or the thing it is about is resolved, so a reminder that fired while nobody was signed in is still there when they
 * come back. `ring` asks the dashboard to sound an alert the first time it shows the row (only while the dashboard is open).
 */

export type StaffNotificationStatus = 'unread' | 'read' | 'resolved';

export interface StaffNotification {
  id: number;
  whatsapp_account_id: number;
  admin_user_id: number | null;
  kind: string;
  title: string;
  body: string;
  followup_id: number | null;
  customer_id: number | null;
  ring: number;
  status: StaffNotificationStatus;
  dedupe_key: string | null;
  created_at: string;
  read_at: string | null;
  resolved_at: string | null;
}

export function createStaffNotification(
  input: { accountId: number; adminUserId?: number | null; kind: string; title: string; body: string; followupId?: number | null; customerId?: number | null; ring?: boolean; dedupeKey?: string | null },
  db: Database.Database = getDb(),
): { row: StaffNotification; created: boolean } {
  if (input.dedupeKey) {
    const existing = db.prepare('SELECT * FROM staff_notifications WHERE dedupe_key = ?').get(input.dedupeKey) as StaffNotification | undefined;
    if (existing) return { row: existing, created: false };
  }
  const result = db
    .prepare(`INSERT INTO staff_notifications (whatsapp_account_id, admin_user_id, kind, title, body, followup_id, customer_id, ring, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(input.accountId, input.adminUserId ?? null, input.kind, input.title.slice(0, 200), input.body.slice(0, 2000), input.followupId ?? null, input.customerId ?? null, input.ring ? 1 : 0, input.dedupeKey ?? null);
  return { row: db.prepare('SELECT * FROM staff_notifications WHERE id = ?').get(result.lastInsertRowid) as StaffNotification, created: true };
}

/** The notifications one staff member may see: their own and the unassigned ones, in the businesses they may open. */
export function listStaffNotifications(
  params: { accountIds: number[]; adminUserId: number; status?: StaffNotificationStatus | 'open'; afterId?: number; limit?: number },
  db: Database.Database = getDb(),
): StaffNotification[] {
  if (params.accountIds.length === 0) return [];
  const where = [`whatsapp_account_id IN (${params.accountIds.map(() => '?').join(',')})`, '(admin_user_id IS NULL OR admin_user_id = ?)'];
  const args: unknown[] = [...params.accountIds, params.adminUserId];
  if (params.status === 'open') where.push(`status IN ('unread', 'read')`);
  else if (params.status) { where.push('status = ?'); args.push(params.status); }
  if (params.afterId) { where.push('id > ?'); args.push(params.afterId); }
  args.push(Math.min(params.limit ?? 50, 200));
  return db.prepare(`SELECT * FROM staff_notifications WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(...args) as StaffNotification[];
}

export function unreadStaffNotificationCount(accountIds: number[], adminUserId: number, db: Database.Database = getDb()): number {
  if (accountIds.length === 0) return 0;
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM staff_notifications WHERE whatsapp_account_id IN (${accountIds.map(() => '?').join(',')}) AND (admin_user_id IS NULL OR admin_user_id = ?) AND status = 'unread'`)
    .get(...accountIds, adminUserId) as { n: number };
  return row.n;
}

/** Marks one notification read, only when it belongs to a business the user may open. */
export function markStaffNotificationRead(id: number, accountIds: number[], db: Database.Database = getDb()): boolean {
  if (accountIds.length === 0) return false;
  return db
    .prepare(`UPDATE staff_notifications SET status = 'read', read_at = datetime('now') WHERE id = ? AND status = 'unread' AND whatsapp_account_id IN (${accountIds.map(() => '?').join(',')})`)
    .run(id, ...accountIds).changes > 0;
}

/** When a follow-up is completed, cancelled or rescheduled its open notifications are closed so stale alerts never ring again. */
export function resolveStaffNotificationsFor(followupId: number, db: Database.Database = getDb()): number {
  return db.prepare(`UPDATE staff_notifications SET status = 'resolved', resolved_at = datetime('now') WHERE followup_id = ? AND status <> 'resolved'`).run(followupId).changes;
}
