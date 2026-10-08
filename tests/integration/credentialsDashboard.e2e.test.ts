import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { getDb } from '../../src/memory/db';
import { env } from '../../src/config/env';
import { encryptWithKey, readOverride } from '../../src/config/secretStore';
import { deriveKeyFromRawValue } from '../../src/config/masterKey';

const OTHER_KEY = deriveKeyFromRawValue('c'.repeat(64));
const STALE = 'sk-or-v1-STALE-SECRET-THAT-MUST-NEVER-APPEAR-IN-A-RESPONSE';
const NEW_KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef';
const mutableEnv = env as unknown as Record<string, unknown>;

describe('dashboard credential pages with stale (undecryptable) overrides', () => {
  const app = createApp();
  const agent = request.agent(app);
  const originalFetch = globalThis.fetch;
  const originalKey = env.OPENROUTER_API_KEY;
  const originalMock = env.shouldUseMockProviders;

  beforeAll(async () => {
    const setup = await agent.post('/api/dashboard/auth/setup').send({ username: 'cred-e2e-admin', password: 'a-very-long-test-password-123' });
    expect(setup.status).toBe(201);
    const admin = (getDb().prepare('SELECT id FROM admin_users LIMIT 1').get() as { id: number }).id;
    for (const key of ['OPENROUTER_API_KEY', 'GOOGLE_CLIENT_EMAIL', 'WHATSAPP_ACCESS_TOKEN', 'META_APP_SECRET']) {
      getDb()
        .prepare(`INSERT INTO credential_overrides (key, ciphertext, updated_at, updated_by) VALUES (?, ?, datetime('now'), ?)`)
        .run(key, encryptWithKey(STALE, OTHER_KEY), admin);
    }
  });

  afterEach(() => {
    vi.stubGlobal('fetch', originalFetch);
    mutableEnv.OPENROUTER_API_KEY = originalKey;
    mutableEnv.shouldUseMockProviders = originalMock;
  });

  it('the credentials list and the WhatsApp status page load (they used to answer 500) and show the stored value as unreadable', async () => {
    const creds = await agent.get('/api/dashboard/credentials');
    expect(creds.status).toBe(200);
    expect(creds.body.OPENROUTER_API_KEY).toMatchObject({ overrideStatus: 'undecryptable' });
    expect(creds.body.OPENROUTER_API_KEY.source).not.toBe('override');
    expect(creds.body.GOOGLE_CLIENT_EMAIL.overrideStatus).toBe('undecryptable');
    expect(JSON.stringify(creds.body)).not.toContain('STALE');

    const wa = await agent.get('/api/dashboard/whatsapp/status');
    expect(wa.status).toBe(200);
    expect(wa.body.configured).toMatchObject({ accessToken: false, appSecret: false });
    expect(JSON.stringify(wa.body)).not.toContain('STALE');

    expect((await agent.get('/api/dashboard/integrations')).status).toBe(200);
  });

  it('entering a valid key through the dashboard repairs it: stored under the CURRENT master key, tested, and shown as the override', async () => {
    mutableEnv.shouldUseMockProviders = false;
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"data":{}}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const configured = await agent.post('/api/dashboard/ai/configure').send({ apiKey: NEW_KEY, model: 'openrouter/free' });
    expect(configured.status).toBe(200);
    expect(configured.body).toMatchObject({ ok: true });
    expect(JSON.stringify(configured.body)).not.toContain(NEW_KEY);
    expect(readOverride('OPENROUTER_API_KEY')).toEqual({ status: 'ok', value: NEW_KEY });
    // The test call used the new key.
    expect((fetchMock.mock.calls[0]![1] as { headers: Record<string, string> }).headers.Authorization).toBe(`Bearer ${NEW_KEY}`);

    const creds = await agent.get('/api/dashboard/credentials');
    expect(creds.body.OPENROUTER_API_KEY).toMatchObject({ source: 'override', overrideStatus: 'ok' });
    expect(creds.body.OPENROUTER_API_KEY.masked).not.toBe(NEW_KEY);
    // The other stale rows are untouched: nothing was deleted or rewritten for them.
    expect(readOverride('GOOGLE_CLIENT_EMAIL').status).toBe('undecryptable');
    expect((getDb().prepare('SELECT COUNT(*) n FROM credential_overrides').get() as { n: number }).n).toBe(4);
  });
});
