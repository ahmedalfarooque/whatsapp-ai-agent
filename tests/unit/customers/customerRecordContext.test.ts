import { describe, expect, it } from 'vitest';
import { getDb } from '../../../src/memory/db';
import { createAccount } from '../../../src/accounts/accountRepo';
import { runWithAccount } from '../../../src/accounts/accountContext';
import { getOrCreateCustomer } from '../../../src/memory/customerRepo';
import { appendMessage, getOrCreateActiveConversation } from '../../../src/memory/conversationRepo';
import { customerRecordSection } from '../../../src/customers/customerRecordContext';
import { buildSystemPrompt } from '../../../src/llm/buildSystemPrompt';
import { addNote } from '../../../src/customers/customerProfile';

/**
 * The verified customer record that goes into the assistant's prompt: the right customer, the right business, older conversations too,
 * dated and in the customer's own words; requests with their status; no internal staff notes; nothing about anyone else.
 */
const KB = { sections: [], asPromptText: '' };
const old = (id: number, when: string) => getDb().prepare('UPDATE conversation_messages SET created_at = ? WHERE id = ?').run(when, id);

const addRequest =(accountId: number, customer: { id: number; wa_id: string }, reference: string, kind: string, status: string, payload = '{}') =>
  getDb().prepare('INSERT INTO customer_requests (whatsapp_account_id, customer_id, wa_id, reference, kind, status, payload, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(accountId, customer.id, customer.wa_id, reference, kind, status, payload, 'menu');

function seed(accountId: number, wa: string, name: string) {
  return runWithAccount(accountId, () => {
    const customer = getOrCreateCustomer(wa, name);
    const conversation = getOrCreateActiveConversation(customer.id);
    return { customer, conversation };
  });
}

describe('customer record for the prompt', () => {
  it('names the customer, their requests with status, a callback, files, and what they said in OLDER messages — dated, in their own words', () => {
    getDb();
    const a = createAccount({ name: 'Record Shop A' }).id;
    const { customer, conversation } = seed(a, '966511110001', 'Layla');
    runWithAccount(a, () => {
      const m = appendMessage(conversation.id, { role: 'user', content: 'I want a quotation for tinting my Camry', direction: 'inbound', messageType: 'text', whatsappMessageId: 'w1' });
      old(m.id, '2026-08-01 09:00:00');
      appendMessage(conversation.id, { role: 'assistant', content: 'Sure, one moment.', direction: 'outbound' });
      appendMessage(conversation.id, { role: 'user', content: 'hello again', direction: 'inbound', messageType: 'text', whatsappMessageId: 'w2' }); // recent: not an "older" message
    });
    addRequest(a, customer, 'REQ-1001', 'quotation', 'preparing', '{"service":"Window tinting"}');
    getDb().prepare(`INSERT INTO followup_requests (whatsapp_account_id, customer_id, reference, contact_method, status, asap, timezone) VALUES (?, ?, 'CB-9', 'call', 'pending', 1, 'Asia/Riyadh')`).run(a, customer.id);
    getDb().prepare(`INSERT INTO customer_files (whatsapp_account_id, customer_id, direction, kind, original_name, stored_name, status) VALUES (?, ?, 'inbound', 'document', 'camry-registration.pdf', 'stored-1', 'stored')`).run(a, customer.id);
    const text = customerRecordSection(customer.id, 1, undefined, a);
    expect(text).toContain('Layla');
    expect(text).toContain('+966511110001');
    expect(text).toMatch(/REQ-1001 · quotation · status preparing · Window tinting/);
    expect(text).toMatch(/CB-9 · phone call · as soon as possible · status pending/);
    expect(text).toContain('camry-registration.pdf');
    expect(text).toContain('2026-08-01: "I want a quotation for tinting my Camry"'); // the older message, dated
    expect(text).not.toContain('hello again'); // recent messages are the live history, not the record
    expect(text).toMatch(/not recorded/); // the instruction to say so for anything missing
    expect(text.length).toBeLessThan(2600);
  });

  it('never mixes customers or businesses, and never includes internal staff notes', () => {
    const a = createAccount({ name: 'Record Shop B' }).id;
    const b = createAccount({ name: 'Record Shop C' }).id;
    const mine = seed(a, '966511110002', 'Omar');
    const twinElsewhere = seed(b, '966511110002', 'Omar Elsewhere'); // the same phone is a different customer of another business
    const other = seed(a, '966511110003', 'Someone Else');
    addRequest(a, other.customer, 'REQ-OTHER-A', 'appointment', 'pending');
    addRequest(b, twinElsewhere.customer, 'REQ-OTHER-B', 'appointment', 'pending');
    runWithAccount(a, () => addNote(mine.customer.id, { body: 'INTERNAL: difficult customer, offer no discount', followUpAt: null } as never, { adminId: 1, name: 'Staff' }));
    const text = customerRecordSection(mine.customer.id, 1, undefined, a);
    expect(text).not.toMatch(/REQ-OTHER|Someone Else|Omar Elsewhere|INTERNAL|difficult customer/);
    expect(text).toContain('Requests: none recorded.');
    // asking for a customer through the wrong business yields nothing at all
    expect(customerRecordSection(mine.customer.id, 1, undefined, b)).toBe('');
  });

  it('is part of the system prompt only for a known customer, and shrinks with the prompt scale (no older messages in the compact form)', () => {
    const a = createAccount({ name: 'Record Shop D' }).id;
    const { customer, conversation } = seed(a, '966511110004', 'Huda');
    runWithAccount(a, () => { const m = appendMessage(conversation.id, { role: 'user', content: 'What time do you open on Fridays?', direction: 'inbound', messageType: 'text' }); old(m.id, '2026-07-01 08:00:00'); });
    const full = runWithAccount(a, () => buildSystemPrompt(KB, 'en', new Date(), { customerId: customer.id }));
    const compact = runWithAccount(a, () => buildSystemPrompt(KB, 'en', new Date(), { customerId: customer.id, knowledgeScale: 0.3 }));
    const none = runWithAccount(a, () => buildSystemPrompt(KB, 'en', new Date(), {}));
    expect(full).toContain('CUSTOMER RECORD');
    expect(full).toContain('What time do you open on Fridays?');
    expect(compact).toContain('CUSTOMER RECORD');
    expect(compact).not.toContain('What time do you open on Fridays?');
    expect(none).not.toContain('CUSTOMER RECORD');
  });
});
