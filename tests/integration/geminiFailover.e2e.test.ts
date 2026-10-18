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
import { runReplaySweep, type ReplayRunner } from '../../src/replay/replayWorker';

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

/**
 * Both directions, with cooldowns and recovery. The providers are SCRIPTED (mocked) and the clock is faked (Date only): this proves the routing
 * rules, the cooldowns and the recovery sweep — not Google's or OpenRouter's real availability, and not a real WhatsApp delivery.
 */
describe('OpenRouter ⇄ Gemini with cooldowns, quota resets and recovery (scripted providers)', () => {
  const T0 = Date.UTC(2026, 9, 20, 10, 0, 0); // 03:00 Pacific: Gemini's daily quota resets 21 h later
  const MIN = 60_000;
  const geminiDaily = () => json(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }, { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '20s' }] } });
  const invalidKey = () => json(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.' } });
  const messagesOf = (waId: string) => (getDb().prepare(`SELECT COUNT(*) AS n FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id JOIN customers u ON u.id = c.customer_id WHERE u.wa_id = ?`).get(waId) as { n: number }).n;
  const at = (ms: number) => vi.setSystemTime(T0 + ms);
  const hosts = (from = 0) => calls.slice(from).reduce<Record<string, number>>((acc, h) => ({ ...acc, [h]: (acc[h] ?? 0) + 1 }), {});

  afterEach(() => { vi.useRealTimers(); });
  // The waiting-message bookkeeping is stamped by the database clock; stamp it with the faked clock so "how old is it" matches the scenario.
  const sqlNow = (): string => new Date(Date.now()).toISOString().slice(0, 19).replace('T', ' ');
  const says = async () => {
    const r = await customerSays();
    getDb().prepare('UPDATE pending_replies SET created_at = ?, updated_at = ? WHERE id = (SELECT MAX(id) FROM pending_replies)').run(sqlNow(), sqlNow());
    return r;
  };

  it('OpenRouter quota → Gemini answers; Gemini quota → both rest (one honest message, no calls); OpenRouter eligible again → it answers and the waiting messages are replayed ONCE; Gemini returns after its reset', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(0);
    let or: 'ok' | 'daily' = 'daily';
    let gem: 'ok' | 'daily' = 'ok';
    network((host) => (host === 'openrouter.ai' ? (or === 'ok' ? orOk('OR answer') : json(429, { error: { message: 'Rate limit exceeded: free-models-per-day' } })) : (gem === 'ok' ? gemOk('Gemini answer') : geminiDaily())));

    // 1. OpenRouter's daily quota is used up → Gemini answers, once.
    const c1 = await says();
    expect(c1.sent).toEqual(['Gemini answer']);
    const history1 = messagesOf(c1.waId);

    // 2. Ten minutes later Gemini's daily quota is used up too; OpenRouter still rests (30 min) → both resting: ONE honest automated message, the question waits.
    at(10 * MIN); gem = 'daily';
    const before2 = calls.length;
    const c2 = await says();
    expect(c2.sent).toHaveLength(1);
    expect(c2.sent[0]).toMatch(/Automated reply/);
    expect(hosts(before2)).toEqual({ 'generativelanguage.googleapis.com:gen': 1 }); // OpenRouter was not called while it rests; Gemini was tried once
    expect(getDb().prepare('SELECT status FROM pending_replies ORDER BY id DESC LIMIT 1').get()).toEqual({ status: 'awaiting_ai' });

    // 3. Two minutes later nothing may leave the process (both resting), and the recovery sweep waits instead of spending attempts.
    at(12 * MIN);
    const before3 = calls.length;
    const c3 = await says();
    expect(c3.sent[0]).toMatch(/Automated reply/);
    const runner: ReplayRunner = { run: async (_row, _jid, fn) => { await fn(knowledge); } };
    vi.mocked(sendTextMessage).mockClear();
    const waiting = await runReplaySweep(runner, new Date(), getDb());
    expect(waiting).toMatchObject({ replayed: 0, answered: 0 });
    expect(waiting.waiting).toBeGreaterThanOrEqual(2);
    expect(calls.length).toBe(before3);
    expect(vi.mocked(sendTextMessage)).not.toHaveBeenCalled();

    // 4. 31 minutes in: OpenRouter's rest is over and it answers. Gemini (daily quota) still rests until its reset and is NOT called.
    at(31 * MIN); or = 'ok';
    const before4 = calls.length;
    vi.mocked(sendTextMessage).mockClear();
    const recovered = await runReplaySweep(runner, new Date(), getDb());
    expect(recovered).toMatchObject({ replayed: 2, answered: 2 });
    expect(vi.mocked(sendTextMessage).mock.calls.map((c) => String(c[1]))).toEqual(['OR answer', 'OR answer']); // each waiting customer once
    expect(hosts(before4)).toEqual({ 'openrouter.ai': 2 });
    const again = await runReplaySweep(runner, new Date(), getDb());
    expect(again).toMatchObject({ replayed: 0 }); // never a duplicate
    expect(vi.mocked(sendTextMessage)).toHaveBeenCalledTimes(2);
    const c4 = await says();
    expect(c4.sent).toEqual(['OR answer']);
    expect(hosts(before4)['generativelanguage.googleapis.com:gen']).toBeUndefined();

    // 5. 22 h in: Gemini's quota has reset (midnight Pacific passed). OpenRouter's quota is used up again → Gemini answers.
    at(22 * 60 * MIN); gem = 'ok'; or = 'daily';
    const before5 = calls.length;
    const c5 = await says();
    expect(c5.sent).toEqual(['Gemini answer']);
    expect(hosts(before5)['generativelanguage.googleapis.com:gen']).toBe(1);

    // History, customers and the route log are intact: nothing was rewritten, every attempt is on record.
    expect(messagesOf(c1.waId)).toBe(history1);
    const log = getDb().prepare("SELECT provider_name p, outcome o, category c FROM ai_route_log ORDER BY id").all() as Array<{ p: string; o: string; c: string | null }>;
    expect(log.filter((r) => r.p === 'Gemini' && r.o === 'ok').length).toBeGreaterThanOrEqual(2);
    expect(log.filter((r) => r.p === 'OpenRouter' && r.o === 'ok')).toHaveLength(3); // c4 and the two replays
    expect(log.some((r) => r.p === 'Gemini' && r.o === 'failed' && r.c === 'rate_limited')).toBe(true);
  });

  it('Gemini\'s per-minute limit rests only until the delay Google states, then Gemini serves again (no day-long rest for a minute-long limit)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(0);
    const perMinute = () => json(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for metric', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] }, { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '90s' }] } });
    let gem: 'ok' | 'minute' = 'minute';
    network((host) => (host === 'openrouter.ai' ? or429() : gem === 'ok' ? gemOk('Gemini again') : perMinute()));
    const first = await says();
    expect(first.sent[0]).toMatch(/Automated reply/); // both limited at once
    const cd = getDb().prepare("SELECT until_ms FROM ai_route_cooldowns WHERE key LIKE 'chat:%gemini-3.8-flash'").get() as { until_ms: number } | undefined;
    const geminiRest = getDb().prepare("SELECT key, until_ms FROM ai_route_cooldowns").all() as Array<{ key: string; until_ms: number }>;
    expect(geminiRest.length).toBeGreaterThan(0);
    if (cd) expect(cd.until_ms - T0).toBeLessThanOrEqual(15 * MIN); // minutes, never a day
    at(2 * MIN); gem = 'ok'; // 120 s: past Google's 90 s
    const second = await says();
    expect(second.sent).toEqual(['Gemini again']);
  });

  it('a rejected Gemini key fails over to OpenRouter at once and is not retried while it rests; the customer is answered once', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(0);
    network((host) => (host === 'openrouter.ai' ? orOk('OR answer') : invalidKey()));
    getDb().prepare("UPDATE ai_providers SET priority = 5 WHERE adapter = 'gemini'").run(); // Gemini first here, to prove the order, not the luck of the draw
    const first = await says();
    expect(first.sent).toEqual(['OR answer']);
    expect(hosts()['generativelanguage.googleapis.com:gen']).toBe(1);
    const before = calls.length;
    const second = await says();
    expect(second.sent).toEqual(['OR answer']);
    expect(hosts(before)['generativelanguage.googleapis.com:gen']).toBeUndefined(); // the rejected key is resting (10 min), not hammered
    const log = getDb().prepare("SELECT category c FROM ai_route_log WHERE provider_name = 'Gemini' AND outcome = 'failed'").all() as Array<{ c: string }>;
    expect(log.map((r) => r.c)).toEqual(['auth']);
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
