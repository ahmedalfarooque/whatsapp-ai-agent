import type Database from 'better-sqlite3';
import { getDb } from '../memory/db';
import { logger, maskWaId } from '../logger';
import { currentAccountId, runWithAccount } from '../accounts/accountContext';

/**
 * WhatsApp notification outbox. Anything the system owes a WhatsApp user
 * (business alert for a new request, customer confirmation, operator command
 * result) is written here first with an idempotency key, then delivered by
 * flushOutbox() through whichever sender the connection manager registers.
 * Every row carries the WhatsApp account it must leave from: the sender is
 * told which account's socket to use, and a disconnected account only defers
 * its own rows — other accounts keep delivering. Delivery never blocks the
 * caller; failures are retried with backoff.
 */

export type OutboxKind = 'business_new_request' | 'business_status' | 'customer_status' | 'operator_result';
export type OutboxStatus = 'pending' | 'sent' | 'failed';

export interface OutboxRow {
  id: number;
  whatsapp_account_id: number;
  dedupe_key: string;
  kind: OutboxKind;
  request_id: number | null;
  target_jid: string;
  body: string;
  status: OutboxStatus;
  attempts: number;
  last_error: string | null;
  message_id: string | null;
  next_attempt_at: string;
  created_at: string;
  sent_at: string | null;
}

/** Delivers one message through the given account's connection; throws NotConnectedError when that account is offline. */
export type OutboxSender = (jid: string, text: string, accountId: number) => Promise<string | null>;

export class NotConnectedError extends Error {
  constructor(accountId?: number) {
    super(accountId === undefined ? 'WhatsApp session is not connected' : `WhatsApp account ${accountId} is not connected`);
  }
}

/** SQLite-style UTC timestamp ('YYYY-MM-DD HH:MM:SS'), comparable with datetime('now'). */
function sqliteTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

let sender: OutboxSender | null = null;
let flushing: Promise<number> | null = null;

/** The connection manager registers how a message actually leaves; tests register a fake. */
export function registerOutboxSender(fn: OutboxSender | null): void {
  sender = fn;
}

const MAX_ATTEMPTS = 12;
const BACKOFF_S = [5, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 3600, 3600];

/** Idempotent: a second call with the same dedupeKey is a no-op and returns the existing row. */
export function enqueueNotification(
  input: { kind: OutboxKind; requestId?: number | null; targetJid: string; body: string; dedupeKey: string; accountId?: number },
  db: Database.Database = getDb(),
): { row: OutboxRow; created: boolean } {
  const existing = db.prepare('SELECT * FROM notification_outbox WHERE dedupe_key = ?').get(input.dedupeKey) as OutboxRow | undefined;
  if (existing) return { row: existing, created: false };
  const result = db
    .prepare(
      `INSERT INTO notification_outbox (dedupe_key, kind, request_id, target_jid, body, whatsapp_account_id)
       VALUES (@dedupeKey, @kind, @requestId, @targetJid, @body, @accountId)`,
    )
    .run({
      dedupeKey: input.dedupeKey, kind: input.kind, requestId: input.requestId ?? null, targetJid: input.targetJid, body: input.body,
      accountId: input.accountId ?? currentAccountId(),
    });
  const row = db.prepare('SELECT * FROM notification_outbox WHERE id = ?').get(result.lastInsertRowid) as OutboxRow;
  return { row, created: true };
}

export function listOutbox(
  params: { requestId?: number; status?: OutboxStatus; limit?: number; accountId?: number | null } = {},
  db: Database.Database = getDb(),
): OutboxRow[] {
  const where: string[] = [];
  const accountId = params.accountId === undefined ? currentAccountId() : params.accountId;
  if (accountId !== null) where.push('whatsapp_account_id = @accountId');
  if (params.requestId !== undefined) where.push('request_id = @requestId');
  if (params.status) where.push('status = @status');
  return db
    .prepare(`SELECT * FROM notification_outbox ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT @limit`)
    .all({ requestId: params.requestId, status: params.status, limit: Math.min(params.limit ?? 100, 500), accountId }) as OutboxRow[];
}

export function outboxSummary(db: Database.Database = getDb(), accountId: number = currentAccountId()): Record<OutboxStatus, number> {
  const out: Record<OutboxStatus, number> = { pending: 0, sent: 0, failed: 0 };
  for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM notification_outbox WHERE whatsapp_account_id = ? GROUP BY status').all(accountId) as { status: OutboxStatus; n: number }[]) out[r.status] = r.n;
  return out;
}

/** Puts a failed row back into the queue for an immediate retry (scoped to the account so ids cannot cross businesses). */
export function retryNotification(id: number, db: Database.Database = getDb(), accountId: number = currentAccountId()): boolean {
  const r = db
    .prepare(`UPDATE notification_outbox SET status = 'pending', next_attempt_at = datetime('now'), attempts = 0, last_error = NULL WHERE id = ? AND whatsapp_account_id = ? AND status <> 'sent'`)
    .run(id, accountId);
  return r.changes > 0;
}

/**
 * Sends every due pending row (all accounts) through the registered sender.
 * Serialised (one flush at a time). Returns the number delivered. Never
 * throws. An account that is not connected only skips its own rows.
 */
export function flushOutbox(db: Database.Database = getDb()): Promise<number> {
  if (flushing) return flushing;
  let settled = false;
  let self: Promise<number> | null = null;
  const run = (async () => {
    let delivered = 0;
    try {
      if (!sender) return 0;
      const due = db
        .prepare(`SELECT * FROM notification_outbox WHERE status = 'pending' AND next_attempt_at <= datetime('now') ORDER BY id ASC LIMIT 50`)
        .all() as OutboxRow[];
      const offlineAccounts = new Set<number>();
      for (const row of due) {
        if (offlineAccounts.has(row.whatsapp_account_id)) continue;
        try {
          const messageId = await runWithAccount(row.whatsapp_account_id, () => sender!(row.target_jid, row.body, row.whatsapp_account_id));
          db.prepare(`UPDATE notification_outbox SET status = 'sent', sent_at = datetime('now'), message_id = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?`).run(messageId, row.id);
          delivered += 1;
          logger.info({ id: row.id, kind: row.kind, account: row.whatsapp_account_id, to: maskWaId(row.target_jid), messageId }, '[OUTBOX] delivered');
        } catch (error) {
          const attempts = row.attempts + 1;
          const notConnected = error instanceof NotConnectedError;
          const exhausted = !notConnected && attempts >= MAX_ATTEMPTS;
          const delay = BACKOFF_S[Math.min(attempts, BACKOFF_S.length) - 1] ?? 3600;
          db.prepare(
            `UPDATE notification_outbox SET status = @status, attempts = @attempts, last_error = @error,
               next_attempt_at = @nextAttemptAt WHERE id = @id`,
          ).run({ id: row.id, status: exhausted ? 'failed' : 'pending', attempts: notConnected ? row.attempts : attempts, error: String((error as Error).message ?? error).slice(0, 300), nextAttemptAt: sqliteTime(Date.now() + (notConnected ? 30 : delay) * 1000) });
          logger.warn({ id: row.id, kind: row.kind, account: row.whatsapp_account_id, attempts, notConnected, error: String((error as Error).message) }, '[OUTBOX] delivery deferred');
          if (notConnected) offlineAccounts.add(row.whatsapp_account_id); // nothing else leaves this account until it reconnects
        }
      }
      return delivered;
    } finally {
      settled = true;
      if (self && flushing === self) flushing = null;
    }
  })();
  self = run;
  // A run that finished synchronously (no sender / nothing due) must never linger as the in-flight marker.
  if (!settled) flushing = run;
  return run;
}
