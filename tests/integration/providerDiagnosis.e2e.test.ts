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
import { createProvider, getProvider } from '../../src/llm/providerRepo';
import { setModelCatalogForTests } from '../../src/llm/modelCatalog';
import { createAccount } from '../../src/accounts/accountRepo';
import { runWithAccount } from '../../src/accounts/accountContext';
import { providerHealth } from '../../src/dashboard/aiPoolState';
import { runProviderTest } from '../../src/dashboard/aiRoutingRoutes';
import { probeRecoveredRoutes, resetRouteProbesForTests } from '../../src/llm/routeProbe';

/**
 * Diagnosis regressions from the production routing history of 2026-10-21 (OpenRouter 429 / 404-policy / free-pool upstream limits, Gemini daily quota with a
 * "10:00" reset and 503 high demand, Groq the only provider answering, and repeated manual Test presses). Scripted providers (mocked), faked clock.
 */
const mutableEnv = env as unknown as Record<string, unknown>;
const OR_KEY = 'sk-or-v1-diagnosisdiagnosisdiagnosisdiagnosis000000';
const G_KEY = 'AQ.Ab8RN6Diagnosis-GeminiKeyShapeDiagnosisDiagnosis0000';
const GROQ_KEY = 'gsk_diagnosisdiagnosisdiagnosisdiagnosis00000000';
const MIN = 60_000;
const knowledge = loadKnowledgeBase(path.join(__dirname, '..', 'fixtures', 'knowledge'));
const originalMock = mutableEnv.shouldUseMockProviders;
const originalKey = mutableEnv.OPENROUTER_API_KEY;
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const chatOk = (text: string) => json(200, { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }] });
const gemOk = (text: string) => json(200, { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] });
const err = (status: number, message: string, headers: Record<string, string> = {}) => json(status, { error: { message } }, headers);
const POLICY = '0 endpoints out of 9 requested are available matching your guardrail restrictions and data policy. We removed them for the following reasons (an endpoint may have multiple)';
const gemDaily = () => json(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota, please check your plan and billing details.', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] } });
const gem503 = () => json(503, { error: { code: 503, status: 'UNAVAILABLE', message: 'This model is currently experiencing high demand. Spikes in demand are usually temporary.' } });

const T0 = ((d) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 2, 10, 0, 0))(new Date());
const at = (ms: number) => vi.setSystemTime(T0 + ms);
type Host = 'openrouter.ai' | 'generativelanguage.googleapis.com' | 'api.groq.com';
let counts: Record<string, number>;
function network(handlers: Partial<Record<Host, (n: number) => Response>>) {
  counts = {};
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
    const host = new URL(String(url)).host as Host;
    counts[host] = (counts[host] ?? 0) + 1;
    const handler = handlers[host];
    return handler ? handler(counts[host]!) : err(500, 'no script');
  }));
}
const total = (): number => Object.values(counts).reduce((a, b) => a + b, 0);

let account: number;
let orId: number; let gemId: number; let groqId: number;
beforeEach(() => {
  mutableEnv.shouldUseMockProviders = false;
  mutableEnv.OPENROUTER_API_KEY = '';
  resetCredentialFallbackThrottle();
  resetRouteProbesForTests();
  const db = getDb();
  db.prepare('DELETE FROM ai_providers').run();
  db.prepare('DELETE FROM ai_route_log').run();
  db.prepare('DELETE FROM pending_replies').run();
  vi.useFakeTimers({ toFake: ['Date'] });
  at(0);
  orId = createProvider({ name: 'OpenRouter', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: OR_KEY, models: ['openrouter/free'], priority: 10, timeoutMs: 3000 }, { accountId: null, updatedBy: 1 }).id;
  gemId = createProvider({ name: 'Gemini', kind: 'openai_compatible', adapter: 'gemini', vendor: 'google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: G_KEY, models: ['gemini-3.8-flash'], priority: 100, timeoutMs: 3000 }, { accountId: null, updatedBy: 1 }).id;
  groqId = createProvider({ name: 'Groq', kind: 'openai_compatible', adapter: 'openai', vendor: 'groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: GROQ_KEY, models: ['openai/gpt-oss-20b'], timeoutMs: 3000, freeConfirmed: true }, { accountId: null, updatedBy: 1 }).id;
  setModelCatalogForTests([{ id: 'openrouter/free', free: true, image: false, audio: false, tools: true, contextLength: 100000 }]);
  allowUnknownPriceForTests(false);
  resetAiRouterForTests();
  account = createAccount({ name: `Diagnosis Co ${Math.random()}` }).id;
  vi.mocked(sendTextMessage).mockReset();
  vi.mocked(sendTextMessage).mockResolvedValue({ messages: [{ id: 'wamid.OUT' }] } as never);
});
afterEach(() => {
  vi.useRealTimers();
  mutableEnv.shouldUseMockProviders = originalMock;
  mutableEnv.OPENROUTER_API_KEY = originalKey;
  vi.unstubAllGlobals();
});

const ask = () => runWithAccount(account, () => routeCompletion({ task: 'chat', messages: [{ role: 'user', content: 'hi' }], maxTokens: 8, temperature: 0, deadline: Date.now() + 8000 }));
const stamp = () => getDb().prepare('UPDATE ai_route_log SET created_at = ?').run(new Date(Date.now()).toISOString().slice(0, 19).replace('T', ' '));
const states = () => getDb().prepare("SELECT key, scope, category, reset_known AS known, strikes, until_ms - set_at_ms AS ms FROM ai_route_cooldowns WHERE key NOT LIKE 'trial:%' ORDER BY key").all() as Array<{ key: string; scope: string; category: string; known: number; strikes: number; ms: number }>;
const only = (id: number) => getDb().prepare('DELETE FROM ai_providers WHERE id <> ?').run(id);

describe('OpenRouter: 429, 404-policy and 404-model-missing are three different things', () => {
  it('each is classified on its own, paused by its own rule, and the account-policy refusal says where to fix it (it is not a quota and not a missing model)', async () => {
    const cases: Array<[string, () => Response, string]> = [
      ['rate limit', () => err(429, 'Provider returned error'), 'rate_limited'],
      ['account data policy', () => err(404, POLICY), 'policy'],
      ['model missing', () => err(404, 'No endpoints found for openrouter/free.'), 'model_unavailable'],
    ];
    for (const [, respond, category] of cases) {
      resetAiRouterForTests();
      getDb().prepare('DELETE FROM ai_route_log').run();
      only(orId);
      network({ 'openrouter.ai': () => respond() });
      await ask().catch(() => undefined);
      expect(states().map((s) => s.category)).toEqual([category]);
      expect(getDb().prepare("SELECT category FROM ai_route_log WHERE outcome = 'failed'").all().every((r) => (r as { category: string }).category === category)).toBe(true);
    }
    // The policy refusal's card names the real cause and the setting that controls it.
    resetAiRouterForTests();
    getDb().prepare('DELETE FROM ai_route_log').run();
    network({ 'openrouter.ai': () => err(404, POLICY) });
    await ask().catch(() => undefined);
    stamp();
    const health = providerHealth(getProvider(orId)!);
    expect(health.detail).toMatch(/ACCOUNT's privacy \/ data-policy settings/);
    expect(health.detail).toMatch(/openrouter\.ai\/settings\/privacy/);
    expect(health.detail).not.toMatch(/allowance|rate limit|retried later/i); // it must not read like a quota problem
  });

  it('a refusal that keeps coming back is NOT retried every minute: 1, 2, 4, 8 minutes, and a success starts over', async () => {
    only(orId);
    let healthy = false;
    network({ 'openrouter.ai': () => (healthy ? chatOk('ok') : err(404, POLICY)) });
    const pauses: number[] = [];
    let now = 0;
    for (let i = 0; i < 4; i += 1) {
      at(now);
      await ask().catch(() => undefined);
      const s = states()[0]!;
      pauses.push(s.ms / MIN);
      const before = counts['openrouter.ai'];
      at(now + 30_000);
      await ask().catch(() => undefined);
      expect(counts['openrouter.ai']).toBe(before); // paused: the same refusal is not asked for again
      now += s.ms + 1000;
    }
    expect(pauses).toEqual([1, 2, 4, 8]);
    healthy = true;
    at(now);
    await ask();
    expect(states()).toEqual([]);
  });

  it('openrouter/free is a valid route: the same request is answered when the account allows it, and one failed request is not repeated by a Test press or a probe', async () => {
    only(orId);
    network({ 'openrouter.ai': () => err(429, 'Provider returned error') });
    const row = getProvider(orId)!;
    await runProviderTest(row); // a Test press is ONE request (it used to be two: the 429, then a retry that met the policy refusal)
    expect(counts['openrouter.ai']).toBe(1);
    network({ 'openrouter.ai': () => err(500, 'upstream exploded') });
    resetAiRouterForTests();
    await runProviderTest(row);
    expect(counts['openrouter.ai']).toBe(1);
    network({ 'openrouter.ai': () => err(500, 'upstream exploded') });
    resetAiRouterForTests();
    await ask().catch(() => undefined); // a customer request whose ONLY route failed keeps its single quick retry
    expect(counts['openrouter.ai']).toBe(2);
  });
});

describe('Gemini: what the "10:00" reset is, and what is never repeated during it', () => {
  it('a daily quota is paused until the provider\'s DOCUMENTED reset (midnight Pacific) — stored and shown as documented, not as a stated timestamp and not as an estimate', async () => {
    only(gemId);
    network({ 'generativelanguage.googleapis.com': () => gemDaily() });
    await ask().catch(() => undefined);
    const s = states()[0]!;
    expect(s).toMatchObject({ scope: 'provider', category: 'rate_limited', known: 2 });
    expect(s.ms).toBeGreaterThan(MIN);
    expect(s.ms).toBeLessThanOrEqual(24 * 60 * MIN);
    const reset = new Date(T0 + s.ms);
    expect(reset.getUTCMinutes()).toBe(0);
    expect([7, 8]).toContain(reset.getUTCHours()); // 00:00 in Pacific time (UTC-7 or UTC-8)
    stamp();
    const health = providerHealth(getProvider(gemId)!);
    expect(health.cooldown).toMatchObject({ resetKnown: true, basis: 'documented' });
    expect(health.summary).toMatch(/daily reset/);
    expect(health.detail).toMatch(/documented daily reset/);
    expect(health.detail).toMatch(/carries no timestamp/);
  });

  it('a reset the response itself states is "stated"; a pause with no reset information is an ESTIMATE — and the longer pause keeps its own basis when a sibling failure arrives', async () => {
    only(gemId);
    network({ 'generativelanguage.googleapis.com': () => json(429, { error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] }, { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '45s' }] } }) });
    await ask().catch(() => undefined);
    expect(states()[0]).toMatchObject({ known: 1 });
    resetAiRouterForTests();
    network({ 'generativelanguage.googleapis.com': () => gem503() });
    await ask().catch(() => undefined);
    expect(states()[0]).toMatchObject({ category: 'provider_error', known: 0, scope: 'route' });
    // Two models of one provider fail in the same message: the daily pause (documented, hours) is not shortened or relabelled by the second, shorter one.
    resetAiRouterForTests();
    getDb().prepare("UPDATE ai_providers SET models = 'gem-a,gem-b' WHERE id = ?").run(gemId);
    network({ 'generativelanguage.googleapis.com': (n) => (n === 1 ? gemDaily() : json(429, { error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } })) });
    await ask().catch(() => undefined);
    const provider = states().find((s) => s.scope === 'provider')!;
    expect(provider).toMatchObject({ known: 2, strikes: 1 });
    expect(provider.ms).toBeGreaterThan(30 * MIN);
  });

  it('503 "high demand" is an outage, not a quota: a short estimated route pause that doubles, ends on its own, and a success clears it', async () => {
    only(gemId);
    let up = false;
    network({ 'generativelanguage.googleapis.com': () => (up ? gemOk('Gemini answer') : gem503()) });
    await ask().catch(() => undefined);
    expect(states()[0]).toMatchObject({ category: 'provider_error', scope: 'route', known: 0, ms: MIN });
    at(MIN + 1000);
    await ask().catch(() => undefined);
    expect(states()[0]).toMatchObject({ strikes: 2, ms: 2 * MIN });
    up = true;
    at(4 * MIN);
    expect((await ask()).choices[0]!.message.content).toBe('Gemini answer');
    expect(states()).toEqual([]);
  });

  it('during a known daily pause nothing is sent: not by a customer request, not by the recovery probe, and not by the Test button — which says why; an ESTIMATED pause may still be tested (one request)', async () => {
    only(gemId);
    network({ 'generativelanguage.googleapis.com': () => gemDaily() });
    await ask().catch(() => undefined);
    const after = total();
    await ask().catch(() => undefined);
    at(MIN);
    expect((await probeRecoveredRoutes(Date.now(), getDb())).probed).toBe(0);
    const test = await runProviderTest(getProvider(gemId)!);
    expect(test).toMatchObject({ ok: false, skipped: true, category: 'cooldown' });
    expect(test.detail).toMatch(/Not tested/);
    expect(test.detail).toMatch(/documented daily reset/);
    expect(total()).toBe(after);
    // An estimate (no reset information) does not block a deliberate test.
    resetAiRouterForTests();
    network({ 'generativelanguage.googleapis.com': () => gem503() });
    await ask().catch(() => undefined);
    const beforeTest = counts['generativelanguage.googleapis.com'];
    const second = await runProviderTest(getProvider(gemId)!);
    expect(second.skipped).toBeUndefined();
    expect(counts['generativelanguage.googleapis.com']).toBe(beforeTest! + 1);
  });
});

describe('Groq takes over automatically, in order, without being moved to the front', () => {
  const sent = (): string[] => vi.mocked(sendTextMessage).mock.calls.map((c) => String(c[1]));
  let counter = 0;
  async function customerSays() {
    const waId = `1555666${String(++counter).padStart(4, '0')}`;
    setCustomerLanguage(getOrCreateCustomer(waId, 'Sam').id, 'en');
    await processInboundMessage({ waId, messageId: `wamid.dg${counter}`, timestamp: Date.now(), type: 'text', text: 'Do you open on Fridays?', contactName: 'Sam' } as never, { knowledge });
    return waId;
  }

  it('OpenRouter (policy) and Gemini (daily quota) rest → the customer is answered by Groq ONCE without either resting provider being called; order and priorities are untouched', async () => {
    network({ 'openrouter.ai': () => err(404, POLICY), 'generativelanguage.googleapis.com': () => gemDaily(), 'api.groq.com': () => chatOk('Groq answer.') });
    await customerSays(); // OpenRouter refuses, Gemini is out of quota, Groq answers
    expect(sent()).toEqual(['Groq answer.']);
    expect(counts['api.groq.com']).toBe(1);
    const afterFirst = { or: counts['openrouter.ai'], gem: counts['generativelanguage.googleapis.com'] };
    await customerSays();
    expect(sent()).toEqual(['Groq answer.', 'Groq answer.']);
    expect(counts['openrouter.ai']).toBe(afterFirst.or); // both are resting: the second customer's answer does not touch them
    expect(counts['generativelanguage.googleapis.com']).toBe(afterFirst.gem);
    const plan = await runWithAccount(account, () => buildCandidates(account, 'chat', { wantsTools: true }));
    expect(plan.eligible.map((c) => c.providerName)).toEqual(['Groq']);
    expect(plan.skipped.filter((s) => s.category === 'cooldown').map((s) => s.candidate.providerName).sort()).toEqual(['Gemini', 'OpenRouter']);
    expect(getProvider(orId)!.priority).toBe(10);
    expect(getProvider(gemId)!.priority).toBe(100);
    expect(getProvider(groqId)!.priority).toBe(110);
  });

  it('when the earlier providers recover the order is OpenRouter → Gemini → Groq again, and an unconfirmed Groq is never used', async () => {
    network({ 'openrouter.ai': () => err(404, POLICY), 'generativelanguage.googleapis.com': () => gemDaily(), 'api.groq.com': () => chatOk('Groq answer.') });
    await customerSays();
    at(26 * 60 * MIN); // past the daily reset and every estimate
    const plan = await runWithAccount(account, () => buildCandidates(account, 'chat', { wantsTools: true }));
    expect(plan.eligible.map((c) => c.providerName)).toEqual(['OpenRouter', 'Gemini', 'Groq']);
    getDb().prepare('UPDATE ai_providers SET free_confirmed = 0 WHERE id = ?').run(groqId);
    resetAiRouterForTests();
    network({ 'openrouter.ai': () => err(429, 'Provider returned error'), 'generativelanguage.googleapis.com': () => gemDaily(), 'api.groq.com': () => chatOk('Groq must not be called') });
    await ask().catch(() => undefined);
    expect(counts['api.groq.com']).toBeUndefined();
  });
});
