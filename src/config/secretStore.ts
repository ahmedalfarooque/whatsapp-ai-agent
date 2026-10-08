import crypto from 'node:crypto';
import { getDb } from '../memory/db';
import { getSecretEncryptionKey } from './masterKey';
import { logger } from '../logger';

/**
 * The exact set of credential fields that may be overridden from the
 * dashboard, at runtime, on top of (never instead of) the process's real
 * .env-derived production-required credentials. This is a SUPERSET of
 * PRODUCTION_REQUIRED_KEYS and META_CLOUD_API_REQUIRED_KEYS in
 * src/config/env.ts — every key that production can require (for either
 * WhatsApp transport) is overridable here, plus a couple of fields (WABA ID)
 * that are not required to run the app but are used by the dashboard's Sync
 * WhatsApp verification step. The Meta keys stay overridable on the QR
 * transport too, so the dashboard can be prepared for a later switch.
 */
export const OVERRIDABLE_KEYS = [
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_BUSINESS_ACCOUNT_ID',
  'WHATSAPP_VERIFY_TOKEN',
  'META_APP_SECRET',
  'OPENROUTER_API_KEY',
  'GOOGLE_CLIENT_EMAIL',
  'GOOGLE_PRIVATE_KEY',
] as const;

export type OverridableKey = (typeof OVERRIDABLE_KEYS)[number];

export function isOverridableKey(value: string): value is OverridableKey {
  return (OVERRIDABLE_KEYS as readonly string[]).includes(value);
}

/**
 * Keys that identify configuration rather than a secret — safe to display in
 * full in the dashboard UI (never just a masked preview). Still stored
 * through the same encrypted override store as everything else here, so
 * there's exactly one credential-override mechanism, not two.
 */
export const NON_SECRET_OVERRIDABLE_KEYS: readonly OverridableKey[] = [
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_BUSINESS_ACCOUNT_ID',
];

export function isSecretOverridableKey(key: OverridableKey): boolean {
  return !NON_SECRET_OVERRIDABLE_KEYS.includes(key);
}

interface CredentialOverrideRow {
  key: string;
  ciphertext: string;
}

/** Encrypts with an explicit key — exported so the offline rotation script
 * (scripts/rotateMasterKey.ts) can re-encrypt existing rows under a NEW
 * master key using the exact same AES-GCM framing, without duplicating the
 * crypto logic or touching env/getSecretEncryptionKey. */
export function encryptWithKey(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

/** Decrypts with an explicit key — see encryptWithKey. */
export function decryptWithKey(payload: string, key: Buffer): string {
  const raw = Buffer.from(payload, 'base64');
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf-8');
}

/** Encrypts and stores (or replaces) an override value for one credential key. */
export function setSecret(key: OverridableKey, plaintext: string, updatedByAdminId: number): void {
  const ciphertext = encryptWithKey(plaintext, getSecretEncryptionKey());
  getDb()
    .prepare(
      `INSERT INTO credential_overrides (key, ciphertext, updated_at, updated_by)
       VALUES (@key, @ciphertext, datetime('now'), @updatedBy)
       ON CONFLICT(key) DO UPDATE SET
         ciphertext = excluded.ciphertext,
         updated_at = datetime('now'),
         updated_by = excluded.updated_by`,
    )
    .run({ key, ciphertext, updatedBy: updatedByAdminId });
}

/** Returns the decrypted override value for a key, or null if none is set. */
export function getSecret(key: OverridableKey): string | null {
  const row = getDb()
    .prepare('SELECT key, ciphertext FROM credential_overrides WHERE key = ?')
    .get(key) as CredentialOverrideRow | undefined;
  if (!row) return null;
  return decryptWithKey(row.ciphertext, getSecretEncryptionKey());
}

/** What is stored for a key, WITHOUT ever throwing on unreadable ciphertext (and never exposing it). */
export type OverrideReading = { status: 'absent' } | { status: 'ok'; value: string } | { status: 'undecryptable' };

const warnedUndecryptable = new Set<string>();

/**
 * The safe way to read an override at runtime. A row that cannot be decrypted with the CURRENT master key (it was written under a
 * different key, or its ciphertext was altered) is reported as 'undecryptable' — never as a value and never as an exception —
 * so one stale row cannot take down AI replies, calendar access or the dashboard pages that list credentials. It is logged once
 * per key per process (key NAME only, never any secret material) and is NOT deleted: the administrator re-enters it.
 * getSecret() above stays strict and throws; tampering must remain loud wherever a caller asks for the value itself.
 */
export function readOverride(key: OverridableKey): OverrideReading {
  const row = getDb().prepare('SELECT key, ciphertext FROM credential_overrides WHERE key = ?').get(key) as CredentialOverrideRow | undefined;
  if (!row) return { status: 'absent' };
  try {
    return { status: 'ok', value: decryptWithKey(row.ciphertext, getSecretEncryptionKey()) };
  } catch {
    if (!warnedUndecryptable.has(key)) {
      warnedUndecryptable.add(key);
      logger.warn(
        { credential: key },
        'a stored credential override cannot be decrypted with the current DASHBOARD_MASTER_KEY (it was saved under a different key); it is being ignored. Enter it again in the dashboard to replace it.',
      );
    }
    return { status: 'undecryptable' };
  }
}

/** Test hook: forget which keys were already warned about. */
export function resetUndecryptableWarnings(): void {
  warnedUndecryptable.clear();
}

/** Lists every row's raw key + ciphertext — used only by the offline rotation
 * script, which needs to decrypt under the OLD key and re-encrypt under the
 * NEW one. Never used by any request-serving code path. */
export function listAllOverrideRows(): CredentialOverrideRow[] {
  return getDb().prepare('SELECT key, ciphertext FROM credential_overrides').all() as CredentialOverrideRow[];
}

/** Overwrites a row's ciphertext in place — used only by the offline
 * rotation script after re-encrypting under the new key. */
export function overwriteCiphertext(key: string, ciphertext: string): void {
  getDb().prepare('UPDATE credential_overrides SET ciphertext = ? WHERE key = ?').run(ciphertext, key);
}

/** Removes an override, reverting that key to its .env-sourced value. */
export function clearSecret(key: OverridableKey): void {
  getDb().prepare('DELETE FROM credential_overrides WHERE key = ?').run(key);
}

/** Which keys currently have a dashboard-entered override (booleans only, never values). */
export function listConfiguredOverrideKeys(): OverridableKey[] {
  const rows = getDb().prepare('SELECT key FROM credential_overrides').all() as { key: string }[];
  return rows.map((r) => r.key).filter(isOverridableKey);
}

/** Masks a secret for display: first 4 + last 4 characters, never the full value. */
export function maskSecret(plaintext: string): string {
  if (!plaintext) return '';
  if (plaintext.length <= 8) return '••••';
  return `${plaintext.slice(0, 4)}…${plaintext.slice(-4)}`;
}
