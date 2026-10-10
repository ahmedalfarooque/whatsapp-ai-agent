import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { runMigrations } from '../../../src/memory/db';

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', '..', 'src', 'memory', 'migrations');

/** The production database as it is today: migrations up to 019 applied, one owner, two customers — one of them waiting for a person. */
function productionLikeDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    if (file >= '020') break;
    db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8'));
    db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(file);
  }
  db.prepare("INSERT INTO admin_users (id, username, password_hash, created_at) VALUES (2, 'owner@example.com', 'scrypt$16384$8$1$c2FsdA==$aGFzaA==', '2026-09-16 20:01:09')").run();
  db.prepare("INSERT INTO customers (id, wa_id, display_name, whatsapp_account_id, language, automation_paused, paused_at, pause_reason) VALUES (10, '966500000010', 'Waiting Customer', 1, 'en', 1, '2026-10-09 10:00:00', 'Customer requested a human')").run();
  db.prepare("INSERT INTO customers (id, wa_id, display_name, whatsapp_account_id, language) VALUES (11, '966500000011', 'Normal Customer', 1, 'ar')").run();
  db.prepare("INSERT INTO conversations (id, customer_id, whatsapp_account_id) VALUES (100, 10, 1)").run();
  db.prepare("INSERT INTO conversation_messages (conversation_id, role, content) VALUES (100, 'user', 'موظف')").run();
  return db;
}

describe('migration 020 — human handoffs (additive)', () => {
  it('keeps every existing row untouched and turns each customer who is already waiting for a person into a queued handoff', () => {
    const db = productionLikeDatabase();
    const customers = db.prepare('SELECT * FROM customers ORDER BY id').all();
    const admins = db.prepare('SELECT * FROM admin_users ORDER BY id').all();
    const messages = db.prepare('SELECT * FROM conversation_messages ORDER BY id').all();
    runMigrations(db);

    expect(db.prepare('SELECT * FROM customers ORDER BY id').all()).toEqual(customers);
    expect(db.prepare('SELECT * FROM admin_users ORDER BY id').all()).toEqual(admins);
    expect(db.prepare('SELECT * FROM conversation_messages ORDER BY id').all()).toEqual(messages);

    const handoffs = db.prepare('SELECT whatsapp_account_id, customer_id, conversation_id, state, source, reason, requested_at, assigned_admin_id FROM human_handoffs').all();
    expect(handoffs).toEqual([
      { whatsapp_account_id: 1, customer_id: 10, conversation_id: 100, state: 'HUMAN_REQUESTED', source: 'migrated', reason: 'Customer requested a human', requested_at: '2026-10-09 10:00:00', assigned_admin_id: null },
    ]);
    expect(db.prepare('SELECT event, to_state, actor_type FROM human_handoff_events').all()).toEqual([{ event: 'migrated', to_state: 'HUMAN_REQUESTED', actor_type: 'system' }]);
  });

  it('is additive and repeatable: the three tables exist, a second run changes nothing, and one open handoff per customer is enforced', () => {
    const db = productionLikeDatabase();
    runMigrations(db);
    const snapshot = JSON.stringify(db.prepare('SELECT * FROM human_handoffs').all());
    runMigrations(db);
    expect(JSON.stringify(db.prepare('SELECT * FROM human_handoffs').all())).toBe(snapshot);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'human_handoff%' ORDER BY name").all()).toEqual([{ name: 'human_handoff_events' }, { name: 'human_handoff_messages' }, { name: 'human_handoffs' }]);
    expect(() => db.prepare("INSERT INTO human_handoffs (whatsapp_account_id, customer_id, state) VALUES (1, 10, 'HUMAN_ACTIVE')").run()).toThrow(/UNIQUE/);
    // a finished handoff does not block a new one
    db.prepare("UPDATE human_handoffs SET state = 'AI_ACTIVE' WHERE customer_id = 10").run();
    expect(() => db.prepare("INSERT INTO human_handoffs (whatsapp_account_id, customer_id, state) VALUES (1, 10, 'HUMAN_REQUESTED')").run()).not.toThrow();
  });

  it('the state and source columns only accept the defined values, and staff replies are unique per message id', () => {
    const db = productionLikeDatabase();
    runMigrations(db);
    expect(() => db.prepare("INSERT INTO human_handoffs (whatsapp_account_id, customer_id, state) VALUES (1, 11, 'BOGUS')").run()).toThrow(/CHECK/);
    expect(() => db.prepare("INSERT INTO human_handoffs (whatsapp_account_id, customer_id, state, source) VALUES (1, 11, 'HUMAN_REQUESTED', 'bogus')").run()).toThrow(/CHECK/);
    const id = Number(db.prepare("INSERT INTO human_handoffs (whatsapp_account_id, customer_id, state) VALUES (1, 11, 'HUMAN_ACTIVE')").run().lastInsertRowid);
    const insert = () => db.prepare("INSERT INTO human_handoff_messages (handoff_id, whatsapp_account_id, client_message_id, staff_admin_id, body) VALUES (?, 1, 'same-id-1234', 2, 'hi')").run(id);
    insert();
    expect(insert).toThrow(/UNIQUE/);
  });
});
