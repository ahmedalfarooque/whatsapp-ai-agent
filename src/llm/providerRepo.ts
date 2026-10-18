import type Database from 'better-sqlite3';
import { getDb } from '../memory/db';
import { decryptWithKey, encryptWithKey, maskSecret } from '../config/secretStore';
import { getSecretEncryptionKey } from '../config/masterKey';
import { isUsableApiKey } from '../config/effectiveConfig';
import { logger } from '../logger';
import { ensureAccountRouting, forgetProviderEntry } from './routingOrder';

/**
 * AI providers configured in the dashboard (table ai_providers, migration 027). A provider is a chat-completions endpoint with its own
 * key: OpenRouter or any OpenAI-compatible free tier (Groq, Google AI Studio, Cerebras, Mistral, ...). A row with
 * whatsapp_account_id NULL is shared by every business; a row with an account id belongs to that business alone and is never visible
 * to, or used by, another one. Keys are encrypted with the dashboard master key (the credential_overrides framing) and are returned
 * only masked; the plaintext leaves this module solely for the HTTP Authorization header of a request to that provider.
 */
export type ProviderKind = 'openrouter' | 'openai_compatible';

export interface AiProviderRow {
  id: number;
  whatsapp_account_id: number | null;
  name: string;
  kind: ProviderKind;
  base_url: string;
  key_ciphertext: string | null;
  models: string;
  vision_models: string;
  audio_models: string;
  free_tier: number;
  /** 0 = the free tier was declared but not confirmed by an administrator (a non-OpenRouter price cannot be verified here): never routed under free-only mode. */
  free_confirmed: number;
  supports_tools: number;
  enabled: number;
  priority: number;
  timeout_ms: number;
  notes: string | null;
  last_test_at: string | null;
  last_test_ok: number | null;
  last_test_detail: string | null;
  created_at: string;
  updated_at: string;
  updated_by: number | null;
}

/** What the dashboard sees: never the key, only whether one is stored and a masked preview. */
export interface AiProviderView {
  id: number;
  accountId: number | null;
  shared: boolean;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  hasKey: boolean;
  keyMasked: string | null;
  keyStatus: 'none' | 'ok' | 'undecryptable';
  models: string[];
  visionModels: string[];
  audioModels: string[];
  freeTier: boolean;
  freeConfirmed: boolean;
  supportsTools: boolean;
  enabled: boolean;
  priority: number;
  timeoutMs: number;
  notes: string | null;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestDetail: string | null;
  updatedAt: string;
}

export interface AiProviderInput {
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  /** undefined = keep the stored key; '' = remove it; a value = replace it. */
  apiKey?: string;
  models: string[];
  visionModels?: string[];
  audioModels?: string[];
  freeTier?: boolean;
  /** undefined on create = confirmed (internal callers); the dashboard sets it false for endpoints whose price it cannot verify. undefined on update = keep. */
  freeConfirmed?: boolean;
  supportsTools?: boolean;
  enabled?: boolean;
  priority?: number;
  timeoutMs?: number;
  notes?: string | null;
}

export const PROVIDER_KINDS: readonly ProviderKind[] = ['openrouter', 'openai_compatible'];
const MODEL_ID = /^[A-Za-z0-9._:/@-]{1,120}$/;
// Every provider is reached over HTTPS: an API key is never sent in clear text.
const URL_RE = /^https:\/\/[^\s"'<>]{3,200}$/;

export class ProviderValidationError extends Error {
  constructor(message: string, public readonly fields: string[]) {
    super(message);
    this.name = 'ProviderValidationError';
  }
}

export const csv = (v: string | null | undefined): string[] => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

function validate(input: AiProviderInput): void {
  const fields: string[] = [];
  if (!input.name || input.name.trim().length < 1 || input.name.length > 80) fields.push('name');
  if (!PROVIDER_KINDS.includes(input.kind)) fields.push('kind');
  if (!URL_RE.test(input.baseUrl ?? '')) fields.push('baseUrl');
  for (const list of [input.models, input.visionModels ?? [], input.audioModels ?? []]) for (const m of list) if (!MODEL_ID.test(m)) fields.push('models');
  if (input.models.length === 0 && (input.visionModels ?? []).length === 0 && (input.audioModels ?? []).length === 0) fields.push('models');
  if (input.apiKey !== undefined && input.apiKey !== '' && !isUsableApiKey(input.apiKey)) fields.push('apiKey');
  if (input.priority !== undefined && !(Number.isInteger(input.priority) && input.priority >= 1 && input.priority <= 1000)) fields.push('priority');
  if (input.timeoutMs !== undefined && !(Number.isInteger(input.timeoutMs) && input.timeoutMs >= 2000 && input.timeoutMs <= 120000)) fields.push('timeoutMs');
  if (fields.length) throw new ProviderValidationError('validation_failed', [...new Set(fields)]);
}

export function toView(row: AiProviderRow): AiProviderView {
  let keyStatus: AiProviderView['keyStatus'] = 'none';
  let keyMasked: string | null = null;
  if (row.key_ciphertext) {
    try {
      keyMasked = maskSecret(decryptWithKey(row.key_ciphertext, getSecretEncryptionKey()));
      keyStatus = 'ok';
    } catch {
      keyStatus = 'undecryptable';
    }
  }
  return {
    id: row.id, accountId: row.whatsapp_account_id, shared: row.whatsapp_account_id === null, name: row.name, kind: row.kind, baseUrl: row.base_url,
    hasKey: Boolean(row.key_ciphertext), keyMasked, keyStatus, models: csv(row.models), visionModels: csv(row.vision_models), audioModels: csv(row.audio_models),
    freeTier: row.free_tier !== 0, freeConfirmed: row.free_confirmed !== 0, supportsTools: row.supports_tools !== 0, enabled: row.enabled !== 0, priority: row.priority, timeoutMs: row.timeout_ms,
    notes: row.notes, lastTestAt: row.last_test_at, lastTestOk: row.last_test_ok === null ? null : row.last_test_ok === 1, lastTestDetail: row.last_test_detail, updatedAt: row.updated_at,
  };
}

/** The providers an account may use: the shared ones and its own, enabled or not, by priority. Another account's rows are never returned. */
export function listProvidersForAccount(accountId: number, db: Database.Database = getDb()): AiProviderRow[] {
  return db.prepare('SELECT * FROM ai_providers WHERE whatsapp_account_id IS NULL OR whatsapp_account_id = ? ORDER BY priority, id').all(accountId) as AiProviderRow[];
}

/** The shared provider pool (the "Default" entry of every business): rows with no owning business, by priority. */
export function listSharedProviders(db: Database.Database = getDb()): AiProviderRow[] {
  return db.prepare('SELECT * FROM ai_providers WHERE whatsapp_account_id IS NULL ORDER BY priority, id').all() as AiProviderRow[];
}

export function getSharedProvider(id: number, db: Database.Database = getDb()): AiProviderRow | undefined {
  return db.prepare('SELECT * FROM ai_providers WHERE id = ? AND whatsapp_account_id IS NULL').get(id) as AiProviderRow | undefined;
}

/** Puts the shared providers in this order (priority 10, 20, 30 …); ids that are not shared providers are ignored. Returns how many moved. */
export function reorderSharedProviders(ids: number[], updatedBy: number, db: Database.Database = getDb()): number {
  const known = new Set(listSharedProviders(db).map((r) => r.id));
  const ordered = ids.filter((id, i) => known.has(id) && ids.indexOf(id) === i);
  const write = db.transaction(() => ordered.forEach((id, i) => db.prepare("UPDATE ai_providers SET priority = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ? AND whatsapp_account_id IS NULL").run((i + 1) * 10, updatedBy, id)));
  write();
  return ordered.length;
}

export function getProvider(id: number, accountId: number, db: Database.Database = getDb()): AiProviderRow | undefined {
  return db.prepare('SELECT * FROM ai_providers WHERE id = ? AND (whatsapp_account_id IS NULL OR whatsapp_account_id = ?)').get(id, accountId) as AiProviderRow | undefined;
}

/** The plaintext key of a provider for ONE request, or null when none is stored or it cannot be decrypted (logged once, never sent). */
const undecryptableWarned = new Set<number>();
export function providerApiKey(row: AiProviderRow): string | null {
  if (!row.key_ciphertext) return null;
  try {
    const key = decryptWithKey(row.key_ciphertext, getSecretEncryptionKey());
    return isUsableApiKey(key) ? key : null;
  } catch {
    if (!undecryptableWarned.has(row.id)) {
      undecryptableWarned.add(row.id);
      logger.warn({ providerId: row.id, provider: row.name }, 'the stored key of this AI provider cannot be decrypted with the current master key; the provider is skipped until the key is entered again');
    }
    return null;
  }
}

export function createProvider(input: AiProviderInput, scope: { accountId: number | null; updatedBy: number }, db: Database.Database = getDb()): AiProviderRow {
  validate(input);
  const ciphertext = input.apiKey ? encryptWithKey(input.apiKey, getSecretEncryptionKey()) : null;
  const result = db
    .prepare(`INSERT INTO ai_providers (whatsapp_account_id, name, kind, base_url, key_ciphertext, models, vision_models, audio_models, free_tier, free_confirmed, supports_tools, enabled, priority, timeout_ms, notes, updated_by)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(scope.accountId, input.name.trim(), input.kind, input.baseUrl.replace(/\/+$/, ''), ciphertext, input.models.join(','), (input.visionModels ?? []).join(','), (input.audioModels ?? []).join(','),
      input.freeTier === false ? 0 : 1, input.freeConfirmed === false ? 0 : 1, input.supportsTools === false ? 0 : 1, input.enabled === false ? 0 : 1, input.priority ?? 100, input.timeoutMs ?? 20000, input.notes?.trim() || null, scope.updatedBy);
  // A business's own provider joins ITS routing order (at the end); a shared one lives inside the Default entry of every business.
  if (scope.accountId !== null) ensureAccountRouting(scope.accountId, db);
  return db.prepare('SELECT * FROM ai_providers WHERE id = ?').get(result.lastInsertRowid) as AiProviderRow;
}

export function updateProvider(id: number, accountId: number, input: AiProviderInput, updatedBy: number, db: Database.Database = getDb()): AiProviderRow {
  const existing = getProvider(id, accountId, db);
  if (!existing) throw new ProviderValidationError('not_found', []);
  validate(input);
  undecryptableWarned.delete(id);
  const keyClause = input.apiKey === undefined ? '' : ', key_ciphertext = @key';
  const params: Record<string, unknown> = {
    id, name: input.name.trim(), kind: input.kind, base_url: input.baseUrl.replace(/\/+$/, ''), models: input.models.join(','), vision_models: (input.visionModels ?? []).join(','), audio_models: (input.audioModels ?? []).join(','),
    free_tier: input.freeTier === false ? 0 : 1,
    // A different endpoint or kind is a different price list: the confirmation does not carry over unless it is given again.
    free_confirmed: input.freeConfirmed !== undefined ? (input.freeConfirmed ? 1 : 0) : (input.baseUrl.replace(/\/+$/, '') !== existing.base_url || input.kind !== existing.kind) ? 0 : existing.free_confirmed,
    supports_tools: input.supportsTools === false ? 0 : 1, enabled: input.enabled === false ? 0 : 1, priority: input.priority ?? existing.priority, timeout_ms: input.timeoutMs ?? existing.timeout_ms, notes: input.notes?.trim() || null, updated_by: updatedBy,
  };
  if (input.apiKey !== undefined) params.key = input.apiKey ? encryptWithKey(input.apiKey, getSecretEncryptionKey()) : null;
  db.prepare(`UPDATE ai_providers SET name = @name, kind = @kind, base_url = @base_url, models = @models, vision_models = @vision_models, audio_models = @audio_models, free_tier = @free_tier, free_confirmed = @free_confirmed,
              supports_tools = @supports_tools, enabled = @enabled, priority = @priority, timeout_ms = @timeout_ms, notes = @notes, updated_by = @updated_by, updated_at = datetime('now')${keyClause} WHERE id = @id`).run(params);
  return db.prepare('SELECT * FROM ai_providers WHERE id = ?').get(id) as AiProviderRow;
}

export function setProviderEnabled(id: number, accountId: number, enabled: boolean, updatedBy: number, db: Database.Database = getDb()): AiProviderRow | undefined {
  if (!getProvider(id, accountId, db)) return undefined;
  db.prepare("UPDATE ai_providers SET enabled = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?").run(enabled ? 1 : 0, updatedBy, id);
  return db.prepare('SELECT * FROM ai_providers WHERE id = ?').get(id) as AiProviderRow;
}

/** The administrator states that this endpoint/model is on a free tier (the only way a non-OpenRouter route becomes eligible under free-only mode). */
export function setProviderFreeConfirmed(id: number, accountId: number, confirmed: boolean, updatedBy: number, db: Database.Database = getDb()): AiProviderRow | undefined {
  if (!getProvider(id, accountId, db)) return undefined;
  db.prepare("UPDATE ai_providers SET free_confirmed = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?").run(confirmed ? 1 : 0, updatedBy, id);
  return db.prepare('SELECT * FROM ai_providers WHERE id = ?').get(id) as AiProviderRow;
}

export function deleteProvider(id: number, accountId: number, db: Database.Database = getDb()): boolean {
  if (!getProvider(id, accountId, db)) return false;
  const removed = db.prepare('DELETE FROM ai_providers WHERE id = ?').run(id).changes === 1;
  if (removed) forgetProviderEntry(id, db);
  return removed;
}

export function recordProviderTest(id: number, ok: boolean, detail: string, db: Database.Database = getDb()): void {
  db.prepare("UPDATE ai_providers SET last_test_at = datetime('now'), last_test_ok = ?, last_test_detail = ? WHERE id = ?").run(ok ? 1 : 0, detail.slice(0, 300), id);
}

/** For the master-key rotation script: every stored ciphertext, re-encrypted under a new key by the caller. */
export function listProviderCiphertexts(db: Database.Database = getDb()): Array<{ id: number; key_ciphertext: string }> {
  return db.prepare('SELECT id, key_ciphertext FROM ai_providers WHERE key_ciphertext IS NOT NULL').all() as Array<{ id: number; key_ciphertext: string }>;
}
export function overwriteProviderCiphertext(id: number, ciphertext: string, db: Database.Database = getDb()): void {
  db.prepare('UPDATE ai_providers SET key_ciphertext = ? WHERE id = ?').run(ciphertext, id);
}
