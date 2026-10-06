import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getDb } from '../../../src/memory/db';
import { getOrCreateCustomer, setCustomerLanguage, setCustomerReplyJid } from '../../../src/memory/customerRepo';
import { createCustomerRequest, getCustomerRequest, listRequestEvents } from '../../../src/memory/customerRequestRepo';
import { recordQrSessionConnected, clearQrSessionIdentity } from '../../../src/memory/qrSessionRepo';
import {
  changeRequestStatus, notifyBusinessNewRequest, parseOperatorCommand, handleOperatorCommand, customerNotificationJid, businessNotificationJid, requestTemplateVars,
} from '../../../src/requests/requestService';
import { registerOutboxSender, flushOutbox, listOutbox, enqueueNotification, retryNotification, NotConnectedError, outboxSummary } from '../../../src/notifications/outbox';
import { resolveTemplate } from '../../../src/templates/templateRepo';

const db = () => getDb();

function makeRequest(waId = '966500000009', kind: 'appointment' | 'quotation' = 'appointment') {
  const customer = getOrCreateCustomer(waId, 'Ali');
  setCustomerLanguage(customer.id, 'en');
  return { customer, request: createCustomerRequest({ customerId: customer.id, waId, kind, payload: { name: 'Ali', make: 'Toyota', model: 'Camry', year: '2024', service: 'PPF', date: 'Tue 23 Sep', time: '10 AM', notes: 'none' } }) };
}

beforeEach(() => {
  db().prepare('DELETE FROM notification_outbox').run();
  db().prepare('DELETE FROM request_events').run();
  recordQrSessionConnected({ phoneNumber: '+966558190545', jid: '966558190545:2@s.whatsapp.net', displayName: 'Rowad Alfa' });
  registerOutboxSender(null);
});

describe('request status transitions (one source of truth)', () => {
  it('records an audit event and queues exactly one customer message and one staff alert per transition; same status is a no-op', () => {
    const { request, customer } = makeRequest();
    setCustomerReplyJid(customer.id, '237374906863661@lid');
    const first = changeRequestStatus(request.id, 'confirmed', { type: 'dashboard', detail: 'admin#1' })!;
    expect(first.changed).toBe(true);
    expect(first.event).toMatchObject({ old_status: 'pending', new_status: 'confirmed', actor: 'dashboard', actor_detail: 'admin#1' });
    expect(first.notifications.map((n) => n.kind).sort()).toEqual(['business_status', 'customer_status']);
    const toCustomer = first.notifications.find((n) => n.kind === 'customer_status')!;
    expect(toCustomer.target_jid).toBe('237374906863661@lid'); // the chat they wrote from — never rewritten
    expect(toCustomer.body).toBe(resolveTemplate('request_confirmed', 'en', requestTemplateVars(getCustomerRequest(request.id)!, { ...customer, reply_jid: '237374906863661@lid' } as never, 'en')));
    expect(toCustomer.body).toContain(request.reference);
    expect(toCustomer.body).toContain('PPF');
    expect(toCustomer.body).not.toMatch(/\{[a-z]+\}/);

    const again = changeRequestStatus(request.id, 'confirmed', { type: 'dashboard' })!;
    expect(again.changed).toBe(false);
    expect(again.notifications).toHaveLength(0);
    expect(listRequestEvents(request.id)).toHaveLength(1);
    expect(listOutbox({ requestId: request.id })).toHaveLength(2);
  });

  it('flipping back and forth never re-sends the same customer confirmation, but staff see every change', () => {
    const { request } = makeRequest('966500000010');
    changeRequestStatus(request.id, 'confirmed', { type: 'dashboard' });
    changeRequestStatus(request.id, 'pending', { type: 'dashboard' });
    const back = changeRequestStatus(request.id, 'confirmed', { type: 'dashboard' })!;
    expect(back.changed).toBe(true);
    expect(back.notifications.map((n) => n.kind)).toEqual(['business_status']); // customer already told "confirmed" once
    const customerMsgs = listOutbox({ requestId: request.id }).filter((n) => n.kind === 'customer_status');
    expect(customerMsgs).toHaveLength(1);
    expect(listRequestEvents(request.id)).toHaveLength(3);
  });

  it('rejected / cancelled / completed use their own templates in the customer language; pending back-transition sends nothing to the customer', () => {
    const { request, customer } = makeRequest('966500000011');
    setCustomerLanguage(customer.id, 'ar');
    const rej = changeRequestStatus(request.id, 'rejected', { type: 'whatsapp', detail: 'op' })!;
    const msg = rej.notifications.find((n) => n.kind === 'customer_status')!;
    expect(msg.body).toContain('❌');
    expect(msg.body).toContain(request.reference);
    expect(rej.notifications.some((n) => n.kind === 'business_status')).toBe(false); // operator acted from WhatsApp → no extra staff alert
    expect(changeRequestStatus(request.id, 'pending', { type: 'dashboard' })!.notifications.map((n) => n.kind)).toEqual(['business_status']);
    expect(changeRequestStatus(request.id, 'cancelled', { type: 'dashboard' })!.notifications.find((n) => n.kind === 'customer_status')!.body).toContain('🚫');
    expect(changeRequestStatus(request.id, 'completed', { type: 'system' })!.notifications.find((n) => n.kind === 'customer_status')!.body).toContain('مكتمل');
    expect(changeRequestStatus(9999, 'confirmed', { type: 'dashboard' })).toBeUndefined();
  });

  it('new-request staff alert is idempotent per request and goes to the linked business number (or the configured staff number)', () => {
    const { request } = makeRequest('966500000012');
    const first = notifyBusinessNewRequest(request)!;
    expect(first.kind).toBe('business_new_request');
    expect(first.target_jid).toBe('966558190545@s.whatsapp.net');
    expect(first.body).toContain(`CONFIRM ${request.reference}`);
    expect(first.body).toContain('Vehicle make: Toyota');
    expect(first.body).not.toContain('966500000012'); // customer number is masked
    expect(notifyBusinessNewRequest(request)!.id).toBe(first.id);
    expect(listOutbox({ requestId: request.id, status: 'pending' })).toHaveLength(1);
    clearQrSessionIdentity();
    expect(businessNotificationJid()).toBeNull();
    expect(notifyBusinessNewRequest(request)).toBeNull(); // nothing linked → nothing queued, no crash
  });

  it('customer notification address prefers the last chat address, then a known LID, then the phone JID', () => {
    const c = getOrCreateCustomer('966500000013', 'X');
    expect(customerNotificationJid(c)).toBe('966500000013@s.whatsapp.net');
    setCustomerReplyJid(c.id, '111222333@lid');
    expect(customerNotificationJid({ ...c, reply_jid: '111222333@lid' })).toBe('111222333@lid');
  });
});

describe('operator commands (business account only)', () => {
  it('parses English and Arabic commands, only when the whole message is the command', () => {
    expect(parseOperatorCommand('CONFIRM APT-2026-3777')).toEqual({ status: 'confirmed', reference: 'APT-2026-3777' });
    expect(parseOperatorCommand('  reject inq-2026-0001 ')).toEqual({ status: 'rejected', reference: 'INQ-2026-0001' });
    expect(parseOperatorCommand('تأكيد APT-2026-3777')).toEqual({ status: 'confirmed', reference: 'APT-2026-3777' });
    expect(parseOperatorCommand('إلغاء APT-2026-3777')).toEqual({ status: 'cancelled', reference: 'APT-2026-3777' });
    expect(parseOperatorCommand('Please CONFIRM APT-2026-3777 today')).toBeNull();
    expect(parseOperatorCommand('CONFIRM')).toBeNull();
    expect(parseOperatorCommand('DESTROY APT-2026-3777')).toBeNull();
    expect(parseOperatorCommand('Reply with one of:\nCONFIRM APT-2026-3777')).toBeNull(); // our own alert body never parses as a command
  });

  it('applies the command to the right request, answers the operator, and treats a repeat as already-done (no second customer message)', () => {
    const { request } = makeRequest('966500000014');
    const first = handleOperatorCommand({ status: 'confirmed', reference: request.reference }, 'whatsapp:test');
    expect(first.result?.changed).toBe(true);
    expect(first.text).toContain(request.reference);
    expect(first.text).toContain('Confirmed');
    expect(getCustomerRequest(request.id)!.status).toBe('confirmed');
    const repeat = handleOperatorCommand({ status: 'confirmed', reference: request.reference }, 'whatsapp:test');
    expect(repeat.result?.changed).toBe(false);
    expect(repeat.text).toContain('already');
    expect(listOutbox({ requestId: request.id }).filter((n) => n.kind === 'customer_status')).toHaveLength(1);
    expect(handleOperatorCommand({ status: 'confirmed', reference: 'APT-1999-0000' }, 'whatsapp:test').text).toContain('no such request');
  });
});

describe('notification outbox — delivery, retry, disconnected session', () => {
  it('stays pending while disconnected, delivers after the session comes back, records the message id, and never double-sends', async () => {
    const { request } = makeRequest('966500000015');
    notifyBusinessNewRequest(request);
    registerOutboxSender(async () => { throw new NotConnectedError(); });
    expect(await flushOutbox()).toBe(0);
    let row = listOutbox({ requestId: request.id })[0]!;
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(0); // not-connected is not counted as a failure

    const sender = vi.fn(async () => 'MSG-1');
    registerOutboxSender(sender);
    expect(await flushOutbox()).toBe(0); // next_attempt_at is 30 s away after the not-connected deferral
    db().prepare(`UPDATE notification_outbox SET next_attempt_at = datetime('now', '-1 second')`).run();
    expect(await flushOutbox()).toBe(1);
    row = listOutbox({ requestId: request.id })[0]!;
    expect(row.status).toBe('sent');
    expect(row.message_id).toBe('MSG-1');
    expect(sender).toHaveBeenCalledTimes(1);
    expect(await flushOutbox()).toBe(0);
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it('transient send errors back off and retry; exhausted rows are marked failed and can be retried manually', async () => {
    enqueueNotification({ kind: 'customer_status', targetJid: '1@s.whatsapp.net', body: 'x', dedupeKey: 'k1' });
    expect(enqueueNotification({ kind: 'customer_status', targetJid: '1@s.whatsapp.net', body: 'x', dedupeKey: 'k1' }).created).toBe(false);
    const sender = vi.fn(async () => { throw new Error('boom'); });
    registerOutboxSender(sender);
    for (let i = 0; i < 12; i += 1) {
      db().prepare(`UPDATE notification_outbox SET next_attempt_at = datetime('now', '-1 second')`).run();
      await flushOutbox();
    }
    const row = listOutbox({ status: 'failed' })[0]!;
    expect(row.attempts).toBe(12);
    expect(row.last_error).toBe('boom');
    expect(outboxSummary().failed).toBe(1);
    registerOutboxSender(async () => 'ok-1');
    expect(retryNotification(row.id)).toBe(true);
    expect(await flushOutbox()).toBe(1);
    expect(listOutbox({ status: 'sent' })[0]!.message_id).toBe('ok-1');
  });
});
