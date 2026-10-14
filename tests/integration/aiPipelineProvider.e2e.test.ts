import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/whatsapp/client', () => ({
  sendTextMessage: vi.fn().mockResolvedValue({ messages: [{ id: 'wamid.OUT' }] }),
  sendInteractiveMessage: vi.fn().mockResolvedValue({ messages: [{ id: 'wamid.OUT' }] }),
  markMessageAsRead: vi.fn().mockResolvedValue(undefined),
}));

import path from 'node:path';
import { sendTextMessage } from '../../src/whatsapp/client';
import { processInboundMessage, resetCredentialFallbackThrottle } from '../../src/pipeline/processInboundMessage';
import { resetAiRouterForTests } from '../../src/llm/aiRouter';
import { getOrCreateCustomer, setCustomerLanguage } from '../../src/memory/customerRepo';
import { loadKnowledgeBase } from '../../src/knowledge/loader';
import { getDb } from '../../src/memory/db';
import { appendMessage, getOrCreateActiveConversation } from '../../src/memory/conversationRepo';
import { env } from '../../src/config/env';
import { logger } from '../../src/logger';

/**
 * The complete AI pipeline with the REAL provider client (only the network and the WhatsApp transport are stubbed): what the customer
 * receives, what is recorded, how many provider calls are made, and what reaches the logs, for every way a provider can fail.
 */
const mutableEnv = env as unknown as Record<string, unknown>;
const KEY = 'sk-or-v1-pipelinepipelinepipelinepipelinepipeline000000';
const PRIVATE_QUESTION = 'ZZ-PRIVATE-QUESTION-7781 do you open on Fridays?';
const knowledge = loadKnowledgeBase(path.join(__dirname, '..', 'fixtures', 'knowledge'));
const originalMock = mutableEnv.shouldUseMockProviders;
const originalKey = mutableEnv.OPENROUTER_API_KEY;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const answer = (content: string | null, extra: Record<string, unknown> = {}) => json(200, { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content, ...extra } }] });
const toolCall = (name: string, args: Record<string, unknown>) => answer(null, { tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

function provider(...responses: Array<() => Response | Promise<Response>>) {
  let i = 0;
  const fn = vi.fn(async () => responses[Math.min(i++, responses.length - 1)]!());
  vi.stubGlobal('fetch', fn);
  return fn;
}

let counter = 0;
async function customerSays(text = PRIVATE_QUESTION) {
  const waId = `1555333${String(++counter).padStart(4, '0')}`;
  setCustomerLanguage(getOrCreateCustomer(waId, 'Alice').id, 'en');
  vi.mocked(sendTextMessage).mockClear();
  await processInboundMessage({ waId, messageId: `wamid.in${counter}`, timestamp: Date.now(), type: 'text', text, contactName: 'Alice' } as never, { knowledge });
  const activity = getDb().prepare('SELECT kind, detail FROM reply_activity WHERE wa_id = ? ORDER BY id').all(waId) as Array<{ kind: string; detail: string | null }>;
  return { waId, sent: vi.mocked(sendTextMessage).mock.calls.map((c) => String(c[1])), activity };
}

let logged: string[];
beforeEach(() => {
  mutableEnv.shouldUseMockProviders = false;
  mutableEnv.OPENROUTER_API_KEY = KEY;
  resetCredentialFallbackThrottle();
  logged = [];
  for (const level of ['error', 'warn', 'info', 'debug'] as const) {
    vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => { logged.push(JSON.stringify(args, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message } : v))); }) as never);
  }
});
afterEach(() => {
  mutableEnv.shouldUseMockProviders = originalMock;
  mutableEnv.OPENROUTER_API_KEY = originalKey;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('customer experience when the provider misbehaves', () => {
  it('a normal answer is sent once and counted as an AI reply', async () => {
    const fetchMock = provider(() => answer('We open Saturday to Thursday.'));
    const { sent, activity } = await customerSays();
    expect(sent).toEqual(['We open Saturday to Thursday.']);
    expect(activity.at(-1)).toMatchObject({ kind: 'ai' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a rate limit that clears is recovered by the bounded retry: ONE customer message, no duplicates', async () => {
    const fetchMock = provider(() => json(429, { error: { message: 'Provider returned error' } }), () => answer('Here you go.'));
    const { sent, activity } = await customerSays();
    expect(sent).toEqual(['Here you go.']);
    expect(activity.filter((a) => a.kind === 'ai')).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // When the assistant cannot answer, the customer gets the LOCAL automated reply (clearly not an AI answer) and the follow-up choices: two
  // bubbles, never "something went wrong" (see docs/AFTER_HOURS_AND_FOLLOWUPS.md).
  const expectLocalFallback = (sent: string[]) => {
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatch(/Automated reply: our smart assistant cannot answer in detail right now/);
    expect(sent[0]).not.toMatch(/went wrong/i);
    expect(sent[1]).toMatch(/1️⃣ Request a phone callback/);
  };

  it('a permanent rate limit costs at most 2 provider calls (one bounded retry, because it is the only route) and sends the automated choices once', async () => {
    const fetchMock = provider(() => json(429, {}));
    const { sent, activity } = await customerSays();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expectLocalFallback(sent);
    expect(activity.at(-1)).toMatchObject({ kind: 'error', detail: expect.stringMatching(/^AI failed; fallback sent \(rate limited, HTTP 429/) });
    expect(activity.some((a) => a.kind === 'ai')).toBe(false);
  });

  it('HTTP 200 with empty content is retried once, then ONE fallback, never recorded as a success', async () => {
    const fetchMock = provider(() => answer(''));
    const { sent, activity } = await customerSays();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expectLocalFallback(sent);
    expect(activity.at(-1)).toMatchObject({ kind: 'error', detail: expect.stringContaining('empty response') });
    expect(activity.some((a) => a.kind === 'ai')).toBe(false);
  });

  it('a refused model (404 data policy) is not retried and gives ONE fallback with the model named in the activity log only', async () => {
    const fetchMock = provider(() => json(404, { error: { message: '0 endpoints available matching your guardrail restrictions and data policy' } }));
    const { sent, activity } = await customerSays();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expectLocalFallback(sent);
    expect(sent.join('\n')).not.toMatch(/openrouter|openai|model|404|guardrail|policy/i);
    expect(activity.at(-1)!.detail).toMatch(/model unavailable, HTTP 404, model /);
  });

  it('a malformed body and a dropped connection each end in ONE fallback within the bounded calls', async () => {
    const bad = provider(() => new Response('<html>gateway error</html>', { status: 200 }));
    const malformed = await customerSays();
    expect(bad).toHaveBeenCalledTimes(1);
    expectLocalFallback(malformed.sent);
    expect(malformed.activity.at(-1)!.detail).toContain('malformed response');

    const down = provider(() => { throw new TypeError('fetch failed'); });
    const dropped = await customerSays();
    expect(down).toHaveBeenCalledTimes(2); // the only route: one bounded retry, then the local choices
    expectLocalFallback(dropped.sent);
    expect(dropped.activity.at(-1)!.detail).toContain('provider error (no answer from the provider)');
  });

  it('a rejected key (401) is not retried and the apology is not repeated for the same customer within the cooldown', async () => {
    const fetchMock = provider(() => json(401, {}));
    const first = await customerSays();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expectLocalFallback(first.sent);
    expect(first.activity.at(-1)!.detail).toMatch(/^AI credential problem \(rejected\)/);
  });

  it('a model that asks for staff through the tool gets the hand-over exactly once and its own text is not sent', async () => {
    provider(() => toolCall('request_human_handoff', { reason: 'wants a person' }), () => answer('I have asked the team to contact you.'));
    const { sent } = await customerSays('please let me talk to a real person about my order');
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toContain('I have asked the team');
  });

  it('a model that loops on tools is cut at the round cap (4 provider calls) and answered with ONE fallback', async () => {
    const fetchMock = provider(() => toolCall('request_human_handoff_typo', { x: 1 }));
    const { sent, activity } = await customerSays();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expectLocalFallback(sent);
    expect(activity.at(-1)!.detail).toContain('tool rounds exhausted');
  });
});

describe('what reaches the logs', () => {
  it('never the key, the prompt, the customer\'s words or the provider\'s raw body — only category, status and model', async () => {
    provider(() => json(404, { error: { message: 'guardrail restriction on endpoints' } }));
    await customerSays();
    resetAiRouterForTests(); // each failure put the route into a cooldown (by design); the next scenario wants a fresh attempt
    provider(() => answer(''));
    await customerSays();
    resetAiRouterForTests();
    provider(() => json(401, {}));
    await customerSays();
    const everything = logged.join('\n');
    expect(everything).toContain('model_unavailable');
    expect(everything).toContain('empty_response');
    expect(everything).not.toContain(KEY);
    expect(everything).not.toMatch(/sk-or-/);
    expect(everything).not.toContain('ZZ-PRIVATE-QUESTION-7781');
    expect(everything).not.toMatch(/BUSINESS KNOWLEDGE|SCOPE AND HONESTY RULES/); // no prompt text
  });
});

describe('a conversation that already contained a tool round', () => {
  it('still gets an answer: the stored tool rows are not replayed to the provider (they made every later message fail with HTTP 400)', async () => {
    const waId = '15553339999';
    const customer = getOrCreateCustomer(waId, 'Alice');
    setCustomerLanguage(customer.id, 'en');
    const conversation = getOrCreateActiveConversation(customer.id);
    appendMessage(conversation.id, { role: 'user', content: 'Do you have a warm neutral colour?' });
    appendMessage(conversation.id, { role: 'assistant', content: '[requested tools: search_catalogues]' });
    appendMessage(conversation.id, { role: 'tool', content: '{"results":[]}', toolCallId: 'call_abc', toolName: 'search_catalogues' });
    appendMessage(conversation.id, { role: 'assistant', content: 'Soft Dunes (12313) is a warm neutral.' });
    const fetchMock = provider((): Response => answer('A darker one is Cocoa Haze.'));
    vi.mocked(sendTextMessage).mockClear();
    await processInboundMessage({ waId, messageId: 'wamid.history1', timestamp: Date.now(), type: 'text', text: 'and is there a darker one?', contactName: 'Alice' } as never, { knowledge });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as { messages: Array<{ role: string; content: string; tool_call_id?: string }> };
    expect(body.messages.map((m) => m.role)).not.toContain('tool');
    expect(body.messages.some((m) => String(m.content).startsWith('[requested tools'))).toBe(false);
    expect(body.messages.some((m) => m.content === 'Soft Dunes (12313) is a warm neutral.')).toBe(true);
    expect(vi.mocked(sendTextMessage).mock.calls.map((c) => c[1])).toEqual(['A darker one is Cocoa Haze.']);
  });
});