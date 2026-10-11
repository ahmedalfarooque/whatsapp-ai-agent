import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/whatsapp/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/whatsapp/client')>();
  return { ...real, sendTextMessage: vi.fn(), sendInteractiveMessage: vi.fn(), sendImageMessage: vi.fn(), sendDocumentMessage: vi.fn() };
});
vi.mock('../../src/llm/agentLoop', () => ({ runAgentLoop: vi.fn().mockResolvedValue({ finalText: 'AI reply', generatedMessages: [] }) }));

import { sendTextMessage, sendDocumentMessage } from '../../src/whatsapp/client';
import { runAgentLoop } from '../../src/llm/agentLoop';
import { createApp } from '../../src/app';
import { getDb } from '../../src/memory/db';
import { processInboundMessage } from '../../src/pipeline/processInboundMessage';
import { createAccount } from '../../src/accounts/accountRepo';
import { runWithAccount } from '../../src/accounts/accountContext';
import { accountHasFeature, FEATURES } from '../../src/accounts/accountFeatures';
import { provisionBlueprint } from '../../src/accounts/blueprint';
import { QMULATE_BLUEPRINT } from '../../src/accounts/blueprints/qmulate';
import { createSession } from '../../src/dashboard/auth';
import { SESSION_COOKIE_NAME } from '../../src/dashboard/authMiddleware';
import { saveDocument } from '../../src/documents/documentStore';
import { updateBusinessSettings } from '../../src/config/businessSettings';
import { buildSystemPrompt } from '../../src/llm/buildSystemPrompt';
import { toolRegistry, toolSchemasForAccount } from '../../src/tools';
import { MENU_STATES } from '../../src/automation/menuStatic';
import { saveMenuConfig, validateMenuConfig } from '../../src/automation/menuConfig';
import { TINY_PNG } from '../fixtures/makePdf';
import {
  archiveProject, createProject, getLead, listLeads, openLeadsForCustomer, publishedProjects, searchPublishedProjects, updateLeadByStaff, updateProject, upsertLeadFromAssistant, RealEstateError,
} from '../../src/realestate/realEstateRepo';
import { sanitizeFields } from '../../src/realestate/leadFields';

const OWNER = 'owner@example.com';
const PASSWORD = 'a-very-long-test-password-123';
const KNOWLEDGE_EMPTY = { sections: [], asPromptText: '' };

let Q: number; // the real estate business
let OTHER: number; // an unrelated business (no add-on)
let ownerId: number;
let counter = 0;
const sent: string[] = [];
const user: Record<string, number> = {};

const app = createApp();
const cookieOf = (id: number) => `${SESSION_COOKIE_NAME}=${createSession(id).token}`;
const api = (id: number, account: number) => ({
  get: (url: string) => request(app).get(url).set('Cookie', cookieOf(id)).set('X-Whatsapp-Account', String(account)),
  post: (url: string, body: unknown = {}) => request(app).post(url).set('Cookie', cookieOf(id)).set('X-Whatsapp-Account', String(account)).send(body as object),
  put: (url: string, body: unknown = {}) => request(app).put(url).set('Cookie', cookieOf(id)).set('X-Whatsapp-Account', String(account)).send(body as object),
  patch: (url: string, body: unknown = {}) => request(app).patch(url).set('Cookie', cookieOf(id)).set('X-Whatsapp-Account', String(account)).send(body as object),
});

function newCustomer(accountId: number, language: 'en' | 'ar' = 'en'): { id: number; waId: string; conversationId: number } {
  const waId = `96650${String(++counter).padStart(7, '0')}`;
  const db = getDb();
  const id = Number(db.prepare('INSERT INTO customers (wa_id, display_name, whatsapp_account_id, language, menu_state) VALUES (?, ?, ?, ?, ?)').run(waId, `Customer ${counter}`, accountId, language, MENU_STATES.MAIN_MENU).lastInsertRowid);
  const conversationId = Number(db.prepare("INSERT INTO conversations (customer_id, whatsapp_account_id, status) VALUES (?, ?, 'active')").run(id, accountId).lastInsertRowid);
  return { id, waId, conversationId };
}

async function say(waId: string, text: string, accountId = Q): Promise<string[]> {
  sent.length = 0;
  await processInboundMessage({ waId, messageId: `wamid.re.${accountId}.${++counter}`, timestamp: Date.now(), type: 'text', text, accountId }, { knowledge: KNOWLEDGE_EMPTY });
  return sent.splice(0, sent.length);
}

async function makeUser(key: string, body: Record<string, unknown>): Promise<void> {
  const res = await request(app).post('/api/dashboard/users').set('Cookie', cookieOf(ownerId)).send({ password: PASSWORD, email: `${key}@example.com`, ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  user[key] = res.body.id;
}

beforeAll(async () => {
  getDb();
  expect((await request(app).post('/api/dashboard/auth/setup').send({ username: OWNER, password: PASSWORD })).status).toBe(201);
  ownerId = (getDb().prepare('SELECT id FROM admin_users WHERE username = ?').get(OWNER) as { id: number }).id;
  const logo = path.join(os.tmpdir(), `re-logo-${process.pid}.png`);
  fs.writeFileSync(logo, TINY_PNG);
  Q = provisionBlueprint(QMULATE_BLUEPRINT, { actor: 'test', logo: { path: logo } }).accountId;
  fs.rmSync(logo, { force: true });
  OTHER = createAccount({ name: 'Paint Shop Fixture', nameAr: 'محل دهانات' }).id;
  await makeUser('manager', { role: 'manager', accountIds: [Q] });
  await makeUser('viewer', { role: 'user', accountIds: [Q] });
  await makeUser('otherManager', { role: 'manager', accountIds: [OTHER] });
  await makeUser('both', { role: 'manager', accountIds: [Q, OTHER] });
});

beforeEach(() => {
  vi.mocked(runAgentLoop).mockClear();
  vi.mocked(sendDocumentMessage).mockReset().mockResolvedValue({ messaging_product: 'whatsapp', contacts: [], messages: [{ id: 'd' }] });
  vi.mocked(sendTextMessage).mockReset().mockImplementation(async (_to, body) => { sent.push(String(body)); return { messaging_product: 'whatsapp', contacts: [], messages: [{ id: 't' }] }; });
});

afterAll(() => undefined);

describe('the add-on belongs to one business', () => {
  it('is on for the real estate business only, and its menu entries cannot be saved anywhere else', () => {
    expect(accountHasFeature(Q, FEATURES.REAL_ESTATE)).toBe(true);
    expect(accountHasFeature(OTHER, FEATURES.REAL_ESTATE)).toBe(false);
    expect(accountHasFeature(1, FEATURES.REAL_ESTATE)).toBe(false);
    expect(() => saveMenuConfig(OTHER, { version: 1, items: [{ id: 'buy', kind: 'realestate', labelEn: 'Buy', labelAr: 'شراء' }] }, 'manual')).toThrow(/not available/);
    expect(() => validateMenuConfig({ items: [{ id: 'rent', kind: 'realestate', labelEn: 'x', labelAr: 'x' }] })).toThrow(/must have the id/);
  });

  it('offers the three real estate tools only to that business', () => {
    const names = (id: number) => toolSchemasForAccount(id).map((t) => String((t.function as { name: string }).name));
    expect(names(Q)).toEqual(expect.arrayContaining(['save_real_estate_lead', 'search_real_estate_projects', 'send_project_brochure', 'request_human_handoff']));
    for (const id of [1, OTHER]) for (const tool of ['save_real_estate_lead', 'search_real_estate_projects', 'send_project_brochure']) expect(names(id)).not.toContain(tool);
  });

  it('every real estate route answers 404 for a business without the add-on, and the dashboard marks it in the accounts list', async () => {
    for (const url of ['/api/dashboard/realestate/overview', '/api/dashboard/realestate/leads', '/api/dashboard/realestate/projects', '/api/dashboard/realestate/followups', '/api/dashboard/realestate/documents']) {
      expect((await api(user.otherManager!, OTHER).get(url)).status, url).toBe(404);
      expect((await api(ownerId, 1).get(url)).status, `owner on account 1 ${url}`).toBe(404);
      expect((await api(user.manager!, Q).get(url)).status, `${url} for the real estate business`).toBe(200);
    }
    const list = (await api(user.both!, Q).get('/api/dashboard/accounts')).body.accounts as { id: number; features: { realEstate: boolean } }[];
    expect(list.find((a) => a.id === Q)!.features.realEstate).toBe(true);
    expect(list.find((a) => a.id === OTHER)!.features.realEstate).toBe(false);
  });
});

describe('projects: only what staff entered and published is ever shown', () => {
  it('validates input, keeps drafts and archived projects away from customers, and never invents any', () => {
    expect(publishedProjects(Q)).toEqual([]);
    expect(() => createProject({ nameEn: '' }, 'test', Q)).toThrow(RealEstateError);
    expect(() => createProject({ nameEn: 'X', stage: 'launched' }, 'test', Q)).toThrow(/stage/);
    expect(() => createProject({ nameEn: 'x'.repeat(200) }, 'test', Q)).toThrow(/too long/);
    const draft = createProject({ nameEn: 'Harbour Residences', nameAr: 'هاربر ريزيدنسز', city: 'Jeddah', propertyType: 'Apartment', stage: 'under_construction', summaryEn: 'Recorded by staff.' }, 'test', Q);
    expect(draft.published).toBe(false);
    expect(publishedProjects(Q)).toEqual([]); // a draft is invisible
    const live = updateProject(draft.id, { published: true }, Q);
    expect(publishedProjects(Q).map((p) => p.id)).toEqual([live.id]);
    expect(searchPublishedProjects({ city: 'jeddah' }, Q)).toHaveLength(1);
    expect(searchPublishedProjects({ city: 'Riyadh' }, Q)).toHaveLength(0);
    expect(searchPublishedProjects({ propertyType: 'villa' }, Q)).toHaveLength(0);
    archiveProject(live.id, true, Q);
    expect(publishedProjects(Q)).toEqual([]); // archived = unpublished
    expect(getDb().prepare('SELECT published, archived FROM real_estate_projects WHERE id = ?').get(live.id)).toEqual({ published: 0, archived: 1 });
    archiveProject(live.id, false, Q);
    expect(publishedProjects(Q)).toEqual([]); // restoring does not republish on its own
  });

  it('a project and its brochure are scoped to their business: another business\'s project or document is "not found"', () => {
    const other = createProject({ nameEn: 'Other business project', published: true }, 'test', OTHER);
    expect(publishedProjects(Q).some((p) => p.id === other.id)).toBe(false);
    expect(() => updateProject(other.id, { city: 'X' }, Q)).toThrow(/not found/i);
    const foreignDoc = saveDocument({ originalName: 'foreign.pdf', mimeType: 'application/pdf', bytes: Buffer.from('%PDF-1.4 foreign'), visibility: 'customer', title: 'foreign', accountId: OTHER });
    expect(() => createProject({ nameEn: 'Uses a foreign brochure', brochureDocumentId: foreignDoc.id }, 'test', Q)).toThrow(/not one of this business/);
    const internalDoc = saveDocument({ originalName: 'internal.pdf', mimeType: 'application/pdf', bytes: Buffer.from('%PDF-1.4 internal'), visibility: 'internal', title: 'internal', accountId: Q });
    expect(() => createProject({ nameEn: 'Internal brochure', brochureDocumentId: internalDoc.id }, 'test', Q)).toThrow(/customer-visible/);
  });
});

describe('leads: one open enquiry per customer and kind, answers merged, nothing sensitive stored', () => {
  it('creates, merges and qualifies a buyer enquiry without ever duplicating it', () => {
    const c = newCustomer(Q);
    const first = upsertLeadFromAssistant({ customerId: c.id, kind: 'buyer', fields: { property_type: 'apartment', city: 'Jeddah' }, summary: 'Wants an apartment in Jeddah' }, Q);
    expect(first.created).toBe(true);
    expect(first.lead).toMatchObject({ kind: 'buyer', status: 'awaiting_info', priority: 'normal' });
    expect(first.lead.reference).toMatch(/^RE-\d{4}-\d{4}$/);
    const second = upsertLeadFromAssistant({ customerId: c.id, kind: 'buyer', fields: { budget: '1,500,000', currency: 'SAR', city: 'Jeddah north' } }, Q);
    expect(second.created).toBe(false);
    expect(second.lead.id).toBe(first.lead.id);
    expect(second.lead.details).toMatchObject({ property_type: 'apartment', city: 'Jeddah north', budget: '1,500,000', currency: 'SAR' }); // corrected city, earlier answers kept
    expect(second.lead).toMatchObject({ status: 'qualified' });
    expect(second.becameQualified).toBe(true);
    expect(upsertLeadFromAssistant({ customerId: c.id, kind: 'buyer', fields: { timeframe: 'three months' } }, Q).becameQualified).toBe(false); // staff hear once
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM real_estate_leads WHERE customer_id = ? AND kind = 'buyer'").get(c.id)).toEqual({ n: 1 });
    // a second kind is a second enquiry; a closed one does not block a new one
    expect(upsertLeadFromAssistant({ customerId: c.id, kind: 'seller', fields: { property_type: 'villa' } }, Q).created).toBe(true);
    updateLeadByStaff(first.lead.id, { status: 'closed' }, ownerId, () => true, Q);
    expect(upsertLeadFromAssistant({ customerId: c.id, kind: 'buyer', fields: { property_type: 'land' } }, Q).created).toBe(true);
    expect(openLeadsForCustomer(c.id, Q).map((l) => l.kind).sort()).toEqual(['buyer', 'seller']);
  });

  it('never overwrites a status a person chose, and keeps the audit trail', () => {
    const c = newCustomer(Q);
    const { lead } = upsertLeadFromAssistant({ customerId: c.id, kind: 'seller', fields: { property_type: 'villa', city: 'Jeddah', ownership_status: 'owner' } }, Q);
    expect(lead.status).toBe('qualified');
    updateLeadByStaff(lead.id, { status: 'follow_up', nextAction: 'Call back', followUpAt: '2026-12-01T09:00:00Z', documentsStatus: 'requested' }, ownerId, () => true, Q);
    const again = upsertLeadFromAssistant({ customerId: c.id, kind: 'seller', fields: { asking_price: '3 million' } }, Q);
    expect(again.lead).toMatchObject({ status: 'follow_up', nextAction: 'Call back', documentsStatus: 'requested' });
    const events = getDb().prepare('SELECT actor, event FROM real_estate_lead_events WHERE lead_id = ? ORDER BY id').all(lead.id) as { actor: string; event: string }[];
    expect(events[0]).toEqual({ actor: 'assistant', event: 'created' });
    expect(events.some((e) => e.actor === `staff:${ownerId}` && e.event === 'status')).toBe(true);
  });

  it('stores nothing that looks like an identity number, an IBAN or a card number', () => {
    const r = sanitizeFields({ notes: 'my IBAN SA03 8000 0000 6080 1016 7519', contact_name: 'Omar 4111 1111 1111 1111', preferred_contact: 'WhatsApp', ownership_status: 'ID 1234567890', budget: 1500000, bogus: 'x' });
    expect(r.sensitive).toBe(true);
    expect(r.fields).toEqual({ preferred_contact: 'WhatsApp', budget: '1500000' });
    expect(r.rejected.sort()).toEqual(['bogus', 'contact_name', 'notes', 'ownership_status']);
    const c = newCustomer(Q);
    const saved = upsertLeadFromAssistant({ customerId: c.id, kind: 'seller', fields: { notes: 'IBAN SA0380000000608010167519', city: 'Jeddah' } }, Q);
    expect(saved.sensitive).toBe(true);
    expect(JSON.stringify(saved.lead.details)).not.toMatch(/SA03|8000/);
  });

  it('records interest only in published projects of this business', () => {
    const mine = createProject({ nameEn: 'Interest Tower', published: true }, 'test', Q);
    const draft = createProject({ nameEn: 'Draft Tower' }, 'test', Q);
    const foreign = createProject({ nameEn: 'Foreign Tower', published: true }, 'test', OTHER);
    const c = newCustomer(Q);
    const r = upsertLeadFromAssistant({ customerId: c.id, kind: 'buyer', fields: { property_type: 'apartment' }, projectIds: [mine.id, draft.id, foreign.id, 99999] }, Q);
    expect(r.linkedProjects).toEqual([mine.id]);
  });

  it('a customer of another business is "not found" for this business', () => {
    const stranger = newCustomer(OTHER);
    expect(() => upsertLeadFromAssistant({ customerId: stranger.id, kind: 'buyer', fields: { city: 'X' } }, Q)).toThrow(/Customer not found/);
  });
});

describe('the WhatsApp conversation', () => {
  async function onMainMenu(language: 'en' | 'ar' = 'en'): Promise<string> {
    const waId = `96651${String(++counter).padStart(7, '0')}`;
    await say(waId, 'hi');
    await say(waId, language === 'ar' ? '1' : '2');
    return waId;
  }
  const stateOf = (waId: string) => (getDb().prepare('SELECT menu_state AS s FROM customers WHERE wa_id = ? AND whatsapp_account_id = ?').get(waId, Q) as { s: string }).s;

  it('Buy / Sell open a guided conversation: the next messages, even a single digit, go to the assistant, and 0 returns to the menu', async () => {
    const waId = await onMainMenu('en');
    const buy = (await say(waId, '1')).join('\n');
    expect(buy).toContain('Buy a Property');
    expect(buy).not.toMatch(/\{[a-z_]+\}/);
    expect(stateOf(waId)).toBe(MENU_STATES.REAL_ESTATE_CHAT);
    expect(runAgentLoop).not.toHaveBeenCalled(); // the menu answered, not the AI
    await say(waId, 'I want an apartment in Jeddah');
    expect(runAgentLoop).toHaveBeenCalledTimes(1);
    await say(waId, '3'); // "3 bedrooms" must not open menu option 3
    expect(runAgentLoop).toHaveBeenCalledTimes(2);
    expect(stateOf(waId)).toBe(MENU_STATES.REAL_ESTATE_CHAT);
    const back = (await say(waId, '0')).join('\n');
    expect(back).toContain('How can we help you today?');
    expect(stateOf(waId)).toBe(MENU_STATES.MAIN_MENU);
    expect(runAgentLoop).toHaveBeenCalledTimes(2);
    const sell = (await say(waId, '2')).join('\n');
    expect(sell).toContain('Sell a Property');
    expect(sell).toMatch(/do not send ownership papers/);
    expect(stateOf(waId)).toBe(MENU_STATES.REAL_ESTATE_CHAT);
  });

  it('works in Arabic, and "menu" or a request for a person still leaves the conversation', async () => {
    const waId = await onMainMenu('ar');
    expect((await say(waId, '1')).join('\n')).toContain('شراء عقار');
    expect(stateOf(waId)).toBe(MENU_STATES.REAL_ESTATE_CHAT);
    expect((await say(waId, 'القائمة')).join('\n')).toContain('كيف يمكننا خدمتك اليوم');
    await say(waId, '2');
    await say(waId, 'agent');
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM human_handoffs WHERE customer_id = (SELECT id FROM customers WHERE wa_id = ? AND whatsapp_account_id = ?)").get(waId, Q)).toEqual({ n: 1 });
  });

  it('Explore Our Projects says so plainly when nothing is published, and lists only published projects when something is', async () => {
    getDb().prepare('DELETE FROM real_estate_projects').run();
    const waId = await onMainMenu('en');
    const none = (await say(waId, '3')).join('\n');
    expect(none).toContain('no projects published');
    expect(none).not.toMatch(/🏗️ [A-Z][a-z]+ [A-Z]/); // no project line
    createProject({ nameEn: 'Visible Heights', city: 'Jeddah', propertyType: 'Apartment', stage: 'completed', published: true }, 'test', Q);
    createProject({ nameEn: 'Hidden Draft Towers' }, 'test', Q);
    createProject({ nameEn: 'Other Business Plaza', published: true }, 'test', OTHER);
    await say(waId, '0');
    const list = (await say(waId, '3')).join('\n');
    expect(list).toContain('Visible Heights');
    expect(list).toContain('Jeddah');
    expect(list).not.toContain('Hidden Draft Towers');
    expect(list).not.toContain('Other Business Plaza');
    expect(list).not.toContain('no projects published');
  });

  it('the assistant sees the customer\'s own open enquiry (to resume it) and the published projects, and nothing of another customer or business', async () => {
    const waId = await onMainMenu('en');
    await say(waId, '1');
    const customer = getDb().prepare('SELECT id FROM customers WHERE wa_id = ? AND whatsapp_account_id = ?').get(waId, Q) as { id: number };
    upsertLeadFromAssistant({ customerId: customer.id, kind: 'buyer', fields: { property_type: 'villa', city: 'Jeddah' } }, Q);
    const stranger = newCustomer(Q);
    upsertLeadFromAssistant({ customerId: stranger.id, kind: 'buyer', fields: { property_type: 'castle', city: 'Narnia' } }, Q);
    await say(waId, 'my budget is two million');
    const prompt = String(vi.mocked(runAgentLoop).mock.calls.at(-1)![0].systemPrompt);
    expect(prompt).toContain('ACTIVE ENQUIRIES OF THIS CUSTOMER');
    expect(prompt).toMatch(/RE-\d{4}-\d{4} \(buyer/);
    expect(prompt).toContain('villa');
    expect(prompt).not.toContain('castle');
    expect(prompt).not.toContain('Narnia');
    expect(prompt).toContain('Visible Heights');
    expect(prompt).not.toContain('Hidden Draft Towers');
    expect(prompt).not.toContain('Other Business Plaza');
    expect(prompt).toMatch(/NEVER: invent or imply a property/);
    // another business gets none of this
    const otherPrompt = runWithAccount(OTHER, () => buildSystemPrompt(KNOWLEDGE_EMPTY, 'en', new Date(), { customerId: customer.id }));
    expect(otherPrompt).not.toMatch(/REAL ESTATE ASSISTANT|Visible Heights|villa/);
  });
});

describe('the assistant tools', () => {
  const call = (name: string, args: unknown, conversationId: number, account = Q) => runWithAccount(account, () => toolRegistry[name]!.handler(args, { conversationId }));

  it('save_real_estate_lead saves through the conversation it runs in, moves the customer into the guided conversation, and alerts staff once', async () => {
    const c = newCustomer(Q);
    updateBusinessSettings({ staffWhatsappNumber: '966500000000' }, Q); // where the staff alert goes
    const result = (await call('save_real_estate_lead', { kind: 'buyer', fields: { property_type: 'apartment', city: 'Jeddah', budget: '1,200,000' }, summary: 'Buyer, apartment in Jeddah' }, c.conversationId)) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: true, status: 'qualified', created: true });
    expect(String(result.note)).toMatch(/Nothing is booked or confirmed/);
    expect(getDb().prepare('SELECT menu_state AS s FROM customers WHERE id = ?').get(c.id)).toEqual({ s: MENU_STATES.REAL_ESTATE_CHAT });
    const alerts = getDb().prepare("SELECT body, dedupe_key FROM notification_outbox WHERE dedupe_key LIKE 're-lead:%' AND whatsapp_account_id = ?").all(Q) as { body: string; dedupe_key: string }[];
    expect(alerts.filter((a) => a.body.includes('Buyer, apartment in Jeddah'))).toHaveLength(1);
    await call('save_real_estate_lead', { kind: 'buyer', fields: { timeframe: 'soon' } }, c.conversationId);
    expect((getDb().prepare("SELECT COUNT(*) AS n FROM notification_outbox WHERE dedupe_key LIKE 're-lead:qualified:%' AND body LIKE ?").get('%Buyer, apartment in Jeddah%') as { n: number }).n).toBe(1);
  });

  it('a conversation of another business is "not found", and the sensitive-data warning reaches the model', async () => {
    const stranger = newCustomer(OTHER);
    expect(await call('save_real_estate_lead', { kind: 'buyer', fields: { city: 'X' } }, stranger.conversationId)).toEqual({ error: 'conversation_not_found' });
    const c = newCustomer(Q);
    const r = (await call('save_real_estate_lead', { kind: 'seller', fields: { notes: 'IBAN SA0380000000608010167519', city: 'Jeddah' } }, c.conversationId)) as Record<string, unknown>;
    expect(String(r.warning)).toMatch(/NOT stored/);
  });

  it('search_real_estate_projects returns only published projects of this business and says when there are none', async () => {
    getDb().prepare('DELETE FROM real_estate_projects').run();
    const c = newCustomer(Q);
    const empty = (await call('search_real_estate_projects', { city: 'Jeddah' }, c.conversationId)) as { published_projects: number; matches: unknown[]; note?: string };
    expect(empty).toMatchObject({ published_projects: 0, matches: [] });
    expect(empty.note).toMatch(/No project is published/);
    const p = createProject({ nameEn: 'Tool Tower', city: 'Jeddah', published: true }, 'test', Q);
    createProject({ nameEn: 'Tool Draft', city: 'Jeddah' }, 'test', Q);
    createProject({ nameEn: 'Tool Foreign', city: 'Jeddah', published: true }, 'test', OTHER);
    const found = (await call('search_real_estate_projects', { city: 'Jeddah' }, c.conversationId)) as { matches: { id: number; name_en: string }[] };
    expect(found.matches.map((m) => m.name_en)).toEqual(['Tool Tower']);
    expect(found.matches[0]!.id).toBe(p.id);
  });

  it('send_project_brochure sends the project\'s own customer-visible file, and refuses everything else', async () => {
    const c = newCustomer(Q);
    const doc = saveDocument({ originalName: 'brochure.pdf', mimeType: 'application/pdf', bytes: Buffer.from('%PDF-1.4 brochure bytes'), visibility: 'customer', title: 'Brochure', accountId: Q });
    const project = createProject({ nameEn: 'Brochure Heights', published: true, brochureDocumentId: doc.id }, 'test', Q);
    const noBrochure = createProject({ nameEn: 'No Brochure Plaza', published: true }, 'test', Q);
    const draft = createProject({ nameEn: 'Draft With Brochure', brochureDocumentId: doc.id }, 'test', Q);
    expect(await call('send_project_brochure', { project_id: noBrochure.id }, c.conversationId)).toEqual({ sent: false, reason: 'no_brochure' });
    expect(await call('send_project_brochure', { project_id: draft.id }, c.conversationId)).toEqual({ sent: false, reason: 'not_available' });
    expect(await call('send_project_brochure', { project_id: 424242 }, c.conversationId)).toEqual({ sent: false, reason: 'not_available' });
    expect(sendDocumentMessage).not.toHaveBeenCalled();
    expect(await call('send_project_brochure', { project_id: project.id }, c.conversationId)).toMatchObject({ sent: true });
    expect(sendDocumentMessage).toHaveBeenCalledTimes(1);
    const [to, payload] = vi.mocked(sendDocumentMessage).mock.calls[0]!;
    expect(to).toBe(c.waId);
    expect(payload).toMatchObject({ fileName: 'brochure.pdf', mimeType: 'application/pdf', caption: 'Brochure Heights' });
    expect((payload.bytes as Buffer).toString()).toBe('%PDF-1.4 brochure bytes');
    // the same project asked for from another business's conversation: not found there
    const stranger = newCustomer(OTHER);
    expect(await call('send_project_brochure', { project_id: project.id }, stranger.conversationId, OTHER)).toEqual({ sent: false, reason: 'not_available' });
    expect(sendDocumentMessage).toHaveBeenCalledTimes(1);
  });
});

describe('the staff dashboard', () => {
  let leadId: number;
  beforeAll(() => {
    const c = newCustomer(Q);
    leadId = upsertLeadFromAssistant({ customerId: c.id, kind: 'seller', fields: { property_type: 'villa', city: 'Jeddah', ownership_status: 'owner' }, summary: 'Seller villa', needsStaff: true }, Q).lead.id;
    getDb().prepare("INSERT INTO customer_files (whatsapp_account_id, customer_id, direction, kind, original_name, stored_name, extension, mime_type, size_bytes, status, processing) VALUES (?, ?, 'inbound', 'document', 'plan.pdf', 'stored-plan.pdf', 'pdf', 'application/pdf', 10, 'stored', 'stored')").run(Q, c.id);
  });

  it('lists and shows leads with masked numbers and the information still missing', async () => {
    const list = (await api(user.manager!, Q).get('/api/dashboard/realestate/leads?kind=seller')).body as { total: number; items: { id: number; waMasked: string; missing: string[]; priority: string }[] };
    expect(list.total).toBeGreaterThan(0);
    const item = list.items.find((l) => l.id === leadId)!;
    expect(item.waMasked).toMatch(/^•+\d{4}$/);
    expect(item.priority).toBe('high');
    expect(item.missing.length).toBeGreaterThan(0);
    const detail = (await api(user.manager!, Q).get(`/api/dashboard/realestate/leads/${leadId}`)).body;
    expect(detail.lead.reference).toMatch(/^RE-/);
    expect(detail.customer.waMasked).toMatch(/^•+\d{4}$/);
    expect(detail.files.some((f: { original_name: string; downloadUrl: string }) => f.original_name === 'plan.pdf' && /\/customers\/files\/\d+\/download$/.test(f.downloadUrl))).toBe(true);
    expect(JSON.stringify(detail)).not.toMatch(/stored-plan\.pdf|stored_name/); // no server file name is exposed
  });

  it('a view-only user can read but not change; a manager can update, assign and follow up; the audit trail records who', async () => {
    expect((await api(user.viewer!, Q).get('/api/dashboard/realestate/leads')).status).toBe(200);
    expect((await api(user.viewer!, Q).patch(`/api/dashboard/realestate/leads/${leadId}`, { status: 'closed' })).status).toBe(403);
    expect((await api(user.viewer!, Q).post('/api/dashboard/realestate/projects', { nameEn: 'Nope' })).status).toBe(403);
    const ok = await api(user.manager!, Q).patch(`/api/dashboard/realestate/leads/${leadId}`, { status: 'assigned', assignedAdminId: user.manager, nextAction: 'Call the owner', followUpAt: '2026-01-01T09:00:00Z', documentsStatus: 'requested', note: 'Spoke briefly' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.lead).toMatchObject({ status: 'assigned', assignedAdminId: user.manager, nextAction: 'Call the owner', documentsStatus: 'requested', needsStaff: false });
    const events = getDb().prepare('SELECT actor, event FROM real_estate_lead_events WHERE lead_id = ?').all(leadId) as { actor: string; event: string }[];
    expect(events.filter((e) => e.actor === `staff:${user.manager}`).map((e) => e.event)).toEqual(expect.arrayContaining(['status', 'assigned', 'documents', 'note']));
    const bad = await api(user.manager!, Q).patch(`/api/dashboard/realestate/leads/${leadId}`, { status: 'won' });
    expect(bad.status).toBe(400);
    // someone without access to this business cannot be assigned to its leads
    const stranger = await api(user.manager!, Q).patch(`/api/dashboard/realestate/leads/${leadId}`, { assignedAdminId: user.otherManager });
    expect(stranger.status).toBe(400);
  });

  it('follow-ups include the leads that need a person and the consultation requests; documents list customer files with their review status', async () => {
    const c = newCustomer(Q);
    getDb().prepare("INSERT INTO customer_requests (reference, customer_id, wa_id, kind, payload, whatsapp_account_id) VALUES ('APT-2026-7777', ?, ?, 'appointment', ?, ?)").run(c.id, c.waId, JSON.stringify({ service: 'Selling a villa', date: 'Sunday', time: 'Afternoon, WhatsApp' }), Q);
    const follow = (await api(user.manager!, Q).get('/api/dashboard/realestate/followups')).body;
    expect(follow.consultations.some((r: { reference: string; topic: string }) => r.reference === 'APT-2026-7777' && r.topic === 'Selling a villa')).toBe(true);
    const docs = (await api(user.manager!, Q).get('/api/dashboard/realestate/documents')).body;
    expect(docs.files.some((f: { original_name: string; reviewStatus: string; leadReference: string }) => f.original_name === 'plan.pdf' && f.leadReference.startsWith('RE-'))).toBe(true);
  });

  it('projects: create, edit, publish and archive through the API; a user of another business cannot see or change them', async () => {
    const created = await api(user.manager!, Q).post('/api/dashboard/realestate/projects', { nameEn: 'API Project', city: 'Jeddah', stage: 'upcoming' });
    expect(created.status).toBe(201);
    const id = created.body.project.id as number;
    expect(created.body.project.customerVisible).toBe(false);
    expect((await api(user.manager!, Q).put(`/api/dashboard/realestate/projects/${id}`, { published: true, summaryEn: 'Recorded' })).body.project.customerVisible).toBe(true);
    expect((await api(user.manager!, Q).post('/api/dashboard/realestate/projects', { nameEn: '' })).status).toBe(400);
    expect((await api(user.manager!, Q).put(`/api/dashboard/realestate/projects/${id}`, { stage: 'launched' })).status).toBe(400);
    // the other business has no access to the add-on at all, and cannot reach this project by id either
    expect((await api(user.otherManager!, OTHER).put(`/api/dashboard/realestate/projects/${id}`, { published: false })).status).toBe(404);
    expect((await api(user.otherManager!, Q).get('/api/dashboard/realestate/projects')).status).toBe(403); // header for a business the user cannot open
    expect((await api(user.manager!, Q).post(`/api/dashboard/realestate/projects/${id}/archive`, { archived: true })).body.project).toMatchObject({ archived: true, customerVisible: false });
  });

  it('a lead id of the real estate business is unreachable from another business', async () => {
    expect((await api(user.both!, OTHER).get(`/api/dashboard/realestate/leads/${leadId}`)).status).toBe(404);
    expect((await api(user.both!, OTHER).patch(`/api/dashboard/realestate/leads/${leadId}`, { status: 'closed' })).status).toBe(404);
    expect(getLead(leadId, OTHER)).toBeNull();
    expect(listLeads({ status: 'all' }, OTHER).total).toBe(0);
  });

  it('the overview counts this business\'s own enquiries, projects and consultation requests', async () => {
    const o = (await api(user.manager!, Q).get('/api/dashboard/realestate/overview')).body;
    expect(o.leads.total).toBeGreaterThan(0);
    expect(o.leads.byKind.seller).toBeGreaterThan(0);
    expect(o.projects.published + o.projects.draft + o.projects.archived).toBeGreaterThan(0);
    expect(o.consultations.pending).toBeGreaterThan(0);
  });
});

describe('the other businesses are untouched', () => {
  it('have no real estate enquiries or events, no real estate templates, and their conversations never reach the add-on', () => {
    const db = getDb();
    for (const t of ['real_estate_leads', 'real_estate_lead_events']) expect(db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE whatsapp_account_id IN (1, ?)`).get(OTHER)).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM reply_templates WHERE key IN ('re_buy', 're_sell', 're_projects', 're_projects_none') AND whatsapp_account_id <> ?").get(Q)).toEqual({ n: 0 });
  });
});
