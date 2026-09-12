/**
 * Rotates DASHBOARD_MASTER_KEY: decrypts every existing credential-override
 * row under the CURRENT key (env.DASHBOARD_MASTER_KEY, i.e. whatever is set
 * in the running .env) and re-encrypts each one under a NEW key, so no
 * override is ever lost or silently orphaned by a key change.
 *
 * Usage (stop the app first — this must run against the same database file,
 * uncontended):
 *   NEW_DASHBOARD_MASTER_KEY=<newly generated 32-byte base64/hex key> \
 *     npx tsx scripts/rotateMasterKey.ts
 *
 * Generate a new key the same way as the original:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 *
 * After this succeeds, update DASHBOARD_MASTER_KEY in .env to the new value
 * and restart the app. Do NOT update .env before running this script — it
 * needs the OLD key (from the current .env) to decrypt existing rows.
 *
 * This is a deliberate offline/maintenance operation, not a dashboard
 * button: rotation touches every stored secret at once and must run with
 * the app stopped, which is a fundamentally different risk profile than
 * setting a single credential from the dashboard while the app is live.
 */
import { env } from '../src/config/env';
import { deriveKeyFromRawValue } from '../src/config/masterKey';
import { listAllOverrideRows, overwriteCiphertext, decryptWithKey, encryptWithKey } from '../src/config/secretStore';
import { getDb } from '../src/memory/db';

/* eslint-disable no-console */

function validateNewKey(value: string | undefined): string {
  if (!value) {
    throw new Error('NEW_DASHBOARD_MASTER_KEY environment variable is required.');
  }
  // Reuses the exact same decode+derive path a real DASHBOARD_MASTER_KEY
  // goes through — if this throws, the new key is malformed, and nothing
  // below has touched the database yet.
  deriveKeyFromRawValue(value);
  if (value === env.DASHBOARD_MASTER_KEY) {
    throw new Error('NEW_DASHBOARD_MASTER_KEY must be different from the current DASHBOARD_MASTER_KEY.');
  }
  return value;
}

function main(): void {
  const newRawKey = validateNewKey(process.env.NEW_DASHBOARD_MASTER_KEY);
  const oldKey = deriveKeyFromRawValue(env.DASHBOARD_MASTER_KEY);
  const newKey = deriveKeyFromRawValue(newRawKey);

  const db = getDb();
  const rows = listAllOverrideRows();

  if (rows.length === 0) {
    console.log('No credential overrides exist — nothing to re-encrypt. Safe to update DASHBOARD_MASTER_KEY and restart.');
    return;
  }

  // Decrypt every row under the OLD key BEFORE writing anything, so a
  // corrupt/mismatched old key aborts with zero rows changed rather than
  // leaving the table half-migrated.
  const plaintextByKey = new Map<string, string>();
  for (const row of rows) {
    plaintextByKey.set(row.key, decryptWithKey(row.ciphertext, oldKey));
  }

  const run = db.transaction(() => {
    for (const [key, plaintext] of plaintextByKey) {
      overwriteCiphertext(key, encryptWithKey(plaintext, newKey));
    }
  });
  run();

  console.log(
    JSON.stringify({
      ok: true,
      rotatedKeys: rows.map((r) => r.key),
      nextStep: 'Update DASHBOARD_MASTER_KEY in .env to the new value and restart the app.',
    }),
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Master key rotation failed');
  process.exitCode = 1;
}
