import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { runMigrations } from '../../../src/memory/db';

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', '..', 'src', 'memory', 'migrations');

/** The production database as it is today: migrations up to 020 applied, customers, requests with their audit trail, queued and sent notifications. */
function productionLikeDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    if (file >= '021') break;
    db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8'));
    db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(file);
  }
  db.prepare("INSERT INTO whatsapp_accounts (id, name, connection_method, auth_dir) VALUES (2, 'Second business', 'qr', 'accounts/2/auth')").run();
  db.prepare("INSERT INTO customers (id, wa_id, display_name, whatsapp_account_id, language) VALUES (10, '966500000010', 'Ali', 1, 'en')").run();
  db.prepare("INSERT INTO customers (id, wa_id, display_name, whatsapp_account_id, language) VALUES (11, '966500000011', 'Mona', 2, 'ar')").run();
  db.prepare(`INSERT INTO customer_requests (id, reference, customer_id, wa_id, kind, payload, status, whatsapp_account_id) VALUES (1, 'INQ-2026-1111', 10, '966500000010', 'quotation', '{"name":"Ali","service":"PPF"}', 'confirmed', 1)`).run();
  db.prepare(`INSERT INTO customer_requests (id, reference, customer_id, wa_id, kind, payload, status, whatsapp_account_id) VALUES (2, 'APT-2026-2222', 11, '966500000011', 'appointment', '{"name":"Mona"}', 'pending', 2)`).run();
  db.prepare(`INSERT INTO request_events (request_id, reference, old_status, new_status, actor, actor_detail) VALUES (1, 'INQ-2026-1111', 'pending', 'confirmed', 'dashboard', 'admin#2')`).run();
  db.prepare(`INSERT INTO notification_outbox (dedupe_key, kind, request_id, target_jid, body, status, whatsapp_account_id) VALUES ('customer:1:confirmed', 'customer_status', 1, '966500000010@s.whatsapp.net', 'Confirmed', 'sent', 1)`).run();
  return db;
}

const snapshot = (db: Database.Database, table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all() as Record<string, unknown>[];
/** Rows with only the columns that existed before (a later migration may add nullable columns; none may change). */
const original = (rows: Record<string, unknown>[], dropped: string[]) => rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !dropped.includes(k))));

describe('migration 021 — customer history, inquiry cart, quotations (additive)', () => {
  it('keeps every existing row exactly as it was and only adds nullable / defaulted columns', () => {
    const db = productionLikeDatabase();
    const before = {
      customers: snapshot(db, 'customers'), requests: snapshot(db, 'customer_requests'), events: snapshot(db, 'request_events'), outbox: snapshot(db, 'notification_outbox'),
    };
    runMigrations(db);

    expect(original(snapshot(db, 'customers'), ['email', 'company_name'])).toEqual(before.customers);
    expect(original(snapshot(db, 'customer_requests'), ['cart_id', 'source'])).toEqual(before.requests);
    expect(original(snapshot(db, 'request_events'), ['admin_user_id', 'reason'])).toEqual(before.events);
    expect(original(snapshot(db, 'notification_outbox'), ['attachment_file_id'])).toEqual(before.outbox);
    // existing requests are known to have come from the menu; the new columns start empty
    expect(db.prepare('SELECT source, cart_id FROM customer_requests ORDER BY id').all()).toEqual([{ source: 'menu', cart_id: null }, { source: 'menu', cart_id: null }]);
    expect(db.prepare('SELECT email, company_name FROM customers WHERE id = 10').get()).toEqual({ email: null, company_name: null });
    expect(db.prepare('SELECT attachment_file_id FROM notification_outbox').get()).toEqual({ attachment_file_id: null });
    expect(db.prepare("SELECT id FROM schema_migrations WHERE id LIKE '021_%'").all()).toHaveLength(1);
  });

  it('is repeatable: a second run changes nothing', () => {
    const db = productionLikeDatabase();
    runMigrations(db);
    const tables = ['inquiry_carts', 'inquiry_cart_items', 'customer_files', 'quotation_versions', 'quotation_lines', 'customer_notes', 'customer_requests', 'customers'];
    const first = tables.map((t) => JSON.stringify(snapshot(db, t)));
    runMigrations(db);
    expect(tables.map((t) => JSON.stringify(snapshot(db, t)))).toEqual(first);
  });

  it('enforces the rules the features rely on', () => {
    const db = productionLikeDatabase();
    runMigrations(db);
    // one OPEN cart per customer (a submitted one does not block a new one)
    db.prepare("INSERT INTO inquiry_carts (whatsapp_account_id, customer_id) VALUES (1, 10)").run();
    expect(() => db.prepare("INSERT INTO inquiry_carts (whatsapp_account_id, customer_id) VALUES (1, 10)").run()).toThrow(/UNIQUE/);
    db.prepare("UPDATE inquiry_carts SET status = 'submitted' WHERE customer_id = 10").run();
    expect(() => db.prepare("INSERT INTO inquiry_carts (whatsapp_account_id, customer_id) VALUES (1, 10)").run()).not.toThrow();
    // a quantity must be sensible; an absent one is NULL, never 0
    const cart = (db.prepare("SELECT id FROM inquiry_carts WHERE status = 'open'").get() as { id: number }).id;
    const item = (qty: number | null) => db.prepare("INSERT INTO inquiry_cart_items (cart_id, whatsapp_account_id, position, description, quantity) VALUES (?, 1, 1, 'x', ?)").run(cart, qty);
    expect(() => item(null)).not.toThrow();
    expect(() => item(0)).toThrow();
    expect(() => item(-2)).toThrow();
    // an inbound WhatsApp message stores at most one file per business; the same id in another business is a different message
    const file = (account: number, messageId: string) => db.prepare("INSERT INTO customer_files (whatsapp_account_id, direction, whatsapp_message_id, stored_name) VALUES (?, 'inbound', ?, ?)").run(account, messageId, `${account}-${messageId}-${Math.random()}`);
    file(1, 'qr:1:abc');
    expect(() => file(1, 'qr:1:abc')).toThrow(/UNIQUE/);
    expect(() => file(2, 'qr:1:abc')).not.toThrow();
    // a quotation version number is unique per request, and so is the quote number
    const version = (n: number, quote: string) => db.prepare("INSERT INTO quotation_versions (whatsapp_account_id, request_id, customer_id, version, quote_number) VALUES (1, 1, 10, ?, ?)").run(n, quote);
    version(1, 'INQ-2026-1111-Q1');
    expect(() => version(1, 'INQ-2026-1111-Q1b')).toThrow(/UNIQUE/);
    expect(() => version(2, 'INQ-2026-1111-Q1')).toThrow(/UNIQUE/);
    expect(() => version(2, 'INQ-2026-1111-Q2')).not.toThrow();
    // money is integer minor units; a negative price is refused
    const v = (db.prepare('SELECT id FROM quotation_versions LIMIT 1').get() as { id: number }).id;
    expect(() => db.prepare("INSERT INTO quotation_lines (version_id, position, description, quantity_milli, unit_price_minor) VALUES (?, 1, 'x', 1000, -1)").run(v)).toThrow();
    expect(() => db.prepare("INSERT INTO quotation_lines (version_id, position, description, quantity_milli, unit_price_minor) VALUES (?, 1, 'x', 1000, NULL)").run(v)).not.toThrow();
  });

  it('removing a business removes its customer files, carts and notes with it (no orphans), but a customer\'s removal keeps their files for review', () => {
    const db = productionLikeDatabase();
    runMigrations(db);
    db.prepare("INSERT INTO customer_files (whatsapp_account_id, customer_id, direction, stored_name) VALUES (2, 11, 'inbound', 'f1')").run();
    db.prepare("INSERT INTO customer_notes (whatsapp_account_id, customer_id, body) VALUES (2, 11, 'hello')").run();
    db.prepare('DELETE FROM customers WHERE id = 11').run();
    expect(db.prepare("SELECT customer_id FROM customer_files WHERE stored_name = 'f1'").get()).toEqual({ customer_id: null });
    expect(db.prepare('SELECT COUNT(*) AS n FROM customer_notes').get()).toEqual({ n: 0 });
  });
});
