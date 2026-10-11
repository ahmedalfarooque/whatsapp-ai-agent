import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/memory/db';
import { createAccount } from '../../src/accounts/accountRepo';
import { runWithAccount } from '../../src/accounts/accountContext';
import { updateBusinessSettings } from '../../src/config/businessSettings';
import { getOrCreateCustomer, setCustomerLanguage } from '../../src/memory/customerRepo';
import { createCustomerRequest, getCustomerRequest, listRequestEvents } from '../../src/memory/customerRequestRepo';
import { changeRequestStatus } from '../../src/requests/requestService';
import { flushOutbox, listOutbox, onOutboxOutcome, registerOutboxSender } from '../../src/notifications/outbox';
import { approveQuotation, finalizeVersion, handleQuotationOutcome, listVersions, saveDraft, sendQuotation } from '../../src/quotations/quotationService';
import { dateInTimezone, expireDueQuotations } from '../../src/quotations/quotationExpiry';

onOutboxOutcome(handleQuotationOutcome);

const STAFF = { adminId: 7, name: 'Sara' };
const LINES = [{ description: 'Front film', quantity: '2', unitPrice: '150' }];
// 23:30 UTC on 10 October is already the next day (13:30, 11 October) in Kiritimati, UTC+14.
const NOW = new Date('2026-10-10T23:30:00Z');
let UTC_ACCOUNT: number;
let EARLY_ACCOUNT: number;
let counter = 0;

const as = <T>(accountId: number, fn: () => T): T => runWithAccount(accountId, fn);
const statusOf = (id: number) => getCustomerRequest(id, undefined, null)!.status;
async function drain(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await flushOutbox();
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A quotation that really went through approve → finalise → send → delivered, so it is "sent" with the given validity date. */
async function sentQuotation(accountId: number, validUntil: string | null) {
  const request = as(accountId, () => {
    const waId = `96569${String(++counter).padStart(7, '0')}`;
    const customer = getOrCreateCustomer(waId, 'Layla');
    setCustomerLanguage(customer.id, 'en');
    return createCustomerRequest({ customerId: customer.id, waId, kind: 'quotation', payload: { name: 'Layla', service: 'Front film' } });
  });
  const version = as(accountId, () => saveDraft(request.id, { currency: 'SAR', validUntil, lines: LINES }, STAFF));
  as(accountId, () => approveQuotation(request.id, STAFF));
  as(accountId, () => finalizeVersion(request.id, version.id, STAFF));
  as(accountId, () => sendQuotation(request.id, STAFF));
  await drain();
  expect(statusOf(request.id)).toBe('sent');
  return { request, version };
}

beforeAll(() => {
  getDb();
  UTC_ACCOUNT = createAccount({ name: 'Expiry Shop UTC' }).id;
  EARLY_ACCOUNT = createAccount({ name: 'Expiry Shop Kiritimati' }).id;
  as(UTC_ACCOUNT, () => updateBusinessSettings({ businessTimezone: 'UTC' }));
  as(EARLY_ACCOUNT, () => updateBusinessSettings({ businessTimezone: 'Pacific/Kiritimati' }));
});
beforeEach(() => {
  getDb().prepare('DELETE FROM notification_outbox').run();
  registerOutboxSender(async () => 'wamid.expiry.test');
});

describe('dateInTimezone', () => {
  it('gives the calendar date in the business timezone, not the server date', () => {
    expect(dateInTimezone('UTC', NOW)).toBe('2026-10-10');
    expect(dateInTimezone('Pacific/Kiritimati', NOW)).toBe('2026-10-11');
    expect(dateInTimezone('Pacific/Pago_Pago', NOW)).toBe('2026-10-10');
  });
});

describe('automatic quotation expiry', () => {
  it('expires a sent quotation once its validity date has passed in the business timezone, keeping history and telling nobody', async () => {
    const { request, version } = await sentQuotation(EARLY_ACCOUNT, '2026-10-10');
    const customerNotesBefore = listOutbox({ requestId: request.id, accountId: null }).filter((o) => o.kind === 'customer_status').length;

    const result = expireDueQuotations(NOW);
    expect(result.expired.map((e) => e.requestId)).toContain(request.id);
    expect(statusOf(request.id)).toBe('expired');

    const event = listRequestEvents(request.id).find((e) => e.new_status === 'expired')!;
    expect(event).toMatchObject({ old_status: 'sent', actor: 'system', actor_detail: 'validity date passed' });
    expect(event.reason).toContain('2026-10-10');
    expect(event.created_at).toBeTruthy(); // the transition is timestamped

    // the delivered version is untouched; its history stays
    const kept = as(EARLY_ACCOUNT, () => listVersions(request.id)).find((v) => v.id === version.id)!;
    expect(kept).toMatchObject({ state: 'final', valid_until: '2026-10-10' });
    expect(kept.sent_at).toBeTruthy();

    // no message to the customer about the expiry
    expect(listOutbox({ requestId: request.id, accountId: null }).filter((o) => o.kind === 'customer_status')).toHaveLength(customerNotesBefore);
  });

  it('the same date has not passed yet where it is still that day', async () => {
    const { request } = await sentQuotation(UTC_ACCOUNT, '2026-10-10'); // 23:30 UTC on the 10th: still valid
    expireDueQuotations(NOW);
    expect(statusOf(request.id)).toBe('sent');
    expireDueQuotations(new Date('2026-10-11T00:00:00Z'));
    expect(statusOf(request.id)).toBe('expired');
  });

  it('is idempotent: running again changes nothing and adds no event or notification', async () => {
    const { request } = await sentQuotation(EARLY_ACCOUNT, '2026-10-01');
    expireDueQuotations(NOW);
    const events = listRequestEvents(request.id).length;
    const outbox = listOutbox({ requestId: request.id, accountId: null }).length;
    const again = expireDueQuotations(NOW);
    expect(again.expired.map((e) => e.requestId)).not.toContain(request.id);
    expect(listRequestEvents(request.id)).toHaveLength(events);
    expect(listOutbox({ requestId: request.id, accountId: null })).toHaveLength(outbox);
  });

  it('never expires a quotation with no date, or with a date that is not a real YYYY-MM-DD date', async () => {
    const none = await sentQuotation(EARLY_ACCOUNT, null);
    const bad = await sentQuotation(EARLY_ACCOUNT, '2026-10-01');
    getDb().prepare('UPDATE quotation_versions SET valid_until = ? WHERE id = ?').run('31/12/2020', bad.version.id);
    const impossible = await sentQuotation(EARLY_ACCOUNT, '2026-10-01');
    getDb().prepare('UPDATE quotation_versions SET valid_until = ? WHERE id = ?').run('2020-02-31', impossible.version.id);
    expireDueQuotations(NOW);
    expect([none, bad, impossible].map((q) => statusOf(q.request.id))).toEqual(['sent', 'sent', 'sent']);
  });

  it('only touches sent quotations: preparing, approved, rejected, cancelled, completed and closed stay as they are', async () => {
    const preparing = as(UTC_ACCOUNT, () => {
      const customer = getOrCreateCustomer(`96569${String(++counter).padStart(7, '0')}`, 'A');
      const r = createCustomerRequest({ customerId: customer.id, waId: customer.wa_id, kind: 'quotation', payload: { name: 'A' } });
      saveDraft(r.id, { currency: 'SAR', validUntil: '2020-01-01', lines: LINES }, STAFF);
      return r;
    });
    const approved = await sentQuotation(UTC_ACCOUNT, '2020-01-01'); // sent first, then moved on below
    const done = await sentQuotation(UTC_ACCOUNT, '2020-01-01');
    const cancelled = await sentQuotation(UTC_ACCOUNT, '2020-01-01');
    as(UTC_ACCOUNT, () => changeRequestStatus(done.request.id, 'completed', { type: 'dashboard' }));
    as(UTC_ACCOUNT, () => changeRequestStatus(cancelled.request.id, 'cancelled', { type: 'dashboard' }));
    as(UTC_ACCOUNT, () => changeRequestStatus(approved.request.id, 'preparing', { type: 'dashboard' })); // staff reopened it: a new version is coming

    expireDueQuotations(NOW);
    expect(statusOf(preparing.id)).toBe('preparing');
    expect(statusOf(approved.request.id)).toBe('preparing');
    expect(statusOf(done.request.id)).toBe('completed');
    expect(statusOf(cancelled.request.id)).toBe('cancelled');
  });

  it('judges the version that was actually delivered, not a later draft', async () => {
    const { request } = await sentQuotation(UTC_ACCOUNT, '2020-01-01');
    // a newer draft with a far-future date exists, but it was never delivered and sending it would first move the request off "sent"
    getDb().prepare(`INSERT INTO quotation_versions (whatsapp_account_id, request_id, customer_id, version, quote_number, state, currency, valid_until, prepared_by_name)
                     SELECT whatsapp_account_id, request_id, customer_id, 2, quote_number || '-X', 'draft', currency, '2099-01-01', 'x' FROM quotation_versions WHERE request_id = ? AND version = 1`).run(request.id);
    expireDueQuotations(NOW);
    expect(statusOf(request.id)).toBe('expired');
  });

  it('works per business: one account\'s timezone never decides another account\'s quotations', async () => {
    const early = await sentQuotation(EARLY_ACCOUNT, '2026-10-10');
    const utc = await sentQuotation(UTC_ACCOUNT, '2026-10-10');
    expireDueQuotations(NOW);
    expect(statusOf(early.request.id)).toBe('expired');
    expect(statusOf(utc.request.id)).toBe('sent');
  });
});
