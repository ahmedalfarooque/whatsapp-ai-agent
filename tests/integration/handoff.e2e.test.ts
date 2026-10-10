import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { getDb } from '../../src/memory/db';
import { createAccount } from '../../src/accounts/accountRepo';
import { runWithAccount } from '../../src/accounts/accountContext';
import { getOrCreateCustomer } from '../../src/memory/customerRepo';
import { appendMessage, getOrCreateActiveConversation } from '../../src/memory/conversationRepo';
import { createSession } from '../../src/dashboard/auth';
import { SESSION_COOKIE_NAME } from '../../src/dashboard/authMiddleware';
import { requestHandoff, getOpenHandoff } from '../../src/handoff/handoffRepo';
import { setStaffSender } from '../../src/dashboard/handoffRoutes';
import { NotConnectedError } from '../../src/notifications/outbox';

/**
 * Human handoff through the real HTTP API: who may see and act, ownership, idempotent replies, honest failures, account isolation.
 * The WhatsApp sender is replaced by a recording fake (a real one needs a live connection); everything else is the real stack.
 */
const OWNER = 'owner@example.com';
const PASSWORD = 'a-very-long-test-password-123';

describe('human handoff API', () => {
  const app = createApp();
  let A: number;
  let B: number;
  let seq = 0;
  const staff: Record<string, number> = {};

  const as = (userId: number) => {
    const cookie = `${SESSION_COOKIE_NAME}=${createSession(userId).token}`;
    const call = (method: 'get' | 'post', url: string, account?: number) => {
      const r = request(app)[method](url).set('Cookie', cookie);
      return account ? r.set('X-Whatsapp-Account', String(account)) : r;
    };
    return { get: (url: string, account?: number) => call('get', url, account), post: (url: string, account?: number) => call('post', url, account) };
  };
  let owner: ReturnType<typeof as>;
  const user = (name: string) => as(staff[name]!);

  const sends: { accountId: number; wa_id: string; reply_jid: string | null; text: string }[] = [];
  let sendBehaviour: (() => Promise<string | null>) | null = null;

  /** A customer of the given account who has already written something, with a waiting handoff. */
  function waiting(account: number, text = 'I need a real person') {
    const waId = `96588${String(++seq).padStart(7, '0')}`;
    const customer = runWithAccount(account, () => getOrCreateCustomer(waId, 'Layla'));
    const conversation = runWithAccount(account, () => getOrCreateActiveConversation(customer.id));
    appendMessage(conversation.id, { role: 'user', content: text, direction: 'inbound' });
    getDb().prepare('UPDATE customers SET reply_jid = ? WHERE id = ?').run(`${waId}@s.whatsapp.net`, customer.id);
    const { handoff } = requestHandoff({ customerId: customer.id, conversationId: conversation.id, source: 'customer' });
    return { waId, customer, conversation, handoff };
  }
  const msgId = () => `msg-${String(++seq).padStart(8, '0')}-test`;

  beforeAll(async () => {
    getDb();
    expect((await request(app).post('/api/dashboard/auth/setup').send({ username: OWNER, password: PASSWORD })).status).toBe(201);
    const ownerId = (getDb().prepare('SELECT id FROM admin_users WHERE username = ?').get(OWNER) as { id: number }).id;
    owner = as(ownerId);
    A = createAccount({ name: 'Handoff API A' }).id;
    B = createAccount({ name: 'Handoff API B' }).id;
    const create = async (key: string, body: Record<string, unknown>) => {
      const res = await owner.post('/api/dashboard/users').send({ password: PASSWORD, ...body });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      staff[key] = res.body.id;
    };
    await create('manager1', { email: 'm1@example.com', role: 'manager', accountIds: [A] });
    await create('manager2', { email: 'm2@example.com', role: 'manager', accountIds: [A] });
    await create('viewer', { email: 'v@example.com', role: 'user', accountIds: [A] });
    await create('lead', { email: 'lead@example.com', role: 'custom', accountIds: [A], permissions: { [A]: { support: 'manage', conversations: 'view' } } });
    await create('blind', { email: 'blind@example.com', role: 'custom', accountIds: [A], permissions: { [A]: { support: 'edit' } } });
    await create('onlyB', { email: 'b@example.com', role: 'manager', accountIds: [B] });
    await create('noSupport', { email: 'ns@example.com', role: 'custom', accountIds: [A], permissions: { [A]: { conversations: 'view', customers: 'view' } } });
  });

  beforeEach(() => {
    sends.length = 0;
    sendBehaviour = null;
    setStaffSender(async (accountId, target, text) => {
      if (sendBehaviour) {
        const id = await sendBehaviour();
        sends.push({ accountId, ...target, text });
        return id;
      }
      sends.push({ accountId, ...target, text });
      return `wa-${sends.length}`;
    });
  });

  describe('seeing the queue', () => {
    it('staff with the support feature see this account\'s handoffs; the Super Admin sees them too', async () => {
      const { handoff } = waiting(A);
      for (const who of [user('manager1'), user('viewer'), user('lead'), owner]) {
        const res = await who.get('/api/dashboard/handoffs', A);
        expect(res.status).toBe(200);
        expect(res.body.handoffs.map((h: { id: number }) => h.id)).toContain(handoff.id);
        expect(res.body.counts.waiting).toBeGreaterThan(0);
      }
      const one = await user('viewer').get(`/api/dashboard/handoffs/${handoff.id}`, A);
      expect(one.status).toBe(200);
      expect(one.body).toMatchObject({ handoff: { id: handoff.id, state: 'HUMAN_REQUESTED', accountId: A }, you: { canAct: false }, customer: { name: 'Layla' } });
      expect(one.body.messages.map((m: { content: string }) => m.content)).toContain('I need a real person');
      expect(one.body.events[0]).toMatchObject({ event: 'requested', actor: 'customer' });
    });

    it('is closed to the unauthenticated and to users without the support feature', async () => {
      const { handoff } = waiting(A);
      expect((await request(app).get('/api/dashboard/handoffs')).status).toBe(401);
      expect((await request(app).post(`/api/dashboard/handoffs/${handoff.id}/accept`)).status).toBe(401);
      expect((await user('noSupport').get('/api/dashboard/handoffs', A)).status).toBe(403);
      expect((await user('noSupport').post(`/api/dashboard/handoffs/${handoff.id}/accept`, A)).status).toBe(403);
    });

    it('support access alone does not open the customer\'s chat: without the conversations permission the history is withheld', async () => {
      const { handoff } = waiting(A);
      const res = await user('blind').get(`/api/dashboard/handoffs/${handoff.id}`, A);
      expect(res.status).toBe(200);
      expect(res.body.messages).toBeNull();
      expect(res.body.you.canSeeConversation).toBe(false);
    });
  });

  describe('accepting, ownership and permissions', () => {
    it('only staff with edit rights can accept; a view-only user gets 403 and nothing changes', async () => {
      const { handoff } = waiting(A);
      expect((await user('viewer').post(`/api/dashboard/handoffs/${handoff.id}/accept`, A)).status).toBe(403);
      expect(getOpenHandoff(handoff.customerId)?.state).toBe('HUMAN_REQUESTED');
      const ok = await user('manager1').post(`/api/dashboard/handoffs/${handoff.id}/accept`, A);
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ ok: true, changed: true, handoff: { state: 'HUMAN_ACTIVE', assignedAdminId: staff.manager1 }, you: { owns: true } });
    });

    it('a second person pressing Accept is told it is taken; the owner pressing it again is a harmless no-op', async () => {
      const { handoff } = waiting(A);
      await user('manager1').post(`/api/dashboard/handoffs/${handoff.id}/accept`, A);
      const other = await user('manager2').post(`/api/dashboard/handoffs/${handoff.id}/accept`, A);
      expect(other.status).toBe(409);
      expect(other.body.code).toBe('owned_by_other');
      const again = await user('manager1').post(`/api/dashboard/handoffs/${handoff.id}/accept`, A);
      expect(again.status).toBe(200);
      expect(again.body.changed).toBe(false);
    });

    it('two people accepting at the same moment: exactly one wins', async () => {
      const { handoff } = waiting(A);
      const results = await Promise.all([user('manager1'), user('manager2'), user('lead')].map((u) => u.post(`/api/dashboard/handoffs/${handoff.id}/accept`, A)));
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    });

    it('a handoff id that does not exist, or is not a number, is rejected cleanly', async () => {
      expect((await user('manager1').post('/api/dashboard/handoffs/987654/accept', A)).status).toBe(404);
      expect((await user('manager1').get('/api/dashboard/handoffs/abc', A)).status).toBe(400);
      expect((await user('manager1').post('/api/dashboard/handoffs/0/accept', A)).status).toBe(400);
    });
  });

  describe('replying to the customer', () => {
    async function active(account = A) {
      const w = waiting(account);
      await user('manager1').post(`/api/dashboard/handoffs/${w.handoff.id}/accept`, account);
      return w;
    }

    it('the owner\'s reply is sent through the account\'s connection once, to this customer, and appears in the conversation as staff', async () => {
      const w = await active();
      const res = await user('manager1').post(`/api/dashboard/handoffs/${w.handoff.id}/reply`, A).send({ text: '  Hello Layla, how can I help?  ', clientMessageId: msgId() });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, status: 'sent', duplicate: false });
      expect(sends).toEqual([{ accountId: A, wa_id: w.waId, reply_jid: `${w.waId}@s.whatsapp.net`, text: 'Hello Layla, how can I help?' }]);
      const view = await user('manager1').get(`/api/dashboard/handoffs/${w.handoff.id}`, A);
      expect(view.body.messages.at(-1)).toMatchObject({ role: 'assistant', staff: true, content: 'Hello Layla, how can I help?' });
      const conversation = await owner.get(`/api/dashboard/conversations/${w.conversation.id}`, A);
      expect(conversation.body.messages.at(-1)).toMatchObject({ staff: true });
      expect(conversation.body.handoff).toMatchObject({ id: w.handoff.id, state: 'HUMAN_ACTIVE' });
    });

    it('a retry, double click or refresh with the same message id delivers exactly ONE message', async () => {
      const w = await active();
      const id = msgId();
      const first = await user('manager1').post(`/api/dashboard/handoffs/${w.handoff.id}/reply`, A).send({ text: 'One', clientMessageId: id });
      const second = await user('manager1').post(`/api/dashboard/handoffs/${w.handoff.id}/reply`, A).send({ text: 'One', clientMessageId: id });
      expect(first.body.duplicate).toBe(false);
      expect(second.status).toBe(200);
      expect(second.body).toMatchObject({ duplicate: true, messageId: first.body.messageId });
      expect(sends).toHaveLength(1);
      const stored = getDb().prepare(`SELECT COUNT(*) AS n FROM conversation_messages WHERE conversation_id = ? AND content = 'One'`).get(w.conversation.id);
      expect(stored).toEqual({ n: 1 });
    });

    it('five identical requests at the same moment send once (the others are refused as already in progress or reported as duplicates)', async () => {
      const w = await active();
      const id = msgId();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      sendBehaviour = async () => { await gate; return 'wa-slow'; };
      const requests = Array.from({ length: 5 }, () => user('manager1').post(`/api/dashboard/handoffs/${w.handoff.id}/reply`, A).send({ text: 'Burst', clientMessageId: id }).then((r) => r));
      await vi.waitFor(() => expect(getDb().prepare('SELECT COUNT(*) AS n FROM human_handoff_messages WHERE handoff_id = ?').get(w.handoff.id)).toEqual({ n: 1 }));
      release();
      const results = await Promise.all(requests);
      expect(sends).toHaveLength(1);
      expect(results.filter((r) => r.status === 200 && r.body.duplicate === false)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409 || (r.status === 200 && r.body.duplicate === true))).toHaveLength(4);
    });

    it('a send that fails is reported honestly (nothing is recorded as sent) and can be retried with the same id', async () => {
      const w = await active();
      const id = msgId();
      sendBehaviour = async () => { throw new Error('socket exploded'); };
      const failed = await user('manager1').post(`/api/dashboard/handoffs/${w.handoff.id}/reply`, A).send({ text: 'Will fail', clientMessageId: id });
      expect(failed.status).toBe(502);
      expect(JSON.stringify(failed.body)).not.toMatch(/socket exploded|stack/i);
      expect(getDb().prepare('SELECT status FROM human_handoff_messages WHERE handoff_id = ?').get(w.handoff.id)).toEqual({ status: 'failed' });
      expect(getDb().prepare(`SELECT COUNT(*) AS n FROM conversation_messages WHERE content = 'Will fail'`).get()).toEqual({ n: 0 });
      sendBehaviour = null;
      const retried = await user('manager1').post(`/api/dashboard/handoffs/${w.handoff.id}/reply`, A).send({ text: 'Will fail', clientMessageId: id });
      expect(retried.status).toBe(200);
      expect(retried.body.status).toBe('sent');
      expect(sends).toHaveLength(1);
      expect(getDb().prepare('SELECT status FROM human_handoff_messages WHERE handoff_id = ?').get(w.handoff.id)).toEqual({ status: 'sent' });
    });

    it('a disconnected WhatsApp number is reported as such (503) and nothing is claimed as delivered', async () => {
      const w = await active();
      sendBehaviour = async () => { throw new NotConnectedError(A); };
      const res = await user('manager1').post(`/api/dashboard/handoffs/${w.handoff.id}/reply`, A).send({ text: 'Anyone?', clientMessageId: msgId() });
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('not_connected');
      expect(getDb().prepare(`SELECT COUNT(*) AS n FROM conversation_messages WHERE content = 'Anyone?'`).get()).toEqual({ n: 0 });
    });

    it('is refused for anyone but the owner (or a manager), before accepting, after resolving, and without conversation access', async () => {
      const waitingOne = waiting(A);
      const early = await user('manager1').post(`/api/dashboard/handoffs/${waitingOne.handoff.id}/reply`, A).send({ text: 'too early', clientMessageId: msgId() });
      expect(early.status).toBe(409);

      const w = await active();
      const send = (who: string, text = 'hi there') => user(who).post(`/api/dashboard/handoffs/${w.handoff.id}/reply`, A).send({ text, clientMessageId: msgId() });
      expect((await send('manager2')).status).toBe(403); // another staff member's conversation
      expect((await send('viewer')).status).toBe(403); // view-only
      expect((await send('blind')).status).toBe(403); // can act on support but cannot read the chat it answers
      expect((await send('onlyB')).status).toBe(403); // no access to this account at all
      expect(sends).toHaveLength(0);
      expect((await send('lead', 'a manager steps in')).status).toBe(200); // manage level may speak in another's conversation
      expect(sends).toHaveLength(1);

      await user('manager1').post(`/api/dashboard/handoffs/${w.handoff.id}/resolve`, A);
      expect((await send('manager1', 'after resolve')).status).toBe(409);
    });

    it('validates the message: not empty, not too long, needs a proper message id; the body of other fields is ignored', async () => {
      const w = await active();
      const post = (body: Record<string, unknown>) => user('manager1').post(`/api/dashboard/handoffs/${w.handoff.id}/reply`, A).send(body);
      expect((await post({ text: '   ', clientMessageId: msgId() })).status).toBe(400);
      expect((await post({ text: 'x'.repeat(4001), clientMessageId: msgId() })).status).toBe(400);
      expect((await post({ text: 'hello', clientMessageId: 'short' })).status).toBe(400);
      expect((await post({ text: 'hello' })).status).toBe(400);
      expect((await post({ text: { not: 'a string' }, clientMessageId: msgId() })).status).toBe(400);
      expect((await post({ text: 'hello', clientMessageId: msgId(), accountId: B, to: '966500000000' })).status).toBe(200);
      expect(sends).toEqual([expect.objectContaining({ accountId: A, text: 'hello', wa_id: w.waId })]); // a customer or account named in the body is never used
    });
  });

  describe('resolving and returning to the AI', () => {
    it('the owner resolves; the conversation stays held until it is explicitly returned; then the customer is free', async () => {
      const w = waiting(A);
      await user('manager1').post(`/api/dashboard/handoffs/${w.handoff.id}/accept`, A);
      expect((await user('manager2').post(`/api/dashboard/handoffs/${w.handoff.id}/resolve`, A)).status).toBe(403);
      expect((await user('manager1').post(`/api/dashboard/handoffs/${w.handoff.id}/resolve`, A)).body).toMatchObject({ changed: true, handoff: { state: 'RESOLVED' } });
      expect((await user('manager1').post(`/api/dashboard/handoffs/${w.handoff.id}/resolve`, A)).body.changed).toBe(false);
      expect(getOpenHandoff(w.customer.id)?.state).toBe('RESOLVED');
      expect((await user('viewer').post(`/api/dashboard/handoffs/${w.handoff.id}/return-to-ai`, A)).status).toBe(403);
      const back = await user('manager2').post(`/api/dashboard/handoffs/${w.handoff.id}/return-to-ai`, A);
      expect(back.status).toBe(200);
      expect(back.body.handoff.state).toBe('AI_ACTIVE');
      expect(getOpenHandoff(w.customer.id)).toBeNull();
      expect((await user('manager2').get('/api/dashboard/handoffs?state=resolved', A)).body.handoffs.map((h: { id: number }) => h.id)).not.toContain(w.handoff.id);
    });

    it('a manager-level user may release a conversation another person owns; an ordinary editor may not', async () => {
      const w = waiting(A);
      await user('manager1').post(`/api/dashboard/handoffs/${w.handoff.id}/accept`, A);
      expect((await user('manager2').post(`/api/dashboard/handoffs/${w.handoff.id}/return-to-ai`, A)).status).toBe(403);
      expect((await user('lead').post(`/api/dashboard/handoffs/${w.handoff.id}/return-to-ai`, A)).status).toBe(200);
    });

    it('the audit trail records who did every step', async () => {
      const w = waiting(A);
      await user('manager1').post(`/api/dashboard/handoffs/${w.handoff.id}/accept`, A);
      await user('manager1').post(`/api/dashboard/handoffs/${w.handoff.id}/resolve`, A);
      await user('lead').post(`/api/dashboard/handoffs/${w.handoff.id}/return-to-ai`, A);
      const view = await owner.get(`/api/dashboard/handoffs/${w.handoff.id}`, A);
      expect(view.body.events.map((e: { event: string; actorAdminId: number | null }) => [e.event, e.actorAdminId])).toEqual([
        ['requested', null], ['accepted', staff.manager1], ['resolved', staff.manager1], ['returned_to_ai', staff.lead],
      ]);
    });
  });

  describe('taking over a conversation the customer did not hand over', () => {
    it('creates an active handoff for the caller; a second person is refused; permissions apply', async () => {
      const customer = runWithAccount(A, () => getOrCreateCustomer(`96599${String(++seq).padStart(7, '0')}`, 'Omar'));
      expect((await user('viewer').post(`/api/dashboard/customers/${customer.id}/take-over`, A)).status).toBe(403);
      const ok = await user('manager1').post(`/api/dashboard/customers/${customer.id}/take-over`, A);
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ ok: true, changed: true, state: 'HUMAN_ACTIVE' });
      expect((await user('manager2').post(`/api/dashboard/customers/${customer.id}/take-over`, A)).status).toBe(409);
      expect((await user('manager1').post(`/api/dashboard/customers/${customer.id}/take-over`, A)).body.changed).toBe(false);
    });

    it('cannot reach a customer of another account', async () => {
      const foreign = runWithAccount(B, () => getOrCreateCustomer(`96599${String(++seq).padStart(7, '0')}`, 'Elsewhere'));
      expect((await user('manager1').post(`/api/dashboard/customers/${foreign.id}/take-over`, A)).status).toBe(404);
      expect((await user('manager1').post(`/api/dashboard/customers/${foreign.id}/take-over`, B)).status).toBe(403); // no access to B
      expect(getOpenHandoff(foreign.id)).toBeNull();
    });

    it('the older pause / resume endpoints run through the same ownership rules', async () => {
      const customer = runWithAccount(A, () => getOrCreateCustomer(`96599${String(++seq).padStart(7, '0')}`, 'Old API'));
      expect((await user('manager1').post(`/api/dashboard/customers/${customer.id}/pause`, A)).status).toBe(200);
      expect(getOpenHandoff(customer.id)).toMatchObject({ state: 'HUMAN_ACTIVE', assignedAdminId: staff.manager1 });
      expect((await user('manager2').post(`/api/dashboard/customers/${customer.id}/resume`, A)).status).toBe(403);
      expect((await user('manager1').post(`/api/dashboard/customers/${customer.id}/resume`, A)).status).toBe(200);
      expect(getOpenHandoff(customer.id)).toBeNull();
      expect((await user('viewer').post(`/api/dashboard/customers/${customer.id}/pause`, A)).status).toBe(403);
    });
  });

  describe('account isolation', () => {
    it('a user of another account cannot see, accept, reply to, resolve or read the history of this account\'s handoffs — by header, by query, or by guessing the id', async () => {
      const w = waiting(A);
      const intruder = user('onlyB');
      expect((await intruder.get('/api/dashboard/handoffs', A)).status).toBe(403);
      expect((await intruder.get(`/api/dashboard/handoffs?account=${A}`)).status).toBe(403);
      for (const path of ['', '/accept', '/resolve', '/return-to-ai', '/reply']) {
        const url = `/api/dashboard/handoffs/${w.handoff.id}${path}`;
        const res = path === '' ? await intruder.get(url, A) : await intruder.post(url, A).send({ text: 'x', clientMessageId: msgId() });
        expect(res.status, url).toBe(403);
      }
      // with their OWN account selected, the id simply does not exist there
      expect((await intruder.get(`/api/dashboard/handoffs/${w.handoff.id}`, B)).status).toBe(404);
      expect((await intruder.post(`/api/dashboard/handoffs/${w.handoff.id}/accept`, B)).status).toBe(404);
      expect((await intruder.post(`/api/dashboard/handoffs/${w.handoff.id}/reply`, B).send({ text: 'x', clientMessageId: msgId() })).status).toBe(404);
      expect((await intruder.get('/api/dashboard/handoffs', B)).body.handoffs.map((h: { id: number }) => h.id)).not.toContain(w.handoff.id);
      expect(sends).toHaveLength(0);
      expect(getOpenHandoff(w.customer.id)?.state).toBe('HUMAN_REQUESTED');
    });

    it('even the Super Admin acts inside the account it selected: a handoff of account A is not found under account B', async () => {
      const w = waiting(A);
      expect((await owner.get(`/api/dashboard/handoffs/${w.handoff.id}`, B)).status).toBe(404);
      expect((await owner.get(`/api/dashboard/handoffs/${w.handoff.id}`, A)).status).toBe(200);
    });
  });
});
