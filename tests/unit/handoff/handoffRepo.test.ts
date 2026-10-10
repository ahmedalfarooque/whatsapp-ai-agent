import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../../../src/memory/db';
import { createAccount } from '../../../src/accounts/accountRepo';
import { runWithAccount } from '../../../src/accounts/accountContext';
import { getOrCreateCustomer, getCustomerById, pauseCustomerAutomation, resumeCustomerAutomation, listPausedCustomers } from '../../../src/memory/customerRepo';
import { getOrCreateActiveConversation } from '../../../src/memory/conversationRepo';
import {
  HandoffError,
  acceptHandoff,
  countHandoffRows,
  customerLeavesHold,
  getHandoff,
  getHandoffEvents,
  getHold,
  getOpenHandoff,
  handoffCounts,
  listHandoffs,
  requestHandoff,
  resolveHandoff,
  returnToAi,
  takeOverCustomer,
} from '../../../src/handoff/handoffRepo';

const ALICE = { type: 'staff' as const, adminId: 11, canManage: false };
const BOB = { type: 'staff' as const, adminId: 12, canManage: false };
const MANAGER = { type: 'staff' as const, adminId: 13, canManage: true };

let A: number; // WhatsApp account 2
let B: number; // WhatsApp account 3
let seq = 0;
const customerOf = (account: number) => runWithAccount(account, () => getOrCreateCustomer(`9665${String(++seq).padStart(8, '0')}`, 'Test Customer'));
const paused = (customerId: number) => (getDb().prepare('SELECT automation_paused AS p FROM customers WHERE id = ?').get(customerId) as { p: number }).p;
const refusal = (fn: () => unknown) => {
  try { fn(); } catch (error) { return error as HandoffError; }
  throw new Error('expected a HandoffError');
};

beforeAll(() => {
  getDb();
  A = createAccount({ name: 'Handoff Test A' }).id;
  B = createAccount({ name: 'Handoff Test B' }).id;
});

describe('creating and persisting a handoff', () => {
  it('a customer request creates ONE HUMAN_REQUESTED handoff for the right account, customer and conversation, and holds the customer', () => {
    const customer = customerOf(A);
    const conversation = runWithAccount(A, () => getOrCreateActiveConversation(customer.id));
    const { handoff, outcome } = requestHandoff({ customerId: customer.id, conversationId: conversation.id, source: 'customer', reason: 'Customer requested a human' });
    expect(outcome).toBe('created');
    expect(handoff).toMatchObject({ accountId: A, customerId: customer.id, conversationId: conversation.id, state: 'HUMAN_REQUESTED', source: 'customer', requestCount: 1, assignedAdminId: null });
    expect(handoff.requestedAt).toBeTruthy();
    expect(getHold(customer.id)?.id).toBe(handoff.id);
    expect(paused(customer.id)).toBe(1); // the older "paused" flag stays in step
  });

  it('is really stored: a fresh read of the database returns the same handoff, with an audit event naming who did what', () => {
    const customer = customerOf(A);
    const { handoff } = requestHandoff({ customerId: customer.id, source: 'menu', reason: 'Customer chose "Talk to staff"' });
    const row = getDb().prepare('SELECT * FROM human_handoffs WHERE id = ?').get(handoff.id);
    expect(row).toMatchObject({ whatsapp_account_id: A, customer_id: customer.id, state: 'HUMAN_REQUESTED', source: 'menu' });
    expect(getHandoffEvents(handoff.id, A)).toEqual([expect.objectContaining({ event: 'requested', from: null, to: 'HUMAN_REQUESTED', actor: 'customer' })]);
  });

  it('repeating the request updates the existing handoff instead of creating more — however often it is repeated', () => {
    const customer = customerOf(A);
    const first = requestHandoff({ customerId: customer.id, source: 'customer' });
    for (let i = 0; i < 25; i += 1) expect(requestHandoff({ customerId: customer.id, source: 'customer' }).outcome).toBe('repeated');
    const rows = getDb().prepare('SELECT id, request_count FROM human_handoffs WHERE customer_id = ?').all(customer.id) as { id: number; request_count: number }[];
    expect(rows).toEqual([{ id: first.handoff.id, request_count: 26 }]);
    expect(getHandoffEvents(first.handoff.id, A)).toHaveLength(1); // repeats are counted, not logged one by one
  });

  it('the database itself refuses a second open handoff for one customer (so even racing requests cannot duplicate)', () => {
    const customer = customerOf(A);
    requestHandoff({ customerId: customer.id, source: 'customer' });
    expect(() => getDb().prepare(`INSERT INTO human_handoffs (whatsapp_account_id, customer_id, state) VALUES (?, ?, 'HUMAN_REQUESTED')`).run(A, customer.id)).toThrow(/UNIQUE/);
  });

  it('keeps no state in memory: nothing but the database is needed to know who is held (survives a restart or reconnect)', () => {
    const customer = customerOf(A);
    const { handoff } = requestHandoff({ customerId: customer.id, source: 'customer' });
    acceptHandoff(handoff.id, ALICE, A);
    // a "new process" knows only the database
    expect(getHold(customer.id)).toMatchObject({ id: handoff.id, state: 'HUMAN_ACTIVE', assignedAdminId: ALICE.adminId });
  });

  it('an unknown customer is refused, not invented', () => {
    expect(refusal(() => requestHandoff({ customerId: 987654, source: 'customer' }))).toMatchObject({ status: 404 });
  });
});

describe('the lifecycle: request → accept → resolve → return to AI', () => {
  it('walks every state, records each step, and releases the customer only on the explicit return', () => {
    const customer = customerOf(A);
    const { handoff } = requestHandoff({ customerId: customer.id, source: 'customer' });

    const accepted = acceptHandoff(handoff.id, ALICE, A);
    expect(accepted).toMatchObject({ changed: true, handoff: { state: 'HUMAN_ACTIVE', assignedAdminId: ALICE.adminId } });
    expect(accepted.handoff.acceptedAt).toBeTruthy();

    const resolved = resolveHandoff(handoff.id, ALICE, A);
    expect(resolved).toMatchObject({ changed: true, handoff: { state: 'RESOLVED', resolvedBy: ALICE.adminId } });
    expect(getHold(customer.id)?.state).toBe('RESOLVED'); // resolved is NOT yet back with the AI
    expect(paused(customer.id)).toBe(1);

    const back = returnToAi(handoff.id, ALICE, A);
    expect(back).toMatchObject({ changed: true, handoff: { state: 'AI_ACTIVE', returnedBy: ALICE.adminId } });
    expect(getHold(customer.id)).toBeNull();
    expect(paused(customer.id)).toBe(0);
    expect(getOpenHandoff(customer.id)).toBeNull();

    expect(getHandoffEvents(handoff.id, A).map((e) => [e.event, e.from, e.to, e.actor, e.actorAdminId])).toEqual([
      ['requested', null, 'HUMAN_REQUESTED', 'customer', null],
      ['accepted', 'HUMAN_REQUESTED', 'HUMAN_ACTIVE', 'staff', ALICE.adminId],
      ['resolved', 'HUMAN_ACTIVE', 'RESOLVED', 'staff', ALICE.adminId],
      ['returned_to_ai', 'RESOLVED', 'AI_ACTIVE', 'staff', ALICE.adminId],
    ]);
  });

  it('after the return, a new request starts a brand-new handoff (history is kept, only one is ever open)', () => {
    const customer = customerOf(A);
    const first = requestHandoff({ customerId: customer.id, source: 'customer' }).handoff;
    returnToAi(first.id, ALICE, A);
    const second = requestHandoff({ customerId: customer.id, source: 'customer' });
    expect(second.outcome).toBe('created');
    expect(second.handoff.id).not.toBe(first.id);
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM human_handoffs WHERE customer_id = ? AND state <> 'AI_ACTIVE'`).get(customer.id)).toEqual({ n: 1 });
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM human_handoffs WHERE customer_id = ?').get(customer.id)).toEqual({ n: 2 });
  });

  it('asking again after a resolution reopens it for staff', () => {
    const customer = customerOf(A);
    const { handoff } = requestHandoff({ customerId: customer.id, source: 'customer' });
    acceptHandoff(handoff.id, ALICE, A);
    resolveHandoff(handoff.id, ALICE, A);
    const again = requestHandoff({ customerId: customer.id, source: 'customer', reason: 'Customer wrote again' });
    expect(again.outcome).toBe('reopened');
    expect(again.handoff).toMatchObject({ id: handoff.id, state: 'HUMAN_REQUESTED', assignedAdminId: null, requestCount: 2 });
  });

  it('enforces the order: cannot resolve before accepting, cannot accept what is resolved', () => {
    const customer = customerOf(A);
    const { handoff } = requestHandoff({ customerId: customer.id, source: 'customer' });
    expect(refusal(() => resolveHandoff(handoff.id, ALICE, A))).toMatchObject({ status: 409, code: 'invalid_state' });
    acceptHandoff(handoff.id, ALICE, A);
    resolveHandoff(handoff.id, ALICE, A);
    expect(refusal(() => acceptHandoff(handoff.id, ALICE, A))).toMatchObject({ status: 409, code: 'invalid_state' });
  });
});

describe('ownership and idempotency', () => {
  it('of two staff accepting the same request exactly one wins; the other is told it is taken', () => {
    const customer = customerOf(A);
    const { handoff } = requestHandoff({ customerId: customer.id, source: 'customer' });
    const first = acceptHandoff(handoff.id, ALICE, A);
    const second = refusal(() => acceptHandoff(handoff.id, BOB, A));
    expect(first.changed).toBe(true);
    expect(second).toMatchObject({ status: 409, code: 'owned_by_other' });
    expect(getHandoff(handoff.id, A).assignedAdminId).toBe(ALICE.adminId);
  });

  it('accepting again as the owner (double click, retry, refresh) changes nothing and logs nothing', () => {
    const customer = customerOf(A);
    const { handoff } = requestHandoff({ customerId: customer.id, source: 'customer' });
    acceptHandoff(handoff.id, ALICE, A);
    const again = acceptHandoff(handoff.id, ALICE, A);
    expect(again.changed).toBe(false);
    expect(getHandoffEvents(handoff.id, A).filter((e) => e.event === 'accepted')).toHaveLength(1);
  });

  it('resolve and return are idempotent too', () => {
    const customer = customerOf(A);
    const { handoff } = requestHandoff({ customerId: customer.id, source: 'customer' });
    acceptHandoff(handoff.id, ALICE, A);
    expect(resolveHandoff(handoff.id, ALICE, A).changed).toBe(true);
    expect(resolveHandoff(handoff.id, ALICE, A).changed).toBe(false);
    expect(returnToAi(handoff.id, ALICE, A).changed).toBe(true);
    expect(returnToAi(handoff.id, ALICE, A).changed).toBe(false);
    expect(getHandoffEvents(handoff.id, A).map((e) => e.event)).toEqual(['requested', 'accepted', 'resolved', 'returned_to_ai']);
  });

  it('only the owner — or someone with manage rights — may resolve or return a conversation another person is handling', () => {
    const customer = customerOf(A);
    const { handoff } = requestHandoff({ customerId: customer.id, source: 'customer' });
    acceptHandoff(handoff.id, ALICE, A);
    expect(refusal(() => resolveHandoff(handoff.id, BOB, A))).toMatchObject({ status: 403, code: 'owned_by_other' });
    expect(refusal(() => returnToAi(handoff.id, BOB, A))).toMatchObject({ status: 403, code: 'owned_by_other' });
    expect(getHandoff(handoff.id, A).state).toBe('HUMAN_ACTIVE');
    expect(resolveHandoff(handoff.id, MANAGER, A).handoff.state).toBe('RESOLVED');
  });

  it('staff may decline a waiting request by returning it, and anyone with edit rights may return a resolved one', () => {
    const waiting = requestHandoff({ customerId: customerOf(A).id, source: 'customer' }).handoff;
    expect(returnToAi(waiting.id, BOB, A).handoff.state).toBe('AI_ACTIVE');
    const customer = customerOf(A);
    const resolved = requestHandoff({ customerId: customer.id, source: 'customer' }).handoff;
    acceptHandoff(resolved.id, ALICE, A);
    resolveHandoff(resolved.id, ALICE, A);
    expect(returnToAi(resolved.id, BOB, A).handoff.state).toBe('AI_ACTIVE');
  });

  it('the customer can leave a waiting or finished handoff (asking for the menu), but never one a person is handling', () => {
    const waitingCustomer = customerOf(A);
    requestHandoff({ customerId: waitingCustomer.id, source: 'customer' });
    expect(customerLeavesHold(waitingCustomer.id)).toBe(true);
    expect(getHold(waitingCustomer.id)).toBeNull();

    const busy = customerOf(A);
    const { handoff } = requestHandoff({ customerId: busy.id, source: 'customer' });
    acceptHandoff(handoff.id, ALICE, A);
    expect(customerLeavesHold(busy.id)).toBe(false);
    expect(getHold(busy.id)?.state).toBe('HUMAN_ACTIVE');
    expect(getHandoffEvents(handoff.id, A).map((e) => e.event)).not.toContain('returned_to_ai');
  });
});

describe('staff-initiated takeover', () => {
  it('takes a customer the assistant is answering: creates an active handoff owned by that staff member', () => {
    const customer = customerOf(A);
    const { handoff, changed } = takeOverCustomer(customer.id, ALICE, A);
    expect(changed).toBe(true);
    expect(handoff).toMatchObject({ state: 'HUMAN_ACTIVE', source: 'staff', assignedAdminId: ALICE.adminId, accountId: A });
    expect(getHold(customer.id)?.id).toBe(handoff.id);
  });

  it('takes over a waiting request (same as accepting), is idempotent for the owner, and refused for a second person', () => {
    const customer = customerOf(A);
    const { handoff } = requestHandoff({ customerId: customer.id, source: 'customer' });
    expect(takeOverCustomer(customer.id, ALICE, A).handoff).toMatchObject({ id: handoff.id, state: 'HUMAN_ACTIVE' });
    expect(takeOverCustomer(customer.id, ALICE, A).changed).toBe(false);
    expect(refusal(() => takeOverCustomer(customer.id, BOB, A))).toMatchObject({ status: 409, code: 'owned_by_other' });
  });

  it('cannot take over a customer of another account', () => {
    const foreign = customerOf(B);
    expect(refusal(() => takeOverCustomer(foreign.id, ALICE, A))).toMatchObject({ status: 404 });
    expect(getHold(foreign.id)).toBeNull();
  });
});

describe('account isolation', () => {
  it('a handoff is only found through its own account — another account gets "not found" for every action', () => {
    const customer = customerOf(A);
    const { handoff } = requestHandoff({ customerId: customer.id, source: 'customer' });
    for (const act of [
      () => getHandoff(handoff.id, B),
      () => getHandoffEvents(handoff.id, B),
      () => acceptHandoff(handoff.id, ALICE, B),
      () => resolveHandoff(handoff.id, ALICE, B),
      () => returnToAi(handoff.id, ALICE, B),
    ]) expect(refusal(act)).toMatchObject({ status: 404, code: 'not_found' });
    expect(getHandoff(handoff.id, A).state).toBe('HUMAN_REQUESTED');
  });

  it('listings and counts contain only the selected account\'s handoffs', () => {
    const a = customerOf(A);
    const b = customerOf(B);
    const ha = requestHandoff({ customerId: a.id, source: 'customer' }).handoff;
    const hb = requestHandoff({ customerId: b.id, source: 'customer' }).handoff;
    const inA = listHandoffs({}, A).map((h) => h.id);
    const inB = listHandoffs({}, B).map((h) => h.id);
    expect(inA).toContain(ha.id);
    expect(inA).not.toContain(hb.id);
    expect(inB).toContain(hb.id);
    expect(inB).not.toContain(ha.id);
    const stored = (state: string, account: number) => (getDb().prepare('SELECT COUNT(*) AS n FROM human_handoffs WHERE whatsapp_account_id = ? AND state = ?').get(account, state) as { n: number }).n;
    expect(handoffCounts(A)).toEqual({ waiting: stored('HUMAN_REQUESTED', A), active: stored('HUMAN_ACTIVE', A), resolved: stored('RESOLVED', A) });
    expect(countHandoffRows(A)).toBeGreaterThan(0);
  });

  it('the same phone number asking two businesses for a person creates two independent handoffs', () => {
    const waId = '966577700001';
    const inA = runWithAccount(A, () => getOrCreateCustomer(waId, 'Same Phone'));
    const inB = runWithAccount(B, () => getOrCreateCustomer(waId, 'Same Phone'));
    const ha = requestHandoff({ customerId: inA.id, source: 'customer' }).handoff;
    expect(getHold(inB.id)).toBeNull();
    const hb = requestHandoff({ customerId: inB.id, source: 'customer' }).handoff;
    expect(ha.id).not.toBe(hb.id);
    acceptHandoff(ha.id, ALICE, A);
    expect(getHandoff(hb.id, B).state).toBe('HUMAN_REQUESTED');
  });

  it('the queue is ordered: waiting (oldest first), then in progress, then resolved; and can be filtered', () => {
    const waiting = requestHandoff({ customerId: customerOf(B).id, source: 'customer' }).handoff;
    const busy = requestHandoff({ customerId: customerOf(B).id, source: 'customer' }).handoff;
    acceptHandoff(busy.id, ALICE, B);
    const done = requestHandoff({ customerId: customerOf(B).id, source: 'customer' }).handoff;
    acceptHandoff(done.id, ALICE, B);
    resolveHandoff(done.id, ALICE, B);
    const states = listHandoffs({}, B).map((h) => h.state);
    const firstActive = states.indexOf('HUMAN_ACTIVE');
    const firstResolved = states.indexOf('RESOLVED');
    expect(states.lastIndexOf('HUMAN_REQUESTED')).toBeLessThan(firstActive);
    expect(states.lastIndexOf('HUMAN_ACTIVE')).toBeLessThan(firstResolved);
    expect(listHandoffs({ states: ['RESOLVED'] }, B).every((h) => h.state === 'RESOLVED')).toBe(true);
    expect(listHandoffs({}, B).find((h) => h.id === waiting.id)).toMatchObject({ customerName: 'Test Customer', state: 'HUMAN_REQUESTED' });
  });
});

describe('compatibility with the older pause / resume and with data from before handoffs existed', () => {
  it('pauseCustomerAutomation now creates a queued handoff, and resumeCustomerAutomation closes it', () => {
    const customer = customerOf(A);
    pauseCustomerAutomation(customer.id, 'asked for human');
    expect(getOpenHandoff(customer.id)).toMatchObject({ state: 'HUMAN_REQUESTED', source: 'staff' });
    expect(runWithAccount(A, () => listPausedCustomers()).map((c) => c.id)).toContain(customer.id);
    expect(resumeCustomerAutomation(customer.id).automation_paused).toBe(0);
    expect(getOpenHandoff(customer.id)).toBeNull();
    expect(getHold(customer.id)).toBeNull();
  });

  it('a customer paused by an older version (flag set, no handoff row) is still held, and is adopted into the queue', () => {
    const customer = customerOf(A);
    getDb().prepare(`UPDATE customers SET automation_paused = 1, paused_at = datetime('now'), pause_reason = 'old pause' WHERE id = ?`).run(customer.id);
    expect(getOpenHandoff(customer.id)).toBeNull();
    const hold = getHold(customer.id);
    expect(hold).toMatchObject({ state: 'HUMAN_REQUESTED', source: 'migrated', reason: 'old pause', accountId: A });
    expect(getOpenHandoff(customer.id)?.id).toBe(hold?.id);
  });

  it('the legacy flag without a handoff is released when the customer leaves', () => {
    const customer = customerOf(A);
    getDb().prepare('UPDATE customers SET automation_paused = 1 WHERE id = ?').run(customer.id);
    expect(customerLeavesHold(customer.id)).toBe(true);
    expect(getCustomerById(customer.id, undefined, null)?.automation_paused).toBe(0);
  });
});
