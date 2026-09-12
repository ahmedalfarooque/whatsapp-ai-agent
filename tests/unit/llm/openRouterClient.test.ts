import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../src/config/env', async () => {
  const actual = await vi.importActual<typeof import('../../../src/config/env')>(
    '../../../src/config/env',
  );
  return { ...actual, env: { ...actual.env, shouldUseMockProviders: false } };
});

import { chatCompletion } from '../../../src/llm/openRouterClient';

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const VALID_COMPLETION = {
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Hello!' } }],
};

describe('OpenRouter client — HTTP behavior', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns a successful completion on the first try', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, VALID_COMPLETION));

    const result = await chatCompletion({ messages: [{ role: 'user', content: 'hi' }] });

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(result.choices[0].message.content).toBe('Hello!');
  });

  it('never sends secrets in a way visible outside the Authorization header (sanity check on request shape)', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, VALID_COMPLETION));
    await chatCompletion({ messages: [{ role: 'user', content: 'hi' }] });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toContain('openrouter.ai');
    const bodyText = init.body as string;
    expect(bodyText).not.toContain('Bearer');
  });

  it('treats a response with no choices as a malformed response and throws', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, { choices: [] }));

    await expect(chatCompletion({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(
      /no choices/,
    );
  });

  it('retries on 429 and eventually succeeds', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(429, { error: 'rate limited' }))
      .mockResolvedValueOnce(jsonResponse(200, VALID_COMPLETION));

    const result = await chatCompletion({ messages: [{ role: 'user', content: 'hi' }] });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.choices[0].message.content).toBe('Hello!');
  });

  it('retries on 5xx and eventually succeeds', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(500, { error: 'internal error' }))
      .mockResolvedValueOnce(jsonResponse(200, VALID_COMPLETION));

    const result = await chatCompletion({ messages: [{ role: 'user', content: 'hi' }] });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.choices[0].message.content).toBe('Hello!');
  });

  it('does NOT retry a 4xx client error (e.g. bad request) — surfaces it immediately', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(400, { error: 'bad request' }));

    await expect(chatCompletion({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(/400/);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('retries a timeout/network error (safe here — a lost response never causes a duplicate side effect, since our code only acts on a response it actually parses)', async () => {
    fetchSpy
      .mockRejectedValueOnce(new DOMException('The operation was aborted', 'AbortError'))
      .mockResolvedValueOnce(jsonResponse(200, VALID_COMPLETION));

    const result = await chatCompletion({ messages: [{ role: 'user', content: 'hi' }] });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.choices[0].message.content).toBe('Hello!');
  });

  it('eventually gives up and throws after exhausting retries on repeated 5xx', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(503, { error: 'down' }));

    await expect(chatCompletion({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(/503/);
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(1);
  });
});
