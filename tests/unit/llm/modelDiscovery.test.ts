import { describe, expect, it, vi } from 'vitest';
import { discoverModels, type Fetcher } from '../../../src/llm/modelDiscovery';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const run = (fetcher: Fetcher, input: Parameters<typeof discoverModels>[0]) => discoverModels(input, { fetch: fetcher, allowLocal: false });

describe('model discovery per vendor (mocked HTTP: no real provider was contacted)', () => {
  it('OpenAI: Bearer key, /models, ids only; nothing is assumed free', async () => {
    const f = vi.fn<Fetcher>(async () => json({ data: [{ id: 'gpt-b' }, { id: 'gpt-a' }, { id: 'https://evil/x' }] }));
    const r = await run(f, { vendor: 'openai', apiKey: 'sk-test' });
    expect(f.mock.calls[0][0]).toBe('https://api.openai.com/v1/models');
    expect((f.mock.calls[0][1].headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    expect(f.mock.calls[0][1].redirect).toBe('error');
    expect(r.ok && r.models.map((m) => m.id)).toEqual(['gpt-a', 'gpt-b']);
    expect(r.ok && r.models.every((m) => m.price === 'paid_or_unknown')).toBe(true);
  });

  it('DeepSeek, Groq, Mistral, xAI use the same OpenAI-compatible list on their own hosts', async () => {
    for (const [vendor, host] of [['deepseek', 'api.deepseek.com'], ['groq', 'api.groq.com'], ['mistral', 'api.mistral.ai'], ['xai', 'api.x.ai']] as const) {
      const f = vi.fn<Fetcher>(async () => json({ data: [{ id: 'm1' }] }));
      const r = await run(f, { vendor, apiKey: 'k-12345678' });
      expect(r.ok).toBe(true);
      expect(new URL(f.mock.calls[0][0]).hostname).toBe(host);
    }
  });

  it('Anthropic: x-api-key plus version header, not Bearer', async () => {
    const f = vi.fn<Fetcher>(async () => json({ data: [{ id: 'claude-x', display_name: 'Claude X' }] }));
    const r = await run(f, { vendor: 'anthropic', apiKey: 'sk-ant-test' });
    const h = f.mock.calls[0][1].headers as Record<string, string>;
    expect(h['x-api-key']).toBe('sk-ant-test');
    expect(h['anthropic-version']).toBeTruthy();
    expect(h.Authorization).toBeUndefined();
    expect(r.ok && r.models[0]).toEqual({ id: 'claude-x', label: 'Claude X', price: 'paid_or_unknown' });
  });

  it('Gemini: key in a header (not the URL), only generateContent models, "models/" prefix removed', async () => {
    const f = vi.fn<Fetcher>(async () => json({ models: [
      { name: 'models/gemini-chat', displayName: 'Chat', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/embed', supportedGenerationMethods: ['embedContent'] },
    ] }));
    const r = await run(f, { vendor: 'google', apiKey: 'AIza-test-key' });
    expect(f.mock.calls[0][0]).not.toContain('AIza');
    expect((f.mock.calls[0][1].headers as Record<string, string>)['x-goog-api-key']).toBe('AIza-test-key');
    expect(r.ok && r.models.map((m) => m.id)).toEqual(['gemini-chat']);
  });

  it('OpenRouter: only price 0/0 is marked free', async () => {
    const f = vi.fn<Fetcher>(async () => json({ data: [
      { id: 'a/free:free', pricing: { prompt: '0', completion: '0' } },
      { id: 'b/paid', pricing: { prompt: '0.000001', completion: '0.000002' } },
      { id: 'c/unknown' },
    ] }));
    const r = await run(f, { vendor: 'openrouter', apiKey: 'sk-or-test' });
    expect(r.ok && r.models.map((m) => [m.id, m.price])).toEqual([['a/free:free', 'free'], ['b/paid', 'paid_or_unknown'], ['c/unknown', 'paid_or_unknown']]);
  });

  it('refuses a key-less request, a foreign host for a known vendor, and a plain-http custom endpoint — before any request', async () => {
    const f = vi.fn<Fetcher>();
    expect((await run(f, { vendor: 'openai', apiKey: '' })).ok).toBe(false);
    expect(await run(f, { vendor: 'openai', apiKey: 'sk-x', baseUrl: 'https://evil.example.com/v1' })).toMatchObject({ ok: false, reason: 'endpoint_refused' });
    expect(await run(f, { vendor: 'custom', apiKey: 'sk-x', baseUrl: 'http://example.com/v1' })).toMatchObject({ ok: false, reason: 'endpoint_refused' });
    expect(await run(f, { vendor: 'custom', apiKey: 'sk-x', baseUrl: 'https://169.254.169.254/v1' })).toMatchObject({ ok: false, reason: 'endpoint_refused' });
    expect(await run(f, { vendor: 'nope', apiKey: 'sk-x' })).toMatchObject({ ok: false, reason: 'unsupported_vendor' });
    expect(f).not.toHaveBeenCalled();
  });

  it('classifies failures with sanitized messages that never contain the key', async () => {
    const key = 'sk-secret-value-123';
    const cases: Array<[Fetcher, string]> = [
      [async () => json({ error: 'no' }, 401), 'rejected'],
      [async () => json({ error: 'no' }, 403), 'rejected'],
      [async () => json({}, 429), 'rate_limited'],
      [async () => json({}, 404), 'unsupported'],
      [async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }, 'unreachable'],
      [async () => new Response('<html>', { status: 200 }), 'unreadable'],
      [async () => json({ data: [] }), 'unreadable'],
    ];
    for (const [fetcher, reason] of cases) {
      const r = await run(fetcher, { vendor: 'openai', apiKey: key });
      expect(r).toMatchObject({ ok: false, reason });
      expect(JSON.stringify(r)).not.toContain(key);
    }
  });

  it('caps a huge list', async () => {
    const f: Fetcher = async () => json({ data: Array.from({ length: 900 }, (_, i) => ({ id: `m-${i}` })) });
    const r = await run(f, { vendor: 'openai', apiKey: 'sk-x' });
    expect(r.ok && r.models.length).toBe(400);
    expect(r.ok && r.truncated).toBe(true);
  });
});
