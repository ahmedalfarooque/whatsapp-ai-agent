import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '../../../src/memory/db';
import { env } from '../../../src/config/env';
import { createAccount } from '../../../src/accounts/accountRepo';
import { runWithAccount } from '../../../src/accounts/accountContext';
import { updateBusinessSettings } from '../../../src/config/businessSettings';
import { chatCompletion, validateCompletion } from '../../../src/llm/openRouterClient';
import { AiResponseError } from '../../../src/llm/aiResponseError';
import { AiCredentialError } from '../../../src/llm/aiCredentialError';
import { runAgentLoop } from '../../../src/llm/agentLoop';

const mutableEnv = env as unknown as Record<string, unknown>;
const KEY = 'sk-or-v1-clientclientclientclientclientclientclientclient00';
const originalMock = mutableEnv.shouldUseMockProviders;
const originalKey = mutableEnv.OPENROUTER_API_KEY;
const messages = [{ role: 'user' as const, content: 'hello' }];

const okBody = (content: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content, ...extra } }] });
const json = (status: number, body: string) => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });

function sequence(...responses: Array<() => Response | Promise<Response>>) {
  let i = 0;
  const fn = vi.fn(async () => responses[Math.min(i++, responses.length - 1)]!());
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeAll(() => {
  getDb();
  expect(createAccount({ name: 'Second Business' }).id).toBe(2);
});

beforeEach(() => {
  mutableEnv.shouldUseMockProviders = false;
  mutableEnv.OPENROUTER_API_KEY = KEY;
  getDb().prepare('UPDATE business_settings SET open_router_model = NULL').run();
});

afterEach(() => {
  mutableEnv.shouldUseMockProviders = originalMock;
  mutableEnv.OPENROUTER_API_KEY = originalKey;
  vi.unstubAllGlobals();
});

describe('validateCompletion', () => {
  it('accepts text and tool calls, normalises content parts, and rejects everything else', () => {
    expect(validateCompletion(JSON.parse(okBody('  hi  ')), 'm').choices[0]!.message.content).toBe('hi');
    expect(validateCompletion(JSON.parse(okBody([{ type: 'text', text: 'he' }, { type: 'text', text: 'llo' }])), 'm').choices[0]!.message.content).toBe('hello');
    expect(() => validateCompletion(JSON.parse(okBody(null, { tool_calls: [{ id: 'c', type: 'function', function: { name: 'x', arguments: '{}' } }] })), 'm')).not.toThrow();
    for (const bad of [okBody(''), okBody('   '), okBody(null), okBody([]), okBody([{ type: 'image', url: 'x' }])]) {
      expect(() => validateCompletion(JSON.parse(bad), 'm')).toThrowError(expect.objectContaining({ reason: 'empty_response', httpStatus: 200, model: 'm' }));
    }
    for (const bad of [{}, { choices: [] }, { choices: [{}] }, { choices: [{ message: null }] }, null, 'text']) {
      expect(() => validateCompletion(bad, 'm')).toThrowError(expect.objectContaining({ reason: 'malformed_response' }));
    }
  });
});

describe('chatCompletion with the real provider code path (network stubbed)', () => {
  it('returns a non-empty answer and sends this account\'s model with a bearer key that never appears in the result', async () => {
    const fetchMock = sequence(() => json(200, okBody('hello there')));
    const result = await chatCompletion({ messages });
    expect(result.choices[0]!.message.content).toBe('hello there');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(JSON.parse(String(init.body)).model).toBe('openai/gpt-4o-mini');
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it('resolves the model per account: one account\'s model never changes another\'s request', async () => {
    updateBusinessSettings({ openRouterModel: 'vendor/second-account-model' }, 2);
    const fetchMock = sequence(() => json(200, okBody('a')));
    await chatCompletion({ messages });
    await runWithAccount(2, () => chatCompletion({ messages }));
    await chatCompletion({ messages });
    const models = fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)).model);
    expect(models).toEqual(['openai/gpt-4o-mini', 'vendor/second-account-model', 'openai/gpt-4o-mini']);
  });

  it('HTTP 200 with an empty message is a failure: retried exactly ONCE, then reported as empty_response', async () => {
    const fetchMock = sequence(() => json(200, okBody('')));
    const error = await chatCompletion({ messages }).catch((e) => e);
    expect(error).toBeInstanceOf(AiResponseError);
    expect(error).toMatchObject({ reason: 'empty_response', httpStatus: 200, model: 'openai/gpt-4o-mini' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(error.message)).not.toContain(KEY);
  });

  it('an empty answer followed by a good one succeeds on the single retry', async () => {
    const fetchMock = sequence(() => json(200, okBody(null)), () => json(200, okBody('second try works')));
    expect((await chatCompletion({ messages })).choices[0]!.message.content).toBe('second try works');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('malformed bodies are never retried', async () => {
    for (const body of ['not json at all', '{}', '{"choices":[]}', '{"choices":[{"message":null}]}']) {
      const fetchMock = sequence(() => json(200, body));
      await expect(chatCompletion({ messages })).rejects.toMatchObject({ reason: 'malformed_response' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it('a model refused by the account policy (404) is not retried and carries the provider\'s short reason, not the request', async () => {
    const fetchMock = sequence(() => json(404, JSON.stringify({ error: { message: '0 endpoints available matching your guardrail restrictions and data policy.\nZDR violation', code: 404 } })));
    const error = await chatCompletion({ messages: [{ role: 'user', content: 'SECRET CUSTOMER TEXT' }] }).catch((e) => e);
    expect(error).toMatchObject({ reason: 'model_unavailable', httpStatus: 404, model: 'openai/gpt-4o-mini' });
    expect(error.providerMessage).toContain('data policy');
    expect(error.providerMessage).not.toContain('\n');
    expect(JSON.stringify({ message: error.message, provider: error.providerMessage })).not.toMatch(/SECRET CUSTOMER TEXT|sk-or/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rate limits and provider errors are retried at most twice (3 calls), then reported with their category', async () => {
    const limited = sequence(() => json(429, JSON.stringify({ error: { message: 'Provider returned error' } })));
    await expect(chatCompletion({ messages })).rejects.toMatchObject({ reason: 'rate_limited', httpStatus: 429 });
    expect(limited).toHaveBeenCalledTimes(3);
    const broken = sequence(() => json(503, '{}'));
    await expect(chatCompletion({ messages })).rejects.toMatchObject({ reason: 'provider_error', httpStatus: 503 });
    expect(broken).toHaveBeenCalledTimes(3);
  });

  it('a rate limit that clears is recovered from; a dropped connection is a provider_error', async () => {
    const recovering = sequence(() => json(429, '{}'), () => json(200, okBody('back')));
    expect((await chatCompletion({ messages })).choices[0]!.message.content).toBe('back');
    expect(recovering).toHaveBeenCalledTimes(2);
    sequence(() => { throw new TypeError('fetch failed'); });
    await expect(chatCompletion({ messages })).rejects.toMatchObject({ reason: 'provider_error', httpStatus: null });
  });

  it('a rejected key (401/403) is a credential problem and is never retried', async () => {
    const fetchMock = sequence(() => json(401, '{}'));
    await expect(chatCompletion({ messages })).rejects.toBeInstanceOf(AiCredentialError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('the agent loop never turns a failed answer into a success', () => {
  it('an empty provider answer surfaces as an error to the pipeline (no fallback text is invented)', async () => {
    sequence(() => json(200, okBody('')));
    await expect(runAgentLoop({ systemPrompt: 's', history: [{ role: 'user', content: 'hi', tool_call_id: null, tool_name: null } as never], conversationId: 1 })).rejects.toMatchObject({ reason: 'empty_response' });
  });

  it('a real answer passes through unchanged', async () => {
    sequence(() => json(200, okBody('Our hours are listed in the profile.')));
    const result = await runAgentLoop({ systemPrompt: 's', history: [{ role: 'user', content: 'hi', tool_call_id: null, tool_name: null } as never], conversationId: 1 });
    expect(result.finalText).toBe('Our hours are listed in the profile.');
    expect(result.generatedMessages).toEqual([{ role: 'assistant', content: 'Our hours are listed in the profile.' }]);
  });
});
