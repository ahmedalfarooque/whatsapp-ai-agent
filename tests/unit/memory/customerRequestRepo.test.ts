import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../../src/memory/db';
import { getOrCreateCustomer, setCustomerMenuState, getCustomerFlowData, setCustomerReplyJid, getCustomerByWaId } from '../../../src/memory/customerRepo';
import { createCustomerRequest, listCustomerRequests, updateCustomerRequestStatus, countCustomerRequests } from '../../../src/memory/customerRequestRepo';

let db: Database.Database;
beforeEach(() => {
  db = createTestDb();
});

describe('customer_requests — WhatsApp-collected appointment / quotation requests', () => {
  it('creates a pending request with a unique human-readable reference and parses the payload back', () => {
    const c = getOrCreateCustomer('966500000009@s.whatsapp.net', 'Ali', db);
    const r = createCustomerRequest({ customerId: c.id, waId: c.wa_id, kind: 'appointment', payload: { name: 'Ali', make: 'Toyota' } }, db);
    expect(r.reference).toMatch(/^APT-\d{4}-\d{4}$/);
    expect(r.status).toBe('pending');
    expect(r.payload).toEqual({ name: 'Ali', make: 'Toyota' });
    const q = createCustomerRequest({ customerId: c.id, waId: c.wa_id, kind: 'quotation', payload: { vehicle: 'LX' } }, db);
    expect(q.reference).toMatch(/^INQ-\d{4}-\d{4}$/);
    expect(countCustomerRequests('pending', db)).toBe(2);
    expect(listCustomerRequests({ kind: 'quotation' }, db).map((x) => x.id)).toEqual([q.id]);
  });

  it('staff can move a request through statuses; unknown ids return undefined', () => {
    const c = getOrCreateCustomer('966500000009@s.whatsapp.net', 'Ali', db);
    const r = createCustomerRequest({ customerId: c.id, waId: c.wa_id, kind: 'quotation', payload: {} }, db);
    expect(updateCustomerRequestStatus(r.id, 'contacted', db)?.status).toBe('contacted');
    expect(listCustomerRequests({ status: 'pending' }, db)).toHaveLength(0);
    expect(updateCustomerRequestStatus(9999, 'closed', db)).toBeUndefined();
  });
});

describe('customers — guided-menu state and reply address', () => {
  it('stores menu state with flow answers and clears them', () => {
    const c = getOrCreateCustomer('966500000009@s.whatsapp.net', 'Ali', db);
    const stepped = setCustomerMenuState(c.id, 'APPOINTMENT_STEP_2', { name: 'Ali' }, db);
    expect(stepped.menu_state).toBe('APPOINTMENT_STEP_2');
    expect(getCustomerFlowData(stepped)).toEqual({ name: 'Ali' });
    const cleared = setCustomerMenuState(c.id, 'MAIN_MENU', null, db);
    expect(cleared.menu_state).toBe('MAIN_MENU');
    expect(getCustomerFlowData(cleared)).toEqual({});
    expect(getCustomerFlowData({ flow_data: 'not json' })).toEqual({});
  });

  it('remembers the chat address the customer last wrote from (may be an opaque LID)', () => {
    const c = getOrCreateCustomer('966500000009@s.whatsapp.net', 'Ali', db);
    setCustomerReplyJid(c.id, '237374906863661@lid', db);
    expect(getCustomerByWaId('966500000009@s.whatsapp.net', db)?.reply_jid).toBe('237374906863661@lid');
  });
});
