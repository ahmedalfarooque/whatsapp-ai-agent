import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * QMULATE journeys through the REAL application pipeline (inbound message → menu / rules → system prompt → agent loop → real tool handlers → database →
 * outbox) with disposable data. Only the two outside edges are replaced: WhatsApp delivery (a stub that records what would have been sent) and the AI
 * provider (a scripted stand-in for the model that records what the pipeline sent it). Nothing here sends a real WhatsApp message or calls a real model.
 */
vi.mock('../../src/whatsapp/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/whatsapp/client')>();
  return { ...real, sendTextMessage: vi.fn(), sendInteractiveMessage: vi.fn(), sendImageMessage: vi.fn(), sendDocumentMessage: vi.fn() };
});
vi.mock('../../src/llm/openRouterClient', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/llm/openRouterClient')>();
  return { ...real, chatCompletion: vi.fn() };
});

import { sendTextMessage } from '../../src/whatsapp/client';
import { chatCompletion } from '../../src/llm/openRouterClient';
import type { ChatMessage } from '../../src/llm/types';
import { createApp } from '../../src/app';
import { getDb } from '../../src/memory/db';
import { processInboundMessage } from '../../src/pipeline/processInboundMessage';
import { claimWebhookEvent } from '../../src/pipeline/idempotency';
import { createAccount } from '../../src/accounts/accountRepo';
import { runWithAccount } from '../../src/accounts/accountContext';
import { provisionBlueprint } from '../../src/accounts/blueprint';
import { QMULATE_BLUEPRINT } from '../../src/accounts/blueprints/qmulate';
import { createSession } from '../../src/dashboard/auth';
import { SESSION_COOKIE_NAME } from '../../src/dashboard/authMiddleware';
import { updateBusinessSettings } from '../../src/config/businessSettings';
import { businessNotificationJid, staffAlertDestination } from '../../src/requests/requestService';
import { flushOutbox, registerOutboxSender, NotConnectedError } from '../../src/notifications/outbox';
import { recordQrSessionConnected, clearQrSessionIdentity } from '../../src/memory/qrSessionRepo';
import { TINY_PNG } from '../fixtures/makePdf';
import { createProject, openLeadsForCustomer } from '../../src/realestate/realEstateRepo';

const OWNER = 'owner@example.com';
const PASSWORD = 'a-very-long-test-password-123';
const KNOWLEDGE_EMPTY = { sections: [], asPromptText: '' };
const STAFF = '966500000111';

let Q: number; // the real estate business
let OTHER: number; // an unrelated business without the add-on
let ownerId: number;
let managerId: number;
let counter = 0;
const sent: string[] = [];

const app = createApp();
const cookieOf = (id: number) => `${SESSION_COOKIE_NAME}=${createSession(id).token}`;
const api = (id: number, account: number) => ({
  get: (url: string) => request(app).get(url).set('Cookie', cookieOf(id)).set('X-Whatsapp-Account', String(account)),
  put: (url: string, body: unknown = {}) => request(app).put(url).set('Cookie', cookieOf(id)).set('X-Whatsapp-Account', String(account)).send(body as object),
  post: (url: string, body: unknown = {}) => request(app).post(url).set('Cookie', cookieOf(id)).set('X-Whatsapp-Account', String(account)).send(body as object),
});

// ---- the scripted stand-in for the AI model -------------------------------------------------------------------------------------------------------
interface Seen { system: string; all: string; lastTool: Record<string, unknown> | null; toolNames: string[] }
type Step = (seen: Seen) => ChatMessage;
const script: Step[] = [];
const observed: Seen[] = [];
const call = (id: string, name: string, args: unknown): ChatMessage => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const reply = (text: string): ChatMessage => ({ role: 'assistant', content: text });

function newWaId(): string { return `96551${String(++counter).padStart(7, '0')}`; }

async function say(waId: string, text: string, accountId = Q, messageId?: string): Promise<string[]> {
  sent.length = 0;
  await processInboundMessage({ waId, messageId: messageId ?? `wamid.rej.${accountId}.${++counter}`, timestamp: Date.now(), type: 'text', text, accountId }, { knowledge: KNOWLEDGE_EMPTY });
  return sent.splice(0, sent.length);
}

/** A customer who has chosen English and picked "Buy a Property" or "Sell a Property" (main menu 1 / 2). */
async function inGuidedChat(option: '1' | '2'): Promise<string> {
  const waId = newWaId();
  await say(waId, 'hi');
  await say(waId, '2'); // English
  await say(waId, option);
  return waId;
}

const customerOf = (waId: string, account = Q) => getDb().prepare('SELECT id FROM customers WHERE wa_id = ? AND whatsapp_account_id = ?').get(waId, account) as { id: number };
const leadsOf = (waId: string) => getDb().prepare('SELECT * FROM real_estate_leads WHERE customer_id = ? AND whatsapp_account_id = ? ORDER BY id').all(customerOf(waId).id, Q) as Array<Record<string, unknown> & { id: number; reference: string; status: string; needs_staff: number; priority: string; details: string; kind: string }>;
const alertsFor = (leadId: number, key: string) => (getDb().prepare('SELECT COUNT(*) AS n FROM notification_outbox WHERE whatsapp_account_id = ? AND dedupe_key = ?').get(Q, `re-lead:${key}:${Q}:${leadId}`) as { n: number }).n;
const eventsOf = (leadId: number) => (getDb().prepare('SELECT event FROM real_estate_lead_events WHERE lead_id = ? ORDER BY id').all(leadId) as { event: string }[]).map((e) => e.event);
const storedMessages = (waId: string) => (getDb().prepare('SELECT m.content FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id JOIN customers cu ON cu.id = c.customer_id WHERE cu.wa_id = ?').all(waId) as { content: string }[]).map((m) => m.content).join('\n');

beforeAll(async () => {
  getDb();
  expect((await request(app).post('/api/dashboard/auth/setup').send({ username: OWNER, password: PASSWORD })).status).toBe(201);
  ownerId = (getDb().prepare('SELECT id FROM admin_users WHERE username = ?').get(OWNER) as { id: number }).id;
  const logo = path.join(os.tmpdir(), `rej-logo-${process.pid}.png`);
  fs.writeFileSync(logo, TINY_PNG);
  Q = provisionBlueprint(QMULATE_BLUEPRINT, { actor: 'test', logo: { path: logo } }).accountId;
  fs.rmSync(logo, { force: true });
  OTHER = createAccount({ name: 'Paint Shop Fixture', nameAr: 'محل دهانات' }).id;
  const res = await request(app).post('/api/dashboard/users').set('Cookie', cookieOf(ownerId)).send({ password: PASSWORD, email: 'manager@example.com', role: 'manager', accountIds: [Q] });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  managerId = res.body.id;
});

beforeEach(() => {
  script.length = 0;
  observed.length = 0;
  registerOutboxSender(null);
  updateBusinessSettings({ staffWhatsappNumber: STAFF }, Q);
  vi.mocked(sendTextMessage).mockReset().mockImplementation(async (_to, body) => { sent.push(String(body)); return { messaging_product: 'whatsapp', contacts: [], messages: [{ id: 't' }] }; });
  vi.mocked(chatCompletion).mockReset().mockImplementation(async (req) => {
    const messages = req.messages as ChatMessage[];
    const tools = messages.filter((m) => m.role === 'tool');
    const seen: Seen = {
      system: String(messages[0]?.content ?? ''),
      all: messages.map((m) => String(m.content ?? '')).join('\n'),
      lastTool: tools.length ? (JSON.parse(String(tools[tools.length - 1]!.content)) as Record<string, unknown>) : null,
      toolNames: ((req.tools ?? []) as Array<{ function: { name: string } }>).map((t) => t.function.name),
    };
    observed.push(seen);
    const step = script.shift();
    const message = step ? step(seen) : reply('(no scripted answer)');
    return { choices: [{ index: 0, finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message }] };
  });
});

afterAll(() => { registerOutboxSender(null); });

describe('buyer journey', () => {
  it('asks progressively, remembers what it was told, keeps one enquiry and never asks a known question again', async () => {
    const waId = await inGuidedChat('1');
    script.push(
      () => call('a1', 'save_real_estate_lead', { kind: 'buyer', fields: { property_type: 'apartment', city: 'Jeddah' }, summary: 'Buyer looking for an apartment in Jeddah.' }),
      () => reply('Thank you. What budget do you have in mind, and is it for your own use or an investment?'),
    );
    const first = await say(waId, 'I want to buy an apartment in Jeddah');
    expect(first.join('\n')).toContain('What budget');
    let leads = leadsOf(waId);
    expect(leads).toHaveLength(1);
    const reference = leads[0]!.reference;
    expect(leads[0]!.status).toBe('awaiting_info');
    // the model was told what is already known and what is still missing: it is never invited to ask the same question again
    const afterSave = observed[1]!.lastTool!;
    expect(afterSave).toMatchObject({ ok: true, created: true, reference });
    expect(afterSave.still_missing).not.toContain('Property type');
    expect(afterSave.still_missing).not.toContain('City');
    expect((afterSave.ask_next as string[]).length).toBeLessThanOrEqual(2);
    expect(String(afterSave.note)).toMatch(/Nothing is booked or confirmed/);

    // second answer: the system prompt now carries the open enquiry, so the conversation resumes instead of starting again
    script.push(
      () => call('a2', 'save_real_estate_lead', { kind: 'buyer', fields: { budget: '1,500,000', currency: 'SAR', purpose: 'investment', timeframe: '3 months' } }),
      () => reply('Thank you, that helps our team. An advisor will review it and follow up.'),
    );
    const second = await say(waId, 'around 1.5 million riyals, as an investment, within 3 months');
    expect(second.join('\n')).toContain('An advisor will review it');
    const prompt2 = observed[2]!.system;
    expect(prompt2).toContain('ACTIVE ENQUIRIES OF THIS CUSTOMER');
    expect(prompt2).toContain(reference);
    expect(prompt2).toMatch(/Known: .*Property type: apartment.*City: Jeddah/);
    leads = leadsOf(waId);
    expect(leads).toHaveLength(1); // merged, not duplicated
    expect(leads[0]!.reference).toBe(reference);
    expect(leads[0]!.status).toBe('qualified');
    expect(JSON.parse(leads[0]!.details)).toMatchObject({ property_type: 'apartment', city: 'Jeddah', budget: '1,500,000', purpose: 'investment', timeframe: '3 months' });
    expect(alertsFor(leads[0]!.id, 'qualified')).toBe(1); // the team is told once, when the enquiry becomes qualified

    // third message: what was answered is no longer on the "still missing" list handed to the model
    script.push(() => reply('Noted.'));
    await say(waId, 'thanks');
    const missingLine = /Still missing: ([^\n]*)/.exec(observed[4]!.system)![1]!;
    for (const known of ['Property type', 'City', 'Budget', 'Purpose', 'Timeframe']) expect(missingLine).not.toContain(known);
    expect(openLeadsForCustomer(customerOf(waId).id, Q)).toHaveLength(1);
    expect(eventsOf(leads[0]!.id)).toEqual(expect.arrayContaining(['created', 'alert_queued']));
  });

  it('project enquiries: none published → nothing is named; approved → only the approved one with its recorded details; no match → no invention', async () => {
    getDb().prepare('DELETE FROM real_estate_projects WHERE whatsapp_account_id IN (?, ?)').run(Q, OTHER);
    const waId = await inGuidedChat('1');

    // no project exists
    script.push(
      () => call('p1', 'search_real_estate_projects', { property_type: 'apartment', city: 'Jeddah' }),
      () => reply('There is no verified project that matches yet; our team will review your requirements.'),
    );
    await say(waId, 'do you have apartment projects in Jeddah?');
    expect(observed[0]!.system).toContain('PUBLISHED PROJECTS: none');
    expect(observed[0]!.toolNames).toEqual(expect.arrayContaining(['search_real_estate_projects', 'save_real_estate_lead', 'send_project_brochure']));
    expect(observed[1]!.lastTool).toMatchObject({ published_projects: 0, matches: [] });
    expect(String(observed[1]!.lastTool!.note)).toMatch(/No project is published yet.*Do not name or describe any project/);

    // approved, draft and another business's project
    const approved = createProject({ nameEn: 'Verified Heights', city: 'Jeddah', district: 'Al Shati', propertyType: 'Apartments', stage: 'completed', summaryEn: 'Recorded by staff.', published: true }, 'test', Q);
    const draft = createProject({ nameEn: 'Hidden Draft Towers', city: 'Jeddah', propertyType: 'Apartments' }, 'test', Q);
    const foreign = createProject({ nameEn: 'Other Business Plaza', city: 'Jeddah', propertyType: 'Apartments', published: true }, 'test', OTHER);
    script.push(
      () => call('p2', 'search_real_estate_projects', { property_type: 'apartment', city: 'Jeddah' }),
      () => call('p3', 'save_real_estate_lead', { kind: 'buyer', fields: { property_type: 'apartment', city: 'Jeddah' }, interested_project_ids: [approved.id, draft.id, foreign.id] }),
      () => call('p4', 'send_project_brochure', { project_id: draft.id }),
      () => reply('Verified Heights in Al Shati, Jeddah is a completed apartment project. Our team can tell you more.'),
    );
    await say(waId, 'show me what you have');
    expect(observed[2]!.system).toContain('Verified Heights');
    expect(observed[2]!.system).not.toContain('Hidden Draft Towers');
    expect(observed[2]!.system).not.toContain('Other Business Plaza');
    const search = observed[3]!.lastTool as { matches: Array<Record<string, unknown>>; published_projects: number };
    expect(search.published_projects).toBe(1);
    expect(search.matches).toHaveLength(1);
    expect(Object.keys(search.matches[0]!).sort()).toEqual(['city', 'district', 'has_brochure', 'id', 'name_ar', 'name_en', 'property_type', 'stage', 'summary']); // recorded facts only: no price, availability or return exists to be invented
    expect(JSON.stringify(search)).not.toMatch(/Hidden Draft|Other Business|price|yield|return/i);
    expect(observed[4]!.lastTool).toMatchObject({ ok: true, linked_projects: [approved.id] }); // interest is recorded only for the approved project of this business
    expect(observed[5]!.lastTool).toEqual({ sent: false, reason: 'not_available' }); // a draft brochure is never sent

    // a requirement nothing matches
    script.push(
      () => call('p5', 'search_real_estate_projects', { property_type: 'villa', city: 'Riyadh' }),
      () => reply('No verified project matches that yet; I have noted your requirements for our team.'),
    );
    await say(waId, 'what about a villa in Riyadh?');
    expect(observed[7]!.lastTool).toMatchObject({ matches: [] });
    expect(String(observed[7]!.lastTool!.note)).toMatch(/No published project matches\. Do not invent one/);
  });
});

describe('seller journey', () => {
  it('gathers the property progressively, never claims to verify ownership, and never keeps or forwards an ID, IBAN or card number', async () => {
    const waId = await inGuidedChat('2');
    script.push(
      () => call('s1', 'save_real_estate_lead', { kind: 'seller', fields: { property_type: 'villa', city: 'Jeddah' }, summary: 'Owner wants to sell a villa in Jeddah.' }),
      () => reply('I have noted your villa in Jeddah. Are you the registered owner, and what price do you expect?'),
    );
    const text = 'I want to sell my villa in Jeddah. My ID is 1234567890, my IBAN is SA03 8000 0000 6080 1016 7519 and my card is 4111 1111 1111 1111. Call me on 0533339052.';
    await say(waId, text);

    // the model never saw the sensitive values, only that they were removed (and it is told what to do about it)
    const toModel = observed[0]!.all;
    for (const secret of ['1234567890', 'SA03 8000', '6080 1016', '4111 1111']) expect(toModel).not.toContain(secret);
    expect(toModel).toContain('[ID number removed]');
    expect(toModel).toContain('[bank number removed]');
    expect(toModel).toContain('[card number removed]');
    expect(toModel).toContain('0533339052'); // an ordinary phone number is not touched
    expect(observed[0]!.system).toMatch(/Do not claim you can verify ownership or legality/);
    expect(observed[0]!.system).toMatch(/\[bank number removed\].*Never ask them to resend it/s);
    // nor were they stored
    const stored = storedMessages(waId);
    for (const secret of ['1234567890', 'SA03 8000', '4111 1111']) expect(stored).not.toContain(secret);
    expect(stored).toContain('[ID number removed]');
    const [lead] = leadsOf(waId);
    expect(lead!.kind).toBe('seller');
    expect(lead!.details + String(lead!.summary)).not.toMatch(/1234567890|SA03|4111/);
    expect(JSON.parse(lead!.details)).not.toHaveProperty('ownership_status'); // nothing is claimed or verified that the customer has not stated

    // the next answer adds to the same enquiry: ownership is recorded as what the customer SAID, and the assistant's tools offer nothing to verify it
    script.push(
      () => call('s2', 'save_real_estate_lead', { kind: 'seller', fields: { ownership_status: 'says they are the owner', asking_price: '3,000,000' } }),
      () => reply('Thank you. Our advisor will explain which documents are needed and how to send them securely.'),
    );
    await say(waId, 'I am the owner, I expect around 3 million');
    expect(observed[2]!.toolNames).not.toContain('verify_ownership');
    expect(leadsOf(waId)).toHaveLength(1);
    expect(JSON.parse(leadsOf(waId)[0]!.details)).toMatchObject({ property_type: 'villa', ownership_status: 'says they are the owner' });
  });

  it('Arabic-Indic digits are removed too, and a business without the add-on is not affected at all', async () => {
    const waId = await inGuidedChat('2');
    script.push(() => reply('تم، لا ترسل هذه الأرقام.'));
    await say(waId, 'رقم هويتي ١٢٣٤٥٦٧٨٩٠ وأريد بيع فيلا');
    expect(observed[0]!.all).not.toContain('١٢٣٤٥٦٧٨٩٠');
    expect(observed[0]!.all).toContain('[ID number removed]');

    // another business: the same text is stored exactly as written (the protection belongs to the add-on only)
    const other = newWaId();
    await say(other, 'my iban is SA0380000000608010167519', OTHER);
    expect(storedMessages(other)).toContain('SA0380000000608010167519');
  });
});

describe('consultation request', () => {
  it('records a request for the team, never a confirmed booking, and queues the staff alert', async () => {
    const waId = newWaId();
    await say(waId, 'hi');
    await say(waId, '2');
    const intro = (await say(waId, '7')).join('\n');
    expect(intro).toContain('Request a Consultation');
    await say(waId, 'Layla Hassan');
    await say(waId, 'Development & Investment');
    await say(waId, 'next Sunday');
    await say(waId, 'afternoon, WhatsApp');
    const confirm = (await say(waId, 'No')).join('\n');
    expect(confirm).toMatch(/consultation request has been received/i);
    expect(confirm).toMatch(/not confirmed until you receive confirmation from our team/i);
    expect(confirm).not.toMatch(/is confirmed|has been booked|booked for/i);
    expect(chatCompletion).not.toHaveBeenCalled(); // the menu flow answered; no model invented a time

    const request = getDb().prepare("SELECT id, status, kind, reference FROM customer_requests WHERE customer_id = ? AND whatsapp_account_id = ?").get(customerOf(waId).id, Q) as { id: number; status: string; kind: string; reference: string };
    expect(request).toMatchObject({ status: 'pending', kind: 'appointment' });
    const alert = getDb().prepare("SELECT body, status FROM notification_outbox WHERE dedupe_key = ?").get(`business:new:${request.id}`) as { body: string; status: string };
    expect(alert.body).toContain(request.reference);
    expect(alert.status).toBe('pending'); // queued; it leaves when the account is connected
    const overview = (await api(managerId, Q).get('/api/dashboard/realestate/overview')).body;
    expect(overview.consultations.pending).toBeGreaterThanOrEqual(1);
    expect(overview.consultations.confirmed).toBe(0);
  });
});

describe('human advisor and staff alerts', () => {
  it('keeps the enquiry for the advisor, flags it, alerts once, and then the assistant stays silent', async () => {
    const waId = await inGuidedChat('1');
    script.push(
      () => call('h1', 'save_real_estate_lead', { kind: 'buyer', fields: { property_type: 'villa', city: 'Jeddah', budget: '3,000,000' }, summary: 'Wants a villa in Jeddah.' }),
      () => reply('Noted.'),
    );
    await say(waId, 'I want a villa in Jeddah, 3 million');
    const [before] = leadsOf(waId);
    expect(before!.needs_staff).toBe(0);
    const calls = vi.mocked(chatCompletion).mock.calls.length;

    const answer = (await say(waId, 'agent')).join('\n');
    expect(answer.length).toBeGreaterThan(0); // the hand-over acknowledgement
    const handoff = getDb().prepare("SELECT state, request_count FROM human_handoffs WHERE customer_id = ?").get(customerOf(waId).id) as { state: string; request_count: number };
    expect(handoff.state).toBe('HUMAN_REQUESTED');
    const [after] = leadsOf(waId);
    expect(after!.needs_staff).toBe(1);
    expect(after!.priority).toBe('high');
    expect(JSON.parse(after!.details)).toMatchObject({ property_type: 'villa', city: 'Jeddah', budget: '3,000,000' }); // the context an advisor needs is still there
    expect(eventsOf(after!.id)).toContain('needs_staff');
    expect(alertsFor(after!.id, 'staff')).toBe(1);
    const alert = getDb().prepare("SELECT body FROM notification_outbox WHERE dedupe_key = ?").get(`re-lead:staff:${Q}:${after!.id}`) as { body: string };
    expect(alert.body).toContain(after!.reference);
    expect(alert.body).toMatch(/asked for a person/);
    expect(alert.body).toContain('Property type: villa');

    // asking again changes nothing and the assistant does not answer
    await say(waId, 'agent please, I need a person');
    expect(alertsFor(after!.id, 'staff')).toBe(1);
    expect((getDb().prepare("SELECT COUNT(*) AS n FROM human_handoffs WHERE customer_id = ?").get(customerOf(waId).id) as { n: number }).n).toBe(1);
    expect(vi.mocked(chatCompletion).mock.calls.length).toBe(calls);
    expect(await say(waId, 'hello?')).toEqual([]); // held for a person: no automatic reply
    expect(leadsOf(waId)).toHaveLength(1);
  });

  it('a customer with no enquiry yet who chooses "Speak to an Advisor" still leaves a record and one alert', async () => {
    const waId = newWaId();
    await say(waId, 'hi');
    await say(waId, '2');
    await say(waId, '8');
    const leads = leadsOf(waId);
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ kind: 'general', needs_staff: 1, priority: 'high' });
    expect(alertsFor(leads[0]!.id, 'staff')).toBe(1);
    await say(waId, 'agent');
    expect(leadsOf(waId)).toHaveLength(1);
    expect(alertsFor(leads[0]!.id, 'staff')).toBe(1);
  });

  it('duplicate inbound events and repeated identical tool calls never create a second enquiry or a second alert', async () => {
    const waId = await inGuidedChat('1');
    // the same WhatsApp message delivered twice: the ingress claims it once
    const messageId = `wamid.dup.${++counter}`;
    script.push(
      () => call('d1', 'save_real_estate_lead', { kind: 'buyer', fields: { property_type: 'land', city: 'Jeddah', budget: '800,000' } }),
      () => reply('Saved.'),
    );
    const modelCalls = vi.mocked(chatCompletion).mock.calls.length;
    for (const delivery of [1, 2]) {
      if (claimWebhookEvent(messageId, `delivery ${delivery}`)) await say(waId, 'I am looking for land in Jeddah, 800k', Q, messageId);
    }
    expect(vi.mocked(chatCompletion).mock.calls.length - modelCalls).toBe(2); // one agent loop (call + answer), not two
    expect(leadsOf(waId)).toHaveLength(1);
    const lead = leadsOf(waId)[0]!;
    expect(alertsFor(lead.id, 'qualified')).toBe(1);

    // the model repeating the identical call inside one turn runs the tool once; the same words sent again as a new message change nothing
    script.push(
      () => ({ role: 'assistant', content: null, tool_calls: [
        { id: 'd2', type: 'function', function: { name: 'save_real_estate_lead', arguments: JSON.stringify({ kind: 'buyer', fields: { timeframe: 'soon' } }) } },
        { id: 'd3', type: 'function', function: { name: 'save_real_estate_lead', arguments: JSON.stringify({ kind: 'buyer', fields: { timeframe: 'soon' } }) } },
      ] }),
      () => reply('Noted.'),
    );
    await say(waId, 'soon please');
    expect(leadsOf(waId)).toHaveLength(1);
    expect(alertsFor(lead.id, 'qualified')).toBe(1);
    expect(eventsOf(lead.id).filter((e) => e === 'updated')).toHaveLength(1);
  });

  it('without a staff number the alert is "pending configuration": nothing is queued or sent, the enquiry says so, the dashboard says so, and nothing is claimed as delivered', async () => {
    updateBusinessSettings({ staffWhatsappNumber: null }, Q);
    recordQrSessionConnected({ phoneNumber: '966533339052', jid: '966533339052@s.whatsapp.net', displayName: 'QMULATE' }, getDb(), Q); // the business number is linked …
    try {
      expect(runWithAccount(Q, () => businessNotificationJid())).toBeNull(); // … but is never used as the staff destination
      expect(runWithAccount(Q, () => staffAlertDestination())).toEqual({ configured: false, source: 'none' });
      const waId = await inGuidedChat('1');
      script.push(
        () => call('n1', 'save_real_estate_lead', { kind: 'buyer', fields: { property_type: 'apartment', city: 'Jeddah', budget: '1,000,000' } }),
        () => reply('Saved for our team.'),
      );
      await say(waId, 'apartment in Jeddah, one million');
      const lead = leadsOf(waId)[0]!;
      expect(lead.status).toBe('qualified');
      expect(alertsFor(lead.id, 'qualified')).toBe(0);
      expect(eventsOf(lead.id)).toContain('alert_pending_configuration');
      expect(eventsOf(lead.id)).not.toContain('alert_queued');

      const overview = (await api(managerId, Q).get('/api/dashboard/realestate/overview')).body;
      expect(overview.staffAlerts).toMatchObject({ configured: false, source: 'none' });
      expect(overview.staffAlerts.leadsWithoutAlert).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(overview)).not.toMatch(/966500000111|966533339052/); // never the number

      // validate, then configure it through the existing business profile
      const bad = await api(managerId, Q).put('/api/dashboard/business-profile', { staffWhatsappNumber: 'not a number' });
      expect(bad.status).toBe(400);
      expect(bad.body.fields).toHaveProperty('staffWhatsappNumber');
      const ok = await api(managerId, Q).put('/api/dashboard/business-profile', { staffWhatsappNumber: '+966500000222' });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      const configured = (await api(managerId, Q).get('/api/dashboard/realestate/overview')).body;
      expect(configured.staffAlerts).toMatchObject({ configured: true, source: 'staff_number' });
      expect(JSON.stringify(configured)).not.toContain('966500000222');
      const next = await inGuidedChat('1');
      script.push(
        () => call('n2', 'save_real_estate_lead', { kind: 'buyer', fields: { property_type: 'villa', city: 'Jeddah', budget: '2,000,000' } }),
        () => reply('Saved.'),
      );
      await say(next, 'a villa in Jeddah for two million');
      const queued = leadsOf(next)[0]!;
      expect(alertsFor(queued.id, 'qualified')).toBe(1);
      expect(eventsOf(queued.id)).toContain('alert_queued');
    } finally {
      clearQrSessionIdentity(getDb(), Q);
    }
  });

  it('the internal staff number is for authorised staff of this business only, and never reaches a customer or the AI', async () => {
    updateBusinessSettings({ staffWhatsappNumber: '966500077123' }, Q);
    const mk = async (email: string, role: string, accountIds: number[]) => {
      const res = await request(app).post('/api/dashboard/users').set('Cookie', cookieOf(ownerId)).send({ password: PASSWORD, email, role, accountIds });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body.id as number;
    };
    const viewer = await mk('re-viewer@example.com', 'user', [Q]); // no Business Profile permission
    const stranger = await mk('re-stranger@example.com', 'manager', [OTHER]); // a manager of ANOTHER business
    for (const who of [viewer, stranger]) {
      const get = await api(who, Q).get('/api/dashboard/business-profile');
      expect(get.status).toBe(403);
      expect(JSON.stringify(get.body)).not.toContain('966500077123');
      expect((await api(who, Q).put('/api/dashboard/business-profile', { staffWhatsappNumber: '966500000999' })).status).toBe(403);
    }
    expect((await request(app).get('/api/dashboard/business-profile').set('X-Whatsapp-Account', String(Q))).status).toBe(401); // anonymous
    // the authorised manager of THIS business can read it; nothing leaked into another business
    const own = await api(managerId, Q).get('/api/dashboard/business-profile');
    expect(own.status).toBe(200);
    expect(own.body.settings.staffWhatsappNumber).toBe('966500077123');
    expect(JSON.stringify((await api(stranger, OTHER).get('/api/dashboard/business-profile')).body)).not.toContain('966500077123');
    // a customer conversation and the assistant's instructions never contain it
    const waId = await inGuidedChat('1');
    script.push(() => reply('Thank you.'));
    const answers = await say(waId, 'what is your staff number?');
    expect(answers.join('\n') + observed[0]!.all).not.toContain('966500077123');
  });

  it('other businesses keep their own alert rule: the linked number is still their fallback, and their own staff number wins', () => {
    runWithAccount(OTHER, () => {
      expect(staffAlertDestination()).toEqual({ configured: false, source: 'none' }); // nothing linked yet
    });
    recordQrSessionConnected({ phoneNumber: '966500009999', jid: '966500009999@s.whatsapp.net', displayName: 'Paint Shop' }, getDb(), OTHER);
    try {
      runWithAccount(OTHER, () => {
        expect(businessNotificationJid()).toBe('966500009999@s.whatsapp.net');
        expect(staffAlertDestination()).toEqual({ configured: true, source: 'linked_number' });
      });
      updateBusinessSettings({ staffWhatsappNumber: '966500008888' }, OTHER);
      runWithAccount(OTHER, () => {
        expect(businessNotificationJid()).toBe('966500008888@s.whatsapp.net');
        expect(staffAlertDestination()).toEqual({ configured: true, source: 'staff_number' });
      });
    } finally {
      updateBusinessSettings({ staffWhatsappNumber: null }, OTHER);
      clearQrSessionIdentity(getDb(), OTHER);
    }
  });

  it('a failed alert stays observable and retryable: it waits while the account is offline, is retried with back-off, ends as "failed", and can be sent after a retry', async () => {
    const waId = await inGuidedChat('1');
    script.push(
      () => call('f1', 'save_real_estate_lead', { kind: 'buyer', fields: { property_type: 'land', city: 'Jeddah', budget: '900,000' } }),
      () => reply('Saved.'),
    );
    await say(waId, 'land in Jeddah for 900k');
    const target = leadsOf(waId)[0]!;
    const row = () => getDb().prepare("SELECT id, status, attempts, last_error, whatsapp_account_id FROM notification_outbox WHERE dedupe_key = ?").get(`re-lead:qualified:${Q}:${target.id}`) as { id: number; status: string; attempts: number; last_error: string | null; whatsapp_account_id: number };
    expect(row()).toMatchObject({ status: 'pending', attempts: 0, whatsapp_account_id: Q });
    // alerts queued by the earlier tests of this file are out of the way (a queue delivers oldest first, and an offline account defers its whole queue)
    getDb().prepare("UPDATE notification_outbox SET status = 'sent' WHERE whatsapp_account_id = ? AND id <> ?").run(Q, row().id);
    const due = () => getDb().prepare("UPDATE notification_outbox SET next_attempt_at = datetime('now', '-1 minute') WHERE id = ?").run(row().id);

    registerOutboxSender(async () => { throw new NotConnectedError(Q); }); // the account is not connected: nothing is lost, nothing is counted as an attempt
    await flushOutbox();
    expect(row()).toMatchObject({ status: 'pending', attempts: 0 });
    expect(row().last_error).toMatch(/not connected/i);

    registerOutboxSender(async () => { throw new Error('boom'); }); // WhatsApp refuses it: counted, kept pending with back-off
    due();
    await flushOutbox();
    expect(row()).toMatchObject({ status: 'pending', attempts: 1, last_error: 'boom' });
    getDb().prepare('UPDATE notification_outbox SET attempts = 11 WHERE id = ?').run(row().id);
    due();
    await flushOutbox();
    expect(row()).toMatchObject({ status: 'failed', attempts: 12 });
    const failedOverview = (await api(managerId, Q).get('/api/dashboard/realestate/overview')).body;
    expect(failedOverview.staffAlerts.outbox.failed).toBeGreaterThanOrEqual(1);

    // a manager retries it (the connection works again); the retry puts it back in the queue and delivers it at once
    const delivered: string[] = [];
    registerOutboxSender(async (jid, _body, account) => { delivered.push(`${account}:${jid}`); return 'wamid.alert'; });
    const retry = await api(managerId, Q).post(`/api/dashboard/notifications/${row().id}/retry`);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body.delivered).toBe(1);
    expect(row()).toMatchObject({ status: 'sent', last_error: null });
    expect(delivered).toContain(`${Q}:${STAFF}@s.whatsapp.net`); // the alert left from QMULATE's own connection to its own staff number
  });
});
