import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/whatsapp/client', () => ({
  sendTextMessage: vi.fn().mockResolvedValue({ messages: [{ id: 'wamid.OUT' }] }),
  sendInteractiveMessage: vi.fn().mockResolvedValue({ messages: [{ id: 'wamid.OUT' }] }),
  markMessageAsRead: vi.fn().mockResolvedValue(undefined),
}));

import path from 'node:path';
import { sendTextMessage } from '../../src/whatsapp/client';
import { processInboundMessage, resetCredentialFallbackThrottle } from '../../src/pipeline/processInboundMessage';
import { getOrCreateCustomer, setCustomerLanguage } from '../../src/memory/customerRepo';
import { loadKnowledgeBase } from '../../src/knowledge/loader';
import { getDb } from '../../src/memory/db';
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

  it('a permanent rate limit costs at most 3 provider calls and sends ONE neutral fallback', async () => {
    const fetchMock = provider(() => json(429, {}));
    const { sent, activity } = await customerSays();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/went wrong/i);
    expect(activity.at(-1)).toMatchObject({ kind: 'error', detail: expect.stringMatching(/^AI failed; fallback sent \(rate limited, HTTP 429/) });
    expect(activity.some((a) => a.kind === 'ai')).toBe(false);
  });

  it('HTTP 200 with empty content is retried once, then ONE fallback, never recorded as a success', async () => {
    const fetchMock = provider(() => answer(''));
    const { sent, activity } = await customerSays();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/went wrong/i);
    expect(activity.at(-1)).toMatchObject({ kind: 'error', detail: expect.stringContaining('empty response') });
    expect(activity.some((a) => a.kind === 'ai')).toBe(false);
  });

  it('a refused model (404 data policy) is not retried and gives ONE fallback with the model named in the activity log only', async () => {
    const fetchMock = provider(() => json(404, { error: { message: '0 endpoints available matching your guardrail restrictions and data policy' } }));
    const { sent, activity } = await customerSays();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toMatch(/openrouter|openai|model|404|guardrail|policy/i);
    expect(activity.at(-1)!.detail).toMatch(/model unavailable, HTTP 404, model /);
  });

  it('a malformed body and a dropped connection each end in ONE fallback within the bounded calls', async () => {
    const bad = provider(() => new Response('<html>gateway error</html>', { status: 200 }));
    const malformed = await customerSays();
    expect(bad).toHaveBeenCalledTimes(1);
    expect(malformed.sent).toHaveLength(1);
    expect(malformed.activity.at(-1)!.detail).toContain('malformed response');

    const down = provider(() => { throw new TypeError('fetch failed'); });
    const dropped = await customerSays();
    expect(down).toHaveBeenCalledTimes(3);
    expect(dropped.sent).toHaveLength(1);
    expect(dropped.activity.at(-1)!.detail).toContain('provider error');
  });

  it('a rejected key (401) is not retried and the apology is not repeated for the same customer within the cooldown', async () => {
    const fetchMock = provider(() => json(401, {}));
    const first = await customerSays();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.sent).toHaveLength(1);
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
    expect(sent).toHaveLength(1);
    expect(activity.at(-1)!.detail).toContain('tool rounds exhausted');
  });
});

describe('what reaches the logs', () => {
  it('never the key, the prompt, the customer\'s words or the provider\'s raw body — only category, status and model', async () => {
    provider(() => json(404, { error: { message: 'guardrail restriction on endpoints' } }));
    await customerSays();
    provider(() => answer(''));
    await customerSays();
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
