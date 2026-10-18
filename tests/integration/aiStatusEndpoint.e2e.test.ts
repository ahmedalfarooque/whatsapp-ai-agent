import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { getDb } from '../../src/memory/db';
import { env } from '../../src/config/env';
import { createSession } from '../../src/dashboard/auth';
import { SESSION_COOKIE_NAME } from '../../src/dashboard/authMiddleware';
import { createProvider } from '../../src/llm/providerRepo';
import { resetProviderHealthForTests } from '../../src/llm/aiProviderHealth';

/** The status pill's endpoint: a business served by providers renders with no outbound call at all; the legacy route is checked only when used. */
const mutableEnv = env as unknown as Record<string, unknown>;
const originalMock = mutableEnv.shouldUseMockProviders;
const originalKey = mutableEnv.OPENROUTER_API_KEY;

describe('GET /api/dashboard/ai-status', () => {
  const app = createApp();
  let owner: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    getDb();
    expect((await request(app).post('/api/dashboard/auth/setup').send({ username: 'status-owner', password: 'a-very-long-test-password-123' })).status).toBe(201);
    const id = (getDb().prepare('SELECT id FROM admin_users WHERE username = ?').get('status-owner') as { id: number }).id;
    owner = request.agent(app).set('Cookie', `${SESSION_COOKIE_NAME}=${createSession(id).token}`);
  });
  afterEach(() => {
    mutableEnv.shouldUseMockProviders = originalMock;
    mutableEnv.OPENROUTER_API_KEY = originalKey;
    vi.unstubAllGlobals();
    resetProviderHealthForTests();
  });

  it('a business served by a shared provider: no key check, no model probe, no secret in the answer', async () => {
    mutableEnv.shouldUseMockProviders = false;
    mutableEnv.OPENROUTER_API_KEY = 'env-key-0123456789abcdef';
    getDb().prepare('DELETE FROM ai_providers').run();
    createProvider({ name: 'OpenRouter', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-v1-sharedsharedsharedsharedsharedshared00000000000000', models: ['openrouter/free'] }, { accountId: null, updatedBy: 1 });
    const spy = vi.fn(async () => new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', spy);
    const res = await owner.get('/api/dashboard/ai-status');
    expect(res.status).toBe(200);
    expect(res.body.label).not.toBe('AI key rejected');
    expect(res.body.state).toBe('active');
    expect(spy).not.toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toMatch(/sk-or-v1|env-key-0123/);
  });

  it('a business with no provider still has its legacy key checked (and a rejected one is reported)', async () => {
    mutableEnv.shouldUseMockProviders = false;
    mutableEnv.OPENROUTER_API_KEY = 'env-key-0123456789abcdef';
    getDb().prepare('DELETE FROM ai_providers').run();
    const spy = vi.fn(async () => new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', spy);
    const res = await owner.get('/api/dashboard/ai-status');
    expect(res.body).toMatchObject({ state: 'error', label: 'AI key rejected' });
    expect(spy).toHaveBeenCalled();
  });
});
