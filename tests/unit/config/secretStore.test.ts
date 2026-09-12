import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { getDb } from '../../../src/memory/db';
import {
  setSecret,
  getSecret,
  clearSecret,
  listConfiguredOverrideKeys,
  maskSecret,
  listAllOverrideRows,
  overwriteCiphertext,
  encryptWithKey,
  decryptWithKey,
} from '../../../src/config/secretStore';
import { createAdminUser } from '../../../src/dashboard/auth';
import { deriveKeyFromRawValue } from '../../../src/config/masterKey';

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

  it('key rotation round-trip: decrypt under old key, re-encrypt under new key, still readable', () => {
    setSecret('OPENROUTER_API_KEY', 'sk-before-rotation', adminId);
    setSecret('GOOGLE_PRIVATE_KEY', 'pem-before-rotation', adminId);

    const oldKey = deriveKeyFromRawValue(process.env.DASHBOARD_MASTER_KEY as string);
    const newRawKey = '1'.repeat(64); // a different, validly-shaped 32-byte hex key
    const newKey = deriveKeyFromRawValue(newRawKey);
    expect(oldKey.equals(newKey)).toBe(false);

    const rows = listAllOverrideRows();
    expect(rows.length).toBe(2);
    for (const row of rows) {
      const plaintext = decryptWithKey(row.ciphertext, oldKey);
      overwriteCiphertext(row.key, encryptWithKey(plaintext, newKey));
    }

    // Simulate the post-rotation world: reading with the OLD key now fails
    // (proves rotation actually happened, not a no-op)...
    const rotatedRow = getDb().prepare('SELECT ciphertext FROM credential_overrides WHERE key = ?').get('OPENROUTER_API_KEY') as {
      ciphertext: string;
    };
    expect(() => decryptWithKey(rotatedRow.ciphertext, oldKey)).toThrow();

    // ...but reading with the NEW key recovers the original plaintext exactly.
    expect(decryptWithKey(rotatedRow.ciphertext, newKey)).toBe('sk-before-rotation');
  });
});
