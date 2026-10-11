import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { runMigrations } from '../../../src/memory/db';

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', '..', 'src', 'memory', 'migrations');

/** The production database as it is today: migrations up to 021 applied, with a customer, a stored PDF, a failed file and a text file already read. */
function productionLikeDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    if (file >= '022') break;
    db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8'));
    db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(file);
  }
  db.prepare("INSERT INTO customers (id, wa_id, display_name, whatsapp_account_id, language) VALUES (10, '966500000010', 'Ali', 1, 'en')").run();
  db.prepare("INSERT INTO customer_files (id, whatsapp_account_id, customer_id, direction, original_name, stored_name, extension, status, processing) VALUES (1, 1, 10, 'inbound', 'po.pdf', 'a.pdf', 'pdf', 'stored', 'stored')").run();
  db.prepare("INSERT INTO customer_files (id, whatsapp_account_id, customer_id, direction, original_name, status, error, processing) VALUES (2, 1, 10, 'inbound', 'big.pdf', 'too_large', 'File is larger than 10 MB', 'unsupported')").run();
  db.prepare("INSERT INTO customer_files (id, whatsapp_account_id, customer_id, direction, original_name, stored_name, extension, status, processing, extracted_text) VALUES (3, 1, 10, 'inbound', 'note.txt', 'b.txt', 'txt', 'stored', 'text_extracted', 'hello')").run();
  return db;
}

const files = (db: Database.Database) => db.prepare('SELECT * FROM customer_files ORDER BY id').all() as Record<string, unknown>[];
const NEW_COLUMNS = ['extracted_at', 'extraction_error', 'extraction_pages', 'extraction_attempts'];

describe('migration 022 — customer file text extraction (additive)', () => {
  it('keeps every existing file row exactly as it was; the new columns start empty (attempts 0)', () => {
    const db = productionLikeDatabase();
    const before = files(db);
    runMigrations(db);
    const after = files(db);
    expect(after.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !NEW_COLUMNS.includes(k))))).toEqual(before);
    for (const row of after) expect(row).toMatchObject({ extracted_at: null, extraction_error: null, extraction_pages: null, extraction_attempts: 0 });
    expect(db.prepare("SELECT id FROM schema_migrations WHERE id LIKE '022_%'").all()).toHaveLength(1);
  });

  it('is repeatable: a second run changes nothing', () => {
    const db = productionLikeDatabase();
    runMigrations(db);
    const first = JSON.stringify(files(db));
    runMigrations(db);
    expect(JSON.stringify(files(db))).toBe(first);
  });

  it('removes nothing: the table keeps every column it had and gains exactly the four new ones', () => {
    const db = productionLikeDatabase();
    const before = (db.prepare('PRAGMA table_info(customer_files)').all() as { name: string }[]).map((c) => c.name);
    runMigrations(db);
    const after = (db.prepare('PRAGMA table_info(customer_files)').all() as { name: string }[]).map((c) => c.name);
    expect(after).toEqual([...before, ...NEW_COLUMNS]);
  });
});
