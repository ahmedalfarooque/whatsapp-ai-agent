import type Database from 'better-sqlite3';
import { getDb } from '../memory/db';
import { currentAccountId } from '../accounts/accountContext';
import { logger, maskWaId } from '../logger';
import { MESSAGE_DIRECTION } from '../config/constants';
import { appendMessage, getOrCreateActiveConversation } from '../memory/conversationRepo';
import { recordReplyActivity } from '../automation/settingsRepo';
import { NotConnectedError } from '../notifications/outbox';
import { HandoffError, type HandoffActor } from './handoffRepo';
import type { StaffSender } from '../whatsapp/staffSend';

/**
 * A reply typed by the staff member who owns a handoff, sent to the customer through the existing WhatsApp connection of that account.
 *
 *  - Only HUMAN_ACTIVE handoffs, only by the assigned staff member (or someone with manage rights), only inside their own account.
 *  - Idempotent: every send carries a client-chosen id; the same id twice (double click, retry, page refresh) is ONE message.
 *  - Honest: the message is stored in the conversation and reported "sent" only after the transport accepted it. A failure is recorded
 *    as failed and can be retried with the same id; an attempt whose outcome is unknown (still "pending") is never sent a second time.
 */

export const MAX_STAFF_MESSAGE_CHARS = 4000;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export class StaffReplyError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: 'invalid' | 'not_connected' | 'send_failed' | 'in_progress',
  ) {
    super(message);
    this.name = 'StaffReplyError';
  }
}

export interface StaffReplyResult {
  messageId: number;
  status: 'sent';
  duplicate: boolean;
  providerMessageId: string | null;
}

interface HandoffRow {
  id: number;
  whatsapp_account_id: number;
  customer_id: number;
  state: string;
  assigned_admin_id: number | null;
}
interface MessageRow {
  id: number;
  status: 'pending' | 'sent' | 'failed';
  provider_message_id: string | null;
}

export async function sendStaffReply(
  input: { handoffId: number; text: unknown; clientMessageId: unknown },
  actor: Extract<HandoffActor, { type: 'staff' }>,
  send: StaffSender,
  accountId: number = currentAccountId(),
  db: Database.Database = getDb(),
): Promise<StaffReplyResult> {
  if (typeof input.text !== 'string' || !input.text.trim()) throw new StaffReplyError('Write a message first', 400, 'invalid');
  const text = input.text.replace(/\r\n/g, '\n').trim();
  if (text.length > MAX_STAFF_MESSAGE_CHARS) throw new StaffReplyError(`The message is too long (${MAX_STAFF_MESSAGE_CHARS} characters maximum)`, 400, 'invalid');
  if (typeof input.clientMessageId !== 'string' || !CLIENT_ID_RE.test(input.clientMessageId)) throw new StaffReplyError('A message id (8–64 letters, digits, - or _) is required', 400, 'invalid');
  const clientMessageId = input.clientMessageId;

  const handoff = db.prepare('SELECT id, whatsapp_account_id, customer_id, state, assigned_admin_id FROM human_handoffs WHERE id = ? AND whatsapp_account_id = ?').get(input.handoffId, accountId) as HandoffRow | undefined;
  if (!handoff) throw new HandoffError('Handoff not found', 404, 'not_found');
  if (handoff.state !== 'HUMAN_ACTIVE') {
    throw new HandoffError(handoff.state === 'HUMAN_REQUESTED' ? 'Accept the conversation before replying' : 'This handoff is no longer being handled by staff', 409, 'invalid_state');
  }
  if (handoff.assigned_admin_id !== actor.adminId && !actor.canManage) throw new HandoffError('This conversation is being handled by another staff member', 403, 'owned_by_other');

  // Claim this client id. Exactly one caller proceeds to send.
  const claim = db.transaction((): { row: MessageRow; proceed: boolean } => {
    const existing = db.prepare('SELECT id, status, provider_message_id FROM human_handoff_messages WHERE handoff_id = ? AND client_message_id = ?').get(handoff.id, clientMessageId) as MessageRow | undefined;
    if (!existing) {
      const res = db
        .prepare(`INSERT INTO human_handoff_messages (handoff_id, whatsapp_account_id, client_message_id, staff_admin_id, body) VALUES (?, ?, ?, ?, ?)`)
        .run(handoff.id, accountId, clientMessageId, actor.adminId, text);
      return { row: { id: Number(res.lastInsertRowid), status: 'pending', provider_message_id: null }, proceed: true };
    }
    if (existing.status === 'failed') {
      // A known failure may be retried with the same id (nothing reached the customer).
      db.prepare(`UPDATE human_handoff_messages SET status = 'pending', error = NULL, body = ?, updated_at = datetime('now') WHERE id = ? AND status = 'failed'`).run(text, existing.id);
      return { row: { ...existing, status: 'pending' }, proceed: true };
    }
    return { row: existing, proceed: false };
  });
  const { row, proceed } = claim();
  if (!proceed) {
    if (row.status === 'sent') return { messageId: row.id, status: 'sent', duplicate: true, providerMessageId: row.provider_message_id };
    throw new StaffReplyError('This message is already being sent', 409, 'in_progress');
  }

  const customer = db.prepare('SELECT id, wa_id, reply_jid, display_name FROM customers WHERE id = ? AND whatsapp_account_id = ?').get(handoff.customer_id, accountId) as
    | { id: number; wa_id: string; reply_jid: string | null; display_name: string | null }
    | undefined;
  if (!customer) {
    db.prepare(`UPDATE human_handoff_messages SET status = 'failed', error = 'customer not found', updated_at = datetime('now') WHERE id = ?`).run(row.id);
    throw new HandoffError('Customer not found', 404, 'not_found');
  }

  let providerId: string | null;
  try {
    providerId = await send(accountId, { wa_id: customer.wa_id, reply_jid: customer.reply_jid }, text);
  } catch (error) {
    const notConnected = error instanceof NotConnectedError;
    db.prepare(`UPDATE human_handoff_messages SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?`).run(notConnected ? 'whatsapp not connected' : `${(error as Error)?.name ?? 'Error'}`.slice(0, 120), row.id);
    logger.warn({ account: accountId, handoffId: handoff.id, customer: maskWaId(customer.wa_id), errorName: (error as Error)?.name }, 'staff reply could not be sent');
    recordReplyActivity({ customerId: customer.id, waId: customer.wa_id, channel: 'staff', kind: 'error', detail: 'Staff reply could not be sent', accountId });
    throw notConnected
      ? new StaffReplyError('This WhatsApp number is not connected right now, so the message was not sent. Reconnect it and try again.', 503, 'not_connected')
      : new StaffReplyError('The message could not be sent. Nothing was delivered; you can try again.', 502, 'send_failed');
  }

  // The transport accepted it: now (and only now) it is a sent message — recorded for everyone who reads the conversation.
  db.transaction(() => {
    db.prepare(`UPDATE human_handoff_messages SET status = 'sent', provider_message_id = ?, updated_at = datetime('now') WHERE id = ?`).run(providerId, row.id);
    const conversation = getOrCreateActiveConversation(customer.id, db);
    appendMessage(conversation.id, { role: 'assistant', content: text, direction: MESSAGE_DIRECTION.OUTBOUND, messageType: 'text', metadata: { staff: true, staffAdminId: actor.adminId, handoffId: handoff.id } }, db);
  })();
  recordReplyActivity({ customerId: customer.id, waId: customer.wa_id, channel: 'staff', kind: 'human_handoff', detail: 'Staff reply sent', accountId });
  return { messageId: row.id, status: 'sent', duplicate: false, providerMessageId: providerId };
}
