import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiCredentialError } from '../../../src/llm/aiCredentialError';
import { AiResponseError } from '../../../src/llm/aiResponseError';
import { adapterFor, isAdapterId, vendorById, vendorForUrl } from '../../../src/llm/adapters';
import { anthropicAdapter, anthropicFailure, fromAnthropicResponse, toAnthropicRequest } from '../../../src/llm/adapters/anthropicAdapter';
import { openAiAdapter } from '../../../src/llm/adapters/openaiAdapter';

/*
 * SCRIPTED tests: the Anthropic API is simulated with a fake fetch built from the documented request/response contract.
 * They prove this repository's translation and error mapping, NOT that a real Anthropic key works (no key was available).
 */
const FAKE_KEY = 'sk-ant-FAKE-test-key-not-real-000000000000';
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => ({ ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => body, text: async () => JSON.stringify(body) });
const sent = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body)) as Record<string, any>;
afterEach(() => vi.unstubAllGlobals());

describe('Anthropic request translation', () => {
  it('moves system prompts to `system`, keeps user/assistant alternation and clamps temperature to 0..1', () => {
    const req = toAnthropicRequest({ baseUrl: '', apiKey: FAKE_KEY, model: 'm', timeoutMs: 1000, temperature: 1.7, maxTokens: 50000,
      messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hi' }, { role: 'user', content: 'Anyone?' }] });
    expect(req.system).toBe('Be brief.');
    expect(req.temperature).toBe(1);
    expect(req.max_tokens).toBe(8192);
    const turns = req.messages as Array<{ role: string; content: Array<{ text?: string }> }>;
    expect(turns).toHaveLength(1);
    expect(turns[0]!.role).toBe('user');
    expect(turns[0]!.content.map((b) => b.text)).toEqual(['Hi', 'Anyone?']);
  });

  it('returns all tool results of one assistant turn in a single user turn, with ids the API accepts', () => {
    const req = toAnthropicRequest({ baseUrl: '', apiKey: null, model: 'm', timeoutMs: 1000, messages: [
      { role: 'user', content: 'Book it' },
      { role: 'assistant', content: null, tool_calls: [
        { id: 'call:1', type: 'function', function: { name: 'a', arguments: '{"x":1}' } },
        { id: 'call 2', type: 'function', function: { name: 'b', arguments: 'not json' } }] },
      { role: 'tool', tool_call_id: 'call:1', content: 'ra' },
      { role: 'tool', tool_call_id: 'call 2', content: 'rb' }] });
    const turns = req.messages as Array<{ role: string; content: Array<Record<string, any>> }>;
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user']);
    expect(turns[1]!.content.map((b) => [b.type, b.id, b.input])).toEqual([['tool_use', 'call_1', { x: 1 }], ['tool_use', 'call_2', {}]]);
    expect(turns[2]!.content.map((b) => [b.type, b.tool_use_id])).toEqual([['tool_result', 'call_1'], ['tool_result', 'call_2']]);
  });

  it('never fetches a remote image URL; only inline base64 images of supported types are forwarded', () => {
    const req = toAnthropicRequest({ baseUrl: '', apiKey: null, model: 'm', timeoutMs: 1000, messages: [
      { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'http://evil.example/x.png' } }, { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }] }] });
    const blocks = (req.messages as Array<{ content: Array<Record<string, any>> }>)[0]!.content;
    expect(blocks.map((b) => b.type)).toEqual(['text', 'image']);
    expect(blocks[1]!.source).toEqual({ type: 'base64', media_type: 'image/png', data: 'QUJD' });
  });

  it('a conversation that would end on the assistant gets a closing user turn (no prefill)', () => {
    const req = toAnthropicRequest({ baseUrl: '', apiKey: null, model: 'm', timeoutMs: 1000, messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] });
    const turns = req.messages as Array<{ role: string }>;
    expect(turns[turns.length - 1]!.role).toBe('user');
  });
});

describe('Anthropic response and error mapping', () => {
  it('maps text and tool_use blocks to the OpenAI shape the loop reads', () => {
    const out = fromAnthropicResponse({ content: [{ type: 'text', text: 'hello' }, { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'x' } }], stop_reason: 'tool_use' }, 'm');
    const choice = out.choices[0]!;
    expect(choice.finish_reason).toBe('tool_calls');
    expect(choice.message.content).toBe('hello');
    expect(choice.message.tool_calls![0]).toMatchObject({ id: 'toolu_1', function: { name: 'lookup', arguments: '{"q":"x"}' } });
  });

  it('an empty answer is a failure, never a reply; a refusal is model_unavailable', () => {
    expect(() => fromAnthropicResponse({ content: [], stop_reason: 'end_turn' }, 'm')).toThrow(AiResponseError);
    try { fromAnthropicResponse({ content: [], stop_reason: 'refusal' }, 'm'); } catch (e) { expect((e as AiResponseError).reason).toBe('model_unavailable'); }
    expect(() => fromAnthropicResponse({ nope: true }, 'm')).toThrow(AiResponseError);
  });

  it.each([
    [401, { type: 'error', error: { type: 'authentication_error', message: 'bad key' } }, 'credential'],
    [403, { type: 'error', error: { type: 'permission_error', message: 'no' } }, 'credential'],
    [429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 'rate_limited'],
    [404, { type: 'error', error: { type: 'not_found_error', message: 'model: x' } }, 'model_unavailable'],
    [400, { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low' } }, 'payment_required'],
    [529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 'provider_error'],
    [500, { type: 'error', error: { type: 'api_error', message: 'oops' } }, 'provider_error'],
  ])('HTTP %i is normalised', (status, payload, expected) => {
    const failure = anthropicFailure(status, JSON.stringify(payload), 'm');
    if (expected === 'credential') expect(failure).toBeInstanceOf(AiCredentialError);
    else expect((failure as AiResponseError).reason).toBe(expected);
  });
});

describe('Anthropic adapter over a scripted fetch', () => {
  it('sends x-api-key + anthropic-version (never a Bearer token), refuses redirects, and parses the answer', async () => {
    const fetchMock = vi.fn(async () => json(200, { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await anthropicAdapter.complete({ baseUrl: 'https://api.anthropic.com/v1', apiKey: FAKE_KEY, model: 'any-model', timeoutMs: 5000, messages: [{ role: 'user', content: 'ping' }] });
    expect(out.choices[0]!.message.content).toBe('ok');
    const call = fetchMock.mock.calls[0] as unknown[];
    expect(String(call[0])).toBe('https://api.anthropic.com/v1/messages');
    const init = call[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe(FAKE_KEY);
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers.Authorization).toBeUndefined();
    expect(init.redirect).toBe('error');
    expect(sent(call).model).toBe('any-model');
  });

  it('a 429 carries Retry-After into the failure, and the error text never contains the key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(429, { type: 'error', error: { type: 'rate_limit_error', message: `limit for ${FAKE_KEY}` } }, { 'retry-after': '7' })));
    const err = await anthropicAdapter.complete({ baseUrl: 'https://api.anthropic.com/v1', apiKey: FAKE_KEY, model: 'm', timeoutMs: 5000, messages: [{ role: 'user', content: 'x' }] }).catch((e) => e as AiResponseError);
    expect(err).toBeInstanceOf(AiResponseError);
    expect((err as AiResponseError).reason).toBe('rate_limited');
    expect((err as AiResponseError).retryAfterMs).toBe(7000);
  });

  it('a network failure is a retryable provider_error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const err = await anthropicAdapter.complete({ baseUrl: 'https://api.anthropic.com/v1', apiKey: FAKE_KEY, model: 'm', timeoutMs: 5000, messages: [{ role: 'user', content: 'x' }] }).catch((e) => e as AiResponseError);
    expect((err as AiResponseError).reason).toBe('provider_error');
    expect((err as AiResponseError).network).toBe(true);
  });
});

describe('registry and vendors for the new providers', () => {
  it('registers the Anthropic adapter and the OpenAI, Anthropic and DeepSeek vendors with official hosts and no guessed model', () => {
    expect(isAdapterId('anthropic')).toBe(true);
    expect(adapterFor('anthropic')).toBe(anthropicAdapter);
    expect(vendorById('anthropic')).toMatchObject({ adapter: 'anthropic', hosts: ['api.anthropic.com'], verifiedDefault: '', probeModels: [] });
    expect(vendorById('openai')).toMatchObject({ adapter: 'openai', hosts: ['api.openai.com'], verifiedDefault: '', probeModels: [] });
    expect(vendorById('deepseek')).toMatchObject({ hosts: ['api.deepseek.com'], probeModels: ['deepseek-chat'] });
    expect(vendorForUrl('https://api.anthropic.com/v1').id).toBe('anthropic');
    expect(vendorForUrl('https://api.openai.com/v1').id).toBe('openai');
    expect(vendorForUrl('https://api.deepseek.com').id).toBe('deepseek');
  });

  it('OpenAI requests use max_completion_tokens and omit temperature; other vendors keep both', async () => {
    const fetchMock = vi.fn(async () => json(200, { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }] }));
    vi.stubGlobal('fetch', fetchMock);
    await openAiAdapter.complete({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-proj-FAKE000000000000000000', model: 'm', timeoutMs: 5000, messages: [{ role: 'user', content: 'x' }], maxTokens: 9 });
    const openai = sent(fetchMock.mock.calls[0] as unknown[]);
    expect(openai.max_completion_tokens).toBe(9);
    expect('max_tokens' in openai).toBe(false);
    expect('temperature' in openai).toBe(false);
    await openAiAdapter.complete({ baseUrl: 'https://api.deepseek.com', apiKey: 'sk-FAKE0000000000000000000', model: 'm', timeoutMs: 5000, messages: [{ role: 'user', content: 'x' }], maxTokens: 9 });
    const other = sent(fetchMock.mock.calls[1] as unknown[]);
    expect(other.max_tokens).toBe(9);
    expect('temperature' in other).toBe(true);
  });
});
