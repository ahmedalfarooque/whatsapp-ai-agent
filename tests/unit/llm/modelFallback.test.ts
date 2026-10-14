import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/config/env', async () => {
  const actual = await vi.importActual<typeof import('../../../src/config/env')>('../../../src/config/env');
  return { ...actual, env: { ...actual.env, shouldUseMockProviders: false, OPENROUTER_FALLBACK_MODELS: '' } };
});

import { chatCompletion } from '../../../src/llm/openRouterClient';
import { AiResponseError } from '../../../src/llm/aiResponseError';
import { AiCredentialError } from '../../../src/llm/aiCredentialError';
import { setModelCatalogForTests, type ModelInfo } from '../../../src/llm/modelCatalog';
import { chooseFallback, classifyFailure, resetModelFallbackForTests, freeFallbackBlocked } from '../../../src/llm/modelFallback';
import { getDb } from '../../../src/memory/db';
import { createAccount } from '../../../src/accounts/accountRepo';
import { runWithAccount } from '../../../src/accounts/accountContext';
import { getBusinessSettings, updateBusinessSettings } from '../../../src/config/businessSettings';
import { env } from '../../../src/config/env';

/**
 * The bounded model fallback of the OpenRouter client, with the real client code and a stubbed network. Proves: a model-specific failure
 * switches ONCE to an eligible fallback with the very same conversation; a 402 switches only to a FREE model and, when that fails too,
 * marks free fallback blocked; a rejected key or a network failure never switches; a text-only model is never given a picture; every
 * attempt is recorded for staff; and the fallback list is per business (a new business inherits the shared default, never a neighbour's).
 */
const PRIMARY = 'openai/gpt-4.1-mini';
const FREE_TEXT = 'nvidia/nemotron-3.5-lightning:free';
const FREE_VISION = 'google/gemma-4-31b-it:free';
const PAID_ALT = 'anthropic/claude-haiku';
const CATALOG: ModelInfo[] = [
  { id: PRIMARY, free: false, image: true, audio: false, tools: true, contextLength: 1_000_000 },
  { id: FREE_TEXT, free: true, image: false, audio: false, tools: true, contextLength: 1_000_000 },
  { id: FREE_VISION, free: true, image: true, audio: false, tools: true, contextLength: 262_144 },
  { id: PAID_ALT, free: false, image: true, audio: false, tools: true, contextLength: 200_000 },
];
const ok = (text: string) => ({ ok: true, status: 200, json: async () => ({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }] }), text: async () => '' });
const fail = (status: number, message: string) => ({ ok: false, status, json: async () => ({ error: { message } }), text: async () => JSON.stringify({ error: { message } }) });
const CAP_402 = 'Prompt tokens limit exceeded: 7335 > 5458. To increase, visit https://openrouter.ai/settings/credits';
const ZDR_404 = '0 endpoints out of 1 requested are available matching your guardrail restrictions and data policy. ZDR violation (account setting)';
const bodyOf = (fetchSpy: ReturnType<typeof vi.fn>, call: number) => JSON.parse(String((fetchSpy.mock.calls[call] as unknown as [string, RequestInit])[1].body)) as { model: string; messages: unknown[] };

let ACC: number;
let fetchSpy: ReturnType<typeof vi.fn>;
const mutableEnv = env as unknown as Record<string, unknown>;
const KEY = 'sk-or-v1-fallbackfallbackfallbackfallbackfallback00000';
const originalKey = mutableEnv.OPENROUTER_API_KEY;

beforeEach(() => {
  getDb();
  ACC = ACC ?? createAccount({ name: 'Fallback Test Co' }).id;
  runWithAccount(ACC, () => updateBusinessSettings({ openRouterModel: PRIMARY, openRouterFallbackModels: `${FREE_TEXT},${PAID_ALT}` }, ACC));
  setModelCatalogForTests(CATALOG);
  resetModelFallbackForTests();
  mutableEnv.OPENROUTER_API_KEY = KEY;
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
  mutableEnv.OPENROUTER_API_KEY = originalKey;
  setModelCatalogForTests(null);
});

const ask = (extra: Partial<Parameters<typeof chatCompletion>[0]> = {}) => runWithAccount(ACC, () => chatCompletion({ messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'hi' }], deadline: Date.now() + 30_000, ...extra }));

describe('free-model fallback after a primary quota failure (HTTP 402)', () => {
  it('the primary fails with the credit-derived token cap; the FREE fallback is tried once with the SAME messages and answers; the paid alternative is never tried', async () => {
    fetchSpy.mockResolvedValueOnce(fail(402, CAP_402)).mockResolvedValueOnce(ok('Hello from the free model'));
    const result = await ask();
    expect(result.choices[0]!.message.content).toBe('Hello from the free model');
    expect(result.servedBy).toEqual({ model: FREE_TEXT, fallbackFrom: PRIMARY, fallbackReason: 'payment_required' });
    expect(fetchSpy).toHaveBeenCalledTimes(2); // a 402 is never retried on the same model
    expect(bodyOf(fetchSpy, 0).model).toBe(PRIMARY);
    expect(bodyOf(fetchSpy, 1).model).toBe(FREE_TEXT);
    expect(bodyOf(fetchSpy, 1).messages).toEqual(bodyOf(fetchSpy, 0).messages); // language, knowledge and context preserved: identical conversation
  });

  it('ACCOUNT-WIDE: when the free fallback fails too (402, or 404 because the account policy blocks free endpoints) both attempts are recorded, free fallback is marked blocked, and the next message does not try it again', async () => {
    fetchSpy.mockResolvedValueOnce(fail(402, CAP_402)).mockResolvedValueOnce(fail(404, ZDR_404));
    const error = await ask().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiResponseError);
    const e = error as AiResponseError;
    expect(e.reason).toBe('payment_required');
    expect(e.model).toBe(PRIMARY); // the dashboard still recognises the configured model in the detail
    expect(e.attempts.map((a) => [a.model, a.reason, a.httpStatus])).toEqual([[PRIMARY, 'payment_required', 402], [FREE_TEXT, 'model_unavailable', 404]]);
    expect(e.describe()).toMatch(/also tried nvidia\/nemotron-3\.5-lightning:free \(model unavailable, HTTP 404\)/);
    expect(freeFallbackBlocked()).toMatch(/free model refused, HTTP 404/);
    fetchSpy.mockClear();
    fetchSpy.mockResolvedValueOnce(fail(402, CAP_402));
    const again = (await ask().catch((err: unknown) => err)) as AiResponseError;
    expect(fetchSpy).toHaveBeenCalledTimes(1); // only the primary: switching cannot help while the account is blocked
    expect(again.fallbackSkipped).toMatch(/free fallback blocked for this account/);
  });

  it('NO FREE FALLBACK: with only paid alternatives configured a 402 ends after the primary, naming why nothing else was tried', async () => {
    runWithAccount(ACC, () => updateBusinessSettings({ openRouterFallbackModels: PAID_ALT }, ACC));
    fetchSpy.mockResolvedValueOnce(fail(402, CAP_402));
    const e = (await ask().catch((err: unknown) => err)) as AiResponseError;
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(e.attempts).toHaveLength(1);
    expect(e.fallbackSkipped).toMatch(/anthropic\/claude-haiku: not free, a 402 would repeat/);
    expect(e.describe()).toMatch(/no fallback: anthropic\/claude-haiku: not free/);
  });
});

describe('model-specific failures and the limits of switching', () => {
  it('a refused primary (HTTP 404) switches once to the first eligible fallback (paid is fine here: nothing to do with credit) and the primary enters a cooldown', async () => {
    runWithAccount(ACC, () => updateBusinessSettings({ openRouterFallbackModels: PAID_ALT }, ACC));
    fetchSpy.mockResolvedValueOnce(fail(404, 'No endpoints found')).mockResolvedValueOnce(ok('alt answer'));
    const result = await ask();
    expect(result.servedBy?.model).toBe(PAID_ALT);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(await chooseFallback(PAID_ALT, [PRIMARY], 'model', { tools: false, image: false, audio: false })).toMatchObject({ model: null, skipped: expect.stringMatching(/cooling down/) });
  });

  it('a rejected KEY (HTTP 401) and a NETWORK failure never switch models', async () => {
    fetchSpy.mockResolvedValueOnce(fail(401, 'User not found'));
    await expect(ask()).rejects.toBeInstanceOf(AiCredentialError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockClear();
    fetchSpy.mockRejectedValue(Object.assign(new Error('getaddrinfo ENOTFOUND'), { name: 'TypeError' }));
    const e = (await ask({ retries: 0 }).catch((err: unknown) => err)) as AiResponseError;
    expect(e.network).toBe(true);
    expect(classifyFailure(e)).toBe('network');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(e.fallbackSkipped).toMatch(/network failure: switching models cannot help/);
  });

  it('CAPABILITY: a request that carries a picture is never handed to a text-only fallback; an image-capable free model is chosen instead', async () => {
    runWithAccount(ACC, () => updateBusinessSettings({ openRouterFallbackModels: `${FREE_TEXT},${FREE_VISION}` }, ACC));
    fetchSpy.mockResolvedValueOnce(fail(402, CAP_402)).mockResolvedValueOnce(ok('I see a car'));
    const result = await ask({ requires: { image: true }, allowFallback: true });
    expect(result.servedBy?.model).toBe(FREE_VISION);
    expect(bodyOf(fetchSpy, 1).model).toBe(FREE_VISION);
    // and with no image-capable fallback at all, nothing is tried
    runWithAccount(ACC, () => updateBusinessSettings({ openRouterFallbackModels: FREE_TEXT }, ACC));
    fetchSpy.mockClear();
    fetchSpy.mockResolvedValueOnce(fail(402, CAP_402));
    const e = (await ask({ requires: { image: true }, allowFallback: true }).catch((err: unknown) => err)) as AiResponseError;
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(e.fallbackSkipped).toMatch(/no image input/);
  });

  it('a caller that names its own model (the vision / audio steps) gets no automatic switch unless it asks for one', async () => {
    fetchSpy.mockResolvedValueOnce(fail(404, 'no endpoints'));
    const e = (await ask({ model: PRIMARY }).catch((err: unknown) => err)) as AiResponseError;
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(e.fallbackSkipped).toBeNull();
  });

  it('a 402 after a TOOL round switches within the same round with the tool results in place: the tool is never re-run and the loop is never restarted', async () => {
    const toolRow = { role: 'tool' as const, tool_call_id: 'call_1', name: 'get_hours', content: '{"open":true}' };
    fetchSpy.mockResolvedValueOnce(fail(402, CAP_402)).mockResolvedValueOnce(ok('We are open until 6'));
    const result = await ask({ messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'open?' }, { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_hours', arguments: '{}' } }] }, toolRow] });
    expect(result.servedBy?.model).toBe(FREE_TEXT);
    const sent = bodyOf(fetchSpy, 1).messages as Array<{ role: string; tool_call_id?: string }>;
    expect(sent.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
  });
});

describe('every business keeps its own fallback list; a new business inherits the shared default only', () => {
  it('account A sets a list, account B keeps the shared env default (empty here), and a brand-new business never sees A\'s list', () => {
    const other = createAccount({ name: 'Neighbour Co' }).id;
    expect(runWithAccount(ACC, () => getBusinessSettings(ACC)).openRouterFallbackModels).toEqual([FREE_TEXT, PAID_ALT]);
    expect(runWithAccount(other, () => getBusinessSettings(other)).openRouterFallbackModels).toEqual([]);
    runWithAccount(other, () => updateBusinessSettings({ openRouterFallbackModels: '' }, other)); // explicitly none
    expect(runWithAccount(other, () => getBusinessSettings(other)).openRouterFallbackModels).toEqual([]);
    runWithAccount(ACC, () => updateBusinessSettings({ openRouterFallbackModels: null }, ACC)); // back to the shared default
    expect(runWithAccount(ACC, () => getBusinessSettings(ACC)).openRouterFallbackModels).toEqual([]);
  });
});
