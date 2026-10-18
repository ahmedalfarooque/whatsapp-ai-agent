import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/config/env', async () => {
  const actual = await vi.importActual<typeof import('../../../src/config/env')>('../../../src/config/env');
  return { ...actual, env: { ...actual.env, shouldUseMockProviders: false, OPENROUTER_FALLBACK_MODELS: '', AI_ROUTING_BUDGET_MS: 6000, AI_ROUTE_MAX_ATTEMPTS: 4 } };
});

import { env } from '../../../src/config/env';
import { getDb } from '../../../src/memory/db';
import { createAccount } from '../../../src/accounts/accountRepo';
import { runWithAccount } from '../../../src/accounts/accountContext';
import { allowUnknownPriceForTests, buildCandidates, resetAiRouterForTests, routeCompletion } from '../../../src/llm/aiRouter';
import { createProvider } from '../../../src/llm/providerRepo';
import { setModelCatalogForTests } from '../../../src/llm/modelCatalog';
import { probeRecoveredRoutes, PROBE_INTERVAL_MS, MAX_PER_PASS, resetRouteProbesForTests } from '../../../src/llm/routeProbe';

const mutableEnv = env as unknown as Record<string, unknown>;
const KEY = 'gsk_groqgroqgroqgroqgroqgroqgroqgroq000000000';
const ok = () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }] }), text: async () => '' });
const quota = () => ({ ok: false, status: 402, headers: new Headers(), json: async () => ({ error: { message: 'You exceeded your current quota' } }), text: async () => '{"error":{"message":"You exceeded your current quota"}}' });
const ask = () => routeCompletion({ task: 'chat', messages: [{ role: 'user', content: 'hi' }], maxTokens: 8, temperature: 0, deadline: Date.now() + 5000 });
const originalKey = mutableEnv.OPENROUTER_API_KEY;

let acc: number;
let providerId: number;

beforeEach(() => {
  getDb();
  getDb().prepare('DELETE FROM ai_providers').run();
  getDb().prepare('DELETE FROM ai_route_log').run();
  acc = createAccount({ name: `Probe Co ${Math.random()}` }).id;
  providerId = createProvider({ name: 'Groq', kind: 'openai_compatible', baseUrl: 'https://api.groq.com/openai/v1', apiKey: KEY, models: ['llama-3.3-70b-versatile'], priority: 10, timeoutMs: 3000 }, { accountId: null, updatedBy: 1 }).id;
  setModelCatalogForTests([]);
  allowUnknownPriceForTests(false);
  resetAiRouterForTests();
  resetRouteProbesForTests();
  mutableEnv.OPENROUTER_API_KEY = '';
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  mutableEnv.OPENROUTER_API_KEY = originalKey;
});

describe('recovery after a cooldown', () => {
  it('a route is skipped while cooling and eligible again once the cooldown has passed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => quota()));
    await expect(runWithAccount(acc, ask)).rejects.toBeTruthy();
    const during = await runWithAccount(acc, () => buildCandidates(acc, 'chat', { wantsTools: false }));
    expect(during.eligible).toHaveLength(0);
    expect(during.skipped[0]?.category).toBe('cooldown');
    const later = await runWithAccount(acc, () => buildCandidates(acc, 'chat', { wantsTools: false, now: Date.now() + 31 * 60_000 }));
    expect(later.eligible).toHaveLength(1);
  });
});

describe('bounded recovery probes', () => {
  it('probes a route that failed and whose cooldown ended, once, and a success makes it normal again', async () => {
    const fetchSpy = vi.fn(async () => quota());
    vi.stubGlobal('fetch', fetchSpy);
    await expect(runWithAccount(acc, ask)).rejects.toBeTruthy();
    const calls = fetchSpy.mock.calls.length;

    const t = Date.now() + 31 * 60_000;
    fetchSpy.mockImplementation(async () => ok());
    expect((await probeRecoveredRoutes(t)).probed).toBe(1);
    expect(fetchSpy.mock.calls.length).toBe(calls + 1);
    const last = getDb().prepare("SELECT outcome FROM ai_route_log WHERE provider_id = ? ORDER BY id DESC LIMIT 1").get(providerId) as { outcome: string };
    expect(last.outcome).toBe('ok');

    // healthy now: nothing more to probe
    expect((await probeRecoveredRoutes(t + PROBE_INTERVAL_MS + 1)).probed).toBe(0);
  });

  it('never probes more than once per interval, and a failed probe sets the cooldown again (no tight loop)', async () => {
    const fetchSpy = vi.fn(async () => quota());
    vi.stubGlobal('fetch', fetchSpy);
    await expect(runWithAccount(acc, ask)).rejects.toBeTruthy();
    const t = Date.now() + 31 * 60_000;
    const before = fetchSpy.mock.calls.length;
    expect((await probeRecoveredRoutes(t)).probed).toBe(1);
    expect(fetchSpy.mock.calls.length).toBe(before + 1);
    // still failing: cooling again, and within the interval nothing is called
    expect((await probeRecoveredRoutes(t + 1000)).probed).toBe(0);
    expect((await probeRecoveredRoutes(t + PROBE_INTERVAL_MS - 1)).probed).toBe(0);
    expect(fetchSpy.mock.calls.length).toBe(before + 1);
  });

  it('does nothing for a route that never failed, and respects the per-pass bound', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok()));
    expect((await probeRecoveredRoutes()).probed).toBe(0);
    expect(MAX_PER_PASS).toBeLessThanOrEqual(2);
  });

  it('never probes a provider whose free tier is not confirmed (strict free-only mode)', async () => {
    getDb().prepare('UPDATE ai_providers SET free_confirmed = 0 WHERE id = ?').run(providerId);
    const fetchSpy = vi.fn(async () => ok());
    vi.stubGlobal('fetch', fetchSpy);
    getDb().prepare("INSERT INTO ai_route_log (whatsapp_account_id, task, provider_id, provider_name, model, outcome, category, latency_ms) VALUES (?, 'chat', ?, 'Groq', 'llama-3.3-70b-versatile', 'failed', 'credit', 10)").run(acc, providerId);
    expect((await probeRecoveredRoutes(Date.now() + 31 * 60_000)).probed).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
