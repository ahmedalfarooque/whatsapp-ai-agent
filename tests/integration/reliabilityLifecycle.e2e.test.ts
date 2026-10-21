import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/whatsapp/client', () => ({
  sendTextMessage: vi.fn().mockResolvedValue({ messages: [{ id: 'wamid.OUT' }] }),
  sendInteractiveMessage: vi.fn().mockResolvedValue({ messages: [{ id: 'wamid.OUT' }] }),
  markMessageAsRead: vi.fn().mockResolvedValue(undefined),
}));

import path from 'node:path';
import { sendTextMessage } from '../../src/whatsapp/client';
import { processInboundMessage, resetCredentialFallbackThrottle } from '../../src/pipeline/processInboundMessage';
import { allowUnknownPriceForTests, buildCandidates, resetAiRouterForTests, routeCompletion } from '../../src/llm/aiRouter';
import { getOrCreateCustomer, setCustomerLanguage } from '../../src/memory/customerRepo';
import { loadKnowledgeBase } from '../../src/knowledge/loader';
import { getDb } from '../../src/memory/db';
import { env } from '../../src/config/env';
import { createProvider } from '../../src/llm/providerRepo';
import { setModelCatalogForTests } from '../../src/llm/modelCatalog';
import { createAccount } from '../../src/accounts/accountRepo';
import { runWithAccount } from '../../src/accounts/accountContext';
import { runReplaySweep, type ReplayRunner } from '../../src/replay/replayWorker';
import { runDeliverySweep, MAX_DELIVERY_ATTEMPTS } from '../../src/replay/deliverySweep';
import { parseTokenLimit } from '../../src/llm/openAiCompatible';

/**
 * Generation, delivery and recovery as separate facts — scripted providers (mocked), a mocked WhatsApp client, a faked clock where noted. These prove the application's
 * rules; they are not a real WhatsApp delivery and not a real provider's behaviour.
 */
const mutableEnv = env as unknown as Record<string, unknown>;
const OR_KEY = 'sk-or-v1-lifecyclelifecyclelifecyclelifecycle000000';
const G_KEY = 'AQ.Ab8RN6Lifecycle-GeminiKeyShapeLifecycleLifecycle00000';
const GROQ_KEY = 'gsk_lifecyclelifecyclelifecyclelifecycle00000000';
const MIN = 60_000;
const knowledge = loadKnowledgeBase(path.join(__dirname, '..', 'fixtures', 'knowledge'));
const originalMock = mutableEnv.shouldUseMockProviders;
const originalKey = mutableEnv.OPENROUTER_API_KEY;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const orOk = (text: string) => json(200, { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }] });
const reasoningOnly = () => json(200, { choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: '', reasoning: 'let me think…' } }] });
const gemOk = (text: string) => json(200, { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] });
const err = (status: number, message: string) => json(status, { error: { message } });

type Host = 'openrouter.ai' | 'generativelanguage.googleapis.com' | 'api.groq.com';
let counts: Record<string, number>;
let bodies: Array<{ host: string; body: Record<string, unknown> }>;
function network(handlers: Partial<Record<Host, (n: number, body: Record<string, unknown>) => Response>>) {
  counts = {}; bodies = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const host = new URL(String(url)).host as Host;
    counts[host] = (counts[host] ?? 0) + 1;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    bodies.push({ host, body });
    const handler = handlers[host];
    return handler ? handler(counts[host]!, body) : err(500, 'no script');
  }));
}
const total = (): number => Object.values(counts).reduce((a, b) => a + b, 0);

let account: number;
beforeEach(() => {
  mutableEnv.shouldUseMockProviders = false;
  mutableEnv.OPENROUTER_API_KEY = '';
  resetCredentialFallbackThrottle();
  const db = getDb();
  db.prepare('DELETE FROM ai_providers').run();
  db.prepare('DELETE FROM ai_route_log').run();
  db.prepare('DELETE FROM pending_replies').run();
  createProvider({ name: 'OpenRouter', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: OR_KEY, models: ['openrouter/free'], priority: 10, timeoutMs: 3000 }, { accountId: null, updatedBy: 1 });
  createProvider({ name: 'Gemini', kind: 'openai_compatible', adapter: 'gemini', vendor: 'google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: G_KEY, models: ['gemini-3.8-flash'], priority: 100, timeoutMs: 3000 }, { accountId: null, updatedBy: 1 });
  setModelCatalogForTests([{ id: 'openrouter/free', free: true, image: false, audio: false, tools: true, contextLength: 100000 }]);
  allowUnknownPriceForTests(false);
  resetAiRouterForTests();
  account = createAccount({ name: `Lifecycle Co ${Math.random()}` }).id;
  vi.mocked(sendTextMessage).mockReset();
  vi.mocked(sendTextMessage).mockResolvedValue({ messages: [{ id: 'wamid.OUT' }] } as never);
});
afterEach(() => {
  vi.useRealTimers();
  mutableEnv.shouldUseMockProviders = originalMock;
  mutableEnv.OPENROUTER_API_KEY = originalKey;
  vi.unstubAllGlobals();
});

const sent = (): string[] => vi.mocked(sendTextMessage).mock.calls.map((c) => String(c[1]));
let counter = 0;
async function customerSays(text = 'Do you open on Fridays?') {
  const waId = `1555777${String(++counter).padStart(4, '0')}`;
  setCustomerLanguage(getOrCreateCustomer(waId, 'Sam').id, 'en');
  await processInboundMessage({ waId, messageId: `wamid.rl${counter}`, timestamp: Date.now(), type: 'text', text, contactName: 'Sam' } as never, { knowledge });
  return waId;
}
const runner: ReplayRunner = { run: async (_row, _jid, fn) => { await fn(knowledge); } };
const storedReplies = (waId: string) => getDb().prepare(`SELECT m.id, m.content, m.metadata, m.whatsapp_message_id AS wa FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id JOIN customers u ON u.id = c.customer_id WHERE u.wa_id = ? AND m.role = 'assistant' ORDER BY m.id`).all(waId) as Array<{ id: number; content: string; metadata: string | null; wa: string | null }>;
const pendingStatus = (waId: string): string[] => (getDb().prepare('SELECT status FROM pending_replies WHERE wa_id = ? ORDER BY id').all(waId) as Array<{ status: string }>).map((r) => r.status);

describe('a generated answer that WhatsApp would not deliver is delivered later — the same text, no new AI call, never twice', () => {
  it('the answer is stored as undelivered, the delivery sweep sends THAT text once through the live transport, the question closes as answered, and nothing is regenerated', async () => {
    network({ 'openrouter.ai': () => orOk('We open Saturday to Thursday.') });
    vi.mocked(sendTextMessage).mockRejectedValueOnce(new Error('socket closed'));
    const waId = await customerSays();
    const first = storedReplies(waId).at(-1)!;
    expect(first.content).toBe('We open Saturday to Thursday.');
    expect(JSON.parse(first.metadata!)).toMatchObject({ delivery: 'send_failed' }); // generation succeeded, delivery did not: told apart
    expect(first.wa).toBeNull();
    expect(pendingStatus(waId)).toEqual(['pending']); // not claimed as answered without delivery evidence
    const aiCalls = total();

    const result = await runDeliverySweep(runner, new Date(), getDb());
    expect(result).toMatchObject({ retried: 1, delivered: 1 });
    expect(sent()).toEqual(['We open Saturday to Thursday.', 'We open Saturday to Thursday.']); // the failed attempt, then the retry: the SAME text
    expect(total()).toBe(aiCalls); // no new AI request
    const after = storedReplies(waId).at(-1)!;
    expect(JSON.parse(after.metadata!)).toMatchObject({ delivery: 'sent', deliveredLate: true, deliveryAttempts: 1 });
    expect(after.wa).toBe('wamid.OUT');
    expect(pendingStatus(waId)).toEqual(['answered']);
    expect(await runDeliverySweep(runner, new Date(), getDb())).toMatchObject({ retried: 0 }); // already delivered: never again
    expect(sent()).toHaveLength(2);
  });

  it('a question whose answer is waiting for delivery is NOT answered a second time by the replay sweep (after a restart the pending row is interrupted)', async () => {
    network({ 'openrouter.ai': () => orOk('We open Saturday to Thursday.') });
    vi.mocked(sendTextMessage).mockRejectedValueOnce(new Error('socket closed'));
    const waId = await customerSays();
    getDb().prepare("UPDATE pending_replies SET status = 'interrupted' WHERE wa_id = ?").run(waId); // what a restart does to a row still "pending"
    const aiCalls = total();
    const replay = await runReplaySweep(runner, new Date(), getDb());
    expect(replay.replayed).toBe(0);
    expect(total()).toBe(aiCalls); // the stored answer is the answer: no second generation
    const delivery = await runDeliverySweep(runner, new Date(), getDb());
    expect(delivery.delivered).toBe(1);
    expect(sent().filter((t) => t === 'We open Saturday to Thursday.')).toHaveLength(2); // one failed attempt + one delivery
  });

  it('after the last try staff are told once and the answer is marked abandoned; a failing try sends nothing else', async () => {
    network({ 'openrouter.ai': () => orOk('We open Saturday to Thursday.') });
    vi.mocked(sendTextMessage).mockReset();
    vi.mocked(sendTextMessage).mockRejectedValue(new Error('socket closed'));
    const waId = await customerSays();
    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i += 1) expect(await runDeliverySweep(runner, new Date(), getDb())).toMatchObject({ retried: 1, delivered: 0 });
    const last = await runDeliverySweep(runner, new Date(), getDb());
    expect(last).toMatchObject({ retried: 0, gaveUp: 1 });
    expect(JSON.parse(storedReplies(waId).at(-1)!.metadata!)).toMatchObject({ delivery: 'send_abandoned' });
    const notes = getDb().prepare("SELECT COUNT(*) AS n FROM staff_notifications WHERE kind = 'reply_undelivered'").get() as { n: number };
    expect(notes.n).toBe(1);
    await runDeliverySweep(runner, new Date(), getDb());
    expect((getDb().prepare("SELECT COUNT(*) AS n FROM staff_notifications WHERE kind = 'reply_undelivered'").get() as { n: number }).n).toBe(1);
  });

  it('a stale undelivered answer is not sent once the customer has since received another delivered answer', async () => {
    network({ 'openrouter.ai': (n) => orOk(n === 1 ? 'First answer.' : 'Second answer.') });
    vi.mocked(sendTextMessage).mockRejectedValueOnce(new Error('socket closed'));
    const waId = await customerSays('Do you open on Fridays?');
    await processInboundMessage({ waId, messageId: 'wamid.rl-second', timestamp: Date.now(), type: 'text', text: 'And on Saturdays?', contactName: 'Sam' } as never, { knowledge });
    expect(sent().slice(-1)).toEqual(['Second answer.']);
    vi.mocked(sendTextMessage).mockClear();
    expect(await runDeliverySweep(runner, new Date(), getDb())).toMatchObject({ superseded: 1, retried: 0 });
    expect(sent()).toHaveLength(0);
  });
});

describe('customer replies get a budget a reasoning model can answer within', () => {
  const groq = () => createProvider({ name: 'Groq', kind: 'openai_compatible', adapter: 'openai', vendor: 'groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: GROQ_KEY, models: ['openai/gpt-oss-20b'], priority: 5, timeoutMs: 3000, freeConfirmed: true }, { accountId: null, updatedBy: 1 });

  it('Groq is asked with 1000 completion tokens (max_completion_tokens); other vendors keep 600 (max_tokens)', async () => {
    groq();
    network({ 'api.groq.com': () => orOk('Groq answer.'), 'openrouter.ai': () => orOk('OpenRouter answer.') });
    await customerSays();
    expect(bodies[0]).toMatchObject({ host: 'api.groq.com', body: { max_completion_tokens: 1000 } });
    expect(bodies[0]!.body).not.toHaveProperty('max_tokens');
    getDb().prepare("UPDATE ai_providers SET enabled = 0 WHERE vendor = 'groq'").run();
    resetAiRouterForTests();
    await customerSays();
    expect(bodies.at(-1)).toMatchObject({ host: 'openrouter.ai', body: { max_tokens: 600 } });
  });

  it('a reply whose whole budget went on reasoning is retried ONCE on the same route with a bounded larger budget, and the customer gets ONE answer', async () => {
    groq();
    network({ 'api.groq.com': (_n, body) => (Number(body.max_completion_tokens) >= 2000 ? orOk('Answer after reasoning.') : reasoningOnly()), 'openrouter.ai': () => orOk('Should not be needed.') });
    await customerSays();
    expect(bodies.filter((b) => b.host === 'api.groq.com').map((b) => b.body.max_completion_tokens)).toEqual([1000, 2000]);
    expect(counts['openrouter.ai']).toBeUndefined();
    expect(sent()).toEqual(['Answer after reasoning.']);
  });

  it('still reasoning-only at the larger budget: the route fails over to the next provider (never a blank or internal text to the customer), the budget never exceeds 2048', async () => {
    groq();
    network({ 'api.groq.com': () => reasoningOnly(), 'openrouter.ai': () => orOk('OpenRouter answer.') });
    await customerSays();
    expect(bodies.filter((b) => b.host === 'api.groq.com').map((b) => b.body.max_completion_tokens)).toEqual([1000, 2000]);
    expect(sent()).toEqual(['OpenRouter answer.']);
    expect(sent().join(' ')).not.toMatch(/think|reasoning/i);
  });

  const tooLarge = (requested: number) => json(413, { error: { message: `Request too large for model \`openai/gpt-oss-20b\` in organization \`org_x\` service tier \`on_demand\` on tokens per minute (TPM): Limit 8000, Requested ${requested}, please reduce your message size and try again.`, type: 'tokens', code: 'rate_limit_exceeded' } });
  const cooldownRows = (): number => (getDb().prepare('SELECT COUNT(*) AS n FROM ai_route_cooldowns').get() as { n: number }).n;

  it('Groq says the REQUEST is over its per-minute token limit and the prompt alone does not fit: fail over at once, with no pause on Groq (a smaller request would be fine)', async () => {
    groq();
    getDb().prepare('DELETE FROM ai_route_cooldowns').run();
    network({ 'api.groq.com': () => tooLarge(8900), 'openrouter.ai': () => orOk('OpenRouter answer.') });
    await customerSays();
    expect(bodies.filter((b) => b.host === 'api.groq.com')).toHaveLength(1); // not repeated: shrinking the reply cannot make a 7,900-token prompt fit
    expect(sent()).toEqual(['OpenRouter answer.']);
    expect(cooldownRows()).toBe(0); // the size is the problem, not the route
  });

  it('the prompt fits and only the reply budget tips it over: ONE retry with the budget that fits, and Groq answers (no failover, no pause)', async () => {
    groq();
    getDb().prepare('DELETE FROM ai_route_cooldowns').run();
    network({ 'api.groq.com': (_n, body) => (Number(body.max_completion_tokens) > 700 ? tooLarge(7300 + Number(body.max_completion_tokens)) : orOk('Groq answer.')), 'openrouter.ai': () => orOk('Should not be needed.') });
    await customerSays();
    expect(bodies.filter((b) => b.host === 'api.groq.com').map((b) => b.body.max_completion_tokens)).toEqual([1000, 600]); // 8000 - 7300 - 100 margin
    expect(counts['openrouter.ai']).toBeUndefined();
    expect(sent()).toEqual(['Groq answer.']);
    expect(cooldownRows()).toBe(0);
  });

  it('a per-minute limit that is already USED UP (a 429, not "request too large") is still a rate limit and pauses the route as before', async () => {
    groq();
    getDb().prepare('DELETE FROM ai_route_cooldowns').run();
    network({ 'api.groq.com': () => json(429, { error: { message: 'Rate limit reached for model `openai/gpt-oss-20b` on tokens per minute (TPM): Limit 8000, Used 7900, Requested 1000. Please try again in 6.5s.' } }), 'openrouter.ai': () => orOk('OpenRouter answer.') });
    await customerSays();
    expect(sent()).toEqual(['OpenRouter answer.']);
    expect(cooldownRows()).toBeGreaterThan(0);
  });

  it('parseTokenLimit reads the limit and the request size only when the provider says the request is too large', () => {
    const body = JSON.stringify({ error: { message: 'Request too large for model x on tokens per minute (TPM): Limit 8000, Requested 9234, please reduce your message size.' } });
    expect(parseTokenLimit(body, 413)).toEqual({ limit: 8000, requested: 9234 });
    expect(parseTokenLimit(body, 400)).toEqual({ limit: 8000, requested: 9234 }); // the words "request too large" are enough
    expect(parseTokenLimit(JSON.stringify({ error: { message: 'Rate limit reached on tokens per minute (TPM): Limit 8000, Used 7000, Requested 2000.' } }), 429)).toBeNull(); // cumulative use is a rate limit
    expect(parseTokenLimit(undefined, 413)).toBeNull();
    expect(parseTokenLimit('not json: Limit 1, Requested 2', 500)).toBeNull();
  });

  it('an EMPTY answer from the first provider fails over to the next, once', async () => {
    network({ 'openrouter.ai': () => json(200, { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '' } }] }), 'generativelanguage.googleapis.com': () => gemOk('Gemini answer.') });
    await customerSays();
    expect(sent()).toEqual(['Gemini answer.']);
  });
});

describe('an invalid request is its own failure class, and a trial is guarded across worker processes', () => {
  const ask = () => runWithAccount(account, () => routeCompletion({ task: 'chat', messages: [{ role: 'user', content: 'hi' }], maxTokens: 8, temperature: 0, deadline: Date.now() + 8000 }));

  it('HTTP 400 is classified invalid_request (not quota, not auth, not billing), pauses only that route with a backoff, and fails over', async () => {
    network({ 'openrouter.ai': () => err(400, 'Unsupported value for this request'), 'generativelanguage.googleapis.com': () => gemOk('Gemini answer.') });
    const answer = await ask();
    expect(answer.choices[0]!.message.content).toBe('Gemini answer.');
    expect(getDb().prepare("SELECT category FROM ai_route_log WHERE provider_name = 'OpenRouter' AND outcome = 'failed'").all()).toEqual([{ category: 'invalid_request' }]);
    const state = getDb().prepare("SELECT scope, category, reset_known AS known FROM ai_route_cooldowns WHERE key LIKE 'chat:%'").get() as { scope: string; category: string; known: number };
    expect(state).toEqual({ scope: 'route', category: 'invalid_request', known: 0 });
    const before = counts['openrouter.ai'];
    await ask();
    expect(counts['openrouter.ai']).toBe(before); // paused: not called again
  });

  it('a trial lease taken by ANOTHER worker keeps this worker off the recovering route (it fails over); when the lease is gone the trial runs and leaves no lease behind', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const T0 = Date.now();
    network({ 'openrouter.ai': () => err(500, 'upstream exploded'), 'generativelanguage.googleapis.com': () => gemOk('Gemini answer.') });
    await ask(); // OpenRouter fails: it now has a failure on record
    vi.setSystemTime(T0 + 2 * MIN); // its pause is over
    const plan = await runWithAccount(account, () => buildCandidates(account, 'chat', { wantsTools: false }));
    const routeKey = `chat:${plan.eligible[0]!.key}`;
    // Another process holds the trial lease for this route.
    getDb().prepare("INSERT INTO ai_route_cooldowns (key, scope, until_ms, why, category, reset_known, strikes, set_at_ms) VALUES (?, 'route', ?, 'trial in flight', 'trial', 0, 0, ?)").run(`trial:${routeKey}`, Date.now() + 60_000, Date.now());
    const before = counts['openrouter.ai'];
    const answer = await ask();
    expect(answer.choices[0]!.message.content).toBe('Gemini answer.');
    expect(counts['openrouter.ai']).toBe(before); // not touched while the other worker tests it
    expect(answer.route.skipped.some((s) => s.category === 'recovering')).toBe(true);
    // The other worker finished (or its lease expired).
    vi.setSystemTime(T0 + 4 * MIN);
    network({ 'openrouter.ai': () => orOk('OpenRouter is back.'), 'generativelanguage.googleapis.com': () => gemOk('Gemini answer.') });
    const back = await ask();
    expect(back.choices[0]!.message.content).toBe('OpenRouter is back.');
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM ai_route_cooldowns WHERE key LIKE 'trial:%'").get()).toEqual({ n: 0 });
  });
});
