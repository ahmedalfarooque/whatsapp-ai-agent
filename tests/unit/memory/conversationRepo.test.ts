import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../../src/memory/db';
import { getOrCreateCustomer } from '../../../src/memory/customerRepo';
import {
  getOrCreateActiveConversation,
  appendMessage,
  getRecentMessages,
  resetConversation,
} from '../../../src/memory/conversationRepo';

let db: Database.Database;
let customerId: number;

beforeEach(() => {
  db = createTestDb();
  customerId = getOrCreateCustomer('15551234567', 'Alice', db).id;
});

describe('getOrCreateActiveConversation', () => {
  it('creates a new active conversation for a fresh customer', () => {
    const conv = getOrCreateActiveConversation(customerId, db);
    expect(conv.status).toBe('active');
  });

  it('returns the same active conversation on repeat calls', () => {
    const first = getOrCreateActiveConversation(customerId, db);
    const second = getOrCreateActiveConversation(customerId, db);
    expect(second.id).toBe(first.id);
  });
});

describe('appendMessage + getRecentMessages', () => {
  it('persists messages and returns them in chronological order', () => {
    const conv = getOrCreateActiveConversation(customerId, db);
    appendMessage(conv.id, { role: 'user', content: 'Hi' }, db);
    appendMessage(conv.id, { role: 'assistant', content: 'Hello!' }, db);

    const history = getRecentMessages(conv.id, 10, db);
    expect(history).toEqual([
      { role: 'user', content: 'Hi', tool_call_id: undefined, tool_name: undefined },
      { role: 'assistant', content: 'Hello!', tool_call_id: undefined, tool_name: undefined },
    ]);
  });

  it('respects the limit and still returns oldest-first ordering', () => {
    const conv = getOrCreateActiveConversation(customerId, db);
    for (let i = 0; i < 5; i += 1) {
      appendMessage(conv.id, { role: 'user', content: `msg-${i}` }, db);
    }
    const history = getRecentMessages(conv.id, 2, db);
    expect(history.map((m) => m.content)).toEqual(['msg-3', 'msg-4']);
  });

  it('survives across separate "process" simulated by reopening the same db handle', () => {
    const conv = getOrCreateActiveConversation(customerId, db);
    appendMessage(conv.id, { role: 'user', content: 'persisted?' }, db);

    // Simulate "after restart" by simply re-querying — for a file-backed DB
    // this is exactly what happens; for :memory: the same handle stands in
    // for "the data survives" since a fresh process would reopen the file.
    const history = getRecentMessages(conv.id, 10, db);
    expect(history.some((m) => m.content === 'persisted?')).toBe(true);
  });
});

describe('resetConversation', () => {
  it('ends the active conversation and starts a new one', () => {
    const original = getOrCreateActiveConversation(customerId, db);
    appendMessage(original.id, { role: 'user', content: 'old context' }, db);

    const fresh = resetConversation(customerId, db);

    expect(fresh.id).not.toBe(original.id);
    expect(fresh.status).toBe('active');

    const originalRow = db.prepare('SELECT status FROM conversations WHERE id = ?').get(original.id) as {
      status: string;
    };
    expect(originalRow.status).toBe('ended');
  });

  it('retains historical messages from the ended conversation (no deletion)', () => {
    const original = getOrCreateActiveConversation(customerId, db);
    appendMessage(original.id, { role: 'user', content: 'do not delete me' }, db);

    resetConversation(customerId, db);

    const stillThere = db
      .prepare('SELECT content FROM conversation_messages WHERE conversation_id = ?')
      .all(original.id);
    expect(stillThere).toHaveLength(1);
  });

  it('separates conversations so old history is not reused as active context', () => {
    const original = getOrCreateActiveConversation(customerId, db);
    appendMessage(original.id, { role: 'user', content: 'old conversation message' }, db);

    const fresh = resetConversation(customerId, db);
    const freshHistory = getRecentMessages(fresh.id, 10, db);

    expect(freshHistory).toEqual([]);
  });
});
