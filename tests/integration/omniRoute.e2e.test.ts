import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { getDb } from '../../src/memory/db';
import { env } from '../../src/config/env';
import { createSession } from '../../src/dashboard/auth';
import { SESSION_COOKIE_NAME } from '../../src/dashboard/authMiddleware';
import { createAccount } from '../../src/accounts/accountRepo';
import { runWithAccount } from '../../src/accounts/accountContext';
import { createProvider } from '../../src/llm/providerRepo';
import { allowUnknownPriceForTests, resetAiRouterForTests, routeCompletion } from '../../src/llm/aiRouter';
import { setModelCatalogForTests } from '../../src/llm/modelCatalog';
import { isOmniRouteKey, omniRouteReachable, discoverLocalOmniRouteKey } from '../../src/llm/omniRoute';

/**
 * OmniRoute (a local OpenAI-compatible gateway on loopback) as the FIRST route, with OpenRouter behind it. The network is SCRIPTED (mocked): these tests prove the
 * detection, the saved configuration, the routing order, the failover on every kind of failure and the recovery — not that a real OmniRoute behaves this way.
 */
const PASSWORD = 'a-very-long-test-password-123';
const OMNI_KEY = 'sk-omniroutetestkey0123456789abcdef';
const OR_KEY = 'sk-or-v1-omniroutetestomniroutetestomniroutetest0000';
const mutableEnv = env as unknown as Record<string, unknown>;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const chat = (text: string) => json(200, { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }] });
const OMNI = '127.0.0.1:20128';

let counts: Record<string, number>;
type Handler = (n: number, init?: RequestInit) => Response | Promise<Response>;
function network(handlers: { omni?: Handler; openrouter?: Handler; health?: Handler; models?: Handler }) {
  counts = {};
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const key = u.pathname === '/api/monitoring/health' ? 'health' : u.host === OMNI && u.pathname.endsWith('/models') ? 'models' : u.host === OMNI ? 'omni' : u.host === 'openrouter.ai' ? 'openrouter' : u.host;
    counts[key] = (counts[key] ?? 0) + 1;
    const handler = handlers[key as keyof typeof handlers];
    if (!handler) throw new TypeError(`no script for ${key}`);
    return handler(counts[key]!, init);
  }));
}

describe('OmniRoute: discovery and saving through the simplified form', () => {
  const app = createApp();
  let owner: ReturnType<typeof request.agent>;
  const originalFetch = globalThis.fetch;
  const shared = (body: Record<string, unknown>) => owner.post('/api/dashboard/super-admin/ai/providers').send(body);

  beforeAll(async () => {
    getDb();
    expect((await request(app).post('/api/dashboard/auth/setup').send({ username: 'omni-owner', password: PASSWORD })).status).toBe(201);
    const id = (getDb().prepare('SELECT id FROM admin_users WHERE username = ?').get('omni-owner') as { id: number }).id;
    owner = request.agent(app).set('Cookie', `${SESSION_COOKIE_NAME}=${createSession(id).token}`);
  });
  beforeEach(() => { getDb().prepare('DELETE FROM ai_providers').run(); mutableEnv.OMNIROUTE_API_KEY = ''; });
  afterEach(() => { vi.stubGlobal('fetch', originalFetch); mutableEnv.OMNIROUTE_API_KEY = ''; });

  const healthy = () => json(200, { status: 'healthy', setupComplete: true });

  it('OmniRoute chosen EXPLICITLY with its key: endpoint, model and priority are filled in, a real test request answers, and the free combo is NOT assumed free from its name', async () => {
    network({ health: healthy, models: () => json(200, { data: [{ id: 'auto/best-free' }] }), omni: () => chat('ok') });
    const res = await shared({ config: OMNI_KEY, provider: 'omniroute' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    // `auto/best-free` is only a name: until an administrator confirms the route is free, strict free-only mode would not use it
    expect(res.body.provider).toMatchObject({ name: 'OmniRoute', vendor: 'omniroute', baseUrl: 'http://127.0.0.1:20128/v1', models: ['auto/best-free'], priority: 5, freeConfirmed: false, lastTestOk: true });
    expect(res.body.setup).toMatchObject({ verified: true, freeConfirmationRequired: true });
    expect(res.body.setup).toMatchObject({ verified: true });
    expect(JSON.stringify(res.body)).not.toContain(OMNI_KEY);
    const row = getDb().prepare('SELECT key_ciphertext FROM ai_providers WHERE id = ?').get(res.body.provider.id) as { key_ciphertext: string };
    expect(row.key_ciphertext).not.toContain(OMNI_KEY);
  });

  it('the administrator confirming the free combo is what makes it count as free', async () => {
    network({ health: healthy, models: () => json(200, { data: [] }), omni: () => chat('ok') });
    const res = await shared({ config: OMNI_KEY, provider: 'omniroute', freeConfirmed: true });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.provider).toMatchObject({ vendor: 'omniroute', freeConfirmed: true });
  });

  it('an unknown key is NEVER tried on the local gateway port, and never guessed to be OmniRoute: no request at all, a concise "provider not recognised", nothing saved', async () => {
    network({ health: healthy, models: () => json(200, { data: [] }), omni: () => chat('ok') });
    const res = await shared({ config: OMNI_KEY });
    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual(['provider']);
    expect(counts).toEqual({}); // not even a health probe: the key stayed on this server
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM ai_providers').get() as { n: number }).n).toBe(0);
  });

  it('a provider NAME containing "omni" does not select OmniRoute or adopt the local key', async () => {
    mutableEnv.OMNIROUTE_API_KEY = OMNI_KEY;
    network({ health: healthy, models: () => json(200, { data: [] }), omni: () => chat('ok') });
    const res = await shared({ name: 'OmniRoute', config: '' });
    expect(res.status).toBe(400);
    expect(counts).toEqual({});
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM ai_providers').get() as { n: number }).n).toBe(0);
  });

  it('a malformed key is refused for OmniRoute before anything is sent anywhere', async () => {
    network({ health: healthy, models: () => json(200, { data: [] }), omni: () => chat('ok') });
    for (const bad of ['sk-has a space-0123456789', 'AIzaSyNotAnOmniRouteKey0123456789', 'sk-', 'sk-short']) {
      const res = await shared({ config: bad, provider: 'omniroute' });
      expect(res.status, bad).toBeGreaterThanOrEqual(400);
      expect(res.status, bad).toBeLessThan(500);
    }
    expect(counts).toEqual({});
  });

  it('a gateway that rejects the key is not OmniRoute for that key', async () => {
    network({ health: healthy, models: () => json(401, { error: { message: 'Invalid API key' } }) });
    expect(await isOmniRouteKey(OMNI_KEY)).toBe(false);
    network({ health: () => json(200, { status: 'degraded' }) });
    expect(await omniRouteReachable()).toBe(false);
  });

  it('OmniRoute chosen explicitly and no key typed: the key OmniRoute already has on this machine is used (never echoed); when there is none, the save is refused with the reason', async () => {
    mutableEnv.OMNIROUTE_API_KEY = OMNI_KEY;
    expect(await discoverLocalOmniRouteKey()).toBe(OMNI_KEY);
    network({ health: healthy, omni: () => chat('ok') });
    const res = await shared({ name: 'My AI', config: '', provider: 'omniroute' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.provider).toMatchObject({ name: 'My AI', vendor: 'omniroute', hasKey: true });
    expect(JSON.stringify(res.body)).not.toContain(OMNI_KEY);

    mutableEnv.OMNIROUTE_API_KEY = '';
    network({ health: () => { throw new TypeError('connect ECONNREFUSED'); } });
    const none = await shared({ name: 'OmniRoute', config: '', provider: 'omniroute' });
    expect(none.status).toBe(422);
    expect(none.body.code).toBe('omniroute_unavailable');
  });

  it('a rejected OmniRoute key (401 on the first real request) refuses the save; nothing else about the form changes', async () => {
    network({ health: healthy, models: () => chat('x'), omni: () => json(401, { error: { message: 'Invalid API key' } }) });
    const res = await shared({ name: 'OmniRoute', config: OMNI_KEY, provider: 'omniroute' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('credential');
  });

  it('edit, test, disable and remove work for it like for any provider', async () => {
    network({ health: healthy, models: () => json(200, { data: [] }), omni: () => chat('ok') });
    const created = await shared({ config: OMNI_KEY, provider: 'omniroute' });
    const id = created.body.provider.id as number;
    const edited = await owner.put(`/api/dashboard/super-admin/ai/providers/${id}`).send({ name: 'Backup AI', config: '' });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.provider).toMatchObject({ name: 'Backup AI', models: ['auto/best-free'], hasKey: true });
    createProvider({ name: 'OpenRouter', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: OR_KEY, models: ['openrouter/free'], priority: 10 }, { accountId: null, updatedBy: 1 }); // the last enabled provider cannot be switched off
    const off = await owner.post(`/api/dashboard/super-admin/ai/providers/${id}/disable`).send({});
    expect(off.status, JSON.stringify(off.body)).toBeLessThan(300);
    expect((getDb().prepare('SELECT enabled FROM ai_providers WHERE id = ?').get(id) as { enabled: number }).enabled).toBe(0);
    const tested = await owner.post(`/api/dashboard/super-admin/ai/providers/${id}/test`).send({});
    expect(tested.status).toBe(200);
    expect(tested.body.ok).toBe(true);
    expect((await owner.delete(`/api/dashboard/super-admin/ai/providers/${id}?confirm=yes`)).status).toBeLessThan(300);
    expect((getDb().prepare("SELECT COUNT(*) AS n FROM ai_providers WHERE vendor = 'omniroute'").get() as { n: number }).n).toBe(0);
  });
});

describe('OmniRoute first, the existing providers behind it (routing, failover, recovery)', () => {
  const originalMock = mutableEnv.shouldUseMockProviders;
  let account: number;
  const ask = () => runWithAccount(account, () => routeCompletion({ task: 'chat', messages: [{ role: 'user', content: 'Do you open on Fridays?' }], maxTokens: 50, deadline: Date.now() + 8000 })) as Promise<{ choices: Array<{ message: { content: string } }> }>;
  const text = async (): Promise<string> => (await ask()).choices[0]!.message.content;

  beforeEach(() => {
    mutableEnv.shouldUseMockProviders = false;
    const db = getDb();
    db.prepare('DELETE FROM ai_providers').run();
    db.prepare('DELETE FROM ai_route_cooldowns').run();
    createProvider({ name: 'OmniRoute', kind: 'openai_compatible', adapter: 'openai', vendor: 'omniroute', baseUrl: 'http://127.0.0.1:20128/v1', apiKey: OMNI_KEY, models: ['auto/best-free'], priority: 5, timeoutMs: 3000, freeConfirmed: true }, { accountId: null, updatedBy: 1 });
    createProvider({ name: 'OpenRouter', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: OR_KEY, models: ['openrouter/free'], priority: 10, timeoutMs: 3000 }, { accountId: null, updatedBy: 1 });
    setModelCatalogForTests([{ id: 'openrouter/free', free: true, image: false, audio: false, tools: true, contextLength: 100000 }]);
    allowUnknownPriceForTests(false);
    resetAiRouterForTests();
    account = createAccount({ name: `Omni Co ${Math.random()}` }).id;
  });
  afterEach(() => { vi.useRealTimers(); mutableEnv.shouldUseMockProviders = originalMock; vi.unstubAllGlobals(); setModelCatalogForTests(null); resetAiRouterForTests(); });

  it('when OmniRoute answers it is the only provider asked, with its own key and the free-only combo', async () => {
    let seen: { auth: string | null; model: string } | null = null;
    network({ omni: (_n, init) => { seen = { auth: new Headers(init?.headers).get('authorization'), model: String((JSON.parse(String(init?.body)) as { model: string }).model) }; return chat('From OmniRoute.'); }, openrouter: () => chat('From OpenRouter.') });
    expect(await text()).toBe('From OmniRoute.');
    expect(counts.openrouter).toBeUndefined();
    expect(seen).toEqual({ auth: `Bearer ${OMNI_KEY}`, model: 'auto/best-free' });
  });

  it.each([
    ['no free route (HTTP 502)', () => json(502, { error: { message: 'oc/x: model — [402]: requires an API key (HTTP 402)' } })],
    ['a rejected key (HTTP 401)', () => json(401, { error: { message: 'Invalid API key' } })],
    ['a rate limit (HTTP 429)', () => json(429, { error: { message: 'Rate limit exceeded' } })],
    ['an HTML page with HTTP 200 (malformed)', () => new Response('<!doctype html><html>gateway</html>', { status: 200 })],
    ['an error object inside HTTP 200', () => json(200, { error: { code: 503, message: 'all routes busy' } })],
    ['an empty answer', () => json(200, { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '' } }] })],
    ['a timeout', () => { throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }); }],
    ['OmniRoute not running (connection refused)', () => { throw new TypeError('fetch failed'); }],
  ])('%s: the customer still gets ONE answer, from OpenRouter, and OmniRoute is asked once', async (_label, failure) => {
    network({ omni: failure as Handler, openrouter: () => chat('From OpenRouter.') });
    expect(await text()).toBe('From OpenRouter.');
    expect(counts.omni).toBe(1);
    expect(counts.openrouter).toBe(1);
  });

  it('every route down: the router fails honestly (no invented reply), and each route was asked at most once', async () => {
    network({ omni: () => json(502, { error: { message: 'no route' } }), openrouter: () => json(429, { error: { message: 'free pool limited' } }) });
    await expect(ask()).rejects.toThrow();
    expect(counts.omni).toBe(1);
    expect(counts.openrouter).toBe(1);
  });

  it('a failed OmniRoute rests (the next request does not touch it) and comes back by itself once its pause is over — no reconfiguration', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let omniUp = false;
    network({ omni: () => (omniUp ? chat('From OmniRoute.') : json(502, { error: { message: 'no route' } })), openrouter: () => chat('From OpenRouter.') });
    expect(await text()).toBe('From OpenRouter.');
    expect(await text()).toBe('From OpenRouter.');
    expect(counts.omni).toBe(1); // resting: not asked again
    omniUp = true;
    vi.setSystemTime(Date.now() + 3 * 3_600_000);
    expect(await text()).toBe('From OmniRoute.'); // back in first place on its own
  });
});
