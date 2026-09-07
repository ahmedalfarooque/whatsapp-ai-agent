import type Database from 'better-sqlite3';
import { getDb } from './db';

/**
 * Attempts to claim a webhook message id for processing.
 * Returns true if this call successfully claimed it (i.e. it's new),
 * false if it has already been seen (duplicate delivery — skip processing).
 */
export function claimWebhookEvent(
  messageId: string,
  payloadSummary: string | undefined,
  db: Database.Database = getDb(),
): boolean {
  const result = db
    .prepare('INSERT OR IGNORE INTO webhook_events (message_id, payload_summary) VALUES (?, ?)')
    .run(messageId, payloadSummary ?? null);
  return result.changes === 1;
}

export function markWebhookEventProcessed(
  messageId: string,
  db: Database.Database = getDb(),
): void {
  db.prepare(
    "UPDATE webhook_events SET processed_at = datetime('now') WHERE message_id = ?",
  ).run(messageId);
}

export function markWebhookEventFailed(
  messageId: string,
  error: string,
  db: Database.Database = getDb(),
): void {
  db.prepare('UPDATE webhook_events SET error = ? WHERE message_id = ?').run(error, messageId);
}

export function hasWebhookEventBeenProcessed(
  messageId: string,
  db: Database.Database = getDb(),
): boolean {
  const row = db
    .prepare('SELECT processed_at FROM webhook_events WHERE message_id = ?')
    .get(messageId) as { processed_at: string | null } | undefined;
  return Boolean(row?.processed_at);
}
