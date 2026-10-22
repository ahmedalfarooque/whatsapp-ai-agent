import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';

/**
 * The OmniRoute "Load models" button in the LOCAL window. On the live site the server reads ITS gateway; in the local window the gateway is the one on THIS PC, so the proxy answers
 * the request itself (after production confirms the person's session) instead of forwarding it. Scripted gateway and upstream: production is never contacted.
 */
const require = createRequire(import.meta.url);
const proxy = require('../../../scripts/dev-proxy.cjs') as {
  decide: (m: string, p: string, mode?: string) => { allow: boolean; reason: string; local?: string };
  createProxyServer: (o: Record<string, unknown>) => http.Server & { proxyState: { port: number } };
};
const localTest = require('../../../scripts/local-ai-test.cjs') as {
  listOmniRouteModelsLocal: (o: Record<string, unknown>) => Promise<{ reachable: boolean; keyFound: boolean; baseUrl: string; models: string[]; reason?: string; truncated?: boolean }>;
  matchOmniRouteModels: (m: string, p: string) => boolean;
};
const PATH = '/api/dashboard/ai-routing/omniroute/models';
const KEY = 'sk-localomnimodelskey0123456789';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const fakeFetch = (handler: (url: string) => Response | Promise<Response>) => {
  const calls: Array<{ url: string; headers: Record<string, string>; redirect?: string }> = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, redirect: init?.redirect }); return handler(String(url)); }) as typeof fetch;
  return { fetch: fn, calls };
};
const healthy = () => json(200, { status: 'healthy' });
const noFile = async () => null;

describe('policy', () => {
  it('the model list is answered locally in every mode (a read of THIS PC\'s gateway); nothing else changed', () => {
    for (const mode of ['read-only', 'business-data']) {
      const v = proxy.decide('GET', PATH, mode);
      expect(v.local, mode).toBe('omniroute-models');
      expect(v.allow, mode).toBe(false); // never forwarded to production
    }
    expect(localTest.matchOmniRouteModels('GET', PATH)).toBe(true);
    for (const [m, p] of [['POST', PATH], ['GET', `${PATH}/x`], ['GET', '/api/dashboard/ai-routing/omniroute'], ['GET', '/api/dashboard/super-admin/ai/omniroute/models']] as const) expect(localTest.matchOmniRouteModels(m, p), `${m} ${p}`).toBe(false);
    expect(proxy.decide('GET', '/api/dashboard/ai-routing', 'read-only').allow).toBe(true); // the page the session check reads
    expect(proxy.decide('POST', PATH, 'business-data').allow).toBe(false);
  });
});

describe('reading the gateway on this PC', () => {
  it('lists its models, its own auto/ combos first, with this PC\'s key — never returned — and redirects refused', async () => {
    const g = fakeFetch((u) => (u.endsWith('/health') ? healthy() : json(200, { data: [{ id: 'z/model' }, { id: 'auto/best-free' }, { id: 'a/model' }, { id: 'ftp://bad/x' }, { id: 'bad id' }] })));
    const r = await localTest.listOmniRouteModelsLocal({ fetch: g.fetch, env: { OMNIROUTE_API_KEY: KEY } });
    expect(r).toEqual({ reachable: true, keyFound: true, baseUrl: 'http://127.0.0.1:20128/v1', models: ['auto/best-free', 'a/model', 'z/model'], truncated: false });
    expect(JSON.stringify(r)).not.toContain(KEY);
    const call = g.calls.find((c) => c.url.endsWith('/models'))!;
    expect(call.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(call.redirect).toBe('error');
    expect(g.calls.find((c) => c.url.endsWith('/health'))!.headers.Authorization).toBeUndefined();
  });

  it('says what is missing: not running (no key sent), no key on this PC, key rejected, unreadable', async () => {
    const down = fakeFetch(() => { throw new TypeError('connect ECONNREFUSED'); });
    expect(await localTest.listOmniRouteModelsLocal({ fetch: down.fetch, env: { OMNIROUTE_API_KEY: KEY } })).toMatchObject({ reachable: false, models: [], reason: 'not_running' });
    expect(down.calls.every((c) => c.url.endsWith('/health'))).toBe(true);
    const up = fakeFetch(() => healthy());
    expect(await localTest.listOmniRouteModelsLocal({ fetch: up.fetch, env: {}, discoverOmniRouteKey: noFile })).toMatchObject({ reachable: true, keyFound: false, reason: 'no_key' });
    expect(up.calls).toHaveLength(1); // only the health probe: nothing to authenticate with
    expect(await localTest.listOmniRouteModelsLocal({ fetch: up.fetch, env: { OMNIROUTE_API_KEY: 'not an omniroute key at all' }, discoverOmniRouteKey: noFile })).toMatchObject({ reason: 'no_key' });
    expect(await localTest.listOmniRouteModelsLocal({ fetch: fakeFetch((u) => (u.endsWith('/health') ? healthy() : json(401, {}))).fetch, env: { OMNIROUTE_API_KEY: KEY } })).toMatchObject({ keyFound: true, reason: 'rejected' });
    expect(await localTest.listOmniRouteModelsLocal({ fetch: fakeFetch((u) => (u.endsWith('/health') ? healthy() : json(200, { nope: 1 }))).fetch, env: { OMNIROUTE_API_KEY: KEY } })).toMatchObject({ reason: 'unreadable' });
  });

  it('OMNIROUTE_BASE_URL from this PC\'s environment is honoured only when it is the loopback gateway; anything else falls back to the local default', async () => {
    const mk = () => fakeFetch((u) => (u.endsWith('/health') ? healthy() : json(200, { data: [{ id: 'm/one' }] })));
    const ok = mk();
    expect((await localTest.listOmniRouteModelsLocal({ fetch: ok.fetch, env: { OMNIROUTE_API_KEY: KEY, OMNIROUTE_BASE_URL: 'http://localhost:20999/v1/' } })).baseUrl).toBe('http://localhost:20999/v1');
    expect(ok.calls.every((c) => c.url.startsWith('http://localhost:20999/'))).toBe(true);
    for (const bad of ['https://evil.example/v1', 'http://10.0.0.5:20128/v1', 'http://user:pw@127.0.0.1:20128/v1', 'not a url']) {
      const g = mk();
      expect((await localTest.listOmniRouteModelsLocal({ fetch: g.fetch, env: { OMNIROUTE_API_KEY: KEY, OMNIROUTE_BASE_URL: bad } })).baseUrl, bad).toBe('http://127.0.0.1:20128/v1');
      expect(g.calls.every((c) => c.url.startsWith('http://127.0.0.1:20128/')), bad).toBe(true); // the key never went anywhere else
    }
  });
});

describe('the local server', () => {
  let upstream: http.Server;
  let server: http.Server & { proxyState: { port: number } };
  const seen: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders }> = [];
  let status = 200;
  let listed = 0;
  const listen = (s: http.Server): Promise<number> => new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port)));
  const get = (p: string, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> => new Promise((resolve, reject) => {
    const port = server.proxyState.port;
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: p, headers: { host: `workspace.localhost:${port}`, ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: body ? JSON.parse(body) : {} }));
    });
    req.on('error', reject);
    req.end();
  });
  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status === 200 ? { providers: [] } : { error: 'unauthenticated' }));
    });
    const port = await listen(upstream);
    server = proxy.createProxyServer({
      upstream: `http://127.0.0.1:${port}`, mode: 'read-only',
      listLocalModels: async () => { listed += 1; return { reachable: true, keyFound: true, baseUrl: 'http://127.0.0.1:20128/v1', models: ['auto/best-free'] }; },
    }) as typeof server;
    server.proxyState.port = await listen(server);
  });
  afterAll(async () => { for (const s of [server, upstream]) await new Promise((r) => s.close(() => r(null))); });

  it('with a session production accepts, the list is read from this PC\'s gateway; production only confirms the session (one read, nothing written)', async () => {
    seen.length = 0; listed = 0; status = 200;
    const r = await get(PATH, { cookie: 'ws=SESSION' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ reachable: true, models: ['auto/best-free'] });
    expect(listed).toBe(1);
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(['GET /api/dashboard/ai-routing']);
    expect(seen[0]!.headers.cookie).toBe('ws=SESSION');
  });

  it('without a valid session the gateway is not read at all', async () => {
    seen.length = 0; listed = 0; status = 401;
    expect((await get(PATH)).status).toBe(401);
    status = 403;
    expect((await get(PATH)).status).toBe(403);
    expect(listed).toBe(0);
    status = 200;
  });
});
