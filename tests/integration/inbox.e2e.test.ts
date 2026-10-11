import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/whatsapp/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/whatsapp/client')>();
  return { ...real, sendTextMessage: vi.fn(), sendInteractiveMessage: vi.fn(), sendImageMessage: vi.fn(), sendDocumentMessage: vi.fn() };
});
vi.mock('../../src/llm/agentLoop', () => ({ runAgentLoop: vi.fn() }));

import { sendTextMessage } from '../../src/whatsapp/client';
import { runAgentLoop } from '../../src/llm/agentLoop';
import { processInboundMessage } from '../../src/pipeline/processInboundMessage';
import { createApp } from '../../src/app';
import { getDb } from '../../src/memory/db';
import { createAccount } from '../../src/accounts/accountRepo';
import { createSession } from '../../src/dashboard/auth';
import { SESSION_COOKIE_NAME } from '../../src/dashboard/authMiddleware';
import { setStaffSender } from '../../src/dashboard/handoffRoutes';

/**
 * The unified inbox through the real HTTP API and the real message pipeline: who may see what, account isolation, search / filters /
 * paging on the server, live updates (revision + incremental thread), and the existing handoff actions working from inbox data.
 */
const OWNER = 'owner@example.com';
const PASSWORD = 'a-very-long-test-password-123';
const KNOWLEDGE = { sections: [], asPromptText: '' };

describe('unified inbox API', () => {
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
  const sent: string[] = [];
  const sends: string[] = [];

  /** A real inbound message through the real pipeline. */
  async function say(account: number, waId: string, text: string, name?: string) {
    sent.length = 0;
    await processInboundMessage({ waId, messageId: `wamid.inbox.${account}.${++seq}`, timestamp: Date.now(), type: 'text', text, accountId: account, contactName: name }, { knowledge: KNOWLEDGE });
    return [...sent];
  }
  const wa = () => `96577${String(++seq).padStart(7, '0')}`;
  const list = async (who: ReturnType<typeof as>, query = '', account = A) => who.get(`/api/dashboard/inbox${query ? `?${query}` : ''}`, account);

  beforeAll(async () => {
    getDb();
    expect((await request(app).post('/api/dashboard/auth/setup').send({ username: OWNER, password: PASSWORD })).status).toBe(201);
    const ownerId = (getDb().prepare('SELECT id FROM admin_users WHERE username = ?').get(OWNER) as { id: number }).id;
    owner = as(ownerId);
    A = createAccount({ name: 'Inbox API A' }).id;
    B = createAccount({ name: 'Inbox API B' }).id;
    const create = async (key: string, body: Record<string, unknown>) => {
      const res = await owner.post('/api/dashboard/users').send({ password: PASSWORD, ...body });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      staff[key] = res.body.id;
    };
    await create('manager1', { email: 'm1@example.com', role: 'manager', accountIds: [A] });
    await create('manager2', { email: 'm2@example.com', role: 'manager', accountIds: [A] });
    await create('readonly', { email: 'ro@example.com', role: 'custom', accountIds: [A], permissions: { [A]: { conversations: 'view' } } });
    await create('presetUser', { email: 'pu@example.com', role: 'user', accountIds: [A] });
    await create('lead', { email: 'lead@example.com', role: 'custom', accountIds: [A], permissions: { [A]: { support: 'manage', conversations: 'view', customers: 'view' } } });
    await create('supportOnly', { email: 'so@example.com', role: 'custom', accountIds: [A], permissions: { [A]: { support: 'edit' } } });
    await create('onlyB', { email: 'b@example.com', role: 'manager', accountIds: [B] });
  });

  beforeEach(() => {
    vi.mocked(sendTextMessage).mockReset().mockImplementation(async (_to, body) => { sent.push(String(body)); return { messaging_product: 'whatsapp', contacts: [], messages: [{ id: 't' }] }; });
    vi.mocked(runAgentLoop).mockReset().mockResolvedValue({ finalText: 'AI answer', generatedMessages: [{ role: 'assistant', content: 'AI answer' }] });
    sends.length = 0;
    setStaffSender(async (_account, _target, text) => { sends.push(text); return `wa-${sends.length}`; });
  });

  describe('access and account isolation', () => {
    it('needs a session and the conversations feature on the selected account', async () => {
      expect((await request(app).get('/api/dashboard/inbox')).status).toBe(401);
      expect((await request(app).get('/api/dashboard/inbox/pulse')).status).toBe(401);
      expect((await list(user('supportOnly'))).status).toBe(403);
      expect((await user('supportOnly').get('/api/dashboard/inbox/pulse', A)).status).toBe(403);
      for (const who of ['readonly', 'presetUser', 'manager1', 'lead']) expect((await list(user(who))).status, who).toBe(200);
      expect((await list(owner)).status).toBe(200);
    });

    it('a user of another account cannot list, poll or open anything of this one — by header, by query string or by guessing a customer id', async () => {
      const waId = wa();
      await say(A, waId, 'hello from account A', 'Private Person');
      const customerId = (getDb().prepare('SELECT id FROM customers WHERE wa_id = ? AND whatsapp_account_id = ?').get(waId, A) as { id: number }).id;
      const intruder = user('onlyB');
      expect((await list(intruder, '', A)).status).toBe(403);
      expect((await intruder.get(`/api/dashboard/inbox?account=${A}`)).status).toBe(403);
      expect((await intruder.get('/api/dashboard/inbox/pulse', A)).status).toBe(403);
      expect((await intruder.get(`/api/dashboard/inbox/customers/${customerId}`, A)).status).toBe(403);
      const own = await intruder.get(`/api/dashboard/inbox/customers/${customerId}`, B);
      expect(own.status).toBe(404);
      expect(JSON.stringify(own.body)).not.toMatch(/Private Person|hello from account A|Inbox API A/);
      expect(JSON.stringify((await list(intruder, '', B)).body)).not.toMatch(/Private Person|hello from account A/);
    });

    it('the same customer id is "not found" in another account, exactly like one that does not exist (nothing to learn)', async () => {
      const waId = wa();
      await say(A, waId, 'hi');
      const customerId = (getDb().prepare('SELECT id FROM customers WHERE wa_id = ? AND whatsapp_account_id = ?').get(waId, A) as { id: number }).id;
      const foreign = await owner.get(`/api/dashboard/inbox/customers/${customerId}`, B);
      const missing = await owner.get('/api/dashboard/inbox/customers/987654', B);
      expect(foreign.status).toBe(404);
      expect(foreign.body).toEqual(missing.body);
      expect((await owner.get('/api/dashboard/inbox/customers/abc', A)).status).toBe(404);
    });

    it('the Super Admin sees each account\'s own inbox, never a mixture', async () => {
      const a = wa();
      const b = wa();
      await say(A, a, 'only in A', 'Mixture Alpha');
      await say(B, b, 'only in B', 'Mixture Beta');
      const inA = JSON.stringify((await list(owner, 'limit=100', A)).body.items);
      const inB = JSON.stringify((await list(owner, 'limit=100', B)).body.items);
      expect(inA).toContain('Mixture Alpha');
      expect(inA).not.toContain('Mixture Beta');
      expect(inB).toContain('Mixture Beta');
      expect(inB).not.toContain('Mixture Alpha');
    });
  });

  describe('what each permission reveals', () => {
    it('without customers access the full number is never sent (a masked one is); without support access staff names and the assignee filter are withheld', async () => {
      const waId = wa();
      await say(A, waId, 'I need a real person', 'Nadia');
      const handoffId = (getDb().prepare("SELECT h.id FROM human_handoffs h JOIN customers c ON c.id = h.customer_id WHERE c.wa_id = ? AND c.whatsapp_account_id = ?").get(waId, A) as { id: number }).id;
      await user('manager1').post(`/api/dashboard/handoffs/${handoffId}/accept`, A);
      const customerId = (getDb().prepare('SELECT id FROM customers WHERE wa_id = ? AND whatsapp_account_id = ?').get(waId, A) as { id: number }).id;

      const ro = await list(user('readonly'), 'q=Nadia');
      expect(ro.body.items).toHaveLength(1);
      expect(JSON.stringify(ro.body)).not.toContain(waId);
      expect(ro.body.items[0].waIdMasked).toBe(`${'*'.repeat(waId.length - 4)}${waId.slice(-4)}`);
      expect(ro.body.items[0].handling).toMatchObject({ state: 'HUMAN_ACTIVE', assignedToName: null, assignedAdminId: null });
      expect(ro.body.you).toMatchObject({ canSeeNumber: false, canSeeStaff: false, canAct: false });
      // filtering by assignee would reveal who handles what: ignored for this user
      expect((await list(user('readonly'), `assignee=${staff.manager1}&q=Nadia`)).body.items).toHaveLength(1);
      expect((await list(user('readonly'), 'assignee=999999&q=Nadia')).body.items).toHaveLength(1);
      const thread = await user('readonly').get(`/api/dashboard/inbox/customers/${customerId}`, A);
      expect(JSON.stringify(thread.body)).not.toContain(waId);
      expect(thread.body.handoff.assignedTo).toBeNull();
      expect(thread.body.handoff.you.canAct).toBe(false);

      const lead = await list(user('lead'), 'q=Nadia');
      expect(lead.body.items[0]).toMatchObject({ waId, handling: { assignedToName: expect.any(String) } });
      expect(lead.body.you).toMatchObject({ canSeeNumber: true, canSeeStaff: true, canAct: true });
      expect((await list(user('lead'), `assignee=${staff.manager1}`)).body.items.map((i: { waId: string }) => i.waId)).toContain(waId);
    });
  });

  describe('listing, search, filters and paging on the server', () => {
    it('new inbound messages create and update the right row; the AI answer becomes the preview; handling follows the handoff', async () => {
      const waId = wa();
      await say(A, waId, 'hi', 'Rania');
      await say(A, waId, '2');
      await say(A, waId, 'what services do you offer?');
      let row = (await list(owner, 'q=Rania')).body.items[0];
      expect(row).toMatchObject({ name: 'Rania', handling: { state: 'AI_ACTIVE' }, needsReply: false, last: { role: 'assistant', preview: 'AI answer' } });
      await say(A, waId, 'I want to speak to a human');
      row = (await list(owner, 'q=Rania')).body.items[0];
      expect(row.handling).toMatchObject({ state: 'HUMAN_REQUESTED', handoffId: expect.any(Number) });
      expect(row.last.role).toBe('assistant'); // the hand-over message
      expect((await list(owner, 'handling=waiting&q=Rania')).body.items).toHaveLength(1);
      expect((await list(owner, 'handling=ai&q=Rania')).body.items).toHaveLength(0);
      await say(A, waId, 'hello? anyone?');
      row = (await list(owner, 'q=Rania')).body.items[0];
      expect(row).toMatchObject({ needsReply: true, last: { role: 'user', preview: 'hello? anyone?' } });
      expect(vi.mocked(runAgentLoop)).toHaveBeenCalledTimes(1); // the assistant stayed silent while the customer waits
    });

    it('server-side search, filters, sorting and paging; the counts; and clamped parameters', async () => {
      for (let i = 0; i < 6; i += 1) await say(A, wa(), `bulk message ${i}`, `Bulk ${String(i).padStart(2, '0')}`);
      const all = await list(owner, 'limit=100');
      expect(all.status).toBe(200);
      expect(all.headers['cache-control']).toBe('no-store');
      const total = all.body.total;
      expect(all.body.items.length).toBe(Math.min(total, 100));
      expect(all.body.counts.all).toBe(total);
      expect((await list(owner, 'q=bulk')).body.total).toBe(6);
      expect((await list(owner, 'q=Bulk 03')).body.items.map((i: { name: string }) => i.name)).toEqual(['Bulk 03']);
      const p1 = await list(owner, 'q=bulk&limit=4&offset=0');
      const p2 = await list(owner, 'q=bulk&limit=4&offset=4');
      expect(p1.body.items).toHaveLength(4);
      expect(p2.body.items).toHaveLength(2);
      expect([...p1.body.items, ...p2.body.items].map((i: { customerId: number }) => i.customerId)).toEqual((await list(owner, 'q=bulk&limit=100')).body.items.map((i: { customerId: number }) => i.customerId));
      expect(p1.body).toMatchObject({ total: 6, limit: 4, offset: 0 });
      // hostile or odd parameters never break the call
      for (const query of ['limit=99999', 'limit=-3', 'offset=-4', 'limit=abc&offset=xyz', 'handling=bogus', 'sort=bogus', 'assignee=bogus', `q=${'x'.repeat(500)}`, 'q=%25', "q='; DROP TABLE customers;--"]) {
        expect((await list(owner, query)).status, query).toBe(200);
      }
      expect((await list(owner, 'limit=99999')).body.limit).toBe(100);
      expect((await list(owner, 'handling=bogus')).body.total).toBe(total);
      expect((await list(owner, 'sort=waiting_first')).status).toBe(200);
      expect(getDb().prepare('SELECT COUNT(*) AS n FROM customers').get()).not.toEqual({ n: 0 });
    });

    it('lists Arabic and English conversations intact and searchable', async () => {
      const waId = wa();
      await say(A, waId, 'السلام عليكم، أريد معرفة الأسعار', 'محمد العتيبي');
      const found = await list(owner, `q=${encodeURIComponent('العتيبي')}`);
      expect(found.body.items).toHaveLength(1);
      expect(found.body.items[0]).toMatchObject({ name: 'محمد العتيبي' });
      const thread = await owner.get(`/api/dashboard/inbox/customers/${found.body.items[0].customerId}`, A);
      expect(thread.body.messages[0]).toMatchObject({ kind: 'customer', content: 'السلام عليكم، أريد معرفة الأسعار' });
    });

    it('an empty account returns an empty, well-formed page', async () => {
      const empty = createAccount({ name: 'Inbox API Empty' }).id;
      const res = await owner.get('/api/dashboard/inbox', empty);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ items: [], total: 0, counts: { all: 0, waiting: 0 } });
      expect(res.body.revision).toBeTypeOf('string');
    });
  });

  describe('the conversation, live updates and the existing handoff actions', () => {
    it('shows every message kind, the connection state, and returns only what is new when asked after a known id', async () => {
      const waId = wa();
      await say(A, waId, 'hi', 'Salma');
      await say(A, waId, '2');
      await say(A, waId, 'tell me something nice');
      const customerId = (getDb().prepare('SELECT id FROM customers WHERE wa_id = ? AND whatsapp_account_id = ?').get(waId, A) as { id: number }).id;
      const first = await owner.get(`/api/dashboard/inbox/customers/${customerId}`, A);
      expect(first.status).toBe(200);
      expect(first.body.customer).toMatchObject({ id: customerId, name: 'Salma', waId });
      expect(first.body.account).toMatchObject({ id: A, name: 'Inbox API A' });
      expect(first.body.connection).toHaveProperty('connected');
      const kinds = first.body.messages.map((m: { kind: string }) => m.kind);
      expect(kinds).toContain('customer');
      expect(kinds).toContain('auto'); // the language/menu templates
      expect(kinds).toContain('ai');
      expect(first.body.messages.every((m: { status: string | null; kind: string }) => m.kind === 'staff' || m.status === null)).toBe(true);

      expect((await owner.get(`/api/dashboard/inbox/customers/${customerId}?after=${first.body.latestId}`, A)).body.messages).toEqual([]);
      await say(A, waId, 'one more question');
      const incremental = await owner.get(`/api/dashboard/inbox/customers/${customerId}?after=${first.body.latestId}`, A);
      expect(incremental.body.messages.map((m: { content: string }) => m.content)).toEqual(['one more question', 'AI answer']);
      const ids = [...first.body.messages, ...incremental.body.messages].map((m: { id: number }) => m.id);
      expect(new Set(ids).size).toBe(ids.length); // no duplicates when the browser merges the two
      const older = await owner.get(`/api/dashboard/inbox/customers/${customerId}?before=${first.body.messages[1].id}&limit=1`, A);
      expect(older.body.messages).toHaveLength(1);
      expect(older.body.messages[0].id).toBe(first.body.messages[0].id);
    });

    it('the pulse changes exactly when something happens in the selected account', async () => {
      const before = (await owner.get('/api/dashboard/inbox/pulse', A)).body;
      expect((await owner.get('/api/dashboard/inbox/pulse', A)).body.revision).toBe(before.revision);
      await say(A, wa(), 'pulse test');
      const after = (await owner.get('/api/dashboard/inbox/pulse', A)).body;
      expect(after.revision).not.toBe(before.revision);
      expect(after.connection).toHaveProperty('phase');
      const otherBefore = (await owner.get('/api/dashboard/inbox/pulse', B)).body.revision;
      await say(A, wa(), 'again');
      expect((await owner.get('/api/dashboard/inbox/pulse', B)).body.revision).toBe(otherBefore);
    });

    it('accept, reply, resolve and return to AI work from inbox data, with ownership: the second person is told it is taken, and a stale tab sees the truth', async () => {
      const waId = wa();
      await say(A, waId, 'I need a real person', 'Huda');
      const row = (await list(owner, 'q=Huda')).body.items[0];
      const customerId = row.customerId;
      const handoffId = row.handling.handoffId;
      expect(row.handling.state).toBe('HUMAN_REQUESTED');

      // two staff members both see "waiting"; one accepts, the other's stale tab tries too
      const m1 = user('manager1');
      const m2 = user('manager2');
      expect((await m1.post(`/api/dashboard/handoffs/${handoffId}/accept`, A)).status).toBe(200);
      const stale = await m2.post(`/api/dashboard/handoffs/${handoffId}/accept`, A);
      expect(stale.status).toBe(409);
      let thread = await m2.get(`/api/dashboard/inbox/customers/${customerId}`, A);
      expect(thread.body.handoff).toMatchObject({ handoff: { state: 'HUMAN_ACTIVE' }, you: { owns: false, canAct: true }, assignedTo: { id: staff.manager1 } });
      expect((await m2.post(`/api/dashboard/handoffs/${handoffId}/reply`, A).send({ text: 'let me in', clientMessageId: `stale-${seq}-aaaa` })).status).toBe(403);
      expect(sends).toEqual([]);

      const reply = await m1.post(`/api/dashboard/handoffs/${handoffId}/reply`, A).send({ text: 'Hello Huda, how can I help?', clientMessageId: `reply-${seq}-bbbb` });
      expect(reply.status).toBe(200);
      expect(sends).toEqual(['Hello Huda, how can I help?']);
      thread = await m1.get(`/api/dashboard/inbox/customers/${customerId}`, A);
      expect(thread.body.messages.at(-1)).toMatchObject({ kind: 'staff', status: 'sent', content: 'Hello Huda, how can I help?', staffAdminId: staff.manager1 });
      expect(thread.body.handoff.you.owns).toBe(true);
      const mid = (await list(owner, 'q=Huda')).body.items[0];
      expect(mid).toMatchObject({ handling: { state: 'HUMAN_ACTIVE', assignedAdminId: staff.manager1 }, last: { role: 'assistant', preview: 'Hello Huda, how can I help?' }, needsReply: false });
      expect((await list(owner, `handling=in_progress&assignee=${staff.manager1}`)).body.items.map((i: { customerId: number }) => i.customerId)).toContain(customerId);

      expect((await m1.post(`/api/dashboard/handoffs/${handoffId}/resolve`, A)).status).toBe(200);
      expect((await list(owner, 'handling=resolved&q=Huda')).body.items).toHaveLength(1);
      expect((await m2.post(`/api/dashboard/handoffs/${handoffId}/return-to-ai`, A)).status).toBe(200);
      expect((await list(owner, 'q=Huda')).body.items[0].handling.state).toBe('AI_ACTIVE');
      await say(A, waId, 'thanks, one more thing');
      expect((await list(owner, 'q=Huda')).body.items[0].last.preview).toBe('AI answer');
    });

    it('taking over from the inbox stops the assistant at once, and a view-only user cannot', async () => {
      const waId = wa();
      await say(A, waId, 'hello', 'Mona');
      const customerId = (await list(owner, 'q=Mona')).body.items[0].customerId;
      expect((await user('readonly').post(`/api/dashboard/customers/${customerId}/take-over`, A)).status).toBe(403);
      expect((await user('manager1').post(`/api/dashboard/customers/${customerId}/take-over`, A)).status).toBe(200);
      vi.mocked(runAgentLoop).mockClear();
      expect(await say(A, waId, 'are you there?')).toEqual([]);
      expect(vi.mocked(runAgentLoop)).not.toHaveBeenCalled();
      expect((await list(owner, 'q=Mona')).body.items[0]).toMatchObject({ handling: { state: 'HUMAN_ACTIVE' }, needsReply: true });
    });
  });
});
