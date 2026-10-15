import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { getDb } from '../../src/memory/db';
import { env } from '../../src/config/env';
import { createAccount } from '../../src/accounts/accountRepo';
import { runWithAccount } from '../../src/accounts/accountContext';
import { createSession } from '../../src/dashboard/auth';
import { SESSION_COOKIE_NAME } from '../../src/dashboard/authMiddleware';
import { allowUnknownPriceForTests, explainRoutes, resetAiRouterForTests } from '../../src/llm/aiRouter';
import { setModelCatalogForTests } from '../../src/llm/modelCatalog';
import { PROVIDER_KINDS } from '../../src/llm/providerRepo';
import { PROVIDER_PRESETS } from '../../src/llm/providerPresets';

/**
 * OpenRouter as the shared Default (the key already saved on the server is adopted without ever being shown), the Default status, the AI
 * health in /readiness, migration 030, and the proof that no application path still knows Ollama. Provider traffic is MOCKED here.
 */
const PASSWORD = 'a-very-long-test-password-123';
const mutableEnv = env as unknown as Record<string, unknown>;
const SERVER_KEY = process.env.OPENROUTER_API_KEY as string;
const ok = (text: string) => new Response(JSON.stringify({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }] }), { status: 200 });
const ZDR = "0 endpoints out of 10 requested are available matching your guardrail restrictions and data policy.";

describe('OpenRouter as the shared Default', () => {
  const app = createApp();
  let owner: ReturnType<typeof request.agent>;
  let manager: ReturnType<typeof request.agent>;
  let A: number;
  const originalFetch = globalThis.fetch;
  const originalMock = env.shouldUseMockProviders;
  const as = (id: number) => request.agent(app).set('Cookie', `${SESSION_COOKIE_NAME}=${createSession(id).token}`);

  beforeAll(async () => {
    getDb();
    expect((await request(app).post('/api/dashboard/auth/setup').send({ username: 'or-owner', password: PASSWORD })).status).toBe(201);
    owner = as((getDb().prepare('SELECT id FROM admin_users WHERE username = ?').get('or-owner') as { id: number }).id);
    A = createAccount({ name: 'OpenRouter Default Co' }).id;
    const res = await owner.post('/api/dashboard/users').send({ password: PASSWORD, email: 'or-manager@example.com', role: 'manager', accountIds: [A] });
    manager = as(res.body.id as number);
    setModelCatalogForTests([{ id: 'openrouter/free', free: true, image: false, audio: false, tools: true, contextLength: 128000 }]);
    allowUnknownPriceForTests(false);
  });
  afterEach(() => {
    vi.stubGlobal('fetch', originalFetch);
    mutableEnv.shouldUseMockProviders = originalMock;
    resetAiRouterForTests();
  });

  it('adopts the key already saved on the server into the shared pool: editable provider, masked, encrypted, never returned — and only the Super Admin can do it', async () => {
    expect((await request(app).post('/api/dashboard/super-admin/ai/adopt-openrouter')).status).toBe(401);
    expect((await manager.post('/api/dashboard/super-admin/ai/adopt-openrouter')).status).toBe(403);
    const before = await owner.get('/api/dashboard/super-admin/ai');
    expect(before.body.builtin.openRouter).toMatchObject({ hasKey: true, adopted: false });
    const created = await owner.post('/api/dashboard/super-admin/ai/adopt-openrouter').send({});
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('created');
    expect(created.body.provider).toMatchObject({ name: 'OpenRouter', kind: 'openrouter', shared: true, hasKey: true, keyStatus: 'ok', freeTier: true, enabled: true, models: ['openrouter/free'] });
    expect(JSON.stringify(created.body)).not.toContain(SERVER_KEY);
    const stored = getDb().prepare("SELECT key_ciphertext, whatsapp_account_id FROM ai_providers WHERE kind = 'openrouter'").get() as { key_ciphertext: string; whatsapp_account_id: number | null };
    expect(stored.whatsapp_account_id).toBeNull();
    expect(stored.key_ciphertext).not.toContain(SERVER_KEY);
    // idempotent: a second call creates nothing
    const again = await owner.post('/api/dashboard/super-admin/ai/adopt-openrouter').send({});
    expect(again.status).toBe(200);
    expect(again.body.status).toBe('exists');
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM ai_providers WHERE kind = 'openrouter'").get()).toEqual({ n: 1 });
    expect((await owner.get('/api/dashboard/super-admin/ai')).body.builtin.openRouter.adopted).toBe(true);
  });

  it('for chat the shared OpenRouter provider REPLACES the built-in route (one key is never tried twice); every business inherits it; strict free-only still applies', async () => {
    const plan = await runWithAccount(A, () => explainRoutes(A, 'chat'));
    expect(plan.eligible.map((r) => r.providerName)).toEqual(['OpenRouter']);
    expect(plan.eligible[0]).toMatchObject({ model: 'openrouter/free', free: true });
    expect(plan.skipped.some((s) => s.route.providerName === 'OpenRouter (built-in key)')).toBe(false);
    const fresh = createAccount({ name: 'Inherits OpenRouter' }).id;
    expect((await runWithAccount(fresh, () => explainRoutes(fresh, 'chat'))).eligible.map((r) => r.providerName)).toEqual(['OpenRouter']); // a business created later inherits it
    // a model the catalog does not show as free is refused, whatever the provider says
    getDb().prepare("UPDATE ai_providers SET models = 'openai/gpt-4.1-mini' WHERE kind = 'openrouter'").run();
    const paid = await runWithAccount(A, () => explainRoutes(A, 'chat'));
    expect(paid.eligible).toEqual([]);
    expect(paid.skipped.find((s) => s.route.model === 'openai/gpt-4.1-mini')).toMatchObject({ category: 'free_only' });
    getDb().prepare("UPDATE ai_providers SET models = 'openrouter/free' WHERE kind = 'openrouter'").run();
  });

  it('the Default status says whether an eligible model is configured AND tested: not tested → failed with the reason → passed', async () => {
    expect((await owner.get('/api/dashboard/super-admin/ai')).body.status).toMatchObject({ state: 'untested', eligibleRoutes: 1 });
    const id = (getDb().prepare("SELECT id FROM ai_providers WHERE kind = 'openrouter'").get() as { id: number }).id;
    mutableEnv.shouldUseMockProviders = false;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: ZDR } }), { status: 404 })));
    const failed = await owner.post(`/api/dashboard/super-admin/ai/providers/${id}/test`).send({});
    expect(failed.body.ok).toBe(false);
    const afterFail = (await owner.get('/api/dashboard/super-admin/ai')).body.status;
    expect(afterFail.state).toBe('failed');
    expect(afterFail.detail).toMatch(/last test of "OpenRouter" failed/);
    resetAiRouterForTests(); // the failed test put the route into its cooldown; the next test starts clean
    vi.stubGlobal('fetch', vi.fn(async () => ok('ok')));
    expect((await owner.post(`/api/dashboard/super-admin/ai/providers/${id}/test`).send({})).body.ok).toBe(true);
    const passed = (await owner.get('/api/dashboard/super-admin/ai')).body.status;
    expect(passed).toMatchObject({ state: 'ok', eligibleRoutes: 1 });
    expect(passed.detail).toMatch(/passed its last test/);
  });

  it('/readiness reports the AI health per business: eligible routes and the last hour; with every route off it says degraded (still HTTP 200) and never carries a key', async () => {
    const ready = await request(app).get('/readiness');
    expect(ready.status).toBe(200);
    expect(ready.body.ai.accounts.length).toBeGreaterThanOrEqual(1);
    expect(ready.body.ai.accounts[0]).toHaveProperty('eligibleRoutes');
    expect(ready.body.ai.accounts[0].lastHour).toEqual({ ok: expect.any(Number), failed: expect.any(Number) });
    const id = (getDb().prepare("SELECT id FROM ai_providers WHERE kind = 'openrouter'").get() as { id: number }).id;
    await owner.post(`/api/dashboard/super-admin/ai/providers/${id}/disable`);
    const down = await request(app).get('/readiness');
    expect(down.status).toBe(200);
    expect(down.body.ai.status).toBe('degraded');
    expect(down.body.status).toBe('degraded');
    expect(down.body.ai.noEligibleRoute.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(down.body)).not.toContain(SERVER_KEY);
    await owner.post(`/api/dashboard/super-admin/ai/providers/${id}/enable`);
  });

  it('migration 030 removes any leftover Ollama provider and its place in a routing order, and nothing else', () => {
    const db = getDb();
    const keep = (db.prepare("SELECT id FROM ai_providers WHERE kind = 'openrouter'").get() as { id: number }).id;
    const insert = db.prepare("INSERT INTO ai_providers (whatsapp_account_id, name, kind, base_url, models) VALUES (?, 'old local', 'ollama', 'http://127.0.0.1:11434/v1', 'm')").run(A);
    db.prepare("INSERT INTO ai_account_routing (whatsapp_account_id, entry_key, position) VALUES (?, ?, 9)").run(A, `provider:${insert.lastInsertRowid}`);
    db.exec(fs.readFileSync(path.join(__dirname, '../../src/memory/migrations/030_remove_local_inference.sql'), 'utf8'));
    expect(db.prepare("SELECT COUNT(*) AS n FROM ai_providers WHERE kind = 'ollama'").get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM ai_account_routing WHERE entry_key = ?').get(`provider:${insert.lastInsertRowid}`)).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM ai_providers WHERE id = ?').get(keep)).toEqual({ n: 1 });
  });
});

describe('no application path knows Ollama any more', () => {
  const root = path.join(__dirname, '../..');
  const walk = (dir: string, exts: string[]): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p, exts) : exts.some((x) => e.name.endsWith(x)) ? [p] : [];
  });

  it('the source, the dashboard and the environment example contain no Ollama or local-runtime configuration (history lives only in the migrations and the evidence docs)', () => {
    const files = [...walk(path.join(root, 'src'), ['.ts']), ...walk(path.join(root, 'dashboard'), ['.js', '.html', '.css']), path.join(root, '.env.example')]
      .filter((f) => !f.includes(`${path.sep}migrations${path.sep}`));
    const offenders = files.filter((f) => /ollama|OLLAMA|11434|localPrompt|hasLocalRoute/.test(fs.readFileSync(f, 'utf8')));
    expect(offenders.map((f) => path.relative(root, f))).toEqual([]);
  });

  it('is not a provider kind, a preset or an environment setting; the router has no local candidate', () => {
    expect([...PROVIDER_KINDS]).toEqual(['openrouter', 'openai_compatible']);
    expect(PROVIDER_PRESETS.map((p) => p.id)).not.toContain('ollama');
    for (const key of Object.keys(env)) expect(key).not.toMatch(/ollama/i);
  });
});
