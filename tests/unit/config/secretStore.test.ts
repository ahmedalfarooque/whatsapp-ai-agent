import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { getDb } from '../../../src/memory/db';
import { setSecret, getSecret, clearSecret, listConfiguredOverrideKeys, maskSecret } from '../../../src/config/secretStore';
import { createAdminUser } from '../../../src/dashboard/auth';

describe('secretStore', () => {
  let adminId: number;

  beforeAll(() => {
    adminId = createAdminUser('secret-store-test-admin', 'a-very-long-password-123');
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM credential_overrides').run();
  });

  it('round-trips an encrypted value', () => {
    setSecret('OPENROUTER_API_KEY', 'sk-real-secret-value-12345', adminId);
    expect(getSecret('OPENROUTER_API_KEY')).toBe('sk-real-secret-value-12345');
  });

  it('returns null for a key with no override', () => {
    expect(getSecret('GOOGLE_CLIENT_EMAIL')).toBeNull();
  });

  it('clearSecret removes the override', () => {
    setSecret('WHATSAPP_ACCESS_TOKEN', 'token-value', adminId);
    clearSecret('WHATSAPP_ACCESS_TOKEN');
    expect(getSecret('WHATSAPP_ACCESS_TOKEN')).toBeNull();
  });

  it('lists exactly the keys with a stored override', () => {
    setSecret('META_APP_SECRET', 'shh', adminId);
    setSecret('GOOGLE_PRIVATE_KEY', 'pem-key', adminId);
    const keys = listConfiguredOverrideKeys().sort();
    expect(keys).toEqual(['GOOGLE_PRIVATE_KEY', 'META_APP_SECRET'].sort());
  });

  it('detects tampering: a flipped ciphertext byte fails to decrypt rather than returning garbage', () => {
    setSecret('OPENROUTER_API_KEY', 'sk-original-value', adminId);
    const row = getDb().prepare('SELECT ciphertext FROM credential_overrides WHERE key = ?').get('OPENROUTER_API_KEY') as {
      ciphertext: string;
    };
    const raw = Buffer.from(row.ciphertext, 'base64');
    raw[raw.length - 1] ^= 0xff; // flip the last byte of the ciphertext
    getDb()
      .prepare('UPDATE credential_overrides SET ciphertext = ? WHERE key = ?')
      .run(raw.toString('base64'), 'OPENROUTER_API_KEY');

    expect(() => getSecret('OPENROUTER_API_KEY')).toThrow();
  });

  it('masks a secret, never returning the full value', () => {
    const masked = maskSecret('sk-abcdefghijklmnop');
    expect(masked).not.toBe('sk-abcdefghijklmnop');
    expect(masked.length).toBeLessThan('sk-abcdefghijklmnop'.length);
  });
});
