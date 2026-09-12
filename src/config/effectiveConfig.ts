import { env } from './env';
import { getSecret, type OverridableKey } from './secretStore';

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
  return getSecret(key) ?? env[key];
}
