import type Database from 'better-sqlite3';
import { getDb } from './db';
import { CONVERSATION_STATUS } from '../config/constants';
import { currentAccountId } from '../accounts/accountContext';

export interface Conversation {
  id: number;
  customer_id: number;
  whatsapp_account_id: number;
  status: 'active' | 'ended';
  started_at: string;
  ended_at: string | null;
}

export interface ConversationMessage {
  id: number;
  conversation_id: number;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  tool_call_id: string | null;
  tool_name: string | null;
  whatsapp_message_id: string | null;
  direction: 'inbound' | 'outbound' | null;
  message_type: string | null;
  metadata: string | null;
  created_at: string;
}

export interface ChatMessageForLlm {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  tool_call_id?: string;
  tool_name?: string;
}

export function getOrCreateActiveConversation(
  customerId: number,
  db: Database.Database = getDb(),
): Conversation {
  const existing = db
    .prepare(
      "SELECT * FROM conversations WHERE customer_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1",
    )
    .get(customerId) as Conversation | undefined;

  if (existing) return existing;

  const result = db
    .prepare('INSERT INTO conversations (customer_id, status, whatsapp_account_id) VALUES (?, ?, ?)')
    .run(customerId, CONVERSATION_STATUS.ACTIVE, customerAccountId(customerId, db));

  return db
    .prepare('SELECT * FROM conversations WHERE id = ?')
    .get(result.lastInsertRowid) as Conversation;
}

/** A conversation belongs to the same business as its customer. */
function customerAccountId(customerId: number, db: Database.Database): number {
  const row = db.prepare('SELECT whatsapp_account_id FROM customers WHERE id = ?').get(customerId) as { whatsapp_account_id: number } | undefined;
  return row?.whatsapp_account_id ?? currentAccountId();
}

export interface AppendMessageInput {
  role: ConversationMessage['role'];
  content: string;
  toolCallId?: string;
  toolName?: string;
  whatsappMessageId?: string;
  direction?: 'inbound' | 'outbound';
  messageType?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Delivery evidence for the reply that was just stored: the reply is recorded BEFORE it is sent (so a crash never loses it), which means a stored
 * assistant row alone proves nothing about delivery. After the send, the row gets the id WhatsApp returned (`whatsapp_message_id`) and
 * `metadata.delivery = "sent"`, `"sent_unconfirmed"` (no real id came back) or `"send_failed"` when the send threw — so a failed send is distinguishable from a failed generation, and
 * "delivered" is only ever claimed with an id. Matches the newest outbound assistant row with this text that has no WhatsApp id yet.
 */
export function recordOutboundDelivery(conversationId: number, content: string, outcome: { sent: boolean; id?: string | null }, db: Database.Database = getDb()): void {
  const row = db.prepare(`SELECT id, metadata FROM conversation_messages WHERE conversation_id = ? AND role = 'assistant' AND direction = 'outbound' AND content = ? AND whatsapp_message_id IS NULL ORDER BY id DESC LIMIT 1`).get(conversationId, content) as { id: number; metadata: string | null } | undefined;
  if (!row) return;
  let meta: Record<string, unknown> = {};
  try { meta = row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : {}; } catch { meta = {}; }
  // A real id (the one WhatsApp's session returned) is the only delivery evidence; a locally made placeholder id (qr-<time>) or none at all is sent_unconfirmed.
  const real = outcome.sent && outcome.id && !/^qr-\d+$/.test(outcome.id) ? outcome.id : null;
  meta.delivery = !outcome.sent ? 'send_failed' : real ? 'sent' : 'sent_unconfirmed';
  db.prepare('UPDATE conversation_messages SET whatsapp_message_id = ?, metadata = ? WHERE id = ?').run(real, JSON.stringify(meta), row.id);
}

export function appendMessage(
  conversationId: number,
  input: AppendMessageInput,
  db: Database.Database = getDb(),
): ConversationMessage {
  const result = db
    .prepare(
      `INSERT INTO conversation_messages
        (conversation_id, role, content, tool_call_id, tool_name, whatsapp_message_id, direction, message_type, metadata)
       VALUES (@conversation_id, @role, @content, @tool_call_id, @tool_name, @whatsapp_message_id, @direction, @message_type, @metadata)`,
    )
    .run({
      conversation_id: conversationId,
      role: input.role,
      content: input.content,
      tool_call_id: input.toolCallId ?? null,
      tool_name: input.toolName ?? null,
      whatsapp_message_id: input.whatsappMessageId ?? null,
      direction: input.direction ?? null,
      message_type: input.messageType ?? null,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
    });

  return db
    .prepare('SELECT * FROM conversation_messages WHERE id = ?')
    .get(result.lastInsertRowid) as ConversationMessage;
}

/**
 * The latest messages of a conversation, oldest first. limit bounds the size; sinceHours (optional) bounds the age, so an old
 * exchange is not replayed to the model as if it had just happened. Nothing is deleted: only what is returned is limited.
 */
export function getRecentMessages(
  conversationId: number,
  limit: number,
  db: Database.Database = getDb(),
  sinceHours?: number,
): ChatMessageForLlm[] {
  const recent = sinceHours !== undefined;
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT * FROM conversation_messages
         WHERE conversation_id = ?${recent ? " AND created_at >= datetime('now', ?)" : ''}
         ORDER BY id DESC
         LIMIT ?
       ) sub
       ORDER BY sub.id ASC`,
    )
    .all(...(recent ? [conversationId, `-${Math.max(1, Math.floor(sinceHours))} hours`, limit] : [conversationId, limit])) as ConversationMessage[];

  return rows.map((row) => ({
    role: row.role,
    content: row.content,
    tool_call_id: row.tool_call_id ?? undefined,
    tool_name: row.tool_name ?? undefined,
  }));
}

export interface ConversationListItem {
  id: number;
  status: 'active' | 'ended';
  started_at: string;
  ended_at: string | null;
  customerId: number;
  customerLabel: string;
  waId: string;
  messageCount: number;
  lastMessageAt: string | null;
}

const MAX_PAGE_SIZE = 100;

export function listConversations(
  params: { status?: 'active' | 'ended'; limit?: number; offset?: number; accountId?: number } = {},
  db: Database.Database = getDb(),
): { items: ConversationListItem[]; total: number } {
  const limit = Math.max(1, Math.min(params.limit ?? 25, MAX_PAGE_SIZE));
  const offset = Math.max(0, params.offset ?? 0);
  const whereClause = `WHERE c.whatsapp_account_id = @accountId${params.status ? ' AND c.status = @status' : ''}`;
  const args = { accountId: params.accountId ?? currentAccountId(), status: params.status };

  const total = (
    db.prepare(`SELECT COUNT(*) AS count FROM conversations c ${whereClause}`).get(args) as {
      count: number;
    }
  ).count;

  const items = db
    .prepare(
      `SELECT c.id, c.status, c.started_at, c.ended_at, cu.id AS customerId,
              cu.display_name AS customerLabel, cu.wa_id AS waId,
              (SELECT COUNT(*) FROM conversation_messages m WHERE m.conversation_id = c.id) AS messageCount,
              (SELECT MAX(m2.created_at) FROM conversation_messages m2 WHERE m2.conversation_id = c.id) AS lastMessageAt
       FROM conversations c
       JOIN customers cu ON cu.id = c.customer_id
       ${whereClause}
       ORDER BY COALESCE(lastMessageAt, c.started_at) DESC
       LIMIT @limit OFFSET @offset`,
    )
    .all({ ...args, limit, offset }) as ConversationListItem[];

  return { items, total };
}

/** Scoped to the account: a conversation id from another business is "not found". */
export function getConversationById(
  id: number,
  db: Database.Database = getDb(),
  accountId: number = currentAccountId(),
): ConversationListItem | undefined {
  return db
    .prepare(
      `SELECT c.id, c.status, c.started_at, c.ended_at, cu.id AS customerId,
              cu.display_name AS customerLabel, cu.wa_id AS waId,
              (SELECT COUNT(*) FROM conversation_messages m WHERE m.conversation_id = c.id) AS messageCount,
              (SELECT MAX(m2.created_at) FROM conversation_messages m2 WHERE m2.conversation_id = c.id) AS lastMessageAt
       FROM conversations c
       JOIN customers cu ON cu.id = c.customer_id
       WHERE c.id = ? AND c.whatsapp_account_id = ?`,
    )
    .get(id, accountId) as ConversationListItem | undefined;
}

/** Full chronological message history for a conversation, for admin display (not the LLM-shaped subset). */
export function getConversationMessages(
  conversationId: number,
  db: Database.Database = getDb(),
): ConversationMessage[] {
  return db
    .prepare('SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY id ASC')
    .all(conversationId) as ConversationMessage[];
}

/** Ends the current active conversation (if any) and returns the new active one. */
export function resetConversation(
  customerId: number,
  db: Database.Database = getDb(),
): Conversation {
  db.prepare(
    "UPDATE conversations SET status = 'ended', ended_at = datetime('now') WHERE customer_id = ? AND status = 'active'",
  ).run(customerId);

  const result = db
    .prepare('INSERT INTO conversations (customer_id, status, whatsapp_account_id) VALUES (?, ?, ?)')
    .run(customerId, CONVERSATION_STATUS.ACTIVE, customerAccountId(customerId, db));

  return db
    .prepare('SELECT * FROM conversations WHERE id = ?')
    .get(result.lastInsertRowid) as Conversation;
}
