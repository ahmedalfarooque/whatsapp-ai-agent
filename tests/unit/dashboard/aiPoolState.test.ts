import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '../../../src/memory/db';
import { env } from '../../../src/config/env';
import { createAccount } from '../../../src/accounts/accountRepo';
import { getAiState } from '../../../src/dashboard/overview';
import { describeRouteFailure, legacyRouteInUse, sanitizeProviderReason } from '../../../src/dashboard/aiPoolState';
import { createProvider, setProviderFreeConfirmed } from '../../../src/llm/providerRepo';
import { refreshProviderHealth, resetProviderHealthForTests } from '../../../src/llm/aiProviderHealth';
import { resetAiRouterForTests } from '../../../src/llm/aiRouter';
import { updateBusinessSettings } from '../../../src/config/businessSettings';

/**
 * The dashboard's AI status for businesses served by configured providers: from the routes and the router's own history,
 * never from the legacy built-in key slot alone, and with the real failure category in the wording.
 */
const mutableEnv = env as unknown as Record<string, unknown>;
const SHARED_KEY = 'sk-or-v1-sharedsharedsharedsharedsharedshared00000000000000';
const GROQ = 'gsk_groqgroqgroqgroqgroqgroqgroqgroq000000000';
const NOW = Date.parse('2026-10-18T12:00:00Z');
const HOUR = 3_600_000;
const at = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const originalMock = mutableEnv.shouldUseMockProviders;
const originalKey = mutableEnv.OPENROUTER_API_KEY;

let A1: number; let A2: number; let A3: number;

function logRow(providerId: number | null, name: string, model: string, outcome: 'ok' | 'failed', category: string | null, http: number | null, detail: string | null, atMs: number, account = A1): void {
  getDb().prepare('INSERT INTO ai_route_log (whatsapp_account_id, task, provider_id, provider_name, model, outcome, category, http_status, latency_ms, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(account, 'chat', providerId, name, model, outcome, category, http, 100, detail, at(atMs));
}

function sharedOpenRouter(): number {
  return createProvider({ name: 'OpenRouter', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: SHARED_KEY, models: ['openrouter/free'], priority: 10 }, { accountId: null, updatedBy: 1 }).id;
}

/** The legacy built-in key slot holds something OpenRouter rejects (as in production), and the application has noticed. */
async function legacyKeyRejected(): Promise<void> {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));
  await refreshProviderHealth();
  vi.unstubAllGlobals();
}

beforeAll(() => {
  getDb();
  A1 = 1;
  A2 = createAccount({ name: 'Pool Two' }).id;
  A3 = createAccount({ name: 'Pool Three' }).id;
});
beforeEach(() => {
  mutableEnv.shouldUseMockProviders = false;
  mutableEnv.OPENROUTER_API_KEY = 'env-key-0123456789abcdef';
  getDb().prepare('DELETE FROM ai_providers').run();
  getDb().prepare('DELETE FROM ai_route_log').run();
  getDb().prepare('DELETE FROM ai_route_cooldowns').run();
  resetProviderHealthForTests();
  resetAiRouterForTests();
  for (const id of [A1, A2, A3]) updateBusinessSettings({ aiFreeOnly: true }, id); // the production rule
});
afterEach(() => {
  mutableEnv.shouldUseMockProviders = originalMock;
  mutableEnv.OPENROUTER_API_KEY = originalKey;
  vi.unstubAllGlobals();
});

describe('the legacy key slot does not decide the status of a business served by providers', () => {
  it('an invalid legacy key with a healthy shared provider: AI active, the legacy slot is named inactive, nothing says "key rejected"', async () => {
    const id = sharedOpenRouter();
    logRow(id, 'OpenRouter', 'openrouter/free', 'ok', null, null, null, NOW - 20 * 60_000);
    await legacyKeyRejected();
    for (const account of [A1, A2, A3]) {
      const s = getAiState(account, NOW);
      expect(s).toMatchObject({ state: 'active', label: 'AI active', verified: true });
      expect(s.detail).toContain('OpenRouter · openrouter/free answered');
      expect(s.detail).toMatch(/Legacy OpenRouter key slot: rejected \(HTTP 401\), inactive/);
      expect(s.label).not.toMatch(/key rejected/i);
    }
  });

  it('the shared provider rate-limited on its daily free quota while the legacy key is invalid: the real cause, not "key rejected"', async () => {
    const id = sharedOpenRouter();
    logRow(id, 'OpenRouter', 'openrouter/free', 'failed', 'rate_limited', 429, 'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day', NOW - 5 * 60_000);
    await legacyKeyRejected();
    const s = getAiState(A1, NOW);
    expect(s).toMatchObject({ state: 'error', label: 'AI free quota reached' });
    expect(s.detail).toContain('HTTP 429');
    expect(s.detail).toContain('nothing is purchased');
    expect(s.detail).toMatch(/Legacy OpenRouter key slot: rejected/);
  });

  it('a business with no provider at all keeps the legacy evaluation exactly (a rejected built-in key IS reported there)', async () => {
    await legacyKeyRejected();
    expect(getAiState(A1, NOW)).toMatchObject({ state: 'error', label: 'AI key rejected' });
    expect(legacyRouteInUse(A1)).toBe(true);
  });

  it('no network call is made to render the status, and a pool-served business triggers no legacy check', async () => {
    sharedOpenRouter();
    const spy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', spy);
    getAiState(A1, NOW);
    expect(spy).not.toHaveBeenCalled();
    expect(legacyRouteInUse(A1)).toBe(false);
  });
});

describe('what the dashboard says for each real failure category', () => {
  const failure = (category: string, http: number | null, detail: string | null) => {
    const id = sharedOpenRouter();
    logRow(id, 'OpenRouter', 'openrouter/free', 'failed', category, http, detail, NOW - 60_000);
    return getAiState(A1, NOW);
  };

  it.each([
    ['auth', 401, 'bad key', 'AI key rejected', /rejected its API key \(HTTP 401\)/],
    ['auth', 403, null, 'AI key rejected', /\(HTTP 403\)/],
    ['rate_limited', 429, 'Too many requests, slow down', 'AI rate limit reached', /too many requests/],
    ['rate_limited', 429, 'Rate limit exceeded: free-models-per-day', 'AI free quota reached', /daily free allowance used up/],
    ['credit', 402, 'Prompt tokens limit exceeded', 'AI credits exhausted', /credit or free allowance exhausted/],
    ['model_unavailable', 404, 'model not found', 'AI model unavailable', /HTTP 404/],
    ['policy', 404, 'guardrail restrictions and data policy', 'AI request rejected by provider policy', /data policy/],
    ['capability', 404, 'does not support tools', 'AI model lacks a needed capability', /tools/],
    ['empty', 200, null, 'AI returned an unusable response', /an empty answer/],
    ['malformed', 200, null, 'AI returned an unusable response', /unreadable/],
    ['timeout', null, 'timeout', 'AI provider temporarily unavailable', /timeout/],
    ['provider_error', 503, 'overloaded', 'AI provider temporarily unavailable', /HTTP 503/],
  ])('%s (HTTP %s) → "%s"', (category, http, reason, label, detail) => {
    const s = failure(category, http, reason);
    expect(s).toMatchObject({ state: 'error', label });
    expect(s.detail).toMatch(detail);
  });

  it('HTTP 404 is not always a model problem: a web page answering is reported as a wrong address, and a policy 404 as a policy rejection', () => {
    expect(describeRouteFailure({ category: 'model_unavailable', http_status: 404, detail: '<!DOCTYPE html><html lang="en"><head>', provider_name: 'Grok', model: 'x' }).label).toBe('AI provider address is not an API');
    expect(describeRouteFailure({ category: 'policy', http_status: 404, detail: 'data policy', provider_name: 'OpenRouter', model: 'x' }).label).toBe('AI request rejected by provider policy');
    expect(describeRouteFailure({ category: 'model_unavailable', http_status: 404, detail: 'no such model', provider_name: 'OpenRouter', model: 'x' }).label).toBe('AI model unavailable');
  });

  it('a prompt that is too long for one model is not an account-level failure (it is ignored, nothing is reported)', () => {
    const id = sharedOpenRouter();
    logRow(id, 'OpenRouter', 'openrouter/free', 'failed', 'context', 400, 'context length exceeded', NOW - 60_000);
    expect(getAiState(A1, NOW)).toMatchObject({ state: 'active' });
  });
});

describe('routes, failover and business isolation', () => {
  it('no eligible free provider: a non-OpenRouter provider whose free tier is unconfirmed is named as the reason', () => {
    mutableEnv.OPENROUTER_API_KEY = 'x'; // no usable legacy key either: the built-in route does not participate
    getDb().prepare("DELETE FROM ai_providers").run();
    createProvider({ name: 'Groq', kind: 'openai_compatible', adapter: 'openai', vendor: 'groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: GROQ, models: ['openai/gpt-oss-20b'], freeConfirmed: false }, { accountId: null, updatedBy: 1 });
    const s = getAiState(A1, NOW);
    expect(s).toMatchObject({ state: 'error', label: 'No available free route' });
    expect(s.detail).toContain('Groq: free tier not confirmed');
    // confirming it makes the route eligible: configured, nothing confirmed yet
    const id = (getDb().prepare('SELECT id FROM ai_providers').get() as { id: number }).id;
    setProviderFreeConfirmed(id, A1, true, 1);
    expect(getAiState(A1, NOW)).toMatchObject({ state: 'active', verified: false });
  });

  it('disabled and key-less providers are listed as the reason, never as a key rejection', () => {
    const id = sharedOpenRouter();
    getDb().prepare('UPDATE ai_providers SET enabled = 0 WHERE id = ?').run(id);
    const s = getAiState(A1, NOW);
    expect(s).toMatchObject({ state: 'error', label: 'No available free route' });
    expect(s.detail).toContain('OpenRouter: turned off');
  });

  it('failover is healthy: one route failed, another answered → AI active, the failure is mentioned', () => {
    const a = sharedOpenRouter();
    const b = createProvider({ name: 'Groq', kind: 'openai_compatible', adapter: 'openai', vendor: 'groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: GROQ, models: ['openai/gpt-oss-20b'], priority: 20 }, { accountId: null, updatedBy: 1 }).id;
    logRow(b, 'Groq', 'openai/gpt-oss-20b', 'ok', null, null, null, NOW - 30 * 60_000);
    logRow(a, 'OpenRouter', 'openrouter/free', 'failed', 'rate_limited', 429, 'free-models-per-day', NOW - 5 * 60_000);
    const s = getAiState(A1, NOW);
    expect(s).toMatchObject({ state: 'active', label: 'AI active', verified: true });
    expect(s.detail).toContain('Groq · openai/gpt-oss-20b answered');
    expect(s.detail).toContain('AI free quota reached');
  });

  it('a shared provider has ONE status for every business (whoever triggered the failure); a business\'s own provider affects only that business', () => {
    const shared = sharedOpenRouter();
    logRow(shared, 'OpenRouter', 'openrouter/free', 'failed', 'rate_limited', 429, 'free-models-per-day', NOW - 60_000, A2); // seen by business 2's traffic
    const own = createProvider({ name: 'Own Groq', kind: 'openai_compatible', adapter: 'openai', vendor: 'groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: GROQ, models: ['openai/gpt-oss-20b'], priority: 50 }, { accountId: A3, updatedBy: 1 }).id;
    logRow(own, 'Own Groq', 'openai/gpt-oss-20b', 'ok', null, null, null, NOW - 30 * 60_000, A3);
    expect(getAiState(A1, NOW)).toMatchObject({ state: 'error', label: 'AI free quota reached' });
    expect(getAiState(A2, NOW)).toMatchObject({ state: 'error', label: 'AI free quota reached' });
    expect(getAiState(A3, NOW)).toMatchObject({ state: 'active', label: 'AI active' });
    expect(getAiState(A1, NOW).detail).not.toContain('Own Groq');
  });

  it('evidence older than 24 hours is not held against a route: configured, nothing confirmed yet', () => {
    const id = sharedOpenRouter();
    logRow(id, 'OpenRouter', 'openrouter/free', 'failed', 'rate_limited', 429, 'free-models-per-day', NOW - 30 * HOUR);
    expect(getAiState(A1, NOW)).toMatchObject({ state: 'active', verified: false });
  });

  it('the Default entry switched off for a business leaves it with no route, said plainly', () => {
    sharedOpenRouter();
    getDb().prepare("UPDATE ai_account_routing SET enabled = 0 WHERE whatsapp_account_id = ? AND entry_key = 'default'").run(A2);
    expect(getAiState(A2, NOW)).toMatchObject({ state: 'error', label: 'No available free route' });
    expect(getAiState(A1, NOW).state).not.toBe('error');
  });
});

describe('no secret leakage', () => {
  it('provider wording is cleaned: key-like tokens, HTML pages and long text never reach the dashboard', async () => {
    expect(sanitizeProviderReason(`bad key ${GROQ} and sk-or-v1-abcdefghijklmnopqrstuvwxyz`)).toBe('bad key [key] and [key]');
    expect(sanitizeProviderReason('<html><body>secret page</body></html>')).toBe('the address answered a web page, not an API');
    expect(sanitizeProviderReason('x'.repeat(500)).length).toBeLessThanOrEqual(120);
    const id = sharedOpenRouter();
    logRow(id, 'OpenRouter', 'openrouter/free', 'failed', 'auth', 401, `provider echoed ${SHARED_KEY}`, NOW - 60_000);
    await legacyKeyRejected();
    const json = JSON.stringify(getAiState(A1, NOW));
    expect(json).not.toContain(SHARED_KEY);
    expect(json).not.toContain(GROQ);
    expect(json).not.toContain('env-key-0123456789abcdef');
  });
});

describe('every route failing', () => {
  it('names the situation and every route\'s own reason instead of one generic line', () => {
    const a = sharedOpenRouter();
    const b = createProvider({ name: 'Gemini', kind: 'openai_compatible', adapter: 'gemini', vendor: 'google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'AIzaSyGeminiGeminiGeminiGeminiGemini000000', models: ['gemini-2.5-flash'], priority: 100 }, { accountId: null, updatedBy: 1 }).id;
    logRow(a, 'OpenRouter', 'openrouter/free', 'failed', 'rate_limited', 429, 'Rate limit exceeded: free-models-per-day', NOW - 60_000);
    logRow(b, 'Gemini', 'gemini-2.5-flash', 'failed', 'model_unavailable', 404, 'This model is no longer available to new users', NOW - 120_000, A1);
    const s = getAiState(A1, NOW);
    expect(s.state).toBe('error');
    expect(s.label).toBe('No provider is answering — AI free quota reached');
    expect(s.detail).toContain('Gemini · gemini-2.5-flash: AI model unavailable');
  });
});