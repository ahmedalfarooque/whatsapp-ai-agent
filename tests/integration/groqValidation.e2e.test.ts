import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '../../src/memory/db';
import { env } from '../../src/config/env';
import { createProvider, getProvider } from '../../src/llm/providerRepo';
import { runProviderTest } from '../../src/dashboard/aiRoutingRoutes';
import { adapterFor, VENDORS } from '../../src/llm/adapters';
import { autoSelectModel } from '../../src/llm/autoSetup';
import { validationBudget, VALIDATION_RETRY_CAP } from '../../src/llm/validationBudget';
import { allowUnknownPriceForTests, resetAiRouterForTests } from '../../src/llm/aiRouter';
import { setModelCatalogForTests } from '../../src/llm/modelCatalog';

/**
 * Groq's reasoning models (openai/gpt-oss-20b) spend the completion budget on hidden reasoning: with 8 tokens the answer comes back EMPTY, with 256 it answers
 * (verified by the owner). The network here is SCRIPTED to behave that way (mocked): these tests prove the validation budget, the single bounded retry and the
 * failed-validation handling — not that Groq's live API still behaves like this.
 */
const mutableEnv = env as unknown as Record<string, unknown>;
const GROQ_KEY = 'gsk_groqvalidategroqvalidategroqvalidate0000000';
const OR_KEY = 'sk-or-v1-groqvalidategroqvalidategroqvalidate00000';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const reasoningOnly = () => json(200, { choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: '', reasoning: 'The user wants one word, let me think about it…' } }] });
const answered = () => json(200, { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok', reasoning: 'short thought' } }] });

type Sent = { url: string; body: Record<string, unknown> };
let sent: Sent[];
/** `needs` = the least completion budget at which the scripted model still has room left for a visible answer. */
function reasoningModel(needs: number) {
  sent = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    sent.push({ url: String(url), body });
    const budget = Number(body.max_completion_tokens ?? body.max_tokens ?? 0);
    return budget >= needs ? answered() : reasoningOnly();
  }));
}
const budgetsSent = (): number[] => sent.map((s) => Number(s.body.max_completion_tokens ?? s.body.max_tokens));

const originalMock = mutableEnv.shouldUseMockProviders;
beforeEach(() => {
  mutableEnv.shouldUseMockProviders = false;
  getDb().prepare('DELETE FROM ai_providers').run();
  setModelCatalogForTests([{ id: 'openrouter/free', free: true, image: false, audio: false, tools: true, contextLength: 100000 }]);
  allowUnknownPriceForTests(false);
  resetAiRouterForTests();
});
afterEach(() => { mutableEnv.shouldUseMockProviders = originalMock; vi.unstubAllGlobals(); });

const groqRow = () => getProvider(createProvider({ name: 'Groq', kind: 'openai_compatible', adapter: 'openai', vendor: 'groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: GROQ_KEY, models: ['openai/gpt-oss-20b'], timeoutMs: 3000, freeConfirmed: true }, { accountId: null, updatedBy: 1 }).id)!;

describe('the validation budget', () => {
  it('Groq validates with 256 tokens, everyone else with 8; the retry is larger, bounded, and chosen per vendor', () => {
    expect(validationBudget('groq', 'https://api.groq.com/openai/v1')).toEqual({ first: 256, retry: 1024 });
    expect(validationBudget('openrouter', 'https://openrouter.ai/api/v1')).toEqual({ first: 8, retry: 256 });
    expect(validationBudget('google', '')).toEqual({ first: 8, retry: 256 });
    expect(validationBudget(undefined, 'https://api.groq.com/openai/v1').first).toBe(256); // recognised from the address when the vendor id is missing
    for (const v of VENDORS) expect(validationBudget(v.id, v.baseUrl).retry).toBeLessThanOrEqual(VALIDATION_RETRY_CAP);
  });

  it('Groq is sent its documented `max_completion_tokens`; every other endpoint keeps `max_tokens`', async () => {
    reasoningModel(1);
    await adapterFor('openai').complete({ baseUrl: 'https://api.groq.com/openai/v1', apiKey: GROQ_KEY, model: 'openai/gpt-oss-20b', messages: [{ role: 'user', content: 'hi' }], maxTokens: 256, timeoutMs: 3000 });
    expect(sent[0]!.body).toMatchObject({ max_completion_tokens: 256 });
    expect(sent[0]!.body).not.toHaveProperty('max_tokens');
    await adapterFor('openai').complete({ baseUrl: 'https://api.example.com/v1', apiKey: GROQ_KEY, model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 256, timeoutMs: 3000 });
    expect(sent[1]!.body).toMatchObject({ max_tokens: 256 });
    expect(sent[1]!.body).not.toHaveProperty('max_completion_tokens');
  });
});

describe('Settings → Test on a Groq provider', () => {
  it('a reasoning model that needs ~100 tokens passes on the FIRST request now (it used to come back empty at 8 tokens)', async () => {
    reasoningModel(100);
    const row = groqRow();
    const result = await runProviderTest(row);
    expect(result).toMatchObject({ ok: true });
    expect(budgetsSent()).toEqual([256]);
    expect(getProvider(row.id)!.last_test_ok).toBe(1);
  });

  it('an empty (reasoning-only) answer at 256 is a failed validation that is retried ONCE with the bounded larger budget, and then passes', async () => {
    reasoningModel(500);
    const result = await runProviderTest(groqRow());
    expect(result.ok).toBe(true);
    expect(budgetsSent()).toEqual([256, 1024]); // exactly one retry, nothing in between (the router does not repeat a request whose budget was spent on reasoning)
  });

  it('still empty at the larger budget: the validation FAILS, honestly, after exactly two requests — nothing is invented and nothing loops', async () => {
    reasoningModel(5000);
    const row = groqRow();
    const result = await runProviderTest(row);
    expect(result.ok).toBe(false);
    expect(result.category).toBe('empty_response');
    expect(result.detail).toMatch(/empty/i);
    expect(budgetsSent()).toEqual([256, 1024]);
    expect(getProvider(row.id)!.last_test_ok).toBe(0);
  });

  it('only an EMPTY answer earns the retry: a rate limit, a rejected key or an unavailable model is not repeated with a bigger budget', async () => {
    for (const status of [429, 401, 404]) {
      resetAiRouterForTests();
      sent = [];
      vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => { sent.push({ url: '', body: JSON.parse(String(init?.body)) as Record<string, unknown> }); return json(status, { error: { message: 'no' } }); }));
      const result = await runProviderTest(groqRow());
      expect(result.ok).toBe(false);
      expect(budgetsSent().every((b) => b === 256)).toBe(true); // never 1024
      expect(budgetsSent().length).toBeLessThanOrEqual(2); // at most the router's own single quick retry of a sole route
    }
  });

  it('other vendors keep their small budget and still get ONE bounded retry on an empty answer (OpenRouter: 8, then 256)', async () => {
    reasoningModel(100);
    const row = getProvider(createProvider({ name: 'OpenRouter', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: OR_KEY, models: ['openrouter/free'], timeoutMs: 3000 }, { accountId: null, updatedBy: 1 }).id)!;
    const result = await runProviderTest(row);
    expect(result.ok).toBe(true);
    expect(budgetsSent()).toEqual([8, 256]);
  });
});

describe('automatic setup when a Groq key is saved', () => {
  const groq = VENDORS.find((v) => v.id === 'groq')!;

  it('the model is confirmed with the 256-token budget in one request', async () => {
    reasoningModel(100);
    const result = await autoSelectModel(groq, groq.baseUrl, GROQ_KEY);
    expect(result).toMatchObject({ ok: true, models: ['openai/gpt-oss-20b'] });
    expect(budgetsSent()).toEqual([256]);
  });

  it('a reasoning-only answer is retried once at the larger budget (the model is then accepted and the detail says so)', async () => {
    reasoningModel(500);
    const result = await autoSelectModel(groq, groq.baseUrl, GROQ_KEY);
    expect(result).toMatchObject({ ok: true, models: ['openai/gpt-oss-20b'] });
    expect(budgetsSent()).toEqual([256, 1024]);
    expect(result.attempts[0]!.detail).toMatch(/1024 tokens/);
  });

  it('never answering visibly: the key is kept with the documented default but NOT marked verified, at most two requests per candidate model', async () => {
    reasoningModel(100000);
    const result = await autoSelectModel(groq, groq.baseUrl, GROQ_KEY);
    expect(result).toMatchObject({ ok: true, verified: false, models: ['openai/gpt-oss-20b'] });
    expect(result.ok && result.testFailure).toMatch(/No model answered a real test request/);
    expect(budgetsSent()).toEqual([256, 1024, 256, 1024]); // gpt-oss-20b then gpt-oss-120b, each asked twice at most
  });
});
