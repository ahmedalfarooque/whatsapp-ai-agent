import { env } from '../config/env';
import { logger } from '../logger';
import { fetchWithTimeout } from '../utils/retry';

/**
 * What OpenRouter publishes about each model (public endpoint, no key): whether it is free (price 0 for prompt and completion), which
 * inputs it accepts (text, image, audio) and whether it supports tool calling. The fallback logic uses it to pick a model whose
 * CAPABILITIES match the task (a text-only model is never given a picture) and whose PRICE is zero when the chat model failed with a
 * 402. The list is cached for an hour; when it cannot be fetched nothing is assumed: `null` = unknown, and unknown is treated
 * conservatively (allowed for a plain text task, not for pictures/audio, not as "free").
 */
export interface ModelInfo {
  id: string;
  free: boolean;
  image: boolean;
  audio: boolean;
  tools: boolean;
  contextLength: number | null;
}

const CATALOG_URL = 'https://openrouter.ai/api/v1/models';
const CATALOG_TTL_MS = 60 * 60_000;
const CATALOG_FAIL_TTL_MS = 5 * 60_000;
const CATALOG_TIMEOUT_MS = 10_000;

let cache: { models: Map<string, ModelInfo>; at: number; ok: boolean } | null = null;
let inFlight: Promise<Map<string, ModelInfo> | null> | null = null;
// Test hook: the suite stubs fetch with scripted provider answers; a catalog download would consume one. Tests set a catalog explicitly.
let fetchDisabled = false;
export function disableCatalogFetchForTests(flag: boolean): void { fetchDisabled = flag; }

function parseCatalog(body: unknown): Map<string, ModelInfo> {
  const data = (body as { data?: unknown[] } | null)?.data;
  const out = new Map<string, ModelInfo>();
  if (!Array.isArray(data)) return out;
  for (const raw of data) {
    const m = raw as { id?: unknown; pricing?: { prompt?: unknown; completion?: unknown }; architecture?: { input_modalities?: unknown }; supported_parameters?: unknown; context_length?: unknown };
    if (typeof m.id !== 'string' || !m.id) continue;
    const price = (v: unknown): number => (typeof v === 'string' || typeof v === 'number' ? Number(v) : Number.NaN);
    const prompt = price(m.pricing?.prompt);
    const completion = price(m.pricing?.completion);
    const modalities = Array.isArray(m.architecture?.input_modalities) ? (m.architecture!.input_modalities as unknown[]).map(String) : [];
    const params = Array.isArray(m.supported_parameters) ? (m.supported_parameters as unknown[]).map(String) : [];
    out.set(m.id, {
      id: m.id,
      free: prompt === 0 && completion === 0,
      image: modalities.includes('image'),
      audio: modalities.includes('audio'),
      tools: params.includes('tools'),
      contextLength: typeof m.context_length === 'number' ? m.context_length : null,
    });
  }
  return out;
}

/** The catalog (fresh or cached), or null when it cannot be read; never throws, never blocks longer than CATALOG_TIMEOUT_MS. */
export async function loadModelCatalog(now = Date.now()): Promise<Map<string, ModelInfo> | null> {
  if (env.shouldUseMockProviders || fetchDisabled) return cache?.models.size ? cache.models : null;
  // A failed refresh keeps serving the LAST GOOD catalog (stale is far better than "unknown" under strict free-only routing, where an
  // unknown price fails closed); only with no catalog ever read does it answer null.
  if (cache && now - cache.at < (cache.ok ? CATALOG_TTL_MS : CATALOG_FAIL_TTL_MS)) return cache.models.size ? cache.models : null;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const response = await fetchWithTimeout(CATALOG_URL, { method: 'GET' }, CATALOG_TIMEOUT_MS);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const models = parseCatalog(await response.json());
      if (models.size === 0) throw new Error('empty catalog');
      cache = { models, at: Date.now(), ok: true };
      return models;
    } catch (error) {
      logger.warn({ errorName: (error as Error)?.name, errorMessage: String((error as Error)?.message ?? '').slice(0, 80) }, 'OpenRouter model catalog could not be read; model capabilities are unknown until the next attempt');
      cache = { models: cache?.models ?? new Map(), at: Date.now(), ok: false };
      return cache.models.size ? cache.models : null;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** The published facts about one model, or null when unknown (not listed, or the catalog is unreachable). */
export async function getModelInfo(id: string): Promise<ModelInfo | null> {
  const models = await loadModelCatalog();
  return models?.get(id) ?? null;
}

/** Test hook: a fixed catalog (or none). */
export function setModelCatalogForTests(models: ModelInfo[] | null): void {
  cache = models ? { models: new Map(models.map((m) => [m.id, m])), at: Date.now(), ok: true } : null;
  inFlight = null;
}
