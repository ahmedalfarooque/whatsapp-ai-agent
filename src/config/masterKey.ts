import crypto from 'node:crypto';
import { env } from './env';

const HKDF_INFO = 'whatsapp-ai-agent:dashboard-secrets:v1';
const HKDF_SALT = Buffer.alloc(0);

function decodeMasterKey(value: string): Buffer {
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length === 32) return decoded;
  }
  if (/^[0-9a-fA-F]+$/.test(value)) {
    const decoded = Buffer.from(value, 'hex');
    if (decoded.length === 32) return decoded;
  }
  // Should be unreachable — env.ts validates this at process boot. Fail
  // closed rather than silently deriving a key from garbage input.
  throw new Error('DASHBOARD_MASTER_KEY is invalid: must decode to exactly 32 bytes (base64 or hex).');
}

let cachedKey: Buffer | null = null;

/**
 * Returns the AES-256-GCM key used to encrypt dashboard-entered credential
 * overrides at rest (src/config/secretStore.ts). Derived via HKDF from the
 * raw DASHBOARD_MASTER_KEY rather than using the raw bytes directly, so a
 * future key-rotation scheme can change the HKDF info string without
 * changing the .env format. Cached for the process lifetime.
 */
export function getSecretEncryptionKey(): Buffer {
  if (!cachedKey) {
    const rawKey = decodeMasterKey(env.DASHBOARD_MASTER_KEY);
    const derived = crypto.hkdfSync('sha256', rawKey, HKDF_SALT, HKDF_INFO, 32);
    cachedKey = Buffer.from(derived);
  }
  return cachedKey;
}
