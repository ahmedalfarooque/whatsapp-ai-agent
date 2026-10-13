import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { runMigrations } from '../../../src/memory/db';

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', '..', 'src', 'memory', 'migrations');
const NEW_TABLES = ['real_estate_projects', 'real_estate_leads', 'real_estate_lead_projects', 'real_estate_lead_events'];

/** The production database as it is today: migrations up to 022 applied, three businesses with customers, requests and files. */
function productionLikeDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    if (file >= '023') break;
    db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8'));
    db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(file);
  }
  db.prepare("INSERT INTO whatsapp_accounts (id, name, auth_dir) VALUES (2, 'Second', 'accounts/2/baileys-auth'), (3, 'Third', 'accounts/3/baileys-auth')").run();
  db.prepare("INSERT INTO customers (id, wa_id, display_name, whatsapp_account_id, language) VALUES (10, '966500000010', 'Ali', 1, 'en'), (11, '966500000011', 'Sara', 3, 'ar')").run();
  db.prepare("INSERT INTO customer_requests (reference, customer_id, wa_id, kind, payload, whatsapp_account_id) VALUES ('APT-2026-1111', 10, '966500000010', 'appointment', '{}', 1)").run();
  return db;
}

/** Applies exactly the migrations whose file name starts with the given prefix (the way runMigrations would, one by one). */
function applyOnly(db: Database.Database, prefix: string): void {
  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && f.startsWith(prefix)).sort()) {
    db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8'));
    db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(file);
  }
}

function fingerprint(db: Database.Database): string {
  const parts: unknown[] = [];
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'real_estate_%' AND name <> 'schema_migrations' ORDER BY name").all() as { name: string }[]) {
    parts.push([name, (db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]).map((c) => c.name), db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]);
  }
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

describe('migration 023 — real estate add-on (additive)', () => {
  it('changes no existing table or row; it only adds the four real estate tables, all empty', () => {
    const db = productionLikeDatabase();
    const before = fingerprint(db);
    applyOnly(db, '023'); // 023 alone: later additive migrations (024 adds two business_settings columns) have their own test
    expect(fingerprint(db)).toBe(before);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    for (const t of NEW_TABLES) {
      expect(tables).toContain(t);
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()).toEqual({ n: 0 });
    }
    expect(db.prepare("SELECT id FROM schema_migrations WHERE id LIKE '023_%'").all()).toHaveLength(1);
  });

  it('is repeatable: a second run changes nothing', () => {
    const db = productionLikeDatabase();
    runMigrations(db);
    const first = JSON.stringify(db.prepare("SELECT name, sql FROM sqlite_master WHERE name LIKE 'real_estate_%' OR name LIKE '%re_%' ORDER BY name").all());
    runMigrations(db);
    expect(JSON.stringify(db.prepare("SELECT name, sql FROM sqlite_master WHERE name LIKE 'real_estate_%' OR name LIKE '%re_%' ORDER BY name").all())).toBe(first);
  });

  it('allows exactly one OPEN lead per customer and kind; a closed one does not block a new enquiry', () => {
    const db = productionLikeDatabase();
    runMigrations(db);
    const insert = db.prepare("INSERT INTO real_estate_leads (whatsapp_account_id, customer_id, reference, kind, status) VALUES (3, 11, ?, ?, ?)");
    insert.run('RE-2026-1001', 'buyer', 'new');
    expect(() => insert.run('RE-2026-1002', 'buyer', 'qualified')).toThrow(/UNIQUE/);
    insert.run('RE-2026-1003', 'seller', 'new'); // another kind is fine
    db.prepare("UPDATE real_estate_leads SET status = 'closed' WHERE reference = 'RE-2026-1001'").run();
    insert.run('RE-2026-1004', 'buyer', 'new'); // the earlier buyer enquiry is closed
    expect(() => insert.run('RE-2026-1004', 'investor', 'new')).toThrow(/UNIQUE/); // references are unique per business
  });

  it('rejects unknown kinds, statuses and project stages, and removes a business\'s rows with the business', () => {
    const db = productionLikeDatabase();
    runMigrations(db);
    expect(() => db.prepare("INSERT INTO real_estate_leads (whatsapp_account_id, customer_id, reference, kind) VALUES (3, 11, 'x', 'landlord')").run()).toThrow(/CHECK/);
    expect(() => db.prepare("INSERT INTO real_estate_leads (whatsapp_account_id, customer_id, reference, kind, status) VALUES (3, 11, 'y', 'buyer', 'won')").run()).toThrow(/CHECK/);
    expect(() => db.prepare("INSERT INTO real_estate_projects (whatsapp_account_id, name_en, stage) VALUES (3, 'P', 'launched')").run()).toThrow(/CHECK/);
    db.prepare("INSERT INTO real_estate_projects (whatsapp_account_id, name_en) VALUES (3, 'P')").run();
    db.prepare("INSERT INTO real_estate_leads (whatsapp_account_id, customer_id, reference, kind) VALUES (3, 11, 'z', 'buyer')").run();
    db.prepare('DELETE FROM customers WHERE id = 11').run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_estate_leads').get()).toEqual({ n: 0 });
  });
});
