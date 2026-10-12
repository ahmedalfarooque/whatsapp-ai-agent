import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// scripts/dev-proxy.cjs: the local dashboard on PRODUCTION DATA. Tested against a disposable loopback "upstream"; production is never contacted.
const require = createRequire(import.meta.url);
const proxy = require('../../../scripts/dev-proxy.cjs') as {
  decide: (m: string, p: string, mode?: string) => { allow: boolean; reason: string };
  createProxyServer: (o: Record<string, unknown>) => http.Server & { proxyState: { port: number } };
  isAllowedUpstream: (v: string) => boolean;
  rewriteSetCookie: (v: string) => string;
  PRODUCTION_UPSTREAM: string;
};

describe('policy: what the local window may forward to production', () => {
  const ro = (m: string, p: string) => proxy.decide(m, p, 'read-only').allow;
  const rw = (m: string, p: string) => proxy.decide(m, p, 'business-data').allow;

  it('read-only (the default) lets you look at everything except pairing, credentials and webhook secrets, and writes nothing', () => {
    for (const p of ['/api/dashboard/accounts', '/api/dashboard/overview', '/api/dashboard/conversations', '/api/dashboard/customers/4', '/api/dashboard/accounts/3/logo', '/health']) expect(ro('GET', p), p).toBe(true);
    for (const p of ['/api/dashboard/accounts/3/qr', '/api/dashboard/whatsapp/qr', '/api/dashboard/credentials', '/api/dashboard/credentials/openrouter', '/api/dashboard/webhook-info']) expect(ro('GET', p), p).toBe(false);
    for (const [m, p] of [['POST', '/api/dashboard/offers'], ['PUT', '/api/dashboard/business-profile'], ['DELETE', '/api/dashboard/accounts/2'], ['POST', '/api/dashboard/handoffs/1/reply']] as const) expect(ro(m, p), `${m} ${p}`).toBe(false);
  });

  it('signing in and out of your own session is allowed in every mode; first-run setup and logout-all are not', () => {
    for (const p of ['/api/dashboard/auth/login', '/api/dashboard/auth/logout', '/api/dashboard/auth/otp/verify']) { expect(ro('POST', p), p).toBe(true); expect(rw('POST', p), p).toBe(true); }
    expect(ro('POST', '/api/dashboard/auth/setup')).toBe(false);
    expect(rw('POST', '/api/dashboard/auth/logout-all')).toBe(false);
  });

  it('--write-business-data allows business content only', () => {
    for (const [m, p] of [['PUT', '/api/dashboard/business-profile'], ['POST', '/api/dashboard/offers'], ['PUT', '/api/dashboard/offers/2'], ['POST', '/api/dashboard/offers/2/activate'], ['POST', '/api/dashboard/templates/welcome/publish'],
      ['PATCH', '/api/dashboard/automation'], ['PUT', '/api/dashboard/knowledge/faq.md'], ['PUT', '/api/dashboard/accounts/3/setup/profile'], ['POST', '/api/dashboard/customers/4/notes'], ['POST', '/api/dashboard/requests/9/quotation/draft'],
      ['POST', '/api/dashboard/documents'], ['PATCH', '/api/dashboard/realestate/leads/5']] as const) expect(rw(m, p), `${m} ${p}`).toBe(true);
  });

  it('...and never anything that connects WhatsApp, sends a message, or changes users, credentials, keys or settings', () => {
    for (const [m, p] of [['POST', '/api/dashboard/accounts'], ['PUT', '/api/dashboard/accounts/1'], ['DELETE', '/api/dashboard/accounts/4'], ['POST', '/api/dashboard/accounts/1/disable'], ['POST', '/api/dashboard/accounts/4/qr/connect'],
      ['POST', '/api/dashboard/whatsapp/qr/connect'], ['POST', '/api/dashboard/whatsapp/configure'], ['POST', '/api/dashboard/whatsapp/sync'], ['POST', '/api/dashboard/handoffs/1/reply'], ['POST', '/api/dashboard/handoffs/1/accept'],
      ['POST', '/api/dashboard/customers/4/take-over'], ['POST', '/api/dashboard/requests/9/quotation/send'], ['POST', '/api/dashboard/requests/9/status'], ['POST', '/api/dashboard/notifications/flush'], ['POST', '/api/dashboard/notifications/3/retry'],
      ['POST', '/api/dashboard/users'], ['POST', '/api/dashboard/users/2/reset-password'], ['PUT', '/api/dashboard/credentials/openrouter'], ['POST', '/api/dashboard/ai/configure'], ['PUT', '/api/dashboard/settings']] as const) expect(rw(m, p), `${m} ${p}`).toBe(false);
  });

  it('refuses malformed and traversal paths and anything outside the dashboard API', () => {
    for (const p of ['/api/dashboard/../../etc/passwd', '/api/dashboard/%2e%2e/x', '/api/dashboard//accounts', '/api/dashboard/a\\b', '/etc/passwd', '/']) expect(ro('GET', p), p).toBe(false);
  });
});

describe('upstream and cookies', () => {
  it('only production (or a loopback test server with a port) may be the upstream', () => {
    expect(proxy.isAllowedUpstream(proxy.PRODUCTION_UPSTREAM)).toBe(true);
    expect(proxy.isAllowedUpstream('http://127.0.0.1:4567')).toBe(true);
    for (const bad of ['https://evil.example', 'https://whatsapp.alfarooque.com.evil.example', 'https://whatsapp.alfarooque.com/api', 'http://127.0.0.1', 'http://10.0.0.5:3000', 'file:///etc/passwd', 'not a url']) expect(proxy.isAllowedUpstream(bad), bad).toBe(false);
    expect(() => proxy.createProxyServer({ upstream: 'https://evil.example' })).toThrow(/refusing upstream/);
  });

  it('re-issues the session cookie without Secure and Domain so it is scoped to workspace.localhost only', () => {
    expect(proxy.rewriteSetCookie('ws=abc; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=3600; Domain=whatsapp.alfarooque.com')).toBe('ws=abc; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600');
  });
});

describe('the local server (against a disposable upstream)', () => {
  let upstream: http.Server;
  let upstreamPort = 0;
  const seen: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders }> = [];
  let readOnly: http.Server & { proxyState: { port: number } };
  let writeMode: http.Server & { proxyState: { port: number } };

  const listen = (s: http.Server): Promise<number> => new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port)));
  const call = (server: http.Server & { proxyState: { port: number } }, method: string, p: string, headers: Record<string, string> = {}, host?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> =>
    new Promise((resolve, reject) => {
      const port = server.proxyState.port;
      const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: host ?? `workspace.localhost:${port}`, ...headers } }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      });
      req.on('error', reject);
      req.end(method === 'GET' ? undefined : '{}');
    });

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': ['ws=TOKEN; Path=/; HttpOnly; Secure; SameSite=Strict; Domain=whatsapp.alfarooque.com'], 'Strict-Transport-Security': 'max-age=1', 'Content-Security-Policy': "default-src 'none'" });
      res.end(JSON.stringify({ ok: true, accounts: 4 }));
    });
    upstreamPort = await listen(upstream);
    readOnly = proxy.createProxyServer({ upstream: `http://127.0.0.1:${upstreamPort}`, mode: 'read-only' });
    readOnly.proxyState.port = await listen(readOnly);
    writeMode = proxy.createProxyServer({ upstream: `http://127.0.0.1:${upstreamPort}`, mode: 'business-data' });
    writeMode.proxyState.port = await listen(writeMode);
  });
  afterAll(async () => { for (const s of [readOnly, writeMode, upstream]) await new Promise((r) => s.close(() => r(null))); });

  it('answers only on workspace.localhost:<port> (cookie scope and DNS-rebinding guard)', async () => {
    for (const host of ['localhost:1', '127.0.0.1:1', 'evil.example']) {
      const r = await call(readOnly, 'GET', '/dashboard', {}, host);
      expect(r.status, host).toBe(421);
    }
  });

  it('serves the dashboard from THIS checkout, and a build identifier that names the commit and the data source', async () => {
    const page = await call(readOnly, 'GET', '/dashboard');
    expect(page.status).toBe(200);
    expect(page.body).toBe(readFileSync(path.resolve(__dirname, '..', '..', '..', 'dashboard', 'index.html'), 'utf8'));
    const info = JSON.parse((await call(readOnly, 'GET', '/dashboard/build-info.json')).body);
    expect(info).toMatchObject({ environment: 'local-ui', dataSource: 'production', mode: 'read-only' });
    expect(info.commit).toMatch(/^[0-9a-f]{7,}$/);
    expect((await call(readOnly, 'GET', '/dashboard/../package.json')).status).toBeGreaterThanOrEqual(400);
    expect((await call(readOnly, 'GET', '/dashboard/%2e%2e/package.json')).status).toBeGreaterThanOrEqual(400);
  });

  it('forwards reads to production with production\'s own host, passes the session cookie through and re-scopes the cookie it gets back', async () => {
    seen.length = 0;
    const r = await call(readOnly, 'GET', '/api/dashboard/accounts', { cookie: 'ws=MYSESSION' });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true, accounts: 4 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers.host).toBe(`127.0.0.1:${upstreamPort}`);
    expect(seen[0]!.headers.cookie).toBe('ws=MYSESSION');
    expect(String(r.headers['set-cookie'])).toBe('ws=TOKEN; Path=/; HttpOnly; SameSite=Strict');
    expect(r.headers['strict-transport-security']).toBeUndefined();
    expect(r.headers['content-security-policy']).toBeUndefined();
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('read-only: a write never reaches production; sign-in does', async () => {
    seen.length = 0;
    const blocked = await call(readOnly, 'POST', '/api/dashboard/offers');
    expect(blocked.status).toBe(403);
    expect(JSON.parse(blocked.body).error).toBe('blocked_by_local_window');
    expect(seen).toHaveLength(0);
    const login = await call(readOnly, 'POST', '/api/dashboard/auth/login', { origin: `http://workspace.localhost:${readOnly.proxyState.port}` });
    expect(login.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers.origin).toBe(`http://127.0.0.1:${upstreamPort}`); // production sees its own origin, not the local one
  });

  it('--write-business-data: business content goes through; WhatsApp connection and sending are refused before they leave this machine', async () => {
    seen.length = 0;
    expect((await call(writeMode, 'PUT', '/api/dashboard/business-profile')).status).toBe(200);
    for (const p of ['/api/dashboard/handoffs/1/reply', '/api/dashboard/accounts/4/qr/connect', '/api/dashboard/requests/9/quotation/send']) expect((await call(writeMode, 'POST', p)).status, p).toBe(403);
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(['PUT /api/dashboard/business-profile']);
  });

  it('refuses a cross-origin write even when the operation itself is allowed', async () => {
    seen.length = 0;
    const r = await call(writeMode, 'PUT', '/api/dashboard/business-profile', { origin: 'https://evil.example' });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body).error).toBe('cross_origin_blocked');
    const r2 = await call(writeMode, 'PUT', '/api/dashboard/business-profile', { 'sec-fetch-site': 'cross-site' });
    expect(r2.status).toBe(403);
    expect(seen).toHaveLength(0);
  });
});
