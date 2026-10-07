import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../../src/memory/db';
import {
  listAccounts,
  listEnabledAccounts,
  getAccount,
  createAccount,
  updateAccount,
  setAccountEnabled,
  recordAccountConnected,
  setAccountStatus,
  clearAccountIdentity,
  accountIdsForAdmin,
  canAdminAccessAccount,
  listAccountsForAdmin,
  grantAccountAccess,
  revokeAccountAccess,
  defaultAccountIdForAdmin,
  AccountValidationError,
} from '../../../src/accounts/accountRepo';
import { LEGACY_ACCOUNT_ID } from '../../../src/accounts/accountContext';

let db: Database.Database;
beforeEach(() => {
  db = createTestDb();
});

describe('whatsapp accounts', () => {
  it('a fresh database has exactly one account: the legacy business on the legacy auth directory', () => {
    const accounts = listAccounts(db);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ id: LEGACY_ACCOUNT_ID, authDir: 'baileys-auth', enabled: true, connectionMethod: 'qr', status: 'idle' });
    expect(db.prepare('SELECT id FROM business_settings').all()).toEqual([{ id: 1 }]);
    expect(db.prepare('SELECT id FROM automation_settings').all()).toEqual([{ id: 1 }]);
  });

  it('creates a second business with its own auth directory, profile row and automation row', () => {
    const salon = createAccount({ name: 'Noor Salon', nameAr: 'صالون نور', businessCategory: 'Beauty salon' }, db);
    expect(salon).toMatchObject({ id: 2, name: 'Noor Salon', nameAr: 'صالون نور', businessCategory: 'Beauty salon', authDir: 'accounts/2/baileys-auth', enabled: true, phoneNumber: null });
    expect(db.prepare('SELECT business_name, business_name_ar, business_category FROM business_settings WHERE id = 2').get()).toEqual({
      business_name: 'Noor Salon', business_name_ar: 'صالون نور', business_category: 'Beauty salon',
    });
    expect(db.prepare('SELECT auto_replies_enabled FROM automation_settings WHERE id = 2').get()).toEqual({ auto_replies_enabled: 1 });
    expect(listAccounts(db).map((a) => a.id)).toEqual([1, 2]);
    // The legacy account is untouched.
    expect(getAccount(1, db)!.authDir).toBe('baileys-auth');
  });

  it('validates input', () => {
    expect(() => createAccount({ name: '   ' }, db)).toThrow(AccountValidationError);
    expect(() => createAccount({ name: 'X', connectionMethod: 'sms' }, db)).toThrow(AccountValidationError);
    expect(() => updateAccount(1, { name: '' }, db)).toThrow(AccountValidationError);
    expect(updateAccount(999, { name: 'Ghost' }, db)).toBeUndefined();
  });

  it('renaming an account mirrors the name/category into its business profile and never another account\'s', () => {
    createAccount({ name: 'Noor Salon' }, db);
    updateAccount(2, { name: 'Noor Beauty', nameAr: 'نور', businessCategory: 'Salon' }, db);
    expect(getAccount(2, db)).toMatchObject({ name: 'Noor Beauty', nameAr: 'نور', businessCategory: 'Salon' });
    expect(db.prepare('SELECT business_name, business_category FROM business_settings WHERE id = 2').get()).toEqual({ business_name: 'Noor Beauty', business_category: 'Salon' });
    expect(getAccount(1, db)!.name).toBe('Rowad Alfa Auto Care');
  });

  it('enable/disable flips only the flag; disabled accounts drop out of the enabled list', () => {
    createAccount({ name: 'Noor Salon' }, db);
    expect(setAccountEnabled(2, false, db)!.enabled).toBe(false);
    expect(listEnabledAccounts(db).map((a) => a.id)).toEqual([1]);
    expect(setAccountEnabled(2, true, db)!.enabled).toBe(true);
    expect(setAccountEnabled(77, true, db)).toBeUndefined();
  });

  it('session state is per account: connecting one, logging out one, never touches the other', () => {
    createAccount({ name: 'Noor Salon' }, db);
    recordAccountConnected(1, { phoneNumber: '+966558190545', jid: '966558190545:2@s.whatsapp.net', displayName: 'Rowad' }, db);
    recordAccountConnected(2, { phoneNumber: '+966511111111', jid: '966511111111:3@s.whatsapp.net', displayName: 'Noor' }, db);
    setAccountStatus(2, 'reconnecting', null, db);
    expect(getAccount(1, db)).toMatchObject({ status: 'connected', phoneNumber: '+966558190545' });
    expect(getAccount(2, db)).toMatchObject({ status: 'reconnecting', phoneNumber: '+966511111111' });
    clearAccountIdentity(1, db);
    expect(getAccount(1, db)).toMatchObject({ status: 'logged_out', phoneNumber: null, jid: null });
    expect(getAccount(2, db)).toMatchObject({ phoneNumber: '+966511111111', jid: '966511111111:3@s.whatsapp.net' });
  });

  it('authorization: an admin with no explicit grants sees every account; grants restrict them', () => {
    db.prepare("INSERT INTO admin_users (id, username, password_hash) VALUES (1, 'owner', 'x'), (2, 'agent', 'x')").run();
    createAccount({ name: 'Noor Salon' }, db);
    expect(accountIdsForAdmin(1, db)).toBe('all');
    expect(listAccountsForAdmin(1, db).map((a) => a.id)).toEqual([1, 2]);
    expect(defaultAccountIdForAdmin(1, db)).toBe(1);

    grantAccountAccess(2, 2, 'agent', db);
    expect(accountIdsForAdmin(2, db)).toEqual([2]);
    expect(canAdminAccessAccount(2, 1, db)).toBe(false);
    expect(canAdminAccessAccount(2, 2, db)).toBe(true);
    expect(listAccountsForAdmin(2, db).map((a) => a.id)).toEqual([2]);
    expect(defaultAccountIdForAdmin(2, db)).toBe(2);

    revokeAccountAccess(2, 2, db);
    expect(accountIdsForAdmin(2, db)).toBe('all');
  });
});
