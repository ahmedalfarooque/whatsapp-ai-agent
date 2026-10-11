import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '../../src/memory/db';
import { createAccount } from '../../src/accounts/accountRepo';
import { runWithAccount } from '../../src/accounts/accountContext';
import { getOrCreateCustomer, setCustomerLanguage } from '../../src/memory/customerRepo';
import { createCustomerRequest, getCustomerRequest, listRequestEvents } from '../../src/memory/customerRequestRepo';
import { changeRequestStatus, handleOperatorCommand, parseOperatorCommand } from '../../src/requests/requestService';
import { RequestTransitionError } from '../../src/requests/quotationLifecycle';
import { NotConnectedError, flushOutbox, listOutbox, onOutboxOutcome, registerOutboxSender } from '../../src/notifications/outbox';
import {
  QuotationError, approveQuotation, finalizeVersion, handleQuotationOutcome, markQuotationSentManually, quotationView, rejectQuotation, saveDraft, sendQuotation, sentQuotationSummary,
} from '../../src/quotations/quotationService';
import { saveCustomerFile } from '../../src/files/customerFileRepo';

onOutboxOutcome(handleQuotationOutcome);

const STAFF = { adminId: 7, name: 'Sara' };
let A: number;
let B: number;
let counter = 0;
const delivered: { jid: string; text: string; account: number; attachment?: { fileId: number } }[] = [];

function newQuotation(accountId: number, language: 'en' | 'ar' = 'en') {
  return runWithAccount(accountId, () => {
    const waId = `96568${String(++counter).padStart(7, '0')}`;
    const customer = getOrCreateCustomer(waId, 'Layla');
    setCustomerLanguage(customer.id, language);
    const request = createCustomerRequest({ customerId: customer.id, waId, kind: 'quotation', payload: { name: 'Layla', service: 'Front film', details: '1. Front film' } });
    return { customer, request };
  });
}
const LINES = [{ description: 'Front film', quantity: '2', unitPrice: '150.50' }, { description: 'Side film', quantity: '1', unitPrice: '99' }];
const as = <T>(accountId: number, fn: () => T): T => runWithAccount(accountId, fn);
const status = (id: number) => getCustomerRequest(id, undefined, null)!.status;
/** A flush already in flight when a row is queued does not include it: flush until the queue is quiet (what the periodic flush does in production). */
async function drain(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await flushOutbox();
    await new Promise((r) => setTimeout(r, 5));
  }
}
const customerNotes = (id: number) => listOutbox({ requestId: id, accountId: null }).filter((o) => o.kind === 'customer_status');

beforeAll(() => {
  getDb();
  A = createAccount({ name: 'Quote Shop A' }).id;
  B = createAccount({ name: 'Quote Shop B' }).id;
});
beforeEach(() => {
  getDb().prepare('DELETE FROM notification_outbox').run();
  delivered.length = 0;
  registerOutboxSender(async (jid, text, account, attachment) => {
    delivered.push({ jid, text, account, attachment });
    return `wamid.quote.${delivered.length}`;
  });
});

describe('preparing a quotation', () => {
  it('a draft keeps exactly what staff supplied: totals in minor units, tax on the subtotal, a quote number from the reference', () => {
    const { request } = newQuotation(A);
    const v = as(A, () => saveDraft(request.id, { currency: 'sar', taxRatePercent: '15', validUntil: '2026-12-31', lines: LINES, customerMessage: 'Thank you.', internalNote: 'margin 20%' }, STAFF));
    expect(v).toMatchObject({ version: 1, state: 'draft', currency: 'SAR', subtotal_minor: 40000, tax_rate_bp: 1500, tax_minor: 6000, total_minor: 46000, valid_until: '2026-12-31', quote_number: `${request.reference}-Q1`, prepared_by_name: 'Sara' });
    expect(status(request.id)).toBe('preparing');
    const view = as(A, () => quotationView(request.id));
    expect(view.versions[0]!.lines.map((l) => l.line_total_minor)).toEqual([30100, 9900]);
    expect(view.versions[0]!.preview).toContain('Total: 460.00 SAR');
    expect(view.versions[0]!.preview).not.toContain('margin'); // the internal note is never in what the customer reads
  });

  it('nothing is invented: a line without a price gives no total; a price needs a quantity and a currency', () => {
    const { request } = newQuotation(A);
    const partial = as(A, () => saveDraft(request.id, { currency: 'SAR', lines: [{ description: 'Front film', quantity: '2', unitPrice: '150' }, { description: 'Custom work' }] }, STAFF));
    expect(partial).toMatchObject({ subtotal_minor: null, total_minor: null, tax_minor: null });
    expect(() => as(A, () => saveDraft(request.id, { currency: 'SAR', lines: [{ description: 'x', unitPrice: '5' }] }, STAFF))).toThrow(/needs a quantity/);
    expect(() => as(A, () => saveDraft(request.id, { lines: [{ description: 'x', quantity: '1', unitPrice: '5' }] }, STAFF))).toThrow(/currency/);
    expect(() => as(A, () => saveDraft(request.id, { currency: 'SAR', taxRatePercent: '15', lines: [{ description: 'x' }] }, STAFF))).toThrow(/tax rate needs/);
    expect(() => as(A, () => saveDraft(request.id, { currency: 'SAR', lines: [{ description: 'x', quantity: '1', unitPrice: '5.123' }] }, STAFF))).toThrow(/2 decimals/);
  });

  it('editing the draft replaces its content; a finalised version is frozen and a change is a new version', () => {
    const { request } = newQuotation(A);
    const first = as(A, () => saveDraft(request.id, { currency: 'SAR', lines: LINES }, STAFF));
    const again = as(A, () => saveDraft(request.id, { currency: 'SAR', lines: [LINES[0]!] }, STAFF));
    expect(again.id).toBe(first.id);
    expect(as(A, () => quotationView(request.id)).versions[0]!.lines).toHaveLength(1);
    as(A, () => finalizeVersion(request.id, first.id, STAFF));
    expect(() => as(A, () => finalizeVersion(request.id, first.id, STAFF))).toThrow(QuotationError);
    const second = as(A, () => saveDraft(request.id, { currency: 'SAR', lines: LINES }, STAFF));
    expect(second).toMatchObject({ version: 2, state: 'draft', quote_number: `${request.reference}-Q2` });
    as(A, () => finalizeVersion(request.id, second.id, STAFF));
    const states = as(A, () => quotationView(request.id)).versions.map((v) => [v.version, v.state]);
    expect(states).toEqual([[1, 'superseded'], [2, 'final']]); // history preserved
  });

  it('an empty quotation cannot be finalised', () => {
    const { request } = newQuotation(A);
    const v = as(A, () => saveDraft(request.id, { lines: [] }, STAFF));
    expect(() => as(A, () => finalizeVersion(request.id, v.id, STAFF))).toThrow(/at least one line/);
  });
});

describe('approval is not delivery', () => {
  it('cannot be sent before approval or before a version is final; approving tells the customer once', () => {
    const { request } = newQuotation(A);
    const v = as(A, () => saveDraft(request.id, { currency: 'SAR', lines: LINES }, STAFF));
    expect(() => as(A, () => sendQuotation(request.id, STAFF))).toThrow(/Approve the quotation/);
    const approved = as(A, () => approveQuotation(request.id, STAFF));
    expect(approved.changed).toBe(true);
    expect(status(request.id)).toBe('approved'); // approved, NOT sent
    expect(() => as(A, () => sendQuotation(request.id, STAFF))).toThrow(/Finalise/);
    as(A, () => finalizeVersion(request.id, v.id, STAFF));
    expect(customerNotes(request.id)).toHaveLength(1);
    expect(customerNotes(request.id)[0]!.body).toContain('approved');
    expect(as(A, () => approveQuotation(request.id, STAFF)).changed).toBe(false); // repeating changes nothing
    expect(customerNotes(request.id)).toHaveLength(1);
    expect(listRequestEvents(request.id).find((e) => e.new_status === 'approved')).toMatchObject({ admin_user_id: 7, actor: 'dashboard', actor_detail: 'Sara' });
  });

  it('Sent is never a button: no dashboard, operator or API status change can set it', () => {
    const { request } = newQuotation(A);
    as(A, () => approveQuotation(request.id, STAFF));
    expect(() => changeRequestStatus(request.id, 'sent', { type: 'dashboard' }, undefined, null)).toThrow(RequestTransitionError);
    expect(status(request.id)).toBe('approved');
    expect(handleOperatorCommand({ status: 'sent' as never, reference: request.reference }, 'op', undefined, A).text).toContain('Sent only when');
  });

  it('rejecting needs a reason, notifies the customer once and is final', () => {
    const { request } = newQuotation(A);
    expect(() => as(A, () => rejectQuotation(request.id, ' ', STAFF))).toThrow(/reason/);
    as(A, () => rejectQuotation(request.id, 'Out of our scope', STAFF));
    expect(status(request.id)).toBe('rejected');
    expect(listRequestEvents(request.id).find((e) => e.new_status === 'rejected')?.reason).toBe('Out of our scope');
    expect(customerNotes(request.id).map((n) => n.body).join('\n')).toMatch(/not approved/);
    expect(() => changeRequestStatus(request.id, 'pending', { type: 'dashboard' }, undefined, null)).toThrow(RequestTransitionError);
    expect(() => as(A, () => approveQuotation(request.id, STAFF))).toThrow(RequestTransitionError);
  });

  it('the operator words work: "approve" and the older "confirm" both approve a quotation', () => {
    const one = newQuotation(A).request;
    const two = newQuotation(A).request;
    expect(handleOperatorCommand(parseOperatorCommand(`approve ${one.reference}`)!, 'op', undefined, A).result?.request.status).toBe('approved');
    expect(handleOperatorCommand(parseOperatorCommand(`confirm ${two.reference}`)!, 'op', undefined, A).result?.request.status).toBe('approved');
  });
});

describe('delivery: Sent only when WhatsApp accepted the message', () => {
  async function approvedAndFinal(accountId = A) {
    const { request, customer } = newQuotation(accountId);
    const v = as(accountId, () => saveDraft(request.id, { currency: 'SAR', taxRatePercent: '15', lines: LINES, customerMessage: 'Valid for 7 days' }, STAFF));
    as(accountId, () => finalizeVersion(request.id, v.id, STAFF));
    as(accountId, () => approveQuotation(request.id, STAFF));
    return { request, customer, version: v };
  }

  it('queues one delivery, stays Approved until it is delivered, then becomes Sent with the real outcome recorded', async () => {
    const { request, version } = await approvedAndFinal();
    // The sender is slow: while WhatsApp has not accepted the message the request must still read Approved.
    let accept!: (id: string) => void;
    registerOutboxSender((jid, text, account, attachment) => new Promise<string>((resolve) => { delivered.push({ jid, text, account, attachment }); accept = resolve; }));
    const out = as(A, () => sendQuotation(request.id, STAFF));
    expect(out.alreadyQueued).toBe(false);
    expect(out.outbox).toMatchObject({ kind: 'customer_quotation', status: 'pending' });
    expect(status(request.id)).toBe('approved'); // queued, in flight: not sent
    await new Promise((r) => setTimeout(r, 20));
    expect(status(request.id)).toBe('approved'); // still not accepted
    accept('wamid.quote.1');
    await drain();
    const sent = delivered.find((d) => d.text.includes(`${request.reference}-Q1`))!;
    expect(sent.text).toContain('Total: 460.00 SAR');
    expect(sent.text).toContain('Valid for 7 days');
    expect(sent.text).not.toMatch(/\{[a-z]+\}/);
    expect(status(request.id)).toBe('sent');
    const v = as(A, () => quotationView(request.id)).versions[0]!;
    expect(v.sent_at).toBeTruthy();
    expect(v.id).toBe(version.id);
    const sentEvent = listRequestEvents(request.id).find((e) => e.new_status === 'sent')!;
    expect(sentEvent).toMatchObject({ actor: 'system' });
    expect(sentEvent.reason).toContain('wamid.quote.');
    // the customer is told by the quotation itself, not by a second "your status changed" message
    expect(customerNotes(request.id).filter((n) => n.body.includes('Sent'))).toHaveLength(0);
  });

  it('asking again never queues a second quotation message', async () => {
    const { request } = await approvedAndFinal();
    const first = as(A, () => sendQuotation(request.id, STAFF));
    const again = as(A, () => sendQuotation(request.id, STAFF));
    expect(again.alreadyQueued).toBe(true);
    expect(again.outbox.id).toBe(first.outbox.id);
    await drain();
    await drain();
    expect(delivered.filter((d) => d.text.includes(`${request.reference}-Q1`))).toHaveLength(1);
    expect(() => as(A, () => sendQuotation(request.id, STAFF))).toThrow(/already sent/);
  });

  it('an offline account only defers: the quotation stays queued, the request stays Approved, nothing is marked sent', async () => {
    const { request } = await approvedAndFinal();
    registerOutboxSender(async () => { throw new NotConnectedError(A); });
    as(A, () => sendQuotation(request.id, STAFF));
    await drain();
    expect(status(request.id)).toBe('approved');
    expect(listOutbox({ requestId: request.id, accountId: null }).find((o) => o.kind === 'customer_quotation')).toMatchObject({ status: 'pending' });
    expect(as(A, () => quotationView(request.id)).versions[0]!.sent_at).toBeNull();
    // back online: the same row is delivered, once
    registerOutboxSender(async (jid, text, account, attachment) => { delivered.push({ jid, text, account, attachment }); return 'wamid.later'; });
    getDb().prepare(`UPDATE notification_outbox SET next_attempt_at = datetime('now', '-1 minute') WHERE request_id = ?`).run(request.id);
    await drain();
    expect(status(request.id)).toBe('sent');
  });

  it('a permanent failure is recorded on the request and does NOT mark it sent', async () => {
    const { request } = await approvedAndFinal();
    const { outbox } = as(A, () => sendQuotation(request.id, STAFF));
    handleQuotationOutcome({ ...outbox, status: 'failed', last_error: 'media upload failed' }, 'failed');
    expect(status(request.id)).toBe('approved');
    expect(listRequestEvents(request.id).some((e) => e.reason?.includes('could not be delivered: media upload failed'))).toBe(true);
  });

  it('the attached file travels with the message through the sender', async () => {
    const { request, customer } = newQuotation(A);
    const file = as(A, () => saveCustomerFile({ customerId: customer.id, direction: 'outbound', bytes: Buffer.from('%PDF-1.4 test'), originalName: 'quote.pdf', mimeType: 'application/pdf', uploadedByAdminId: 7 }));
    const v = as(A, () => saveDraft(request.id, { currency: 'SAR', lines: LINES, fileId: file.id }, STAFF));
    as(A, () => finalizeVersion(request.id, v.id, STAFF));
    as(A, () => approveQuotation(request.id, STAFF));
    as(A, () => sendQuotation(request.id, STAFF));
    await drain();
    expect(delivered.find((d) => d.text.includes(`${request.reference}-Q1`))?.attachment).toEqual({ fileId: file.id });
    expect(getDb().prepare('SELECT request_id, quotation_version_id FROM customer_files WHERE id = ?').get(file.id)).toEqual({ request_id: request.id, quotation_version_id: v.id });
  });

  it('staff can record a quotation sent by other means, but only with a reason', async () => {
    const { request } = await approvedAndFinal();
    expect(() => as(A, () => markQuotationSentManually(request.id, '', STAFF))).toThrow(/reason/);
    as(A, () => markQuotationSentManually(request.id, 'Emailed the PDF to the customer', STAFF));
    expect(status(request.id)).toBe('sent');
    expect(listRequestEvents(request.id).find((e) => e.new_status === 'sent')?.reason).toContain('Emailed the PDF');
    expect(delivered.filter((d) => d.text.includes('Quotation'))).toHaveLength(0); // nothing went through WhatsApp
  });

  it('a revision after sending: new version, approve again, delivered again; no second "approved" message to the customer', async () => {
    const { request } = await approvedAndFinal();
    as(A, () => sendQuotation(request.id, STAFF));
    await drain();
    expect(status(request.id)).toBe('sent');
    changeRequestStatus(request.id, 'preparing', { type: 'dashboard', detail: 'Sara' }, undefined, A, { adminUserId: 7, reason: 'Customer asked for a change' });
    const v2 = as(A, () => saveDraft(request.id, { currency: 'SAR', lines: [LINES[0]!] }, STAFF));
    as(A, () => finalizeVersion(request.id, v2.id, STAFF));
    as(A, () => approveQuotation(request.id, STAFF));
    as(A, () => sendQuotation(request.id, STAFF));
    await drain();
    expect(status(request.id)).toBe('sent');
    expect(delivered.filter((d) => d.text.includes(`${request.reference}-Q`))).toHaveLength(2);
    expect(customerNotes(request.id).filter((n) => n.body.includes('approved'))).toHaveLength(1);
    expect(as(A, () => quotationView(request.id)).versions.filter((v) => v.sent_at)).toHaveLength(2);
    expect(as(A, () => sentQuotationSummary(request.id, 'en'))).toContain(`${request.reference}-Q2`);
  });

  it('Arabic customers receive the Arabic quotation', async () => {
    const { request } = newQuotation(A, 'ar');
    const v = as(A, () => saveDraft(request.id, { currency: 'SAR', lines: [LINES[0]!] }, STAFF));
    as(A, () => finalizeVersion(request.id, v.id, STAFF));
    as(A, () => approveQuotation(request.id, STAFF));
    as(A, () => sendQuotation(request.id, STAFF));
    await drain();
    const text = delivered.find((d) => d.text.includes(`${request.reference}-Q1`))!.text;
    expect(text).toContain('الكمية');
    expect(text).toContain('الإجمالي');
  });
});

describe('isolation between businesses', () => {
  it('another business cannot read, approve or send a quotation request it does not own', () => {
    const { request } = newQuotation(A);
    as(A, () => saveDraft(request.id, { currency: 'SAR', lines: LINES }, STAFF));
    expect(() => as(B, () => quotationView(request.id))).toThrow(/not found/);
    expect(() => as(B, () => approveQuotation(request.id, STAFF))).toThrow(/not found/);
    expect(() => as(B, () => saveDraft(request.id, { lines: [] }, STAFF))).toThrow(/not found/);
    expect(status(request.id)).toBe('preparing');
  });

  it('a file of another customer or business cannot be attached', () => {
    const one = newQuotation(A);
    const other = newQuotation(A);
    const file = as(A, () => saveCustomerFile({ customerId: other.customer.id, direction: 'outbound', bytes: Buffer.from('%PDF-1.4 x'), originalName: 'x.pdf', mimeType: 'application/pdf' }));
    expect(() => as(A, () => saveDraft(one.request.id, { fileId: file.id, lines: [] }, STAFF))).toThrow(/cannot be attached/);
    const foreign = as(B, () => saveCustomerFile({ customerId: null, direction: 'outbound', bytes: Buffer.from('%PDF-1.4 y'), originalName: 'y.pdf', mimeType: 'application/pdf' }));
    expect(() => as(A, () => saveDraft(one.request.id, { fileId: foreign.id, lines: [] }, STAFF))).toThrow(/cannot be attached/);
  });
});

describe('appointments are not affected', () => {
  it('keep every old status and transition; the quotation statuses are refused', () => {
    const waId = `96568${String(++counter).padStart(7, '0')}`;
    const c = getOrCreateCustomer(waId, 'Omar');
    const appointment = createCustomerRequest({ customerId: c.id, waId, kind: 'appointment', payload: { name: 'Omar' } });
    expect(changeRequestStatus(appointment.id, 'confirmed', { type: 'dashboard' })?.changed).toBe(true);
    expect(changeRequestStatus(appointment.id, 'pending', { type: 'dashboard' })?.changed).toBe(true);
    expect(() => changeRequestStatus(appointment.id, 'approved', { type: 'dashboard' })).toThrow(RequestTransitionError);
    expect(() => saveDraft(appointment.id, { lines: [] }, STAFF)).toThrow(/Only a quotation/);
  });
});

void vi;
