import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/whatsapp/client', () => ({
  sendTextMessage: vi.fn().mockResolvedValue({ messages: [{ id: 'wamid.OUT' }] }),
  sendInteractiveMessage: vi.fn().mockResolvedValue({ messages: [{ id: 'wamid.OUT' }] }),
  markMessageAsRead: vi.fn().mockResolvedValue(undefined),
}));

import path from 'node:path';
import { sendTextMessage } from '../../src/whatsapp/client';
import { processInboundMessage, resetCredentialFallbackThrottle } from '../../src/pipeline/processInboundMessage';
import { allowUnknownPriceForTests, buildCandidates, resetAiRouterForTests } from '../../src/llm/aiRouter';
import { getOrCreateCustomer, setCustomerLanguage } from '../../src/memory/customerRepo';
import { loadKnowledgeBase } from '../../src/knowledge/loader';
import { getDb } from '../../src/memory/db';
import { env } from '../../src/config/env';
import { createProvider } from '../../src/llm/providerRepo';
import { setModelCatalogForTests } from '../../src/llm/modelCatalog';
import { runWithAccount } from '../../src/accounts/accountContext';
import { THINKING_HEADROOM_TOKENS } from '../../src/llm/adapters/geminiAdapter';

/**
 * The production failover this release is about: OpenRouter's free pool answers HTTP 429 → the SAME customer message is answered by Gemini
 * (native generateContent), once. Provider calls are scripted (mocked): these tests prove the routing, not Google's or OpenRouter's availability.
 */
const mutableEnv = env as unknown as Record<string, unknown>;
const OR_KEY = 'sk-or-v1-failoverfailoverfailoverfailoverfailover0000000';
const G_KEY = 'AQ.Ab8RN6Failover-GeminiKeyShapeFailoverFailover0000000';
const knowledge = loadKnowledgeBase(path.join(__dirname, '..', 'fixtures', 'knowledge'));
const originalMock = mutableEnv.shouldUseMockProviders;
const originalKey = mutableEnv.OPENROUTER_API_KEY;
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const orOk = (text: string) => json(200, { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }] });
const gemOk = (text: string) => json(200, { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] });
const or429 = () => json(429, { error: { message: 'Rate limit exceeded: free-models-per-day' } });
const gem429 = () => json(429, { error: { status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota' } });

let calls: string[];
function network(handler: (host: string, body: Record<string, unknown>) => Response) {
  calls = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const host = new URL(String(url)).host;
    calls.push(host + (String(url).includes(':generateContent') ? ':gen' : ''));
    return handler(host, init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {});
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

let counter = 0;
async function customerSays() {
  const waId = `1555777${String(++counter).padStart(4, '0')}`;
  setCustomerLanguage(getOrCreateCustomer(waId, 'Sam').id, 'en');
  vi.mocked(sendTextMessage).mockClear();
  vi.mocked(sendTextMessage).mockResolvedValue({ messages: [{ id: 'wamid.OUT' }] } as never);
  await processInboundMessage({ waId, messageId: `wamid.fo${counter}`, timestamp: Date.now(), type: 'text', text: 'Do you open on Fridays?', contactName: 'Sam' } as never, { knowledge });
  return { waId, sent: vi.mocked(sendTextMessage).mock.calls.map((c) => String(c[1])) };
}

beforeEach(() => {
  mutableEnv.shouldUseMockProviders = false;
  mutableEnv.OPENROUTER_API_KEY = '';
  resetCredentialFallbackThrottle();
  getDb().prepare('DELETE FROM ai_providers').run();
  getDb().prepare('DELETE FROM ai_route_log').run();
  createProvider({ name: 'OpenRouter', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: OR_KEY, models: ['openrouter/free'], priority: 10, timeoutMs: 3000 }, { accountId: null, updatedBy: 1 });
  createProvider({ name: 'Gemini', kind: 'openai_compatible', adapter: 'gemini', vendor: 'google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: G_KEY, models: ['gemini-3.8-flash'], priority: 100, timeoutMs: 3000 }, { accountId: null, updatedBy: 1 });
  setModelCatalogForTests([{ id: 'openrouter/free', free: true, image: false, audio: false, tools: true, contextLength: 100000 }]);
  allowUnknownPriceForTests(false); // the production rule
  resetAiRouterForTests();
});
afterEach(() => {
  mutableEnv.shouldUseMockProviders = originalMock;
  mutableEnv.OPENROUTER_API_KEY = originalKey;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('OpenRouter free quota reached → Gemini answers the customer', () => {
  it('OpenRouter 429 → ONE Gemini answer → ONE WhatsApp reply with the sent id recorded; the OpenRouter route then rests and is not called again', async () => {
    network((host) => (host === 'openrouter.ai' ? or429() : gemOk('We open Saturday to Thursday.')));
    const first = await customerSays();
    expect(first.sent).toEqual(['We open Saturday to Thursday.']);
    expect(calls.filter((c) => c === 'openrouter.ai').length).toBeGreaterThanOrEqual(1);
    expect(calls.filter((c) => c === 'generativelanguage.googleapis.com:gen')).toHaveLength(1);
    const out = getDb().prepare(`SELECT m.whatsapp_message_id AS wa FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id JOIN customers u ON u.id = c.customer_id WHERE u.wa_id = ? AND m.direction = 'outbound' AND m.role = 'assistant'`).all(first.waId) as Array<{ wa: string | null }>;
    expect(out).toEqual([{ wa: 'wamid.OUT' }]);

    const before = calls.length;
    const second = await customerSays();
    expect(second.sent).toEqual(['We open Saturday to Thursday.']);
    expect(calls.slice(before).filter((c) => c === 'openrouter.ai')).toHaveLength(0); // OpenRouter's cooldown holds; Gemini serves directly
    const log = getDb().prepare("SELECT provider_name p, outcome o FROM ai_route_log ORDER BY id").all() as Array<{ p: string; o: string }>;
    expect(log.some((r) => r.p === 'OpenRouter' && r.o === 'failed')).toBe(true);
    expect(log.filter((r) => r.p === 'Gemini' && r.o === 'ok')).toHaveLength(2);
  });

  it('one provider\'s cooldown never blocks the other: with OpenRouter resting, Gemini stays eligible (and vice versa)', async () => {
    network((host) => (host === 'openrouter.ai' ? or429() : gemOk('ok')));
    await customerSays();
    const acc = 1;
    const plan = await runWithAccount(acc, () => buildCandidates(acc, 'chat', { wantsTools: false }));
    expect(plan.eligible.map((c) => c.providerName)).toEqual(['Gemini']);
    expect(plan.skipped.find((s) => s.candidate.providerName === 'OpenRouter')?.category).toBe('cooldown');
  });

  it('both providers unavailable: ONE honest automated message, the question stays waiting, no further calls while both rest, and no AI answer is invented', async () => {
    network((host) => (host === 'openrouter.ai' ? or429() : gem429()));
    const first = await customerSays();
    expect(first.sent).toHaveLength(1);
    expect(first.sent[0]).toMatch(/Automated reply: our assistant cannot answer right now/);
    const waiting = getDb().prepare("SELECT status FROM pending_replies ORDER BY id DESC LIMIT 1").get() as { status: string };
    expect(waiting.status).toBe('awaiting_ai');
    const before = calls.length;
    const second = await customerSays();
    expect(second.sent).toHaveLength(1); // the same honest automated message, still no AI text
    expect(calls.length).toBe(before); // both routes cooling: no request leaves the process
  });

  it('a malformed Gemini answer fails over to nothing invented: the customer gets the automated message, never an empty or made-up reply', async () => {
    network((host) => (host === 'openrouter.ai' ? or429() : json(200, { candidates: [] })));
    const r = await customerSays();
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]).toMatch(/Automated reply/);
  });
});

describe('strict free-only routing for Gemini', () => {
  it('Gemini is never called until its free tier is confirmed (and an unconfirmed provider is skipped, not retried)', async () => {
    getDb().prepare("UPDATE ai_providers SET free_confirmed = 0 WHERE adapter = 'gemini'").run();
    network((host) => (host === 'openrouter.ai' ? or429() : gemOk('should never be called')));
    const r = await customerSays();
    expect(r.sent[0]).toMatch(/Automated reply/);
    expect(calls.some((c) => c.startsWith('generativelanguage'))).toBe(false);
  });
});

describe('Gemini request details that production exposed', () => {
  it('the output limit leaves room for the model\'s hidden thinking (verified live: a 16-token limit returned finishReason MAX_TOKENS with 11 thought tokens and a one-character answer)', async () => {
    const fn = network(() => gemOk('ok'));
    const { adapterFor } = await import('../../src/llm/adapters');
    await adapterFor('gemini').complete({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: G_KEY, model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'hi' }], maxTokens: 16, timeoutMs: 3000 });
    const sent = JSON.parse(String((fn.mock.calls[0]![1] as RequestInit).body)) as { generationConfig: { maxOutputTokens: number } };
    expect(sent.generationConfig.maxOutputTokens).toBe(16 + THINKING_HEADROOM_TOKENS);
  });

  it('a retired model is reported in the provider\'s own words and rests an hour; the model list is not treated as proof the model can be called', async () => {
    const retired = { error: { code: 404, status: 'NOT_FOUND', message: 'This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.8-flash.' } };
    network((host) => (host === 'openrouter.ai' ? or429() : json(404, retired)));
    getDb().prepare("UPDATE ai_providers SET models = 'gemini-2.5-flash' WHERE adapter = 'gemini'").run();
    await customerSays();
    const row = getDb().prepare("SELECT category, detail FROM ai_route_log WHERE provider_name = 'Gemini' ORDER BY id DESC LIMIT 1").get() as { category: string; detail: string };
    expect(row.category).toBe('model_unavailable');
    expect(row.detail).toContain('no longer available to new users');
    const cd = getDb().prepare("SELECT until_ms FROM ai_route_cooldowns WHERE key LIKE 'chat:%gemini-2.5-flash'").get() as { until_ms: number };
    expect(cd.until_ms - Date.now()).toBeGreaterThan(55 * 60_000);
  });
});
