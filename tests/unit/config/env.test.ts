import { describe, it, expect, vi } from 'vitest';

describe('env validation', () => {
  it('loads successfully with the test env vars from tests/setup.ts', async () => {
    const { env } = await import('../../../src/config/env');
    expect(env.WHATSAPP_PHONE_NUMBER_ID).toBe('1234567890');
    expect(env.RESTART_KEYWORDS).toContain('restart');
    expect(env.BUSINESS_DAYS).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('throws a clear error when a required variable is missing', async () => {
    const originalToken = process.env.WHATSAPP_ACCESS_TOKEN;
    delete process.env.WHATSAPP_ACCESS_TOKEN;
    vi.resetModules();

    await expect(import('../../../src/config/env')).rejects.toThrow(
      /Invalid environment configuration/,
    );

    process.env.WHATSAPP_ACCESS_TOKEN = originalToken;
    vi.resetModules();
  });
});
