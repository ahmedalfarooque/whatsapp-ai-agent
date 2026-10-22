import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';

/**
 * The local window's AI-provider Test button. The window is a read-only proxy onto PRODUCTION data, and a provider test on production would use production's key, spend its
 * quota and write its database. So the proxy never forwards the test: it answers it locally (scripts/local-ai-test.cjs) with a real, minimal inference from THIS PC using
 * THIS PC's key. Everything here is scripted (a disposable loopback upstream and a fake `fetch`): it proves the routing, the isolation and the honesty of the answers, not that
 * a given provider is up today — the real-inference check against live providers is a separate, clearly labelled run.
 */
const require = createRequire(import.meta.url);
const proxy = require('../../../scripts/dev-proxy.cjs') as {
  decide: (m: string, p: string, mode?: string) => { allow: boolean; reason: string; local?: string };
  createProxyServer: (o: Record<string, unknown>) => http.Server & { proxyState: { port: number } };
};
type LocalResult = { ok: boolean; detail: string; category?: string; skipped?: boolean; httpStatus?: number; local: boolean; latencyMs: number };
const localTest = require('../../../scripts/local-ai-test.cjs') as {
  runLocalProviderTest: (view: Record<string, unknown>, o: Record<string, unknown>) => Promise<LocalResult>;
  matchProviderTest: (m: string, p: string) => { id: number; list: string } | null;
  endpointRefusal: (u: string) => string | null;
};

const LOCAL_KEY = 'gsk_local_test_key_0123456789abcdef';
const OMNI_KEY = 'sk-omniroutelocalkey0123456789';
const view = (over: Record<string, unknown> = {}) => ({ id: 7, name: 'Groq', vendor: 'groq', adapter: 'openai', kind: 'openai_compatible', baseUrl: 'https://api.groq.com/openai/v1', models: ['llama-3.1-8b-instant'], visionModels: [], freeTier: true, freeConfirmed: true, keyMasked: 'gsk_…cdef', hasKey: true, timeoutMs: 20000, ...over });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const chat = (text: string) => json(200, { choices: [{ index: 0, message: { role: 'assistant', content: text } }] });

type Call = { url: string; init: RequestInit };
function fakeFetch(handler: (call: Call, n: number) => Response | Promise<Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => { const call = { url: String(url), init: init ?? {} }; calls.push(call); return handler(call, calls.length); }) as typeof fetch;
  return { fetch: fn, calls };
}
const headersOf = (call: Call): Record<string, string> => call.init.headers as Record<string, string>;

describe('policy: a provider test is answered locally, never forwarded, in every mode', () => {
  it('POST .../providers/:id/test is not allowed to reach production but is marked for the local runner (read-only and business-data alike)', () => {
    for (const mode of ['read-only', 'business-data']) {
      for (const p of ['/api/dashboard/super-admin/ai/providers/1/test', '/api/dashboard/ai-routing/providers/12/test']) {
        const v = proxy.decide('POST', p, mode);
        expect(v.allow, `${mode} ${p}`).toBe(false);
        expect(v.local, `${mode} ${p}`).toBe('ai-provider-test');
      }
    }
    expect(localTest.matchProviderTest('POST', '/api/dashboard/super-admin/ai/providers/5/test')).toEqual({ id: 5, list: '/api/dashboard/super-admin/ai' });
    expect(localTest.matchProviderTest('POST', '/api/dashboard/ai-routing/providers/5/test')).toEqual({ id: 5, list: '/api/dashboard/ai-routing' });
  });

  it('nothing else about the window changed: provider saves, key changes, order, enable/disable, removal, the default-entry test and every other write stay blocked with a plain reason', () => {
    for (const mode of ['read-only', 'business-data']) {
      for (const [m, p] of [['POST', '/api/dashboard/super-admin/ai/providers'], ['PUT', '/api/dashboard/super-admin/ai/providers/7'], ['PUT', '/api/dashboard/super-admin/ai/providers/order'], ['POST', '/api/dashboard/super-admin/ai/providers/7/disable'],
        ['POST', '/api/dashboard/super-admin/ai/providers/7/confirm-free'], ['DELETE', '/api/dashboard/super-admin/ai/providers/7'], ['POST', '/api/dashboard/super-admin/ai/adopt-openrouter'], ['POST', '/api/dashboard/ai-routing/providers'],
        ['POST', '/api/dashboard/ai-routing/entries/default/test'], ['PUT', '/api/dashboard/credentials/openrouter'], ['POST', '/api/dashboard/handoffs/1/reply']] as const) {
        const v = proxy.decide(m, p, mode);
        expect(v.allow, `${mode} ${m} ${p}`).toBe(false);
        expect(v.local, `${mode} ${m} ${p}`).toBeUndefined();
      }
    }
    expect(proxy.decide('PUT', '/api/dashboard/super-admin/ai/providers/7', 'read-only').reason).toMatch(/saved on production only/);
    expect(proxy.decide('POST', '/api/dashboard/super-admin/ai/providers/7/test', 'read-only').allow).toBe(false); // still "not forwarded"
    expect(proxy.decide('GET', '/api/dashboard/super-admin/ai', 'read-only').allow).toBe(true); // the list the Test button reads from
    expect(proxy.decide('GET', '/api/dashboard/super-admin/ai/providers/7/test', 'read-only').allow).toBe(true); // a GET is just a read (and production has no such route)
  });

  it('a malformed id or a traversal never matches the local route', () => {
    for (const p of ['/api/dashboard/super-admin/ai/providers/x/test', '/api/dashboard/super-admin/ai/providers/1/test/extra', '/api/dashboard/super-admin/ai/providers/../1/test', '/api/dashboard/other/providers/1/test']) {
      expect(localTest.matchProviderTest('POST', p), p).toBeNull();
    }
    expect(localTest.matchProviderTest('PUT', '/api/dashboard/super-admin/ai/providers/1/test')).toBeNull();
  });
});

describe('the local server answers the Test button itself and sends production nothing', () => {
  let upstream: http.Server;
  let server: http.Server & { proxyState: { port: number } };
  const seen: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders }> = [];
  let listStatus = 200;
  let providers: unknown[] = [view()];
  const tested: Array<Record<string, unknown>> = [];

  const listen = (s: http.Server): Promise<number> => new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port)));
  const post = (p: string, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> & { provider?: Record<string, unknown> } }> =>
    new Promise((resolve, reject) => {
      const port = server.proxyState.port;
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: p, headers: { host: `workspace.localhost:${port}`, 'content-type': 'application/json', ...headers } }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: body ? JSON.parse(body) : {} }));
      });
      req.on('error', reject);
      req.end('{}');
    });

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
      res.writeHead(listStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(listStatus === 200 ? { providers } : { error: listStatus === 401 ? 'unauthenticated' : 'forbidden' }));
    });
    const upstreamPort = await listen(upstream);
    server = proxy.createProxyServer({
      upstream: `http://127.0.0.1:${upstreamPort}`, mode: 'read-only',
      runLocalTest: async (v: Record<string, unknown>) => { tested.push(v); return { ok: true, detail: 'Model m answered a real test request (run from this PC with this PC\'s own key; production was not touched).', latencyMs: 12, category: 'ok', local: true }; },
    }) as typeof server;
    server.proxyState.port = await listen(server);
  });
  afterAll(async () => { for (const s of [server, upstream]) await new Promise((r) => s.close(() => r(null))); });

  it('the Test button works in the read-only window: the provider is READ from production with the person\'s own session, tested locally, and production receives no write', async () => {
    seen.length = 0; tested.length = 0; listStatus = 200; providers = [view({ id: 6, name: 'Other' }), view({ id: 7 })];
    const r = await post('/api/dashboard/super-admin/ai/providers/7/test', { cookie: 'ws=SESSION', origin: `http://workspace.localhost:${server.proxyState.port}` });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, local: true, category: 'ok' });
    expect(r.body.provider).toMatchObject({ id: 7, name: 'Groq' });
    expect(tested).toHaveLength(1);
    expect(tested[0]).toMatchObject({ id: 7, vendor: 'groq' });
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(['GET /api/dashboard/super-admin/ai']); // ONE read; no POST, PUT or DELETE ever left this machine
    expect(seen[0]!.headers.cookie).toBe('ws=SESSION'); // production's own permission check decides who may see the provider
    expect(JSON.stringify(r.body)).not.toContain(LOCAL_KEY);
  });

  it('a business provider is read from the business page, with the selected business', async () => {
    seen.length = 0; listStatus = 200; providers = [view({ id: 12 })];
    const r = await post('/api/dashboard/ai-routing/providers/12/test', { cookie: 'ws=S', 'x-whatsapp-account': '3' });
    expect(r.status).toBe(200);
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(['GET /api/dashboard/ai-routing']);
    expect(seen[0]!.headers['x-whatsapp-account']).toBe('3');
  });

  it('an unknown provider is a 404, an unauthenticated or unauthorised person gets production\'s own answer, and nothing is tested', async () => {
    tested.length = 0; providers = [view({ id: 7 })]; listStatus = 200;
    expect((await post('/api/dashboard/super-admin/ai/providers/99/test')).status).toBe(404);
    listStatus = 401;
    expect((await post('/api/dashboard/super-admin/ai/providers/7/test')).status).toBe(401);
    listStatus = 403;
    expect((await post('/api/dashboard/super-admin/ai/providers/7/test')).status).toBe(403);
    expect(tested).toHaveLength(0);
    listStatus = 200;
  });

  it('a cross-origin request is refused before production is even asked', async () => {
    seen.length = 0; tested.length = 0;
    expect((await post('/api/dashboard/super-admin/ai/providers/7/test', { origin: 'https://evil.example' })).status).toBe(403);
    expect((await post('/api/dashboard/super-admin/ai/providers/7/test', { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect(seen).toHaveLength(0);
    expect(tested).toHaveLength(0);
  });

  it('saving a provider from the local window is still refused, with the reason shown to the person instead of a bare code', async () => {
    seen.length = 0;
    const r = await post('/api/dashboard/super-admin/ai/providers/7', { origin: `http://workspace.localhost:${server.proxyState.port}` });
    expect([403, 405]).toContain(r.status);
    const put = await new Promise<{ status: number; body: { error?: string; message?: string } }>((resolve, reject) => {
      const port = server.proxyState.port;
      const req = http.request({ host: '127.0.0.1', port, method: 'PUT', path: '/api/dashboard/super-admin/ai/providers/7', headers: { host: `workspace.localhost:${port}` } }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(body) }));
      });
      req.on('error', reject);
      req.end('{}');
    });
    expect(put.status).toBe(403);
    expect(put.body.error).toBe('blocked_by_local_window');
    expect(put.body.message).toMatch(/saved on production only/);
    expect(put.body.message).toMatch(/Test button/);
    expect(seen).toHaveLength(0);
  });
});

describe('the local test itself: a real, minimal inference from this PC with this PC\'s own key', () => {
  const env = { GROQ_API_KEY: LOCAL_KEY } as Record<string, string>;

  it('sends one tiny request straight to the provider with the LOCAL key (never anything from production), and reports success only on a real answer', async () => {
    const f = fakeFetch(() => chat('ok'));
    const r = await localTest.runLocalProviderTest(view(), { fetch: f.fetch, env });
    expect(r).toMatchObject({ ok: true, local: true, category: 'ok' });
    expect(r.detail).toMatch(/real test request/);
    expect(r.detail).toMatch(/production was not touched/);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(headersOf(f.calls[0]!).Authorization).toBe(`Bearer ${LOCAL_KEY}`);
    expect(f.calls[0]!.init.redirect).toBe('error'); // an accepted address can never bounce the key elsewhere
    const body = JSON.parse(String(f.calls[0]!.init.body));
    expect(body).toMatchObject({ model: 'llama-3.1-8b-instant', max_tokens: 64, temperature: 0 });
    expect(JSON.stringify(body)).toContain('Reply with the single word: ok'); // a neutral prompt: no customer data
    expect(JSON.stringify(r)).not.toContain(LOCAL_KEY);
  });

  it('Gemini uses its own request shape and header', async () => {
    const f = fakeFetch(() => json(200, { candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
    const r = await localTest.runLocalProviderTest(view({ vendor: 'google', adapter: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', models: ['gemini-2.5-flash'] }), { fetch: f.fetch, env: { GEMINI_API_KEY: 'AIzaSyLocalGeminiKey0123456789abcdef' } });
    expect(r.ok).toBe(true);
    expect(f.calls[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    expect(headersOf(f.calls[0]!)['x-goog-api-key']).toBe('AIzaSyLocalGeminiKey0123456789abcdef');
    expect(headersOf(f.calls[0]!).Authorization).toBeUndefined();
  });

  it('HTTP 200 with no text is NOT a pass; an empty answer is retried ONCE with a larger bounded budget (a reasoning model), and only for that case', async () => {
    const empty = fakeFetch((_c, n) => (n === 1 ? chat('') : chat('ok')));
    expect((await localTest.runLocalProviderTest(view(), { fetch: empty.fetch, env })).ok).toBe(true);
    expect(empty.calls.map((c) => JSON.parse(String(c.init.body)).max_tokens)).toEqual([64, 256]);
    const never = fakeFetch(() => chat(''));
    const r = await localTest.runLocalProviderTest(view(), { fetch: never.fetch, env });
    expect(r).toMatchObject({ ok: false, category: 'empty_response' });
    expect(never.calls).toHaveLength(2); // bounded
  });

  it('failures are reported honestly, classified, never retried blindly, and without echoing the key or the provider\'s body', async () => {
    for (const [status, category] of [[401, 'credential'], [403, 'credential'], [402, 'payment_required'], [404, 'model_unavailable'], [429, 'rate_limited'], [503, 'provider_error']] as const) {
      const f = fakeFetch(() => json(status, { error: { message: `secret detail ${LOCAL_KEY}` } }));
      const r = await localTest.runLocalProviderTest(view(), { fetch: f.fetch, env });
      expect(r, String(status)).toMatchObject({ ok: false, category, httpStatus: status, local: true });
      expect(f.calls, String(status)).toHaveLength(1); // no retry on a rate limit or an outage
      expect(JSON.stringify(r)).not.toContain(LOCAL_KEY);
      expect(JSON.stringify(r)).not.toContain('secret detail');
      expect(r.detail).toMatch(/production was not touched/);
    }
    const down = await localTest.runLocalProviderTest(view(), { fetch: fakeFetch(() => { throw new TypeError('connect ECONNREFUSED'); }).fetch, env });
    expect(down).toMatchObject({ ok: false, category: 'network' });
    const slow = await localTest.runLocalProviderTest(view(), { fetch: fakeFetch(() => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; }).fetch, env });
    expect(slow).toMatchObject({ ok: false, category: 'timeout' });
  });

  it('no local key: nothing is sent, the exact variable to set is named, and production\'s key is explained as unavailable', async () => {
    const f = fakeFetch(() => chat('ok'));
    const r = await localTest.runLocalProviderTest(view(), { fetch: f.fetch, env: {} });
    expect(r).toMatchObject({ ok: false, skipped: true, category: 'no_local_key' });
    expect(r.detail).toContain('GROQ_API_KEY');
    expect(r.detail).toMatch(/never revealed/);
    expect(f.calls).toHaveLength(0);
    for (const bad of ['short', 'has space in the key 0123456789', '']) {
      expect((await localTest.runLocalProviderTest(view(), { fetch: f.fetch, env: { GROQ_API_KEY: bad } })).category, bad).toBe('no_local_key');
    }
    expect(f.calls).toHaveLength(0);
  });

  it('a paid provider, a private or internal address, a non-HTTPS address and a missing model are refused without any request', async () => {
    const f = fakeFetch(() => chat('ok'));
    expect(await localTest.runLocalProviderTest(view({ freeTier: false }), { fetch: f.fetch, env })).toMatchObject({ ok: false, skipped: true, category: 'paid_route' });
    for (const baseUrl of ['http://10.0.0.5/v1', 'https://192.168.1.10/v1', 'https://169.254.169.254/latest', 'http://api.groq.com/openai/v1', 'https://intranet/v1', 'https://user:pw@api.groq.com/v1', 'ftp://x.example/v1', 'not a url']) {
      expect(await localTest.runLocalProviderTest(view({ baseUrl }), { fetch: f.fetch, env }), baseUrl).toMatchObject({ ok: false, skipped: true, category: 'endpoint' });
    }
    expect((await localTest.runLocalProviderTest(view({ models: [] }), { fetch: f.fetch, env })).category).toBe('model_required');
    expect(f.calls).toHaveLength(0);
    expect(localTest.endpointRefusal('http://127.0.0.1:20128/v1')).toBeNull(); // this PC's own gateway is the one plain-HTTP address that is fine
    expect(localTest.endpointRefusal('https://api.groq.com/openai/v1')).toBeNull();
  });

  describe('OmniRoute on this PC', () => {
    const omni = (over: Record<string, unknown> = {}) => view({ id: 3, name: 'OmniRoute', vendor: 'omniroute', adapter: 'openai', baseUrl: 'http://127.0.0.1:20128/v1', models: ['auto/best-free'], ...over });

    it('not running: nothing is sent to it, and the message names the missing dependency', async () => {
      const f = fakeFetch(() => { throw new TypeError('connect ECONNREFUSED'); });
      const r = await localTest.runLocalProviderTest(omni(), { fetch: f.fetch, env: { OMNIROUTE_API_KEY: OMNI_KEY } });
      expect(r).toMatchObject({ ok: false, skipped: true, category: 'omniroute_not_running' });
      expect(r.detail).toMatch(/omniroute/);
      expect(f.calls.every((c) => c.url.endsWith('/api/monitoring/health'))).toBe(true); // the key was never sent to a gateway that is not demonstrably OmniRoute
    });

    it('running but with no client key on this PC: no key is invented and none is sent', async () => {
      const f = fakeFetch(() => json(200, { status: 'healthy' }));
      const r = await localTest.runLocalProviderTest(omni(), { fetch: f.fetch, env: {}, discoverOmniRouteKey: async () => null });
      expect(r).toMatchObject({ ok: false, skipped: true, category: 'no_local_key' });
      expect(r.detail).toContain('OMNIROUTE_API_KEY');
      expect(f.calls).toHaveLength(1); // only the health probe
    });

    it('running with a key (from .env / the environment, or its own key file on this PC): a real chat request goes to the loopback gateway only', async () => {
      const f = fakeFetch((c) => (c.url.endsWith('/health') ? json(200, { status: 'healthy' }) : chat('ok')));
      const r = await localTest.runLocalProviderTest(omni(), { fetch: f.fetch, env: {}, discoverOmniRouteKey: async () => OMNI_KEY });
      expect(r).toMatchObject({ ok: true, category: 'ok' });
      const chatCall = f.calls.find((c) => c.url.endsWith('/chat/completions'))!;
      expect(chatCall.url).toBe('http://127.0.0.1:20128/v1/chat/completions');
      expect(headersOf(chatCall).Authorization).toBe(`Bearer ${OMNI_KEY}`);
      expect(JSON.stringify(r)).not.toContain(OMNI_KEY);
    });

    it('a key that is not shaped like an OmniRoute key is never sent to the gateway', async () => {
      const f = fakeFetch(() => json(200, { status: 'healthy' }));
      const r = await localTest.runLocalProviderTest(omni(), { fetch: f.fetch, env: { OMNIROUTE_API_KEY: 'not an omniroute key at all 123456' }, discoverOmniRouteKey: async () => null });
      expect(r.category).toBe('no_local_key');
      expect(f.calls.every((c) => c.url.endsWith('/health'))).toBe(true);
    });

    it('an unhealthy answer ("degraded") is not OmniRoute being up', async () => {
      const f = fakeFetch(() => json(200, { status: 'degraded' }));
      expect((await localTest.runLocalProviderTest(omni(), { fetch: f.fetch, env: { OMNIROUTE_API_KEY: OMNI_KEY } })).category).toBe('omniroute_not_running');
    });
  });
});
