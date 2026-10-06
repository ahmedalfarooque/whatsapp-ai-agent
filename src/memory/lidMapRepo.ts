import type Database from 'better-sqlite3';
import { getDb } from './db';

/** "9665...:12@s.whatsapp.net" -> "9665...@s.whatsapp.net" (device suffix dropped). */
export function canonicalJid(jid: string): string {
  const [user, server] = jid.split('@');
  return `${(user ?? '').split(':')[0]}@${server ?? ''}`;
}

/** Records that a LID chat belongs to a phone number. Idempotent upsert. */
export function rememberLidMapping(lid: string, pn: string, db: Database.Database = getDb()): void {
  if (!lid.endsWith('@lid') || !pn.endsWith('@s.whatsapp.net')) return;
  db.prepare(
    `INSERT INTO whatsapp_lid_map (lid, pn, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(lid) DO UPDATE SET pn = excluded.pn, updated_at = datetime('now')`,
  ).run(canonicalJid(lid), canonicalJid(pn));
}

export function getPnForLid(lid: string, db: Database.Database = getDb()): string | null {
  const row = db.prepare('SELECT pn FROM whatsapp_lid_map WHERE lid = ?').get(canonicalJid(lid)) as { pn: string } | undefined;
  return row?.pn ?? null;
}

export function getLidForPn(pn: string, db: Database.Database = getDb()): string | null {
  const row = db
    .prepare('SELECT lid FROM whatsapp_lid_map WHERE pn = ? ORDER BY updated_at DESC LIMIT 1')
    .get(canonicalJid(pn)) as { lid: string } | undefined;
  return row?.lid ?? null;
}
