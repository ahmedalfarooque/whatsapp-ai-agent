import type Database from 'better-sqlite3';
import { getDb } from '../memory/db';

/**
 * The business's AI routing order (table ai_account_routing, migration 029). The router (aiRouter.buildCandidates) tries the entries in
 * this order: the single "Default" entry — the shared provider pool the Super Admin manages, plus the server's built-in routes — and the
 * business's OWN providers. The order is persisted per business and is what the server really uses; the dashboard only edits it.
 *
 * A saved list can be incomplete or stale (a provider added by an older version, a provider removed since): reading it repairs that without
 * writing — entries whose provider no longer belongs to this business are dropped, entries that are missing are appended (Default first,
 * then own providers by priority), so a new business and an old one both always have a complete, safe order.
 */
export const DEFAULT_ENTRY = 'default';
export const providerEntryKey = (providerId: number): string => `provider:${providerId}`;
export const providerIdOfEntry = (key: string): number | null => {
  const m = /^provider:(\d+)$/.exec(key);
  return m ? Number(m[1]) : null;
};

export interface RoutingEntry {
  key: string;
  type: 'default' | 'provider';
  providerId: number | null;
  enabled: boolean;
  position: number;
}

export class RoutingOrderError extends Error {
  constructor(message: string, public readonly keys: string[] = []) {
    super(message);
    this.name = 'RoutingOrderError';
  }
}

interface SavedRow { entry_key: string; position: number; enabled: number }

function ownProviderIds(accountId: number, db: Database.Database): number[] {
  return (db.prepare('SELECT id FROM ai_providers WHERE whatsapp_account_id = ? ORDER BY priority, id').all(accountId) as Array<{ id: number }>).map((r) => r.id);
}

/** The complete, ordered list for a business (always contains Default; never contains another business's or a shared provider). */
export function getAccountRouting(accountId: number, db: Database.Database = getDb()): RoutingEntry[] {
  const own = ownProviderIds(accountId, db);
  const ownKeys = new Set(own.map(providerEntryKey));
  const saved = (db.prepare('SELECT entry_key, position, enabled FROM ai_account_routing WHERE whatsapp_account_id = ? ORDER BY position, entry_key').all(accountId) as SavedRow[])
    .filter((r) => r.entry_key === DEFAULT_ENTRY || ownKeys.has(r.entry_key));
  const seen = new Set(saved.map((r) => r.entry_key));
  const out: RoutingEntry[] = saved.map((r) => ({ key: r.entry_key, type: r.entry_key === DEFAULT_ENTRY ? 'default' : 'provider', providerId: providerIdOfEntry(r.entry_key), enabled: r.enabled !== 0, position: 0 }));
  if (!seen.has(DEFAULT_ENTRY)) out.push({ key: DEFAULT_ENTRY, type: 'default', providerId: null, enabled: true, position: 0 });
  for (const id of own) if (!seen.has(providerEntryKey(id))) out.push({ key: providerEntryKey(id), type: 'provider', providerId: id, enabled: true, position: 0 });
  return out.map((e, i) => ({ ...e, position: i + 1 }));
}

/**
 * Saves the order (and on/off switches) a business chose. Every key must be Default or one of ITS OWN providers; unknown or foreign keys are
 * refused (a business can never route through another business's provider by naming it). Keys left out are appended in their usual order.
 */
export function saveAccountRouting(accountId: number, entries: Array<{ key: string; enabled?: boolean }>, updatedBy: number | null, db: Database.Database = getDb()): RoutingEntry[] {
  const allowed = new Set([DEFAULT_ENTRY, ...ownProviderIds(accountId, db).map(providerEntryKey)]);
  const bad = entries.map((e) => e.key).filter((k) => !allowed.has(k));
  if (bad.length) throw new RoutingOrderError('unknown_entry', bad);
  const keys = entries.map((e) => e.key);
  if (new Set(keys).size !== keys.length) throw new RoutingOrderError('duplicate_entry', keys.filter((k, i) => keys.indexOf(k) !== i));
  const current = getAccountRouting(accountId, db);
  const wanted = new Map(entries.map((e) => [e.key, e.enabled]));
  const merged = [...entries.map((e) => e.key), ...current.map((c) => c.key).filter((k) => !wanted.has(k))];
  const enabledOf = (k: string): boolean => (wanted.get(k) !== undefined ? wanted.get(k) !== false : current.find((c) => c.key === k)?.enabled ?? true);
  const write = db.transaction(() => {
    db.prepare('DELETE FROM ai_account_routing WHERE whatsapp_account_id = ?').run(accountId);
    const insert = db.prepare('INSERT INTO ai_account_routing (whatsapp_account_id, entry_key, position, enabled, updated_by) VALUES (?, ?, ?, ?, ?)');
    merged.forEach((k, i) => insert.run(accountId, k, i + 1, enabledOf(k) ? 1 : 0, updatedBy));
  });
  write();
  return getAccountRouting(accountId, db);
}

/** Persists the current (repaired) order so a business always has an explicit saved one: used when a business is created or adds a provider. */
export function ensureAccountRouting(accountId: number, db: Database.Database = getDb()): RoutingEntry[] {
  const current = getAccountRouting(accountId, db);
  const insert = db.prepare('INSERT OR IGNORE INTO ai_account_routing (whatsapp_account_id, entry_key, position, enabled) VALUES (?, ?, ?, ?)');
  const write = db.transaction(() => { for (const e of current) insert.run(accountId, e.key, e.position, e.enabled ? 1 : 0); });
  write();
  return current;
}

/** A provider was removed: its entry disappears from the (one) business that owned it. */
export function forgetProviderEntry(providerId: number, db: Database.Database = getDb()): void {
  db.prepare('DELETE FROM ai_account_routing WHERE entry_key = ?').run(providerEntryKey(providerId));
}

export function deleteAccountRouting(accountId: number, db: Database.Database = getDb()): void {
  db.prepare('DELETE FROM ai_account_routing WHERE whatsapp_account_id = ?').run(accountId);
}

/** Forgets this business's saved order and on/off switches: the order is then rebuilt from the defaults (the shared Default entry first, then its own providers in the order they were added). Providers, keys and the shared pool are untouched. */
export function resetAccountRouting(accountId: number, db: Database.Database = getDb()): RoutingEntry[] {
  db.prepare('DELETE FROM ai_account_routing WHERE whatsapp_account_id = ?').run(accountId);
  return ensureAccountRouting(accountId, db);
}
