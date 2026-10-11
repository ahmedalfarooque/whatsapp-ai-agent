import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { getDb } from '../../../src/memory/db';
import { env } from '../../../src/config/env';
import { setSecret } from '../../../src/config/secretStore';
import { createAdminUser } from '../../../src/dashboard/auth';
import { getAiState } from '../../../src/dashboard/overview';
import { createAccount } from '../../../src/accounts/accountRepo';
import { classifyModelResponse, classifyProviderResponse, ensureProviderHealth, getCachedModelHealth, getCachedProviderHealth, refreshModelHealth, refreshProviderHealth, resetProviderHealthForTests } from '../../../src/llm/aiProviderHealth';
import { updateBusinessSettings } from '../../../src/config/businessSettings';

const mutableEnv = env as unknown as Record<string, unknown>;
const KEY_A = 'sk-or-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const KEY_B = 'sk-or-v1-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const NOW = Date.parse('2026-10-11T12:00:00Z');
const at = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const HOUR = 3_600_000;
const MODEL = 'openai/gpt-4o-mini'; // what the test environment configures (OPENROUTER_MODEL)
const FAILED = `AI failed; fallback sent (empty response, HTTP 200, model ${MODEL})`;

let adminId: number;
const originalMock = mutableEnv.shouldUseMockProviders;
const originalKey = mutableEnv.OPENROUTER_API_KEY;

function fetchReturning(status: number) {
  const fn = vi.fn(async () => new Response('{}', { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

function activity(account: number, kind: 'ai' | 'error', detail: string, atMs: number): void {
  getDb().prepare('INSERT INTO reply_activity (channel, kind, detail, whatsapp_account_id, created_at) VALUES (?, ?, ?, ?, ?)').run('qr', kind, detail, account, at(atMs));
}

/** Saves a key the way the dashboard does, then pins when it was saved so the tests control the timeline. */
function saveKey(key: string, savedAtMs: number): void {
  setSecret('OPENROUTER_API_KEY', key, adminId);
  getDb().prepare("UPDATE credential_overrides SET updated_at = ? WHERE key = 'OPENROUTER_API_KEY'").run(at(savedAtMs));
}

beforeAll(() => {
  getDb();
  adminId = createAdminUser('ai-state-admin', 'a-very-long-test-password-123');
  expect(createAccount({ name: 'Second Business' }).id).toBe(2);
  expect(createAccount({ name: 'Third Business' }).id).toBe(3);
});

beforeEach(() => {
  mutableEnv.shouldUseMockProviders = false;
  mutableEnv.OPENROUTER_API_KEY = 'env-key-0123456789abcdef';
  getDb().prepare('DELETE FROM credential_overrides').run();
  getDb().prepare('DELETE FROM reply_activity').run();
  getDb().prepare('UPDATE business_settings SET open_router_model = NULL').run();
  resetProviderHealthForTests();
});

afterEach(() => {
  mutableEnv.shouldUseMockProviders = originalMock;
  mutableEnv.OPENROUTER_API_KEY = originalKey;
  vi.unstubAllGlobals();
});

describe('classifyProviderResponse', () => {
  it('maps provider answers to a health status', () => {
    expect(classifyProviderResponse(200)).toBe('ok');
    expect(classifyProviderResponse(401)).toBe('rejected');
    expect(classifyProviderResponse(403)).toBe('rejected');
    expect(classifyProviderResponse(429)).toBe('rate_limited');
    expect(classifyProviderResponse(502)).toBe('unreachable');
    expect(classifyProviderResponse(418)).toBe('unknown');
  });
});

describe('AI state is decided by the live provider check, not by old reply history', () => {
  it('mock providers and a missing key never reach the network', async () => {
    const fetchMock = fetchReturning(200);
    mutableEnv.shouldUseMockProviders = true;
    expect(await refreshProviderHealth()).toBeNull();
    expect(getAiState(1, NOW).state).toBe('mock');
    mutableEnv.shouldUseMockProviders = false;
    mutableEnv.OPENROUTER_API_KEY = 'x';
    expect(await refreshProviderHealth()).toBeNull();
    expect(getAiState(1, NOW)).toMatchObject({ state: 'needs_key', verified: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a key the provider confirms is shown as active AND verified', async () => {
    saveKey(KEY_A, NOW - 10 * HOUR);
    const fetchMock = fetchReturning(200);
    await refreshProviderHealth();
    expect(getAiState(1, NOW)).toMatchObject({ state: 'active', label: 'AI active', verified: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://openrouter.ai/api/v1/auth/key');
  });

  it('a key the provider rejects is shown as rejected for every account, with no secret in the answer', async () => {
    saveKey(KEY_A, NOW - 10 * HOUR);
    fetchReturning(401);
    await refreshProviderHealth();
    for (const account of [1, 2, 3]) {
      const state = getAiState(account, NOW);
      expect(state).toMatchObject({ state: 'error', label: 'AI key rejected', verified: false });
      expect(JSON.stringify(state)).not.toContain(KEY_A);
    }
  });

  it('failures recorded BEFORE the key was saved no longer mark the new key as rejected', async () => {
    // The owner's situation: errors from the old, malformed key are still inside the 24-hour window when the key is replaced.
    activity(2, 'error', 'AI credential problem (malformed): fallback sent.', NOW - 3 * HOUR);
    activity(2, 'error', FAILED, NOW - 2 * HOUR);
    saveKey(KEY_A, NOW - 1 * HOUR);
    fetchReturning(200);
    await refreshProviderHealth();
    expect(getAiState(2, NOW)).toMatchObject({ state: 'active', verified: true });
    // ...and even when the provider cannot be reached, those old failures are not held against the new key.
    resetProviderHealthForTests();
    fetchReturning(503);
    await refreshProviderHealth();
    expect(getAiState(2, NOW)).toMatchObject({ state: 'active', verified: false });
  });

  it('without a live verdict, a credential failure AFTER the key was saved is still reported', async () => {
    saveKey(KEY_A, NOW - 3 * HOUR);
    activity(1, 'error', 'AI credential problem (rejected): fallback sent.', NOW - 1 * HOUR);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await refreshProviderHealth();
    expect(getCachedProviderHealth(NOW)?.status).toBe('unreachable');
    expect(getAiState(1, NOW)).toMatchObject({ state: 'error', label: 'AI key rejected' });
  });

  it('a valid key whose latest reply failed says so, and a later success clears it', async () => {
    saveKey(KEY_A, NOW - 10 * HOUR);
    fetchReturning(200);
    await refreshProviderHealth();
    activity(1, 'error', FAILED, NOW - 2 * HOUR);
    expect(getAiState(1, NOW)).toMatchObject({ state: 'error', label: 'AI replies failing', verified: true });
    expect(getAiState(1, NOW).detail).toContain('empty response, HTTP 200');
    activity(1, 'ai', 'answered', NOW - 1 * HOUR);
    expect(getAiState(1, NOW)).toMatchObject({ state: 'active', verified: true });
  });

  it('one account failures never change another account', async () => {
    saveKey(KEY_A, NOW - 10 * HOUR);
    fetchReturning(200);
    await refreshProviderHealth();
    activity(2, 'error', FAILED, NOW - 1 * HOUR);
    expect(getAiState(2, NOW).label).toBe('AI replies failing');
    expect(getAiState(1, NOW)).toMatchObject({ state: 'active', label: 'AI active' });
    expect(getAiState(3, NOW)).toMatchObject({ state: 'active', label: 'AI active' });
  });

  it('a rate-limited key is reported as busy, not rejected', async () => {
    saveKey(KEY_A, NOW - HOUR);
    fetchReturning(429);
    await refreshProviderHealth();
    expect(getAiState(1, NOW)).toMatchObject({ state: 'error', label: 'AI provider busy' });
  });

  it('a verdict belongs to one key: saving a different key discards it immediately', async () => {
    saveKey(KEY_A, NOW - 2 * HOUR);
    fetchReturning(401);
    await refreshProviderHealth();
    expect(getAiState(1, NOW).label).toBe('AI key rejected');
    saveKey(KEY_B, NOW - HOUR);
    expect(getCachedProviderHealth(NOW)).toBeNull();
    expect(getAiState(1, NOW)).toMatchObject({ state: 'active', verified: false });
    fetchReturning(200);
    await refreshProviderHealth();
    expect(getAiState(1, NOW)).toMatchObject({ state: 'active', verified: true });
  });

  it('concurrent checks share one provider request, and a fresh verdict is not re-fetched', async () => {
    saveKey(KEY_A, NOW - HOUR);
    const fetchMock = fetchReturning(200);
    await Promise.all([refreshProviderHealth(), refreshProviderHealth(), ensureProviderHealth(1000)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await ensureProviderHealth(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a failed verdict goes stale quickly so a corrected key turns green soon; a good one lasts minutes', async () => {
    saveKey(KEY_A, NOW - HOUR);
    fetchReturning(401);
    await refreshProviderHealth();
    const checkedAt = getCachedProviderHealth(NOW)!.checkedAt;
    expect(getCachedProviderHealth(checkedAt + 30_000)!.stale).toBe(false);
    expect(getCachedProviderHealth(checkedAt + 90_000)!.stale).toBe(true);
    resetProviderHealthForTests();
    fetchReturning(200);
    await refreshProviderHealth();
    const okAt = getCachedProviderHealth(NOW)!.checkedAt;
    expect(getCachedProviderHealth(okAt + 4 * 60_000)!.stale).toBe(false);
    expect(getCachedProviderHealth(okAt + 6 * 60_000)!.stale).toBe(true);
  });
});

/** A provider double that answers per URL: the key check and the chat completion are separate requests. */
function provider(opts: { key?: number; chat?: { status: number; content?: string | null; message?: string } }) {
  const fn = vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith('/auth/key')) return new Response('{}', { status: opts.key ?? 200 });
    const chat = opts.chat ?? { status: 200, content: 'ok' };
    if (chat.status >= 400) return new Response(JSON.stringify({ error: { message: chat.message ?? 'refused', code: chat.status } }), { status: chat.status });
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: chat.content ?? null } }] }), { status: 200 });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('a valid key is not a usable model', () => {
  it('classifies model answers', () => {
    expect(classifyModelResponse(200, 'ok')).toBe('usable');
    expect(classifyModelResponse(200, null)).toBe('empty');
    expect(classifyModelResponse(404, null)).toBe('unavailable');
    expect(classifyModelResponse(429, null)).toBe('rate_limited');
    expect(classifyModelResponse(503, null)).toBe('error');
  });

  it('a model that answers is "Model verified"', async () => {
    saveKey(KEY_A, NOW - HOUR);
    provider({});
    await ensureProviderHealth(2000, MODEL);
    expect(getAiState(1, NOW)).toMatchObject({ state: 'active', verified: true, modelVerified: true, model: MODEL });
    expect(getAiState(1, NOW).detail).toContain(MODEL);
  });

  it('HTTP 200 with an empty answer is a failed model, even though the key is valid', async () => {
    saveKey(KEY_A, NOW - HOUR);
    provider({ chat: { status: 200, content: '   ' } });
    await ensureProviderHealth(2000, MODEL);
    expect(getAiState(1, NOW)).toMatchObject({ state: 'error', label: 'AI model unavailable', verified: true, modelVerified: false });
    expect(getAiState(1, NOW).detail).toContain('empty answer');
  });

  it('a model refused by the account data policy (404) is reported with its status, and a rate limit as such', async () => {
    saveKey(KEY_A, NOW - HOUR);
    provider({ chat: { status: 404, message: '0 endpoints available matching your guardrail restrictions and data policy' } });
    await ensureProviderHealth(2000, MODEL);
    expect(getAiState(1, NOW).detail).toMatch(/refused \(HTTP 404\).*data-policy/);
    resetProviderHealthForTests();
    provider({ chat: { status: 429 } });
    await ensureProviderHealth(2000, MODEL);
    expect(getAiState(1, NOW).detail).toContain('rate limited');
  });

  it('the model is probed per model and per account: changing one account\'s model leaves the others', async () => {
    saveKey(KEY_A, NOW - HOUR);
    const fetchMock = provider({});
    updateBusinessSettings({ openRouterModel: 'vendor/special-model' }, 2);
    await ensureProviderHealth(2000, 'vendor/special-model');
    expect(getAiState(2, NOW)).toMatchObject({ model: 'vendor/special-model', modelVerified: true });
    // account 1 still has its own model and no verdict for it: not "verified" just because another account's model answered
    expect(getAiState(1, NOW)).toMatchObject({ model: MODEL, modelVerified: false });
    expect(getAiState(3, NOW)).toMatchObject({ model: MODEL, modelVerified: false });
    const bodies = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/chat/completions')).map(([, init]) => JSON.parse(String((init as RequestInit).body)));
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ model: 'vendor/special-model', max_tokens: 8 });
    expect(JSON.stringify(bodies[0])).not.toMatch(/customer|business|Rowad|JOTUN/i); // a neutral prompt, no business or customer data
  });

  it('the probe never runs for a rejected key, never for mock mode, and is cached (no excessive provider calls)', async () => {
    saveKey(KEY_A, NOW - HOUR);
    const rejected = provider({ key: 401 });
    await ensureProviderHealth(2000, MODEL);
    expect(rejected.mock.calls.some(([u]) => String(u).endsWith('/chat/completions'))).toBe(false);
    resetProviderHealthForTests();
    const ok = provider({});
    await Promise.all([ensureProviderHealth(2000, MODEL), ensureProviderHealth(2000, MODEL), ensureProviderHealth(2000, MODEL)]);
    await ensureProviderHealth(2000, MODEL);
    expect(ok.mock.calls.filter(([u]) => String(u).endsWith('/chat/completions'))).toHaveLength(1);
    expect(ok.mock.calls.filter(([u]) => String(u).endsWith('/auth/key'))).toHaveLength(1);
    const probedAt = getCachedModelHealth(MODEL)!.checkedAt;
    expect(getCachedModelHealth(MODEL, probedAt + 29 * 60_000)!.stale).toBe(false);
    expect(getCachedModelHealth(MODEL, probedAt + 31 * 60_000)!.stale).toBe(true);
    mutableEnv.shouldUseMockProviders = true;
    expect(await refreshModelHealth(MODEL)).toBeNull();
  });

  it('a different key discards the model verdict too', async () => {
    saveKey(KEY_A, NOW - 2 * HOUR);
    provider({ chat: { status: 200, content: '' } });
    await ensureProviderHealth(2000, MODEL);
    expect(getAiState(1, NOW).label).toBe('AI model unavailable');
    saveKey(KEY_B, NOW - HOUR);
    expect(getCachedModelHealth(MODEL)).toBeNull();
    expect(getAiState(1, NOW)).toMatchObject({ state: 'active', modelVerified: false });
  });

  it('real replies are the strongest evidence: a later success beats an older failing probe, a later failure beats a good probe', async () => {
    saveKey(KEY_A, Date.now() - 10 * HOUR); // probes are stamped with the real clock, so this timeline uses it too
    provider({ chat: { status: 200, content: '' } });
    await ensureProviderHealth(2000, MODEL);
    const probedAt = getCachedModelHealth(MODEL)!.checkedAt;
    activity(1, 'ai', 'answered', probedAt + 60_000);
    expect(getAiState(1, probedAt + 120_000)).toMatchObject({ state: 'active', modelVerified: true });
    resetProviderHealthForTests();
    provider({});
    await ensureProviderHealth(2000, MODEL);
    activity(1, 'error', FAILED, getCachedModelHealth(MODEL)!.checkedAt + 180_000);
    expect(getAiState(1, getCachedModelHealth(MODEL)!.checkedAt + 240_000)).toMatchObject({ state: 'error', label: 'AI replies failing' });
  });

  it('failures under another model, and old failures without a model, no longer count once the model is corrected', async () => {
    saveKey(KEY_A, NOW - 10 * HOUR);
    activity(1, 'error', 'AI failed; fallback sent (empty response, HTTP 200, model openrouter/free)', NOW - 2 * HOUR);
    activity(1, 'error', 'AI failed; fallback sent', NOW - 3 * HOUR);
    provider({});
    await ensureProviderHealth(2000, MODEL);
    expect(getAiState(1, NOW)).toMatchObject({ state: 'active', modelVerified: true });
    updateBusinessSettings({ openRouterModel: 'openrouter/free' }, 1);
    expect(getAiState(1, NOW)).toMatchObject({ state: 'error', label: 'AI replies failing', model: 'openrouter/free' }); // that model really failed
  });

  it('with a key but no check yet, the pill does not claim the model works just because nothing failed recently', async () => {
    saveKey(KEY_A, NOW - HOUR);
    provider({});
    await refreshProviderHealth();
    const state = getAiState(1, NOW);
    expect(state).toMatchObject({ state: 'active', verified: true, modelVerified: false });
    expect(state.detail).toContain('not confirmed');
  });
});
