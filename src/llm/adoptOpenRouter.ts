import type Database from 'better-sqlite3';
import { getDb } from '../memory/db';
import { getEffectiveCredential, isUsableApiKey } from '../config/effectiveConfig';
import { createProvider, listSharedProviders, type AiProviderRow } from './providerRepo';

/**
 * Moves the OpenRouter key this server already stores (the dashboard credential or the server environment) into the shared Default pool as a
 * normal, editable provider — so the Super Admin can test, edit, reorder, turn off or remove it like any other. The key is read and
 * encrypted again on the server only: it is never returned, logged or shown. Nothing is invented: with no usable key nothing is created.
 * Only a FREE model is configured (OpenRouter's free router); the router additionally refuses any model the public catalog prices above 0.
 */
export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
export const ADOPTED_MODELS = ['openrouter/free'];

export type AdoptResult = { status: 'created' | 'exists' | 'no_key'; provider?: AiProviderRow };

export function adoptBuiltinOpenRouter(updatedBy: number | null, db: Database.Database = getDb()): AdoptResult {
  const existing = listSharedProviders(db).find((r) => r.kind === 'openrouter');
  if (existing) return { status: 'exists', provider: existing };
  const key = getEffectiveCredential('OPENROUTER_API_KEY');
  if (!isUsableApiKey(key)) return { status: 'no_key' };
  const provider = createProvider({
    name: 'OpenRouter', kind: 'openrouter', baseUrl: OPENROUTER_BASE, apiKey: key, models: ADOPTED_MODELS,
    freeTier: true, supportsTools: true, enabled: true, priority: 10, timeoutMs: 20000,
    notes: 'Added from the OpenRouter key already saved on this server.',
  }, { accountId: null, updatedBy: updatedBy ?? 0 }, db);
  return { status: 'created', provider };
}
