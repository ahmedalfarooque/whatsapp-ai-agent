import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/config/env', async () => {
  const actual = await vi.importActual<typeof import('../../../src/config/env')>('../../../src/config/env');
  return { ...actual, env: { ...actual.env, shouldUseMockProviders: false, OPENROUTER_FALLBACK_MODELS: '', AI_ROUTING_BUDGET_MS: 6000, AI_ROUTE_MAX_ATTEMPTS: 4 } };
});

import { env } from '../../../src/config/env';
import { getDb } from '../../../src/memory/db';
import { createAccount } from '../../../src/accounts/accountRepo';
import { runWithAccount } from '../../../src/accounts/accountContext';
import { AiResponseError } from '../../../src/llm/aiResponseError';
import { allowUnknownPriceForTests, buildCandidates, resetAiRouterForTests, routeCompletion } from '../../../src/llm/aiRouter';
import { createProvider } from '../../../src/llm/providerRepo';
import { setModelCatalogForTests } from '../../../src/llm/modelCatalog';
import { validateCompletion } from '../../../src/llm/openAiCompatible';
import { fromGeminiResponse } from '../../../src/llm/adapters/geminiAdapter';
import { aiRouteAvailable } from '../../../src/replay/replayWorker';

const mutableEnv = env as unknown as Record<string, unknown>;
const KEY = 'sk-or-v1-dailydailydailydailydailydailydaily000000000000';
const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) });
const originalKey = mutableEnv.OPENROUTER_API_KEY;
const ask = () => routeCompletion({ task: 'chat', messages: [{ role: 'user', content: 'hi' }], maxTokens: 8, temperature: 0, deadline: Date.now() + 5000 });
let acc: number;

beforeEach(() => {
  getDb();
  getDb().prepare('DELETE FROM ai_providers').run();
  acc = createAccount({ name: `Daily Co ${Math.random()}` }).id;
  createProvider({ name: 'OpenRouter', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: KEY, models: ['openrouter/free', 'other/free-model'], priority: 10, timeoutMs: 3000 }, { accountId: null, updatedBy: 1 });
  setModelCatalogForTests([{ id: 'openrouter/free', free: true, image: false, audio: false, tools: true, contextLength: 100000 }, { id: 'other/free-model', free: true, image: false, audio: false, tools: true, contextLength: 100000 }]);
  allowUnknownPriceForTests(false);
  resetAiRouterForTests();
  mutableEnv.OPENROUTER_API_KEY = '';
});
afterEach(() => { vi.unstubAllGlobals(); mutableEnv.OPENROUTER_API_KEY = originalKey; });

describe('a daily free allowance is not retried every minute', () => {
  it('a "per-day" 429 rests the WHOLE provider for 30 minutes (production made ~28 calls in 6 h); a plain 429 rests one route for a minute', async () => {
    const spy = vi.fn(async () => json(429, { error: { message: 'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day' } }));
    vi.stubGlobal('fetch', spy);
    await expect(runWithAccount(acc, ask)).rejects.toBeInstanceOf(AiResponseError);
    const calls = spy.mock.calls.length;
    for (const minutes of [2, 10, 29]) {
      const plan = await runWithAccount(acc, () => buildCandidates(acc, 'chat', { wantsTools: false, now: Date.now() + minutes * 60_000 }));
      expect(plan.eligible).toHaveLength(0); // still resting: no call is made
    }
    // the recovery worker asks the same question before it replays anything: no usable route, so no attempt of a waiting customer message is spent
    expect(await runWithAccount(acc, () => aiRouteAvailable(acc))).toBe(false);
    expect((await runWithAccount(acc, () => buildCandidates(acc, 'chat', { wantsTools: false, now: Date.now() + 31 * 60_000 }))).eligible.length).toBeGreaterThan(0); // eligible again later
    expect(spy.mock.calls.length).toBe(calls);

    resetAiRouterForTests();
    vi.stubGlobal('fetch', vi.fn(async () => json(429, { error: { message: 'Too many requests, slow down' } })));
    await expect(runWithAccount(acc, ask)).rejects.toBeInstanceOf(AiResponseError);
    const soon = await runWithAccount(acc, () => buildCandidates(acc, 'chat', { wantsTools: false, now: Date.now() + 70_000 }));
    expect(soon.eligible.length).toBeGreaterThan(0); // an ordinary rate limit clears within about a minute
  });
});

describe('empty and malformed answers say WHY (and are still failures)', () => {
  it('an empty answer records the finish reason and whether the tokens went to hidden reasoning', () => {
    const run = (choice: Record<string, unknown>) => { try { validateCompletion({ choices: [choice] }, 'm'); } catch (e) { return e as AiResponseError; } throw new Error('should fail'); };
    const length = run({ finish_reason: 'length', message: { role: 'assistant', content: '', reasoning: 'thinking about the question' } });
    expect(length.reason).toBe('empty_response');
    expect(length.providerMessage).toContain('finish_reason=length');
    expect(length.providerMessage).toContain('reasoning text present but no answer');
    const filter = run({ finish_reason: 'content_filter', message: { role: 'assistant', content: null } });
    expect(filter.providerMessage).toBe('empty answer; finish_reason=content_filter');
    expect(run({ message: { role: 'assistant', content: '   ' } }).providerMessage).toBe('empty answer; finish_reason=none');
  });

  it('an error returned INSIDE an HTTP 200 body is the provider\'s real error (rate limit, outage), not "malformed"', () => {
    const run = (body: unknown) => { try { validateCompletion(body, 'm'); } catch (e) { return e as AiResponseError; } throw new Error('should fail'); };
    const limited = run({ error: { code: 429, message: 'Rate limit exceeded: free-models-per-day' } });
    expect(limited).toMatchObject({ reason: 'rate_limited', httpStatus: 429 });
    expect(limited.providerMessage).toContain('free-models-per-day');
    expect(run({ error: { code: 502, message: 'Provider returned error' } })).toMatchObject({ reason: 'provider_error', httpStatus: 502 });
    expect(run({ error: { message: 'odd' } })).toMatchObject({ reason: 'provider_error' });
  });

  it('a body with neither choices nor an error stays malformed and names only the fields that arrived (never values)', () => {
    try { validateCompletion({ id: 'gen-123', secret_value: 'do-not-print', usage: {} }, 'm'); throw new Error('no'); } catch (e) {
      const err = e as AiResponseError;
      expect(err.reason).toBe('malformed_response');
      expect(err.providerMessage).toBe('no choices in the answer (fields: id, secret_value, usage)');
      expect(err.providerMessage).not.toContain('do-not-print');
    }
  });

  it('Gemini: an answer with no text and no call records its finishReason; it is still a failure', () => {
    try { fromGeminiResponse({ candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }] }, 'g'); throw new Error('no'); } catch (e) {
      expect((e as AiResponseError).reason).toBe('empty_response');
      expect((e as AiResponseError).providerMessage).toBe('empty answer; finishReason=MAX_TOKENS');
    }
  });
});
