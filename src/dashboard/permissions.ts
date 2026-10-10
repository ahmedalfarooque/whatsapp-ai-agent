import type Database from 'better-sqlite3';
import { getDb } from '../memory/db';

/**
 * Who may do what in the dashboard.
 *
 * Two separate questions are always asked by the server (never by the browser):
 *   1. which WHATSAPP ACCOUNTS may this user open?   -> accessibleAccountIds()
 *   2. what may this user do on that account?        -> featureLevel()
 * plus three account-independent capabilities that are NOT feature permissions: managing WhatsApp connections, sensitive
 * configuration (credentials, providers, system) and the Users page.
 */

export const ROLES = ['super_admin', 'admin', 'manager', 'user', 'custom'] as const;
export type Role = (typeof ROLES)[number];
export const ASSIGNABLE_ROLES: readonly Role[] = ['admin', 'manager', 'user', 'custom'];

export const LEVELS = ['view', 'edit', 'manage'] as const;
export type Level = (typeof LEVELS)[number];
const LEVEL_RANK: Record<Level, number> = { view: 1, edit: 2, manage: 3 };

export function levelAtLeast(have: Level | null | undefined, need: Level): boolean {
  return have != null && LEVEL_RANK[have] >= LEVEL_RANK[need];
}

/** Only features that exist in the dashboard today. Each one maps to real pages and API routes (see authorize.ts). */
export const FEATURES = [
  { key: 'dashboard', label: 'Dashboard & reports', description: 'Overview, analytics and reports' },
  { key: 'conversations', label: 'Conversations', description: 'Customer conversation history' },
  { key: 'customers', label: 'Customers', description: 'Customer list and details' },
  { key: 'requests', label: 'Requests & appointments', description: 'Quotation and appointment requests, bookings' },
  { key: 'support', label: 'Human support queue', description: 'Customers waiting for a person; pause or resume automation' },
  { key: 'offers', label: 'Offers', description: 'Offers and their pictures and files' },
  { key: 'catalogues', label: 'Catalogues', description: 'Catalogue library (where enabled)' },
  { key: 'documents', label: 'Documents', description: 'Uploaded documents and files' },
  { key: 'business', label: 'Business profile', description: 'Business information, links, location and hours' },
  { key: 'menus', label: 'Menus & templates', description: 'Reply templates, menu and auto-reply control' },
  { key: 'ai', label: 'AI knowledge & settings', description: 'Knowledge files, services and AI configuration (read-only status)' },
  { key: 'notifications', label: 'Notifications', description: 'Staff notification queue' },
  { key: 'activity', label: 'Activity logs', description: 'Automatic reply activity log' },
] as const;
export type FeatureKey = (typeof FEATURES)[number]['key'];
export const FEATURE_KEYS: readonly FeatureKey[] = FEATURES.map((f) => f.key);

export function isFeatureKey(value: unknown): value is FeatureKey {
  return typeof value === 'string' && (FEATURE_KEYS as readonly string[]).includes(value);
}
export function isLevel(value: unknown): value is Level {
  return typeof value === 'string' && (LEVELS as readonly string[]).includes(value);
}
export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export type PermissionMap = Partial<Record<FeatureKey, Level>>;

/** What each role gets on every account it is assigned (stored explicitly per account when the user is saved). */
export function presetPermissions(role: Role): PermissionMap {
  const out: PermissionMap = {};
  if (role === 'manager') for (const k of FEATURE_KEYS) out[k] = 'edit';
  if (role === 'user') for (const k of ['dashboard', 'conversations', 'customers', 'requests', 'support', 'offers', 'catalogues', 'documents', 'notifications'] as const) out[k] = 'view';
  return out;
}

export interface AuthUser {
  id: number;
  username: string;
  email: string | null;
  displayName: string | null;
  role: Role;
  isProtected: boolean;
  disabled: boolean;
  allAccounts: boolean;
  canConnection: boolean;
  canConfiguration: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  createdBy: number | null;
}

interface UserRow {
  id: number;
  username: string;
  email: string | null;
  display_name: string | null;
  role: string;
  is_protected: number;
  disabled_at: string | null;
  all_accounts: number;
  can_connection: number;
  can_configuration: number;
  created_at: string;
  last_login_at: string | null;
  created_by: number | null;
}

const USER_COLUMNS = 'id, username, email, display_name, role, is_protected, disabled_at, all_accounts, can_connection, can_configuration, created_at, last_login_at, created_by';

function toUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    displayName: row.display_name,
    role: isRole(row.role) ? row.role : 'user', // an unknown role value is treated as the least-privileged one
    isProtected: row.is_protected === 1,
    disabled: row.disabled_at !== null,
    allAccounts: row.all_accounts === 1,
    canConnection: row.can_connection === 1,
    canConfiguration: row.can_configuration === 1,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    createdBy: row.created_by,
  };
}

export function getAuthUser(adminUserId: number, db: Database.Database = getDb()): AuthUser | null {
  const row = db.prepare(`SELECT ${USER_COLUMNS} FROM admin_users WHERE id = ?`).get(adminUserId) as UserRow | undefined;
  return row ? toUser(row) : null;
}

export function listAuthUsers(db: Database.Database = getDb()): AuthUser[] {
  return (db.prepare(`SELECT ${USER_COLUMNS} FROM admin_users ORDER BY id`).all() as UserRow[]).map(toUser);
}

/** The permanent Super Admin (and anything marked super_admin) has unrestricted access, always. */
export function isSuperAdmin(user: AuthUser | null): boolean {
  return Boolean(user && !user.disabled && (user.isProtected || user.role === 'super_admin'));
}

/**
 * The WhatsApp accounts a user may open.
 *  - Super Admin, or a user explicitly granted "all accounts": every account (including future ones).
 *  - manager / user / custom: ONLY the accounts assigned to them. None assigned = no access (deny by default).
 *  - admin: the assigned accounts; an admin with no assignment keeps the original behaviour (every account), which is the
 *    behaviour every dashboard admin had before roles existed. The Users page always writes an explicit assignment.
 */
export function accessibleAccountIds(user: AuthUser, db: Database.Database = getDb()): number[] | 'all' {
  if (user.disabled) return [];
  if (isSuperAdmin(user) || user.allAccounts) return 'all';
  const ids = (db.prepare('SELECT whatsapp_account_id AS id FROM admin_account_access WHERE admin_user_id = ?').all(user.id) as { id: number }[]).map((r) => r.id);
  if (user.role === 'admin' && ids.length === 0) return 'all';
  return ids;
}

export function canAccessAccount(user: AuthUser, accountId: number, db: Database.Database = getDb()): boolean {
  const allowed = accessibleAccountIds(user, db);
  return allowed === 'all' || allowed.includes(accountId);
}

export function storedPermissions(userId: number, accountId: number, db: Database.Database = getDb()): PermissionMap {
  const rows = db.prepare('SELECT feature, level FROM admin_account_permissions WHERE admin_user_id = ? AND whatsapp_account_id = ?').all(userId, accountId) as { feature: string; level: string }[];
  const out: PermissionMap = {};
  for (const r of rows) if (isFeatureKey(r.feature) && isLevel(r.level)) out[r.feature] = r.level;
  return out;
}

/** The level a user holds for one feature on one account, or null when there is none. Account access is checked first. */
export function featureLevel(user: AuthUser, accountId: number, feature: FeatureKey, db: Database.Database = getDb()): Level | null {
  if (!canAccessAccount(user, accountId, db)) return null;
  if (isSuperAdmin(user) || user.role === 'admin') return 'manage';
  return storedPermissions(user.id, accountId, db)[feature] ?? null;
}

/** Every feature level for one account (what the browser uses to hide what it cannot use — the server enforces it regardless). */
export function effectivePermissions(user: AuthUser, accountId: number, db: Database.Database = getDb()): PermissionMap {
  if (!canAccessAccount(user, accountId, db)) return {};
  if (isSuperAdmin(user) || user.role === 'admin') return Object.fromEntries(FEATURE_KEYS.map((k) => [k, 'manage'])) as PermissionMap;
  return storedPermissions(user.id, accountId, db);
}

export function canManageConnections(user: AuthUser | null): boolean {
  return Boolean(user && !user.disabled && (isSuperAdmin(user) || (user.role === 'admin' && user.canConnection)));
}
export function canManageConfiguration(user: AuthUser | null): boolean {
  return Boolean(user && !user.disabled && (isSuperAdmin(user) || (user.role === 'admin' && user.canConfiguration)));
}
export function canManageUsers(user: AuthUser | null): boolean {
  return Boolean(user && !user.disabled && (isSuperAdmin(user) || user.role === 'admin'));
}
