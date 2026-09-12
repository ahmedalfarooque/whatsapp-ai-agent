import type Database from 'better-sqlite3';
import { getDb } from './db';
import { CONVERSATION_STATUS } from '../config/constants';

export interface Conversation {
  id: number;
  customer_id: number;
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
    .prepare('INSERT INTO conversations (customer_id, status) VALUES (?, ?)')
    .run(customerId, CONVERSATION_STATUS.ACTIVE);

  return db
    .prepare('SELECT * FROM conversations WHERE id = ?')
    .get(result.lastInsertRowid) as Conversation;
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

export function getRecentMessages(
  conversationId: number,
  limit: number,
  db: Database.Database = getDb(),
): ChatMessageForLlm[] {
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT * FROM conversation_messages
         WHERE conversation_id = ?
         ORDER BY id DESC
         LIMIT ?
       ) sub
       ORDER BY sub.id ASC`,
    )
    .all(conversationId, limit) as ConversationMessage[];

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
  params: { status?: 'active' | 'ended'; limit?: number; offset?: number } = {},
  db: Database.Database = getDb(),
): { items: ConversationListItem[]; total: number } {
  const limit = Math.max(1, Math.min(params.limit ?? 25, MAX_PAGE_SIZE));
  const offset = Math.max(0, params.offset ?? 0);
  const whereClause = params.status ? 'WHERE c.status = @status' : '';
  const args = params.status ? { status: params.status } : {};

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

export function getConversationById(
  id: number,
  db: Database.Database = getDb(),
): ConversationListItem | undefined {
  return db
    .prepare(
      `SELECT c.id, c.status, c.started_at, c.ended_at, cu.id AS customerId,
              cu.display_name AS customerLabel, cu.wa_id AS waId,
              (SELECT COUNT(*) FROM conversation_messages m WHERE m.conversation_id = c.id) AS messageCount,
              (SELECT MAX(m2.created_at) FROM conversation_messages m2 WHERE m2.conversation_id = c.id) AS lastMessageAt
       FROM conversations c
       JOIN customers cu ON cu.id = c.customer_id
       WHERE c.id = ?`,
    )
    .get(id) as ConversationListItem | undefined;
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
    .prepare('INSERT INTO conversations (customer_id, status) VALUES (?, ?)')
    .run(customerId, CONVERSATION_STATUS.ACTIVE);

  return db
    .prepare('SELECT * FROM conversations WHERE id = ?')
    .get(result.lastInsertRowid) as Conversation;
}
