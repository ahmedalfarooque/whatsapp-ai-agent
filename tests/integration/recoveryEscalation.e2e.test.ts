import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/whatsapp/client', () => ({
  sendTextMessage: vi.fn().mockResolvedValue({ messaging_product: 'whatsapp', contacts: [], messages: [{ id: 'w1' }] }),
  sendInteractiveMessage: vi.fn().mockResolvedValue({ messaging_product: 'whatsapp', contacts: [], messages: [{ id: 'w2' }] }),
  sendDocumentMessage: vi.fn(),
  sendImageMessage: vi.fn(),
}));
vi.mock('../../src/llm/openRouterClient', () => ({ chatCompletion: vi.fn() }));

import { DateTime } from 'luxon';
import { sendTextMessage } from '../../src/whatsapp/client';
import { chatCompletion } from '../../src/llm/openRouterClient';
import { processInboundMessage, resetCredentialFallbackThrottle } from '../../src/pipeline/processInboundMessage';
import { getDb } from '../../src/memory/db';
import { createAccount } from '../../src/accounts/accountRepo';
import { runWithAccount } from '../../src/accounts/accountContext';
import { getCustomerByWaId, setCustomerMenuState } from '../../src/memory/customerRepo';
import { updateBusinessSettings } from '../../src/config/businessSettings';
import { AiResponseError } from '../../src/llm/aiResponseError';
import { requestHandoff } from '../../src/handoff/handoffRepo';
import { appendMessage } from '../../src/memory/conversationRepo';
import { activeFollowupsForCustomer, getFollowup } from '../../src/followups/followupRepo';
import { createFollowup } from '../../src/followups/followupService';
import { listStaffNotifications } from '../../src/notifications/staffNotifications';
import { FOLLOWUP_STATES } from '../../src/followups/customerFlow';
import { getPendingReply, markInterruptedAtBoot, pendingReplyCounts, REPLAY_MAX_AGE_MS } from '../../src/replay/pendingReplyRepo';
import { runReplaySweep, type ReplayRunner } from '../../src/replay/replayWorker';
import { ESCALATION_AFTER_MS, listEscalations, runEscalationSweep } from '../../src/escalation/escalationService';
import { attemptVoiceCall, voiceCallCapability } from '../../src/escalation/voiceCall';
import type { InboundMessage } from '../../src/webhook/parseInboundPayload';

/**
 * Safe replay of customer messages that were never answered, and the five-minute escalation — end to end on generic businesses.
 * The transport is mocked (this is NOT real WhatsApp delivery and NOT real inference): what is proven is the bookkeeping, the
 * eligibility rules, the idempotency and the account isolation.
 */
const reply = (content: string) => ({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }] });
let counter = 0;
const KB = { sections: [], asPromptText: 'We tint windows and fit accessories.' };
let ACC: number;
let OTHER: number;
const msgFor = (account: number, waId: string, text: string): InboundMessage => ({ waId, messageId: `wamid.rc.${++counter}`, timestamp: Date.now(), type: 'text', text, accountId: account });
const OPEN_NOW = new Date('2026-10-08T07:00:00Z'); // Thursday 10:00 Riyadh — open (09:00-18:00)
const CLOSED_NOW = new Date('2026-10-07T20:00:00Z'); // Wednesday 23:00 Riyadh — closed
const db = () => getDb();
const sent = () => vi.mocked(sendTextMessage).mock.calls.map((c) => String(c[1]));
const newWa = () => `96656${String(++counter).padStart(7, '0')}`;
const runner: ReplayRunner = { run: async (_row, _jid, fn) => { await fn(KB as never); } };
const yes = async () => true;
const no = async () => false;
const sqlAgo = (ms: number) => new Date(Date.now() - ms).toISOString().slice(0, 19).replace('T', ' ');
const customerOf = (account: number, waId: string) => runWithAccount(account, () => getCustomerByWaId(waId, undefined, account))!;
const rowFor = (account: number, waId: string) => db().prepare('SELECT * FROM pending_replies WHERE whatsapp_account_id = ? AND wa_id = ? ORDER BY id DESC').get(account, waId) as { id: number; message_id: string; status: string; attempts: number; recovered: number; conversation_id: number; created_at: string };
const ageRow = (id: number, ms: number) => db().prepare('UPDATE pending_replies SET created_at = ? WHERE id = ?').run(sqlAgo(ms), id);
const roleCounts = (conversationId: number) => db().prepare('SELECT role, COUNT(*) AS n FROM conversation_messages WHERE conversation_id = ? GROUP BY role').all(conversationId) as Array<{ role: string; n: number }>;

async function say(account: number, waId: string, text: string): Promise<void> {
  await processInboundMessage(msgFor(account, waId, text), { knowledge: KB });
}

/** A customer who finished the language step and then wrote a real question while the AI was DOWN: the honest automated reply is sent and the question waits. */
async function waitingCustomer(account = ACC, language: '2' | '1' = '2'): Promise<{ waId: string; row: ReturnType<typeof rowFor> }> {
  const waId = newWa();
  vi.mocked(chatCompletion).mockResolvedValue(reply('ok') as never);
  await say(account, waId, 'hi');
  await say(account, waId, language);
  vi.mocked(chatCompletion).mockRejectedValue(new AiResponseError('payment_required', 402, 'openai/gpt-4.1-mini', 'Insufficient credits'));
  await say(account, waId, 'what window tinting packages do you offer and how much?');
  return { waId, row: rowFor(account, waId) };
}

beforeAll(() => {
  getDb();
  ACC = createAccount({ name: 'Pearl Dental' }).id;
  OTHER = createAccount({ name: 'Other Shop' }).id;
  for (const id of [ACC, OTHER]) {
    runWithAccount(id, () => updateBusinessSettings({ businessTimezone: 'Asia/Riyadh', businessHoursStart: '09:00', businessHoursEnd: '18:00', businessDays: '1,2,3,4,5,6,7', contactPhone: '+966112223344', staffWhatsappNumber: '+966500000000' }, id));
  }
});
beforeEach(() => {
  vi.clearAllMocks();
  resetCredentialFallbackThrottle();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(OPEN_NOW);
});
afterEach(() => { vi.useRealTimers(); });

describe('a message the assistant could not answer waits, and is answered once when an AI route works again', () => {
  it('the customer gets ONE honest automated message; the question is recorded as waiting; a replay answers it once without duplicating anything', async () => {
    const { waId, row } = await waitingCustomer();
    expect(row).toMatchObject({ status: 'awaiting_ai', attempts: 0, recovered: 0 });
    const unavailable = sent().filter((t) => /Automated reply: our assistant cannot answer right now/.test(t));
    expect(unavailable).toHaveLength(1);
    const before = roleCounts(row.conversation_id);
    const sentBefore = sent().length;

    vi.mocked(chatCompletion).mockResolvedValue(reply('Tinting packages start from the basic package; ask us for a quote.') as never);
    const result = await runReplaySweep(runner, new Date(), db(), { routeAvailable: yes });
    expect(result).toMatchObject({ replayed: 1, answered: 1 });
    expect(sent().slice(sentBefore)).toEqual(['Tinting packages start from the basic package; ask us for a quote.']); // exactly ONE late answer, no apology, no menu
    expect(rowFor(ACC, waId)).toMatchObject({ status: 'answered', recovered: 1, attempts: 1 });
    const after = roleCounts(row.conversation_id);
    expect(after.find((r) => r.role === 'user')?.n).toBe(before.find((r) => r.role === 'user')?.n); // the customer's words are NOT stored twice
    expect(after.find((r) => r.role === 'assistant')!.n).toBe(before.find((r) => r.role === 'assistant')!.n + 1);
    expect(pendingReplyCounts(ACC)).toMatchObject({ answeredByReplay: 1, awaitingAi: 0 });
    // idempotent: another pass finds nothing and sends nothing
    vi.mocked(sendTextMessage).mockClear();
    expect(await runReplaySweep(runner, new Date(), db(), { routeAvailable: yes })).toMatchObject({ replayed: 0 });
    expect(sent()).toHaveLength(0);
    // the customer's menu position, language and reply mode are untouched by the replay
    expect(customerOf(ACC, waId).language).toBe('en');
  });

  it('while no AI route works nothing is replayed, nothing is sent and no attempt is spent', async () => {
    const { waId } = await waitingCustomer();
    vi.mocked(sendTextMessage).mockClear();
    expect(await runReplaySweep(runner, new Date(), db(), { routeAvailable: no })).toMatchObject({ replayed: 0, waiting: 1 });
    expect(sent()).toHaveLength(0);
    expect(rowFor(ACC, waId)).toMatchObject({ status: 'awaiting_ai', attempts: 0 });
  });

  it('a replay that fails again sends NOTHING and keeps the message; after three attempts it is left for staff', async () => {
    const { waId } = await waitingCustomer();
    vi.mocked(sendTextMessage).mockClear();
    for (let i = 1; i <= 3; i += 1) {
      await runReplaySweep(runner, new Date(), db(), { routeAvailable: yes });
      expect(sent()).toHaveLength(0); // the customer already has the automated reply
      expect(rowFor(ACC, waId).attempts).toBe(i);
    }
    expect(rowFor(ACC, waId).status).toBe('needs_staff');
    expect(await runReplaySweep(runner, new Date(), db(), { routeAvailable: yes })).toMatchObject({ replayed: 0 });
  });

  it('a message cut short by a restart becomes interrupted and is then replayed; a replay cut short is never repeated automatically', async () => {
    const waId = newWa();
    vi.mocked(chatCompletion).mockResolvedValue(reply('ok') as never);
    await say(ACC, waId, 'hi');
    await say(ACC, waId, '2');
    // the interrupted message: stored and recorded as pending, but the process died before any outcome
    const conversationId = (db().prepare('SELECT id FROM conversations WHERE customer_id = ? ORDER BY id DESC').get(customerOf(ACC, waId).id) as { id: number }).id;
    runWithAccount(ACC, () => appendMessage(conversationId, { role: 'user', content: 'do you tint sunroofs as well?', whatsappMessageId: 'wamid.cut.1', direction: 'inbound', messageType: 'text' }));
    db().prepare(`INSERT INTO pending_replies (whatsapp_account_id, customer_id, conversation_id, message_id, wa_id, channel, created_at) VALUES (?, ?, ?, 'wamid.cut.1', ?, 'qr', ?)`).run(ACC, customerOf(ACC, waId).id, conversationId, waId, sqlAgo(10 * 60_000));
    expect(markInterruptedAtBoot(120, db())).toMatchObject({ interrupted: 1 });
    expect(runWithAccount(ACC, () => getPendingReply('wamid.cut.1'))!.status).toBe('interrupted');
    vi.mocked(sendTextMessage).mockClear();
    vi.mocked(chatCompletion).mockResolvedValue(reply('Yes, we tint sunroofs.') as never);
    expect(await runReplaySweep(runner, new Date(), db(), { routeAvailable: yes })).toMatchObject({ replayed: 1, answered: 1 });
    expect(sent()).toEqual(['Yes, we tint sunroofs.']);
    // a replay that was running when the process died could already have been answered: it goes to staff, never again
    db().prepare(`UPDATE pending_replies SET status = 'replaying' WHERE message_id = 'wamid.cut.1'`).run();
    expect(markInterruptedAtBoot(120, db())).toMatchObject({ replayingToStaff: 1 });
    expect(runWithAccount(ACC, () => getPendingReply('wamid.cut.1'))!.status).toBe('needs_staff');
  });

  it('is never replayed when it must not be: answered meanwhile, a person owns the customer, a tool already ran, too old, or the customer moved on', async () => {
    const cases: Array<{ name: string; setup: (waId: string, row: ReturnType<typeof rowFor>) => void; expected: string }> = [
      { name: 'staff or the assistant already answered', setup: (_w, row) => { runWithAccount(ACC, () => appendMessage(row.conversation_id, { role: 'assistant', content: 'Hi, staff here: we tint from 300 SAR.', direction: 'outbound' })); }, expected: 'abandoned' },
      { name: 'a person owns the conversation', setup: (waId) => { runWithAccount(ACC, () => requestHandoff({ customerId: customerOf(ACC, waId).id, conversationId: null, source: 'customer', reason: 'wants a person' })); }, expected: 'abandoned' },
      { name: 'a tool already ran', setup: (_w, row) => { runWithAccount(ACC, () => appendMessage(row.conversation_id, { role: 'tool', content: '{"ok":true}', toolCallId: 'call_x', toolName: 'create_booking' })); }, expected: 'needs_staff' },
      { name: 'too old', setup: (_w, row) => { ageRow(row.id, REPLAY_MAX_AGE_MS + 60_000); }, expected: 'abandoned' },
      { name: 'the customer is inside a guided flow', setup: (waId) => { runWithAccount(ACC, () => setCustomerMenuState(customerOf(ACC, waId).id, FOLLOWUP_STATES.TIME, null)); }, expected: 'abandoned' },
    ];
    for (const c of cases) {
      const { waId, row } = await waitingCustomer();
      c.setup(waId, row);
      vi.mocked(sendTextMessage).mockClear();
      vi.mocked(chatCompletion).mockClear();
      await runReplaySweep(runner, new Date(), db(), { routeAvailable: yes });
      expect(rowFor(ACC, waId).status, c.name).toBe(c.expected);
      expect(sent(), c.name).toHaveLength(0);
      expect(chatCompletion, c.name).not.toHaveBeenCalled();
    }
  });

  it('only the newest waiting message of a customer is replayed (one answer covers the older ones)', async () => {
    const { waId } = await waitingCustomer();
    vi.mocked(sendTextMessage).mockClear();
    resetCredentialFallbackThrottle();
    await say(ACC, waId, 'and do you also fit dash cams? what is the price?');
    expect(db().prepare(`SELECT COUNT(*) AS n FROM pending_replies WHERE wa_id = ? AND status = 'awaiting_ai'`).get(waId)).toEqual({ n: 2 });
    vi.mocked(sendTextMessage).mockClear();
    vi.mocked(chatCompletion).mockResolvedValue(reply('Yes to both: ask us for a quote.') as never);
    expect(await runReplaySweep(runner, new Date(), db(), { routeAvailable: yes })).toMatchObject({ replayed: 1, answered: 1, abandoned: 1 });
    expect(sent()).toEqual(['Yes to both: ask us for a quote.']);
  });

  it('keeps businesses apart: a replay answers only through its own account, and another business\'s waiting message is untouched by a sweep that cannot serve it', async () => {
    const mine = await waitingCustomer(ACC);
    const theirs = await waitingCustomer(OTHER);
    vi.mocked(chatCompletion).mockResolvedValue(reply('Answer.') as never);
    const seen: number[] = [];
    const accountRunner: ReplayRunner = { run: async (row, _jid, fn) => { seen.push(row.whatsapp_account_id); if (row.whatsapp_account_id === OTHER) throw new Error('not connected'); await fn(KB as never); } };
    await runReplaySweep(accountRunner, new Date(), db(), { routeAvailable: yes });
    expect(seen.sort()).toEqual([ACC, OTHER].sort());
    expect(rowFor(ACC, mine.waId).status).toBe('answered');
    expect(rowFor(OTHER, theirs.waId)).toMatchObject({ status: 'awaiting_ai', attempts: 1 }); // stays queued: its own session was not connected
    expect(customerOf(OTHER, theirs.waId).whatsapp_account_id).toBe(OTHER);
  });
});

describe('the five-minute escalation', () => {
  it('a customer message unanswered for five minutes while the business is OPEN escalates ONCE: staff notification that rings, a staff WhatsApp alert, and a voice-call record that says it was not placed', async () => {
    const { waId, row } = await waitingCustomer();
    runEscalationSweep(new Date(), db());
    expect(listEscalations(ACC, 100).some((e) => e.ref_kind === 'pending_reply' && e.ref_id === row.id)).toBe(false); // not five minutes yet
    ageRow(row.id, ESCALATION_AFTER_MS + 30_000);
    expect(runEscalationSweep(new Date(), db()).escalated).toBeGreaterThanOrEqual(1);
    expect(runEscalationSweep(new Date(), db())).toMatchObject({ escalated: 0 }); // never twice
    const escalations = listEscalations(ACC, 100).filter((e) => e.ref_kind === 'pending_reply' && e.ref_id === row.id);
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({ ref_kind: 'pending_reply', ref_id: row.id, status: 'open', voice_call_status: 'unavailable' });
    expect(escalations[0]!.voice_call_detail).toMatch(/cannot place SIM/);
    expect(escalations[0]!.voice_call_at).toBeTruthy();
    const note = listStaffNotifications({ accountIds: [ACC], adminUserId: 1, status: 'open' }).find((n) => n.kind === 'escalation' && n.customer_id === customerOf(ACC, waId).id);
    expect(note).toMatchObject({ ring: 1 });
    expect(note!.body).not.toContain(waId); // the number is masked
    expect(db().prepare(`SELECT target_jid FROM notification_outbox WHERE dedupe_key = ?`).get(`outbox:escalation:pending_reply:${row.id}`)).toMatchObject({ target_jid: '966500000000@s.whatsapp.net' });
    // answering the customer (a replay) closes the escalation
    vi.mocked(chatCompletion).mockResolvedValue(reply('Here you go.') as never);
    await runReplaySweep(runner, new Date(), db(), { routeAvailable: yes });
    runEscalationSweep(new Date(), db());
    expect(listEscalations(ACC, 100).find((e) => e.ref_kind === 'pending_reply' && e.ref_id === row.id)!.status).toBe('resolved');
    // another business has none
    expect(listEscalations(OTHER)).toHaveLength(0);
  });

  it('outside business hours nothing escalates (the request waits for the opening)', async () => {
    vi.setSystemTime(CLOSED_NOW);
    const { row } = await waitingCustomer();
    ageRow(row.id, ESCALATION_AFTER_MS + 30_000);
    expect(runEscalationSweep(new Date(), db())).toMatchObject({ escalated: 0 });
    expect(listEscalations(ACC).some((e) => e.ref_id === row.id)).toBe(false);
  });

  it('an "as soon as possible" callback still unassigned after five minutes of business hours escalates once; an assigned or cancelled one does not', async () => {
    const waId = newWa();
    vi.mocked(chatCompletion).mockResolvedValue(reply('ok') as never);
    await say(ACC, waId, 'hi');
    await say(ACC, waId, '2');
    const customerId = customerOf(ACC, waId).id;
    const open = runWithAccount(ACC, () => createFollowup({ customerId, conversationId: null, contactMethod: 'call', appointmentTypeKey: null, requestedAt: null, asap: true, source: 'customer' }));
    expect(open.status).toBe('eligible');
    db().prepare('UPDATE followup_requests SET created_at = ? WHERE id = ?').run(new Date(OPEN_NOW.getTime() - ESCALATION_AFTER_MS - 30_000).toISOString(), open.id);
    expect(runEscalationSweep(new Date(), db()).escalated).toBeGreaterThanOrEqual(1);
    expect(listEscalations(ACC).filter((e) => e.ref_kind === 'followup' && e.ref_id === open.id)).toHaveLength(1);
    expect(runEscalationSweep(new Date(), db())).toMatchObject({ escalated: 0 });
    db().prepare(`UPDATE followup_requests SET status = 'assigned' WHERE id = ?`).run(open.id);
    runEscalationSweep(new Date(), db());
    expect(listEscalations(ACC).find((e) => e.ref_id === open.id)!.status).toBe('resolved');
    expect(runWithAccount(ACC, () => getFollowup(open.id))!.status).toBe('assigned');
  });
});

describe('the outbound voice call is available only through a verified zero-cost authorized path — none exists, so it never calls', () => {
  it('reports the exact blockers and the no-cost alternatives, and an attempt never reports a placed call', () => {
    const capability = voiceCallCapability();
    expect(capability.available).toBe(false);
    expect(capability.provider).toBeNull();
    expect(capability.blockers.join(' ')).toMatch(/WhatsApp Web[\s\S]*cannot place SIM[\s\S]*charges per minute[\s\S]*consent/);
    expect(capability.alternatives.length).toBeGreaterThanOrEqual(2);
    for (const input of [{ hasValidNumber: true, hasConsent: true }, { hasValidNumber: false, hasConsent: false }]) {
      expect(['unavailable', 'skipped']).toContain(attemptVoiceCall(input).status);
    }
  });
});

describe('callbacks are manageable from WhatsApp: reschedule keeps the SAME request; Arabic customers get the short Arabic flow', () => {
  it('"cancel" lists the request, choosing it offers cancel / change the time, and a new valid time moves the same request (no duplicate)', async () => {
    const waId = newWa();
    vi.mocked(chatCompletion).mockResolvedValue(reply('ok') as never);
    await say(ACC, waId, 'hi');
    await say(ACC, waId, '2');
    runWithAccount(ACC, () => setCustomerMenuState(customerOf(ACC, waId).id, FOLLOWUP_STATES.MENU, null));
    await say(ACC, waId, '1'); // request a callback
    await say(ACC, waId, '1'); // as soon as possible
    const first = runWithAccount(ACC, () => activeFollowupsForCustomer(customerOf(ACC, waId).id))[0]!;
    await say(ACC, waId, 'cancel'); // the list
    await say(ACC, waId, '1'); // the request
    expect(sent().at(-1)).toMatch(/1️⃣ Cancel this request\n2️⃣ Change the date and time/);
    await say(ACC, waId, '2'); // change the time
    expect(customerOf(ACC, waId).menu_state).toBe(FOLLOWUP_STATES.RESCHEDULE);
    await say(ACC, waId, 'tomorrow 8pm'); // closed time: refused, still asked
    expect(sent().at(-1)).toMatch(/outside our opening hours/);
    await say(ACC, waId, 'tomorrow 11am');
    expect(sent().at(-1)).toMatch(new RegExp(`${first.reference} was rescheduled`));
    const rows = runWithAccount(ACC, () => activeFollowupsForCustomer(customerOf(ACC, waId).id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first.id, status: 'scheduled' });
    expect(DateTime.fromISO(rows[0]!.requested_at!).setZone('Asia/Riyadh').toFormat('yyyy-MM-dd HH:mm')).toBe('2026-10-09 11:00');
  });

  it('an Arabic customer whose question cannot be answered gets ONE Arabic automated message with the numbered choices (callback, call us now)', async () => {
    const { waId } = await waitingCustomer(ACC, '1');
    expect(customerOf(ACC, waId).language).toBe('ar');
    const unavailable = sent().filter((t) => /رد تلقائي/.test(t));
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0]).toMatch(/1️⃣ طلب اتصال\n2️⃣ اتصل بنا الآن: \+966112223344/);
    expect(unavailable[0]).not.toMatch(/\{options\}/);
  });
});
