import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Required in production only when WHATSAPP_CONNECTION_METHOD=meta. */
const META_CLOUD_API_KEYS = [
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_VERIFY_TOKEN',
  'META_APP_SECRET',
] as const;

/** Required in production regardless of the WhatsApp transport. */
const ALWAYS_PRODUCTION_REQUIRED_KEYS = ['OPENROUTER_API_KEY'] as const;

const PRODUCTION_REQUIRED_KEYS = [...META_CLOUD_API_KEYS, ...ALWAYS_PRODUCTION_REQUIRED_KEYS] as const;

/** Snapshots and restores process.env around a test that mutates it. */
function withEnvSnapshot(fn: () => Promise<void> | void) {
  return async () => {
    const snapshot = { ...process.env };
    try {
      await fn();
    } finally {
      process.env = snapshot;
      vi.resetModules();
    }
  };
}

describe('env validation', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('loads successfully with the test env vars from tests/setup.ts', async () => {
    const { env } = await import('../../../src/config/env');
    expect(env.WHATSAPP_PHONE_NUMBER_ID).toBe('1234567890');
    expect(env.RESTART_KEYWORDS).toContain('restart');
    expect(env.BUSINESS_DAYS).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  describe('development mode', () => {
    it(
      'starts successfully with no real integration credentials at all',
      withEnvSnapshot(async () => {
        process.env.NODE_ENV = 'development';
        for (const key of PRODUCTION_REQUIRED_KEYS) delete process.env[key];

        const { env } = await import('../../../src/config/env');
        expect(env.isProduction).toBe(false);
        expect(env.isDevelopment).toBe(true);
      }),
    );

    it(
      'selects mock providers (shouldUseMockProviders = true)',
      withEnvSnapshot(async () => {
        process.env.NODE_ENV = 'development';
        const { env } = await import('../../../src/config/env');
        expect(env.shouldUseMockProviders).toBe(true);
      }),
    );
  });

  describe('test mode (as used by the automated test suite itself)', () => {
    it(
      'also tolerates missing credentials and selects mock providers',
      withEnvSnapshot(async () => {
        process.env.NODE_ENV = 'test';
        for (const key of PRODUCTION_REQUIRED_KEYS) delete process.env[key];

        const { env } = await import('../../../src/config/env');
        expect(env.isProduction).toBe(false);
        expect(env.shouldUseMockProviders).toBe(true);
      }),
    );
  });

  describe('WHATSAPP_CONNECTION_METHOD', () => {
    it(
      'defaults to the QR transport when unset',
      withEnvSnapshot(async () => {
        delete process.env.WHATSAPP_CONNECTION_METHOD;
        const { env } = await import('../../../src/config/env');
        expect(env.whatsappConnectionMethod).toBe('qr');
        expect(env.usesMetaCloudApi).toBe(false);
      }),
    );

    it(
      'treats a blank value as the default (qr)',
      withEnvSnapshot(async () => {
        process.env.WHATSAPP_CONNECTION_METHOD = '';
        const { env } = await import('../../../src/config/env');
        expect(env.whatsappConnectionMethod).toBe('qr');
        expect(env.usesMetaCloudApi).toBe(false);
      }),
    );

    it(
      'accepts meta',
      withEnvSnapshot(async () => {
        process.env.WHATSAPP_CONNECTION_METHOD = 'meta';
        const { env } = await import('../../../src/config/env');
        expect(env.whatsappConnectionMethod).toBe('meta');
        expect(env.usesMetaCloudApi).toBe(true);
      }),
    );

    it(
      'rejects an unknown transport name',
      withEnvSnapshot(async () => {
        process.env.WHATSAPP_CONNECTION_METHOD = 'telegram';
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(import('../../../src/config/env')).rejects.toThrow(
          /Invalid environment configuration/,
        );
        expect(errorSpy.mock.calls.flat().join('\n')).toContain('WHATSAPP_CONNECTION_METHOD');
        errorSpy.mockRestore();
      }),
    );
  });

  describe('production mode', () => {
    function setAllProductionCreds() {
      process.env.NODE_ENV = 'production';
      process.env.WHATSAPP_ACCESS_TOKEN = 'real-token';
      process.env.WHATSAPP_PHONE_NUMBER_ID = 'real-phone-id';
      process.env.WHATSAPP_VERIFY_TOKEN = 'real-verify-token';
      process.env.META_APP_SECRET = 'real-app-secret';
      process.env.OPENROUTER_API_KEY = 'real-openrouter-key';
      delete process.env.GOOGLE_CLIENT_EMAIL;
      delete process.env.GOOGLE_PRIVATE_KEY;
    }

    describe('QR transport (WHATSAPP_CONNECTION_METHOD=qr, the default)', () => {
      it(
        'starts successfully with OPENROUTER_API_KEY and NO Meta credentials at all',
        withEnvSnapshot(async () => {
          process.env.NODE_ENV = 'production';
          delete process.env.WHATSAPP_CONNECTION_METHOD;
          process.env.OPENROUTER_API_KEY = 'real-openrouter-key';
          for (const key of META_CLOUD_API_KEYS) delete process.env[key];
          delete process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
          delete process.env.GOOGLE_CLIENT_EMAIL;
          delete process.env.GOOGLE_PRIVATE_KEY;

          const { env } = await import('../../../src/config/env');
          expect(env.isProduction).toBe(true);
          expect(env.shouldUseMockProviders).toBe(false);
          expect(env.whatsappConnectionMethod).toBe('qr');
          expect(env.usesMetaCloudApi).toBe(false);
        }),
      );

      it(
        'also starts when qr is set explicitly and Meta credentials are absent',
        withEnvSnapshot(async () => {
          process.env.NODE_ENV = 'production';
          process.env.WHATSAPP_CONNECTION_METHOD = 'qr';
          process.env.OPENROUTER_API_KEY = 'real-openrouter-key';
          for (const key of META_CLOUD_API_KEYS) delete process.env[key];

          await expect(import('../../../src/config/env')).resolves.toBeDefined();
        }),
      );

      it(
        'still accepts Meta credentials when they happen to be present',
        withEnvSnapshot(async () => {
          setAllProductionCreds();
          process.env.WHATSAPP_CONNECTION_METHOD = 'qr';
          const { env } = await import('../../../src/config/env');
          expect(env.isProduction).toBe(true);
          expect(env.shouldUseMockProviders).toBe(false);
        }),
      );

      it.each(ALWAYS_PRODUCTION_REQUIRED_KEYS)(
        'still rejects startup when %s is missing',
        (missingKey) =>
          withEnvSnapshot(async () => {
            setAllProductionCreds();
            process.env.WHATSAPP_CONNECTION_METHOD = 'qr';
            delete process.env[missingKey];

            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            await expect(import('../../../src/config/env')).rejects.toThrow(
              /Invalid environment configuration/,
            );
            expect(errorSpy.mock.calls.flat().join('\n')).toContain(missingKey);
            errorSpy.mockRestore();
          })(),
      );
    });

    describe('Meta Cloud API transport (WHATSAPP_CONNECTION_METHOD=meta)', () => {
      it(
        'starts successfully and selects real providers when every credential is present',
        withEnvSnapshot(async () => {
          setAllProductionCreds();
          process.env.WHATSAPP_CONNECTION_METHOD = 'meta';
          const { env } = await import('../../../src/config/env');
          expect(env.isProduction).toBe(true);
          expect(env.shouldUseMockProviders).toBe(false);
          expect(env.usesMetaCloudApi).toBe(true);
        }),
      );

      it.each(PRODUCTION_REQUIRED_KEYS)(
        'rejects startup when %s is missing',
        (missingKey) =>
          withEnvSnapshot(async () => {
            setAllProductionCreds();
            process.env.WHATSAPP_CONNECTION_METHOD = 'meta';
            delete process.env[missingKey];

            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            await expect(import('../../../src/config/env')).rejects.toThrow(
              /Invalid environment configuration/,
            );
            expect(errorSpy.mock.calls.flat().join('\n')).toContain(missingKey);
            errorSpy.mockRestore();
          })(),
      );

      it(
        'reports every missing credential at once, not just the first',
        withEnvSnapshot(async () => {
          process.env.NODE_ENV = 'production';
          process.env.WHATSAPP_CONNECTION_METHOD = 'meta';
          for (const key of PRODUCTION_REQUIRED_KEYS) delete process.env[key];

          const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
          await expect(import('../../../src/config/env')).rejects.toThrow();

          const loggedText = errorSpy.mock.calls.flat().join('\n');
          for (const key of PRODUCTION_REQUIRED_KEYS) {
            expect(loggedText).toContain(key);
          }
          errorSpy.mockRestore();
        }),
      );
    });

    it(
      'never requires Meta credentials merely because NODE_ENV=production',
      withEnvSnapshot(async () => {
        process.env.NODE_ENV = 'production';
        delete process.env.WHATSAPP_CONNECTION_METHOD;
        process.env.OPENROUTER_API_KEY = 'real-openrouter-key';
        for (const key of META_CLOUD_API_KEYS) delete process.env[key];

        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(import('../../../src/config/env')).resolves.toBeDefined();
        expect(errorSpy).not.toHaveBeenCalled();
        errorSpy.mockRestore();
      }),
    );
  });

  describe('DASHBOARD_MASTER_KEY (required unconditionally, every environment)', () => {
    it(
      'rejects startup when the key is missing, even in development',
      withEnvSnapshot(async () => {
        process.env.NODE_ENV = 'development';
        process.env.DASHBOARD_MASTER_KEY = '';

        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(import('../../../src/config/env')).rejects.toThrow(
          /Invalid environment configuration/,
        );
        expect(errorSpy.mock.calls.flat().join('\n')).toContain('DASHBOARD_MASTER_KEY');
        errorSpy.mockRestore();
      }),
    );

    it(
      'rejects a key that does not decode to exactly 32 bytes',
      withEnvSnapshot(async () => {
        process.env.NODE_ENV = 'development';
        process.env.DASHBOARD_MASTER_KEY = 'dG9vLXNob3J0'; // base64, well under 32 bytes

        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(import('../../../src/config/env')).rejects.toThrow(
          /Invalid environment configuration/,
        );
        expect(errorSpy.mock.calls.flat().join('\n')).toContain('DASHBOARD_MASTER_KEY');
        errorSpy.mockRestore();
      }),
    );

    it(
      'accepts a valid 32-byte base64 key',
      withEnvSnapshot(async () => {
        process.env.NODE_ENV = 'development';
        process.env.DASHBOARD_MASTER_KEY = 'DZLe+BvfUId17vxA3cwqtF4GC0L+Zeh3LkN+CEvlxng=';

        await expect(import('../../../src/config/env')).resolves.toBeDefined();
      }),
    );

    it(
      'accepts a valid 32-byte hex key',
      withEnvSnapshot(async () => {
        process.env.NODE_ENV = 'development';
        process.env.DASHBOARD_MASTER_KEY = '0'.repeat(64);

        await expect(import('../../../src/config/env')).resolves.toBeDefined();
      }),
    );
  });
});
