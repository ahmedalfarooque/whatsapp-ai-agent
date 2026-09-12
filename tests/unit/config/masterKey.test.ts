import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('masterKey', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('derives a stable 32-byte key from a valid DASHBOARD_MASTER_KEY', async () => {
    const { getSecretEncryptionKey } = await import('../../../src/config/masterKey');
    const key1 = getSecretEncryptionKey();
    const key2 = getSecretEncryptionKey();
    expect(key1.length).toBe(32);
    expect(key1.equals(key2)).toBe(true); // cached, stable across calls
  });

  it('derives different keys for different master keys', async () => {
    const snapshot = process.env.DASHBOARD_MASTER_KEY;
    try {
      const { getSecretEncryptionKey: getA } = await import('../../../src/config/masterKey');
      const keyA = getA();

      vi.resetModules();
      process.env.DASHBOARD_MASTER_KEY = '0'.repeat(64); // valid, different, hex-encoded
      const { getSecretEncryptionKey: getB } = await import('../../../src/config/masterKey');
      const keyB = getB();

      expect(keyA.equals(keyB)).toBe(false);
    } finally {
      process.env.DASHBOARD_MASTER_KEY = snapshot;
      vi.resetModules();
    }
  });
});
