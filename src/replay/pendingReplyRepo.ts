import type Database from 'better-sqlite3';
import { getDb } from '../memory/db';
import { currentAccountId } from '../accounts/accountContext';

/**
 * Customer messages that went to the AI path and what became of them (table pending_replies, migration 028). The row is the bookkeeping
 * that lets an interrupted or unanswered message be answered LATER, once and safely (src/replay/replayWorker.ts). It holds no customer text:
 * the words stay in `messages`, found by whatsapp_message_id.
 */
export type PendingStatus = 'pending' | 'awaiting_ai' | 'interrupted' | 'replaying' | 'answered' | 'abandoned' | 'needs_staff';

export interface PendingReply {
  id: number;
  whatsapp_account_id: number;
  customer_id: number;
  conversation_id: number;
  message_id: string;
  wa_id: string;
  channel: string;
  status: PendingStatus;
  attempts: number;
  recovered: number;
  last_error: string | null;
  last_attempt_at: string | null;
  created_at: string;
  updated_at: string;
  settled_at: string | null;
}

/** A waiting message is replayed only within this age and at most this many times (src/replay/replayWorker.ts). */
export const REPLAY_MAX_AGE_MS = 6 * 60 * 60_000;
export const MAX_REPLAY_ATTEMPTS = 3;

const OPEN_STATUSES: PendingStatus[] = ['pending', 'awaiting_ai', 'interrupted', 'replaying'];

/** Opens the record when a message enters the AI step (idempotent: the same message id is one row). */
export function openPendingReply(
  input: { customerId: number; conversationId: number; messageId: string; waId: string; channel: string },
  db: Database.Database = getDb(),
  accountId: number = currentAccountId(),
): void {
  db.prepare(
    `INSERT OR IGNORE INTO pending_replies (whatsapp_account_id, customer_id, conversation_id, message_id, wa_id, channel) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(accountId, input.customerId, input.conversationId, input.messageId, input.waId, input.channel);
}

/**
 * Settles a message. `answered` / `abandoned` / `needs_staff` close it; `awaiting_ai` keeps it for a later replay. A row that is already
 * closed is never changed (a late settle cannot reopen an answered message). `recovered` marks an answer produced by a replay.
 */
export function settlePendingReply(
  messageId: string,
  status: 'answered' | 'abandoned' | 'needs_staff' | 'awaiting_ai',
  detail: string | null = null,
  opts: { recovered?: boolean } = {},
  db: Database.Database = getDb(),
  accountId: number = currentAccountId(),
): boolean {
  const closes = status !== 'awaiting_ai';
  const r = db
    .prepare(
      `UPDATE pending_replies SET status = ?, last_error = ?, recovered = CASE WHEN ? THEN 1 ELSE recovered END, updated_at = datetime('now'), settled_at = CASE WHEN ? THEN datetime('now') ELSE settled_at END
       WHERE whatsapp_account_id = ? AND message_id = ? AND status IN ('pending', 'awaiting_ai', 'interrupted', 'replaying')`,
    )
    .run(status, detail ? detail.slice(0, 300) : null, opts.recovered ? 1 : 0, closes ? 1 : 0, accountId, messageId);
  return r.changes > 0;
}

export function getPendingReply(messageId: string, db: Database.Database = getDb(), accountId: number = currentAccountId()): PendingReply | undefined {
  return db.prepare('SELECT * FROM pending_replies WHERE whatsapp_account_id = ? AND message_id = ?').get(accountId, messageId) as PendingReply | undefined;
}

/**
 * At start-up: a message still `pending` older than `minAgeSeconds` was cut short by the shutdown → `interrupted` (replayable);
 * a row left `replaying` may have been answered just before the crash → `needs_staff` (never replayed twice). Returns both counts.
 */
export function markInterruptedAtBoot(minAgeSeconds = 120, db: Database.Database = getDb()): { interrupted: number; replayingToStaff: number } {
  const interrupted = db
    .prepare(`UPDATE pending_replies SET status = 'interrupted', last_error = 'cut short by a restart before an outcome was recorded', updated_at = datetime('now') WHERE status = 'pending' AND created_at <= datetime('now', ?)`)
    .run(`-${Math.max(1, Math.floor(minAgeSeconds))} seconds`).changes;
  const replayingToStaff = db
    .prepare(`UPDATE pending_replies SET status = 'needs_staff', last_error = 'a replay was cut short by a restart; not repeated automatically so the customer is never answered twice', updated_at = datetime('now'), settled_at = datetime('now') WHERE status = 'replaying'`)
    .run().changes;
  return { interrupted, replayingToStaff };
}

/** Rows that may be replayed, oldest first. Eligibility beyond the status is decided by the worker. */
export function listReplayCandidates(limit = 50, db: Database.Database = getDb()): PendingReply[] {
  return db.prepare(`SELECT * FROM pending_replies WHERE status IN ('awaiting_ai', 'interrupted') ORDER BY created_at, id LIMIT ?`).all(limit) as PendingReply[];
}

/** Atomically takes a row for a replay (only one worker pass can). Returns the claimed row, or null. */
export function claimForReplay(id: number, db: Database.Database = getDb()): PendingReply | null {
  const r = db
    .prepare(`UPDATE pending_replies SET status = 'replaying', attempts = attempts + 1, last_attempt_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status IN ('awaiting_ai', 'interrupted')`)
    .run(id);
  if (r.changes === 0) return null;
  return db.prepare('SELECT * FROM pending_replies WHERE id = ?').get(id) as PendingReply;
}

/** A replay that produced no answer hands the row back (or closes it when the attempts are used up). */
export function releaseAfterFailedReplay(id: number, detail: string, maxAttempts: number, db: Database.Database = getDb()): PendingStatus {
  const row = db.prepare('SELECT attempts FROM pending_replies WHERE id = ?').get(id) as { attempts: number } | undefined;
  const exhausted = (row?.attempts ?? 0) >= maxAttempts;
  const status: PendingStatus = exhausted ? 'needs_staff' : 'awaiting_ai';
  db.prepare(`UPDATE pending_replies SET status = ?, last_error = ?, updated_at = datetime('now'), settled_at = CASE WHEN ? THEN datetime('now') ELSE settled_at END WHERE id = ? AND status = 'replaying'`)
    .run(status, detail.slice(0, 300), exhausted ? 1 : 0, id);
  return status;
}

export function setPendingStatus(id: number, status: 'abandoned' | 'needs_staff', detail: string, db: Database.Database = getDb()): void {
  db.prepare(`UPDATE pending_replies SET status = ?, last_error = ?, updated_at = datetime('now'), settled_at = datetime('now') WHERE id = ? AND status IN ('pending', 'awaiting_ai', 'interrupted', 'replaying')`)
    .run(status, detail.slice(0, 300), id);
}

export interface PendingCounts { pending: number; awaitingAi: number; interrupted: number; replaying: number; answeredByReplay: number; needsStaff: number }

/** Counts for the dashboard (one account, or all when none is given). */
export function pendingReplyCounts(accountId?: number, db: Database.Database = getDb()): PendingCounts {
  const where = accountId ? 'WHERE whatsapp_account_id = ?' : '';
  const rows = db.prepare(`SELECT status, recovered, COUNT(*) AS n FROM pending_replies ${where} GROUP BY status, recovered`).all(...(accountId ? [accountId] : [])) as Array<{ status: PendingStatus; recovered: number; n: number }>;
  const counts: PendingCounts = { pending: 0, awaitingAi: 0, interrupted: 0, replaying: 0, answeredByReplay: 0, needsStaff: 0 };
  for (const r of rows) {
    if (r.status === 'pending') counts.pending += r.n;
    else if (r.status === 'awaiting_ai') counts.awaitingAi += r.n;
    else if (r.status === 'interrupted') counts.interrupted += r.n;
    else if (r.status === 'replaying') counts.replaying += r.n;
    else if (r.status === 'needs_staff') counts.needsStaff += r.n;
    else if (r.status === 'answered' && r.recovered) counts.answeredByReplay += r.n;
  }
  return counts;
}

export function listOpenPendingReplies(accountId: number | undefined, limit = 50, db: Database.Database = getDb()): PendingReply[] {
  const marks = [...OPEN_STATUSES, 'needs_staff'].map(() => '?').join(',');
  const args: Array<string | number> = [...OPEN_STATUSES, 'needs_staff'];
  let sql = `SELECT * FROM pending_replies WHERE status IN (${marks})`;
  if (accountId) { sql += ' AND whatsapp_account_id = ?'; args.push(accountId); }
  sql += ' ORDER BY created_at DESC, id DESC LIMIT ?';
  args.push(limit);
  return db.prepare(sql).all(...args) as PendingReply[];
}
