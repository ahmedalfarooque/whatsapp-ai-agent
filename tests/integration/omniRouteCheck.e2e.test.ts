import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { getDb } from '../../src/memory/db';
import { env } from '../../src/config/env';
import { createSession } from '../../src/dashboard/auth';
import { SESSION_COOKIE_NAME } from '../../src/dashboard/authMiddleware';
import { setOmniRouteKeyFileEnabledForTests } from '../../src/llm/omniRoute';
import { GATEWAY_SUMMARY_PREFIX } from '../../src/llm/openAiCompatible';

/**
 * The Super Admin "Check gateway" route and Load models for OmniRoute, through the real Express stack. The gateway is SCRIPTED (a fake `fetch`): these tests prove the wiring,
 * the key handling and the distinct states, not that any real upstream works.
 */
const PASSWORD = 'a-very-long-test-password-123';
const GATEWAY_KEY = 'sk-omnirouteCheckKey0123456789abcdef';
const mutableEnv = env as unknown as Record<string, unknown>;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const chat = (text: string) => json(200, { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }] });

let seen: Array<{ url: string; auth: string | null }>;
function gateway(handlers: { models?: () => Response; chat?: () => Response; healthy?: boolean } = {}) {
  seen = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const auth = ((init?.headers ?? {}) as Record<string, string>).Authorization ?? null;
    seen.push({ url: String(url), auth });
    if (u.pathname === '/api/monitoring/health') return handlers.healthy === false ? new Response('down', { status: 503 }) : json(200, { status: 'healthy' });
    if (u.pathname.endsWith('/models')) return auth === `Bearer ${GATEWAY_KEY}` ? (handlers.models ?? (() => json(200, { data: [{ id: 'auto/best-free' }, { id: 'alpha/works' }] })))() : json(401, { error: 'Invalid API key' });
    if (u.pathname.endsWith('/chat/completions')) return (handlers.chat ?? (() => chat('ok')))();
    throw new TypeError(`no script for ${u.pathname}`);
  }));
}

describe('Super Admin: OmniRoute layered check and Load models (scripted gateway)', () => {
  const app = createApp();
  let owner: ReturnType<typeof request.agent>;
  const originalFetch = globalThis.fetch;
  const check = (body: Record<string, unknown>) => owner.post('/api/dashboard/ai-routing/omniroute-check').send(body);

  beforeAll(async () => {
    getDb();
    setOmniRouteKeyFileEnabledForTests(false);
    expect((await request(app).post('/api/dashboard/auth/setup').send({ username: 'omni-check-owner', password: PASSWORD })).status).toBe(201);
    const id = (getDb().prepare('SELECT id FROM admin_users WHERE username = ?').get('omni-check-owner') as { id: number }).id;
    owner = request.agent(app).set('Cookie', `${SESSION_COOKIE_NAME}=${createSession(id).token}`);
  });
  afterAll(() => setOmniRouteKeyFileEnabledForTests(true));
  beforeEach(() => { mutableEnv.OMNIROUTE_API_KEY = ''; mutableEnv.OMNIROUTE_BASE_URL = ''; });
  afterEach(() => { vi.stubGlobal('fetch', originalFetch); mutableEnv.OMNIROUTE_API_KEY = ''; });

  it('Load models works with the key typed in the form even though the server has none configured, and never returns the key', async () => {
    gateway();
    const res = await owner.post('/api/dashboard/ai-routing/discover-models').send({ vendor: 'omniroute', baseUrl: 'http://127.0.0.1:20128/v1', apiKey: GATEWAY_KEY });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
    expect(res.body.models.map((m: { id: string }) => m.id)).toEqual(expect.arrayContaining(['auto/best-free', 'alpha/works']));
    expect(JSON.stringify(res.body)).not.toContain(GATEWAY_KEY);
    expect(seen.find((s) => s.url.endsWith('/models'))!.auth).toBe(`Bearer ${GATEWAY_KEY}`);
  });

  it('models listed is reported as "models listed", not as working, and no generation request is made', async () => {
    gateway();
    const res = await check({ baseUrl: 'http://127.0.0.1:20128/v1', apiKey: GATEWAY_KEY, model: 'auto/best-free' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ state: 'models_listed', layers: { reachable: true, keyAccepted: true, modelCount: 2, inference: 'not_run' } });
    expect(seen.some((s) => s.url.endsWith('/chat/completions'))).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain(GATEWAY_KEY);
  });

  it('a test request that returns text is the only thing that reports inference_ok, and it sends the typed key to the gateway only', async () => {
    gateway({ chat: () => chat('ok') });
    const res = await check({ baseUrl: 'http://127.0.0.1:20128/v1', apiKey: GATEWAY_KEY, model: 'alpha/works', probe: true });
    expect(res.body).toMatchObject({ state: 'inference_ok', layers: { inference: 'ok' } });
    const call = seen.find((s) => s.url.endsWith('/chat/completions'))!;
    expect(call.url).toBe('http://127.0.0.1:20128/v1/chat/completions');
    expect(call.auth).toBe(`Bearer ${GATEWAY_KEY}`);
    expect(JSON.stringify(res.body)).not.toContain(GATEWAY_KEY);
  });

  it('a gateway whose upstreams all failed is "no upstream", distinct from a rejected key and from rate limits', async () => {
    gateway({ chat: () => json(502, { error: { message: 'oc/a: rate limit — [429]: Free usage limit reached (HTTP 429); oc/b: model — [402]: needs a key (HTTP 402)', type: 'server_error', code: 'bad_gateway' } }) });
    const noUpstream = await check({ baseUrl: 'http://127.0.0.1:20128/v1', apiKey: GATEWAY_KEY, model: 'auto/best-free', probe: true });
    expect(noUpstream.body).toMatchObject({ state: 'no_upstream', layers: { reachable: true, keyAccepted: true, inference: 'failed' } });
    expect(noUpstream.body.message).toMatch(/none of its upstream provider accounts did/);
    expect(GATEWAY_SUMMARY_PREFIX.length).toBeGreaterThan(0);
    const rate = await (gateway({ chat: () => json(429, { error: { message: 'Rate limit exceeded: free-models-per-day' } }) }), check({ baseUrl: 'http://127.0.0.1:20128/v1', apiKey: GATEWAY_KEY, model: 'alpha/works', probe: true }));
    expect(rate.body.state).toBe('rate_limited');
  });

  it('a wrong gateway key is "invalid key" and no generation request is made; a stopped gateway is "unreachable"', async () => {
    gateway();
    const wrong = await check({ baseUrl: 'http://127.0.0.1:20128/v1', apiKey: 'sk-wrongwrongwrongwrongwrong0000', model: 'alpha/works', probe: true });
    expect(wrong.body).toMatchObject({ state: 'invalid_key', layers: { keyAccepted: false, inference: 'not_run' } });
    expect(seen.some((s) => s.url.endsWith('/chat/completions'))).toBe(false);
    gateway({ healthy: false });
    expect((await check({ baseUrl: 'http://127.0.0.1:20128/v1', apiKey: GATEWAY_KEY })).body).toMatchObject({ state: 'unreachable', layers: { reachable: false } });
  });

  it('an external or non-loopback address is refused before ANY request, so the key goes nowhere', async () => {
    gateway();
    for (const baseUrl of ['http://example.com:20128/v1', 'http://130.110.112.192:20128/v1', 'https://gateway.example.com/v1', 'http://10.0.0.5:20128/v1']) {
      const res = await check({ baseUrl, apiKey: GATEWAY_KEY, model: 'alpha/works', probe: true });
      expect(res.body, baseUrl).toMatchObject({ refused: true, layers: { reachable: false, inference: 'not_run' } });
    }
    expect(seen).toHaveLength(0);
  });

  it('requires a signed-in administrator', async () => {
    gateway();
    expect((await request(app).post('/api/dashboard/ai-routing/omniroute-check').send({ baseUrl: 'http://127.0.0.1:20128/v1', apiKey: GATEWAY_KEY })).status).toBe(401);
    expect(seen).toHaveLength(0);
  });
});
