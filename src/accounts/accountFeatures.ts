import type Database from 'better-sqlite3';
import { getDb } from '../memory/db';
import { LEGACY_ACCOUNT_ID } from './accountContext';

/**
 * Add-on capabilities that belong to one specific business (not the platform).
 * The original business (account 1) can never have one: this is the single
 * place where that is enforced, so no menu, template, AI tool or dashboard
 * page of the original business can change because an add-on exists elsewhere.
 */
export const FEATURES = { CATALOGUES: 'catalogues' } as const;
export type AccountFeature = (typeof FEATURES)[keyof typeof FEATURES];

export function accountHasFeature(accountId: number, feature: AccountFeature, db: Database.Database = getDb()): boolean {
  if (accountId === LEGACY_ACCOUNT_ID) return false;
  try {
    const row = db.prepare('SELECT enabled FROM account_features WHERE whatsapp_account_id = ? AND feature = ?').get(accountId, feature) as { enabled: number } | undefined;
    return row?.enabled === 1;
  } catch {
    return false; // very old test databases without the table
  }
}

export function setAccountFeature(accountId: number, feature: AccountFeature, enabled: boolean, db: Database.Database = getDb()): void {
  if (accountId === LEGACY_ACCOUNT_ID) throw new Error('The original business does not use add-on features');
  if (!db.prepare('SELECT 1 FROM whatsapp_accounts WHERE id = ?').get(accountId)) throw new Error(`WhatsApp account ${accountId} does not exist`);
  db.prepare(
    `INSERT INTO account_features (whatsapp_account_id, feature, enabled, updated_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(whatsapp_account_id, feature) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
  ).run(accountId, feature, enabled ? 1 : 0);
}
