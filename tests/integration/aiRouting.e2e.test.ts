import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { getDb } from '../../src/memory/db';
import { env } from '../../src/config/env';
import { createAccount } from '../../src/accounts/accountRepo';
import { claimWebhookEvent } from '../../src/memory/webhookEventRepo';

/**
 * The AI routing administration API as the dashboard uses it: providers with keys are added, edited, tested, enabled, disabled,
 * prioritised and removed; keys never come back (masked only); switches are per business; a provider of one business is invisible
 * to another; a shared provider needs a super administrator; and a duplicate inbound delivery is refused by the message-id claim.
 */
const GROQ_KEY = 'gsk_e2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee00';
const mutableEnv = env as unknown as Record<string, unknown>;

describe('AI routing dashboard API', () => {
  const app = createApp();
  const agent = request.agent(app);
  let OTHER: number;
  const originalFetch = globalThis.fetch;
  const originalMock = env.shouldUseMockProviders;

  beforeAll(async () => {
    const setup = await agent.post('/api/dashboard/auth/setup').send({ username: 'routing-e2e-admin', password: 'a-very-long-test-password-123' });
    expect(setup.status).toBe(201);
    OTHER = createAccount({ name: 'Other Routing Co' }).id;
  });
  afterEach(() => {
    vi.stubGlobal('fetch', originalFetch);
    mutableEnv.shouldUseMockProviders = originalMock;
  });

  it('requires a signed-in administrator', async () => {
    expect((await request(app).get('/api/dashboard/ai-routing')).status).toBe(401);
  });

  it('lists the routing state with the plan, the built-in routes, the switches and empty history — and never a key', async () => {
    const res = await agent.get('/api/dashboard/ai-routing');
    expect(res.status).toBe(200);
    expect(res.body.settings).toEqual({ freeOnly: true, failover: true });
    expect(res.body.providers).toEqual([]);
    expect(res.body.plan.chat).toHaveProperty('eligible');
    expect(res.body.builtin.openRouter.hasKey).toBe(true);
    expect(res.body.presets.map((p: { id: string }) => p.id)).not.toContain('ollama'); // no local runtime is offered any more
    expect(res.body.presets.map((p: { id: string }) => p.id)).toEqual(expect.arrayContaining(['groq', 'google', 'cerebras', 'mistral', 'openrouter']));
    expect(JSON.stringify(res.body)).not.toMatch(/test-openrouter-key|sk-or-/);
  });

  it('adds a provider with a key (returned masked only), edits it, tests it (one tiny completion, recorded), disables/enables it, and removes it', async () => {
    const created = await agent.post('/api/dashboard/ai-routing/providers').send({ name: 'Groq free tier', kind: 'openai_compatible', baseUrl: 'https://api.groq.com/openai/v1/', apiKey: GROQ_KEY, models: 'llama-3.3-70b-versatile, llama-3.1-8b-instant', freeTier: true, priority: 10, timeoutMs: 5000 });
    expect(created.status).toBe(201);
    const id = created.body.provider.id as number;
    expect(created.body.provider).toMatchObject({ name: 'Groq free tier', baseUrl: 'https://api.groq.com/openai/v1', hasKey: true, keyStatus: 'ok', models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'], freeTier: true, enabled: true, shared: false });
    expect(JSON.stringify(created.body)).not.toContain(GROQ_KEY);
    expect(String(created.body.provider.keyMasked)).not.toContain('e2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2');
    const stored = getDb().prepare('SELECT key_ciphertext FROM ai_providers WHERE id = ?').get(id) as { key_ciphertext: string };
    expect(stored.key_ciphertext).not.toContain('gsk_'); // encrypted at rest

    // a new own provider joins the business's order AFTER Default; the business then moves it first and the router follows at once
    const state = await agent.get('/api/dashboard/ai-routing');
    expect(state.body.entries.map((e: { name: string }) => e.name)).toEqual(['Default', 'Groq free tier']);
    const moved = await agent.put('/api/dashboard/ai-routing/order').send({ entries: [{ key: `provider:${id}` }, { key: 'default' }] });
    expect(moved.status).toBe(200);
    expect(moved.body.entries.map((e: { name: string }) => e.name)).toEqual(['Groq free tier', 'Default']);
    const reordered = await agent.get('/api/dashboard/ai-routing');
    expect(reordered.body.plan.chat.eligible[0]).toMatchObject({ providerName: 'Groq free tier', model: 'llama-3.3-70b-versatile' });

    // edit without touching the key
    const edited = await agent.put(`/api/dashboard/ai-routing/providers/${id}`).send({ name: 'Groq (free)', kind: 'openai_compatible', baseUrl: 'https://api.groq.com/openai/v1', models: 'llama-3.1-8b-instant', priority: 15, freeTier: true, supportsTools: true });
    expect(edited.status).toBe(200);
    expect(edited.body.provider).toMatchObject({ name: 'Groq (free)', models: ['llama-3.1-8b-instant'], priority: 15, hasKey: true });

    // test: the provider answers; the key is sent to the provider only
    mutableEnv.shouldUseMockProviders = false;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${GROQ_KEY}`);
      return new Response('{"choices":[{"message":{"role":"assistant","content":"ok"}}]}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const tested = await agent.post(`/api/dashboard/ai-routing/providers/${id}/test`).send({});
    expect(tested.status).toBe(200);
    expect(tested.body.ok).toBe(true);
    expect(tested.body.provider).toMatchObject({ lastTestOk: true });
    expect(tested.body.latencyMs).toBeGreaterThanOrEqual(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // a failing test is recorded honestly
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"Rate limit reached"}}', { status: 429 })));
    const failed = await agent.post(`/api/dashboard/ai-routing/providers/${id}/test`).send({});
    expect(failed.body.ok).toBe(false);
    expect(failed.body.detail).toMatch(/rate limited/);
    expect(failed.body.provider.lastTestOk).toBe(false);

    // disable / enable
    expect((await agent.post(`/api/dashboard/ai-routing/providers/${id}/disable`)).body.provider.enabled).toBe(false);
    const planOff = await agent.get('/api/dashboard/ai-routing');
    expect(planOff.body.plan.chat.skipped.find((s: { route: { providerName: string } }) => s.route.providerName === 'Groq (free)')).toMatchObject({ category: 'disabled' });
    expect((await agent.post(`/api/dashboard/ai-routing/providers/${id}/enable`)).body.provider.enabled).toBe(true);

    // the history shows the two test attempts
    const after = await agent.get('/api/dashboard/ai-routing');
    expect(after.body.history.map((h: { outcome: string }) => h.outcome)).toEqual(expect.arrayContaining(['ok', 'failed']));
    expect(after.body.stats.totals.ok).toBeGreaterThanOrEqual(1);

    // remove
    expect((await agent.delete(`/api/dashboard/ai-routing/providers/${id}`)).status).toBe(200);
    expect((await agent.get('/api/dashboard/ai-routing')).body.providers).toEqual([]);
  });

  it('rejects a bad provider (unknown kind, bad URL, no model, a public address for a local runtime, a malformed key) with the fields named', async () => {
    const bad = await agent.post('/api/dashboard/ai-routing/providers').send({ name: '', kind: 'magic', baseUrl: 'ftp://x', apiKey: 'short', models: '' });
    expect(bad.status).toBe(400);
    expect(bad.body.fields).toEqual(expect.arrayContaining(['name', 'kind', 'baseUrl', 'models', 'apiKey']));
    const clear = await agent.post('/api/dashboard/ai-routing/providers').send({ name: 'Plain http', kind: 'openai_compatible', baseUrl: 'http://api.example.test/v1', apiKey: GROQ_KEY, models: 'm' });
    expect(clear.status).toBe(400); // an API key is never sent over plain http
    expect(clear.body.fields).toContain('baseUrl');
    const local = await agent.post('/api/dashboard/ai-routing/providers').send({ name: 'Old kind', kind: 'ollama', baseUrl: 'https://127.0.0.1/v1', models: 'm' });
    expect(local.status).toBe(400); // Ollama is not a provider kind any more
    expect(local.body.fields).toContain('kind');
  });

  it('switches are per business; a provider of one business is invisible to another; a shared provider is visible to both and needs the super administrator', async () => {
    const mine = await agent.post('/api/dashboard/ai-routing/providers').send({ name: 'Only mine', kind: 'openai_compatible', baseUrl: 'https://api.cerebras.ai/v1', apiKey: GROQ_KEY, models: 'llama3.1-8b' });
    expect(mine.status).toBe(201);
    const other = await agent.get('/api/dashboard/ai-routing').set('X-Whatsapp-Account', String(OTHER));
    expect(other.status).toBe(200);
    expect(other.body.providers).toEqual([]);
    expect((await agent.put(`/api/dashboard/ai-routing/providers/${mine.body.provider.id}`).set('X-Whatsapp-Account', String(OTHER)).send({ name: 'x', kind: 'openai_compatible', baseUrl: 'https://api.cerebras.ai/v1', models: 'a' })).status).toBe(404);
    const shared = await agent.post('/api/dashboard/ai-routing/providers').send({ name: 'Shared Google', kind: 'openai_compatible', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: GROQ_KEY, models: 'gemini-2.5-flash-lite', shared: true });
    expect(shared.status).toBe(201); // the first administrator is the super administrator
    expect(shared.body.provider.shared).toBe(true);
    // a shared provider is part of EVERY business's Default entry: they see a summary, never its name, address or key
    const otherView = (await agent.get('/api/dashboard/ai-routing').set('X-Whatsapp-Account', String(OTHER))).body;
    expect(otherView.providers).toEqual([]);
    expect(otherView.entries.map((e: { name: string }) => e.name)).toEqual(['Default']);
    expect(otherView.defaultPool.usable).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify({ providers: otherView.providers, entries: otherView.entries, defaultPool: otherView.defaultPool })).not.toMatch(/Shared Google|generativelanguage|gsk_/);
    // switches: strict mode off for the OTHER business only
    expect((await agent.put('/api/dashboard/ai-routing/settings').set('X-Whatsapp-Account', String(OTHER)).send({ freeOnly: false })).body.settings).toEqual({ freeOnly: false, failover: true });
    expect((await agent.get('/api/dashboard/ai-routing')).body.settings.freeOnly).toBe(true);
    await agent.delete(`/api/dashboard/ai-routing/providers/${mine.body.provider.id}`);
    await agent.delete(`/api/dashboard/ai-routing/providers/${shared.body.provider.id}`);
  });

  it('a duplicate inbound delivery is refused by the message-id claim (the second delivery never reaches the pipeline, so no reply or side effect repeats)', () => {
    expect(claimWebhookEvent('wamid.dup.routing.1', 'text')).toBe(true);
    expect(claimWebhookEvent('wamid.dup.routing.1', 'text')).toBe(false);
  });
});
