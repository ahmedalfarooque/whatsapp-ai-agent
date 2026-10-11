import crypto from 'node:crypto';
import { env } from '../config/env';
import { getEffectiveCredential, isUsableApiKey } from '../config/effectiveConfig';
import { getDb } from '../memory/db';
import { fetchWithTimeout } from '../utils/retry';
import { logger } from '../logger';

/**
 * A real, cached check of the AI provider credential (OpenRouter's authenticated /auth/key endpoint), so the dashboard never has to
 * guess the provider state from old reply history. The result is classified, never contains the key, and is tied to a one-way
 * fingerprint of the credential: when the owner saves a different key the previous verdict is discarded at once.
 */
export type ProviderHealthStatus = 'ok' | 'rejected' | 'rate_limited' | 'unreachable' | 'unknown';

export interface ProviderHealth {
  status: ProviderHealthStatus;
  /** Epoch ms when the check ran. */
  checkedAt: number;
  /** HTTP status the provider answered with, or null when it could not be reached. */
  httpStatus: number | null;
}

const OK_TTL_MS = 5 * 60_000; // a verified key is re-verified at most every 5 minutes
const FAIL_TTL_MS = 60_000; // a failed check is retried sooner, so a fixed key turns green quickly

let cached: (ProviderHealth & { fingerprint: string }) | null = null;
let inFlight: Promise<ProviderHealth | null> | null = null;

/** One-way, truncated hash used only to notice that the credential changed; it is never returned or logged. */
function fingerprintOf(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

export function classifyProviderResponse(httpStatus: number): ProviderHealthStatus {
  if (httpStatus >= 200 && httpStatus < 300) return 'ok';
  if (httpStatus === 401 || httpStatus === 403) return 'rejected';
  if (httpStatus === 429) return 'rate_limited';
  if (httpStatus >= 500) return 'unreachable';
  return 'unknown';
}

function ttlFor(health: ProviderHealth): number {
  return health.status === 'ok' ? OK_TTL_MS : FAIL_TTL_MS;
}

/** The last verdict for the CURRENT credential, or null when none exists yet (never checked, or the key changed since). */
export function getCachedProviderHealth(now: number = Date.now()): (ProviderHealth & { stale: boolean }) | null {
  if (!cached) return null;
  const key = getEffectiveCredential('OPENROUTER_API_KEY');
  if (!isUsableApiKey(key) || fingerprintOf(key) !== cached.fingerprint) return null;
  return { status: cached.status, checkedAt: cached.checkedAt, httpStatus: cached.httpStatus, stale: now - cached.checkedAt > ttlFor(cached) };
}

/** When the owner last saved the OpenRouter credential in the dashboard (ms), or null when only .env provides it. */
export function credentialSavedAtMs(): number | null {
  const row = getDb().prepare("SELECT updated_at FROM credential_overrides WHERE key = 'OPENROUTER_API_KEY'").get() as { updated_at: string } | undefined;
  if (!row?.updated_at) return null;
  const ms = Date.parse(row.updated_at.includes('T') ? row.updated_at : `${row.updated_at.replace(' ', 'T')}Z`);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Asks the provider whether the current key is valid. De-duplicated (concurrent callers share one request) and skipped entirely
 * in mock/test mode and when no usable key exists. Returns null when no check was made.
 */
export function refreshProviderHealth(): Promise<ProviderHealth | null> {
  if (env.shouldUseMockProviders) return Promise.resolve(null);
  const key = getEffectiveCredential('OPENROUTER_API_KEY');
  if (!isUsableApiKey(key)) return Promise.resolve(null);
  if (inFlight) return inFlight;
  const fingerprint = fingerprintOf(key);
  inFlight = (async () => {
    let result: ProviderHealth;
    try {
      const response = await fetchWithTimeout('https://openrouter.ai/api/v1/auth/key', { method: 'GET', headers: { Authorization: `Bearer ${key}` } }, env.OPENROUTER_TIMEOUT_MS);
      result = { status: classifyProviderResponse(response.status), checkedAt: Date.now(), httpStatus: response.status };
    } catch (error) {
      logger.warn({ errorName: (error as Error)?.name }, 'ai provider health: could not reach the provider');
      result = { status: 'unreachable', checkedAt: Date.now(), httpStatus: null };
    }
    // A key saved while this request was running makes the verdict stale before it lands: drop it instead of caching it.
    if (fingerprintOf(getEffectiveCredential('OPENROUTER_API_KEY')) === fingerprint) cached = { ...result, fingerprint };
    return result;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Makes sure a fresh verdict exists, waiting at most `waitMs` for the provider; used by the dashboard's status call. */
export async function ensureProviderHealth(waitMs: number): Promise<void> {
  const current = getCachedProviderHealth();
  if (current && !current.stale) return;
  await Promise.race([refreshProviderHealth(), new Promise<void>((resolve) => setTimeout(resolve, waitMs).unref())]);
}

/** Test helper: forget every cached verdict. */
export function resetProviderHealthForTests(): void {
  cached = null;
  inFlight = null;
}
