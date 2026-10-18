import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { getDb } from '../../src/memory/db';
import { createSession } from '../../src/dashboard/auth';
import { SESSION_COOKIE_NAME } from '../../src/dashboard/authMiddleware';
import { createAccount } from '../../src/accounts/accountRepo';
import { PROVIDER_PRESETS, resolveSimpleProvider, SimpleProviderError } from '../../src/llm/providerPresets';
import { PROVIDER_RULES } from '../../src/llm/providerRepo';
import { allowUnknownPriceForTests, buildCandidates } from '../../src/llm/aiRouter';
import { runWithAccount } from '../../src/accounts/accountContext';

/**
 * The Add Provider form of Super Admin Settings, end to end: the exact failure reported in production (a custom OpenAI-compatible provider
 * saved with an API key but no endpoint and no models), known providers that fill themselves in, invalid input, and strict free-only mode.
 */
const PASSWORD = 'a-very-long-test-password-123';
const KEY = 'sk-deepseekdeepseekdeepseekdeepseek0000000000';
const GROQ = 'gsk_groqgroqgroqgroqgroqgroqgroqgroq000000000';

describe('Add provider (Super Admin Settings)', () => {
  const app = createApp();
  let owner: ReturnType<typeof request.agent>;
  let acc: number;

  beforeAll(async () => {
    getDb();
    expect((await request(app).post('/api/dashboard/auth/setup').send({ username: 'pf-owner', password: PASSWORD })).status).toBe(201);
    const id = (getDb().prepare('SELECT id FROM admin_users WHERE username = ?').get('pf-owner') as { id: number }).id;
    owner = request.agent(app).set('Cookie', `${SESSION_COOKIE_NAME}=${createSession(id).token}`);
    acc = createAccount({ name: 'Provider Form Co' }).id;
    allowUnknownPriceForTests(false); // the real production rule (the shared test setup relaxes it)
  });

  it('serves the presets and the exact validation rules the form uses (no key prefixes, no secrets)', async () => {
    const res = await owner.get('/api/dashboard/super-admin/ai');
    expect(res.status).toBe(200);
    expect(res.body.rules).toEqual({ baseUrl: PROVIDER_RULES.baseUrl.source, model: PROVIDER_RULES.model.source });
    expect(res.body.presets.map((p: { id: string }) => p.id)).toEqual(PROVIDER_PRESETS.map((p) => p.id));
    expect(JSON.stringify(res.body.presets)).not.toMatch(/gsk_|sk-or-|AIza|csk-/);
  });

  it('the reported case: a custom provider with a key but no endpoint and no models is refused with a clear message naming both fields', async () => {
    const res = await owner.post('/api/dashboard/super-admin/ai/providers').send({ name: 'Deepseek free', config: KEY, provider: 'custom', models: '', baseUrl: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_failed');
    expect(res.body.fields).toEqual(['baseUrl', 'models']);
    expect(res.body.message).toMatch(/https:\/\//);
    expect(res.body.message).toMatch(/model id/);
    expect(JSON.stringify(res.body)).not.toContain(KEY);
  });

  it.each([
    ['plain http', 'http://api.example.com/v1', 'm-1'],
    ['no scheme', 'api.example.com/v1', 'm-1'],
    ['spaces', 'https://api example.com', 'm-1'],
    ['a script', 'javascript:alert(1)', 'm-1'],
  ])('an invalid endpoint (%s) is refused', async (_label, baseUrl, models) => {
    const res = await owner.post('/api/dashboard/super-admin/ai/providers').send({ name: 'Bad', config: KEY, provider: 'custom', models, baseUrl });
    expect(res.status).toBe(400);
    expect(res.body.fields).toContain('baseUrl');
  });

  it('an invalid model id is refused', async () => {
    const res = await owner.post('/api/dashboard/super-admin/ai/providers').send({ name: 'Bad', config: KEY, provider: 'custom', models: 'ok-model, bad model!', baseUrl: 'https://api.example.com/v1' });
    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual(['models']);
  });

  it('a known provider needs only a name and a key: endpoint and models come from the preset, and the key is stored masked', async () => {
    const res = await owner.post('/api/dashboard/super-admin/ai/providers').send({ name: 'Groq free', config: GROQ, provider: 'groq' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const preset = PROVIDER_PRESETS.find((p) => p.id === 'groq')!;
    expect(res.body.provider.baseUrl).toBe(preset.baseUrl);
    expect(res.body.provider.models).toEqual(preset.models.split(','));
    expect(res.body.provider.keyMasked).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toContain(GROQ);
    expect(res.body.provider.freeConfirmed).toBe(false);
  });

  it('a known provider is also recognised from the key alone', async () => {
    const res = await owner.post('/api/dashboard/super-admin/ai/providers').send({ name: 'Groq auto', config: GROQ });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.provider.baseUrl).toBe('https://api.groq.com/openai/v1');
  });

  it('a custom provider with an endpoint and models saves, but strict free-only mode never routes it until the Super Admin confirms its free tier', async () => {
    const res = await owner.post('/api/dashboard/super-admin/ai/providers').send({ name: 'Deepseek free', config: KEY, provider: 'custom', models: 'deepseek-chat', baseUrl: 'https://api.example.com/v1' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const id = res.body.provider.id as number;
    const before = await runWithAccount(acc, () => buildCandidates(acc, 'chat', { wantsTools: false }));
    expect(before.eligible.find((c) => c.providerId === id)).toBeUndefined();
    expect(before.skipped.find((s) => s.candidate.providerId === id)?.reason).toMatch(/not confirmed/);

    expect((await owner.post(`/api/dashboard/super-admin/ai/providers/${id}/confirm-free`)).status).toBe(200);
    const after = await runWithAccount(acc, () => buildCandidates(acc, 'chat', { wantsTools: false }));
    expect(after.eligible.find((c) => c.providerId === id)).toBeDefined();
  });

  it('presets never select a paid-looking default: every known preset lists only the free-tier model ids it documents, and custom lists none', () => {
    expect(PROVIDER_PRESETS.find((p) => p.id === 'custom')!.models).toBe('');
    expect(PROVIDER_PRESETS.find((p) => p.id === 'custom')!.baseUrl).toBe('');
    for (const p of PROVIDER_PRESETS) {
      expect(p.baseUrl === '' || PROVIDER_RULES.baseUrl.test(p.baseUrl)).toBe(true);
      for (const m of p.models.split(',').filter(Boolean)) expect(PROVIDER_RULES.model.test(m)).toBe(true);
    }
  });

  it('the resolver itself never guesses: custom without an endpoint or models throws with the field names', () => {
    try { resolveSimpleProvider({ name: 'x', config: KEY, provider: 'custom' }); throw new Error('should have thrown'); } catch (e) {
      expect(e).toBeInstanceOf(SimpleProviderError);
      expect((e as SimpleProviderError).fields).toEqual(['baseUrl', 'models']);
    }
  });
});
