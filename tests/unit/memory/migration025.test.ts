import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { runMigrations } from '../../../src/memory/db';

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', '..', 'src', 'memory', 'migrations');

/** The production database as it is today: migrations up to 024 applied, three businesses with their settings rows and a customer each. */
function productionLikeDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    if (file >= '025') break;
    db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8'));
    db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(file);
  }
  db.prepare("INSERT INTO whatsapp_accounts (id, name, auth_dir) VALUES (2, 'Second', 'accounts/2/baileys-auth'), (3, 'Third', 'accounts/3/baileys-auth')").run();
  db.prepare("INSERT INTO business_settings (id, business_hours_start, business_hours_end, business_days, business_timezone) VALUES (2, '09:00', '18:00', '1,2,3,4,5', 'Asia/Dubai'), (3, NULL, NULL, NULL, NULL)").run();
  db.prepare("INSERT INTO customers (id, wa_id, whatsapp_account_id, language, menu_state) VALUES (10, '966500000001', 1, 'ar', 'MAIN_MENU'), (11, '966500000002', 2, 'en', NULL)").run();
  return db;
}

const rows = (db: Database.Database, table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all() as Record<string, unknown>[];
const hashWithout = (list: Record<string, unknown>[], omit: string[]) => createHash('sha256').update(JSON.stringify(list.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !omit.includes(k)))))).digest('hex');
const ADDED = ['weekly_hours', 'closures', 'after_hours_enabled', 'direct_call_enabled', 'callback_window_minutes', 'reminder_lead_minutes', 'reminder_repeat_minutes', 'reminder_max_attempts', 'response_time_promise', 'open_router_audio_model'];

describe('migration 025 — after-hours, follow-up requests, appointment types, job schedule, staff notifications (additive)', () => {
  it('adds the settings columns with the shared defaults and leaves every existing value untouched; customers only gain one nullable column', () => {
    const db = productionLikeDatabase();
    const settingsBefore = hashWithout(rows(db, 'business_settings'), []);
    const customersBefore = hashWithout(rows(db, 'customers'), []);
    runMigrations(db);
    expect(hashWithout(rows(db, 'business_settings'), [...ADDED, 'open_router_fallback_models' /* added by 026, additive too */])).toBe(settingsBefore);
    expect(hashWithout(rows(db, 'customers'), ['after_hours_notified_at'])).toBe(customersBefore);
    for (const r of rows(db, 'business_settings')) {
      expect(r).toMatchObject({ weekly_hours: null, closures: null, after_hours_enabled: 1, direct_call_enabled: 1, callback_window_minutes: 30, reminder_lead_minutes: 0, reminder_repeat_minutes: 5, reminder_max_attempts: 3, response_time_promise: null, open_router_audio_model: null });
    }
    expect(rows(db, 'business_settings').find((r) => r.id === 2)).toMatchObject({ business_hours_start: '09:00', business_timezone: 'Asia/Dubai' });
    for (const r of rows(db, 'customers')) expect(r.after_hours_notified_at).toBeNull();
    expect(db.prepare("SELECT id FROM schema_migrations WHERE id LIKE '025_%'").all()).toHaveLength(1);
  });

  it('seeds the four generic appointment types for EVERY existing business (and only those), and creates the empty new tables', () => {
    const db = productionLikeDatabase();
    runMigrations(db);
    const types = db.prepare('SELECT whatsapp_account_id, key, enabled FROM account_appointment_types ORDER BY whatsapp_account_id, sort_order').all() as { whatsapp_account_id: number; key: string; enabled: number }[];
    expect(types.filter((t) => t.whatsapp_account_id === 1).map((t) => t.key)).toEqual(['consultation', 'service_enquiry', 'product_enquiry', 'quotation_discussion']);
    expect(new Set(types.map((t) => t.whatsapp_account_id))).toEqual(new Set([1, 2, 3]));
    expect(types.every((t) => t.enabled === 1)).toBe(true);
    for (const table of ['followup_requests', 'followup_events', 'scheduled_jobs', 'staff_notifications']) expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    // a second run changes nothing (idempotent: runMigrations skips applied files, and the seed is INSERT OR IGNORE)
    runMigrations(db);
    expect(db.prepare('SELECT COUNT(*) AS n FROM account_appointment_types').get()).toEqual({ n: 12 });
  });

  it('enforces the status and contact-method vocabularies and cascades a business\'s requests with the business', () => {
    const db = productionLikeDatabase();
    runMigrations(db);
    expect(() => db.prepare("INSERT INTO followup_requests (whatsapp_account_id, customer_id, reference, contact_method, timezone, status) VALUES (2, 11, 'CB-1', 'fax', 'Asia/Dubai', 'pending')").run()).toThrow(/CHECK/);
    expect(() => db.prepare("INSERT INTO followup_requests (whatsapp_account_id, customer_id, reference, contact_method, timezone, status) VALUES (2, 11, 'CB-1', 'call', 'Asia/Dubai', 'maybe')").run()).toThrow(/CHECK/);
    db.prepare("INSERT INTO followup_requests (whatsapp_account_id, customer_id, reference, contact_method, timezone, status) VALUES (2, 11, 'CB-1', 'call', 'Asia/Dubai', 'pending')").run();
    db.prepare('DELETE FROM whatsapp_accounts WHERE id = 2').run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM followup_requests').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM account_appointment_types WHERE whatsapp_account_id = 2').get()).toEqual({ n: 0 });
  });
});
