import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../../src/memory/db';
import { getAutomationSettings, updateAutomationSettings, recordReplyActivity, listReplyActivity } from '../../../src/automation/settingsRepo';
import { getOrCreateCustomer, pauseCustomerAutomation, resumeCustomerAutomation, listPausedCustomers, setLastMenuOptions, getLastMenuOptions } from '../../../src/memory/customerRepo';
import { getQrSession, recordQrSessionConnected, clearQrSessionIdentity, setQrSessionStatus } from '../../../src/memory/qrSessionRepo';

let db: Database.Database;
beforeEach(() => { db = createTestDb(); });

describe('automation settings', () => {
  it('defaults to everything enabled and persists partial updates', () => {
    expect(getAutomationSettings(db)).toMatchObject({ autoRepliesEnabled: true, ruleRepliesEnabled: true, aiRepliesEnabled: true });
    const next = updateAutomationSettings({ aiRepliesEnabled: false }, db);
    expect(next).toMatchObject({ autoRepliesEnabled: true, ruleRepliesEnabled: true, aiRepliesEnabled: false });
    expect(getAutomationSettings(db).aiRepliesEnabled).toBe(false);
  });
  it('records and lists reply activity newest first, filterable by kind', () => {
    recordReplyActivity({ channel: 'qr', kind: 'rule', templateKey: 'welcome' }, db);
    recordReplyActivity({ channel: 'qr', kind: 'error', detail: 'boom' }, db);
    const all = listReplyActivity({}, db);
    expect(all).toHaveLength(2);
    expect(all[0]?.kind).toBe('error');
    expect(listReplyActivity({ kind: 'rule' }, db)).toHaveLength(1);
  });
});

describe('customer pause / support queue / menu memory', () => {
  it('pause puts a customer in the queue, resume removes them', () => {
    const c = getOrCreateCustomer('966500000001', 'Ali', db);
    expect(c.automation_paused).toBe(0);
    pauseCustomerAutomation(c.id, 'asked for human', db);
    const queue = listPausedCustomers(db);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ id: c.id, pause_reason: 'asked for human' });
    expect(resumeCustomerAutomation(c.id, db).automation_paused).toBe(0);
    expect(listPausedCustomers(db)).toHaveLength(0);
  });
  it('remembers the last numbered menu options across calls and survives bad JSON', () => {
    const c = getOrCreateCustomer('966500000002', undefined, db);
    expect(getLastMenuOptions(c.id, db)).toEqual([]);
    setLastMenuOptions(c.id, ['a', 'b'], db);
    expect(getLastMenuOptions(c.id, db)).toEqual(['a', 'b']);
    db.prepare('UPDATE customers SET last_menu_options = ? WHERE id = ?').run('{not json', c.id);
    expect(getLastMenuOptions(c.id, db)).toEqual([]);
  });
});

describe('QR session record', () => {
  it('stores the scanned identity and clears it on logout', () => {
    expect(getQrSession(db).status).toBe('idle');
    recordQrSessionConnected({ phoneNumber: '+966558190545', jid: '966558190545@s.whatsapp.net', displayName: 'Rowad' }, db);
    expect(getQrSession(db)).toMatchObject({ status: 'connected', phoneNumber: '+966558190545' });
    setQrSessionStatus('reconnecting', null, db);
    expect(getQrSession(db).phoneNumber).toBe('+966558190545');
    clearQrSessionIdentity(db);
    expect(getQrSession(db)).toMatchObject({ status: 'logged_out', phoneNumber: null, jid: null });
  });
});
