import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/whatsapp/client', () => ({
  sendTextMessage: vi.fn().mockResolvedValue({ messages: [{ id: 'wamid.OUT' }] }),
  sendInteractiveMessage: vi.fn().mockResolvedValue({ messages: [{ id: 'wamid.OUT' }] }),
  markMessageAsRead: vi.fn().mockResolvedValue(undefined),
}));

import path from 'node:path';
import { sendTextMessage } from '../../src/whatsapp/client';
import { processInboundMessage, resetCredentialFallbackThrottle } from '../../src/pipeline/processInboundMessage';
import { activeCooldowns, allowUnknownPriceForTests, buildCandidates, resetAiRouterForTests, routeCompletion, simulateRestartForTests } from '../../src/llm/aiRouter';
import { getOrCreateCustomer, setCustomerLanguage } from '../../src/memory/customerRepo';
import { loadKnowledgeBase } from '../../src/knowledge/loader';
import { getDb } from '../../src/memory/db';
import { env } from '../../src/config/env';
import { createProvider, getProvider, setProviderFreeConfirmed } from '../../src/llm/providerRepo';
import { setModelCatalogForTests } from '../../src/llm/modelCatalog';
import { createAccount } from '../../src/accounts/accountRepo';
import { runWithAccount } from '../../src/accounts/accountContext';
import { providerHealth } from '../../src/dashboard/aiPoolState';
import { runReplaySweep, type ReplayRunner } from '../../src/replay/replayWorker';
import { AiResponseError } from '../../src/llm/aiResponseError';
import { claimWebhookEvent } from '../../src/pipeline/idempotency';

/**
 * Provider limits, end to end, with SCRIPTED providers and a faked clock (Date only): these prove the routing, classification, persistence and recovery rules —
 * not Google's, OpenRouter's or Groq's real behaviour and not a real WhatsApp delivery.
 */
const mutableEnv = env as unknown as Record<string, unknown>;
const OR_KEY = 'sk-or-v1-limitslimitslimitslimitslimitslimit00000000';
const G_KEY = 'AQ.Ab8RN6Limits-GeminiKeyShapeLimitsLimitsLimits0000000';
const GROQ_KEY = 'gsk_limitslimitslimitslimitslimitslimit0000000';
const MIN = 60_000;
const knowledge = loadKnowledgeBase(path.join(__dirname, '..', 'fixtures', 'knowledge'));
const originalMock = mutableEnv.shouldUseMockProviders;
const originalKey = mutableEnv.OPENROUTER_API_KEY;
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const orOk = (text: string) => json(200, { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }] });
const gemOk = (text: string) => json(200, { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] });
const err = (status: number, message: string, headers: Record<string, string> = {}) => json(status, { error: { message } }, headers);
const gemQuota = (message = 'You exceeded your current quota') => json(429, { error: { status: 'RESOURCE_EXHAUSTED', message } });

// T0 is two days ahead: rows the real clock stamped are always older than the scenario.
const T0 = ((d) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 2, 10, 0, 0))(new Date());
const at = (ms: number) => vi.setSystemTime(T0 + ms);

type Host = 'openrouter.ai' | 'generativelanguage.googleapis.com' | 'api.groq.com';
let counts: Record<string, number>;
function network(handlers: Partial<Record<Host, (n: number) => Response | Promise<Response>>>, delayMs = 0) {
  counts = {};
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
    const host = new URL(String(url)).host as Host;
    counts[host] = (counts[host] ?? 0) + 1;
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const handler = handlers[host];
    return handler ? await handler(counts[host]!) : err(500, 'no script');
  }));
}

let account: number;
let orId: number;
beforeEach(() => {
  mutableEnv.shouldUseMockProviders = false;
  mutableEnv.OPENROUTER_API_KEY = '';
  resetCredentialFallbackThrottle();
  const db = getDb();
  db.prepare('DELETE FROM ai_providers').run();
  db.prepare('DELETE FROM ai_route_log').run();
  db.prepare('DELETE FROM pending_replies').run();
  vi.useFakeTimers({ toFake: ['Date'] });
  at(0);
  orId = createProvider({ name: 'OpenRouter', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: OR_KEY, models: ['openrouter/free'], priority: 10, timeoutMs: 3000 }, { accountId: null, updatedBy: 1 }).id;
  createProvider({ name: 'Gemini', kind: 'openai_compatible', adapter: 'gemini', vendor: 'google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: G_KEY, models: ['gemini-3.8-flash'], priority: 100, timeoutMs: 3000 }, { accountId: null, updatedBy: 1 });
  setModelCatalogForTests([{ id: 'openrouter/free', free: true, image: false, audio: false, tools: true, contextLength: 100000 }]);
  allowUnknownPriceForTests(false); // the production rule
  resetAiRouterForTests();
  account = createAccount({ name: `Limits Co ${Math.random()}` }).id;
});
afterEach(() => {
  vi.useRealTimers();
  mutableEnv.shouldUseMockProviders = originalMock;
  mutableEnv.OPENROUTER_API_KEY = originalKey;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const only = (vendorOrKind: 'openrouter' | 'google') => getDb().prepare(vendorOrKind === 'openrouter' ? "DELETE FROM ai_providers WHERE vendor <> 'openrouter'" : "DELETE FROM ai_providers WHERE vendor <> 'google'").run();
const ask = () => runWithAccount(account, () => routeCompletion({ task: 'chat', messages: [{ role: 'user', content: 'hi' }], maxTokens: 8, temperature: 0, deadline: Date.now() + 8000 }));
const state = (like: string) => getDb().prepare('SELECT key, scope, category, reset_known AS known, strikes, until_ms - set_at_ms AS ms FROM ai_route_cooldowns WHERE key LIKE ?').get(like) as { key: string; scope: string; category: string; known: number; strikes: number; ms: number } | undefined;

describe('quota errors are told apart from bad keys, billing and ordinary failures, and the provider\'s own reset time is what gets stored', () => {
  it.each([
    ['HTTP 429, no reset time → quota/rate limit, a one-minute route pause that is an ESTIMATE', () => err(429, 'Provider returned error'), 'rate_limited', 'chat:%', 60_000, 0],
    ['HTTP 429 with Retry-After: 120 → the pause IS 120 s and is marked as stated', () => err(429, 'slow down', { 'retry-after': '120' }), 'rate_limited', 'chat:%', 120_000, 1],
    ['HTTP 429 with an HTTP-date Retry-After → the pause ends at that date', () => err(429, 'slow down', { 'retry-after': new Date(T0 + 300_000).toUTCString() }), 'rate_limited', 'chat:%', 300_000, 1],
    ['HTTP 429 whose body says "try again in 7m12s" → 432 s, stated', () => err(429, 'Rate limit reached. Please try again in 7m12s.'), 'rate_limited', 'chat:%', 432_000, 1],
    ['HTTP 429 with X-RateLimit-Reset (epoch ms) → until that moment, stated', () => err(429, 'limit', { 'x-ratelimit-reset': String(T0 + 600_000) }), 'rate_limited', 'chat:%', 600_000, 1],
    ['HTTP 429 "free-models-per-day" without a reset → the WHOLE provider rests 30 minutes (estimate)', () => err(429, 'Rate limit exceeded: free-models-per-day'), 'rate_limited', 'provider:%', 30 * MIN, 0],
    ['HTTP 401 → a rejected key: provider paused 10 minutes, category auth (not a quota)', () => err(401, 'Invalid API key'), 'auth', 'provider:%', 10 * MIN, 0],
    ['HTTP 402 → billing/credits: provider paused 30 minutes, category credit (not a quota)', () => err(402, 'Insufficient credits'), 'credit', 'provider:%', 30 * MIN, 0],
    ['HTTP 500 → ordinary failure: route paused one minute', () => err(500, 'upstream exploded'), 'provider_error', 'chat:%', MIN, 0],
  ])('%s', async (_label, respond, category, keyLike, ms, known) => {
    only('openrouter');
    network({ 'openrouter.ai': () => respond() });
    await ask().then(() => { throw new Error('the request should have failed'); }, () => undefined); // a rejected key is an AiCredentialError, every other failure an AiResponseError
    const s = state(keyLike);
    expect(s, JSON.stringify(getDb().prepare('SELECT * FROM ai_route_cooldowns').all())).toBeDefined();
    expect(s!.category).toBe(category);
    expect(s!.known).toBe(known);
    expect(Math.abs(s!.ms - ms)).toBeLessThanOrEqual(2000);
  });

  it('Google: a per-minute quota waits the stated RetryInfo delay; a per-day quota rests until the daily reset; a bad key and billing stay separate', async () => {
    only('google');
    const detail = (id: string, delay: string) => json(429, { error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: id }] }, { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: delay }] } });
    network({ 'generativelanguage.googleapis.com': () => detail('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '45s') });
    await ask().catch(() => undefined);
    expect(state('%')).toMatchObject({ category: 'rate_limited', known: 1 });
    expect(Math.abs(state('%')!.ms - 45_000)).toBeLessThanOrEqual(2000);
    resetAiRouterForTests();
    network({ 'generativelanguage.googleapis.com': () => detail('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '20s') });
    await ask().catch(() => undefined);
    const day = state('%')!;
    expect(day).toMatchObject({ category: 'rate_limited', scope: 'provider', known: 1 });
    expect(day.ms).toBeGreaterThan(MIN); // the daily reset (midnight Pacific), never the 20 s hint
    expect(day.ms).toBeLessThanOrEqual(24 * 60 * MIN);
    resetAiRouterForTests();
    network({ 'generativelanguage.googleapis.com': () => json(400, { error: { status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.' } }) });
    await ask().catch(() => undefined);
    expect(state('%')).toMatchObject({ category: 'auth', scope: 'provider' });
  });
});

describe('when the provider gives no reset time the retry is a bounded backoff — never an invented reset', () => {
  it('doubles with each consecutive failure up to a cap (1, 2, 4, 8, 15, 15 minutes), starts over after a success, and is never shown as a reset time', async () => {
    only('openrouter');
    let healthy = false;
    network({ 'openrouter.ai': () => (healthy ? orOk('ok') : err(500, 'upstream exploded')) });
    const pauses: number[] = [];
    let now = 0;
    for (let i = 0; i < 6; i += 1) {
      at(now);
      await ask().catch(() => undefined);
      const s = state('chat:%')!;
      pauses.push(s.ms / MIN);
      expect(s.known).toBe(0);
      now += s.ms + 1000; // wait until just after the pause, then it is tried (and fails) again
    }
    expect(pauses).toEqual([1, 2, 4, 8, 15, 15]);
    const health = providerHealth(getProvider(orId)!, T0 + now - 3000);
    expect(health.cooldown).toMatchObject({ resetKnown: false, failures: 6 });
    expect(health.summary).toMatch(/retry ~/);
    expect(health.summary).not.toMatch(/resets/);

    healthy = true;
    at(now);
    await ask();
    expect(state('chat:%')).toBeUndefined(); // a success clears the backoff
    healthy = false;
    at(now + 2000);
    await ask().catch(() => undefined);
    expect(state('chat:%')!.ms).toBe(MIN); // starts over
  });

  it('a failure inside the SAME pause (a sibling route in the same message) is one event, not an escalation, and never shortens a pause already running', async () => {
    getDb().prepare("UPDATE ai_providers SET models = 'openrouter/free,second/free-model' WHERE vendor = 'openrouter'").run();
    setModelCatalogForTests([{ id: 'openrouter/free', free: true, image: false, audio: false, tools: true, contextLength: 1 }, { id: 'second/free-model', free: true, image: false, audio: false, tools: true, contextLength: 1 }]);
    only('openrouter');
    network({ 'openrouter.ai': () => err(429, 'Rate limit exceeded: free-models-per-day', { 'retry-after': '7200' }) });
    await ask().catch(() => undefined);
    const s = state('provider:%')!;
    expect(s.strikes).toBe(1);
    expect(Math.abs(s.ms - 7200_000)).toBeLessThanOrEqual(2000); // the stated 2 h, not cut to the 30-minute estimate
  });
});

describe('pauses and health survive a restart', () => {
  it('a stated reset set before a restart still blocks the provider afterwards, is shown with its stated time, and the backoff continues from where it was', async () => {
    only('openrouter');
    network({ 'openrouter.ai': () => err(429, 'slow down', { 'retry-after': '600' }) });
    await ask().catch(() => undefined);
    simulateRestartForTests(); // everything held in memory is gone; the database keeps the pause
    const plan = await runWithAccount(account, () => buildCandidates(account, 'chat', { wantsTools: false }));
    expect(plan.eligible).toHaveLength(0);
    expect(plan.skipped[0]).toMatchObject({ category: 'cooldown' });
    const health = providerHealth(getProvider(orId)!);
    expect(health).toMatchObject({ state: 'rate_limited' });
    expect(health.cooldown).toMatchObject({ resetKnown: true });
    expect(health.summary).toMatch(/resets \d\d:\d\d UTC/);
    expect(activeCooldowns().some((c) => c.resetKnown && c.category === 'rate_limited')).toBe(true);
    const calls = counts['openrouter.ai'];
    await ask().catch(() => undefined);
    expect(counts['openrouter.ai']).toBe(calls); // no request while it rests, restart or not

    resetAiRouterForTests();
    network({ 'openrouter.ai': () => err(500, 'upstream exploded') });
    at(0);
    await ask().catch(() => undefined);
    simulateRestartForTests();
    at(MIN + 5000);
    await ask().catch(() => undefined);
    expect(state('chat:%')).toMatchObject({ strikes: 2, ms: 2 * MIN }); // the second failure after the restart is the second strike
  });
});

describe('a recovering provider is tested by ONE request at a time', () => {
  it('after its pause, five concurrent requests send ONE request to the failing provider (the trial); the other four go to Gemini without touching it', async () => {
    network({ 'openrouter.ai': () => err(500, 'upstream exploded'), 'generativelanguage.googleapis.com': () => gemOk('Gemini answer') }, 25);
    await ask(); // OpenRouter fails, Gemini answers: OpenRouter is now paused
    at(2 * MIN); // its pause has ended
    counts = {};
    const results = await Promise.all(Array.from({ length: 5 }, () => ask()));
    expect(results.map((r) => r.choices[0]!.message.content)).toEqual(Array(5).fill('Gemini answer'));
    expect(counts['openrouter.ai']).toBe(1); // one trial, not five
    expect(counts['generativelanguage.googleapis.com']).toBe(5);
  });

  it('when the trial succeeds the route is open again: the waiting requests then use it, and no second request overlapped the trial', async () => {
    let healthy = false;
    const timeline: string[] = [];
    network({
      'openrouter.ai': async (n) => { timeline.push(`start${n}`); const r = healthy ? orOk('OpenRouter answer') : err(500, 'upstream exploded'); timeline.push(`end${n}`); return r; },
      'generativelanguage.googleapis.com': () => gemOk('Gemini answer'),
    }, 20);
    await ask();
    at(2 * MIN);
    healthy = true;
    timeline.length = 0;
    const results = await Promise.all(Array.from({ length: 4 }, () => ask()));
    expect(results.every((r) => r.choices[0]!.message.content === 'OpenRouter answer')).toBe(true);
    const first = /^start(\d+)$/.exec(timeline[0]!)![1];
    expect(timeline.slice(0, 2)).toEqual([`start${first}`, `end${first}`]); // the trial finished before any other request started
    expect(state('chat:%')).toBeUndefined();
  });
});

describe('a free-tier limit is never bypassed with a paid or unconfirmed route', () => {
  it('OpenRouter and Gemini both exhausted: an unconfirmed Groq is never called; confirmed free, it takes over — in the order OpenRouter, Gemini, Groq', async () => {
    const groq = createProvider({ name: 'Groq', kind: 'openai_compatible', adapter: 'openai', vendor: 'groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: GROQ_KEY, models: ['openai/gpt-oss-20b'], timeoutMs: 3000, freeConfirmed: false }, { accountId: null, updatedBy: 1 });
    expect(groq.priority).toBe(110); // appended after Gemini (100): a new shared provider joins the end of Default
    network({ 'openrouter.ai': () => err(429, 'Rate limit exceeded: free-models-per-day'), 'generativelanguage.googleapis.com': () => gemQuota(), 'api.groq.com': () => orOk('Groq answer') });
    await expect(ask()).rejects.toBeInstanceOf(AiResponseError);
    expect(counts['api.groq.com']).toBeUndefined(); // not confirmed free: never called, even with everything else exhausted
    setProviderFreeConfirmed(groq.id, account, true, 1);
    resetAiRouterForTests();
    const plan = await runWithAccount(account, () => buildCandidates(account, 'chat', { wantsTools: false }));
    expect(plan.eligible.map((c) => c.providerName)).toEqual(['OpenRouter', 'Gemini', 'Groq']);
    const answer = await ask();
    expect(answer.choices[0]!.message.content).toBe('Groq answer');
    expect(answer.route.attempts.map((a) => `${a.candidate.providerName}:${a.category}`)).toEqual(['OpenRouter:rate_limited', 'Gemini:rate_limited', 'Groq:null']);
  });

  it('a route whose catalog price is not zero is never used to get around an exhausted free quota', async () => {
    only('openrouter');
    getDb().prepare("UPDATE ai_providers SET models = 'openrouter/free,paid/model' WHERE vendor = 'openrouter'").run();
    setModelCatalogForTests([{ id: 'openrouter/free', free: true, image: false, audio: false, tools: true, contextLength: 1 }, { id: 'paid/model', free: false, image: false, audio: false, tools: true, contextLength: 1 }]);
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => { urls.push(String((JSON.parse(String(init?.body)) as { model: string }).model)); return err(429, 'Rate limit exceeded: free-models-per-day'); }));
    await ask().catch(() => undefined);
    expect(urls.every((m) => m === 'openrouter/free')).toBe(true);
  });
});

describe('every provider exhausted: customers are told once, never see a provider error, lose nothing, and are answered when a provider returns', () => {
  const sendersOf = () => vi.mocked(sendTextMessage).mock.calls.map((c) => String(c[1]));
  let counter = 0;
  async function customerSays(text = 'Do you open on Fridays?', messageId?: string, waId?: string) {
    const id = waId ?? `1555888${String(++counter).padStart(4, '0')}`;
    setCustomerLanguage(getOrCreateCustomer(id, 'Sam').id, 'en');
    await processInboundMessage({ waId: id, messageId: messageId ?? `wamid.lim${++counter}`, timestamp: Date.now(), type: 'text', text, contactName: 'Sam' } as never, { knowledge });
    return id;
  }
  const runner: ReplayRunner = { run: async (_row, _jid, fn) => { await fn(knowledge); } };

  it('one friendly notice per conversation (also across a restart), no raw provider wording anywhere the customer can see, then ONE late answer after the reset — and no duplicate', async () => {
    let orUp = false;
    const RAW = 'AI limit finished: free-models-per-day, Add 10 credits to unlock';
    network({ 'openrouter.ai': () => (orUp ? orOk('We open Saturday to Thursday.') : err(429, RAW)), 'generativelanguage.googleapis.com': () => gemQuota(RAW) });
    vi.mocked(sendTextMessage).mockClear();
    vi.mocked(sendTextMessage).mockResolvedValue({ messages: [{ id: 'wamid.OUT' }] } as never);
    const waId = await customerSays();
    getDb().prepare('UPDATE pending_replies SET created_at = ?, updated_at = ? WHERE id = (SELECT MAX(id) FROM pending_replies)').run(new Date(Date.now()).toISOString().slice(0, 19).replace('T', ' '), new Date(Date.now()).toISOString().slice(0, 19).replace('T', ' '));
    expect(sendersOf()).toHaveLength(1);
    expect(sendersOf()[0]).toMatch(/Automated reply/);
    expect(sendersOf().join(' ')).not.toMatch(/limit|quota|credits|429|rate|provider|openrouter|gemini/i);

    // The customer writes again, much later and after a restart: still the one notice of this outage.
    at(40 * MIN);
    simulateRestartForTests();
    resetCredentialFallbackThrottle();
    await customerSays('Hello? Is anyone there?', undefined, waId);
    await customerSays('Any news please?', undefined, waId);
    expect(sendersOf()).toHaveLength(1);

    // Nothing the customer can see — and nothing stored as an assistant message — carries the provider's words.
    const stored = getDb().prepare("SELECT content FROM conversation_messages WHERE role = 'assistant'").all() as Array<{ content: string }>;
    expect(stored.map((r) => r.content).join(' ')).not.toMatch(/AI limit finished|free-models-per-day|credits/i);
    // The questions are kept, not lost.
    const waiting = getDb().prepare("SELECT status FROM pending_replies WHERE wa_id = ?").all(waId) as Array<{ status: string }>;
    expect(waiting.length).toBeGreaterThan(0);
    expect(waiting.every((r) => r.status === 'awaiting_ai')).toBe(true);
    const userMessages = (getDb().prepare("SELECT COUNT(*) AS n FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id JOIN customers u ON u.id = c.customer_id WHERE u.wa_id = ? AND m.role = 'user'").get(waId) as { n: number }).n;
    expect(userMessages).toBe(3);

    // While every provider rests, the recovery sweep spends nothing; when one is back it answers the newest waiting question ONCE.
    const callsBefore = Object.values(counts).reduce((a, b) => a + b, 0);
    vi.mocked(sendTextMessage).mockClear();
    expect(await runReplaySweep(runner, new Date(), getDb())).toMatchObject({ replayed: 0 });
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(callsBefore);
    getDb().prepare("UPDATE pending_replies SET created_at = ?, updated_at = ? WHERE wa_id = ?").run(new Date(Date.now()).toISOString().slice(0, 19).replace('T', ' '), new Date(Date.now()).toISOString().slice(0, 19).replace('T', ' '), waId);
    at(2 * 60 * MIN); orUp = true; // OpenRouter's stated pause is long over
    getDb().prepare("UPDATE pending_replies SET created_at = ?, updated_at = ? WHERE wa_id = ?").run(new Date(T0 + 119 * MIN).toISOString().slice(0, 19).replace('T', ' '), new Date(T0 + 119 * MIN).toISOString().slice(0, 19).replace('T', ' '), waId);
    const recovered = await runReplaySweep(runner, new Date(), getDb());
    expect(recovered).toMatchObject({ replayed: 1, answered: 1 });
    expect(sendersOf()).toEqual(['We open Saturday to Thursday.']);
    expect(await runReplaySweep(runner, new Date(), getDb())).toMatchObject({ replayed: 0 });
    expect(sendersOf()).toHaveLength(1);
  });

  it('the same WhatsApp message delivered twice at once (a webhook retry) while providers fail over produces ONE reply', async () => {
    network({ 'openrouter.ai': () => err(429, 'Rate limit exceeded: free-models-per-day'), 'generativelanguage.googleapis.com': () => gemOk('Gemini answer once') }, 30);
    vi.mocked(sendTextMessage).mockClear();
    vi.mocked(sendTextMessage).mockResolvedValue({ messages: [{ id: 'wamid.OUT' }] } as never);
    const waId = `1555999${String(++counter).padStart(4, '0')}`;
    setCustomerLanguage(getOrCreateCustomer(waId, 'Sam').id, 'en');
    const msg = { waId, messageId: 'wamid.same-delivery', timestamp: Date.now(), type: 'text', text: 'Do you open on Fridays?', contactName: 'Sam' } as never;
    // The transports (webhook router, QR connection) claim every inbound id atomically before processing; only the claimer proceeds.
    const deliver = async (): Promise<boolean> => { if (!claimWebhookEvent('wamid.same-delivery', 'text from limits test')) return false; await processInboundMessage(msg, { knowledge }); return true; };
    const delivered = await Promise.all([deliver(), deliver(), deliver()]);
    expect(delivered.filter(Boolean)).toHaveLength(1);
    expect(sendersOf()).toEqual(['Gemini answer once']);
    const stored = (getDb().prepare("SELECT COUNT(*) AS n FROM conversation_messages WHERE role = 'user' AND whatsapp_message_id = 'wamid.same-delivery'").get() as { n: number }).n;
    expect(stored).toBe(1);
  });
});
