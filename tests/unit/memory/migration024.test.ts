import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { runMigrations } from '../../../src/memory/db';

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', '..', 'src', 'memory', 'migrations');

/** The production database as it is today: migrations up to 023 applied, three businesses with their settings rows. */
function productionLikeDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    if (file >= '024') break;
    db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8'));
    db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(file);
  }
  db.prepare("INSERT INTO whatsapp_accounts (id, name, auth_dir) VALUES (2, 'Second', 'accounts/2/baileys-auth'), (3, 'Third', 'accounts/3/baileys-auth')").run();
  db.prepare("INSERT INTO business_settings (id, open_router_model, supported_languages) VALUES (2, 'vendor/model-x', 'ar,en'), (3, NULL, NULL)").run();
  return db;
}

const rows = (db: Database.Database) => db.prepare('SELECT * FROM business_settings ORDER BY id').all() as Record<string, unknown>[];
const hashWithout = (list: Record<string, unknown>[], omit: string[]) => createHash('sha256').update(JSON.stringify(list.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !omit.includes(k)))))).digest('hex');

describe('migration 024 — shared AI reply policy and vision model (additive)', () => {
  it('adds the two nullable columns and changes nothing else: every business keeps its values and inherits the shared defaults (NULL)', () => {
    const db = productionLikeDatabase();
    const before = hashWithout(rows(db), []);
    runMigrations(db);
    const after = rows(db);
    // (025 later adds the after-hours / follow-up columns to the same table; they are additive too and are left out of the comparison)
    const ADDED_BY_025 = ['weekly_hours', 'closures', 'after_hours_enabled', 'direct_call_enabled', 'callback_window_minutes', 'reminder_lead_minutes', 'reminder_repeat_minutes', 'reminder_max_attempts', 'response_time_promise', 'open_router_audio_model'];
    const ADDED_BY_026 = ['open_router_fallback_models'];
    expect(hashWithout(after, ['ai_reply_language', 'open_router_vision_model', ...ADDED_BY_025, ...ADDED_BY_026])).toBe(before);
    for (const r of after) {
      expect(r.ai_reply_language).toBeNull();
      expect(r.open_router_vision_model).toBeNull();
    }
    expect(after.find((r) => r.id === 2)?.open_router_model).toBe('vendor/model-x');
    expect(db.prepare("SELECT id FROM schema_migrations WHERE id LIKE '024_%'").all()).toHaveLength(1);
  });

  it('is repeatable and the columns accept a per-business override', () => {
    const db = productionLikeDatabase();
    runMigrations(db);
    runMigrations(db);
    db.prepare("UPDATE business_settings SET ai_reply_language = 'ar', open_router_vision_model = 'vendor/sees-pictures' WHERE id = 3").run();
    expect(rows(db).find((r) => r.id === 3)).toMatchObject({ ai_reply_language: 'ar', open_router_vision_model: 'vendor/sees-pictures' });
    expect(rows(db).find((r) => r.id === 2)).toMatchObject({ ai_reply_language: null, open_router_vision_model: null });
  });
});
