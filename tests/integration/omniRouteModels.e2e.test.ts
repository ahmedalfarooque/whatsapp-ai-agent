import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { getDb } from '../../src/memory/db';
import { env } from '../../src/config/env';
import { createSession } from '../../src/dashboard/auth';
import { SESSION_COOKIE_NAME } from '../../src/dashboard/authMiddleware';
import { omniRouteBaseUrl, setOmniRouteKeyFileEnabledForTests, OMNIROUTE_BASE_URL } from '../../src/llm/omniRoute';

/**
 * Connecting the agent to the local OmniRoute gateway: its address and key come from the central configuration (OMNIROUTE_BASE_URL, OMNIROUTE_API_KEY; the local default is
 * http://127.0.0.1:20128/v1), the form can LOAD the gateway's model list, and a listed model is only a suggestion — the one chosen is tested with a real request when saved.
 * The gateway is scripted (a fake `fetch`): these tests prove the wiring and the safety, not that a given gateway has a working free provider connected inside it.
 */
const PASSWORD = 'a-very-long-test-password-123';
const KEY = 'sk-omniroutemodelskey0123456789abcdef';
const mutableEnv = env as unknown as Record<string, unknown>;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const chat = (text: string) => json(200, { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }] });
const healthy = () => json(200, { status: 'healthy', setupComplete: true });
const clearProviders = () => getDb().prepare('DELETE FROM ai_providers').run();

type Seen = { url: string; headers: Record<string, string>; redirect?: RequestRedirect };
let seen: Seen[];
function gateway(handlers: { health?: () => Response; models?: () => Response; chat?: () => Response }) {
  seen = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    seen.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, redirect: init?.redirect });
    const handler = u.pathname === '/api/monitoring/health' ? handlers.health : u.pathname.endsWith('/models') ? handlers.models : u.pathname.endsWith('/chat/completions') ? handlers.chat : undefined;
    if (!handler) throw new TypeError(`no script for ${u.pathname}`);
    return handler();
  }));
}

describe('OmniRoute: address, key and model list', () => {
  const app = createApp();
  let owner: ReturnType<typeof request.agent>;
  const originalFetch = globalThis.fetch;
  const models = () => owner.get('/api/dashboard/ai-routing/omniroute/models');

  beforeAll(async () => {
    getDb();
    setOmniRouteKeyFileEnabledForTests(false);
    expect((await request(app).post('/api/dashboard/auth/setup').send({ username: 'omni-models-owner', password: PASSWORD })).status).toBe(201);
    const id = (getDb().prepare('SELECT id FROM admin_users WHERE username = ?').get('omni-models-owner') as { id: number }).id;
    owner = request.agent(app).set('Cookie', `${SESSION_COOKIE_NAME}=${createSession(id).token}`);
  });
  afterAll(() => setOmniRouteKeyFileEnabledForTests(true));
  beforeEach(() => { clearProviders(); mutableEnv.OMNIROUTE_API_KEY = KEY; mutableEnv.OMNIROUTE_BASE_URL = ''; });
  afterEach(() => { vi.stubGlobal('fetch', originalFetch); mutableEnv.OMNIROUTE_API_KEY = ''; mutableEnv.OMNIROUTE_BASE_URL = ''; });

  it('the gateway address defaults to the local one and can be set (loopback only) in the central configuration', () => {
    expect(omniRouteBaseUrl()).toBe(OMNIROUTE_BASE_URL);
    expect(OMNIROUTE_BASE_URL).toBe('http://127.0.0.1:20128/v1');
    mutableEnv.OMNIROUTE_BASE_URL = 'http://localhost:20999/v1/';
    expect(omniRouteBaseUrl()).toBe('http://localhost:20999/v1');
  });

  it('lists the models the gateway offers: its own auto/ combos first, ids deduplicated and validated, the key sent only to the gateway and never returned', async () => {
    gateway({ health: healthy, models: () => json(200, { data: [{ id: 'zeta/model' }, { id: 'auto/best-free' }, { id: 'alpha/model' }, { id: 'auto/best-fast' }, { id: 'alpha/model' }, { id: 'bad id with spaces' }, { id: 'http://evil.example/x' }, { id: 42 }, {}, null] }) });
    const res = await models();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ reachable: true, keyFound: true, baseUrl: 'http://127.0.0.1:20128/v1', models: ['auto/best-fast', 'auto/best-free', 'alpha/model', 'zeta/model'], truncated: false });
    expect(JSON.stringify(res.body)).not.toContain(KEY);
    const modelsCall = seen.find((s) => s.url.endsWith('/models'))!;
    expect(modelsCall.url).toBe('http://127.0.0.1:20128/v1/models');
    expect(modelsCall.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(modelsCall.redirect).toBe('error');
    expect(seen.find((s) => s.url.endsWith('/health'))!.headers.Authorization).toBeUndefined(); // the health probe carries no key
  });

  it('a very long list is capped', async () => {
    gateway({ health: healthy, models: () => json(200, { data: Array.from({ length: 900 }, (_, i) => ({ id: `vendor/model-${String(i).padStart(4, '0')}` })) }) });
    const res = await models();
    expect(res.body.models).toHaveLength(500);
    expect(res.body.truncated).toBe(true);
  });

  it('says exactly what is missing: gateway not running, no key on this server, key rejected, unreadable answer — and sends no key when the gateway is not demonstrably OmniRoute', async () => {
    gateway({ health: () => { throw new TypeError('connect ECONNREFUSED'); } });
    expect((await models()).body).toMatchObject({ reachable: false, models: [], reason: 'not_running' });
    expect(seen.every((s) => s.url.endsWith('/health'))).toBe(true);

    mutableEnv.OMNIROUTE_API_KEY = '';
    gateway({ health: healthy, models: () => json(200, { data: [] }) });
    expect((await models()).body).toMatchObject({ reachable: true, keyFound: false, models: [], reason: 'no_key' });
    expect(seen.some((s) => s.url.endsWith('/models'))).toBe(false); // nothing to authenticate with: nothing asked

    mutableEnv.OMNIROUTE_API_KEY = KEY;
    gateway({ health: healthy, models: () => json(401, { error: 'invalid key' }) });
    expect((await models()).body).toMatchObject({ reachable: true, keyFound: true, models: [], reason: 'rejected' }); // a key was found, and the gateway refused it
    gateway({ health: healthy, models: () => json(200, { unexpected: true }) });
    expect((await models()).body).toMatchObject({ models: [], reason: 'unreadable' });
    gateway({ health: healthy, models: () => json(500, {}) });
    expect((await models()).body).toMatchObject({ models: [], reason: 'unreadable' });
  });

  it('only a signed-in user may ask', async () => {
    gateway({ health: healthy, models: () => json(200, { data: [{ id: 'auto/best-free' }] }) });
    expect((await request(app).get('/api/dashboard/ai-routing/omniroute/models')).status).toBe(401);
    expect(seen).toEqual([]);
  });

  it('saving through the form with OmniRoute chosen uses the configured address and TESTS the chosen model with a real request: a listed model that does not answer is never saved as working', async () => {
    mutableEnv.OMNIROUTE_BASE_URL = 'http://localhost:20999/v1';
    const asked: string[] = [];
    let working = new Set<string>();
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url));
      if (u.pathname === '/api/monitoring/health') return healthy();
      if (u.pathname.endsWith('/chat/completions')) {
        const model = JSON.parse(String(init?.body)).model as string;
        asked.push(model);
        return working.has(model) ? chat('ok') : json(502, { error: { message: 'no provider for this model' } });
      }
      throw new TypeError(`no script for ${u.pathname}`);
    }));
    const admin = (body: Record<string, unknown>) => owner.post('/api/dashboard/super-admin/ai/providers').send(body);

    // the chosen model answers: it is saved, on the configured address
    working = new Set(['alpha/works']);
    const good = await admin({ provider: 'omniroute', config: '', models: 'alpha/works' });
    expect(good.status, JSON.stringify(good.body)).toBe(201);
    expect(asked[0]).toBe('alpha/works'); // the person's choice is the first thing tested
    expect(good.body.provider).toMatchObject({ vendor: 'omniroute', baseUrl: 'http://localhost:20999/v1', models: ['alpha/works'], lastTestOk: true });
    expect(JSON.stringify(good.body)).not.toContain(KEY);
    clearProviders();

    // the chosen model is listed but does not answer: it is NOT saved; the vendor's own verified default that does answer is, and the reason is reported
    asked.length = 0;
    working = new Set(['auto/best-free']);
    const fellBack = await admin({ provider: 'omniroute', config: '', models: 'listed/but-broken' });
    expect(fellBack.status, JSON.stringify(fellBack.body)).toBe(201);
    expect(fellBack.body.provider.models).toEqual(['auto/best-free']);
    expect(fellBack.body.provider.models).not.toContain('listed/but-broken');
    expect(fellBack.body.setup.testFailure).toContain('listed/but-broken');
    clearProviders();

    // nothing answers (no free provider connected inside the gateway): the entry is kept (only a rejected key refuses a save) but it is recorded as FAILED and unverified —
    // never as working — with the reason, and its free tier is not confirmed, so strict free-only routing cannot use it
    working = new Set();
    const none = await admin({ provider: 'omniroute', config: '', models: 'listed/but-broken' });
    expect(none.status, JSON.stringify(none.body)).toBe(201);
    expect(none.body.setup).toMatchObject({ verified: false });
    expect(none.body.setup.testFailure).toMatch(/did not answer|HTTP 502/);
    expect(none.body.provider).toMatchObject({ lastTestOk: false, freeConfirmed: false });
    expect(JSON.stringify(none.body)).not.toContain(KEY);
  });
});
