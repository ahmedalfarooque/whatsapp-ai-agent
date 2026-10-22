import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/whatsapp/client', () => ({
  sendTextMessage: vi.fn().mockResolvedValue({ messaging_product: 'whatsapp', contacts: [], messages: [{ id: 'w1' }] }),
  sendInteractiveMessage: vi.fn().mockResolvedValue({ messaging_product: 'whatsapp', contacts: [], messages: [{ id: 'w2' }] }),
  sendDocumentMessage: vi.fn(),
  markMessageAsRead: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/llm/openRouterClient', () => ({ chatCompletion: vi.fn() }));

import { createApp } from '../../src/app';
import { getDb } from '../../src/memory/db';
import { createAccount } from '../../src/accounts/accountRepo';
import { LEGACY_ACCOUNT_ID, runWithAccount } from '../../src/accounts/accountContext';
import { setAccountFeature, FEATURES } from '../../src/accounts/accountFeatures';
import { createSession } from '../../src/dashboard/auth';
import { SESSION_COOKIE_NAME } from '../../src/dashboard/authMiddleware';
import { chatCompletion } from '../../src/llm/openRouterClient';
import { AiResponseError } from '../../src/llm/aiResponseError';
import { sendTextMessage } from '../../src/whatsapp/client';
import { processInboundMessage } from '../../src/pipeline/processInboundMessage';
import { setSkillsRootForTests, resetSkillCache } from '../../src/skills/registry';
import { setSkillEnabled } from '../../src/skills/skillRepo';
import { setWebSearchProvider } from '../../src/tools/webSearch';
import type { InboundMessage } from '../../src/webhook/parseInboundPayload';

/**
 * Business skills end to end: the dashboard API (who may see and change them, validation, persistence, tenant isolation, add-on gating), and the real inbound pipeline
 * (explicit and automatic selection, instructions reaching the model, tool restriction enforced server-side, failures, duplicate webhook deliveries, normal chat when
 * no skill applies). The model and WhatsApp are scripted; everything else is the real application and its real database.
 */
const PASSWORD = 'a-very-long-test-password-123';
const APP_SECRET = process.env.META_APP_SECRET as string;
const skillFile = (name: string, extra: string, body = 'Follow these steps carefully.') => `---\nname: ${name}\ndescription: ${name} description.\n${extra}\n---\n${body}\n`;

const text = (content: string) => ({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }] });
const toolCall = (name: string, args: Record<string, unknown>) => ({ choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });

let skillsDir: string;
let A: number; // has the catalogues add-on
let B: number; // has no add-on
const staff: Record<string, number> = {};
let owner: ReturnType<typeof as>;
const app = createApp();

const as = (userId: number) => {
  const cookie = `${SESSION_COOKIE_NAME}=${createSession(userId).token}`;
  const call = (method: 'get' | 'put', url: string, account?: number, body?: unknown) => {
    const r = request(app)[method](url).set('Cookie', cookie);
    const withAccount = account ? r.set('X-Whatsapp-Account', String(account)) : r;
    return body === undefined ? withAccount : withAccount.send(body as object);
  };
  return { get: (url: string, account?: number) => call('get', url, account), put: (url: string, body: unknown, account?: number) => call('put', url, account, body) };
};
const user = (name: string) => as(staff[name]!);
const runsOf = (account: number) => getDb().prepare('SELECT skill_id, selection, status, tools_used, reason FROM skill_runs WHERE whatsapp_account_id = ? ORDER BY id').all(account) as Array<{ skill_id: string; selection: string; status: string; tools_used: string; reason: string | null }>;

let counter = 0;
const msg = (accountId: number, waId: string, content: string): InboundMessage => ({ waId, messageId: `wamid.skill.${accountId}.${++counter}`, timestamp: Date.now(), type: 'text', text: content, accountId });
const KB = { sections: [], asPromptText: 'KB: We sell paint and polish cars.' };
const lastCall = () => { const c = vi.mocked(chatCompletion).mock.calls.at(-1)![0]; return { system: String(c.messages[0]!.content), tools: ((c.tools ?? []) as Array<{ function: { name: string } }>).map((t) => t.function.name) }; };
const customerNumber = () => `9665${String(7000000 + ++counter)}`;
const ask = (account: number, content: string, waId = customerNumber()) => runWithAccount(account, () => processInboundMessage(msg(account, waId, content), { knowledge: KB }));

beforeAll(async () => {
  getDb();
  skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-e2e-'));
  const put = (id: string, content: string) => { fs.mkdirSync(path.join(skillsDir, id), { recursive: true }); fs.writeFileSync(path.join(skillsDir, id, 'SKILL.md'), content); };
  put('quote-helper', skillFile('Quote helper', 'triggers: need a quote, عرض سعر\ntools: request_human_handoff', 'Collect: item, size, place, date. Never state a price.'));
  put('catalogue-lookup', skillFile('Catalogue lookup', 'triggers: do you have\ntools: search_catalogues\nrequires_feature: catalogues'));
  put('rush-a', skillFile('Rush A', 'triggers: rush order'));
  put('rush-b', skillFile('Rush B', 'triggers: rush order'));
  put('warranty-info', skillFile('Warranty info', 'triggers: warranty claim\ndefault_enabled: true'));
  put('broken', 'this file has no header');
  setSkillsRootForTests(skillsDir);

  expect((await request(app).post('/api/dashboard/auth/setup').send({ username: 'skills-owner', password: PASSWORD })).status).toBe(201);
  owner = as((getDb().prepare('SELECT id FROM admin_users WHERE username = ?').get('skills-owner') as { id: number }).id);
  A = createAccount({ name: 'Skills Business A' }).id;
  B = createAccount({ name: 'Skills Business B' }).id;
  setAccountFeature(A, FEATURES.CATALOGUES, true);
  const create = async (key: string, body: Record<string, unknown>) => {
    const res = await owner.get('/api/dashboard/users'); // keep the harness honest: the owner exists
    expect(res.status).toBe(200);
    const created = await request(app).post('/api/dashboard/users').set('Cookie', `${SESSION_COOKIE_NAME}=${createSession((getDb().prepare('SELECT id FROM admin_users WHERE username = ?').get('skills-owner') as { id: number }).id).token}`).send({ password: PASSWORD, ...body });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    staff[key] = created.body.id;
  };
  await create('editor', { email: 'editor@example.com', role: 'custom', accountIds: [A], permissions: { [A]: { ai: 'edit' } } });
  await create('viewer', { email: 'viewer@example.com', role: 'custom', accountIds: [A], permissions: { [A]: { ai: 'view' } } });
  await create('noAi', { email: 'noai@example.com', role: 'custom', accountIds: [A], permissions: { [A]: { conversations: 'view' } } });
  await create('onlyB', { email: 'onlyb@example.com', role: 'manager', accountIds: [B] });
});
afterAll(() => { setSkillsRootForTests(null); fs.rmSync(skillsDir, { recursive: true, force: true }); });
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(chatCompletion).mockResolvedValue(text('AI answer') as never);
  getDb().prepare('DELETE FROM account_skills').run();
  getDb().prepare('DELETE FROM skill_runs').run();
  resetSkillCache();
});

describe('the Skills page API', () => {
  it('lists the skills with their state, add-on availability and the files that could not be loaded; the default applies until the business chooses', async () => {
    const res = await owner.get('/api/dashboard/skills', A);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const byId = Object.fromEntries(res.body.skills.map((s: { id: string }) => [s.id, s]));
    expect(Object.keys(byId).sort()).toEqual(['catalogue-lookup', 'quote-helper', 'rush-a', 'rush-b', 'warranty-info']);
    expect(byId['quote-helper']).toMatchObject({ name: 'Quote helper', enabled: false, available: true, choice: 'default', invocation: '/quote-helper', tools: [{ name: 'request_human_handoff' }] });
    expect(byId['warranty-info']).toMatchObject({ enabled: true, choice: 'default', defaultEnabled: true });
    expect(byId['catalogue-lookup']).toMatchObject({ available: true });
    expect(res.body.problems).toEqual([{ id: 'broken', problems: ['the file must start with a header between two "---" lines'] }]);
    expect(JSON.stringify(res.body)).not.toContain(skillsDir); // no server paths
    const other = await owner.get('/api/dashboard/skills', B);
    expect(other.body.skills.find((s: { id: string }) => s.id === 'catalogue-lookup')).toMatchObject({ available: false, enabled: false, unavailableReason: expect.stringContaining('add-on') });
  });

  it('enable and disable persist: the state survives a new session, a fresh read and a registry reload', async () => {
    expect((await user('editor').put('/api/dashboard/skills/quote-helper', { enabled: true }, A)).body.skill).toMatchObject({ enabled: true, choice: 'on' });
    resetSkillCache();
    for (const who of [owner, user('editor'), user('viewer')]) {
      const read = await who.get('/api/dashboard/skills', A);
      expect(read.body.skills.find((s: { id: string }) => s.id === 'quote-helper')).toMatchObject({ enabled: true, choice: 'on' });
    }
    expect((await user('editor').put('/api/dashboard/skills/quote-helper', { enabled: false }, A)).body.skill).toMatchObject({ enabled: false, choice: 'off' });
    expect(getDb().prepare('SELECT enabled, updated_by FROM account_skills WHERE whatsapp_account_id = ? AND skill_id = ?').get(A, 'quote-helper')).toEqual({ enabled: 0, updated_by: staff.editor });
    // an explicit "off" beats a default of "on"
    await owner.put('/api/dashboard/skills/warranty-info', { enabled: false }, A);
    expect((await owner.get('/api/dashboard/skills/warranty-info', A)).body.skill).toMatchObject({ enabled: false, choice: 'off', defaultEnabled: true });
  });

  it('who may do what: edit changes a skill, view only reads, no AI permission sees nothing, and a user of another business is refused', async () => {
    expect((await user('viewer').get('/api/dashboard/skills', A)).status).toBe(200);
    expect((await user('viewer').put('/api/dashboard/skills/quote-helper', { enabled: true }, A)).status).toBe(403);
    expect((await user('noAi').get('/api/dashboard/skills', A)).status).toBe(403);
    expect((await user('noAi').put('/api/dashboard/skills/quote-helper', { enabled: true }, A)).status).toBe(403);
    expect((await user('onlyB').get('/api/dashboard/skills', A)).status).toBe(403);
    expect((await user('onlyB').put('/api/dashboard/skills/quote-helper', { enabled: true }, A)).status).toBe(403);
    expect((await request(app).get('/api/dashboard/skills')).status).toBe(401); // not signed in
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM account_skills').get()).toEqual({ n: 0 }); // nothing slipped through
  });

  it('businesses are isolated: switching a skill on for one never shows or changes another', async () => {
    await owner.put('/api/dashboard/skills/quote-helper', { enabled: true }, A);
    expect((await owner.get('/api/dashboard/skills', B)).body.skills.find((s: { id: string }) => s.id === 'quote-helper')).toMatchObject({ enabled: false });
    await user('onlyB').put('/api/dashboard/skills/quote-helper', { enabled: true }, B);
    expect((await owner.get('/api/dashboard/skills', A)).body.skills.find((s: { id: string }) => s.id === 'quote-helper')).toMatchObject({ enabled: true });
    await owner.put('/api/dashboard/skills/quote-helper', { enabled: false }, A);
    expect((await owner.get('/api/dashboard/skills', B)).body.skills.find((s: { id: string }) => s.id === 'quote-helper')).toMatchObject({ enabled: true });
    // the business is never taken from the body or the URL
    expect((await owner.put('/api/dashboard/skills/quote-helper', { enabled: true, whatsapp_account_id: B, accountId: B }, A)).status).toBe(400);
  });

  it('input is validated on the server: only a boolean "enabled", only known skill ids, nothing else in the body', async () => {
    for (const body of [{}, { enabled: 'yes' }, { enabled: 1 }, { enabled: null }, { enabled: true, extra: 1 }, []]) {
      expect((await owner.put('/api/dashboard/skills/quote-helper', body, A)).status, JSON.stringify(body)).toBe(400);
    }
    for (const id of ['nope', 'Bad_ID', 'broken', '..%2F..%2Fetc', 'x'.repeat(80)]) expect((await owner.put(`/api/dashboard/skills/${id}`, { enabled: true }, A)).status, id).toBe(404);
    expect((await owner.get('/api/dashboard/skills/nope', A)).status).toBe(404);
    expect((await owner.get('/api/dashboard/skills/broken', A)).status).toBe(404); // a file that did not validate is not a skill
  });

  it('a skill that needs an add-on cannot be switched on by a business without it', async () => {
    const refused = await owner.put('/api/dashboard/skills/catalogue-lookup', { enabled: true }, B);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('skill_not_available');
    expect((await owner.put('/api/dashboard/skills/catalogue-lookup', { enabled: true }, A)).status).toBe(200);
  });

  it('the detail shows what the skill does, what it may use and how it was used, without a customer\'s text', async () => {
    await owner.put('/api/dashboard/skills/quote-helper', { enabled: true }, A);
    await ask(A, 'I need a quote for polishing my car');
    const detail = await owner.get('/api/dashboard/skills/quote-helper', A);
    expect(detail.body.skill).toMatchObject({ id: 'quote-helper', instructions: expect.stringContaining('Never state a price'), runs: { total: 1, answered: 1, failed: 0 } });
    expect(detail.body.recentRuns).toEqual([expect.objectContaining({ selection: 'automatic', status: 'answered', tools: [] })]);
    expect(JSON.stringify(detail.body)).not.toContain('polishing my car');
  });
});

describe('a skill taking part in a real customer message', () => {
  it('with no skill switched on the assistant answers exactly as before: no skill section, the normal tools, nothing recorded', async () => {
    await ask(A, 'I need a quote for polishing my car');
    expect(chatCompletion).toHaveBeenCalledTimes(1);
    expect(lastCall().system).not.toContain('ACTIVE SERVICE');
    expect(lastCall().tools).toEqual(expect.arrayContaining(['web_search', 'request_human_handoff', 'search_catalogues']));
    expect(vi.mocked(sendTextMessage).mock.calls.map((c) => String(c[1]))).toEqual(['AI answer']);
    expect(runsOf(A)).toEqual([]);
  });

  it('automatic selection: a matching message loads ONLY that skill\'s instructions and ONLY its tools (plus the hand-over), and the run is recorded', async () => {
    await owner.put('/api/dashboard/skills/quote-helper', { enabled: true }, A);
    await owner.put('/api/dashboard/skills/catalogue-lookup', { enabled: true }, A);
    await ask(A, 'Hello, I need a quote for polishing my car please');
    const { system, tools } = lastCall();
    expect(system).toContain('ACTIVE SERVICE: Quote helper');
    expect(system).toContain('<service_instructions>\nCollect: item, size, place, date. Never state a price.\n</service_instructions>');
    expect(system).not.toContain('Catalogue lookup'); // the other skill is not loaded
    expect(tools).toEqual(['request_human_handoff']);
    expect(vi.mocked(sendTextMessage).mock.calls.map((c) => String(c[1]))).toEqual(['AI answer']);
    expect(runsOf(A)).toEqual([{ skill_id: 'quote-helper', selection: 'automatic', status: 'answered', tools_used: '', reason: null }]);
  });

  it('Arabic trigger phrases match too (letter variants and punctuation are folded)', async () => {
    await owner.put('/api/dashboard/skills/quote-helper', { enabled: true }, A);
    await ask(A, 'السلام عليكم، أريد عرض سعر لتلميع السيارة؟');
    expect(lastCall().system).toContain('ACTIVE SERVICE: Quote helper');
  });

  it('explicit invocation: "/skill-id" selects that skill even when its trigger words are absent', async () => {
    await owner.put('/api/dashboard/skills/quote-helper', { enabled: true }, A);
    await ask(A, '/quote-helper polishing a car for the weekend, please help');
    expect(lastCall().system).toContain('ACTIVE SERVICE: Quote helper');
    expect(lastCall().system).toContain('the customer asked for it by name');
    expect(runsOf(A)[0]).toMatchObject({ selection: 'explicit' });
    await ask(A, '#quote-helper another one, polishing a bike for the weekend');
    expect(runsOf(A).map((r) => r.selection)).toEqual(['explicit', 'explicit']);
  });

  it('"/something" that is not a skill is just text, and a message that matches nothing loads nothing', async () => {
    await owner.put('/api/dashboard/skills/quote-helper', { enabled: true }, A);
    await ask(A, '/nothing-here what are your opening hours today?');
    expect(lastCall().system).not.toContain('ACTIVE SERVICE');
    await ask(A, 'What time do you close on Friday evening?');
    expect(lastCall().system).not.toContain('ACTIVE SERVICE');
    expect(runsOf(A)).toEqual([]);
  });

  it('a disabled skill never runs: not by its trigger words, not by name — and asking for it by name is answered with a clear "not available" instruction', async () => {
    await ask(A, 'Hello, I need a quote for polishing my car please');
    expect(lastCall().system).not.toContain('ACTIVE SERVICE');
    await ask(A, '/quote-helper I need help with a quote for my car');
    expect(lastCall().system).not.toContain('ACTIVE SERVICE');
    expect(lastCall().system).toContain('SERVICE NOT AVAILABLE');
    expect(lastCall().system).toContain('"Quote helper"');
    expect(lastCall().system).not.toContain('Never state a price'); // its instructions were not loaded
    expect(runsOf(A)).toEqual([]);
  });

  it('a skill whose add-on the business lacks is never selected, even if a database row says it is on', async () => {
    setSkillEnabled(B, 'catalogue-lookup', true, null); // bypassing the API's own refusal
    await ask(B, 'Do you have wall paint in stock today?');
    expect(lastCall().system).not.toContain('ACTIVE SERVICE');
    await ask(B, '/catalogue-lookup do you have wall paint?');
    expect(lastCall().system).not.toContain('ACTIVE SERVICE');
    expect(runsOf(B)).toEqual([]);
  });

  it('two enabled skills matching equally is ambiguous: neither is loaded and the normal assistant answers; a more specific match still wins', async () => {
    await owner.put('/api/dashboard/skills/rush-a', { enabled: true }, A);
    await owner.put('/api/dashboard/skills/rush-b', { enabled: true }, A);
    await ask(A, 'I would like to place a rush order for tomorrow');
    expect(lastCall().system).not.toContain('ACTIVE SERVICE');
    await owner.put('/api/dashboard/skills/quote-helper', { enabled: true }, A);
    await ask(A, 'rush order: I need a quote (عرض سعر) for ten cars'); // two of its triggers against one each: a clear winner
    expect(lastCall().system).toContain('ACTIVE SERVICE: Quote helper'); // one skill with the best score
    expect(lastCall().system).not.toContain('Rush A');
  });

  it('a skill that is on by default works without the business having chosen, and turning it off stops it', async () => {
    await ask(A, 'I have a warranty claim for the polish I bought last week');
    expect(lastCall().system).toContain('ACTIVE SERVICE: Warranty info');
    await owner.put('/api/dashboard/skills/warranty-info', { enabled: false }, A);
    await ask(A, 'I have another warranty claim for the polish');
    expect(lastCall().system).not.toContain('ACTIVE SERVICE');
  });

  it('businesses are isolated at answer time too: A\'s skill never shapes B\'s customer', async () => {
    await owner.put('/api/dashboard/skills/quote-helper', { enabled: true }, A);
    await ask(B, 'I need a quote for polishing my car');
    expect(lastCall().system).not.toContain('ACTIVE SERVICE');
    expect(runsOf(B)).toEqual([]);
  });

  it('tool permissions are enforced on the server: a tool outside the skill\'s list is refused and never executed, even if the model asks for it', async () => {
    const searched = vi.fn(async () => []);
    setWebSearchProvider(searched);
    try {
      await owner.put('/api/dashboard/skills/quote-helper', { enabled: true }, A);
      vi.mocked(chatCompletion).mockResolvedValueOnce(toolCall('web_search', { query: 'secret competitor prices' }) as never).mockResolvedValueOnce(text('Sorry, I cannot look that up. Let me take your details.') as never);
      await ask(A, 'I need a quote for polishing my car');
      expect(searched).not.toHaveBeenCalled();
      const second = vi.mocked(chatCompletion).mock.calls[1]![0].messages;
      const toolResult = second.find((m) => m.role === 'tool');
      expect(JSON.parse(String(toolResult!.content))).toMatchObject({ error: 'unknown_tool' });
      expect(runsOf(A)[0]).toMatchObject({ status: 'answered', tools_used: 'web_search' }); // what the model ASKED for is recorded; nothing ran

      // control: with no skill active the very same request is allowed to run
      await owner.put('/api/dashboard/skills/quote-helper', { enabled: false }, A);
      vi.mocked(chatCompletion).mockResolvedValueOnce(toolCall('web_search', { query: 'car polish price riyadh' }) as never).mockResolvedValueOnce(text('Found something.') as never);
      await ask(A, 'How much does car polish usually cost in Riyadh?');
      expect(searched).toHaveBeenCalledTimes(1);
    } finally { setWebSearchProvider(null); }
  });

  it('a tool the skill DOES list is offered and runs', async () => {
    await owner.put('/api/dashboard/skills/catalogue-lookup', { enabled: true }, A);
    vi.mocked(chatCompletion).mockResolvedValueOnce(toolCall('search_catalogues', { query: 'wall paint' }) as never).mockResolvedValueOnce(text('Here is what I found.') as never);
    await ask(A, 'Do you have wall paint in white?');
    expect(lastCall().tools).toEqual(['search_catalogues', 'request_human_handoff']);
    const toolResult = vi.mocked(chatCompletion).mock.calls[1]![0].messages.find((m) => m.role === 'tool');
    expect(JSON.parse(String(toolResult!.content))).not.toMatchObject({ error: 'unknown_tool' });
    expect(runsOf(A)[0]).toMatchObject({ skill_id: 'catalogue-lookup', status: 'answered', tools_used: 'search_catalogues' });
  });

  it('a provider failure is handled safely: the customer gets the neutral fallback (no claim of success), and the run is closed as failed with a short code only', async () => {
    await owner.put('/api/dashboard/skills/quote-helper', { enabled: true }, A);
    vi.mocked(chatCompletion).mockRejectedValueOnce(new AiResponseError('provider_error', 503, 'some-model', 'upstream melted: secret details'));
    await ask(A, 'I need a quote for polishing my car');
    const sent = vi.mocked(sendTextMessage).mock.calls.map((c) => String(c[1]));
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toBe('AI answer');
    expect(runsOf(A)).toEqual([{ skill_id: 'quote-helper', selection: 'automatic', status: 'failed', tools_used: '', reason: 'provider_error' }]);
    expect(JSON.stringify(getDb().prepare('SELECT * FROM skill_runs').all())).not.toContain('secret details');
  });

  it('a skills directory that is missing or empty changes nothing: the normal assistant answers', async () => {
    setSkillsRootForTests(path.join(os.tmpdir(), 'no-such-skills-directory-xyz'));
    try {
      await ask(A, 'I need a quote for polishing my car');
      expect(vi.mocked(sendTextMessage).mock.calls.map((c) => String(c[1]))).toEqual(['AI answer']);
      expect(lastCall().system).not.toContain('ACTIVE SERVICE');
    } finally { setSkillsRootForTests(skillsDir); }
  });
});

describe('duplicate WhatsApp deliveries never run a skill twice', () => {
  const sign = (body: string) => `sha256=${crypto.createHmac('sha256', APP_SECRET).update(body).digest('hex')}`;
  const payload = (messageId: string, from: string, body: string) => JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '966500000000', phone_number_id: process.env.WHATSAPP_PHONE_NUMBER_ID }, contacts: [{ profile: { name: 'Sara' }, wa_id: from }], messages: [{ from, id: messageId, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } }] } }] }],
  });

  it('the same message delivered three times (a Meta retry) is answered once, with ONE skill run', async () => {
    setSkillEnabled(LEGACY_ACCOUNT_ID, 'quote-helper', true, null);
    const body = payload('wamid.DUPLICATE.skills.1', '966511700001', 'Hello, I need a quote for polishing my car please');
    for (let i = 0; i < 3; i += 1) {
      const res = await request(app).post('/webhook').set('Content-Type', 'application/json').set('x-hub-signature-256', sign(body)).send(body);
      expect(res.status).toBe(200);
    }
    await vi.waitFor(() => expect(runsOf(LEGACY_ACCOUNT_ID).length).toBeGreaterThanOrEqual(1), { timeout: 8000 });
    await new Promise((r) => setTimeout(r, 400)); // give any wrongly accepted duplicate time to show up
    expect(runsOf(LEGACY_ACCOUNT_ID)).toHaveLength(1);
    expect(vi.mocked(chatCompletion)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendTextMessage)).toHaveBeenCalledTimes(1);
  });
});
