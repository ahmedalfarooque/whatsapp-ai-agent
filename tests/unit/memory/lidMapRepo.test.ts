import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../../src/memory/db';
import { canonicalJid, rememberLidMapping, getPnForLid, getLidForPn } from '../../../src/memory/lidMapRepo';

let db: Database.Database;
beforeEach(() => {
  db = createTestDb();
});

describe('whatsapp_lid_map — one customer whichever address WhatsApp uses', () => {
  it('canonicalises device suffixes', () => {
    expect(canonicalJid('966500000009:12@s.whatsapp.net')).toBe('966500000009@s.whatsapp.net');
    expect(canonicalJid('237374906863661@lid')).toBe('237374906863661@lid');
  });

  it('stores and resolves LID → phone in both directions, updating on conflict', () => {
    rememberLidMapping('237374906863661@lid', '966500000009:3@s.whatsapp.net', db);
    expect(getPnForLid('237374906863661@lid', db)).toBe('966500000009@s.whatsapp.net');
    expect(getLidForPn('966500000009@s.whatsapp.net', db)).toBe('237374906863661@lid');
    rememberLidMapping('237374906863661@lid', '966500000010@s.whatsapp.net', db);
    expect(getPnForLid('237374906863661@lid', db)).toBe('966500000010@s.whatsapp.net');
  });

  it('ignores malformed pairs and returns null for unknown LIDs', () => {
    rememberLidMapping('966500000009@s.whatsapp.net', '237374906863661@lid', db);
    rememberLidMapping('1203@g.us', '966500000009@s.whatsapp.net', db);
    expect(getPnForLid('999@lid', db)).toBeNull();
    expect(getLidForPn('966500000009@s.whatsapp.net', db)).toBeNull();
  });
});
