import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { runMigrations } from '../../../src/memory/db';
import { getAuthUser, accessibleAccountIds, isSuperAdmin, canManageConfiguration, canManageConnections } from '../../../src/dashboard/permissions';

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', '..', 'src', 'memory', 'migrations');

/** The production database as it is today: migrations up to 018 applied, one existing owner account (id 2) with a live session. */
function productionLikeDatabase(extraAdmins = false): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    if (file >= '019') break;
    db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8'));
    db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(file);
  }
  db.prepare("INSERT INTO admin_users (id, username, password_hash, created_at, last_login_at) VALUES (2, 'owner@example.com', 'scrypt$16384$8$1$c2FsdA==$aGFzaA==', '2026-09-16 20:01:09', '2026-10-10 08:53:17')").run();
  db.prepare("INSERT INTO admin_sessions (id, admin_user_id, token_hash, expires_at) VALUES ('s1', 2, 'tokenhash', '2099-01-01T00:00:00.000Z')").run();
  if (extraAdmins) db.prepare("INSERT INTO admin_users (id, username, password_hash) VALUES (7, 'second@example.com', 'x')").run();
  return db;
}

describe('migration 019 — users, roles and permissions (additive)', () => {
  it('marks the existing owner as the protected Super Admin without changing a single credential, id or session', () => {
    const db = productionLikeDatabase();
    const before = db.prepare('SELECT id, username, password_hash, created_at, last_login_at, email FROM admin_users WHERE id = 2').get();
    const sessionsBefore = db.prepare('SELECT * FROM admin_sessions').all();
    runMigrations(db);

    expect(db.prepare('SELECT id, username, password_hash, created_at, last_login_at, email FROM admin_users WHERE id = 2').get()).toEqual(before);
    expect(db.prepare('SELECT * FROM admin_sessions').all()).toEqual(sessionsBefore);
    expect(db.prepare('SELECT role, is_protected, all_accounts, disabled_at FROM admin_users WHERE id = 2').get()).toEqual({ role: 'super_admin', is_protected: 1, all_accounts: 1, disabled_at: null });
    const user = getAuthUser(2, db)!;
    expect(isSuperAdmin(user)).toBe(true);
    expect(canManageConnections(user)).toBe(true);
    expect(canManageConfiguration(user)).toBe(true);
    expect(accessibleAccountIds(user, db)).toBe('all');
  });

  it('is additive: new tables exist, no admin row is added or removed, and re-running changes nothing', () => {
    const db = productionLikeDatabase();
    runMigrations(db);
    const snapshot = JSON.stringify(db.prepare('SELECT * FROM admin_users').all());
    runMigrations(db);
    expect(JSON.stringify(db.prepare('SELECT * FROM admin_users').all())).toBe(snapshot);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('admin_account_permissions', 'admin_audit_log') ORDER BY name").all()).toHaveLength(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM admin_users').get()).toEqual({ n: 1 });
  });

  it('any other pre-existing admin keeps exactly today\'s powers (a full admin on every account) and is not protected', () => {
    const db = productionLikeDatabase(true);
    runMigrations(db);
    expect(db.prepare('SELECT role, is_protected, all_accounts, can_connection, can_configuration FROM admin_users WHERE id = 7').get()).toEqual({ role: 'admin', is_protected: 0, all_accounts: 0, can_connection: 1, can_configuration: 1 });
    const other = getAuthUser(7, db)!;
    expect(isSuperAdmin(other)).toBe(false);
    expect(accessibleAccountIds(other, db)).toBe('all'); // no assignment rows = the behaviour every admin had before roles existed
  });
});
