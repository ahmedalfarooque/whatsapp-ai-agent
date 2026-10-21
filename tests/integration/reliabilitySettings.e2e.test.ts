import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { getDb } from '../../src/memory/db';
import { env } from '../../src/config/env';
import { createSession } from '../../src/dashboard/auth';
import { SESSION_COOKIE_NAME } from '../../src/dashboard/authMiddleware';
import { createAccount } from '../../src/accounts/accountRepo';
import { createProvider, getProvider, providerApiKey } from '../../src/llm/providerRepo';
import { allowUnknownPriceForTests, resetAiRouterForTests, routeCompletion } from '../../src/llm/aiRouter';
import { setModelCatalogForTests } from '../../src/llm/modelCatalog';
import { runWithAccount } from '../../src/accounts/accountContext';

/**
 * Settings: replacing a key is validated, and what the Super Admin page shows is what the server persisted. Scripted providers (mocked) and a faked clock.
 */
const PASSWORD = 'a-very-long-test-password-123';
const mutableEnv = env as unknown as Record<string, unknown>;
const OLD_KEY = 'gsk_oldkeyoldkeyoldkeyoldkeyoldkeyoldkey00000000';
const NEW_KEY = 'gsk_newkeynewkeynewkeynewkeynewkeynewkey00000000';
const OR_KEY = 'sk-or-v1-settingssettingssettingssettingssettings000';
const G_KEY = 'AQ.Ab8RN6Settings-GeminiKeyShapeSettingsSettings000000';
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const chatOk = (text = 'ok') => json(200, { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }] });
const gemOk = (text: string) => json(200, { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] });

// One administrator for the whole file (the dashboard allows a single first-run setup).
const app = createApp();
let owner: ReturnType<typeof request.agent>;
let acc: number;
let adminId: number;
beforeAll(async () => {
  getDb();
  expect((await request(app).post('/api/dashboard/auth/setup').send({ username: 'rs-owner', password: PASSWORD })).status).toBe(201);
  adminId = (getDb().prepare('SELECT id FROM admin_users WHERE username = ?').get('rs-owner') as { id: number }).id;
  owner = request.agent(app).set('Cookie', `${SESSION_COOKIE_NAME}=${createSession(adminId).token}`);
  acc = createAccount({ name: 'Settings Co' }).id;
  allowUnknownPriceForTests(false);
});

describe('Settings: replacing a provider key is validated by one real request', () => {
  const originalMock = mutableEnv.shouldUseMockProviders;
  beforeEach(() => { mutableEnv.shouldUseMockProviders = false; getDb().prepare('DELETE FROM ai_providers').run(); });
  afterEach(() => { mutableEnv.shouldUseMockProviders = originalMock; vi.unstubAllGlobals(); });
  const make = (accountId: number | null = null) => createProvider({ name: 'Groq', kind: 'openai_compatible', adapter: 'openai', vendor: 'groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: OLD_KEY, models: ['openai/gpt-oss-20b'], timeoutMs: 3000, freeConfirmed: true }, { accountId, updatedBy: 1 });
  const edit = (id: number, body: Record<string, unknown>) => owner.put(`/api/dashboard/super-admin/ai/providers/${id}`).send(body);

  it('a key the provider REJECTS is refused (HTTP 422): the old key stays, nothing is saved, nothing secret is echoed', async () => {
    const row = make();
    vi.stubGlobal('fetch', vi.fn(async () => json(401, { error: { message: 'Invalid API Key' } })));
    const res = await edit(row.id, { name: 'Groq', config: NEW_KEY });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'credential', fields: ['config'] });
    expect(res.body.error).toMatch(/rejected.*previous key was kept/s);
    expect(providerApiKey(getProvider(row.id, acc)!)).toBe(OLD_KEY);
    expect(JSON.stringify(res.body)).not.toContain(NEW_KEY);
    expect(JSON.stringify(res.body)).not.toContain(OLD_KEY);
  });

  it('a key that ANSWERS is saved and the provider starts from a passed test; the response says it was verified', async () => {
    const row = make();
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => { expect(String((init?.headers as Record<string, string>).Authorization)).toBe(`Bearer ${NEW_KEY}`); return chatOk(); }));
    const res = await edit(row.id, { name: 'Groq', config: NEW_KEY });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.keyCheck).toMatchObject({ ok: true });
    expect(providerApiKey(getProvider(row.id, acc)!)).toBe(NEW_KEY);
    expect(getProvider(row.id, acc)!.last_test_ok).toBe(1);
  });

  it('a key that cannot be verified right now (quota used up) is saved but the response says plainly it could NOT be verified — never "verified"', async () => {
    const row = make();
    vi.stubGlobal('fetch', vi.fn(async () => json(429, { error: { message: 'Rate limit exceeded: free-models-per-day' } })));
    const res = await edit(row.id, { name: 'Groq', config: NEW_KEY });
    expect(res.status).toBe(200);
    expect(res.body.keyCheck).toMatchObject({ ok: false, category: 'rate_limited' });
    expect(res.body.keyCheck.message).toMatch(/could not be verified/);
    expect(providerApiKey(getProvider(row.id, acc)!)).toBe(NEW_KEY);
    expect(getProvider(row.id, acc)!.last_test_ok).not.toBe(1); // a failed check is not recorded as a passed test
  });

  it('an edit that does not touch the key makes no provider request at all, and a business can validate its own provider the same way', async () => {
    const row = make();
    const spy = vi.fn(async () => chatOk());
    vi.stubGlobal('fetch', spy);
    expect((await edit(row.id, { name: 'Groq renamed', config: '' })).status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
    const own = make(acc);
    vi.stubGlobal('fetch', vi.fn(async () => json(401, { error: { message: 'bad' } })));
    const res = await owner.put(`/api/dashboard/ai-routing/providers/${own.id}`).set('X-Whatsapp-Account', String(acc)).send({ name: 'Groq', config: NEW_KEY });
    expect(res.status).toBe(422);
    expect(providerApiKey(getProvider(own.id, acc)!)).toBe(OLD_KEY);
  });
});

describe('Super Admin Settings shows exactly what the server persisted', () => {
  const originalMock = mutableEnv.shouldUseMockProviders;
  const T0 = ((d) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 2, 10, 0, 0))(new Date());
  beforeEach(() => {
    mutableEnv.shouldUseMockProviders = false;
    mutableEnv.OPENROUTER_API_KEY = '';
    const db = getDb();
    db.prepare('DELETE FROM ai_providers').run();
    db.prepare('DELETE FROM ai_route_log').run();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    // A session created now expires relative to the faked clock (the one made in beforeAll would look two days old).
    owner = request.agent(app).set('Cookie', `${SESSION_COOKIE_NAME}=${createSession(adminId).token}`);
    createProvider({ name: 'OpenRouter', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: OR_KEY, models: ['openrouter/free'], priority: 10, timeoutMs: 3000 }, { accountId: null, updatedBy: 1 });
    createProvider({ name: 'Gemini', kind: 'openai_compatible', adapter: 'gemini', vendor: 'google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: G_KEY, models: ['gemini-3.8-flash'], priority: 100, timeoutMs: 3000 }, { accountId: null, updatedBy: 1 });
    setModelCatalogForTests([{ id: 'openrouter/free', free: true, image: false, audio: false, tools: true, contextLength: 100000 }]);
    allowUnknownPriceForTests(false);
    resetAiRouterForTests();
  });
  afterEach(() => { vi.useRealTimers(); mutableEnv.shouldUseMockProviders = originalMock; vi.unstubAllGlobals(); });
  const ask = () => runWithAccount(acc, () => routeCompletion({ task: 'chat', messages: [{ role: 'user', content: 'hi' }], maxTokens: 8, temperature: 0, deadline: Date.now() + 8000 }));
  // The routing history is stamped by the database clock; stamp it with the faked clock so "within the last 24 hours" matches the scenario.
  const page = async () => {
    getDb().prepare('UPDATE ai_route_log SET created_at = ?').run(new Date(Date.now()).toISOString().slice(0, 19).replace('T', ' '));
    return (await owner.get('/api/dashboard/super-admin/ai')).body;
  };

  it('active provider, next route, a STATED reset and its basis are shown while OpenRouter rests; after recovery nothing stale remains', async () => {
    let orUp = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => (String(url).includes('openrouter.ai') ? (orUp ? chatOk('OpenRouter answer') : json(429, { error: { message: 'Rate limit exceeded' } }, { 'retry-after': '600' })) : gemOk('Gemini answer'))));
    await ask(); // OpenRouter is rate limited with a STATED 10-minute reset; Gemini answers
    let data = await page();
    expect(data.active).toMatchObject({ provider: 'Gemini', model: 'gemini-3.8-flash' });
    expect(data.nextRoute).toMatchObject({ provider: 'Gemini' });
    expect(data.nextRetry).toMatchObject({ provider: 'OpenRouter', resetKnown: true });
    expect(Date.parse(data.nextRetry.at) - T0).toBeGreaterThanOrEqual(599_000);
    const orCard = data.providers.find((p: { name: string }) => p.name === 'OpenRouter');
    expect(orCard.health).toMatchObject({ state: 'rate_limited', cooldown: { resetKnown: true } });
    expect(orCard.health.summary).toMatch(/resets/);
    expect(data.allResting).toBe(false);

    vi.setSystemTime(T0 + 11 * 60_000);
    orUp = true;
    await ask(); // the pause is over; OpenRouter answers again
    data = await page();
    expect(data.active).toMatchObject({ provider: 'OpenRouter' });
    expect(data.nextRetry).toBeNull();
    const recovered = data.providers.find((p: { name: string }) => p.name === 'OpenRouter');
    expect(recovered.health.state).toBe('ok');
    expect(recovered.health.cooldown).toBeUndefined();
    expect(JSON.stringify(data)).not.toMatch(/AI limit finished/);
  });

  it('when every route rests the page does not claim success: no next route, "all resting", the earliest retry, and an ESTIMATE is not presented as a provider reset', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => (String(url).includes('openrouter.ai') ? json(500, { error: { message: 'upstream exploded' } }) : json(503, { error: { status: 'UNAVAILABLE', message: 'overloaded' } }))));
    await ask().catch(() => undefined);
    const data = await page();
    expect(data.nextRoute).toBeNull();
    expect(data.allResting).toBe(true);
    expect(data.status.state).not.toBe('ok');
    expect(data.nextRetry).toMatchObject({ resetKnown: false });
    for (const p of data.providers) {
      expect(p.health.cooldown).toMatchObject({ resetKnown: false });
      expect(p.health.summary).toMatch(/retry ~/);
      expect(p.health.summary).not.toMatch(/resets/);
    }
  });
});

describe('the operator sees times in their own time zone', () => {
  it('localizeHealthTimes replaces every "HH:MM UTC" with the local time of the exact instant the server sends, and leaves other text alone', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'dashboard', 'app.js'), 'utf8');
    const fn = /function localizeHealthTimes[\s\S]*?\n}\n/.exec(src.replace(/\r\n/g, '\n'))?.[0];
    expect(fn).toBeTruthy();
    const localize = vm.runInNewContext(`${fn}\nlocalizeHealthTimes`) as (text: string, health: unknown) => string;
    const iso = '2026-10-21T15:13:58.000Z';
    const local = new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    expect(localize('Resting (rate limited) — retry ~15:13 UTC.', { cooldown: { nextRetryAt: iso } })).toBe(`Resting (rate limited) — retry ~${local}.`);
    expect(localize('Answered at 15:13 UTC · model', { at: iso })).toBe(`Answered at ${local} · model`);
    expect(localize('No instant known 15:13 UTC', {})).toBe('No instant known 15:13 UTC');
    expect(localize('', { at: iso })).toBe('');
  });
});
