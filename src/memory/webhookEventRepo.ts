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

/**
 * Boot-time recovery: an event claimed before a crash or restart but never marked processed or failed would otherwise look "handled"
 * forever (the duplicate guard refuses it) while the customer never got an answer. Such rows are marked failed with an explicit reason so
 * they show up as errors instead of silence. The message content itself cannot be replayed (WhatsApp delivers it once), so this records
 * the definitive outcome; it never re-sends anything. Only rows older than `minAgeSeconds` count, so in-flight work is never touched.
 */
export function recoverInterruptedEvents(minAgeSeconds = 120, db: Database.Database = getDb()): string[] {
  const rows = db
    .prepare("SELECT message_id FROM webhook_events WHERE processed_at IS NULL AND error IS NULL AND received_at <= datetime('now', ?)")
    .all(`-${Math.max(1, Math.floor(minAgeSeconds))} seconds`) as Array<{ message_id: string }>;
  if (rows.length === 0) return [];
  const mark = db.prepare("UPDATE webhook_events SET error = 'interrupted by a restart before an outcome was recorded' WHERE message_id = ? AND processed_at IS NULL AND error IS NULL");
  const run = db.transaction(() => { for (const r of rows) mark.run(r.message_id); });
  run();
  return rows.map((r) => r.message_id);
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
