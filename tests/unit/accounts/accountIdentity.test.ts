import { describe, it, expect, beforeAll } from 'vitest';
import { getDb } from '../../../src/memory/db';
import { createAccount, recordAccountConnected, clearAccountIdentity, findAccountHoldingIdentity, getAccount } from '../../../src/accounts/accountRepo';

describe('one WhatsApp identity belongs to one business', () => {
  let a: number;
  let b: number;
  let c: number;

  beforeAll(() => {
    getDb();
    a = createAccount({ name: 'Identity A' }).id;
    b = createAccount({ name: 'Identity B' }).id;
    c = createAccount({ name: 'Identity C' }).id;
    recordAccountConnected(a, { phoneNumber: '+966511000001', jid: '966511000001:7@s.whatsapp.net', displayName: 'A' });
  });

  it('finds the holder of a number whatever the linked-device suffix, and never the account asking', () => {
    expect(findAccountHoldingIdentity(b, { phoneNumber: '+966511000001', jid: '966511000001:42@s.whatsapp.net' })?.id).toBe(a);
    expect(findAccountHoldingIdentity(b, { phoneNumber: null, jid: '966511000001:3@s.whatsapp.net' })?.id).toBe(a);
    expect(findAccountHoldingIdentity(a, { phoneNumber: '+966511000001', jid: '966511000001:7@s.whatsapp.net' })).toBeNull();
  });

  it('does not match a different number or an unknown identity', () => {
    expect(findAccountHoldingIdentity(b, { phoneNumber: '+966511000002', jid: '966511000002:1@s.whatsapp.net' })).toBeNull();
    expect(findAccountHoldingIdentity(b, { phoneNumber: null, jid: '' })).toBeNull();
  });

  it('matches a LID identity by its user part', () => {
    recordAccountConnected(c, { phoneNumber: null, jid: '123456789012345:2@lid', displayName: null });
    expect(findAccountHoldingIdentity(b, { phoneNumber: null, jid: '123456789012345:9@lid' })?.id).toBe(c);
  });

  it('frees the number when its account is logged out, so the right phone can pair next', () => {
    clearAccountIdentity(a);
    expect(getAccount(a)).toMatchObject({ phoneNumber: null, jid: null, status: 'logged_out' });
    expect(findAccountHoldingIdentity(b, { phoneNumber: '+966511000001', jid: '966511000001:42@s.whatsapp.net' })).toBeNull();
  });
});
