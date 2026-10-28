import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { getDb } from '../../src/memory/db';
import { createSession } from '../../src/dashboard/auth';
import { SESSION_COOKIE_NAME } from '../../src/dashboard/authMiddleware';
import { setOmniRouteKeyFileEnabledForTests } from '../../src/llm/omniRoute';

/** The dashboard routes for "Load models" (any vendor) and "reset routing". The provider HTTP is scripted: no real provider is contacted. */
const PASSWORD = 'a-very-long-test-password-123';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe('Load models route and routing reset', () => {
  const app = createApp();
  let owner: ReturnType<typeof request.agent>;
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    getDb();
    setOmniRouteKeyFileEnabledForTests(false);
    expect((await request(app).post('/api/dashboard/auth/setup').send({ username: 'discovery-owner', password: PASSWORD })).status).toBe(201);
    const id = (getDb().prepare('SELECT id FROM admin_users WHERE username = ?').get('discovery-owner') as { id: number }).id;
    owner = request.agent(app).set('Cookie', `${SESSION_COOKIE_NAME}=${createSession(id).token}`);
  });
  afterAll(() => setOmniRouteKeyFileEnabledForTests(true));
  afterEach(() => vi.stubGlobal('fetch', originalFetch));

  it('requires a signed-in administrator', async () => {
    expect((await request(app).post('/api/dashboard/ai-routing/discover-models').send({ vendor: 'openai', apiKey: 'sk-x' })).status).toBe(401);
    expect((await request(app).post('/api/dashboard/ai-routing/order/reset')).status).toBe(401);
  });

  it('lists a vendor\'s models with the typed key, and never echoes the key back', async () => {
    const fetchMock = vi.fn(async () => json(200, { data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await owner.post('/api/dashboard/ai-routing/discover-models').send({ vendor: 'deepseek', apiKey: 'sk-typed-deepseek-key-123' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.models.map((m: { id: string }) => m.id)).toEqual(['deepseek-chat', 'deepseek-reasoner']);
    expect(JSON.stringify(res.body)).not.toContain('sk-typed-deepseek-key-123');
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe('https://api.deepseek.com/models');
  });

  it('reports a rejected key plainly, and an unreachable OmniRoute gateway as "not running" (the production situation)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(401, { error: 'bad key' })));
    const rejected = await owner.post('/api/dashboard/ai-routing/discover-models').send({ vendor: 'openai', apiKey: 'sk-wrong' });
    expect(rejected.body).toMatchObject({ ok: false, reason: 'rejected' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }));
    const omni = await owner.post('/api/dashboard/ai-routing/discover-models').send({ vendor: 'omniroute' });
    expect(omni.body).toMatchObject({ ok: false, reason: 'gateway_not_running' });
    expect(omni.body.message).toMatch(/not running/);
  });

  it('refuses an address that is not the vendor\'s own host', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await owner.post('/api/dashboard/ai-routing/discover-models').send({ vendor: 'openai', apiKey: 'sk-x', baseUrl: 'https://attacker.example/v1' });
    expect(res.body).toMatchObject({ ok: false, reason: 'endpoint_refused' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reset brings the saved order back to the defaults and leaves providers and keys alone', async () => {
    const db = getDb();
    const before = (db.prepare('SELECT COUNT(*) AS n FROM ai_providers').get() as { n: number }).n;
    const reorder = await owner.put('/api/dashboard/ai-routing/order').send({ entries: [{ key: 'default', enabled: false }] });
    expect(reorder.status).toBe(200);
    const reset = await owner.post('/api/dashboard/ai-routing/order/reset');
    expect(reset.status).toBe(200);
    expect(reset.body.ok).toBe(true);
    const def = reset.body.entries.find((e: { type: string }) => e.type === 'default');
    expect(def.enabled).toBe(true);
    expect((db.prepare('SELECT COUNT(*) AS n FROM ai_providers').get() as { n: number }).n).toBe(before);
  });
});
