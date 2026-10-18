import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/config/env', async () => {
  const actual = await vi.importActual<typeof import('../../../src/config/env')>('../../../src/config/env');
  return { ...actual, env: { ...actual.env, shouldUseMockProviders: false, OPENROUTER_FALLBACK_MODELS: '', AI_ROUTING_BUDGET_MS: 6000, AI_ROUTE_MAX_ATTEMPTS: 4 } };
});

import { env } from '../../../src/config/env';
import { getDb } from '../../../src/memory/db';
import { createAccount } from '../../../src/accounts/accountRepo';
import { runWithAccount } from '../../../src/accounts/accountContext';
import { AiCredentialError } from '../../../src/llm/aiCredentialError';
import { AiResponseError } from '../../../src/llm/aiResponseError';
import { adapterFor, endpointMatchesVendor, vendorById, vendorForUrl, VENDORS } from '../../../src/llm/adapters';
import { fromGeminiResponse, pacificMidnightDelayMs, quotaInfo, toGeminiRequest } from '../../../src/llm/adapters/geminiAdapter';
import { allowUnknownPriceForTests, resetAiRouterForTests, routeCompletion } from '../../../src/llm/aiRouter';
import { createProvider, PROVIDER_RULES } from '../../../src/llm/providerRepo';
import { setModelCatalogForTests } from '../../../src/llm/modelCatalog';

const mutableEnv = env as unknown as Record<string, unknown>;
const GKEY = 'AIzaSyGeminiGeminiGeminiGeminiGemini000000';
const GROQ = 'gsk_groqgroqgroqgroqgroqgroqgroqgroq000000000';
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => ({ ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => body, text: async () => JSON.stringify(body) });
const geminiOk = (text: string) => json(200, { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] });
const header = (call: unknown[], name: string): string => String(((call[1] as RequestInit).headers as Record<string, string>)[name] ?? '');
const body = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body)) as Record<string, any>;
const originalKey = mutableEnv.OPENROUTER_API_KEY;

beforeEach(() => { mutableEnv.OPENROUTER_API_KEY = ''; });
afterEach(() => { vi.unstubAllGlobals(); mutableEnv.OPENROUTER_API_KEY = originalKey; });

describe('vendor identity', () => {
  it('Groq and xAI are different vendors with different official hosts, adapters registered per vendor', () => {
    expect(vendorById('groq')!.hosts).toEqual(['api.groq.com']);
    expect(vendorById('xai')!.hosts).toEqual(['api.x.ai']);
    expect(vendorForUrl('https://api.groq.com/openai/v1').id).toBe('groq');
    expect(vendorForUrl('https://api.x.ai/v1').id).toBe('xai');
    expect(vendorForUrl('https://somewhere.example.com/v1').id).toBe('custom');
    expect(vendorById('google')!.adapter).toBe('gemini');
    expect(vendorById('openrouter')!.adapter).toBe('openrouter');
    expect(['groq', 'xai', 'mistral', 'custom'].every((id) => vendorById(id)!.adapter === 'openai')).toBe(true);
  });

  it('a known vendor refuses any address that is not its official API host (a console / key page is not an API); custom accepts any https address', () => {
    expect(endpointMatchesVendor('groq', 'https://console.groq.com/keys')).toBe(false);
    expect(endpointMatchesVendor('groq', 'https://api.groq.com/openai/v1')).toBe(true);
    expect(endpointMatchesVendor('custom', 'https://anything.example.com/v1')).toBe(true);
  });

  it('a model id can never be an address (the production Groq mistake: the key-page URL typed as the model)', () => {
    expect(PROVIDER_RULES.model.test('https://console.groq.com/keys')).toBe(false);
    expect(PROVIDER_RULES.model.test('openai/gpt-oss-20b')).toBe(true);
    expect(PROVIDER_RULES.model.test('models/gemini-x')).toBe(true);
  });

  it('only OpenRouter can prove a price; every other vendor needs the administrator to confirm the free tier', () => {
    expect(VENDORS.filter((v) => v.free.mode === 'catalog').map((v) => v.id)).toEqual(['openrouter']);
  });

  it('no vendor lists a default model that was not seen in its live model list (only Groq and OpenRouter have a verified default)', () => {
    expect(VENDORS.filter((v) => v.verifiedDefault).map((v) => v.id).sort()).toEqual(['groq', 'openrouter']);
  });
});

describe('OpenAI-protocol adapter (Groq, Mistral, xAI, custom)', () => {
  it('sends a chat completion to {base}/chat/completions with Bearer authentication and returns the answer (no model list is ever requested)', async () => {
    const fetchSpy = vi.fn(async () => json(200, { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }] }));
    vi.stubGlobal('fetch', fetchSpy);
    const res = await adapterFor('openai').complete({ baseUrl: 'https://api.groq.com/openai/v1', apiKey: GROQ, model: 'openai/gpt-oss-20b', messages: [{ role: 'user', content: 'hi' }], timeoutMs: 3000 });
    expect(String(fetchSpy.mock.calls[0]![0])).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(header(fetchSpy.mock.calls[0]!, 'Authorization')).toBe(`Bearer ${GROQ}`);
    expect(body(fetchSpy.mock.calls[0]!)).toMatchObject({ model: 'openai/gpt-oss-20b' });
    expect(res.choices[0]!.message.content).toBe('ok');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('adapters expose no model-list call: a model is trusted only after a real inference answered', () => {
    for (const id of ['openai', 'openrouter', 'gemini']) expect(Object.keys(adapterFor(id)).sort()).toEqual(['authentication', 'complete', 'id']);
  });

  it.each([[401, 'credential'], [403, 'credential'], [429, 'rate_limited'], [503, 'provider_error']])('chat HTTP %i is normalised as %s', async (status, expected) => {
    vi.stubGlobal('fetch', vi.fn(async () => json(status, { error: { message: 'x' } })));
    let caught: unknown;
    try { await adapterFor('openai').complete({ baseUrl: 'https://api.example.com/v1', apiKey: GROQ, model: 'm', messages: [{ role: 'user', content: 'hi' }], timeoutMs: 2000 }); } catch (e) { caught = e; }
    if (expected === 'credential') expect(caught).toBeInstanceOf(AiCredentialError); else expect((caught as AiResponseError).reason).toBe(expected);
  });
});

describe('Gemini native adapter', () => {
  it('serialises the request in Gemini\'s own contract: path, key header, systemInstruction, roles, tool declarations without unsupported keywords', async () => {
    const fetchSpy = vi.fn(async () => geminiOk('hello'));
    vi.stubGlobal('fetch', fetchSpy);
    const res = await adapterFor('gemini').complete({
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: GKEY, model: 'gemini-test', timeoutMs: 3000, temperature: 0.2, maxTokens: 50,
      messages: [{ role: 'system', content: 'You are helpful.' }, { role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }, { role: 'user', content: 'again' }],
      tools: [{ type: 'function', function: { name: 'lookup', description: 'find', parameters: { type: 'object', additionalProperties: false, properties: { q: { type: 'string', default: 'x' } }, required: ['q'] } } }] as never,
    });
    const call = fetchSpy.mock.calls[0]!;
    expect(String(call[0])).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent');
    expect(header(call, 'x-goog-api-key')).toBe(GKEY);
    expect(header(call, 'Authorization')).toBe(''); // Google does not use a Bearer header here
    const sent = body(call);
    expect(sent.systemInstruction).toEqual({ parts: [{ text: 'You are helpful.' }] });
    expect(sent.contents.map((c: { role: string }) => c.role)).toEqual(['user', 'model', 'user']);
    expect(sent.generationConfig).toEqual({ temperature: 0.2, maxOutputTokens: 50 + 1024 }); // headroom for the model's hidden thinking
    expect(JSON.stringify(sent.tools)).not.toMatch(/additionalProperties|default/);
    expect(sent.tools[0].functionDeclarations[0]).toMatchObject({ name: 'lookup', parameters: { type: 'object', required: ['q'] } });
    expect(res.choices[0]!.message).toMatchObject({ role: 'assistant', content: 'hello' });
  });

  it('maps tool calls both ways: functionCall → tool_calls, tool result → functionResponse under the function\'s name', () => {
    const request = toGeminiRequest({ baseUrl: '', apiKey: null, model: 'm', timeoutMs: 1000, messages: [
      { role: 'user', content: 'book it' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'book', arguments: '{"slot":"10:00"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
    ] }) as { contents: Array<{ role: string; parts: Array<Record<string, any>> }> };
    expect(request.contents[1]).toEqual({ role: 'model', parts: [{ functionCall: { name: 'book', args: { slot: '10:00' } } }] });
    expect(request.contents[2]).toEqual({ role: 'user', parts: [{ functionResponse: { name: 'book', response: { ok: true } } }] });
    const parsed = fromGeminiResponse({ candidates: [{ content: { parts: [{ functionCall: { name: 'book', args: { slot: '11:00' } } }] }, finishReason: 'STOP' }] }, 'm');
    expect(parsed.choices[0]!.finish_reason).toBe('tool_calls');
    expect(parsed.choices[0]!.message.tool_calls![0]!.function).toEqual({ name: 'book', arguments: '{"slot":"11:00"}' });
  });

  it('an answer with no text and no call is a failure; a prompt blocked by Google\'s safety policy is a refusal of the request, not an outage', () => {
    expect(() => fromGeminiResponse({ candidates: [{ content: { parts: [] } }] }, 'm')).toThrow(AiResponseError);
    try { fromGeminiResponse({ promptFeedback: { blockReason: 'SAFETY' } }, 'm'); throw new Error('no'); } catch (e) { expect((e as AiResponseError).reason).toBe('model_unavailable'); }
  });

  it.each([
    [400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.' } }, 'credential'],
    [403, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'denied' } }, 'credential'],
    [404, { error: { code: 404, status: 'NOT_FOUND', message: 'models/x is not found' } }, 'model_unavailable'],
    [429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota, please check your plan and billing details.' } }, 'payment_required'],
    [429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Too many requests, retry shortly.' } }, 'rate_limited'],
    [503, { error: { code: 503, status: 'UNAVAILABLE', message: 'overloaded' } }, 'provider_error'],
  ])('Gemini HTTP %i is normalised (%#)', async (status, errBody, expected) => {
    vi.stubGlobal('fetch', vi.fn(async () => json(status, errBody)));
    let caught: unknown;
    try { await adapterFor('gemini').complete({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: GKEY, model: 'x', timeoutMs: 2000, messages: [{ role: 'user', content: 'hi' }] }); } catch (e) { caught = e; }
    if (expected === 'credential') expect(caught).toBeInstanceOf(AiCredentialError); else expect((caught as AiResponseError).reason).toBe(expected);
    expect(JSON.stringify(String((caught as Error).message))).not.toContain(GKEY);
  });

  it('quota 429s use what Google says: a per-minute limit waits the stated RetryInfo delay, a per-day limit rests until the daily reset (never retried in between)', async () => {
    const perMinute = { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for metric', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] }, { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '34s' }] } };
    vi.stubGlobal('fetch', vi.fn(async () => json(429, perMinute)));
    const ask = () => adapterFor('gemini').complete({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: GKEY, model: 'x', timeoutMs: 2000, messages: [{ role: 'user', content: 'hi' }] });
    const minute = await ask().catch((e) => e as AiResponseError);
    expect(minute).toMatchObject({ reason: 'rate_limited', retryAfterMs: 34_000 });
    const perDay = { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for metric', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }, { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '20s' }] } };
    vi.stubGlobal('fetch', vi.fn(async () => json(429, perDay)));
    const day = await ask().catch((e) => e as AiResponseError);
    expect(day.reason).toBe('rate_limited');
    expect(day.providerMessage).toMatch(/daily quota/);
    expect(day.retryAfterMs!).toBeGreaterThan(20_000); // the daily reset, not the 20 s hint: retrying in 20 s would call an exhausted quota again
    expect(day.retryAfterMs!).toBeLessThanOrEqual(24 * 3600_000);
  });

  it('quotaInfo reads quota ids and the retry delay and tolerates bodies without them; the daily reset delay is between one minute and a day', () => {
    expect(quotaInfo('not json')).toEqual({ quotaIds: [], retryDelayMs: null });
    expect(quotaInfo(JSON.stringify({ error: { details: [{ '@type': 'x.RetryInfo', retryDelay: '1.5s' }] } }))).toEqual({ quotaIds: [], retryDelayMs: 1500 });
    for (const t of [Date.UTC(2026, 9, 18, 7, 0, 0), Date.UTC(2026, 9, 18, 6, 59, 59), Date.UTC(2026, 0, 5, 8, 0, 0), Date.UTC(2026, 6, 1, 12, 34, 56)]) {
      const d = pacificMidnightDelayMs(t);
      expect(d).toBeGreaterThanOrEqual(60_000);
      expect(d).toBeLessThanOrEqual(24 * 3600_000);
    }
    // 07:00 UTC in October is 00:00 Pacific (PDT): the next reset is a full day away; one second before it, the delay is clamped to one minute.
    expect(pacificMidnightDelayMs(Date.UTC(2026, 9, 18, 7, 0, 0))).toBe(24 * 3600_000);
    expect(pacificMidnightDelayMs(Date.UTC(2026, 9, 18, 6, 59, 59))).toBe(60_000);
  });
});

describe('the router speaks each provider through its own adapter', () => {
  let acc: number;
  beforeEach(() => {
    getDb();
    getDb().prepare('DELETE FROM ai_providers').run();
    acc = createAccount({ name: `Adapter Co ${Math.random()}` }).id;
    setModelCatalogForTests([]);
    allowUnknownPriceForTests(false);
    resetAiRouterForTests();
  });
  const ask = () => routeCompletion({ task: 'chat', messages: [{ role: 'user', content: 'hi' }], maxTokens: 8, temperature: 0, deadline: Date.now() + 5000 });

  it('a native Gemini provider is called with generateContent and, when its quota is exhausted, the router fails over to the next provider', async () => {
    createProvider({ name: 'Gemini', kind: 'openai_compatible', adapter: 'gemini', vendor: 'google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: GKEY, models: ['gemini-test'], priority: 10, timeoutMs: 3000 }, { accountId: null, updatedBy: 1 });
    createProvider({ name: 'Groq', kind: 'openai_compatible', adapter: 'openai', vendor: 'groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: GROQ, models: ['openai/gpt-oss-20b'], priority: 20, timeoutMs: 3000 }, { accountId: null, updatedBy: 1 });
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url));
      if (String(url).includes('generativelanguage')) return json(429, { error: { status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota' } });
      return json(200, { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'from groq' } }] });
    }));
    const res = await runWithAccount(acc, ask);
    expect(res.route.candidate.providerName).toBe('Groq');
    expect(res.choices[0]!.message.content).toBe('from groq');
    expect(calls[0]).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent');
    expect(calls[1]).toBe('https://api.groq.com/openai/v1/chat/completions');
  });
});
