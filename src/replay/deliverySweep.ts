import type Database from 'better-sqlite3';
import { getDb } from '../memory/db';
import { logger, maskWaId } from '../logger';
import { runWithAccount } from '../accounts/accountContext';
import { sendTextMessage } from '../whatsapp/client';
import { createStaffNotification } from '../notifications/staffNotifications';
import { REPLAY_MAX_AGE_MS, settlePendingReply, type PendingReply } from './pendingReplyRepo';
import type { ReplayRunner } from './replayWorker';

/**
 * Delivery retry for answers that were GENERATED but not DELIVERED. When the AI produced a good answer and the WhatsApp send then failed (socket reconnecting, timeout),
 * the answer stays stored with metadata.delivery = "send_failed". This sweep sends that SAME stored text again — it never calls the AI again, so a delivery problem
 * cannot become a second, different answer — through the account's live transport (the same runner the replay sweep uses).
 * Safe by construction: only answers younger than REPLAY_MAX_AGE_MS; at most MAX_DELIVERY_ATTEMPTS tries; never when the customer has since received another delivered
 * answer (staff or assistant: the stale one is marked superseded, not sent); a try that fails again sends nothing; after the last try staff are told, once.
 */
export const MAX_DELIVERY_ATTEMPTS = 3;
const BATCH = 20;

interface FailedRow { id: number; content: string; metadata: string | null; conversation_id: number; customer_id: number; wa_id: string; whatsapp_account_id: number; reply_jid: string | null; created_at: string }
export interface DeliverySweepResult { retried: number; delivered: number; superseded: number; gaveUp: number }

const parse = (raw: string | null): Record<string, unknown> => { try { return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}; } catch { return {}; } };

function writeMeta(db: Database.Database, id: number, meta: Record<string, unknown>, whatsappId?: string | null): void {
  if (whatsappId !== undefined) db.prepare('UPDATE conversation_messages SET metadata = ?, whatsapp_message_id = ? WHERE id = ?').run(JSON.stringify(meta), whatsappId, id);
  else db.prepare('UPDATE conversation_messages SET metadata = ? WHERE id = ?').run(JSON.stringify(meta), id);
}

export async function runDeliverySweep(runner: ReplayRunner, now: Date = new Date(), db: Database.Database = getDb()): Promise<DeliverySweepResult> {
  const result: DeliverySweepResult = { retried: 0, delivered: 0, superseded: 0, gaveUp: 0 };
  const rows = db.prepare(
    `SELECT m.id, m.content, m.metadata, m.conversation_id, c.customer_id, u.wa_id, u.whatsapp_account_id, u.reply_jid, m.created_at
       FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id JOIN customers u ON u.id = c.customer_id
      WHERE m.role = 'assistant' AND m.direction = 'outbound' AND m.metadata LIKE '%"delivery":"send_failed"%' AND m.created_at >= datetime('now', '-2 days')
      ORDER BY m.id LIMIT ?`,
  ).all(BATCH) as FailedRow[];
  for (const row of rows) {
    const meta = parse(row.metadata);
    const attempts = Number(meta.deliveryAttempts ?? 0);
    const age = now.getTime() - Date.parse(`${row.created_at.replace(' ', 'T')}Z`);
    const later = db.prepare(`SELECT COUNT(*) AS n FROM conversation_messages WHERE conversation_id = ? AND id > ? AND role = 'assistant' AND direction = 'outbound' AND (whatsapp_message_id IS NOT NULL OR metadata LIKE '%"delivery":"sent%')`).get(row.conversation_id, row.id) as { n: number };
    if (later.n > 0) {
      writeMeta(db, row.id, { ...meta, delivery: 'superseded' });
      result.superseded += 1;
      continue;
    }
    if (attempts >= MAX_DELIVERY_ATTEMPTS || age > REPLAY_MAX_AGE_MS) {
      writeMeta(db, row.id, { ...meta, delivery: 'send_abandoned' });
      result.gaveUp += 1;
      try {
        createStaffNotification({ accountId: row.whatsapp_account_id, kind: 'reply_undelivered', title: 'A reply could not be delivered', body: `The assistant's answer to ${maskWaId(row.wa_id)} was written but WhatsApp would not deliver it after ${attempts} tries. Open the conversation and reply by hand.`, customerId: row.customer_id, ring: false, dedupeKey: `undelivered:${row.id}` }, db);
      } catch (error) { logger.warn({ error: String((error as Error)?.message ?? error).slice(0, 160) }, '[DELIVERY] could not notify staff about an undeliverable reply'); }
      continue;
    }
    const channel = (db.prepare('SELECT channel FROM pending_replies WHERE conversation_id = ? ORDER BY id DESC LIMIT 1').get(row.conversation_id) as { channel: string } | undefined)?.channel ?? 'cloud';
    const pseudo = { id: 0, whatsapp_account_id: row.whatsapp_account_id, customer_id: row.customer_id, conversation_id: row.conversation_id, message_id: `delivery:${row.id}`, wa_id: row.wa_id, channel, status: 'replaying', attempts, recovered: 0, last_error: null, last_attempt_at: null, created_at: row.created_at, updated_at: row.created_at, settled_at: null } as PendingReply;
    result.retried += 1;
    // The attempt is counted BEFORE it is made, so a crash in the middle cannot grant a free extra try.
    writeMeta(db, row.id, { ...meta, deliveryAttempts: attempts + 1 });
    try {
      let id: string | null = null;
      await runner.run(pseudo, row.reply_jid, async () => {
        const sent = await runWithAccount(row.whatsapp_account_id, () => sendTextMessage(row.wa_id, row.content));
        id = sent?.messages?.[0]?.id ?? null;
      });
      const real = id && !/^qr-\d+$/.test(id) ? id : null;
      writeMeta(db, row.id, { ...meta, deliveryAttempts: attempts + 1, delivery: real ? 'sent' : 'sent_unconfirmed', deliveredLate: true }, real);
      const waiting = db.prepare(`SELECT message_id FROM pending_replies WHERE conversation_id = ? AND status IN ('pending', 'replaying') ORDER BY id DESC LIMIT 1`).get(row.conversation_id) as { message_id: string } | undefined;
      if (waiting) settlePendingReply(waiting.message_id, 'answered', 'answer delivered late after a send failure', { recovered: true }, db, row.whatsapp_account_id);
      result.delivered += 1;
    } catch (error) {
      logger.warn({ customer: maskWaId(row.wa_id), account: row.whatsapp_account_id, attempt: attempts + 1, error: String((error as Error)?.message ?? error).slice(0, 160) }, '[DELIVERY] the stored answer could not be delivered; it stays queued');
    }
  }
  if (result.retried || result.superseded || result.gaveUp) logger.info({ ...result }, '[DELIVERY] sweep finished');
  return result;
}
