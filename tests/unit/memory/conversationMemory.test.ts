import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../../../src/memory/db';
import { createAccount } from '../../../src/accounts/accountRepo';
import { runWithAccount } from '../../../src/accounts/accountContext';
import { getOrCreateCustomer } from '../../../src/memory/customerRepo';
import { appendMessage, getOrCreateActiveConversation, getRecentMessages } from '../../../src/memory/conversationRepo';
import { historyToChatMessages } from '../../../src/llm/agentLoop';

/**
 * The assistant's memory of a customer: the active conversation of that customer in that business only, the latest N messages, and
 * nothing older than the memory window. Nothing is deleted by the bound.
 */
let conv1: number;
let conv2: number;
let conv1Other: number;

const backdate = (conversationId: number, content: string, hoursAgo: number): void => {
  getDb().prepare("UPDATE conversation_messages SET created_at = datetime('now', ?) WHERE conversation_id = ? AND content = ?").run(`-${hoursAgo} hours`, conversationId, content);
};
const say = (conversationId: number, role: 'user' | 'assistant' | 'tool', content: string, extra: Record<string, unknown> = {}) => appendMessage(conversationId, { role, content, ...extra } as never);

beforeAll(() => {
  getDb();
  expect(createAccount({ name: 'Second Business' }).id).toBe(2);
  const shared = '15558880001'; // the same phone number is a different customer in each business
  conv1 = getOrCreateActiveConversation(getOrCreateCustomer(shared, 'Sam').id).id;
  conv2 = runWithAccount(2, () => getOrCreateActiveConversation(getOrCreateCustomer(shared, 'Sam').id).id);
  conv1Other = getOrCreateActiveConversation(getOrCreateCustomer('15558880002', 'Lee').id).id;
});

describe('size and age bounds', () => {
  it('returns the latest N messages, oldest first', () => {
    for (let i = 1; i <= 8; i += 1) say(conv1, i % 2 ? 'user' : 'assistant', `size-${i}`);
    expect(getRecentMessages(conv1, 3).map((m) => m.content)).toEqual(['size-6', 'size-7', 'size-8']);
  });

  it('leaves out messages older than the memory window but never deletes them', () => {
    say(conv1, 'user', 'age-ancient');
    say(conv1, 'assistant', 'age-yesterday');
    say(conv1, 'user', 'age-now');
    backdate(conv1, 'age-ancient', 24 * 10);
    backdate(conv1, 'age-yesterday', 30);
    const within72 = getRecentMessages(conv1, 50, undefined, 72).map((m) => m.content);
    expect(within72).toContain('age-yesterday');
    expect(within72).toContain('age-now');
    expect(within72).not.toContain('age-ancient');
    expect(getRecentMessages(conv1, 50, undefined, 24).map((m) => m.content)).not.toContain('age-yesterday');
    expect(getRecentMessages(conv1, 50).map((m) => m.content)).toContain('age-ancient'); // the stored conversation is intact
  });
});

describe('isolation', () => {
  it('the same phone number in two businesses has two conversations that never share messages', () => {
    expect(conv1).not.toBe(conv2);
    say(conv1, 'user', 'ONLY-IN-BUSINESS-ONE');
    say(conv2, 'user', 'ONLY-IN-BUSINESS-TWO');
    expect(getRecentMessages(conv2, 50).map((m) => m.content)).toEqual(['ONLY-IN-BUSINESS-TWO']);
    expect(getRecentMessages(conv1, 50).map((m) => m.content)).not.toContain('ONLY-IN-BUSINESS-TWO');
  });

  it('another customer of the same business has their own conversation', () => {
    say(conv1Other, 'user', 'LEE-PRIVATE');
    expect(getRecentMessages(conv1, 50).map((m) => m.content)).not.toContain('LEE-PRIVATE');
    expect(getRecentMessages(conv1Other, 50).map((m) => m.content)).toEqual(['LEE-PRIVATE']);
  });
});

describe('stored history becomes provider-valid turns', () => {
  it('drops tool rows and tool-request markers (the provider rejects a tool message without its tool_calls) and keeps the real conversation', () => {
    say(conv1Other, 'user', 'Do you have a warm neutral colour?');
    say(conv1Other, 'assistant', '[requested tools: search_catalogues]');
    say(conv1Other, 'tool', '{"results":[{"text":"Soft dunes"}]}', { toolCallId: 'call_abc', toolName: 'search_catalogues' });
    say(conv1Other, 'assistant', 'Soft Dunes (12313) is a warm neutral.');
    say(conv1Other, 'user', 'and a darker one?');
    const turns = historyToChatMessages(getRecentMessages(conv1Other, 50));
    expect(turns.map((t) => t.role)).not.toContain('tool');
    expect(turns.some((t) => String(t.content).startsWith('[requested tools'))).toBe(false);
    expect(turns.map((t) => t.content)).toEqual(['LEE-PRIVATE', 'Do you have a warm neutral colour?', 'Soft Dunes (12313) is a warm neutral.', 'and a darker one?']);
    for (const t of turns) expect(Object.keys(t).sort()).toEqual(['content', 'role']); // no stray tool_call_id / name
  });
});
