import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/whatsapp/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/whatsapp/client')>();
  return { ...real, sendTextMessage: vi.fn(), sendInteractiveMessage: vi.fn(), sendImageMessage: vi.fn(), sendDocumentMessage: vi.fn() };
});
vi.mock('../../../src/llm/agentLoop', () => ({ runAgentLoop: vi.fn() }));

import { sendTextMessage } from '../../../src/whatsapp/client';
import { runAgentLoop } from '../../../src/llm/agentLoop';
import { processInboundMessage } from '../../../src/pipeline/processInboundMessage';
import { getDb } from '../../../src/memory/db';
import { createAccount } from '../../../src/accounts/accountRepo';
import { runWithAccount } from '../../../src/accounts/accountContext';
import { getCustomerByWaId } from '../../../src/memory/customerRepo';
import { getMenuConfig } from '../../../src/automation/menuConfig';
import { replyTransport } from '../../../src/whatsapp/replyTransport';
import { listReplyActivity } from '../../../src/automation/settingsRepo';
import { acceptHandoff, getHold, getOpenHandoff, resolveHandoff, returnToAi, takeOverCustomer } from '../../../src/handoff/handoffRepo';
import { requestHumanHandoffHandler } from '../../../src/tools/requestHumanHandoff';

const STAFF = { type: 'staff' as const, adminId: 21, canManage: false };
const KNOWLEDGE = { sections: [], asPromptText: '' };

let A: number;
let B: number;
let counter = 0;
const sent: string[] = [];
const takeSent = () => sent.splice(0, sent.length);

const waIdOf = () => `96566${String(++counter).padStart(7, '0')}`;
async function say(accountId: number, waId: string, text: string, extra: { channel?: string } = {}): Promise<string[]> {
  takeSent();
  await processInboundMessage({ waId, messageId: `wamid.handoff.${accountId}.${++counter}`, timestamp: Date.now(), type: 'text', text, accountId, ...extra }, { knowledge: KNOWLEDGE });
  return takeSent();
}
/** A customer who chose English and stands on the main menu. */
async function ready(accountId: number): Promise<string> {
  const waId = waIdOf();
  await say(accountId, waId, 'hi');
  await say(accountId, waId, '2');
  return waId;
}
const hold = (accountId: number, waId: string) => runWithAccount(accountId, () => { const c = getCustomerByWaId(waId); return c ? getHold(c.id) : null; });
const customerId = (accountId: number, waId: string) => runWithAccount(accountId, () => getCustomerByWaId(waId)!.id);
const aiReplies = (text = 'AI answer') => vi.mocked(runAgentLoop).mockResolvedValue({ finalText: text, generatedMessages: [{ role: 'assistant', content: text }] });
const activity = (accountId: number) => runWithAccount(accountId, () => listReplyActivity({ limit: 50 }));

beforeAll(() => {
  getDb();
  A = createAccount({ name: 'Handoff Pipeline A' }).id;
  B = createAccount({ name: 'Handoff Pipeline B' }).id;
});

beforeEach(() => {
  vi.mocked(sendTextMessage).mockReset().mockImplementation(async (_to, body) => { sent.push(String(body)); return { messaging_product: 'whatsapp', contacts: [], messages: [{ id: 't' }] }; });
  vi.mocked(runAgentLoop).mockReset();
  aiReplies();
  takeSent();
});

describe('the customer asks for a person', () => {
  it('creates one persistent handoff for that business and sends the hand-over message once', async () => {
    const waId = await ready(A);
    const out = await say(A, waId, 'I want to speak to a human.');
    expect(out).toHaveLength(1);
    expect(out[0]).not.toBe('AI answer');
    const h = hold(A, waId);
    expect(h).toMatchObject({ state: 'HUMAN_REQUESTED', accountId: A, source: 'customer', requestCount: 1 });
    expect(h?.conversationId).toBeGreaterThan(0);
    expect(vi.mocked(runAgentLoop)).not.toHaveBeenCalled();
  });

  it.each([
    'Connect me to an agent',
    'Let me talk to someone',
    'I need a real person',
    'موظف',
    'أريد التحدث إلى موظف',
    'أبغى أكلم شخص',
    'خدمة العملاء',
    'أريد التحدث إلى شخص حقيقي',
  ])('hands over for: %s', async (text) => {
    const waId = await ready(A);
    const out = await say(A, waId, text);
    expect(out).toHaveLength(1);
    expect(hold(A, waId)?.state).toBe('HUMAN_REQUESTED');
  });

  it('choosing "Talk to our team" in the menu does the same', async () => {
    const waId = await ready(A);
    const position = getMenuConfig(A).config.items.findIndex((i) => i.kind === 'handoff') + 1;
    const out = await say(A, waId, String(position));
    expect(out).toHaveLength(1);
    expect(hold(A, waId)).toMatchObject({ state: 'HUMAN_REQUESTED', source: 'menu' });
  });

  it('does NOT hand over when the customer is only talking about staff, or asking for a service', async () => {
    for (const text of ['Your staff were very helpful, thank you', 'I need someone to manage my property', 'Is Ahmed the manager there?', "I don't need an agent"]) {
      const waId = await ready(A);
      const out = await say(A, waId, text);
      expect(out, text).toEqual(['AI answer']);
      expect(hold(A, waId), text).toBeNull();
    }
  });
});

describe('repeated and concurrent requests', () => {
  it('repeating the request updates the same handoff and is never answered again', async () => {
    const waId = await ready(A);
    expect(await say(A, waId, 'human')).toHaveLength(1);
    for (const text of ['human please', 'I need a real person now', 'موظف']) expect(await say(A, waId, text)).toEqual([]);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM human_handoffs WHERE customer_id = ?').get(customerId(A, waId))).toEqual({ n: 1 });
    expect(hold(A, waId)?.requestCount).toBe(4);
  });

  it('five requests arriving at the same moment make ONE handoff and ONE hand-over message', async () => {
    const waId = await ready(A);
    takeSent();
    await Promise.all(Array.from({ length: 5 }, (_, i) => processInboundMessage({ waId, messageId: `wamid.burst.${++counter}.${i}`, timestamp: Date.now(), type: 'text', text: 'I need a human', accountId: A }, { knowledge: KNOWLEDGE })));
    expect(takeSent()).toHaveLength(1);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM human_handoffs WHERE customer_id = ?').get(customerId(A, waId))).toEqual({ n: 1 });
    expect(hold(A, waId)?.requestCount).toBe(5);
  });
});

describe('the assistant stays silent while a human owns the conversation', () => {
  it.each(['What are your hours?', 'hello', 'menu', '2', 'تفاصيل أكثر', 'restart', 'language'])('waiting for staff: "%s" gets no automatic reply except leaving via the menu', async (text) => {
    const waId = await ready(A);
    await say(A, waId, 'I need a real person');
    const out = await say(A, waId, text);
    if (text === 'menu' || text === 'restart') return; // asking for the menu / starting over leaves a waiting handoff (tested below)
    expect(out, text).toEqual([]);
    expect(hold(A, waId)?.state).toBe('HUMAN_REQUESTED');
  });

  it('while staff are handling it, nothing — not the menu, not a greeting, not "restart", not the AI — is sent; the customer\'s messages are still stored', async () => {
    const waId = await ready(A);
    await say(A, waId, 'I need a real person');
    const { handoff } = runWithAccount(A, () => acceptHandoff(hold(A, waId)!.id, STAFF, A));
    vi.mocked(runAgentLoop).mockClear();
    for (const text of ['hello', 'menu', '0', 'restart', 'main menu', 'What is the price?', 'language', 'human']) {
      expect(await say(A, waId, text), text).toEqual([]);
    }
    expect(hold(A, waId)).toMatchObject({ id: handoff.id, state: 'HUMAN_ACTIVE', assignedAdminId: STAFF.adminId });
    expect(vi.mocked(runAgentLoop)).not.toHaveBeenCalled();
    const stored = getDb().prepare(`SELECT COUNT(*) AS n FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.customer_id = ? AND m.role = 'user' AND m.content = 'What is the price?'`).get(customerId(A, waId));
    expect(stored).toEqual({ n: 1 });
    expect(activity(A).filter((a) => a.waId === waId && a.kind === 'suppressed').length).toBeGreaterThanOrEqual(8);
  });

  it('a customer who is only waiting can leave by asking for the menu, and the assistant answers again', async () => {
    const waId = await ready(A);
    await say(A, waId, 'I need a real person');
    const out = await say(A, waId, 'menu');
    expect(out).toHaveLength(1);
    expect(hold(A, waId)).toBeNull();
    expect(await say(A, waId, 'what do you sell?')).toEqual(['AI answer']);
  });

  it('after resolution the assistant is still silent until staff return the conversation to it; then it answers again', async () => {
    const waId = await ready(A);
    await say(A, waId, 'I need a real person');
    const id = hold(A, waId)!.id;
    runWithAccount(A, () => { acceptHandoff(id, STAFF, A); resolveHandoff(id, STAFF, A); });
    expect(await say(A, waId, 'thanks, one more question about prices')).toEqual([]);
    expect(hold(A, waId)?.state).toBe('RESOLVED');
    runWithAccount(A, () => returnToAi(id, STAFF, A));
    expect(await say(A, waId, 'what are the prices?')).toEqual(['AI answer']);
    expect(hold(A, waId)).toBeNull();
  });

  it('asking for a person again after a resolution reopens it for staff', async () => {
    const waId = await ready(A);
    await say(A, waId, 'I need a real person');
    const id = hold(A, waId)!.id;
    runWithAccount(A, () => { acceptHandoff(id, STAFF, A); resolveHandoff(id, STAFF, A); });
    expect(await say(A, waId, 'I need a real person again')).toEqual([]);
    expect(hold(A, waId)).toMatchObject({ id, state: 'HUMAN_REQUESTED' });
  });

  it('files and voice notes are stored for staff and never answered, as before', async () => {
    const waId = await ready(A);
    await say(A, waId, 'I need a real person');
    takeSent();
    await processInboundMessage({ waId, messageId: `wamid.media.${++counter}`, timestamp: Date.now(), type: 'image', text: 'my contract', accountId: A }, { knowledge: KNOWLEDGE });
    expect(takeSent()).toEqual([]);
  });

  it('a handoff in one business never silences the same phone number in another business, or other customers', async () => {
    const waId = await ready(A);
    await say(A, waId, 'I need a real person');
    const other = await ready(A);
    expect(await say(A, other, 'what are your hours')).toEqual(['AI answer']);
    await say(B, waId, 'hi');
    await say(B, waId, '2');
    expect(await say(B, waId, 'what are your hours')).toEqual(['AI answer']);
    expect(hold(B, waId)).toBeNull();
    expect(hold(A, waId)?.state).toBe('HUMAN_REQUESTED');
  });
});

describe('an AI answer that is still being written when a person takes over', () => {
  it('is dropped: not sent, not stored as sent, and the suppression is recorded', async () => {
    const waId = await ready(A);
    let release!: () => void;
    vi.mocked(runAgentLoop).mockImplementation(() => new Promise((resolve) => { release = () => resolve({ finalText: 'LATE AI ANSWER', generatedMessages: [{ role: 'assistant', content: 'LATE AI ANSWER' }] }); }));
    const pending = processInboundMessage({ waId, messageId: `wamid.slow.${++counter}`, timestamp: Date.now(), type: 'text', text: 'tell me about your services please', accountId: A }, { knowledge: KNOWLEDGE });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    runWithAccount(A, () => takeOverCustomer(customerId(A, waId), STAFF, A)); // staff press "take over" while the model is thinking
    release();
    await pending;
    expect(takeSent()).toEqual([]);
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM conversation_messages WHERE content = 'LATE AI ANSWER'`).get()).toEqual({ n: 0 });
    expect(activity(A).some((a) => a.waId === waId && a.kind === 'suppressed' && /Human handoff/.test(a.detail ?? ''))).toBe(true);
    expect(hold(A, waId)?.state).toBe('HUMAN_ACTIVE');
  });

  it('a model failure after the takeover does not send the apology either', async () => {
    const waId = await ready(A);
    let fail!: () => void;
    vi.mocked(runAgentLoop).mockImplementation(() => new Promise((_resolve, reject) => { fail = () => reject(new Error('upstream timeout')); }));
    const pending = processInboundMessage({ waId, messageId: `wamid.fail.${++counter}`, timestamp: Date.now(), type: 'text', text: 'a question that fails', accountId: A }, { knowledge: KNOWLEDGE });
    await vi.waitFor(() => expect(fail).toBeTypeOf('function'));
    runWithAccount(A, () => takeOverCustomer(customerId(A, waId), STAFF, A));
    fail();
    await pending;
    expect(takeSent()).toEqual([]);
  });

  it('a takeover pressed between two bubbles of the same reply stops the remaining bubbles (every send re-checks ownership)', async () => {
    const waId = await ready(A);
    let first = true;
    vi.mocked(sendTextMessage).mockImplementation(async (_to, body) => {
      sent.push(String(body));
      if (first) { first = false; runWithAccount(A, () => takeOverCustomer(customerId(A, waId), STAFF, A)); } // staff take over while bubble one is being delivered
      return { messaging_product: 'whatsapp', contacts: [], messages: [{ id: 't' }] };
    });
    takeSent();
    await processInboundMessage({ waId, messageId: `wamid.twobubbles.${++counter}`, timestamp: Date.now(), type: 'text', text: '57', accountId: A }, { knowledge: KNOWLEDGE });
    // "57" is not a menu option: the customer would normally get "invalid option" AND the menu, as two bubbles.
    expect(takeSent()).toHaveLength(1);
    expect(hold(A, waId)?.state).toBe('HUMAN_ACTIVE');
  });

  it('without a takeover, the same slow answer IS delivered (the guard does not eat ordinary replies)', async () => {
    const waId = await ready(A);
    let release!: () => void;
    vi.mocked(runAgentLoop).mockImplementation(() => new Promise((resolve) => { release = () => resolve({ finalText: 'SLOW BUT FINE', generatedMessages: [{ role: 'assistant', content: 'SLOW BUT FINE' }] }); }));
    const pending = processInboundMessage({ waId, messageId: `wamid.fine.${++counter}`, timestamp: Date.now(), type: 'text', text: 'tell me about your services please', accountId: A }, { knowledge: KNOWLEDGE });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release();
    await pending;
    expect(takeSent()).toEqual(['SLOW BUT FINE']);
  });

  it('a takeover of one customer does not drop another customer\'s answer that is being written at the same time', async () => {
    const one = await ready(A);
    const two = await ready(A);
    const releases = new Map<string, () => void>();
    vi.mocked(runAgentLoop).mockImplementation(({ conversationId }) => new Promise((resolve) => { releases.set(String(conversationId), () => resolve({ finalText: `answer-${conversationId}`, generatedMessages: [{ role: 'assistant', content: `answer-${conversationId}` }] })); }));
    const p1 = processInboundMessage({ waId: one, messageId: `wamid.p1.${++counter}`, timestamp: Date.now(), type: 'text', text: 'a long question from the first customer', accountId: A }, { knowledge: KNOWLEDGE });
    const p2 = processInboundMessage({ waId: two, messageId: `wamid.p2.${++counter}`, timestamp: Date.now(), type: 'text', text: 'a long question from the second customer', accountId: A }, { knowledge: KNOWLEDGE });
    await vi.waitFor(() => expect(releases.size).toBe(2));
    runWithAccount(A, () => takeOverCustomer(customerId(A, one), STAFF, A));
    for (const release of releases.values()) release();
    await Promise.all([p1, p2]);
    const out = takeSent();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^answer-/);
  });
});

describe('the assistant hands over by itself', () => {
  it('its handoff tool creates the handoff and the customer gets the hand-over message instead of the model\'s own text', async () => {
    const waId = await ready(A);
    vi.mocked(runAgentLoop).mockImplementation(async ({ conversationId }) => {
      const result = await runWithAccount(A, () => requestHumanHandoffHandler({ reason: 'customer is frustrated with the options' }, { conversationId }));
      expect(result).toMatchObject({ ok: true, status: 'HUMAN_REQUESTED' });
      return { finalText: 'MODEL TEXT THAT MUST NOT BE SENT', generatedMessages: [{ role: 'assistant', content: '[requested tools: request_human_handoff]' }, { role: 'tool', content: '{"ok":true}', toolName: 'request_human_handoff', toolCallId: 'c1' }, { role: 'assistant', content: 'MODEL TEXT THAT MUST NOT BE SENT' }] };
    });
    const out = await say(A, waId, 'this is all too confusing for me honestly');
    expect(out).toHaveLength(1);
    expect(out[0]).not.toContain('MODEL TEXT');
    expect(hold(A, waId)).toMatchObject({ state: 'HUMAN_REQUESTED', source: 'ai' });
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM conversation_messages WHERE content LIKE 'MODEL TEXT%'`).get()).toEqual({ n: 0 });
  });

  it('the tool only ever touches the conversation it runs in, inside its own account', async () => {
    const waId = await ready(A);
    const conversationId = (getDb().prepare('SELECT id FROM conversations WHERE customer_id = ?').get(customerId(A, waId)) as { id: number }).id;
    expect(await runWithAccount(B, () => requestHumanHandoffHandler({}, { conversationId }))).toEqual({ error: 'conversation_not_found' });
    expect(hold(A, waId)).toBeNull();
    expect(await runWithAccount(A, () => requestHumanHandoffHandler({ reason: 'x'.repeat(500) }, { conversationId }))).toMatchObject({ ok: true });
    expect(hold(A, waId)?.reason?.length).toBeLessThanOrEqual(300);
  });
});

describe('ordinary conversations are unaffected', () => {
  it('free text goes to the AI and is answered; menu navigation works; nothing is created', async () => {
    const waId = await ready(A);
    expect(await say(A, waId, 'what services do you offer?')).toEqual(['AI answer']);
    expect((await say(A, waId, '1'))[0]).toBeTruthy(); // a menu page, not the AI
    expect(hold(A, waId)).toBeNull();
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM human_handoffs WHERE customer_id = ?').get(customerId(A, waId))).toEqual({ n: 0 });
  });

  it('inside a guided request, a sentence typed as an answer is not mistaken for a request for a person — but the exact keyword still exits', async () => {
    const waId = await ready(A);
    const position = getMenuConfig(A).config.items.findIndex((i) => i.kind === 'appointment') + 1;
    await say(A, waId, String(position));
    await say(A, waId, 'Layla');
    const answered = await say(A, waId, 'I would like to talk to a person about my villa');
    expect(answered).toHaveLength(1);
    expect(hold(A, waId)).toBeNull();
    const out = await say(A, waId, 'agent');
    expect(out).toHaveLength(1);
    expect(hold(A, waId)?.state).toBe('HUMAN_REQUESTED');
  });

  it('customers who were paused before handoffs existed (flag only) stay silent', async () => {
    const waId = await ready(A);
    getDb().prepare('UPDATE customers SET automation_paused = 1 WHERE id = ?').run(customerId(A, waId));
    expect(await say(A, waId, 'hello?')).toEqual([]);
    expect(getOpenHandoff(customerId(A, waId))).toMatchObject({ source: 'migrated', state: 'HUMAN_REQUESTED' });
  });
});

describe('both connection types go through the same rule', () => {
  it('a message that arrives on the linked-device (QR) transport is acknowledged once, then the transport stays silent while a human owns it', async () => {
    const text = vi.fn(async () => ({ messaging_product: 'whatsapp' as const, contacts: [], messages: [{ id: 'q' }] }));
    const transport = { text, interactive: vi.fn() };
    const waId = await ready(A);
    // The real send path of a QR connection is replyTransport; the client module is mocked above, so route the call through it explicitly.
    vi.mocked(sendTextMessage).mockImplementation(async (to, body) => replyTransport.getStore()!.text(to, body));
    await replyTransport.run(transport, () => processInboundMessage({ waId, messageId: `wamid.qr.${++counter}`, timestamp: Date.now(), type: 'text', text: 'I need a human', accountId: A, channel: 'qr' }, { knowledge: KNOWLEDGE }));
    expect(text).toHaveBeenCalledTimes(1);
    await replyTransport.run(transport, () => processInboundMessage({ waId, messageId: `wamid.qr.${++counter}`, timestamp: Date.now(), type: 'text', text: 'hello??', accountId: A, channel: 'qr' }, { knowledge: KNOWLEDGE }));
    expect(text).toHaveBeenCalledTimes(1);
  });

  it('a message from the Cloud API channel is held the same way', async () => {
    const waId = await ready(A);
    expect(await say(A, waId, 'I need a human', { channel: 'cloud' })).toHaveLength(1);
    expect(await say(A, waId, 'anyone there?', { channel: 'cloud' })).toEqual([]);
  });
});
