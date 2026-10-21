import crypto from 'node:crypto';
import { env } from '../config/env';
import { getEffectiveCredential, isUsableApiKey } from '../config/effectiveConfig';
import { getDb } from '../memory/db';
import { fetchWithTimeout } from '../utils/retry';
import { logger } from '../logger';
import { parseCompletionBody } from './openAiCompatible';

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

// ---------------------------------------------------------------- the MODEL (a valid key does not mean a usable model)

/**
 * Whether the configured MODEL can actually answer, found with one tiny real completion (8 tokens, a neutral prompt, no business or
 * customer data). Separate from the key check: OpenRouter accepts a valid key for a model whose endpoints are blocked by the account's
 * data-policy settings, rate limited upstream, or that returns empty answers.
 *  usable        HTTP 200 with text
 *  empty         HTTP 200 but no text
 *  unavailable   HTTP 400-404: no endpoint can serve this model for this account
 *  rate_limited  HTTP 429 / 408
 *  error         HTTP 5xx, malformed answer or no connection
 */
export type ModelHealthStatus = 'usable' | 'empty' | 'unavailable' | 'rate_limited' | 'error';

export interface ModelHealth {
  status: ModelHealthStatus;
  model: string;
  checkedAt: number;
  httpStatus: number | null;
  latencyMs: number;
}

const MODEL_OK_TTL_MS = 30 * 60_000; // a working model is re-checked at most every 30 minutes
const MODEL_FAIL_TTL_MS = 5 * 60_000; // a failing one every 5 minutes, so a fixed model turns green soon without hammering the provider

const modelCache = new Map<string, ModelHealth & { fingerprint: string }>();
const modelInFlight = new Map<string, Promise<ModelHealth | null>>();

export function classifyModelResponse(httpStatus: number, text: string | null): ModelHealthStatus {
  if (httpStatus >= 200 && httpStatus < 300) return text ? 'usable' : 'empty';
  if (httpStatus === 429 || httpStatus === 408) return 'rate_limited';
  if (httpStatus >= 400 && httpStatus < 500) return 'unavailable';
  return 'error';
}

/** Last probe of this model for the CURRENT key, or null when none exists (never probed, or the key changed since). */
export function getCachedModelHealth(model: string, now: number = Date.now()): (ModelHealth & { stale: boolean }) | null {
  const entry = modelCache.get(model);
  if (!entry) return null;
  const key = getEffectiveCredential('OPENROUTER_API_KEY');
  if (!isUsableApiKey(key) || fingerprintOf(key) !== entry.fingerprint) return null;
  const ttl = entry.status === 'usable' ? MODEL_OK_TTL_MS : MODEL_FAIL_TTL_MS;
  return { status: entry.status, model: entry.model, checkedAt: entry.checkedAt, httpStatus: entry.httpStatus, latencyMs: entry.latencyMs, stale: now - entry.checkedAt > ttl };
}

type AnswerBody = { choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown } }>; error?: unknown } | null;

/**
 * Reads an HTTP 200 answer the way the router does (JSON, JSON behind keep-alive comment lines, or an event stream); null when it cannot be read. A body that carries an
 * error object is a failed probe whatever else it holds — HTTP 200 alone never makes a model "usable".
 */
async function readAnswerBody(response: Response): Promise<AnswerBody> {
  try {
    const body = parseCompletionBody(await response.text(), '', response.status) as AnswerBody;
    const failed = Boolean(body?.error) && (body?.choices?.[0]?.finish_reason === 'error' || !body?.choices?.[0]?.message?.content);
    return failed ? null : body;
  } catch {
    return null;
  }
}

export function refreshModelHealth(model: string): Promise<ModelHealth | null> {
  if (env.shouldUseMockProviders) return Promise.resolve(null);
  const key = getEffectiveCredential('OPENROUTER_API_KEY');
  if (!isUsableApiKey(key)) return Promise.resolve(null);
  const existing = modelInFlight.get(model);
  if (existing) return existing;
  const fingerprint = fingerprintOf(key);
  const run = (async (): Promise<ModelHealth> => {
    const started = Date.now();
    let result: ModelHealth;
    try {
      const response = await fetchWithTimeout(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, max_tokens: 8, temperature: 0, messages: [{ role: 'user', content: 'Reply with the single word: ok' }] }),
        },
        env.OPENROUTER_TIMEOUT_MS,
      );
      let text: string | null = null;
      if (response.ok) {
        const body = await readAnswerBody(response);
        const content = body?.choices?.[0]?.message?.content;
        text = typeof content === 'string' && content.trim() ? content.trim() : null;
      }
      result = { status: classifyModelResponse(response.status, text), model, checkedAt: Date.now(), httpStatus: response.status, latencyMs: Date.now() - started };
    } catch (error) {
      logger.warn({ errorName: (error as Error)?.name, model }, 'ai model health: could not reach the provider');
      result = { status: 'error', model, checkedAt: Date.now(), httpStatus: null, latencyMs: Date.now() - started };
    }
    if (fingerprintOf(getEffectiveCredential('OPENROUTER_API_KEY')) === fingerprint) modelCache.set(model, { ...result, fingerprint });
    return result;
  })().finally(() => {
    modelInFlight.delete(model);
  });
  modelInFlight.set(model, run);
  return run;
}

// ---------------------------------------------------------------- the VISION model (a usable chat model does not mean pictures are accepted)

/** A 1x1 transparent PNG: enough to prove the model accepts image input; it carries no business or customer data. */
const PROBE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const visionCache = new Map<string, ModelHealth & { fingerprint: string }>();
const visionInFlight = new Map<string, Promise<ModelHealth | null>>();

export function getCachedVisionHealth(model: string, now: number = Date.now()): (ModelHealth & { stale: boolean }) | null {
  const entry = visionCache.get(model);
  if (!entry) return null;
  const key = getEffectiveCredential('OPENROUTER_API_KEY');
  if (!isUsableApiKey(key) || fingerprintOf(key) !== entry.fingerprint) return null;
  const ttl = entry.status === 'usable' ? MODEL_OK_TTL_MS : MODEL_FAIL_TTL_MS;
  return { status: entry.status, model: entry.model, checkedAt: entry.checkedAt, httpStatus: entry.httpStatus, latencyMs: entry.latencyMs, stale: now - entry.checkedAt > ttl };
}

/**
 * Whether the configured VISION model actually accepts a picture: one tiny real completion with a 1x1 image attached (the same request
 * shape the customer-picture analysis uses). 'unavailable' here means the model (or the account's data policy) rejects image input,
 * so customer pictures would NOT be analysed and the assistant would say it could not open them.
 */
export function refreshVisionHealth(model: string): Promise<ModelHealth | null> {
  if (env.shouldUseMockProviders) return Promise.resolve(null);
  const key = getEffectiveCredential('OPENROUTER_API_KEY');
  if (!isUsableApiKey(key)) return Promise.resolve(null);
  const existing = visionInFlight.get(model);
  if (existing) return existing;
  const fingerprint = fingerprintOf(key);
  const run = (async (): Promise<ModelHealth> => {
    const started = Date.now();
    let result: ModelHealth;
    try {
      const response = await fetchWithTimeout(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model, max_tokens: 8, temperature: 0,
            messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with the single word: ok' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${PROBE_PNG}` } }] }],
          }),
        },
        env.VISION_TIMEOUT_MS,
      );
      let text: string | null = null;
      if (response.ok) {
        const body = await readAnswerBody(response);
        const content = body?.choices?.[0]?.message?.content;
        text = typeof content === 'string' && content.trim() ? content.trim() : Array.isArray(content) && content.length ? 'ok' : null;
      }
      result = { status: classifyModelResponse(response.status, text), model, checkedAt: Date.now(), httpStatus: response.status, latencyMs: Date.now() - started };
    } catch (error) {
      logger.warn({ errorName: (error as Error)?.name, model }, 'ai vision health: could not reach the provider');
      result = { status: 'error', model, checkedAt: Date.now(), httpStatus: null, latencyMs: Date.now() - started };
    }
    if (fingerprintOf(getEffectiveCredential('OPENROUTER_API_KEY')) === fingerprint) visionCache.set(model, { ...result, fingerprint });
    return result;
  })().finally(() => {
    visionInFlight.delete(model);
  });
  visionInFlight.set(model, run);
  return run;
}

/**
 * Makes sure fresh verdicts exist — for the key and, when a model is given, for that model — waiting at most `waitMs` in total.
 * The model is probed only after the key is known to be accepted, and only when its cached probe has expired.
 */
export async function ensureProviderHealth(waitMs: number, model?: string): Promise<void> {
  const work = (async () => {
    const keyHealth = getCachedProviderHealth();
    if (!keyHealth || keyHealth.stale) await refreshProviderHealth();
    if (!model || getCachedProviderHealth()?.status !== 'ok') return;
    const modelHealth = getCachedModelHealth(model);
    if (!modelHealth || modelHealth.stale) await refreshModelHealth(model);
  })();
  work.catch(() => undefined);
  await Promise.race([work, new Promise<void>((resolve) => setTimeout(resolve, waitMs).unref())]);
}

/** Test helper: forget every cached verdict. */
export function resetProviderHealthForTests(): void {
  cached = null;
  inFlight = null;
  modelCache.clear();
  modelInFlight.clear();
  visionCache.clear();
  visionInFlight.clear();
}
