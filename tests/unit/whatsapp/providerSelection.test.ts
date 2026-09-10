import { describe, it, expect, vi, afterEach } from 'vitest';

/** Snapshots and restores process.env + global.fetch around a test. */
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

describe('WhatsApp provider selection', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('development mode never touches the real network — uses the mock provider', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await withIsolatedEnv(
      () => {
        process.env.NODE_ENV = 'development';
      },
      async () => {
        const { sendTextMessage } = await import('../../../src/whatsapp/client');
        const result = await sendTextMessage('15551234567', 'hi');

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(result.messages[0].id).toMatch(/^mock-wamid-/);
      },
    );
  });

  it('production mode calls the real Graph API client (network attempted, not mocked)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        messaging_product: 'whatsapp',
        contacts: [{ input: '15551234567', wa_id: '15551234567' }],
        messages: [{ id: 'wamid.REAL' }],
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
        const { sendTextMessage } = await import('../../../src/whatsapp/client');
        const result = await sendTextMessage('15551234567', 'hi');

        expect(fetchSpy).toHaveBeenCalledOnce();
        expect(result.messages[0].id).toBe('wamid.REAL');
      },
    );
  });
});
