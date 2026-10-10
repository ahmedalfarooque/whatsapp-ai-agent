import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getDb } from '../memory/db';
import { env } from '../config/env';
import { LEGACY_ACCOUNT_ID } from './accountContext';
import { getAuthUser, accessibleAccountIds } from '../dashboard/permissions';

/**
 * WhatsApp accounts = businesses. One row per linked WhatsApp number, each
 * with its own Baileys auth directory, business profile (business_settings
 * row with the same id), automation flags, templates, customers, offers,
 * documents and requests. Account 1 is the legacy single business.
 */

export type AccountConnectionMethod = 'qr' | 'meta';

/** Session phases; identical to the former whatsapp_qr_session statuses. */
export type AccountSessionStatus =
  | 'idle'
  | 'starting'
  | 'scan'
  | 'qr_expired'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'logged_out'
  | 'error';

export interface WhatsappAccount {
  id: number;
  name: string;
  nameAr: string | null;
  businessCategory: string | null;
  connectionMethod: AccountConnectionMethod;
  /** Relative to the data directory. */
  authDir: string;
  enabled: boolean;
  phoneNumber: string | null;
  jid: string | null;
  displayName: string | null;
  status: AccountSessionStatus;
  connectedAt: string | null;
  disconnectedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: number;
  name: string;
  name_ar: string | null;
  business_category: string | null;
  connection_method: string;
  auth_dir: string;
  enabled: number;
  phone_number: string | null;
  jid: string | null;
  display_name: string | null;
  status: string;
  connected_at: string | null;
  disconnected_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function toAccount(r: Row): WhatsappAccount {
  return {
    id: r.id,
    name: r.name,
    nameAr: r.name_ar,
    businessCategory: r.business_category,
    connectionMethod: r.connection_method === 'meta' ? 'meta' : 'qr',
    authDir: r.auth_dir,
    enabled: r.enabled === 1,
    phoneNumber: r.phone_number,
    jid: r.jid,
    displayName: r.display_name,
    status: r.status as AccountSessionStatus,
    connectedAt: r.connected_at,
    disconnectedAt: r.disconnected_at,
    lastError: r.last_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class AccountValidationError extends Error {
  status = 400;
  fields: Record<string, string>;
  constructor(fields: Record<string, string>) {
    super('Account validation failed');
    this.fields = fields;
  }
}

export function listAccounts(db: Database.Database = getDb()): WhatsappAccount[] {
  return (db.prepare('SELECT * FROM whatsapp_accounts ORDER BY id ASC').all() as Row[]).map(toAccount);
}

export function listEnabledAccounts(db: Database.Database = getDb()): WhatsappAccount[] {
  return listAccounts(db).filter((a) => a.enabled);
}

export function getAccount(id: number, db: Database.Database = getDb()): WhatsappAccount | undefined {
  const row = db.prepare('SELECT * FROM whatsapp_accounts WHERE id = ?').get(id) as Row | undefined;
  return row ? toAccount(row) : undefined;
}

export function requireAccount(id: number, db: Database.Database = getDb()): WhatsappAccount {
  const account = getAccount(id, db);
  if (!account) throw new Error(`whatsapp account ${id} does not exist`);
  return account;
}

/** The data directory every account's files live under (same parent as the SQLite file). */
export function dataDir(): string {
  // An in-memory database (tests) must never make the process write next to the source tree.
  // Tests only (in-memory database): one folder per test worker, so test files running in parallel never share or delete each other's files.
  if (env.DATABASE_PATH === ':memory:') return path.join(os.tmpdir(), `whatsapp-ai-agent-test-data${process.env.VITEST_WORKER_ID ? `-${process.env.VITEST_WORKER_ID}` : ''}`);
  return path.resolve(path.dirname(env.DATABASE_PATH));
}

/** Absolute Baileys auth directory for an account (account 1 = the legacy <data>/baileys-auth). */
export function authDirFor(account: Pick<WhatsappAccount, 'authDir'>): string {
  const resolved = path.resolve(dataDir(), account.authDir);
  if (!resolved.startsWith(dataDir())) throw new Error('account auth directory escapes the data directory');
  return resolved;
}

function str(v: unknown, max: number): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

export interface AccountInput {
  name: string;
  nameAr?: string | null;
  businessCategory?: string | null;
  connectionMethod?: AccountConnectionMethod;
}

function validate(raw: unknown, partial: boolean): { name?: string; nameAr?: string | null; businessCategory?: string | null; connectionMethod?: AccountConnectionMethod } {
  const input = (raw ?? {}) as Record<string, unknown>;
  const fields: Record<string, string> = {};
  const out: ReturnType<typeof validate> = {};
  if ('name' in input || !partial) {
    const name = str(input.name, 200);
    if (!name) fields.name = 'Business name is required';
    else out.name = name;
  }
  if ('nameAr' in input) out.nameAr = str(input.nameAr, 200);
  if ('businessCategory' in input) out.businessCategory = str(input.businessCategory, 200);
  if ('connectionMethod' in input) {
    if (input.connectionMethod !== 'qr' && input.connectionMethod !== 'meta') fields.connectionMethod = 'must be qr or meta';
    else out.connectionMethod = input.connectionMethod;
  }
  if (Object.keys(fields).length) throw new AccountValidationError(fields);
  return out;
}

/**
 * Creates a new business with its own auth directory, settings row and
 * automation row. Templates are seeded lazily on first use (templateRepo),
 * knowledge files live under knowledge/accounts/<id>/ (knowledgeAdmin).
 */
export function createAccount(raw: unknown, db: Database.Database = getDb()): WhatsappAccount {
  const v = validate(raw, false);
  const run = db.transaction(() => {
    const result = db
      .prepare(
        `INSERT INTO whatsapp_accounts (name, name_ar, business_category, connection_method, auth_dir)
         VALUES (@name, @nameAr, @businessCategory, @connectionMethod, 'pending')`,
      )
      .run({ name: v.name, nameAr: v.nameAr ?? null, businessCategory: v.businessCategory ?? null, connectionMethod: v.connectionMethod ?? 'qr' });
    const id = Number(result.lastInsertRowid);
    db.prepare('UPDATE whatsapp_accounts SET auth_dir = ? WHERE id = ?').run(`accounts/${id}/baileys-auth`, id);
    ensureAccountRows(id, { name: v.name!, nameAr: v.nameAr ?? null, businessCategory: v.businessCategory ?? null }, db);
    return id;
  });
  return getAccount(run(), db)!;
}

/** Guarantees the per-account settings/automation rows exist (idempotent; also used for account 1 on old databases). */
export function ensureAccountRows(
  accountId: number,
  seed: { name?: string; nameAr?: string | null; businessCategory?: string | null } = {},
  db: Database.Database = getDb(),
): void {
  db.prepare(
    `INSERT OR IGNORE INTO business_settings (id, business_name, business_name_ar, business_category) VALUES (?, ?, ?, ?)`,
  ).run(accountId, seed.name ?? null, seed.nameAr ?? null, seed.businessCategory ?? null);
  db.prepare('INSERT OR IGNORE INTO automation_settings (id) VALUES (?)').run(accountId);
}

export function updateAccount(id: number, raw: unknown, db: Database.Database = getDb()): WhatsappAccount | undefined {
  if (!getAccount(id, db)) return undefined;
  const v = validate(raw, true);
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };
  if (v.name !== undefined) { sets.push('name = @name'); params.name = v.name; }
  if (v.nameAr !== undefined) { sets.push('name_ar = @nameAr'); params.nameAr = v.nameAr; }
  if (v.businessCategory !== undefined) { sets.push('business_category = @businessCategory'); params.businessCategory = v.businessCategory; }
  if (v.connectionMethod !== undefined) { sets.push('connection_method = @connectionMethod'); params.connectionMethod = v.connectionMethod; }
  if (sets.length) {
    sets.push("updated_at = datetime('now')");
    db.prepare(`UPDATE whatsapp_accounts SET ${sets.join(', ')} WHERE id = @id`).run(params);
    // Keep the business profile's own name/category in step when the account is renamed.
    const profile: string[] = [];
    if (v.name !== undefined) profile.push('business_name = @name');
    if (v.nameAr !== undefined) profile.push('business_name_ar = @nameAr');
    if (v.businessCategory !== undefined) profile.push('business_category = @businessCategory');
    if (profile.length) db.prepare(`UPDATE business_settings SET ${profile.join(', ')}, updated_at = datetime('now') WHERE id = @id`).run(params);
  }
  return getAccount(id, db);
}

export function setAccountEnabled(id: number, enabled: boolean, db: Database.Database = getDb()): WhatsappAccount | undefined {
  if (!getAccount(id, db)) return undefined;
  db.prepare("UPDATE whatsapp_accounts SET enabled = ?, updated_at = datetime('now') WHERE id = ?").run(enabled ? 1 : 0, id);
  return getAccount(id, db);
}

// ------------------------------------------------------------------ session state (formerly whatsapp_qr_session)

export function setAccountStatus(
  accountId: number,
  status: AccountSessionStatus,
  lastError: string | null = null,
  db: Database.Database = getDb(),
): void {
  db.prepare(
    `UPDATE whatsapp_accounts
     SET status = @status,
         last_error = @lastError,
         disconnected_at = CASE WHEN @status IN ('disconnected','logged_out','error') THEN datetime('now') ELSE disconnected_at END,
         updated_at = datetime('now')
     WHERE id = @id`,
  ).run({ id: accountId, status, lastError });
}

/** Records the identity that actually scanned the QR code. */
export function recordAccountConnected(
  accountId: number,
  identity: { phoneNumber: string | null; jid: string; displayName: string | null },
  db: Database.Database = getDb(),
): void {
  db.prepare(
    `UPDATE whatsapp_accounts
     SET status = 'connected', phone_number = @phoneNumber, jid = @jid, display_name = @displayName,
         connected_at = datetime('now'), last_error = NULL, updated_at = datetime('now')
     WHERE id = @id`,
  ).run({ id: accountId, ...identity });
}

/**
 * Another account that already holds this WhatsApp identity, if any. Compared by phone number and by the JID's
 * user part with the device suffix removed (each linked device of one number has its own ":<device>" suffix).
 * Used so a number can never be bound to two businesses: both would receive every message and both would reply.
 */
export function findAccountHoldingIdentity(
  accountId: number,
  identity: { phoneNumber: string | null; jid: string },
  db: Database.Database = getDb(),
): WhatsappAccount | null {
  const userOf = (jid: string | null): string => (jid ? (jid.split('@')[0] ?? '').split(':')[0] ?? '' : '');
  const wanted = userOf(identity.jid);
  return (
    listAccounts(db).find((a) => {
      if (a.id === accountId) return false;
      if (identity.phoneNumber !== null && a.phoneNumber === identity.phoneNumber) return true;
      return wanted !== '' && userOf(a.jid) === wanted;
    }) ?? null
  );
}

/** Logout clears the identity — a different number may pair next. */
export function clearAccountIdentity(accountId: number, db: Database.Database = getDb()): void {
  db.prepare(
    `UPDATE whatsapp_accounts
     SET status = 'logged_out', phone_number = NULL, jid = NULL, display_name = NULL,
         connected_at = NULL, disconnected_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ?`,
  ).run(accountId);
}

// ------------------------------------------------------------------ authorization

/**
 * The accounts a dashboard user may open (rules in dashboard/permissions.ts): the permanent Super Admin and users explicitly
 * granted "all accounts" see every account; manager / user / custom users see ONLY their assigned accounts (none = no access);
 * an admin with no assignment keeps the original behaviour (every account), rows restrict it.
 */
export function accountIdsForAdmin(adminUserId: number, db: Database.Database = getDb()): number[] | 'all' {
  const user = getAuthUser(adminUserId, db);
  return user ? accessibleAccountIds(user, db) : [];
}

export function canAdminAccessAccount(adminUserId: number, accountId: number, db: Database.Database = getDb()): boolean {
  const allowed = accountIdsForAdmin(adminUserId, db);
  return allowed === 'all' || allowed.includes(accountId);
}

export function listAccountsForAdmin(adminUserId: number, db: Database.Database = getDb()): WhatsappAccount[] {
  const allowed = accountIdsForAdmin(adminUserId, db);
  return listAccounts(db).filter((a) => allowed === 'all' || allowed.includes(a.id));
}

export function grantAccountAccess(adminUserId: number, accountId: number, role = 'manager', db: Database.Database = getDb()): void {
  db.prepare(
    `INSERT INTO admin_account_access (admin_user_id, whatsapp_account_id, role) VALUES (?, ?, ?)
     ON CONFLICT(admin_user_id, whatsapp_account_id) DO UPDATE SET role = excluded.role`,
  ).run(adminUserId, accountId, role);
}

export function revokeAccountAccess(adminUserId: number, accountId: number, db: Database.Database = getDb()): void {
  db.prepare('DELETE FROM admin_account_access WHERE admin_user_id = ? AND whatsapp_account_id = ?').run(adminUserId, accountId);
}

/** The account a request without an explicit selection lands on: the legacy account when accessible, else the first accessible one. */
export function defaultAccountIdForAdmin(adminUserId: number, db: Database.Database = getDb()): number | null {
  const accounts = listAccountsForAdmin(adminUserId, db);
  if (!accounts.length) return null;
  return accounts.find((a) => a.id === LEGACY_ACCOUNT_ID)?.id ?? accounts[0]!.id;
}
