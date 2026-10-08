import crypto from 'node:crypto';
import { getDb } from '../memory/db';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours sliding
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days hard cap

export function hashPassword(plaintext: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(plaintext, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export function verifyPassword(plaintext: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number.parseInt(parts[1] ?? '', 10);
  const r = Number.parseInt(parts[2] ?? '', 10);
  const p = Number.parseInt(parts[3] ?? '', 10);
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const expected = Buffer.from(parts[5] ?? '', 'base64');
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p) || expected.length === 0) {
    return false;
  }
  const derived = crypto.scryptSync(plaintext, salt, expected.length, { N: n, r, p });
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

interface AdminUserRow {
  id: number;
  username: string;
  password_hash: string;
}

export function adminCount(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS count FROM admin_users').get() as { count: number };
  return row.count;
}

/** Creates the first (and, by design, typically only) admin account. Callers
 * MUST re-check adminCount() === 0 inside the same transaction to avoid a
 * race between two concurrent setup requests creating two admins. */
export function createAdminUser(username: string, password: string): number {
  const passwordHash = hashPassword(password);
  const result = getDb()
    .prepare('INSERT INTO admin_users (username, password_hash) VALUES (?, ?)')
    .run(username, passwordHash);
  return Number(result.lastInsertRowid);
}

export function verifyAdminCredentials(username: string, password: string): number | null {
  const row = getDb()
    // NOCASE: an email-style username must not depend on how a phone keyboard capitalised it.
    .prepare('SELECT id, username, password_hash FROM admin_users WHERE username = ? COLLATE NOCASE')
    .get(username.trim()) as AdminUserRow | undefined;
  if (!row) return null;
  if (!verifyPassword(password, row.password_hash)) return null;
  return row.id;
}

/** Stamps last_login_at — called only once a session is actually established (after the email code when that step is on). */
export function recordAdminLogin(adminUserId: number): void {
  getDb().prepare("UPDATE admin_users SET last_login_at = datetime('now') WHERE id = ?").run(adminUserId);
}

export interface CreatedSession {
  token: string;
  expiresAt: string;
}

export function createSession(adminUserId: number): CreatedSession {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

  getDb()
    .prepare(
      `INSERT INTO admin_sessions (id, admin_user_id, token_hash, expires_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(id, adminUserId, tokenHash, expiresAt);

  return { token, expiresAt };
}

export function verifySessionToken(token: string): { adminUserId: number } | null {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const row = getDb()
    .prepare('SELECT id, admin_user_id, created_at, expires_at FROM admin_sessions WHERE token_hash = ?')
    .get(tokenHash) as
    | { id: string; admin_user_id: number; created_at: string; expires_at: string }
    | undefined;
  if (!row) return null;

  const now = Date.now();
  const expiresAt = new Date(row.expires_at).getTime();
  const createdAt = new Date(row.created_at).getTime();
  if (now > expiresAt || now - createdAt > SESSION_MAX_AGE_MS) {
    getDb().prepare('DELETE FROM admin_sessions WHERE id = ?').run(row.id);
    return null;
  }

  const newExpiresAt = new Date(now + SESSION_TTL_MS).toISOString();
  getDb()
    .prepare(`UPDATE admin_sessions SET last_seen_at = datetime('now'), expires_at = ? WHERE id = ?`)
    .run(newExpiresAt, row.id);

  return { adminUserId: row.admin_user_id };
}

export function destroySessionByToken(token: string): void {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  getDb().prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(tokenHash);
}

/** Revokes every active dashboard session (including the caller's own) —
 * for when an admin suspects a session/device was compromised and wants a
 * hard reset rather than tracking down individual sessions. Everyone,
 * including whoever calls this, must log in again afterward. */
export function destroyAllSessions(): number {
  const result = getDb().prepare('DELETE FROM admin_sessions').run();
  return result.changes;
}
