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
import { allowUnknownPriceForTests, resetAiRouterForTests, routeCompletion } from '../../src/llm/aiRouter';
import { setModelCatalogForTests } from '../../src/llm/modelCatalog';
import { runWithAccount } from '../../src/accounts/accountContext';
import { env } from '../../src/config/env';

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

  it('the key alone is enough: no name, no provider, no endpoint, no model — all detected; the name is the provider\'s and is numbered on a second key', async () => {
    network(() => chatOk());
    const first = await shared({ config: OR_KEY });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.provider).toMatchObject({ name: 'OpenRouter', models: ['openrouter/free'], baseUrl: 'https://openrouter.ai/api/v1' });
    const second = await shared({ name: '  ', config: OR_KEY });
    expect(second.body.provider.name).toBe('OpenRouter 2');
    const named = await shared({ name: 'My free route', config: OR_KEY });
    expect(named.body.provider.name).toBe('My free route');
    const unknown = await shared({ config: 'not-a-known-key-shape-0000000000000000' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.fields).toEqual(['provider']);
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

  it('a free allowance that is used up still saves the key (the test cannot say the key is bad), says so separately, and never records a pass; every candidate is asked at most once', async () => {
    network(() => quota());
    const res = await shared({ name: 'Groq', config: GROQ_KEY });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.setup).toMatchObject({ verified: false, models: ['openai/gpt-oss-20b'] });
    expect(res.body.setup.testFailure).toMatch(/allowance is used up/);
    expect(res.body.provider).toMatchObject({ lastTestOk: false });
    expect(res.body.provider.lastTestDetail).toMatch(/Saved without a working test/);
    expect(count()).toBe(1);
    expect(urls.length).toBeLessThanOrEqual(MAX_PROBES);
    expect(new Set(models).size).toBe(models.length); // never the same model twice
    expect(JSON.stringify(res.body)).not.toContain(GROQ_KEY);
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

  it('an unreachable provider ends the setup at once (no retries); the key is saved, unverified, with the reason', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const res = await shared({ name: 'Groq', config: GROQ_KEY });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.setup).toMatchObject({ verified: false });
    expect(res.body.setup.testFailure).toMatch(/could not be reached/);
    expect(count()).toBe(1);
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
    expect(none.status, JSON.stringify(none.body)).toBe(201); // xAI has no documented default: the typed model is kept, but NOT verified
    expect(none.body.provider.models).toEqual(['grok-nope']);
    expect(none.body.setup).toMatchObject({ verified: false });
    expect(none.body.provider).toMatchObject({ lastTestOk: false });
  });

  describe('OpenRouter: what the key test accepts and what it never counts as an answer', () => {
    const html = () => new Response('<!doctype html><html><body>blocked</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    const errorInside200 = (code: number, message: string) => json(200, { error: { code, message } });
    const text = (body: string, contentType = 'application/json') => new Response(body, { status: 200, headers: { 'content-type': contentType } });
    const answer = { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }] };

    it('a typed model that does not exist (openai/gpt) does not decide the key: openrouter/free is tried once, answers, and is what gets saved', async () => {
      network((_u, model) => (model === 'openai/gpt' ? json(400, { error: { code: 400, message: 'openai/gpt is not a valid model ID' } }) : chatOk()));
      const res = await shared({ name: 'OpenRouter', config: OR_KEY, models: 'openai/gpt' });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.provider.models).toEqual(['openrouter/free']);
      expect(models).toEqual(['openai/gpt', 'openrouter/free']);
      expect(res.body.setup).toMatchObject({ verified: true, models: ['openrouter/free'] });
      expect(res.body.setup.testFailure).toMatch(/typed did not answer.*openrouter\/free did/);
      expect(res.body.provider).toMatchObject({ lastTestOk: true });
    });

    it('an unreadable HTTP 200 (an HTML page) is a failed test that says what the body was; the key is still saved with openrouter/free, unverified, and never recorded as working', async () => {
      network(() => html());
      const res = await shared({ name: 'OpenRouter', config: OR_KEY });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.setup).toMatchObject({ verified: false, models: ['openrouter/free'] });
      expect(res.body.setup.testFailure).toMatch(/malformed response, HTTP 200: the answer body was not JSON \(html, \d+ bytes\)/);
      expect(res.body.provider).toMatchObject({ lastTestOk: false, models: ['openrouter/free'] });
      expect(JSON.stringify(res.body)).not.toContain(OR_KEY);
    });

    it('an error object inside HTTP 200 is a failed inference, classified by its own code: a rate limit is a rate limit, a rejected key refuses the save', async () => {
      network(() => errorInside200(429, 'Rate limit exceeded: free-models-per-day'));
      const limited = await shared({ name: 'OpenRouter', config: OR_KEY });
      expect(limited.status).toBe(201);
      expect(limited.body.setup).toMatchObject({ verified: false });
      expect(limited.body.setup.testFailure).toMatch(/allowance is used up/);
      expect(limited.body.provider).toMatchObject({ lastTestOk: false });

      getDb().prepare('DELETE FROM ai_providers').run();
      network(() => errorInside200(401, 'User not found.'));
      const rejectedKey = await shared({ name: 'OpenRouter', config: OR_KEY });
      expect(rejectedKey.status).toBe(422);
      expect(rejectedKey.body).toMatchObject({ code: 'credential' });
      expect(count()).toBe(0);
    });

    it('OpenRouter keep-alive lines before the JSON, and an event-stream body, are read as the answer they carry', async () => {
      network(() => text(`: OPENROUTER PROCESSING\n\n: OPENROUTER PROCESSING\n\n${JSON.stringify(answer)}`));
      const keepAlive = await shared({ name: 'OpenRouter', config: OR_KEY });
      expect(keepAlive.status, JSON.stringify(keepAlive.body)).toBe(201);
      expect(keepAlive.body.setup).toMatchObject({ verified: true });

      getDb().prepare('DELETE FROM ai_providers').run();
      const chunk = (delta: Record<string, unknown>, finish: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      network(() => text(`: OPENROUTER PROCESSING\n\n${chunk({ role: 'assistant', content: 'o' })}${chunk({ content: 'k' }, 'stop')}data: [DONE]\n\n`, 'text/event-stream'));
      const streamed = await shared({ name: 'OpenRouter', config: OR_KEY });
      expect(streamed.status, JSON.stringify(streamed.body)).toBe(201);
      expect(streamed.body.setup).toMatchObject({ verified: true });
    });

    it('a key saved from the dashboard (even with a failed test) is stored ENCRYPTED, shown masked, and is the key the AI router really sends with openrouter/free', async () => {
      const mutableEnv = env as unknown as Record<string, unknown>;
      const originalMock = mutableEnv.shouldUseMockProviders;
      try {
        network(() => html());
        const saved = await shared({ name: 'OpenRouter', config: OR_KEY });
        expect(saved.status, JSON.stringify(saved.body)).toBe(201);
        expect(saved.body.setup.verified).toBe(false);
        expect(saved.body.provider.keyMasked).toBeTruthy();
        expect(saved.body.provider.keyMasked).not.toBe(OR_KEY);
        const row = getDb().prepare('SELECT key_ciphertext FROM ai_providers WHERE id = ?').get(saved.body.provider.id) as { key_ciphertext: string };
        expect(row.key_ciphertext).toBeTruthy();
        expect(row.key_ciphertext).not.toContain(OR_KEY);
        expect(row.key_ciphertext).not.toContain('sk-or-');
        const listed = await owner.get('/api/dashboard/super-admin/ai/providers');
        expect(JSON.stringify(listed.body)).not.toContain(OR_KEY);

        mutableEnv.shouldUseMockProviders = false;
        setModelCatalogForTests([{ id: 'openrouter/free', free: true, image: false, audio: false, tools: true, contextLength: 100000 }]);
        resetAiRouterForTests();
        const seen: Array<{ url: string; auth: string | null; model: string }> = [];
        vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
          seen.push({ url: String(url), auth: new Headers(init?.headers).get('authorization'), model: String((JSON.parse(String(init?.body)) as { model?: string }).model) });
          return json(200, { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Hello from the saved key.' } }] });
        }));
        const result = await runWithAccount(acc, () => routeCompletion({ task: 'chat', messages: [{ role: 'user', content: 'hi' }], maxTokens: 20, deadline: Date.now() + 8000 })) as { choices: Array<{ message: { content: string } }> };
        expect(result.choices[0]!.message.content).toBe('Hello from the saved key.');
        expect(seen[0]).toEqual({ url: 'https://openrouter.ai/api/v1/chat/completions', auth: `Bearer ${OR_KEY}`, model: 'openrouter/free' });
      } finally {
        mutableEnv.shouldUseMockProviders = originalMock;
        setModelCatalogForTests(null);
        resetAiRouterForTests();
      }
    });
  });

  it('the preset list tells the form which vendors choose their model automatically, and its text never mentions a retired fetch feature', () => {
    const payload = presetsPayload();
    expect(Object.fromEntries(payload.presets.map((p) => [p.id, p.autoSelect]))).toEqual({ openrouter: true, groq: true, google: true, xai: false, mistral: true, cerebras: false, openai: false, anthropic: false, deepseek: true, omniroute: true, custom: false });
    expect(JSON.stringify(payload)).not.toMatch(/discovery|fetch/i);
    expect(VENDORS.every((v) => Array.isArray(v.probeModels))).toBe(true);
  });

  it('the old "Fetch available models" feature stays gone (no super-admin endpoint, button or wording); its successor is the explicit "Load models" suggestion list, which never chooses or enables a model', async () => {
    expect((await owner.post('/api/dashboard/super-admin/ai/discover-models').send({ provider: 'groq', config: GROQ_KEY })).status).toBe(404);
    // "Load models" (2026-10-28, requested by the owner): a key-less request is answered with a plain refusal, never a list and never a saved provider
    const load = await owner.post('/api/dashboard/ai-routing/discover-models').set('X-Whatsapp-Account', String(acc)).send({ vendor: 'groq' });
    expect(load.status).toBe(200);
    expect(load.body).toMatchObject({ ok: false, reason: 'missing_key' });
    const app_js = fs.readFileSync(path.join(__dirname, '..', '..', 'dashboard', 'app.js'), 'utf8');
    expect(app_js).not.toMatch(/Fetch available models|ai-fetch-models|discoverUrl|super-admin\/ai\/discover-models/);
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
