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
