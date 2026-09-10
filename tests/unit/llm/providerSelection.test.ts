import { describe, it, expect, vi, afterEach } from 'vitest';

async function withIsolatedEnv(mutate: () => void, run: () => Promise<void>) {
  const snapshot = { ...process.env };
  try {
    mutate();
    vi.resetModules();
    await run();
  } finally {
    process.env = snapshot;
    vi.unstubAllGlobals();
    vi.resetModules();
  }
}

describe('OpenRouter provider selection', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('development mode never calls OpenRouter — uses the deterministic mock', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await withIsolatedEnv(
      () => {
        process.env.NODE_ENV = 'development';
      },
      async () => {
        const { chatCompletion } = await import('../../../src/llm/openRouterClient');
        const result = await chatCompletion({ messages: [{ role: 'user', content: 'hi' }] });

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(result.choices[0].message.content).toContain('DEV MODE MOCK REPLY');
      },
    );
  });

  it('production mode calls the real OpenRouter endpoint (network attempted, not mocked)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'real reply' } }],
      }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    await withIsolatedEnv(
      () => {
        process.env.NODE_ENV = 'production';
        process.env.WHATSAPP_ACCESS_TOKEN = 'real-token';
        process.env.WHATSAPP_PHONE_NUMBER_ID = 'real-phone-id';
        process.env.WHATSAPP_VERIFY_TOKEN = 'real-verify-token';
        process.env.META_APP_SECRET = 'real-app-secret';
        process.env.OPENROUTER_API_KEY = 'real-openrouter-key';
        process.env.GOOGLE_CLIENT_EMAIL = 'real@example.iam.gserviceaccount.com';
        process.env.GOOGLE_PRIVATE_KEY = 'real-private-key';
      },
      async () => {
        const { chatCompletion } = await import('../../../src/llm/openRouterClient');
        const result = await chatCompletion({ messages: [{ role: 'user', content: 'hi' }] });

        expect(fetchSpy).toHaveBeenCalledOnce();
        const calledUrl = fetchSpy.mock.calls[0][0];
        expect(calledUrl).toContain('openrouter.ai');
        expect(result.choices[0].message.content).toBe('real reply');
      },
    );
  });
});
