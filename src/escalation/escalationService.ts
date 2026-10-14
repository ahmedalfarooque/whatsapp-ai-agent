import type Database from 'better-sqlite3';
import { getDb } from '../memory/db';
import { logger, maskWaId } from '../logger';
import { runWithAccount } from '../accounts/accountContext';
import { getBusinessSettings } from '../config/businessSettings';
import { isOpenAt } from '../setup/hours';
import { createStaffNotification } from '../notifications/staffNotifications';
import { enqueueNotification } from '../notifications/outbox';
import { businessNotificationJid, kickOutbox } from '../requests/requestService';
import { REPLAY_MAX_AGE_MS } from '../replay/pendingReplyRepo';
import { attemptVoiceCall } from './voiceCall';

/**
 * The five-minute escalation. A request that nobody has resolved five minutes after it became actionable, while the business is OPEN, is
 * escalated ONCE (table escalations, unique per request): a staff notification that rings, a WhatsApp alert to the staff number, and a
 * voice-call attempt that today records "unavailable" with the exact reason (src/escalation/voiceCall.ts) — no call is ever placed.
 * Two kinds of request escalate:
 *   - a customer message the assistant could not answer (pending_replies awaiting an AI answer, interrupted, or left for staff);
 *   - an "as soon as possible" callback request that is open (status eligible) and still unassigned.
 * Outside business hours nothing escalates (the request waits for the opening, when the follow-up flow alerts staff by itself).
 */
export const ESCALATION_AFTER_MS = 5 * 60_000;

export interface Escalation {
  id: number;
  whatsapp_account_id: number;
  customer_id: number | null;
  ref_kind: 'pending_reply' | 'followup';
  ref_id: number;
  reason: string;
  status: 'open' | 'resolved';
  staff_notification_id: number | null;
  voice_call_status: 'not_attempted' | 'unavailable' | 'skipped' | 'placed' | 'failed';
  voice_call_detail: string | null;
  voice_call_at: string | null;
  created_at: string;
  resolved_at: string | null;
}

const sqlTime = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

function escalate(
  accountId: number, customerId: number | null, refKind: Escalation['ref_kind'], refId: number, reason: string, customerLabel: string, db: Database.Database,
): boolean {
  const inserted = db.prepare(`INSERT OR IGNORE INTO escalations (whatsapp_account_id, customer_id, ref_kind, ref_id, reason) VALUES (?, ?, ?, ?, ?)`).run(accountId, customerId, refKind, refId, reason).changes;
  if (!inserted) return false; // already escalated: no second alert, no second call
  const row = db.prepare('SELECT id FROM escalations WHERE ref_kind = ? AND ref_id = ?').get(refKind, refId) as { id: number };
  const title = 'Customer waiting for 5 minutes';
  const body = `${customerLabel}: ${reason} Open the conversation and answer, or call from the dashboard. (Automatic voice calls are not available: see Providers → AI routing.)`;
  const note = createStaffNotification({ accountId, kind: 'escalation', title, body, customerId, ring: true, dedupeKey: `escalation:${refKind}:${refId}` }, db);
  const jid = businessNotificationJid(db, accountId);
  if (jid) {
    enqueueNotification({ kind: 'staff_followup', targetJid: jid, body: `🔔 ${title}\n\n${body}`, dedupeKey: `outbox:escalation:${refKind}:${refId}`, accountId }, db);
    kickOutbox();
  }
  const call = attemptVoiceCall({ hasValidNumber: false, hasConsent: false });
  db.prepare(`UPDATE escalations SET staff_notification_id = ?, voice_call_status = ?, voice_call_detail = ?, voice_call_at = datetime('now') WHERE id = ?`).run(note.row.id, call.status, call.detail.slice(0, 300), row.id);
  logger.info({ account: accountId, refKind, refId, voiceCall: call.status }, '[ESCALATION] request unresolved for 5 minutes while open: staff alerted');
  return true;
}

/** One pass (called every minute and by tests). Returns how many requests were newly escalated and how many escalations closed. */
export function runEscalationSweep(now: Date = new Date(), db: Database.Database = getDb()): { escalated: number; resolved: number } {
  let escalated = 0;
  const olderThan = sqlTime(now.getTime() - ESCALATION_AFTER_MS);
  const notOlderThan = sqlTime(now.getTime() - REPLAY_MAX_AGE_MS);

  const waiting = db.prepare(
    `SELECT p.id, p.whatsapp_account_id AS accountId, p.customer_id AS customerId, p.wa_id AS waId FROM pending_replies p
     WHERE p.status IN ('awaiting_ai', 'interrupted', 'needs_staff') AND p.created_at <= ? AND p.created_at >= ?
       AND NOT EXISTS (SELECT 1 FROM escalations e WHERE e.ref_kind = 'pending_reply' AND e.ref_id = p.id)`,
  ).all(olderThan, notOlderThan) as Array<{ id: number; accountId: number; customerId: number; waId: string }>;
  for (const w of waiting) {
    runWithAccount(w.accountId, () => {
      const settings = getBusinessSettings(w.accountId);
      if (!settings.hoursConfigured || isOpenAt(settings, now) !== true) return;
      if (escalate(w.accountId, w.customerId, 'pending_reply', w.id, 'a customer message has had no answer for 5 minutes while the business is open (the assistant could not answer).', maskWaId(w.waId), db)) escalated += 1;
    });
  }

  const callbacks = db.prepare(
    `SELECT f.id, f.whatsapp_account_id AS accountId, f.customer_id AS customerId, f.reference FROM followup_requests f
     WHERE f.status = 'eligible' AND f.asap = 1 AND f.assigned_admin_id IS NULL AND datetime(COALESCE(f.eligible_at, f.created_at)) <= datetime(?)
       AND NOT EXISTS (SELECT 1 FROM escalations e WHERE e.ref_kind = 'followup' AND e.ref_id = f.id)`,
  ).all(new Date(now.getTime() - ESCALATION_AFTER_MS).toISOString()) as Array<{ id: number; accountId: number; customerId: number; reference: string }>;
  for (const c of callbacks) {
    runWithAccount(c.accountId, () => {
      const settings = getBusinessSettings(c.accountId);
      if (!settings.hoursConfigured || isOpenAt(settings, now) !== true) return;
      if (escalate(c.accountId, c.customerId, 'followup', c.id, `callback request ${c.reference} has been open and unassigned for 5 minutes while the business is open.`, `Request ${c.reference}`, db)) escalated += 1;
    });
  }

  // an escalation closes when its request is settled
  const resolved = db.prepare(
    `UPDATE escalations SET status = 'resolved', resolved_at = datetime('now') WHERE status = 'open' AND (
       (ref_kind = 'pending_reply' AND ref_id IN (SELECT id FROM pending_replies WHERE status IN ('answered', 'abandoned')))
       OR (ref_kind = 'followup' AND ref_id IN (SELECT id FROM followup_requests WHERE status IN ('assigned', 'completed', 'cancelled'))))`,
  ).run().changes;
  return { escalated, resolved };
}

export function listEscalations(accountId: number | undefined, limit = 30, db: Database.Database = getDb()): Escalation[] {
  return (accountId
    ? db.prepare('SELECT * FROM escalations WHERE whatsapp_account_id = ? ORDER BY id DESC LIMIT ?').all(accountId, limit)
    : db.prepare('SELECT * FROM escalations ORDER BY id DESC LIMIT ?').all(limit)) as Escalation[];
}
