import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { getDb } from '../memory/db';
import { currentAccountId } from '../accounts/accountContext';

/**
 * Storage for customer follow-up requests (callbacks and staff WhatsApp messages), table followup_requests (migration 025).
 * Pure data access; the rules (time windows, transitions, notifications, jobs) live in followupService.ts.
 */

export type FollowupStatus = 'pending' | 'scheduled' | 'eligible' | 'assigned' | 'completed' | 'cancelled' | 'overdue';
export type ContactMethod = 'call' | 'whatsapp';
export const ACTIVE_FOLLOWUP_STATUSES: readonly FollowupStatus[] = ['pending', 'scheduled', 'eligible', 'assigned', 'overdue'];

export interface FollowupRequest {
  id: number;
  whatsapp_account_id: number;
  customer_id: number;
  conversation_id: number | null;
  reference: string;
  contact_method: ContactMethod;
  appointment_type_key: string | null;
  appointment_type_label: string | null;
  /** UTC ISO; null = "as soon as staff are available". */
  requested_at: string | null;
  timezone: string;
  asap: number;
  status: FollowupStatus;
  eligible_at: string | null;
  window_end_at: string | null;
  assigned_admin_id: number | null;
  customer_note: string | null;
  outcome: string | null;
  outcome_note: string | null;
  source: 'customer' | 'staff' | 'ai';
  reminder_attempts: number;
  last_notified_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface FollowupEvent {
  id: number;
  followup_id: number;
  event: string;
  from_status: string | null;
  to_status: string | null;
  actor_type: 'customer' | 'staff' | 'system';
  actor_admin_id: number | null;
  detail: string | null;
  created_at: string;
}

export type FollowupActor = { type: 'customer' } | { type: 'system' } | { type: 'staff'; adminId: number };

function newReference(): string {
  return `CB-${Date.now().toString(36).toUpperCase().slice(-5)}${randomBytes(2).toString('hex').toUpperCase()}`;
}

export function insertFollowup(
  input: {
    customerId: number; conversationId?: number | null; contactMethod: ContactMethod; appointmentTypeKey?: string | null; appointmentTypeLabel?: string | null;
    requestedAt: string | null; timezone: string; asap: boolean; status: FollowupStatus; eligibleAt?: string | null; windowEndAt?: string | null;
    customerNote?: string | null; source?: 'customer' | 'staff' | 'ai';
  },
  db: Database.Database = getDb(),
  accountId: number = currentAccountId(),
): FollowupRequest {
  const result = db
    .prepare(
      `INSERT INTO followup_requests (whatsapp_account_id, customer_id, conversation_id, reference, contact_method, appointment_type_key, appointment_type_label, requested_at, timezone, asap, status, eligible_at, window_end_at, customer_note, source)
       VALUES (@accountId, @customerId, @conversationId, @reference, @contactMethod, @typeKey, @typeLabel, @requestedAt, @timezone, @asap, @status, @eligibleAt, @windowEndAt, @customerNote, @source)`,
    )
    .run({
      accountId, customerId: input.customerId, conversationId: input.conversationId ?? null, reference: newReference(), contactMethod: input.contactMethod,
      typeKey: input.appointmentTypeKey ?? null, typeLabel: input.appointmentTypeLabel ?? null, requestedAt: input.requestedAt, timezone: input.timezone, asap: input.asap ? 1 : 0,
      status: input.status, eligibleAt: input.eligibleAt ?? null, windowEndAt: input.windowEndAt ?? null, customerNote: input.customerNote ?? null, source: input.source ?? 'customer',
    });
  return db.prepare('SELECT * FROM followup_requests WHERE id = ?').get(result.lastInsertRowid) as FollowupRequest;
}

/** A follow-up of THIS business only: another business's id is simply not found. */
export function getFollowup(id: number, db: Database.Database = getDb(), accountId: number = currentAccountId()): FollowupRequest | undefined {
  return db.prepare('SELECT * FROM followup_requests WHERE id = ? AND whatsapp_account_id = ?').get(id, accountId) as FollowupRequest | undefined;
}

export function getFollowupAnyAccount(id: number, db: Database.Database = getDb()): FollowupRequest | undefined {
  return db.prepare('SELECT * FROM followup_requests WHERE id = ?').get(id) as FollowupRequest | undefined;
}

export function updateFollowup(id: number, patch: Partial<Record<keyof FollowupRequest, string | number | null>>, db: Database.Database = getDb()): FollowupRequest {
  const entries = Object.entries(patch).filter(([k]) => k !== 'id' && k !== 'whatsapp_account_id');
  if (entries.length) {
    db.prepare(`UPDATE followup_requests SET ${entries.map(([k]) => `${k} = @${k}`).join(', ')}, updated_at = datetime('now') WHERE id = @id`).run({ id, ...Object.fromEntries(entries) });
  }
  return db.prepare('SELECT * FROM followup_requests WHERE id = ?').get(id) as FollowupRequest;
}

export function addFollowupEvent(
  input: { followupId: number; accountId: number; event: string; fromStatus?: string | null; toStatus?: string | null; actor: FollowupActor; detail?: string | null },
  db: Database.Database = getDb(),
): void {
  db.prepare(`INSERT INTO followup_events (followup_id, whatsapp_account_id, event, from_status, to_status, actor_type, actor_admin_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(input.followupId, input.accountId, input.event, input.fromStatus ?? null, input.toStatus ?? null, input.actor.type, input.actor.type === 'staff' ? input.actor.adminId : null, input.detail ?? null);
}

export function listFollowupEvents(followupId: number, db: Database.Database = getDb()): FollowupEvent[] {
  return db.prepare('SELECT * FROM followup_events WHERE followup_id = ? ORDER BY id').all(followupId) as FollowupEvent[];
}

export interface FollowupListItem extends FollowupRequest {
  customer_name: string | null;
  customer_wa_id: string;
  customer_language: string | null;
  assigned_to_name: string | null;
}

export function listFollowups(
  params: { statuses?: readonly FollowupStatus[]; customerId?: number; assignedAdminId?: number; limit?: number } = {},
  db: Database.Database = getDb(),
  accountId: number = currentAccountId(),
): FollowupListItem[] {
  const where = ['f.whatsapp_account_id = @accountId'];
  const args: Record<string, unknown> = { accountId, limit: Math.min(params.limit ?? 100, 500) };
  if (params.statuses?.length) where.push(`f.status IN (${params.statuses.map((s) => `'${s}'`).join(',')})`);
  if (params.customerId) { where.push('f.customer_id = @customerId'); args.customerId = params.customerId; }
  if (params.assignedAdminId) { where.push('f.assigned_admin_id = @assignedAdminId'); args.assignedAdminId = params.assignedAdminId; }
  return db
    .prepare(
      `SELECT f.*, c.display_name AS customer_name, c.wa_id AS customer_wa_id, c.language AS customer_language, COALESCE(a.display_name, a.username) AS assigned_to_name
       FROM followup_requests f JOIN customers c ON c.id = f.customer_id LEFT JOIN admin_users a ON a.id = f.assigned_admin_id
       WHERE ${where.join(' AND ')} ORDER BY CASE WHEN f.requested_at IS NULL THEN 1 ELSE 0 END, f.requested_at, f.id DESC LIMIT @limit`,
    )
    .all(args) as FollowupListItem[];
}

/** The customer's own open requests (what "cancel an existing request" lists). */
export function activeFollowupsForCustomer(customerId: number, db: Database.Database = getDb(), accountId: number = currentAccountId()): FollowupRequest[] {
  return db
    .prepare(`SELECT * FROM followup_requests WHERE customer_id = ? AND whatsapp_account_id = ? AND status IN ('pending','scheduled','eligible','assigned','overdue') ORDER BY id`)
    .all(customerId, accountId) as FollowupRequest[];
}

export function followupCounts(db: Database.Database = getDb(), accountId: number = currentAccountId()): Record<FollowupStatus, number> {
  const out: Record<FollowupStatus, number> = { pending: 0, scheduled: 0, eligible: 0, assigned: 0, completed: 0, cancelled: 0, overdue: 0 };
  for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM followup_requests WHERE whatsapp_account_id = ? GROUP BY status').all(accountId) as { status: FollowupStatus; n: number }[]) out[r.status] = r.n;
  return out;
}

/** The contact method of this customer's most recent request (any status), or null when they never made one: the default for the next callback. */
export function lastContactMethod(customerId: number, db: Database.Database = getDb(), accountId: number = currentAccountId()): ContactMethod | null {
  const row = db.prepare(`SELECT contact_method FROM followup_requests WHERE customer_id = ? AND whatsapp_account_id = ? AND source = 'customer' ORDER BY id DESC LIMIT 1`).get(customerId, accountId) as { contact_method: ContactMethod } | undefined;
  return row?.contact_method ?? null;
}