import { describe, it, expect } from 'vitest';
import { jidToPhoneNumber, jidToUser, isDirectChatJid, isGroupJid, isBroadcastJid, normalizeNumerals } from '../../../src/whatsapp/jid';

describe('JID helpers', () => {
  it('extracts the phone number from a device-suffixed user JID', () => {
    expect(jidToPhoneNumber('966558190545:12@s.whatsapp.net')).toBe('+966558190545');
    expect(jidToPhoneNumber('966558190545@s.whatsapp.net')).toBe('+966558190545');
  });
  it('returns null for LID and group identifiers (not phone numbers)', () => {
    expect(jidToPhoneNumber('133264396300517@lid')).toBeNull();
    expect(jidToPhoneNumber('1203@g.us')).toBeNull();
    expect(jidToPhoneNumber(undefined)).toBeNull();
  });
  it('strips server and device suffix', () => {
    expect(jidToUser('966558190545:3@s.whatsapp.net')).toBe('966558190545');
  });
  it('classifies chat types', () => {
    expect(isDirectChatJid('966500000001@s.whatsapp.net')).toBe(true);
    expect(isDirectChatJid('133264396300517@lid')).toBe(true);
    expect(isDirectChatJid('1203@g.us')).toBe(false);
    expect(isGroupJid('1203@g.us')).toBe(true);
    expect(isBroadcastJid('status@broadcast')).toBe(true);
    expect(isDirectChatJid('status@broadcast')).toBe(false);
  });
  it('normalizes Arabic-Indic numerals', () => {
    expect(normalizeNumerals('٢')).toBe('2');
    expect(normalizeNumerals('١٠ items')).toBe('10 items');
    expect(normalizeNumerals('menu')).toBe('menu');
  });
});
