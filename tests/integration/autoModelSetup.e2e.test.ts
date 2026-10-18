import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { getDb } from '../../src/memory/db';
import { createSession } from '../../src/dashboard/auth';
import { SESSION_COOKIE_NAME } from '../../src/dashboard/authMiddleware';
import { createAccount } from '../../src/accounts/accountRepo';
import { presetsPayload } from '../../src/llm/providerPresets';
import { VENDORS } from '../../src/llm/adapters';
import { autoSelectModel, MAX_PROBES } from '../../src/llm/autoSetup';
import { allowUnknownPriceForTests } from '../../src/llm/aiRouter';

/**
 * Saving an API key configures the provider automatically: the model is chosen by a REAL minimal inference, never from a fetched model list.
 * The provider network here is SCRIPTED (mocked): these tests prove the decision logic, the refusals and that nothing unconfirmed is stored.
 * They do not prove that any vendor's live API accepts these model ids; that was checked separately with the saved keys (see the changelog).
 */
const PASSWORD = 'a-very-long-test-password-123';
const OR_KEY = 'sk-or-v1-autosetupautosetupautosetupautosetup00000000';
const GROQ_KEY = 'gsk_autosetupautosetupautosetupautosetup00000';
const GEMINI_KEY = 'AIzaSyAutoSetupAutoSetupAutoSetupAutoSetup0';
const XAI_KEY = 'xai-autosetupautosetupautosetupautosetup0000';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const chatOk = () => json(200, { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }] });
const geminiOk = () => json(200, { candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] });
const retired = () => json(404, { error: { code: 404, status: 'NOT_FOUND', message: 'This model is no longer available to new users. Please update your code to use a newer model.' } });
const chatModelMissing = () => json(404, { error: { message: 'The model does not exist or you do not have access to it.' } });
const quota = () => json(429, { error: { message: 'Rate limit exceeded: free-models-per-day' } });

let urls: string[] = [];
let models: string[] = [];
function network(handler: (url: string, model: string) => Response) {
  urls = []; models = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const model = u.includes(':generateContent') ? decodeURIComponent(u.split('/models/')[1]!.split(':')[0]!) : init?.body ? String((JSON.parse(String(init.body)) as { model?: string }).model ?? '') : '';
    urls.push(u); models.push(model);
    return handler(u, model);
  }));
}
const count = () => (getDb().prepare('SELECT COUNT(*) AS n FROM ai_providers').get() as { n: number }).n;

describe('automatic model selection when a key is saved (scripted providers)', () => {
  const app = createApp();
  let owner: ReturnType<typeof request.agent>;
  let acc: number;
  const originalFetch = globalThis.fetch;
  const shared = (body: Record<string, unknown>) => owner.post('/api/dashboard/super-admin/ai/providers').send(body);
  const business = (body: Record<string, unknown>) => owner.post('/api/dashboard/ai-routing/providers').set('X-Whatsapp-Account', String(acc)).send(body);

  beforeAll(async () => {
    getDb();
    expect((await request(app).post('/api/dashboard/auth/setup').send({ username: 'am-owner', password: PASSWORD })).status).toBe(201);
    const id = (getDb().prepare('SELECT id FROM admin_users WHERE username = ?').get('am-owner') as { id: number }).id;
    owner = request.agent(app).set('Cookie', `${SESSION_COOKIE_NAME}=${createSession(id).token}`);
    acc = createAccount({ name: 'Auto Model Co' }).id;
    allowUnknownPriceForTests(false);
  });
  beforeEach(() => { getDb().prepare('DELETE FROM ai_providers').run(); });
  afterEach(() => { vi.stubGlobal('fetch', originalFetch); });

  it('OpenRouter: ONE real request confirms openrouter/free, the catalog makes it free, and the provider starts from a passed test (no model list is fetched)', async () => {
    network(() => chatOk());
    const res = await shared({ name: 'OpenRouter', config: OR_KEY });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.provider.models).toEqual(['openrouter/free']);
    expect(res.body.provider.freeConfirmed).toBe(true);
    expect(res.body.setup).toMatchObject({ models: ['openrouter/free'], freeConfirmationRequired: false });
    expect(res.body.provider).toMatchObject({ lastTestOk: true });
    expect(res.body.provider.lastTestDetail).toMatch(/openrouter\/free answered/);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(urls.some((u) => /\/models(\?|$)/.test(u))).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain(OR_KEY);
  });

  it('Groq: the first documented model is refused (404) so the next one is tried; the model that ANSWERED is saved, and the free tier still needs the administrator', async () => {
    network((_u, model) => (model === 'openai/gpt-oss-20b' ? chatModelMissing() : chatOk()));
    const res = await shared({ name: 'Groq', config: GROQ_KEY });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.provider.models).toEqual(['openai/gpt-oss-120b']);
    expect(models).toEqual(['openai/gpt-oss-20b', 'openai/gpt-oss-120b']);
    expect(res.body.provider.freeConfirmed).toBe(false);
    expect(res.body.setup.freeConfirmationRequired).toBe(true);
    expect(urls.every((u) => u === 'https://api.groq.com/openai/v1/chat/completions')).toBe(true);
  });

  it('Gemini: a retired or missing alias is skipped, the native generateContent request that answered decides the model, and the key travels only in a header', async () => {
    network((_u, model) => (model === 'gemini-flash-latest' ? retired() : geminiOk()));
    const res = await business({ name: 'Gemini', config: GEMINI_KEY });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.provider).toMatchObject({ models: ['gemini-flash-lite-latest'], shared: false });
    expect(urls).toEqual([
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent',
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent',
    ]);
    expect(urls.join(' ')).not.toContain(GEMINI_KEY);
    expect(JSON.stringify(res.body)).not.toContain(GEMINI_KEY);
  });

  it('an invalid key is refused after ONE request, with a plain reason; nothing is saved and the key is never echoed', async () => {
    network(() => json(401, { error: { message: 'Invalid API Key' } }));
    for (const submit of [shared, business]) {
      const before = count();
      const res = await submit({ name: 'Bad key', config: GROQ_KEY });
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ code: 'credential', fields: ['config'] });
      expect(res.body.error).toMatch(/rejected/);
      expect(count()).toBe(before);
      expect(JSON.stringify(res.body)).not.toContain(GROQ_KEY);
    }
    expect(urls).toHaveLength(2); // one request per attempt: a rejected key is never tried against more models
  });

  it('a free allowance that is used up refuses the save honestly: every candidate is asked at most once, nothing is retried, nothing is stored', async () => {
    network(() => quota());
    const res = await shared({ name: 'Groq', config: GROQ_KEY });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('rate_limited');
    expect(res.body.error).toMatch(/allowance is used up/);
    expect(count()).toBe(0);
    expect(urls.length).toBeLessThanOrEqual(MAX_PROBES);
    expect(new Set(models).size).toBe(models.length); // never the same model twice
  });

  it('no model answers: refused with each model\'s own reason, nothing stored', async () => {
    network(() => chatModelMissing());
    const res = await shared({ name: 'Gemini', config: GEMINI_KEY });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('no_working_model');
    expect(res.body.error).toContain('No model answered a real test request');
    expect(count()).toBe(0);
    expect(res.body.attempts.every((a: { ok: boolean }) => a.ok === false)).toBe(true);
  });

  it('an unreachable provider ends the setup at once (no retries) and nothing is stored', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const res = await shared({ name: 'Groq', config: GROQ_KEY });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('network');
    expect(count()).toBe(0);
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(1);
  });

  it('a vendor with no documented stable model (xAI) asks for one: no request is made without it; with one typed, it is tested and kept only if it answered', async () => {
    network(() => chatOk());
    const missing = await shared({ name: 'xAI', config: XAI_KEY });
    expect(missing.status).toBe(400);
    expect(missing.body.fields).toEqual(['models']);
    expect(urls).toHaveLength(0);

    network((_u, model) => (model === 'grok-gone' ? chatModelMissing() : chatOk()));
    const typed = await shared({ name: 'xAI', config: XAI_KEY, models: 'grok-gone, grok-works' });
    expect(typed.status, JSON.stringify(typed.body)).toBe(201);
    expect(typed.body.provider.models).toEqual(['grok-works']); // the model that did not answer is not stored
    expect(models).toEqual(['grok-gone', 'grok-works']);

    network(() => chatModelMissing());
    const none = await shared({ name: 'xAI', config: XAI_KEY, models: 'grok-nope' });
    expect(none.status).toBe(422);
    expect(none.body.fields).toEqual(['models']);
  });

  it('the preset list tells the form which vendors choose their model automatically, and offers no model-list feature', () => {
    const payload = presetsPayload();
    expect(Object.fromEntries(payload.presets.map((p) => [p.id, p.autoSelect]))).toEqual({ openrouter: true, groq: true, google: true, xai: false, mistral: true, cerebras: false, custom: false });
    expect(JSON.stringify(payload)).not.toMatch(/discovery|fetch/i);
    expect(VENDORS.every((v) => Array.isArray(v.probeModels))).toBe(true);
  });

  it('the "Fetch available models" feature is gone: no endpoint, no button, no handler, no wording', async () => {
    expect((await owner.post('/api/dashboard/super-admin/ai/discover-models').send({ provider: 'groq', config: GROQ_KEY })).status).toBe(404);
    expect((await owner.post('/api/dashboard/ai-routing/discover-models').set('X-Whatsapp-Account', String(acc)).send({ provider: 'groq', config: GROQ_KEY })).status).toBe(404);
    const app_js = fs.readFileSync(path.join(__dirname, '..', '..', 'dashboard', 'app.js'), 'utf8');
    expect(app_js).not.toMatch(/Fetch available models|ai-fetch-models|discover-models|discoverUrl/);
    const ar = fs.readFileSync(path.join(__dirname, '..', '..', 'dashboard', 'i18n-ar-6.js'), 'utf8');
    expect(ar).not.toMatch(/Fetch available models|Asking the provider/);
  });
});

describe('autoSelectModel (decision logic, scripted provider)', () => {
  const groq = VENDORS.find((v) => v.id === 'groq')!;
  const originalFetch = globalThis.fetch;
  afterEach(() => { vi.stubGlobal('fetch', originalFetch); });

  it('stops at the first model that answers and reports every request it made', async () => {
    network(() => chatOk());
    const r = await autoSelectModel(groq, groq.baseUrl, GROQ_KEY);
    expect(r).toMatchObject({ ok: true, models: ['openai/gpt-oss-20b'] });
    expect(r.attempts).toHaveLength(1);
  });

  it('an empty answer is a failure, not a model: the next candidate is tried', async () => {
    network((_u, model) => (model === 'openai/gpt-oss-20b' ? json(200, { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '' } }] }) : chatOk()));
    const r = await autoSelectModel(groq, groq.baseUrl, GROQ_KEY);
    expect(r).toMatchObject({ ok: true, models: ['openai/gpt-oss-120b'] });
    expect(r.attempts[0]).toMatchObject({ ok: false, category: 'empty_response' });
  });

  it('never calls more than MAX_PROBES default models and never hits the network for a vendor without candidates', async () => {
    network(() => chatModelMissing());
    const google = VENDORS.find((v) => v.id === 'google')!;
    const r = await autoSelectModel(google, google.baseUrl, GEMINI_KEY);
    expect(r.ok).toBe(false);
    expect(urls.length).toBeLessThanOrEqual(MAX_PROBES);
    network(() => chatOk());
    const cerebras = VENDORS.find((v) => v.id === 'cerebras')!;
    const none = await autoSelectModel(cerebras, cerebras.baseUrl, 'csk-' + 'x'.repeat(30));
    expect(none).toMatchObject({ ok: false, category: 'model_required', fields: ['models'] });
    expect(urls).toHaveLength(0);
  });
});
