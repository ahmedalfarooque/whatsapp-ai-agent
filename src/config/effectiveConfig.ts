import { env } from './env';
import { readOverride, type OverridableKey, type OverrideReading } from './secretStore';

/**
 * Resolves the effective value of an overridable credential: a
 * dashboard-entered override (src/config/secretStore.ts) wins when present,
 * otherwise the .env-sourced value from env.ts (today's behavior, unchanged
 * for every deployment that never uses the dashboard override feature).
 *
 * Deliberately NOT consulted by env.ts's own production-required-credential
 * `.superRefine` check — that check must keep validating raw process.env
 * only, so "is this deployment configured for production at boot" stays a
 * static, .env-only guarantee. This function is a runtime rotation layer on
 * top of an already-valid deployment, never a way to boot production with
 * an empty .env.
 */
export function getEffectiveCredential(key: OverridableKey): string {
  const stored = readOverride(key);
  // A stored value that cannot be decrypted is IGNORED (logged once, never thrown, never sent anywhere): the .env value, if any,
  // is used instead. Callers that talk to a provider must still check the value is usable (see isUsableApiKey).
  if (stored.status === 'ok') return stored.value;
  return env[key];
}

export type CredentialSource = 'override' | 'env' | 'unset';

export interface CredentialDiagnostics {
  key: OverridableKey;
  /** Where the effective value comes from. A stored override that cannot be decrypted is not a source. */
  source: CredentialSource;
  overrideStatus: OverrideReading['status'];
  envSet: boolean;
}

/** Safe, secret-free description of where a credential comes from — for the dashboard and for log lines. */
export function describeCredential(key: OverridableKey): CredentialDiagnostics {
  const stored = readOverride(key);
  const envSet = Boolean(env[key]);
  const source: CredentialSource = stored.status === 'ok' && stored.value ? 'override' : envSet ? 'env' : 'unset';
  return { key, source, overrideStatus: stored.status, envSet };
}

/**
 * True when a value looks like an API key worth sending to a provider: printable ASCII, no whitespace or quotes, a sensible length.
 * Anything else (empty, a pasted paragraph, a decryption leftover) is never sent — the provider would only answer 401.
 */
export function isUsableApiKey(value: string | undefined | null): boolean {
  return typeof value === 'string' && /^[!-~]{16,200}$/.test(value) && !/["'`]/.test(value);
}
