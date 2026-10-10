import { getDb } from '../memory/db';
import { getAccount, listAccounts } from '../accounts/accountRepo';
import { hashPassword, destroySessionsForUser } from './auth';
import {
  ASSIGNABLE_ROLES,
  FEATURE_KEYS,
  accessibleAccountIds,
  canAccessAccount,
  getAuthUser,
  isFeatureKey,
  isLevel,
  isRole,
  isSuperAdmin,
  listAuthUsers,
  presetPermissions,
  storedPermissions,
  type AuthUser,
  type PermissionMap,
  type Role,
} from './permissions';

/**
 * Dashboard user management. Everything here is enforced on the server:
 *  - the permanent Super Admin (is_protected) can never be edited, disabled, downgraded, re-assigned or have its password
 *    changed through this module — every function refuses it;
 *  - nobody can change their own role, status or access (so nobody can lock themselves out or promote themselves);
 *  - an Admin can only manage manager / user / custom users and only hand out accounts the Admin itself may open;
 *  - only the Super Admin can create or change Admins or grant the connection / configuration capabilities;
 *  - passwords are hashed with the same scrypt scheme as sign-in and are never stored, returned or logged in clear text;
 *  - there is no hard delete: disabling keeps history and references intact.
 */

export class UserError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'UserError';
  }
}

export const MIN_PASSWORD_LENGTH = 12; // same minimum as first-time setup
const MAX_PASSWORD_LENGTH = 200;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export interface UserAccountView {
  id: number;
  name: string;
  permissions: PermissionMap;
}

export interface UserView {
  id: number;
  name: string | null;
  email: string;
  role: Role;
  status: 'active' | 'disabled';
  protected: boolean;
  allAccounts: boolean;
  canConnection: boolean;
  canConfiguration: boolean;
  accounts: UserAccountView[];
  createdAt: string;
  lastLoginAt: string | null;
}

function viewOf(user: AuthUser): UserView {
  const db = getDb();
  const names = new Map(listAccounts(db).map((a) => [a.id, a.name]));
  const allowed = accessibleAccountIds(user, db);
  const ids = allowed === 'all' ? [...names.keys()] : allowed;
  return {
    id: user.id,
    name: user.displayName,
    email: user.email ?? user.username,
    role: user.role,
    status: user.disabled ? 'disabled' : 'active',
    protected: user.isProtected,
    allAccounts: allowed === 'all',
    canConnection: isSuperAdmin(user) || (user.role === 'admin' && user.canConnection),
    canConfiguration: isSuperAdmin(user) || (user.role === 'admin' && user.canConfiguration),
    accounts: ids
      .filter((id) => names.has(id))
      .map((id) => ({
        id,
        name: names.get(id)!,
        permissions: isSuperAdmin(user) || user.role === 'admin' ? (Object.fromEntries(FEATURE_KEYS.map((k) => [k, 'manage'])) as PermissionMap) : storedPermissions(user.id, id, db),
      })),
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
  };
}

export function listUsers(params: { search?: string; role?: string; status?: string; limit?: number; offset?: number } = {}): { users: UserView[]; total: number } {
  const search = (params.search ?? '').trim().toLowerCase();
  let rows = listAuthUsers();
  if (search) rows = rows.filter((u) => `${u.displayName ?? ''} ${u.email ?? ''} ${u.username}`.toLowerCase().includes(search));
  if (params.role && isRole(params.role)) rows = rows.filter((u) => u.role === params.role);
  if (params.status === 'active') rows = rows.filter((u) => !u.disabled);
  if (params.status === 'disabled') rows = rows.filter((u) => u.disabled);
  const total = rows.length;
  const limit = Math.max(1, Math.min(params.limit ?? 25, 100));
  const offset = Math.max(0, params.offset ?? 0);
  return { users: rows.slice(offset, offset + limit).map(viewOf), total };
}

export function getUserView(id: number): UserView | null {
  const user = getAuthUser(id);
  return user ? viewOf(user) : null;
}

function audit(actor: AuthUser, targetId: number | null, action: string, detail?: Record<string, unknown>): void {
  getDb()
    .prepare('INSERT INTO admin_audit_log (actor_admin_id, target_admin_id, action, detail) VALUES (?, ?, ?, ?)')
    .run(actor.id, targetId, action, detail ? JSON.stringify(detail) : null);
}

function requireManager(actor: AuthUser | null): AuthUser {
  if (!actor || actor.disabled || !(isSuperAdmin(actor) || actor.role === 'admin')) throw new UserError(403, 'You are not allowed to manage users');
  return actor;
}

/** May `actor` change `target` at all? */
function assertCanManage(actor: AuthUser, target: AuthUser): void {
  if (target.isProtected || target.role === 'super_admin') throw new UserError(403, 'The permanent Super Admin account is protected and cannot be changed here');
  if (target.id === actor.id) throw new UserError(403, 'You cannot change your own role, status or access');
  if (!isSuperAdmin(actor) && target.role === 'admin') throw new UserError(403, 'Only the Super Admin can manage administrators');
}

function validateEmail(value: unknown): string {
  if (typeof value !== 'string' || !EMAIL_PATTERN.test(value.trim()) || value.trim().length > 254) throw new UserError(400, 'validation_failed', { email: 'Enter a valid email address' });
  return value.trim();
}

function validatePassword(value: unknown): string {
  if (typeof value !== 'string' || value.length < MIN_PASSWORD_LENGTH) throw new UserError(400, 'validation_failed', { password: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
  if (value.length > MAX_PASSWORD_LENGTH) throw new UserError(400, 'validation_failed', { password: 'Password is too long' });
  return value;
}

function validateName(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new UserError(400, 'validation_failed', { name: 'Name must be text' });
  const name = value.trim();
  if (name.length > 80) throw new UserError(400, 'validation_failed', { name: 'Name must be at most 80 characters' });
  return name || null;
}

function emailTaken(email: string, exceptId?: number): boolean {
  const row = getDb()
    .prepare('SELECT id FROM admin_users WHERE (username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE) AND id != ?')
    .get(email, email, exceptId ?? -1);
  return row !== undefined;
}

interface AccessInput {
  accountIds: number[];
  allAccounts: boolean;
  permissions: Record<number, PermissionMap>;
}

/** Parses and validates the account assignment + per-account permissions that came from the browser. */
function parseAccess(actor: AuthUser, role: Role, body: Record<string, unknown>): AccessInput {
  const allAccounts = body.allAccounts === true;
  if (allAccounts) {
    if (!isSuperAdmin(actor)) throw new UserError(403, 'Only the Super Admin can grant access to all accounts');
    if (role !== 'admin') throw new UserError(400, 'validation_failed', { allAccounts: 'Only administrators can be given every account' });
  }
  const rawIds = Array.isArray(body.accountIds) ? body.accountIds : [];
  const accountIds: number[] = [];
  for (const raw of rawIds) {
    const id = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
    if (!Number.isInteger(id) || id <= 0 || !getAccount(id)) throw new UserError(400, 'validation_failed', { accountIds: 'One of the selected WhatsApp accounts does not exist' });
    if (!canAccessAccount(actor, id)) throw new UserError(403, 'You can only assign WhatsApp accounts you can access yourself');
    if (!accountIds.includes(id)) accountIds.push(id);
  }
  if (!allAccounts && accountIds.length === 0) throw new UserError(400, 'validation_failed', { accountIds: 'Choose at least one WhatsApp account' });

  const permissions: Record<number, PermissionMap> = {};
  const rawPerms = (body.permissions && typeof body.permissions === 'object' ? body.permissions : {}) as Record<string, unknown>;
  for (const id of accountIds) {
    if (role === 'admin') { permissions[id] = {}; continue; } // admins implicitly manage every feature of their accounts
    if (role !== 'custom') { permissions[id] = presetPermissions(role); continue; } // manager / user: the role's preset
    const given = (rawPerms[String(id)] && typeof rawPerms[String(id)] === 'object' ? rawPerms[String(id)] : {}) as Record<string, unknown>;
    const map: PermissionMap = {};
    for (const [feature, level] of Object.entries(given)) {
      if (level === 'none' || level === null || level === '') continue;
      if (!isFeatureKey(feature) || !isLevel(level)) throw new UserError(400, 'validation_failed', { permissions: `Unknown permission "${feature}"` });
      map[feature] = level;
    }
    permissions[id] = map;
  }
  return { accountIds, allAccounts, permissions };
}

function writeAccess(userId: number, access: AccessInput): void {
  const db = getDb();
  db.prepare('DELETE FROM admin_account_access WHERE admin_user_id = ?').run(userId);
  db.prepare('DELETE FROM admin_account_permissions WHERE admin_user_id = ?').run(userId);
  const grant = db.prepare("INSERT INTO admin_account_access (admin_user_id, whatsapp_account_id, role) VALUES (?, ?, 'manager')");
  const perm = db.prepare('INSERT INTO admin_account_permissions (admin_user_id, whatsapp_account_id, feature, level) VALUES (?, ?, ?, ?)');
  for (const id of access.accountIds) {
    grant.run(userId, id);
    for (const [feature, level] of Object.entries(access.permissions[id] ?? {})) perm.run(userId, id, feature, level);
  }
}

export function createUser(actorId: number, body: Record<string, unknown>): UserView {
  const actor = requireManager(getAuthUser(actorId));
  const email = validateEmail(body.email);
  const password = validatePassword(body.password);
  const name = validateName(body.name);
  const role = body.role;
  if (!isRole(role) || !ASSIGNABLE_ROLES.includes(role)) throw new UserError(400, 'validation_failed', { role: 'Choose Admin, Manager, User or Custom' });
  if (role === 'admin' && !isSuperAdmin(actor)) throw new UserError(403, 'Only the Super Admin can create administrators');
  if (emailTaken(email)) throw new UserError(409, 'A user with this email already exists', { email: 'This email is already in use' });
  const access = parseAccess(actor, role, body);
  const wantsConnection = body.canConnection === true;
  const wantsConfiguration = body.canConfiguration === true;
  if ((wantsConnection || wantsConfiguration) && (!isSuperAdmin(actor) || role !== 'admin')) throw new UserError(403, 'Only the Super Admin can give an administrator connection or configuration access');

  const db = getDb();
  const passwordHash = hashPassword(password);
  const id = db.transaction(() => {
    const result = db
      .prepare(
        `INSERT INTO admin_users (username, password_hash, email, display_name, role, is_protected, all_accounts, can_connection, can_configuration, created_by)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      )
      .run(email, passwordHash, email, name, role, access.allAccounts ? 1 : 0, wantsConnection ? 1 : 0, wantsConfiguration ? 1 : 0, actor.id);
    const newId = Number(result.lastInsertRowid);
    writeAccess(newId, access);
    audit(actor, newId, 'user.created', { role, accounts: access.accountIds, allAccounts: access.allAccounts });
    return newId;
  })();
  return getUserView(id)!;
}

export function updateUser(actorId: number, targetId: number, body: Record<string, unknown>): UserView {
  const actor = requireManager(getAuthUser(actorId));
  const target = getAuthUser(targetId);
  if (!target) throw new UserError(404, 'User not found');
  assertCanManage(actor, target);

  const db = getDb();
  const role = body.role === undefined ? target.role : body.role;
  if (!isRole(role) || !ASSIGNABLE_ROLES.includes(role)) throw new UserError(400, 'validation_failed', { role: 'Choose Admin, Manager, User or Custom' });
  if ((role === 'admin' || target.role === 'admin') && role !== target.role && !isSuperAdmin(actor)) throw new UserError(403, 'Only the Super Admin can promote to or demote from Admin');
  const name = body.name === undefined ? target.displayName : validateName(body.name);
  const email = body.email === undefined ? (target.email ?? target.username) : validateEmail(body.email);
  if (emailTaken(email, target.id)) throw new UserError(409, 'A user with this email already exists', { email: 'This email is already in use' });

  const touchesAccess = body.accountIds !== undefined || body.permissions !== undefined || body.allAccounts !== undefined || role !== target.role;
  let access: AccessInput | null = null;
  if (touchesAccess) {
    // Unspecified parts keep their current value so a role-only edit still produces a complete, valid assignment.
    const current = viewOf(target);
    access = parseAccess(actor, role, {
      allAccounts: body.allAccounts === undefined ? target.allAccounts : body.allAccounts,
      accountIds: body.accountIds === undefined ? current.accounts.map((a) => a.id) : body.accountIds,
      permissions: body.permissions === undefined ? Object.fromEntries(current.accounts.map((a) => [String(a.id), a.permissions])) : body.permissions,
    });
  }
  const connection = body.canConnection === undefined ? target.canConnection : body.canConnection === true;
  const configuration = body.canConfiguration === undefined ? target.canConfiguration : body.canConfiguration === true;
  const capabilityChanged = connection !== target.canConnection || configuration !== target.canConfiguration;
  if (capabilityChanged && !isSuperAdmin(actor)) throw new UserError(403, 'Only the Super Admin can change connection or configuration access');
  if ((connection || configuration) && role !== 'admin') throw new UserError(400, 'validation_failed', { canConnection: 'Only administrators can have connection or configuration access' });

  db.transaction(() => {
    db.prepare('UPDATE admin_users SET display_name = ?, email = ?, username = ?, role = ?, all_accounts = ?, can_connection = ?, can_configuration = ? WHERE id = ?').run(
      name,
      email,
      email,
      role,
      access ? (access.allAccounts ? 1 : 0) : target.allAccounts ? 1 : 0,
      role === 'admin' ? (connection ? 1 : 0) : 0,
      role === 'admin' ? (configuration ? 1 : 0) : 0,
      target.id,
    );
    if (access) writeAccess(target.id, access);
    audit(actor, target.id, 'user.updated', { role, accounts: access?.accountIds, allAccounts: access?.allAccounts });
  })();
  // Access changed: sign the user out so the new access applies at the next sign-in (and nothing stale lingers).
  if (access || role !== target.role) destroySessionsForUser(target.id);
  return getUserView(target.id)!;
}

export function setUserDisabled(actorId: number, targetId: number, disabled: boolean): UserView {
  const actor = requireManager(getAuthUser(actorId));
  const target = getAuthUser(targetId);
  if (!target) throw new UserError(404, 'User not found');
  assertCanManage(actor, target);
  getDb().transaction(() => {
    getDb().prepare(disabled ? "UPDATE admin_users SET disabled_at = datetime('now') WHERE id = ?" : 'UPDATE admin_users SET disabled_at = NULL WHERE id = ?').run(target.id);
    if (disabled) destroySessionsForUser(target.id);
    audit(actor, target.id, disabled ? 'user.disabled' : 'user.enabled');
  })();
  return getUserView(target.id)!;
}

export function resetUserPassword(actorId: number, targetId: number, newPassword: unknown): void {
  const actor = requireManager(getAuthUser(actorId));
  const target = getAuthUser(targetId);
  if (!target) throw new UserError(404, 'User not found');
  assertCanManage(actor, target);
  const password = validatePassword(newPassword);
  const hash = hashPassword(password);
  getDb().transaction(() => {
    getDb().prepare('UPDATE admin_users SET password_hash = ? WHERE id = ?').run(hash, target.id);
    destroySessionsForUser(target.id); // the old password's sessions are revoked
    audit(actor, target.id, 'user.password_reset');
  })();
}

export function revokeUserSessions(actorId: number, targetId: number): number {
  const actor = requireManager(getAuthUser(actorId));
  const target = getAuthUser(targetId);
  if (!target) throw new UserError(404, 'User not found');
  assertCanManage(actor, target);
  const count = destroySessionsForUser(target.id);
  audit(actor, target.id, 'user.sessions_revoked', { count });
  return count;
}
