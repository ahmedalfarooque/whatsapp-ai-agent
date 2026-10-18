import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { getDb } from '../../src/memory/db';
import { env } from '../../src/config/env';
import { createAccount } from '../../src/accounts/accountRepo';
import { runWithAccount } from '../../src/accounts/accountContext';
import { createSession } from '../../src/dashboard/auth';
import { SESSION_COOKIE_NAME } from '../../src/dashboard/authMiddleware';
import { explainRoutes, resetAiRouterForTests, routeCompletion } from '../../src/llm/aiRouter';
import { getAccountRouting } from '../../src/llm/routingOrder';
import { getBusinessSettings } from '../../src/config/businessSettings';
import { getOrCreateCustomer } from '../../src/memory/customerRepo';
import { getOrCreateActiveConversation, appendMessage } from '../../src/memory/conversationRepo';
import { openPendingReply, getPendingReply } from '../../src/replay/pendingReplyRepo';

/**
 * Super Admin Settings (the shared AI defaults) and the account AI list, through the real dashboard routes with a stubbed network (these are
 * MOCKED provider calls: they prove routing, order, authorization, masking and isolation — not real inference).
 */
const PASSWORD = 'a-very-long-test-password-123';
const SHARED_KEY = 'gsk_sharedsharedsharedsharedshared000000000000';
const OWN_A_KEY = 'gsk_ownerownerownerownerownerAAAA00000000000';
const OWN_B_KEY = 'gsk_ownerownerownerownerownerBBBB00000000000';
const mutableEnv = env as unknown as Record<string, unknown>;

const ok = (text: string) => new Response(JSON.stringify({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }] }), { status: 200 });
const err = (status: number, message: string) => new Response(JSON.stringify({ error: { message } }), { status });

describe('Super Admin Settings and the account AI list', () => {
  const app = createApp();
  let owner: ReturnType<typeof request.agent>;
  let admin: ReturnType<typeof request.agent>;
  let manager: ReturnType<typeof request.agent>;
  let A: number;
  let B: number;
  const originalFetch = globalThis.fetch;
  const originalMock = env.shouldUseMockProviders;
  const as = (userId: number) => request.agent(app).set('Cookie', `${SESSION_COOKIE_NAME}=${createSession(userId).token}`);
  const asAccount = (agent: ReturnType<typeof request.agent>, id: number) => ({
    get: (u: string) => agent.get(u).set('X-Whatsapp-Account', String(id)),
    post: (u: string) => agent.post(u).set('X-Whatsapp-Account', String(id)),
    put: (u: string) => agent.put(u).set('X-Whatsapp-Account', String(id)),
    delete: (u: string) => agent.delete(u).set('X-Whatsapp-Account', String(id)),
  });
  let sharedId = 0;

  beforeAll(async () => {
    getDb();
    expect((await request(app).post('/api/dashboard/auth/setup').send({ username: 'sa-owner', password: PASSWORD })).status).toBe(201);
    const ownerId = (getDb().prepare('SELECT id FROM admin_users WHERE username = ?').get('sa-owner') as { id: number }).id;
    owner = as(ownerId);
    A = createAccount({ name: 'Super Test A' }).id;
    B = createAccount({ name: 'Super Test B' }).id;
    const make = async (key: string, role: string) => {
      const res = await owner.post('/api/dashboard/users').send({ password: PASSWORD, email: `${key}@example.com`, role, accountIds: [A, B], canConfiguration: role === 'admin' });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return as(res.body.id as number);
    };
    admin = await make('sa-admin', 'admin');
    manager = await make('sa-manager', 'manager');
  });
  afterEach(() => {
    vi.stubGlobal('fetch', originalFetch);
    mutableEnv.shouldUseMockProviders = originalMock;
    resetAiRouterForTests();
  });

  it('only the Super Admin can open or change the shared AI defaults (admin, manager and anonymous are refused, on every method)', async () => {
    expect((await request(app).get('/api/dashboard/super-admin/ai')).status).toBe(401);
    for (const who of [admin, manager]) {
      expect((await who.get('/api/dashboard/super-admin/ai')).status).toBe(403);
      expect((await who.post('/api/dashboard/super-admin/ai/providers').send({ name: 'x', config: SHARED_KEY })).status).toBe(403);
      expect((await who.put('/api/dashboard/super-admin/ai/providers/1').send({ name: 'x' })).status).toBe(403);
      expect((await who.delete('/api/dashboard/super-admin/ai/providers/1?confirm=yes')).status).toBe(403);
      expect((await who.put('/api/dashboard/super-admin/ai/providers/order').send({ ids: [] })).status).toBe(403);
    }
    // an account administrator cannot create a SHARED provider through the account routes either
    const viaAccount = await asAccount(admin, A).post('/api/dashboard/ai-routing/providers').send({ name: 'sneaky', config: SHARED_KEY, shared: true });
    expect(viaAccount.status).toBe(403);
    expect((await owner.get('/api/dashboard/super-admin/ai')).status).toBe(200);
  });

  it('the Super Admin adds a shared provider with just a name and an API key: stored encrypted, shown masked, never returned or logged in full', async () => {
    const created = await owner.post('/api/dashboard/super-admin/ai/providers').send({ name: 'Groq shared', config: SHARED_KEY });
    expect(created.status).toBe(201);
    sharedId = created.body.provider.id as number;
    expect(created.body.provider).toMatchObject({ name: 'Groq shared', kind: 'openai_compatible', shared: true, hasKey: true, keyStatus: 'ok', freeTier: true, enabled: true });
    expect(created.body.provider.baseUrl).toBe('https://api.groq.com/openai/v1'); // recognised from the key prefix
    expect(created.body.provider.models.length).toBeGreaterThan(0);
    expect(JSON.stringify(created.body)).not.toContain(SHARED_KEY);
    expect(String(created.body.provider.keyMasked)).not.toContain('sharedsharedshared');
    const stored = getDb().prepare('SELECT key_ciphertext, whatsapp_account_id FROM ai_providers WHERE id = ?').get(sharedId) as { key_ciphertext: string; whatsapp_account_id: number | null };
    expect(stored.whatsapp_account_id).toBeNull();
    expect(stored.key_ciphertext).not.toContain('gsk_');
    const page = await owner.get('/api/dashboard/super-admin/ai');
    expect(page.body.providers.map((p: { name: string }) => p.name)).toContain('Groq shared');
    expect(page.body.enforced).toMatchObject({ freeOnly: true, failover: true });
    expect(JSON.stringify(page.body)).not.toContain(SHARED_KEY);
    // a key that is not recognised needs the provider named (nothing is guessed)
    const unknown = await owner.post('/api/dashboard/super-admin/ai/providers').send({ name: 'Mystery', config: 'zz_unknownunknownunknownunknown00000000' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.fields).toContain('provider');
  });

  it('every business — existing and a brand-new one — inherits the shared pool as ONE "Default" entry; nobody sees its name, address or key', async () => {
    const fresh = createAccount({ name: 'Created After The Shared Provider' }).id;
    for (const id of [A, B, fresh]) {
      const view = (await asAccount(id === A || id === B ? admin : owner, id).get('/api/dashboard/ai-routing')).body;
      expect(view.entries).toHaveLength(1);
      expect(view.entries[0]).toMatchObject({ key: 'default', type: 'default', name: 'Default', enabled: true, state: 'ok', position: 1 });
      expect(view.providers).toEqual([]);
      expect(view.defaultPool.usable).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify({ e: view.entries, p: view.providers, d: view.defaultPool })).not.toMatch(/Groq shared|api\.groq\.com|gsk_/);
    }
    expect(getAccountRouting(fresh).map((e) => e.key)).toEqual(['default']);
    // the router really uses the shared provider for each of them
    for (const id of [A, B, fresh]) {
      const plan = await runWithAccount(id, () => explainRoutes(id, 'chat'));
      expect(plan.eligible.some((r) => r.providerName === 'Groq shared')).toBe(true);
    }
    // and a new business inherits the safe defaults
    expect(runWithAccount(fresh, () => getBusinessSettings(fresh))).toMatchObject({ aiFreeOnly: true, aiFailoverEnabled: true });
  });

  it('a business adds its OWN provider with a name and a key, orders it before Default, and the router follows that order — another business is unaffected', async () => {
    const created = await asAccount(admin, A).post('/api/dashboard/ai-routing/providers').send({ name: 'My Groq', config: OWN_A_KEY });
    expect(created.status).toBe(201);
    const ownId = created.body.provider.id as number;
    expect(created.body.entries.map((e: { name: string }) => e.name)).toEqual(['Default', 'My Groq']);
    expect(JSON.stringify(created.body)).not.toContain(OWN_A_KEY);
    // before reordering: Default (the shared pool) answers first
    const before = await runWithAccount(A, () => explainRoutes(A, 'chat'));
    expect(before.eligible[0]!.providerName).toBe('Groq shared');
    const saved = await asAccount(admin, A).put('/api/dashboard/ai-routing/order').send({ entries: [{ key: `provider:${ownId}` }, { key: 'default' }] });
    expect(saved.status).toBe(200);
    expect(getAccountRouting(A).map((e) => e.key)).toEqual([`provider:${ownId}`, 'default']); // persisted
    const after = await runWithAccount(A, () => explainRoutes(A, 'chat'));
    expect(after.eligible[0]!.providerName).toBe('My Groq');
    expect(after.eligible.some((r) => r.providerName === 'Groq shared')).toBe(true); // Default is still there, after it
    const other = await runWithAccount(B, () => explainRoutes(B, 'chat'));
    expect(other.eligible[0]!.providerName).toBe('Groq shared');
    expect(other.eligible.some((r) => r.providerName === 'My Groq')).toBe(false); // B never sees or uses A's provider
    // a business cannot name another business's provider or an unknown entry in its order
    const bOwn = await asAccount(admin, B).post('/api/dashboard/ai-routing/providers').send({ name: 'B Groq', config: OWN_B_KEY });
    const bad = await asAccount(admin, A).put('/api/dashboard/ai-routing/order').send({ entries: [{ key: `provider:${bOwn.body.provider.id}` }, { key: 'default' }] });
    expect(bad.status).toBe(400);
    expect((await asAccount(admin, A).put('/api/dashboard/ai-routing/order').send({ entries: [{ key: 'provider:999999' }] })).status).toBe(400);
    expect((await asAccount(admin, A).put('/api/dashboard/ai-routing/order').send({ entries: [{ key: 'default' }, { key: 'default' }] })).status).toBe(400);
    // Default can be switched off for one business only
    await asAccount(admin, B).put('/api/dashboard/ai-routing/order').send({ entries: [{ key: `provider:${bOwn.body.provider.id}` }, { key: 'default', enabled: false }] });
    const bPlan = await runWithAccount(B, () => explainRoutes(B, 'chat'));
    expect([...new Set(bPlan.eligible.map((r) => r.providerName))]).toEqual(['B Groq']);
    expect(bPlan.skipped.some((s) => s.route.providerName === 'Groq shared' && s.category === 'disabled')).toBe(true);
    expect((await runWithAccount(A, () => explainRoutes(A, 'chat'))).eligible.some((r) => r.providerName === 'Groq shared')).toBe(true);
    await asAccount(admin, B).put('/api/dashboard/ai-routing/order').send({ entries: [{ key: 'default', enabled: true }, { key: `provider:${bOwn.body.provider.id}` }] });
  });

  it('failover follows the saved order: own provider rate limited → Default answers; Default exhausted → the next entry; no key rotation, no repeated side effect', async () => {
    mutableEnv.shouldUseMockProviders = false;
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const auth = String((init?.headers as Record<string, string>).Authorization);
      calls.push(auth.includes('ownerowner') ? 'own' : 'shared');
      return auth.includes('ownerowner') ? err(429, 'Rate limit reached') : ok('Answered by the shared pool');
    }));
    const response = await runWithAccount(A, () => routeCompletion({ task: 'chat', messages: [{ role: 'user', content: 'hello' }] }));
    expect(response.choices[0]!.message.content).toBe('Answered by the shared pool');
    expect(calls[0]).toBe('own'); // the order saved above: own first, then Default\n    expect(calls.filter((c) => c === 'shared')).toHaveLength(1); // Default answers once\n    expect(calls.filter((c) => c === 'own').length).toBeLessThanOrEqual(2); // at most one attempt per model of the own provider, no other key is ever tried
    expect(response.servedBy).toMatchObject({ provider: 'Groq shared', fallbackReason: 'rate_limited' });
    // the next message skips the cooling own route instead of retrying it (and never tries another key to get round the limit)
    calls.length = 0;
    await runWithAccount(A, () => routeCompletion({ task: 'chat', messages: [{ role: 'user', content: 'again' }] }));
    expect(calls).toEqual(['shared']);
  });

  it('quota exhausted everywhere: no route answers, the error names the cause, and a pending customer message is preserved untouched for the safe replay', async () => {
    mutableEnv.shouldUseMockProviders = false;
    vi.stubGlobal('fetch', vi.fn(async () => err(402, 'Insufficient credits')));
    const customer = runWithAccount(A, () => getOrCreateCustomer('966599900001', 'Layla'));
    const conversation = runWithAccount(A, () => getOrCreateActiveConversation(customer.id));
    runWithAccount(A, () => appendMessage(conversation.id, { role: 'user', content: 'how much is tinting?', whatsappMessageId: 'wamid.sa.1', direction: 'inbound', messageType: 'text' }));
    runWithAccount(A, () => openPendingReply({ customerId: customer.id, conversationId: conversation.id, messageId: 'wamid.sa.1', waId: customer.wa_id, channel: 'qr' }));
    const before = JSON.stringify(getDb().prepare('SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY id').all(conversation.id));
    const result = await runWithAccount(A, () => routeCompletion({ task: 'chat', messages: [{ role: 'user', content: 'how much is tinting?' }] })).catch((e: unknown) => e);
    expect(result).toBeInstanceOf(Error);
    expect(JSON.stringify(getDb().prepare('SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY id').all(conversation.id))).toBe(before);
    expect(runWithAccount(A, () => getPendingReply('wamid.sa.1'))!.status).toBe('pending'); // untouched: the pipeline decides what to do with it
  });

  it('turning the shared provider off or removing it is handled safely: Default says so, nothing paid is ever used, own providers and customer data are untouched, removal needs confirmation', async () => {
    const settingsBefore = JSON.stringify([A, B].map((id) => runWithAccount(id, () => getBusinessSettings(id))));
    const customersBefore = (getDb().prepare('SELECT COUNT(*) AS n FROM customers').get() as { n: number }).n;
    const disabled = await owner.post(`/api/dashboard/super-admin/ai/providers/${sharedId}/disable`);
    expect(disabled.status).toBe(200);
    expect(disabled.body.provider.enabled).toBe(false);
    const view = (await asAccount(admin, B).get('/api/dashboard/ai-routing')).body;
    expect(view.entries.find((e: { key: string }) => e.key === 'default')).toMatchObject({ enabled: true });
    expect(view.entries.find((e: { key: string }) => e.key === 'default').detail).toMatch(/turned off|No shared provider|no usable/i);
    const plan = await runWithAccount(A, () => explainRoutes(A, 'chat'));
    expect(plan.eligible.some((r) => r.providerName === 'Groq shared')).toBe(false);
    expect(plan.eligible.some((r) => r.providerName === 'My Groq')).toBe(true); // the business's own provider keeps working
    // removal: refused without the explicit confirmation, then removed
    const refused = await owner.delete(`/api/dashboard/super-admin/ai/providers/${sharedId}`);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: 'confirmation_required' });
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM ai_providers WHERE id = ?').get(sharedId)).toEqual({ n: 1 });
    expect((await owner.delete(`/api/dashboard/super-admin/ai/providers/${sharedId}?confirm=yes`)).status).toBe(200);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM ai_providers WHERE id = ?').get(sharedId)).toEqual({ n: 0 });
    // no account setting, order or customer row changed because of the global edits
    expect(JSON.stringify([A, B].map((id) => runWithAccount(id, () => getBusinessSettings(id))))).toBe(settingsBefore);
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM customers').get() as { n: number }).n).toBe(customersBefore);
    expect(getAccountRouting(A).map((e) => e.key)[1]).toBe('default'); // still in A's order, now with nothing shared behind it
  });

  it('strict free-only: a shared provider not declared as a free tier is never called; the free-only switch is per business and defaults ON', async () => {
    const paid = await owner.post('/api/dashboard/super-admin/ai/providers').send({ name: 'Paid endpoint', kind: 'openai_compatible', baseUrl: 'https://api.example-paid.test/v1', apiKey: SHARED_KEY, models: 'big-model', freeTier: false });
    expect(paid.status).toBe(201);
    const plan = await runWithAccount(B, () => explainRoutes(B, 'chat'));
    expect(plan.freeOnly).toBe(true);
    expect(plan.eligible.some((r) => r.providerName === 'Paid endpoint')).toBe(false);
    expect(plan.skipped.find((s) => s.route.providerName === 'Paid endpoint')).toMatchObject({ category: 'free_only' });
    await owner.delete(`/api/dashboard/super-admin/ai/providers/${paid.body.provider.id}?confirm=yes`);
  });

  it('the shared pool can be reordered; test calls use one tiny request and never expose the key', async () => {
    const one = await owner.post('/api/dashboard/super-admin/ai/providers').send({ name: 'Pool one', config: SHARED_KEY });
    const two = await owner.post('/api/dashboard/super-admin/ai/providers').send({ name: 'Pool two', config: 'AIzaSyPoolPoolPoolPoolPoolPoolPool0000000', models: 'gemini-test-model' }); // a vendor without a verified default needs a model chosen from its list
    expect(two.body.provider.baseUrl).toContain('generativelanguage.googleapis.com'); // recognised as Google AI Studio
    const order = await owner.put('/api/dashboard/super-admin/ai/providers/order').send({ ids: [two.body.provider.id, one.body.provider.id] });
    expect(order.body.providers.map((p: { name: string }) => p.name)).toEqual(['Pool two', 'Pool one']);
    expect((await runWithAccount(B, () => explainRoutes(B, 'chat'))).eligible.filter((r) => r.providerName.startsWith('Pool'))[0]!.providerName).toBe('Pool two');
    mutableEnv.shouldUseMockProviders = false;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => { expect(String((init?.headers as Record<string, string>).Authorization)).toContain('Bearer '); return ok('ok'); });
    vi.stubGlobal('fetch', fetchMock);
    const tested = await owner.post(`/api/dashboard/super-admin/ai/providers/${one.body.provider.id}/test`).send({});
    expect(tested.body).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(tested.body)).not.toContain(SHARED_KEY);
    // an account administrator can test the Default entry (not a shared provider's key) and gets a result without any secret
    const viaDefault = await asAccount(admin, B).post('/api/dashboard/ai-routing/entries/default/test').send({});
    expect(viaDefault.status).toBe(200);
    expect(viaDefault.body.ok).toBe(true);
    expect(JSON.stringify(viaDefault.body)).not.toMatch(/gsk_|AIza/);
    expect((await asAccount(admin, B).post(`/api/dashboard/ai-routing/providers/${one.body.provider.id}/test`).send({})).status).toBe(403);
    for (const p of [one, two]) await owner.delete(`/api/dashboard/super-admin/ai/providers/${p.body.provider.id}?confirm=yes`);
  });

  it('provider and routing changes leave history, reply mode, WhatsApp sessions, callbacks, pending recovery records, templates, hours and customers exactly as they were', async () => {
    // some real data to protect: a customer with history, a waiting message, a callback request
    const customer = runWithAccount(A, () => getOrCreateCustomer('966599900002', 'Omar'));
    const conversation = runWithAccount(A, () => getOrCreateActiveConversation(customer.id));
    runWithAccount(A, () => appendMessage(conversation.id, { role: 'user', content: 'preserve me', whatsappMessageId: 'wamid.sa.keep', direction: 'inbound', messageType: 'text' }));
    runWithAccount(A, () => openPendingReply({ customerId: customer.id, conversationId: conversation.id, messageId: 'wamid.sa.keep', waId: customer.wa_id, channel: 'qr' }));
    const tables = ['conversation_messages', 'conversations', 'customers', 'automation_settings', 'business_settings', 'whatsapp_accounts', 'followup_requests', 'pending_replies', 'reply_templates', 'scheduled_jobs', 'admin_users', 'credential_overrides'];
    const snapshot = () => JSON.stringify(tables.map((t) => getDb().prepare(`SELECT * FROM ${t} ORDER BY 1`).all()));
    const before = snapshot();
    // every kind of global and per-business AI change
    const shared = await owner.post('/api/dashboard/super-admin/ai/providers').send({ name: 'Keep test shared', config: SHARED_KEY });
    await owner.put(`/api/dashboard/super-admin/ai/providers/${shared.body.provider.id}`).send({ name: 'Keep test shared 2', config: '' });
    await owner.post(`/api/dashboard/super-admin/ai/providers/${shared.body.provider.id}/disable`);
    await owner.post(`/api/dashboard/super-admin/ai/providers/${shared.body.provider.id}/enable`);
    const mine = await asAccount(admin, A).post('/api/dashboard/ai-routing/providers').send({ name: 'Keep test own', config: 'gsk_keepkeepkeepkeepkeepkeepkeep00000000000' });
    await asAccount(admin, A).put('/api/dashboard/ai-routing/order').send({ entries: [{ key: `provider:${mine.body.provider.id}` }, { key: 'default', enabled: false }] });
    await asAccount(admin, A).put('/api/dashboard/ai-routing/order').send({ entries: [{ key: 'default', enabled: true }, { key: `provider:${mine.body.provider.id}` }] });
    await asAccount(admin, A).delete(`/api/dashboard/ai-routing/providers/${mine.body.provider.id}`);
    await owner.delete(`/api/dashboard/super-admin/ai/providers/${shared.body.provider.id}?confirm=yes`);
    const strip = (s: string) => s; // nothing is excluded: the snapshot is byte-for-byte
    expect(strip(snapshot())).toBe(before);
    expect(runWithAccount(A, () => getPendingReply('wamid.sa.keep'))!.status).toBe('pending');
  });

  it('concurrent requests from different businesses each use only their own order and their own key (no cross-account leak)', async () => {
    const ownB = (getDb().prepare('SELECT id FROM ai_providers WHERE whatsapp_account_id = ?').get(B) as { id: number }).id;
    expect(ownB).toBeGreaterThan(0);
    const ownA = (getDb().prepare('SELECT id FROM ai_providers WHERE whatsapp_account_id = ?').get(A) as { id: number }).id;
    await asAccount(admin, A).put('/api/dashboard/ai-routing/order').send({ entries: [{ key: `provider:${ownA}` }, { key: 'default' }] });
    await asAccount(admin, B).put('/api/dashboard/ai-routing/order').send({ entries: [{ key: `provider:${ownB}` }, { key: 'default' }] }); // each business tries its own provider first
    mutableEnv.shouldUseMockProviders = false;
    const seen: Array<{ account: string; key: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const auth = String((init?.headers as Record<string, string>).Authorization);
      await new Promise((r) => setTimeout(r, 5));
      seen.push({ account: auth.includes('AAAA') ? 'A' : auth.includes('BBBB') ? 'B' : '?', key: auth });
      return ok(auth.includes('AAAA') ? 'answer for A' : 'answer for B');
    }));
    const run = (id: number) => runWithAccount(id, () => routeCompletion({ task: 'chat', messages: [{ role: 'user', content: `q${id}` }] }));
    const results = await Promise.all([run(A), run(B), run(A), run(B), run(A), run(B)]);
    expect(results.map((r) => r.choices[0]!.message.content)).toEqual(['answer for A', 'answer for B', 'answer for A', 'answer for B', 'answer for A', 'answer for B']);
    expect(seen.filter((s) => s.account === 'A')).toHaveLength(3);
    expect(seen.filter((s) => s.account === 'B')).toHaveLength(3);
  });
});
