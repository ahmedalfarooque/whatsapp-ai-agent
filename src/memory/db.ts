import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { env } from '../config/env';
import { logger } from '../logger';

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/** Runs every .sql file in migrations/ exactly once, tracked in schema_migrations. */
export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    db
      .prepare('SELECT id FROM schema_migrations')
      .all()
      .map((row) => (row as { id: string }).id),
  );

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    const run = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(file);
    });
    run();
    logger.info({ migration: file }, 'applied database migration');
  }
}

function createDatabase(filePath: string): Database.Database {
  if (filePath !== ':memory:') {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
  }
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  runMigrations(db);
  return db;
}

let instance: Database.Database | null = null;

/** Lazily-initialized singleton connection to the application's SQLite database. */
export function getDb(): Database.Database {
  if (!instance) {
    instance = createDatabase(env.DATABASE_PATH);
  }
  return instance;
}

/** Creates a fresh, fully-migrated in-memory database — used by tests. */
export function createTestDb(): Database.Database {
  return createDatabase(':memory:');
}

export function closeDb(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}
