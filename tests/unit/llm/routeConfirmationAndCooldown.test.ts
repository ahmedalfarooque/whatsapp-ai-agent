import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/config/env', async () => {
  const actual = await vi.importActual<typeof import('../../../src/config/env')>('../../../src/config/env');
  return { ...actual, env: { ...actual.env, shouldUseMockProviders: false, OPENROUTER_FALLBACK_MODELS: '', AI_ROUTING_BUDGET_MS: 6000, AI_ROUTE_MAX_ATTEMPTS: 4 } };
});

import { env } from '../../../src/config/env';
import { getDb } from '../../../src/memory/db';
import { createAccount } from '../../../src/accounts/accountRepo';
import { runWithAccount } from '../../../src/accounts/accountContext';
import { updateBusinessSettings } from '../../../src/config/businessSettings';
import { AiResponseError } from '../../../src/llm/aiResponseError';
import { allowUnknownPriceForTests, buildCandidates, coolingUntil, resetAiRouterForTests, routeCompletion } from '../../../src/llm/aiRouter';
import { createProvider, getProvider, setProviderFreeConfirmed, toView, updateProvider, type AiProviderInput } from '../../../src/llm/providerRepo';
import { setModelCatalogForTests } from '../../../src/llm/modelCatalog';
import { providerActivity } from '../../../src/llm/routeLog';
import { forCreate } from '../../../src/dashboard/aiRoutingRoutes';

const mutableEnv = env as unknown as Record<string, unknown>;
const GROQ_KEY = 'gsk_groqgroqgroqgroqgroqgroqgroqgroq000000000';
const GEMINI_KEY = 'AIzaSyGeminiGeminiGeminiGeminiGemini000000';
const ok = (text: string) => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }] }), text: async () => '' });
const fail = (status: number, message: string) => ({ ok: false, status, headers: new Headers(), json: async () => ({ error: { message } }), text: async () => JSON.stringify({ error: { message } }) });

const base = (over: Partial<AiProviderInput> = {}): AiProviderInput => ({ name: 'Groq', kind: 'openai_compatible', baseUrl: 'https://api.groq.com/openai/v1', apiKey: GROQ_KEY, models: ['llama-3.3-70b-versatile'], priority: 10, timeoutMs: 3000, ...over });
const ask = () => routeCompletion({ task: 'chat', messages: [{ role: 'user', content: 'hi' }], maxTokens: 8, temperature: 0, deadline: Date.now() + 5000 });

let acc: number;
const originalKey = mutableEnv.OPENROUTER_API_KEY;

beforeEach(() => {
  getDb();
  acc = createAccount({ name: `Confirm Co ${Math.random()}` }).id;
  getDb().prepare('DELETE FROM ai_providers WHERE whatsapp_account_id IS NULL').run();
  runWithAccount(acc, () => updateBusinessSettings({ aiFreeOnly: true, aiFailoverEnabled: true }, acc));
  setModelCatalogForTests([]);
  allowUnknownPriceForTests(false);
  resetAiRouterForTests();
  mutableEnv.OPENROUTER_API_KEY = '';
});
afterEach(() => {
  vi.unstubAllGlobals();
  mutableEnv.OPENROUTER_API_KEY = originalKey;
});

describe('free-tier confirmation', () => {
  it('a non-OpenRouter provider whose free tier is not confirmed is never routed under free-only mode, and says why', async () => {
    const row = createProvider(forCreate(base(), {}), { accountId: acc, updatedBy: 1 });
    expect(toView(row).freeConfirmed).toBe(false);
    const plan = await runWithAccount(acc, () => buildCandidates(acc, 'chat', { wantsTools: false }));
    expect(plan.eligible).toHaveLength(0);
    expect(plan.skipped.find((s) => s.candidate.providerId === row.id)?.reason).toMatch(/not confirmed/);
  });

  it('confirming makes it eligible; a changed endpoint resets the confirmation; unconfirming removes it again', async () => {
    const row = createProvider(forCreate(base(), {}), { accountId: acc, updatedBy: 1 });
    setProviderFreeConfirmed(row.id, acc, true, 1);
    expect((await runWithAccount(acc, () => buildCandidates(acc, 'chat', { wantsTools: false }))).eligible).toHaveLength(1);

    updateProvider(row.id, acc, base({ baseUrl: 'https://other.example.com/v1', apiKey: undefined }), 1);
    expect(toView(getProvider(row.id, acc)!).freeConfirmed).toBe(false);
    expect((await runWithAccount(acc, () => buildCandidates(acc, 'chat', { wantsTools: false }))).eligible).toHaveLength(0);

    setProviderFreeConfirmed(row.id, acc, true, 1);
    setProviderFreeConfirmed(row.id, acc, false, 1);
    expect((await runWithAccount(acc, () => buildCandidates(acc, 'chat', { wantsTools: false }))).eligible).toHaveLength(0);
  });

  it('the creation body may confirm explicitly; OpenRouter (priced from its public catalog) needs no confirmation', () => {
    expect(forCreate(base(), { freeConfirmed: true }).freeConfirmed).toBe(true);
    expect(forCreate(base(), { freeConfirmed: 'yes' }).freeConfirmed).toBe(false);
    expect(forCreate(base({ kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' }), {}).freeConfirmed).toBe(true);
  });
});

describe('persistent cooldowns and failover', () => {
  it('a quota failure fails over to the next confirmed provider and the exhausted one is not called again, even after the in-memory state is lost', async () => {
    const a = createProvider(base({ name: 'A', priority: 10 }), { accountId: null, updatedBy: 1 });
    const b = createProvider(base({ name: 'B', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: GEMINI_KEY, models: ['gemini-2.5-flash-lite'], priority: 20 }), { accountId: null, updatedBy: 1 });
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const host = new URL(String(url)).host;
      calls.push(host);
      return host.includes('groq') ? fail(402, 'You exceeded your current quota, please check your plan and billing details') : ok('hello');
    }));
    const first = await runWithAccount(acc, ask);
    expect(first.route.candidate.providerName).toBe('B');
    expect(calls).toEqual(['api.groq.com', 'generativelanguage.googleapis.com']);

    // simulate a process restart: memory is gone, the database still knows
    const row = getDb().prepare('SELECT COUNT(*) AS n FROM ai_route_cooldowns').get() as { n: number };
    expect(row.n).toBeGreaterThan(0);
    calls.length = 0;
    expect(coolingUntil(`provider:${a.id}`)).not.toBeNull();
    await runWithAccount(acc, ask);
    expect(calls).toEqual(['generativelanguage.googleapis.com']);
    expect(b.id).not.toBe(a.id);
  });

  it('when every provider fails the router stops after a bounded number of attempts and the next request does not call the cooling providers', async () => {
    createProvider(base({ name: 'A', priority: 10 }), { accountId: null, updatedBy: 1 });
    createProvider(base({ name: 'B', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: GEMINI_KEY, models: ['gemini-2.5-flash-lite'], priority: 20 }), { accountId: null, updatedBy: 1 });
    const fetchSpy = vi.fn(async () => fail(429, 'rate limit exceeded'));
    vi.stubGlobal('fetch', fetchSpy);
    await expect(runWithAccount(acc, ask)).rejects.toBeInstanceOf(AiResponseError);
    const afterFirst = fetchSpy.mock.calls.length;
    expect(afterFirst).toBeLessThanOrEqual(4);
    await expect(runWithAccount(acc, ask)).rejects.toBeTruthy();
    expect(fetchSpy.mock.calls.length).toBe(afterFirst); // everything is cooling down: no retry storm
  });

  it('the dashboard can show what the router observed for a provider (last answer, last failure category) and nothing invented', async () => {
    const a = createProvider(base({ name: 'A' }), { accountId: null, updatedBy: 1 });
    vi.stubGlobal('fetch', vi.fn(async () => fail(402, 'You exceeded your current quota')));
    await expect(runWithAccount(acc, ask)).rejects.toBeTruthy();
    const activity = providerActivity(a.id);
    expect(activity.lastOkAt).toBeNull();
    expect(activity.lastFailureCategory).toBe('credit');
  });
});
