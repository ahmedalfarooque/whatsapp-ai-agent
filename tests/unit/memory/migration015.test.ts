import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { runMigrations, createTestDb } from '../../../src/memory/db';

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', '..', 'src', 'memory', 'migrations');

/** Builds a database exactly as production had it BEFORE multi-account support (migrations 001–014) with realistic legacy rows. */
function legacyDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime(\'now\')))');
  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    if (file >= '015') break;
    db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8'));
    db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(file);
  }
  // Legacy data as the current production business would have it.
  db.prepare(`UPDATE business_settings SET business_name = 'Rowad Alfa Auto Care', business_name_ar = 'رواد ألفا', business_category = 'Car care', business_timezone = 'Asia/Riyadh', staff_whatsapp_number = '+966500000000' WHERE id = 1`).run();
  db.prepare(`UPDATE automation_settings SET ai_replies_enabled = 0 WHERE id = 1`).run();
  db.prepare(`UPDATE whatsapp_qr_session SET phone_number = '+966558190545', jid = '966558190545:2@s.whatsapp.net', display_name = 'Rowad Alfa', status = 'connected', connected_at = '2026-10-01 10:00:00' WHERE id = 1`).run();
  db.prepare(`INSERT INTO customers (id, wa_id, display_name, language, menu_state, reply_jid) VALUES (10, '966500000001', 'Ali', 'ar', 'MAIN_MENU', '1234@lid'), (11, '966500000002', NULL, NULL, NULL, NULL)`).run();
  db.prepare(`INSERT INTO conversations (id, customer_id, status) VALUES (100, 10, 'active'), (101, 11, 'ended')`).run();
  db.prepare(`INSERT INTO conversation_messages (conversation_id, role, content) VALUES (100, 'user', 'hi'), (100, 'assistant', 'hello')`).run();
  db.prepare(`INSERT INTO reply_templates (key, category, title_ar, title_en, default_ar, default_en, live_ar, live_en) VALUES ('main_menu', 'menu', 'ق', 'Menu', 'د', 'D', 'مخصص', 'Customised live text')`).run();
  db.prepare(`INSERT INTO customer_requests (id, reference, customer_id, wa_id, kind, payload, status) VALUES (5, 'APT-2026-1234', 10, '966500000001', 'appointment', '{"name":"Ali"}', 'pending')`).run();
  db.prepare(`INSERT INTO offers (id, title_ar, title_en, status) VALUES (7, 'عرض', 'Offer', 'published')`).run();
  db.prepare(`INSERT INTO business_documents (id, original_name, stored_name, mime_type, extension, size_bytes, sha256) VALUES (3, 'a.pdf', 'uuid.pdf', 'application/pdf', 'pdf', 10, 'abc')`).run();
  db.prepare(`INSERT INTO notification_outbox (id, dedupe_key, kind, request_id, target_jid, body) VALUES (9, 'business:new:5', 'business_new_request', 5, '966500000000@s.whatsapp.net', 'alert')`).run();
  db.prepare(`INSERT INTO reply_activity (customer_id, wa_id, channel, kind) VALUES (10, '966500000001', 'qr', 'rule')`).run();
  db.prepare(`INSERT INTO booking_locks (slot_key, idempotency_key, conversation_id, status, start_iso, end_iso) VALUES ('s', 'i', 100, 'confirmed', '2099-01-01T10:00:00.000Z', '2099-01-01T10:30:00.000Z')`).run();
  return db;
}

describe('migration 015 — multi-account (existing production schema)', () => {
  it('creates account 1 from the existing business + session and backfills every business-owned row to it, preserving values and ids', () => {
    const db = legacyDatabase();
    runMigrations(db); // applies 015 (and the additive 016 setup tables) on top
    const applied = (db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as { id: string }[]).map((r) => r.id);
    expect(applied.slice(-3)).toEqual([expect.stringMatching(/^015_/), expect.stringMatching(/^016_/), expect.stringMatching(/^017_/)]);

    const account = db.prepare('SELECT * FROM whatsapp_accounts').all() as Record<string, unknown>[];
    expect(account).toHaveLength(1);
    expect(account[0]).toMatchObject({
      id: 1, name: 'Rowad Alfa Auto Care', name_ar: 'رواد ألفا', business_category: 'Car care', auth_dir: 'baileys-auth', enabled: 1,
      phone_number: '+966558190545', jid: '966558190545:2@s.whatsapp.net', display_name: 'Rowad Alfa', status: 'connected', connected_at: '2026-10-01 10:00:00',
    });

    // Settings rows keep their id (= account id) and values; the CHECK (id = 1) is gone so other accounts can be added.
    expect(db.prepare('SELECT id, business_name, business_timezone, staff_whatsapp_number FROM business_settings').all()).toEqual([
      { id: 1, business_name: 'Rowad Alfa Auto Care', business_timezone: 'Asia/Riyadh', staff_whatsapp_number: '+966500000000' },
    ]);
    expect(db.prepare('SELECT id, ai_replies_enabled FROM automation_settings').all()).toEqual([{ id: 1, ai_replies_enabled: 0 }]);
    expect(() => db.prepare('INSERT INTO business_settings (id) VALUES (2)').run()).not.toThrow();
    expect(() => db.prepare('INSERT INTO automation_settings (id) VALUES (2)').run()).not.toThrow();

    // Customers keep ids, values and the customised template keeps its live text.
    expect(db.prepare('SELECT id, wa_id, display_name, language, menu_state, reply_jid, whatsapp_account_id FROM customers ORDER BY id').all()).toEqual([
      { id: 10, wa_id: '966500000001', display_name: 'Ali', language: 'ar', menu_state: 'MAIN_MENU', reply_jid: '1234@lid', whatsapp_account_id: 1 },
      { id: 11, wa_id: '966500000002', display_name: null, language: null, menu_state: null, reply_jid: null, whatsapp_account_id: 1 },
    ]);
    expect(db.prepare('SELECT whatsapp_account_id, key, live_en FROM reply_templates').all()).toEqual([{ whatsapp_account_id: 1, key: 'main_menu', live_en: 'Customised live text' }]);
    // The same phone may now be a customer of a second business, but not twice of the same one.
    db.prepare("INSERT INTO whatsapp_accounts (id, name, auth_dir) VALUES (2, 'Salon', 'accounts/2/baileys-auth')").run();
    expect(() => db.prepare("INSERT INTO customers (wa_id, whatsapp_account_id) VALUES ('966500000001', 2)").run()).not.toThrow();
    expect(() => db.prepare("INSERT INTO customers (wa_id, whatsapp_account_id) VALUES ('966500000001', 1)").run()).toThrow(/UNIQUE/);

    for (const [table, where] of [
      ['conversations', 'id IN (100, 101)'], ['customer_requests', 'id = 5'], ['offers', 'id = 7'], ['business_documents', 'id = 3'], ['notification_outbox', 'id = 9'], ['reply_activity', '1 = 1'],
    ] as const) {
      const rows = db.prepare(`SELECT whatsapp_account_id FROM ${table} WHERE ${where}`).all() as { whatsapp_account_id: number }[];
      expect(rows.length, table).toBeGreaterThan(0);
      expect(rows.every((r) => r.whatsapp_account_id === 1), table).toBe(true);
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM conversation_messages').get()).toEqual({ n: 2 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM booking_locks WHERE conversation_id = 100').get()).toEqual({ n: 1 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('is idempotent: running the migrations again changes nothing', () => {
    const db = legacyDatabase();
    runMigrations(db);
    const before = JSON.stringify([db.prepare('SELECT * FROM whatsapp_accounts').all(), db.prepare('SELECT * FROM customers').all()]);
    runMigrations(db);
    expect(JSON.stringify([db.prepare('SELECT * FROM whatsapp_accounts').all(), db.prepare('SELECT * FROM customers').all()])).toBe(before);
  });

  it('a fresh database gets the same final schema and a default legacy account', () => {
    const db = createTestDb();
    expect(db.prepare('SELECT id, name, auth_dir, enabled, status FROM whatsapp_accounts').all()).toEqual([
      { id: 1, name: 'Rowad Alfa Auto Care', auth_dir: 'baileys-auth', enabled: 1, status: 'idle' },
    ]);
    const columns = (table: string) => (db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name);
    for (const table of ['customers', 'conversations', 'customer_requests', 'notification_outbox', 'reply_activity', 'business_documents', 'offers', 'reply_templates']) {
      expect(columns(table), table).toContain('whatsapp_account_id');
    }
    expect(columns('admin_account_access')).toEqual(['admin_user_id', 'whatsapp_account_id', 'role', 'created_at']);
  });
});
