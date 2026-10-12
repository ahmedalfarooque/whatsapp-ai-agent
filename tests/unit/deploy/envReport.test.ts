import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

// scripts/env-report.cjs answers "which environment is this checkout?" read-only. Disposable database only.
const SCRIPT = path.resolve(__dirname, '..', '..', '..', 'scripts', 'env-report.cjs');
const sha = (f: string): string => createHash('sha256').update(readFileSync(f)).digest('hex');

function run(dbFile: string, extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: { ...process.env, DATABASE_PATH: dbFile, ...extraEnv } });
}

describe('env-report.cjs', () => {
  it('lists the accounts and counts of the database it would open, writes nothing and prints no secret', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'envrep-'));
    try {
      const file = path.join(dir, 'app.db');
      const db = new Database(file);
      db.exec(`CREATE TABLE schema_migrations (id TEXT);
        INSERT INTO schema_migrations VALUES ('001_init.sql'),('023_real_estate.sql');
        CREATE TABLE whatsapp_accounts (id INTEGER, name TEXT, status TEXT, phone_number TEXT);
        INSERT INTO whatsapp_accounts VALUES (1,'Test Company A','connected','966500000001'),(2,'Test Company B','qr_expired',NULL);
        CREATE TABLE customers (id INTEGER); INSERT INTO customers VALUES (1),(2),(3);`);
      db.close();
      const before = sha(file);
      const r = run(file, { OPENROUTER_API_KEY: 'sk-or-SECRET-SHOULD-NOT-APPEAR', DASHBOARD_MASTER_KEY: 'MASTER-SECRET-SHOULD-NOT-APPEAR' });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('ENVIRONMENT REPORT (read-only)');
      expect(r.stdout).toContain(file);
      expect(r.stdout).toContain('accounts   : 2');
      expect(r.stdout).toContain('#1 Test Company A - connected (phone number set)');
      expect(r.stdout).toContain('#2 Test Company B - qr_expired (phone number unset)');
      expect(r.stdout).toContain('latest migration 023_real_estate.sql');
      expect(r.stdout).toContain('customers 3');
      expect(r.stdout).not.toMatch(/SECRET-SHOULD-NOT-APPEAR|966500000001/); // no credential and no phone number
      expect(r.stdout).toContain('NEVER'); // the reminder that production data is not synchronised
      expect(sha(file)).toBe(before); // the database file is byte-identical afterwards
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('says plainly when the database does not exist yet, and does not create it', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'envrep-'));
    try {
      const file = path.join(dir, 'nope.db');
      const r = run(file);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/does not exist yet/);
      expect(() => readFileSync(file)).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('is read-only by construction', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).toMatch(/readonly: true/);
    expect(src).not.toMatch(/\.exec\(|INSERT |UPDATE |DELETE |DROP |writeFileSync|unlinkSync|rmSync/);
  });
});
