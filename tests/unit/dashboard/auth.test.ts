import crypto from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../../../src/memory/db';
import {
  hashPassword,
  verifyPassword,
  createAdminUser,
  verifyAdminCredentials,
  createSession,
  verifySessionToken,
  destroySessionByToken,
  destroyAllSessions,
  adminCount,
} from '../../../src/dashboard/auth';

describe('dashboard auth', () => {
  beforeEach(() => {
    getDb().prepare('DELETE FROM admin_sessions').run();
    getDb().prepare('DELETE FROM admin_users').run();
  });

  it('hashes and verifies a password round-trip', () => {
    const hash = hashPassword('correct-horse-battery-staple');
    expect(verifyPassword('correct-horse-battery-staple', hash)).toBe(true);
    expect(verifyPassword('wrong-password', hash)).toBe(false);
  });

  it('never stores the password in plaintext', () => {
    const hash = hashPassword('correct-horse-battery-staple');
    expect(hash).not.toContain('correct-horse-battery-staple');
    expect(hash.startsWith('scrypt$')).toBe(true);
  });

  it('creates the first admin and reports the correct count', () => {
    expect(adminCount()).toBe(0);
    createAdminUser('admin', 'a-very-long-password-123');
    expect(adminCount()).toBe(1);
  });

  it('verifies correct admin credentials and rejects wrong ones', () => {
    createAdminUser('admin', 'a-very-long-password-123');
    expect(verifyAdminCredentials('admin', 'a-very-long-password-123')).toEqual(expect.any(Number));
    expect(verifyAdminCredentials('admin', 'wrong-password')).toBeNull();
    expect(verifyAdminCredentials('nobody', 'a-very-long-password-123')).toBeNull();
  });

  it('creates a session and verifies it by token', () => {
    const adminId = createAdminUser('admin', 'a-very-long-password-123');
    const session = createSession(adminId);
    const verified = verifySessionToken(session.token);
    expect(verified?.adminUserId).toBe(adminId);
  });

  it('rejects an unknown/garbage session token', () => {
    expect(verifySessionToken('not-a-real-token')).toBeNull();
  });

  it('destroySessionByToken invalidates the session', () => {
    const adminId = createAdminUser('admin', 'a-very-long-password-123');
    const session = createSession(adminId);
    destroySessionByToken(session.token);
    expect(verifySessionToken(session.token)).toBeNull();
  });

  it('rejects an expired session', () => {
    const adminId = createAdminUser('admin', 'a-very-long-password-123');
    const session = createSession(adminId);
    // Force the stored expiry into the past to simulate a timed-out session.
    getDb()
      .prepare('UPDATE admin_sessions SET expires_at = ? WHERE token_hash = ?')
      .run(
        new Date(Date.now() - 1000).toISOString(),
        crypto.createHash('sha256').update(session.token).digest('hex'),
      );
    expect(verifySessionToken(session.token)).toBeNull();
  });

  it('destroyAllSessions revokes every session at once, including sessions for other logins', () => {
    const adminId = createAdminUser('admin', 'a-very-long-password-123');
    const sessionA = createSession(adminId);
    const sessionB = createSession(adminId);
    expect(verifySessionToken(sessionA.token)).not.toBeNull();
    expect(verifySessionToken(sessionB.token)).not.toBeNull();

    const revoked = destroyAllSessions();
    expect(revoked).toBeGreaterThanOrEqual(2);

    expect(verifySessionToken(sessionA.token)).toBeNull();
    expect(verifySessionToken(sessionB.token)).toBeNull();
  });
});
