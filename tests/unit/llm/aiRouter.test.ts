import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/config/env', async () => {
  const actual = await vi.importActual<typeof import('../../../src/config/env')>('../../../src/config/env');
  return { ...actual, env: { ...actual.env, shouldUseMockProviders: false, OPENROUTER_FALLBACK_MODELS: '', OLLAMA_BASE_URL: '', OLLAMA_MODELS: '', AI_ROUTING_BUDGET_MS: 6000, AI_ROUTE_MAX_ATTEMPTS: 4 } };
});

import { env } from '../../../src/config/env';
import { getDb } from '../../../src/memory/db';
import { createAccount } from '../../../src/accounts/accountRepo';
import { runWithAccount } from '../../../src/accounts/accountContext';
import { getBusinessSettings, updateBusinessSettings } from '../../../src/config/businessSettings';
import { chatCompletion } from '../../../src/llm/openRouterClient';
import { AiResponseError } from '../../../src/llm/aiResponseError';
import { AiCredentialError } from '../../../src/llm/aiCredentialError';
import { setModelCatalogForTests, type ModelInfo } from '../../../src/llm/modelCatalog';
import { DEFAULT_ENTRY, providerEntryKey, saveAccountRouting } from '../../../src/llm/routingOrder';
import { allowUnknownPriceForTests, buildCandidates, classifyRouteFailure, explainRoutes, resetAiRouterForTests, routeCompletion } from '../../../src/llm/aiRouter';
import { createProvider, listProvidersForAccount, providerApiKey, toView } from '../../../src/llm/providerRepo';
import { listRouteLog, routeStats } from '../../../src/llm/routeLog';

/**
 * The AI routing layer with the real client code and a scripted network. Every scenario the owner asked for is isolated here:
 * OpenRouter quota exhaustion and immediate failover, several providers and keys in priority order, strict free-only enforcement
 * (paid routes rejected, fail-closed on an unknown price), privacy-restricted / unsupported / unreachable routes, a local model that
 * times out or is offline, every route failing without a message being lost, duplicate side effects, Arabic and English messages
 * crossing the failover unchanged, account isolation and key secrecy, and the routing time bound.
 */
const mutableEnv = env as unknown as Record<string, unknown>;
const ORK = 'sk-or-v1-routerrouterrouterrouterrouterrouter0000000';
const GROQ_KEY = 'gsk_groqgroqgroqgroqgroqgroqgroqgroq000000000';
const GEMINI_KEY = 'AIzaSyGeminiGeminiGeminiGeminiGemini000000';
const PAID = 'openai/gpt-4.1-mini';
const FREE_OR = 'google/gemma-4-31b-it:free';
const CATALOG: ModelInfo[] = [
  { id: PAID, free: false, image: true, audio: false, tools: true, contextLength: 1_000_000 },
  { id: FREE_OR, free: true, image: true, audio: false, tools: true, contextLength: 262_144 },
];
const ok = (text: string) => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }] }), text: async () => '' });
const fail = (status: number, message: string, headers: Record<string, string> = {}) => ({ ok: false, status, headers: new Headers(headers), json: async () => ({ error: { message } }), text: async () => JSON.stringify({ error: { message } }) });
const CAP_402 = 'Prompt tokens limit exceeded: 7335 > 5458. To increase, visit https://openrouter.ai/settings/credits';
const ZDR_404 = '0 endpoints out of 1 requested are available matching your guardrail restrictions and data policy. ZDR violation (account setting)';
const urlOf = (call: unknown[]): string => String(call[0]);
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body)) as { model: string; messages: Array<{ role: string; content: unknown }>; tools?: unknown[] };
const authOf = (call: unknown[]): string => String(((call[1] as RequestInit).headers as Record<string, string>).Authorization ?? '');

let ACC: number;
let fetchSpy: ReturnType<typeof vi.fn>;
let providerIds: Record<string, number> = {};
const originalKey = mutableEnv.OPENROUTER_API_KEY;

/** Routes fetch by host: each provider gets its own scripted answers. */
function network(script: Record<string, Array<() => unknown>>) {
  const counters: Record<string, number> = {};
  fetchSpy = vi.fn(async (url: string) => {
    const host = new URL(String(url)).host;
    const list = script[host];
    if (!list) throw Object.assign(new TypeError(`fetch failed: ${host}`), { name: 'TypeError' });
    const i = counters[host] ?? 0;
    counters[host] = i + 1;
    return list[Math.min(i, list.length - 1)]!();
  });
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}
const callsTo = (host: string) => fetchSpy.mock.calls.filter((c) => urlOf(c).includes(host));

beforeEach(() => {
  getDb();
  if (!ACC) {
    ACC = createAccount({ name: 'Router Test Co' }).id;
    providerIds = {
      groq: createProvider({ name: 'Groq free tier', kind: 'openai_compatible', baseUrl: 'https://api.groq.com/openai/v1', apiKey: GROQ_KEY, models: ['llama-3.3-70b-versatile'], priority: 10, freeTier: true, timeoutMs: 3000 }, { accountId: ACC, updatedBy: 1 }).id,
      gemini: createProvider({ name: 'Google AI Studio', kind: 'openai_compatible', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: GEMINI_KEY, models: ['gemini-2.5-flash-lite'], visionModels: ['gemini-2.5-flash-lite'], priority: 20, freeTier: true, timeoutMs: 3000 }, { accountId: ACC, updatedBy: 1 }).id,
      local: createProvider({ name: 'Local Ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', models: ['qwen2.5:1.5b-instruct-q4_K_M'], priority: 900, timeoutMs: 2500 }, { accountId: ACC, updatedBy: 1 }).id,
    };
  }
  runWithAccount(ACC, () => updateBusinessSettings({ openRouterModel: PAID, openRouterFallbackModels: FREE_OR, aiFreeOnly: true, aiFailoverEnabled: true }, ACC));
  for (const p of listProvidersForAccount(ACC)) getDb().prepare('UPDATE ai_providers SET enabled = 1 WHERE id = ?').run(p.id);
  // the business's saved order: its two free cloud providers first, then Default (the built-in OpenRouter key), then its own local runtime
  saveAccountRouting(ACC, [{ key: providerEntryKey(providerIds.groq) }, { key: providerEntryKey(providerIds.gemini) }, { key: DEFAULT_ENTRY }, { key: providerEntryKey(providerIds.local) }], 1);
  setModelCatalogForTests(CATALOG);
  allowUnknownPriceForTests(false); // the real rule: an unknown price is NOT free
  resetAiRouterForTests();
  mutableEnv.OPENROUTER_API_KEY = ORK;
});
afterEach(() => {
  vi.unstubAllGlobals();
  mutableEnv.OPENROUTER_API_KEY = originalKey;
  setModelCatalogForTests(null);
  allowUnknownPriceForTests(true);
});

const ask = (extra: Partial<Parameters<typeof chatCompletion>[0]> = {}) => runWithAccount(ACC, () => chatCompletion({ task: 'chat', messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'مرحبا، كم سعر التظليل؟' }], deadline: Date.now() + 6000, ...extra }));

describe('route order, free-only enforcement and the live plan', () => {
  it('orders routes by priority: the free providers first, then the built-in OpenRouter key (paid model REJECTED in strict mode, free one kept), then the local route; a text-only provider never gets pictures', async () => {
    const plan = await explainRoutes(ACC, 'chat');
    expect(plan.freeOnly).toBe(true);
    expect(plan.eligible.map((r) => `${r.providerName}/${r.model}`)).toEqual(['Groq free tier/llama-3.3-70b-versatile', 'Google AI Studio/gemini-2.5-flash-lite', `OpenRouter (built-in key)/${FREE_OR}`, 'Local Ollama/qwen2.5:1.5b-instruct-q4_K_M']);
    expect(plan.skipped.find((s) => s.route.model === PAID)).toMatchObject({ category: 'free_only', reason: expect.stringMatching(/costs money/) });
    expect(JSON.stringify(plan)).not.toMatch(/gsk_|AIza|sk-or-/); // the plan never carries a key
    const vision = await explainRoutes(ACC, 'vision');
    expect(vision.eligible.map((r) => r.providerName)).toEqual(['Google AI Studio', 'OpenRouter (built-in key)']); // Groq (no vision models) and the local route (no vision model) are not offered a picture
    expect([...vision.eligible, ...vision.skipped.map((s) => s.route)].some((r) => r.providerName === 'Groq free tier')).toBe(false); // a provider with no vision model is not even a candidate for pictures
  });

  it('FAIL-CLOSED: with the catalog unavailable the built-in OpenRouter models have an unknown price and are not used in strict mode; a provider declared PAID is never used either', async () => {
    setModelCatalogForTests(null);
    getDb().prepare('UPDATE ai_providers SET free_tier = 0 WHERE id = ?').run(providerIds.groq);
    const plan = await explainRoutes(ACC, 'chat');
    expect(plan.eligible.map((r) => r.providerName)).toEqual(['Google AI Studio', 'Local Ollama']);
    expect(plan.skipped.filter((s) => s.category === 'free_only').map((s) => s.route.providerName)).toEqual(expect.arrayContaining(['Groq free tier', 'OpenRouter (built-in key)']));
    expect(plan.skipped.find((s) => s.route.model === PAID)!.reason).toMatch(/price unknown — treated as paid/);
    getDb().prepare('UPDATE ai_providers SET free_tier = 1 WHERE id = ?').run(providerIds.groq);
  });

  it('with strict mode OFF the paid built-in model is eligible again (the administrator chose that)', async () => {
    runWithAccount(ACC, () => updateBusinessSettings({ aiFreeOnly: false }, ACC));
    const plan = await explainRoutes(ACC, 'chat');
    expect(plan.freeOnly).toBe(false);
    expect(plan.eligible.some((r) => r.model === PAID)).toBe(true);
  });
});

describe('failover', () => {
  it('OpenRouter quota exhaustion (402) on the only cloud key: the next eligible route answers at once, the same ARABIC messages are sent, and both attempts are logged with latency', async () => {
    getDb().prepare('UPDATE ai_providers SET enabled = 0 WHERE id IN (?, ?)').run(providerIds.groq, providerIds.gemini);
    network({ 'openrouter.ai': [() => fail(402, CAP_402)], '127.0.0.1:11434': [() => ok('التظليل يبدأ من 450 ريال')] });
    const result = await ask();
    expect(result.choices[0]!.message.content).toBe('التظليل يبدأ من 450 ريال');
    expect(result.servedBy).toMatchObject({ provider: 'Local Ollama', source: 'local', fallbackFrom: `OpenRouter (built-in key) · ${FREE_OR}`, fallbackReason: 'credit' });
    expect(callsTo('openrouter.ai')).toHaveLength(1); // a 402 is never retried
    expect(bodyOf(callsTo('127.0.0.1:11434')[0]!).messages).toEqual(bodyOf(callsTo('openrouter.ai')[0]!).messages);
    expect(authOf(callsTo('127.0.0.1:11434')[0]!)).toBe(''); // the local route gets no key
    const log = listRouteLog(ACC, 10);
    expect(log.map((l) => [l.provider_name, l.outcome, l.category])).toEqual([['Local Ollama', 'ok', null], ['OpenRouter (built-in key)', 'failed', 'credit']]);
    expect(log.every((l) => Number.isFinite(l.latency_ms) && l.latency_ms >= 0)).toBe(true);
    expect(JSON.stringify(log)).not.toMatch(/sk-or-|rules|مرحبا/); // never the key, the prompt or the customer's words
  });

  it('the local route receives the LEAN text-only request: the compact messages and no tool schemas, while a cloud route keeps the full prompt and the tools', async () => {
    getDb().prepare('UPDATE ai_providers SET enabled = 0 WHERE id IN (?, ?)').run(providerIds.groq, providerIds.gemini);
    network({ 'openrouter.ai': [() => fail(402, CAP_402)], '127.0.0.1:11434': [() => ok('lean answer')] });
    const tools = [{ type: 'function' as const, function: { name: 'search_catalogues', description: 'x', parameters: { type: 'object', properties: {} } } }];
    const result = await ask({ tools, compactMessages: [{ role: 'system', content: 'LEAN prompt' }, { role: 'user', content: 'مرحبا' }] } as never);
    expect(result.servedBy?.source).toBe('local');
    expect(bodyOf(callsTo('openrouter.ai')[0]!).tools).toBeDefined();
    expect(bodyOf(callsTo('openrouter.ai')[0]!).messages[0].content).toBe('rules');
    expect(bodyOf(callsTo('127.0.0.1:11434')[0]!).tools).toBeUndefined();
    expect(bodyOf(callsTo('127.0.0.1:11434')[0]!).messages[0].content).toBe('LEAN prompt');
  });

  it('several providers and keys: Groq rate limited (Retry-After honoured as its cooldown) → Google answers; the next message skips Groq without calling it', async () => {
    network({ 'api.groq.com': [() => fail(429, 'Rate limit reached', { 'retry-after': '120' })], 'generativelanguage.googleapis.com': [() => ok('Tinting starts at 450 SAR.')] });
    const first = await ask();
    expect(first.servedBy).toMatchObject({ provider: 'Google AI Studio', fallbackReason: 'rate_limited' });
    expect(authOf(callsTo('api.groq.com')[0]!)).toBe(`Bearer ${GROQ_KEY}`);
    expect(authOf(callsTo('generativelanguage.googleapis.com')[0]!)).toBe(`Bearer ${GEMINI_KEY}`);
    fetchSpy.mockClear();
    const second = await ask();
    expect(second.servedBy?.provider).toBe('Google AI Studio');
    expect(callsTo('api.groq.com')).toHaveLength(0); // cooling down: not even tried
    const plan = await explainRoutes(ACC, 'chat');
    expect(plan.skipped.find((s) => s.route.providerName === 'Groq free tier')).toMatchObject({ category: 'cooldown', reason: expect.stringMatching(/rate limited/) });
  });

  it('privacy restriction (OpenRouter ZDR 404), an unsupported model (404) and an unreachable provider (network) are each classified, skipped at once and the next route is tried', async () => {
    getDb().prepare('UPDATE ai_providers SET enabled = 0 WHERE id IN (?, ?)').run(providerIds.groq, providerIds.gemini);
    network({ 'openrouter.ai': [() => fail(404, ZDR_404)], '127.0.0.1:11434': [() => ok('local answer')] });
    const r1 = await ask();
    expect(r1.servedBy).toMatchObject({ provider: 'Local Ollama', fallbackReason: 'policy' });
    expect(classifyRouteFailure(new AiResponseError('model_unavailable', 404, FREE_OR, ZDR_404))).toBe('policy');
    expect(classifyRouteFailure(new AiResponseError('model_unavailable', 404, 'x/y', 'No endpoints found for x/y'))).toBe('model_unavailable');
    expect(classifyRouteFailure(new AiResponseError('model_unavailable', 400, 'x/y', 'This model does not support image input'))).toBe('capability');
    expect(classifyRouteFailure(new AiCredentialError('rejected', 'rejected', 401))).toBe('auth');
    resetAiRouterForTests();
    getDb().prepare('UPDATE ai_providers SET enabled = 1 WHERE id IN (?, ?)').run(providerIds.groq, providerIds.gemini);
    network({ 'generativelanguage.googleapis.com': [() => ok('gemini answer')] }); // Groq unreachable (no script → TypeError), OpenRouter unreachable too
    const r2 = await ask();
    expect(r2.servedBy).toMatchObject({ provider: 'Google AI Studio', fallbackReason: 'network' });
    expect(callsTo('api.groq.com')).toHaveLength(1); // no retry against an unreachable provider when another route exists
  });

  it('LOCAL model: a timeout is classified as such, the local route cools down longer, and a local runtime that is OFFLINE (connection refused) is skipped without stalling', async () => {
    getDb().prepare('UPDATE ai_providers SET enabled = 0 WHERE id IN (?, ?)').run(providerIds.groq, providerIds.gemini);
    getDb().prepare('UPDATE ai_providers SET timeout_ms = 2000 WHERE id = ?').run(providerIds.local);
    saveAccountRouting(ACC, [{ key: providerEntryKey(providerIds.local) }, { key: DEFAULT_ENTRY }], 1); // the business tries its local runtime first
    const started = Date.now();
    network({ '127.0.0.1:11434': [() => new Promise((_resolve, reject) => { setTimeout(() => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), 50); })], 'openrouter.ai': [() => ok('cloud answer')] });
    const r = await ask();
    expect(r.servedBy).toMatchObject({ provider: 'OpenRouter (built-in key)', fallbackReason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(3000);
    const plan = await explainRoutes(ACC, 'chat');
    expect(plan.skipped.find((s) => s.route.providerName === 'Local Ollama')).toMatchObject({ category: 'cooldown', reason: expect.stringMatching(/timeout/) });
    resetAiRouterForTests();
    network({ 'openrouter.ai': [() => ok('cloud answer')] }); // 127.0.0.1 not scripted = connection refused
    const r2 = await ask();
    expect(r2.servedBy).toMatchObject({ provider: 'OpenRouter (built-in key)', fallbackReason: 'network' });
    getDb().prepare('UPDATE ai_providers SET timeout_ms = 2500 WHERE id = ?').run(providerIds.local);
  });

  it('EVERY route fails: the error names the first cause, lists every attempt and why the rest were skipped, stays within the routing budget — the caller keeps the message (no exception is swallowed, nothing is lost)', async () => {
    network({ 'api.groq.com': [() => fail(429, 'Rate limit reached')], 'generativelanguage.googleapis.com': [() => fail(503, 'overloaded')], 'openrouter.ai': [() => fail(402, CAP_402)] }); // local: connection refused
    const started = Date.now();
    const e = (await ask().catch((err: unknown) => err)) as AiResponseError;
    expect(e).toBeInstanceOf(AiResponseError);
    expect(e.reason).toBe('rate_limited'); // the first route's failure is the headline
    expect(e.attempts.map((a) => a.reason)).toEqual(['rate_limited', 'provider_error', 'payment_required', 'provider_error']);
    expect(e.attempts).toHaveLength(4); // the 4-route limit for one message
    expect(e.describe()).toMatch(/also tried Google AI Studio[^;]*OpenRouter[^;]*Local Ollama/);
    expect(e.fallbackSkipped).toMatch(/strict free-only mode|costs money/);
    expect(Date.now() - started).toBeLessThan(6000);
    expect(fetchSpy).toHaveBeenCalledTimes(4); // one attempt per route, no serial retries against failing routes
  });

  it('with failover OFF only the first eligible route is tried', async () => {
    runWithAccount(ACC, () => updateBusinessSettings({ aiFailoverEnabled: false }, ACC));
    network({ 'api.groq.com': [() => fail(503, 'down')], 'generativelanguage.googleapis.com': [() => ok('never asked')] });
    await expect(ask()).rejects.toBeInstanceOf(AiResponseError);
    expect(callsTo('generativelanguage.googleapis.com')).toHaveLength(0);
    expect(callsTo('api.groq.com')).toHaveLength(2); // the only route it may use gets its one bounded retry
  });

  it('a failover inside a TOOL round carries the tool results to the next route: the tool is never re-run and the loop is never restarted', async () => {
    const toolRow = { role: 'tool' as const, tool_call_id: 'call_1', name: 'get_hours', content: '{"open":true}' };
    network({ 'api.groq.com': [() => fail(500, 'boom')], 'generativelanguage.googleapis.com': [() => ok('We are open until 6.')] });
    const r = await ask({ messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'open?' }, { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_hours', arguments: '{}' } }] }, toolRow] });
    expect(r.servedBy?.provider).toBe('Google AI Studio');
    const sent = bodyOf(callsTo('generativelanguage.googleapis.com')[0]!).messages as Array<{ role: string; tool_call_id?: string }>;
    expect(sent.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
  });

  it('a provider that cannot do tool calling is never given a request that offers tools (no silent degradation)', async () => {
    getDb().prepare('UPDATE ai_providers SET supports_tools = 0 WHERE id = ?').run(providerIds.groq);
    const plan = await buildCandidates(ACC, 'chat', { wantsTools: true });
    expect(plan.eligible.map((c) => c.providerName)).not.toContain('Groq free tier');
    expect(plan.skipped.find((s) => s.candidate.providerName === 'Groq free tier')).toMatchObject({ category: 'capability', reason: 'no tool calling' });
    getDb().prepare('UPDATE ai_providers SET supports_tools = 1 WHERE id = ?').run(providerIds.groq);
  });

  it('a missing key on every cloud route is a credential problem, not a model failure', async () => {
    mutableEnv.OPENROUTER_API_KEY = '';
    getDb().prepare('UPDATE ai_providers SET enabled = 0 WHERE id = ?').run(providerIds.local);
    getDb().prepare('UPDATE ai_providers SET key_ciphertext = NULL WHERE id IN (?, ?)').run(providerIds.groq, providerIds.gemini);
    await expect(ask()).rejects.toBeInstanceOf(AiCredentialError);
    // restore the keys for the other tests
    getDb().prepare('DELETE FROM ai_providers WHERE id IN (?, ?)').run(providerIds.groq, providerIds.gemini);
    providerIds.groq = createProvider({ name: 'Groq free tier', kind: 'openai_compatible', baseUrl: 'https://api.groq.com/openai/v1', apiKey: GROQ_KEY, models: ['llama-3.3-70b-versatile'], priority: 10, freeTier: true, timeoutMs: 3000 }, { accountId: ACC, updatedBy: 1 }).id;
    providerIds.gemini = createProvider({ name: 'Google AI Studio', kind: 'openai_compatible', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: GEMINI_KEY, models: ['gemini-2.5-flash-lite'], visionModels: ['gemini-2.5-flash-lite'], priority: 20, freeTier: true, timeoutMs: 3000 }, { accountId: ACC, updatedBy: 1 }).id;
  });
});

describe('account isolation and key management', () => {
  it('a provider of one business is invisible to another; a shared provider is visible to both; a brand-new business inherits the shared defaults (strict free-only, failover on) and nothing else', () => {
    const other = createAccount({ name: 'Other Router Co' }).id;
    expect(listProvidersForAccount(other).map((p) => p.name)).toEqual([]);
    const shared = createProvider({ name: 'Shared Groq', kind: 'openai_compatible', baseUrl: 'https://api.groq.com/openai/v1', apiKey: GROQ_KEY, models: ['llama-3.1-8b-instant'], priority: 5 }, { accountId: null, updatedBy: 1 });
    expect(listProvidersForAccount(other).map((p) => p.name)).toEqual(['Shared Groq']);
    expect(listProvidersForAccount(ACC).map((p) => p.name)).toContain('Shared Groq');
    const fresh = createAccount({ name: 'Fresh Router Co' }).id;
    expect(runWithAccount(fresh, () => getBusinessSettings(fresh))).toMatchObject({ aiFreeOnly: true, aiFailoverEnabled: true, openRouterFallbackModels: [] });
    getDb().prepare('DELETE FROM ai_providers WHERE id = ?').run(shared.id);
  });

  it('keys are stored encrypted, decrypt only for the request, and are returned to the dashboard masked', () => {
    const row = listProvidersForAccount(ACC).find((p) => p.id === providerIds.groq)!;
    expect(row.key_ciphertext).not.toContain('gsk_');
    expect(providerApiKey(row)).toBe(GROQ_KEY);
    const view = toView(row);
    expect(view.hasKey).toBe(true);
    expect(view.keyMasked).not.toContain(GROQ_KEY);
    expect(JSON.stringify(view)).not.toContain('gsk_groq');
  });

  it('the statistics are per business and real: counts and average latency come from the attempts recorded above', () => {
    const stats = routeStats(ACC, 24);
    expect(stats.totals.ok + stats.totals.failed).toBeGreaterThan(0);
    expect(stats.perRoute.some((r) => r.providerName === 'Google AI Studio' && r.ok >= 1)).toBe(true);
    const other = createAccount({ name: 'Quiet Router Co' }).id;
    expect(routeStats(other, 24).totals).toEqual({ ok: 0, failed: 0, avgLatencyMs: null });
  });
});

describe('the deterministic path and duplicates', () => {
  it('routeCompletion with no route at all (every provider disabled, no key, no local) fails fast with a clear reason, so the pipeline can send the automated choices', async () => {
    mutableEnv.OPENROUTER_API_KEY = '';
    for (const p of listProvidersForAccount(ACC)) getDb().prepare('UPDATE ai_providers SET enabled = 0 WHERE id = ?').run(p.id);
    const started = Date.now();
    const e = (await runWithAccount(ACC, () => routeCompletion({ task: 'chat', messages: [{ role: 'user', content: 'hi' }] })).catch((err: unknown) => err)) as Error;
    // every route is disabled or has no key: reported as a credential problem (staff must add a key or enable a provider), within milliseconds
    expect(e).toBeInstanceOf(AiCredentialError);
    expect((e as AiCredentialError).reason).toBe('missing');
    expect(Date.now() - started).toBeLessThan(500);
  });
});
describe('context limits and a crashing local runtime', () => {
  it('a "context length exceeded" refusal fails over at once to the next route WITHOUT cooling the first one down (a shorter prompt may fit it next time)', async () => {
    network({ 'api.groq.com': [() => fail(400, "This model's maximum context length is 8192 tokens. Please reduce the length of the messages."), () => ok('short answer')], 'generativelanguage.googleapis.com': [() => ok('gemini answer')] });
    expect(classifyRouteFailure(new AiResponseError('model_unavailable', 400, 'm', "This model's maximum context length is 8192 tokens"))).toBe('context');
    expect(classifyRouteFailure(new AiResponseError('payment_required', 402, 'm', CAP_402))).toBe('credit'); // the credit-derived cap stays a credit problem (the pipeline shrinks the prompt)
    const first = await ask();
    expect(first.servedBy).toMatchObject({ provider: 'Google AI Studio', fallbackReason: 'context' });
    const plan = await explainRoutes(ACC, 'chat');
    expect(plan.skipped.find((s) => s.route.providerName === 'Groq free tier')).toBeUndefined(); // not cooling down
    fetchSpy.mockClear();
    const second = await ask();
    expect(second.servedBy?.provider).toBe('Groq free tier'); // tried again first, and now answers
  });

  it('a local runtime that crashes (connection refused) is skipped within its cooldown, and once it is back (service restarted) the next window uses it again', async () => {
    getDb().prepare('UPDATE ai_providers SET enabled = 0 WHERE id IN (?, ?)').run(providerIds.groq, providerIds.gemini);
    saveAccountRouting(ACC, [{ key: providerEntryKey(providerIds.local) }, { key: DEFAULT_ENTRY }], 1);
    network({ 'openrouter.ai': [() => ok('cloud answer')] }); // local not scripted = refused
    const down = await ask();
    expect(down.servedBy).toMatchObject({ provider: 'OpenRouter (built-in key)', fallbackReason: 'network' });
    fetchSpy.mockClear();
    network({ '127.0.0.1:11434': [() => ok('local answer')], 'openrouter.ai': [() => ok('cloud answer')] });
    const stillCooling = await ask();
    expect(stillCooling.servedBy?.provider).toBe('OpenRouter (built-in key)'); // known-failing route is not retried
    expect(callsTo('127.0.0.1:11434')).toHaveLength(0);
    resetAiRouterForTests(); // the cooldown elapsed
    const back = await ask();
    expect(back.servedBy).toMatchObject({ provider: 'Local Ollama', source: 'local' });
  });
});
