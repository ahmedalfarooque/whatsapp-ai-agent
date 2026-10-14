import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { processInboundMessage } from '../../src/pipeline/processInboundMessage';
import { getDb } from '../../src/memory/db';
import { createAccount } from '../../src/accounts/accountRepo';
import { runWithAccount } from '../../src/accounts/accountContext';
import { getCustomerByWaId, setCustomerMenuState } from '../../src/memory/customerRepo';
import { getBusinessSettings, updateBusinessSettings } from '../../src/config/businessSettings';
import { AiResponseError } from '../../src/llm/aiResponseError';
import { getHold, requestHandoff } from '../../src/handoff/handoffRepo';
import { activeFollowupsForCustomer, getFollowup, listFollowupEvents, type FollowupRequest } from '../../src/followups/followupRepo';
import { callWindow, cancelFollowup, completeFollowup, createFollowup, FollowupError, recordCallOpened, registerFollowupJobs, rescheduleFollowup, telUrlFor } from '../../src/followups/followupService';
import { listJobsFor, runDueJobs, resetJobHandlersForTests } from '../../src/jobs/scheduler';
import { listStaffNotifications } from '../../src/notifications/staffNotifications';
import { FOLLOWUP_STATES } from '../../src/followups/customerFlow';
import type { InboundMessage } from '../../src/webhook/parseInboundPayload';

/**
 * The after-hours experience and the follow-up requests, end to end on a generic business: the customer writes while the business is
 * closed, is told so once, chooses a callback (with the business's appointment type) or an agreed time, can cancel; staff get a persistent
 * notification and the WhatsApp alert; reminders are durable jobs with a 30-minute call window; the "Call customer" action is a tel: URL
 * enforced by the server. Time is frozen (Date only) so "closed", "next opening" and the windows are deterministic. Riyadh = UTC+3.
 */
const reply = (content: string) => ({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }] });
let counter = 0;
const KB = { sections: [], asPromptText: 'We tint windows and fit accessories.' };
let ACC: number;
let OTHER: number;
const msg = (waId: string, text: string): InboundMessage => ({ waId, messageId: `wamid.fu.${++counter}`, timestamp: Date.now(), type: 'text', text, accountId: ACC });
const sent = () => vi.mocked(sendTextMessage).mock.calls.map((c) => c[1]);
const lastSent = () => sent()[sent().length - 1] ?? '';
const CLOSED_NOW = new Date('2026-10-07T20:00:00Z'); // Wednesday 23:00 Riyadh — closed (09:00-18:00); next opening Thursday 09:00
const OPEN_NOW = new Date('2026-10-08T07:00:00Z'); // Thursday 10:00 Riyadh — open
const riyadh = (iso: string) => DateTime.fromISO(iso, { zone: 'Asia/Riyadh' });
const db = () => getDb();
const activityKinds = (waId: string): string[] => (db().prepare('SELECT kind FROM reply_activity WHERE wa_id = ? ORDER BY id').all(waId) as { kind: string }[]).map((r) => r.kind);
const customerOf = (waId: string) => runWithAccount(ACC, () => getCustomerByWaId(waId, undefined, ACC))!;
const newWa = () => `96655${String(++counter).padStart(7, '0')}`;

beforeAll(() => {
  getDb();
  ACC = createAccount({ name: 'Pearl Dental' }).id;
  OTHER = createAccount({ name: 'Other Shop' }).id;
  runWithAccount(ACC, () => updateBusinessSettings({ businessTimezone: 'Asia/Riyadh', businessHoursStart: '09:00', businessHoursEnd: '18:00', businessDays: '1,2,3,4,5,6,7', contactPhone: '+966112223344', staffWhatsappNumber: '+966500000000', reminderRepeatMinutes: 5, reminderMaxAttempts: 2 }, ACC));
  registerFollowupJobs();
});
afterAll(() => { resetJobHandlersForTests(); });
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(chatCompletion).mockResolvedValue(reply('Our tinting starts from the basic package; ask us for a quote.') as never);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(CLOSED_NOW);
});
afterEach(() => { vi.useRealTimers(); });

async function englishCustomer(): Promise<string> {
  const waId = newWa();
  await processInboundMessage(msg(waId, 'hi'), { knowledge: KB });
  await processInboundMessage(msg(waId, '2'), { knowledge: KB });
  return waId;
}

describe('after hours: the customer is told once, offered the follow-up choices, and still gets answers', () => {
  it('after choosing a language while closed: main menu, then the closed notice (hours + next opening) and the follow-up menu, once', async () => {
    const waId = await englishCustomer();
    const texts = sent();
    expect(texts).toHaveLength(4);
    expect(texts[1]).toMatch(/Welcome to Pearl Dental/);
    expect(texts[2]).toMatch(/Pearl Dental is currently closed/);
    expect(texts[2]).toMatch(/9:00 AM - 6:00 PM/);
    expect(texts[2]).toMatch(/We will be back tomorrow at 9:00 AM/);
    expect(texts[2]).not.toMatch(/within/); // no response-time promise unless the business set one
    expect(texts[3]).toMatch(/1️⃣ Request a callback\n2️⃣ Call us now: \+966112223344/);
    expect(texts[3]).not.toMatch(/WhatsApp message|Choose a callback|appointment/); // short: callback, call, (manage only when a request exists)
    expect(customerOf(waId).menu_state).toBe(FOLLOWUP_STATES.MENU);
    // a question while in the follow-up menu is answered by the assistant, and the notice is NOT repeated
    await processInboundMessage(msg(waId, 'how much is window tinting?'), { knowledge: KB });
    expect(chatCompletion).toHaveBeenCalledTimes(1);
    expect(sent()).toHaveLength(5);
    expect(String(vi.mocked(chatCompletion).mock.calls[0]![0].messages[0]!.content)).toMatch(/BUSINESS STATUS NOW: CLOSED \(reopens tomorrow at 9:00 AM\)/);
    expect(customerOf(waId).menu_state).toBe(FOLLOWUP_STATES.MENU); // the choices stay available
  });

  it('SCREENSHOTS: while closed and the assistant is unavailable (HTTP 402), the customer gets the closed notice and the callback choices — never "something went wrong" — and can still finish a callback', async () => {
    const waId = await englishCustomer(); // closed: notice + menu sent, menu state waiting
    vi.mocked(chatCompletion).mockRejectedValue(new AiResponseError('payment_required', 402, 'openai/gpt-4.1-mini', 'Insufficient credits'));
    vi.mocked(sendTextMessage).mockClear();
    // in the follow-up menu, free text goes to the assistant; it is down, so ONE automated message carries the closed notice and the choices
    await processInboundMessage(msg(waId, 'Call me back please'), { knowledge: KB });
    expect(sent()).toHaveLength(1);
    expect(sent().join('\n')).not.toMatch(/went wrong/i);
    expect(sent()[0]).toMatch(/assistant cannot answer right now[\s\S]*is closed[\s\S]*1️⃣ Request a callback\n2️⃣ Call us now/);
    expect(customerOf(waId).menu_state).toBe(FOLLOWUP_STATES.MENU);
    expect(activityKinds(waId)).toContain('error'); // staff still see the genuine failure
    // the whole callback still works without the assistant
    await processInboundMessage(msg(waId, '1'), { knowledge: KB }); // request a callback
    expect(lastSent()).toMatch(/When should we call you back\?[\s\S]*1️⃣ As soon as possible[\s\S]*2️⃣ Choose a date and time/);
    await processInboundMessage(msg(waId, '1'), { knowledge: KB }); // as soon as possible
    expect(lastSent()).toMatch(/Your request is saved\./);
    expect(lastSent()).toMatch(/Reference: CB-/);
    expect(lastSent()).not.toMatch(/About:/); // the appointment type is no longer asked
    expect(customerOf(waId).menu_state).toBe('MAIN_MENU');
    // with the assistant still down: the earlier automated reply stands — no second unavailable message, no second menu
    vi.mocked(sendTextMessage).mockClear();
    await processInboundMessage(msg(waId, 'any news about my tinting?'), { knowledge: KB });
    expect(sent()).toHaveLength(0);
    expect(activityKinds(waId).filter((k) => k === 'error').length).toBeGreaterThanOrEqual(2); // staff still see every genuine failure
    expect(customerOf(waId).menu_state).toBe(FOLLOWUP_STATES.MENU);
    await processInboundMessage(msg(waId, '0'), { knowledge: KB });
    expect(customerOf(waId).menu_state).toBe('MAIN_MENU');
  });

  it('when the business is OPEN and the assistant is unavailable, the customer still gets the automated choices (not "something went wrong"), with the open-hours menu', async () => {
    vi.setSystemTime(OPEN_NOW);
    const waId = await englishCustomer();
    vi.mocked(chatCompletion).mockRejectedValue(new AiResponseError('payment_required', 402, 'openai/gpt-4.1-mini', 'Insufficient credits'));
    vi.mocked(sendTextMessage).mockClear();
    await processInboundMessage(msg(waId, 'how much is tinting?'), { knowledge: KB });
    expect(sent().join('\n')).not.toMatch(/went wrong/i);
    expect(sent().join('\n')).not.toMatch(/currently closed/);
    expect(sent()).toHaveLength(1); // ONE message: the honest notice and the choices together
    expect(sent()[0]).toMatch(/Automated reply: our assistant cannot answer right now, but our team can help[\s\S]*2️⃣ Call us now: \+966112223344/);
    expect(customerOf(waId).menu_state).toBe(FOLLOWUP_STATES.MENU);
    // and a callback request completes without the assistant
    await processInboundMessage(msg(waId, '1'), { knowledge: KB });
    await processInboundMessage(msg(waId, '1'), { knowledge: KB });
    expect(lastSent()).toMatch(/Your request is saved/);
    expect(activeFollowupsForCustomer(customerOf(waId).id, undefined, ACC)).toHaveLength(1);
  });

  it('callback → appointment type → saved as pending until the business opens; staff get a persistent notification, a WhatsApp alert and a durable job', async () => {
    const waId = await englishCustomer();
    vi.mocked(sendTextMessage).mockClear();
    await processInboundMessage(msg(waId, '1'), { knowledge: KB });
    expect(lastSent()).toMatch(/When should we call you back\?[\s\S]*1️⃣ As soon as possible[\s\S]*2️⃣ Choose a date and time/);
    expect(customerOf(waId).menu_state).toBe(FOLLOWUP_STATES.CALLBACK);
    await processInboundMessage(msg(waId, '1'), { knowledge: KB });
    const confirmation = lastSent();
    expect(confirmation).toMatch(/Your request is saved\./);
    expect(confirmation).toMatch(/Reference: CB-/);
    expect(confirmation).not.toMatch(/About:/);
    expect(confirmation).toMatch(/Method: Phone call/);
    expect(confirmation).toMatch(/Staff are not available right now; they will contact you after we reopen tomorrow at 9:00 AM/);
    expect(customerOf(waId).menu_state).toBe('MAIN_MENU');
    const row = runWithAccount(ACC, () => activeFollowupsForCustomer(customerOf(waId).id))[0]!;
    expect(row).toMatchObject({ status: 'pending', contact_method: 'call', asap: 1, requested_at: null, source: 'customer' });
    expect(DateTime.fromISO(row.eligible_at!).toUTC().toISO()).toBe(riyadh('2026-10-08T09:00:00').toUTC().toISO());
    const notifications = listStaffNotifications({ accountIds: [ACC], adminUserId: 1, status: 'open' });
    expect(notifications.filter((n) => n.followup_id === row.id)).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ kind: 'followup_new', ring: 0, admin_user_id: null });
    expect(notifications[0]!.body).toMatch(/Phone call[\s\S]*when staff are back/);
    const outbox = db().prepare("SELECT target_jid, kind, body FROM notification_outbox WHERE dedupe_key = ?").get(`outbox:followup:new:${row.id}`) as { target_jid: string; kind: string; body: string };
    expect(outbox).toMatchObject({ target_jid: '966500000000@s.whatsapp.net', kind: 'staff_followup' });
    expect(outbox.body).toContain(`+${waId}`);
    const jobs = listJobsFor('followup', row.id);
    expect(jobs.map((j) => [j.kind, j.status])).toEqual([['followup_eligible', 'pending']]);
    expect(listFollowupEvents(row.id).map((e) => e.event)).toEqual(['created']);
  });

  it('"as soon as staff are available" becomes actionable (and rings) when the business opens; "cancel" lists and cancels the request and stops the jobs', async () => {
    const waId = await englishCustomer();
    await processInboundMessage(msg(waId, '1'), { knowledge: KB }); // request a callback
    await processInboundMessage(msg(waId, '1'), { knowledge: KB }); // as soon as possible
    expect(lastSent()).toMatch(/Your request is saved/);
    const row = runWithAccount(ACC, () => activeFollowupsForCustomer(customerOf(waId).id))[0]!;
    expect(row.status).toBe('pending');
    // the business opens: the eligibility job runs, the request becomes actionable and staff are alerted with a ring
    vi.setSystemTime(new Date('2026-10-08T06:00:30Z'));
    expect(await runDueJobs(new Date())).toBeGreaterThanOrEqual(1); // (other tests' requests in this database open at the same moment)
    expect(runWithAccount(ACC, () => getFollowup(row.id))!.status).toBe('eligible');
    expect(listStaffNotifications({ accountIds: [ACC], adminUserId: 1, status: 'open' }).find((n) => n.followup_id === row.id && n.kind === 'followup_eligible')).toMatchObject({ ring: 1 });
    // the customer cancels from WhatsApp
    vi.mocked(sendTextMessage).mockClear();
    await processInboundMessage(msg(waId, 'cancel'), { knowledge: KB });
    expect(lastSent()).toMatch(new RegExp(`1️⃣ ${row.reference} · Phone call`));
    await processInboundMessage(msg(waId, '1'), { knowledge: KB });
    expect(lastSent()).toMatch(/1️⃣ Cancel this request\n2️⃣ Change the date and time/);
    expect(customerOf(waId).menu_state).toBe(FOLLOWUP_STATES.MANAGE);
    await processInboundMessage(msg(waId, '1'), { knowledge: KB });
    expect(lastSent()).toMatch(new RegExp(`Request ${row.reference} has been cancelled and its reminders stopped`));
    const after = runWithAccount(ACC, () => getFollowup(row.id))!;
    expect(after).toMatchObject({ status: 'cancelled', cancelled_by: 'customer' });
    expect(listJobsFor('followup', row.id).every((j) => j.status !== 'pending')).toBe(true);
    expect(listStaffNotifications({ accountIds: [ACC], adminUserId: 1, status: 'open' }).some((n) => n.followup_id === row.id)).toBe(false);
    await processInboundMessage(msg(waId, 'cancel'), { knowledge: KB });
    expect(lastSent()).toMatch(/no open callback or appointment requests/);
  });

  it('an agreed time is validated against the schedule (closed times refused, unreadable text re-asked) and confirmed with the callback window', async () => {
    const waId = await englishCustomer();
    await processInboundMessage(msg(waId, '1'), { knowledge: KB }); // request a callback
    await processInboundMessage(msg(waId, '2'), { knowledge: KB }); // choose a date and time
    expect(lastSent()).toMatch(/When suits you\?/);
    expect(customerOf(waId).menu_state).toBe(FOLLOWUP_STATES.TIME);
    await processInboundMessage(msg(waId, 'whenever'), { knowledge: KB });
    expect(lastSent()).toMatch(/I could not read that time/);
    await processInboundMessage(msg(waId, 'tomorrow 8pm'), { knowledge: KB });
    expect(lastSent()).toMatch(/tomorrow at 8:00 PM is outside our opening hours\. The next opening is tomorrow at 9:00 AM/);
    expect(customerOf(waId).menu_state).toBe(FOLLOWUP_STATES.TIME);
    await processInboundMessage(msg(waId, 'tomorrow 10am'), { knowledge: KB });
    const text = lastSent();
    expect(text).toMatch(/Time: tomorrow at 10:00 AM/);
    expect(text).toMatch(/within 30 minutes/);
    const row = runWithAccount(ACC, () => activeFollowupsForCustomer(customerOf(waId).id))[0]!;
    expect(row).toMatchObject({ status: 'scheduled', asap: 0 });
    expect(DateTime.fromISO(row.requested_at!).toUTC().toISO()).toBe(riyadh('2026-10-08T10:00:00').toUTC().toISO());
    expect(DateTime.fromISO(row.window_end_at!).toUTC().toISO()).toBe(riyadh('2026-10-08T10:30:00').toUTC().toISO());
    expect(listJobsFor('followup', row.id).map((j) => j.kind).sort()).toEqual(['followup_overdue', 'followup_reminder']);
  });
});

describe('the callback window, reminders, overdue and the staff actions (server rules)', () => {
  let row: FollowupRequest;
  const customerId = () => runWithAccount(ACC, () => getCustomerByWaId(waFor, undefined, ACC))!.id;
  let waFor = '';
  beforeEach(async () => {
    waFor = await englishCustomer();
    row = runWithAccount(ACC, () => createFollowup({ customerId: customerId(), contactMethod: 'call', appointmentTypeKey: null, requestedAt: riyadh('2026-10-08T10:00:00').toJSDate(), source: 'customer' }));
  });

  it('before the agreed time the call action is refused; inside the 30-minute window it is allowed and opens the ordinary dialler (tel:), not a WhatsApp call; after it the request is overdue', () => {
    expect(callWindow(row, CLOSED_NOW)).toMatchObject({ state: 'before', allowed: false });
    expect(() => runWithAccount(ACC, () => recordCallOpened(row.id, 1))).toThrow(FollowupError);
    vi.setSystemTime(OPEN_NOW);
    const opened = runWithAccount(ACC, () => recordCallOpened(row.id, 1));
    expect(opened.tel).toBe(`tel:${encodeURIComponent(`+${waFor}`)}`);
    expect(opened.tel).not.toMatch(/whatsapp|wa\.me/);
    expect(opened.row.status).toBe('assigned');
    expect(opened.row.assigned_admin_id).toBe(1);
    expect(listFollowupEvents(row.id).map((e) => e.event)).toContain('call_opened');
    // opening the dialler is not an outcome: the request is still open
    expect(runWithAccount(ACC, () => getFollowup(row.id))!.status).toBe('assigned');
    vi.setSystemTime(new Date('2026-10-08T07:31:00Z'));
    expect(callWindow(runWithAccount(ACC, () => getFollowup(row.id))!, new Date())).toMatchObject({ state: 'after', allowed: false });
    expect(() => runWithAccount(ACC, () => recordCallOpened(row.id, 1))).toThrow(/window has passed/);
  });

  it('the reminder fires at the agreed time (rings, repeats up to the limit), the overdue job closes the window; completing records the outcome and stops everything', async () => {
    vi.setSystemTime(new Date('2026-10-08T07:00:10Z')); // 10:00:10 Riyadh
    await runDueJobs(new Date());
    let notes = listStaffNotifications({ accountIds: [ACC], adminUserId: 1, status: 'open' }).filter((n) => n.followup_id === row.id);
    expect(notes.find((n) => n.kind === 'followup_reminder')).toMatchObject({ ring: 1 });
    expect(runWithAccount(ACC, () => getFollowup(row.id))!.reminder_attempts).toBe(1);
    expect(listJobsFor('followup', row.id).filter((j) => j.kind === 'followup_reminder' && j.status === 'pending')).toHaveLength(1); // the repeat
    vi.setSystemTime(new Date('2026-10-08T07:05:20Z'));
    await runDueJobs(new Date());
    expect(runWithAccount(ACC, () => getFollowup(row.id))!.reminder_attempts).toBe(2);
    expect(listJobsFor('followup', row.id).filter((j) => j.kind === 'followup_reminder' && j.status === 'pending')).toHaveLength(0); // max 2 attempts
    expect(db().prepare("SELECT COUNT(*) AS n FROM notification_outbox WHERE kind = 'staff_followup' AND dedupe_key LIKE ?").get(`outbox:followup:reminder:${row.id}:%`)).toEqual({ n: 2 });
    vi.setSystemTime(new Date('2026-10-08T07:30:30Z'));
    await runDueJobs(new Date());
    expect(runWithAccount(ACC, () => getFollowup(row.id))!.status).toBe('overdue');
    expect(listStaffNotifications({ accountIds: [ACC], adminUserId: 1, status: 'open' }).some((n) => n.followup_id === row.id && n.kind === 'followup_overdue')).toBe(true);
    const done = runWithAccount(ACC, () => completeFollowup(row.id, 1, 'reached', 'Booked for Sunday'));
    expect(done).toMatchObject({ status: 'completed', outcome: 'reached', outcome_note: 'Booked for Sunday' });
    expect(listJobsFor('followup', row.id).every((j) => j.status !== 'pending')).toBe(true);
    notes = listStaffNotifications({ accountIds: [ACC], adminUserId: 1, status: 'open' }).filter((n) => n.followup_id === row.id);
    expect(notes).toHaveLength(0);
    expect(() => runWithAccount(ACC, () => completeFollowup(row.id, 1, 'again'))).toThrow(/cannot be completed/);
    expect(() => runWithAccount(ACC, () => cancelFollowup(row.id, { type: 'staff', adminId: 1 }))).toThrow(/cannot be cancelled/);
    await runDueJobs(new Date('2026-10-09T00:00:00Z'));
    expect(listJobsFor('followup', row.id).map((j) => j.status)).not.toContain('pending'); // nothing of this request is left to run
    expect(runWithAccount(ACC, () => getFollowup(row.id))!.status).toBe('completed'); // and a later pass never reopened it
  });

  it('rescheduling moves the SAME request (no duplicate), re-times the jobs and refuses times outside the hours; a cancelled request cannot be called', () => {
    const moved = runWithAccount(ACC, () => rescheduleFollowup(row.id, { type: 'staff', adminId: 1 }, riyadh('2026-10-09T11:00:00').toJSDate()));
    expect(moved).toMatchObject({ id: row.id, status: 'scheduled', reminder_attempts: 0 });
    expect(runWithAccount(ACC, () => activeFollowupsForCustomer(customerId()))).toHaveLength(1);
    const reminder = listJobsFor('followup', row.id).find((j) => j.kind === 'followup_reminder' && j.status === 'pending')!;
    expect(reminder.run_at).toBe(riyadh('2026-10-09T11:00:00').toUTC().toFormat('yyyy-MM-dd HH:mm:ss'));
    expect(listFollowupEvents(row.id).map((e) => e.event)).toContain('rescheduled');
    expect(() => runWithAccount(ACC, () => rescheduleFollowup(row.id, { type: 'staff', adminId: 1 }, riyadh('2026-10-09T20:00:00').toJSDate()))).toThrow(/outside the opening hours/);
    expect(() => runWithAccount(ACC, () => rescheduleFollowup(row.id, { type: 'staff', adminId: 1 }, riyadh('2026-10-07T10:00:00').toJSDate()))).toThrow(/already passed/);
    runWithAccount(ACC, () => cancelFollowup(row.id, { type: 'staff', adminId: 1 }, 'customer called us'));
    vi.setSystemTime(riyadh('2026-10-09T11:05:00').toJSDate());
    expect(() => runWithAccount(ACC, () => recordCallOpened(row.id, 1))).toThrow(/cancelled/);
    expect(callWindow(runWithAccount(ACC, () => getFollowup(row.id))!)).toMatchObject({ state: 'closed', allowed: false });
  });

  it('a request belongs to one business: another business cannot see, cancel or call it; a privacy-only id has no dialable number', () => {
    expect(runWithAccount(OTHER, () => getFollowup(row.id))).toBeUndefined();
    expect(() => runWithAccount(OTHER, () => cancelFollowup(row.id, { type: 'staff', adminId: 1 }))).toThrow(/not found/);
    expect(() => runWithAccount(OTHER, () => recordCallOpened(row.id, 1))).toThrow(/not found/);
    expect(telUrlFor('123456789012345@lid')).toBeNull();
    expect(telUrlFor('abc')).toBeNull();
    expect(telUrlFor('966501234567')).toBe('tel:%2B966501234567');
  });
});

describe('while the business is open', () => {
  it('no closed notice is sent, "as soon as possible" is actionable at once, and the follow-up menu offers the direct call with the business phone', async () => {
    vi.setSystemTime(OPEN_NOW);
    const waId = await englishCustomer();
    expect(sent()).toHaveLength(2); // language selection + main menu only
    runWithAccount(ACC, () => setCustomerMenuState(customerOf(waId).id, FOLLOWUP_STATES.MENU, null));
    await processInboundMessage(msg(waId, '2'), { knowledge: KB }); // Call us now
    expect(lastSent()).toMatch(/We are open now\. You can call us directly on \+966112223344 until today at 6:00 PM/);
    runWithAccount(ACC, () => setCustomerMenuState(customerOf(waId).id, FOLLOWUP_STATES.MENU, null));
    await processInboundMessage(msg(waId, '1'), { knowledge: KB });
    await processInboundMessage(msg(waId, '1'), { knowledge: KB });
    expect(lastSent()).toMatch(/Your request is saved and the team has been notified[\s\S]*A member of staff will contact you as soon as possible/);
    const row = runWithAccount(ACC, () => activeFollowupsForCustomer(customerOf(waId).id))[0]!;
    expect(row.status).toBe('eligible');
    expect(callWindow(row)).toMatchObject({ state: 'open', allowed: true });
    expect(listStaffNotifications({ accountIds: [ACC], adminUserId: 1, status: 'open' }).find((n) => n.followup_id === row.id)).toMatchObject({ kind: 'followup_new', ring: 1 });
  });
});

describe('SCREENSHOT 2026-10-14: the assistant works 24/7; business hours decide the closure notice and staff availability, never whether the AI answers', () => {
  const holdOf = (waId: string) => runWithAccount(ACC, () => getHold(customerOf(waId).id));

  it('after hours the AI answers the actual question FIRST, the closed notice + choices follow once, and later answers never repeat the notice', async () => {
    const waId = await englishCustomer(); // closed: welcome, notice, menu
    vi.mocked(sendTextMessage).mockClear();
    vi.mocked(chatCompletion).mockResolvedValue(reply('Ceramic tint starts at 450 SAR for a sedan.') as never);
    await processInboundMessage(msg(waId, 'how much is ceramic tint?'), { knowledge: KB });
    expect(sent()).toEqual(['Ceramic tint starts at 450 SAR for a sedan.']); // the answer, nothing appended
    await processInboundMessage(msg(waId, 'and for an SUV?'), { knowledge: KB });
    expect(sent()).toHaveLength(2);
    expect(sent().join('\n')).not.toMatch(/currently closed/);
    expect(chatCompletion).toHaveBeenCalledTimes(2);
    expect(String(vi.mocked(chatCompletion).mock.calls[1]![0].messages[0]!.content)).toMatch(/BUSINESS STATUS NOW: CLOSED/); // the model knows it is closed and says so when relevant
  });

  it('"agent" after hours: NO silent hold — an honest "nobody is available until …" with the choices, ONE staff notification, and the assistant keeps answering', async () => {
    const waId = await englishCustomer();
    vi.mocked(sendTextMessage).mockClear();
    await processInboundMessage(msg(waId, 'I want to talk to an agent'), { knowledge: KB });
    expect(sent()).toHaveLength(1); // one message: the honest hand-over and the choices
    expect(sent()[0]).toMatch(/No one from our team is available right now: Pearl Dental is currently closed; we will be back tomorrow at 9:00 AM/);
    expect(sent()[0]).toMatch(/The team has been notified[\s\S]*1️⃣ Request a callback/);
    expect(holdOf(waId)).toBeNull(); // not parked for the night
    expect(customerOf(waId).menu_state).toBe(FOLLOWUP_STATES.MENU);
    const notes = listStaffNotifications({ accountIds: [ACC], adminUserId: 1, status: 'open' }).filter((n) => n.kind === 'handoff_after_hours' && n.customer_id === customerOf(waId).id);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).not.toMatch(new RegExp(waId)); // the number is masked in the notification body
    // asking again within the window: told again, but no second notification row
    vi.mocked(sendTextMessage).mockClear();
    await processInboundMessage(msg(waId, 'agent please'), { knowledge: KB });
    expect(sent()[0]).toMatch(/No one from our team is available right now/);
    expect(listStaffNotifications({ accountIds: [ACC], adminUserId: 1, status: 'open' }).filter((n) => n.kind === 'handoff_after_hours' && n.customer_id === customerOf(waId).id)).toHaveLength(1);
    // a question is still answered by the assistant (no hold), and a callback still completes without it
    vi.mocked(sendTextMessage).mockClear();
    await processInboundMessage(msg(waId, 'do you fit dash cams?'), { knowledge: KB });
    expect(lastSent()).toMatch(/Our tinting starts from the basic package/);
    await processInboundMessage(msg(waId, '1'), { knowledge: KB });
    await processInboundMessage(msg(waId, '1'), { knowledge: KB });
    expect(lastSent()).toMatch(/Your request is saved/);
    expect(runWithAccount(ACC, () => activeFollowupsForCustomer(customerOf(waId).id))).toHaveLength(1);
  });

  it('"agent" while OPEN keeps the real hand-off: the hold is created and the assistant goes quiet for that customer', async () => {
    vi.setSystemTime(OPEN_NOW);
    const waId = await englishCustomer();
    vi.mocked(sendTextMessage).mockClear();
    await processInboundMessage(msg(waId, 'I want to talk to an agent'), { knowledge: KB });
    expect(holdOf(waId)).toMatchObject({ state: 'HUMAN_REQUESTED', source: 'customer' });
    expect(sent().join('\n')).not.toMatch(/No one from our team is available/);
    vi.mocked(chatCompletion).mockClear();
    await processInboundMessage(msg(waId, 'hello?'), { knowledge: KB });
    expect(chatCompletion).not.toHaveBeenCalled();
  });

  it('the assistant itself hands off while closed: its hold is released, the customer gets the honest closed hand-over and the choices', async () => {
    const waId = await englishCustomer();
    vi.mocked(sendTextMessage).mockClear();
    vi.mocked(chatCompletion).mockImplementation(async () => {
      runWithAccount(ACC, () => requestHandoff({ customerId: customerOf(waId).id, conversationId: null, source: 'ai', reason: 'customer wants a person' }, { type: 'assistant' }));
      return reply('Let me connect you with the team.') as never;
    });
    await processInboundMessage(msg(waId, 'can a person call me?'), { knowledge: KB });
    expect(sent()[0]).toMatch(/No one from our team is available right now/);
    expect(sent().join('\n')).not.toMatch(/Let me connect you/);
    expect(holdOf(waId)).toBeNull();
    expect(customerOf(waId).menu_state).toBe(FOLLOWUP_STATES.MENU);
  });

  it('a callback request repeated within two minutes (double tap / repeated webhook) is ONE request, one staff alert, one job', async () => {
    const waId = await englishCustomer();
    const customerId = customerOf(waId).id;
    const first = runWithAccount(ACC, () => createFollowup({ customerId, conversationId: null, contactMethod: 'call', appointmentTypeKey: null, requestedAt: null, asap: true, source: 'customer' }));
    const second = runWithAccount(ACC, () => createFollowup({ customerId, conversationId: null, contactMethod: 'call', appointmentTypeKey: null, requestedAt: null, asap: true, source: 'customer' }));
    expect(second.id).toBe(first.id);
    expect(runWithAccount(ACC, () => activeFollowupsForCustomer(customerId))).toHaveLength(1);
    expect(listStaffNotifications({ accountIds: [ACC], adminUserId: 1, status: 'open' }).filter((n) => n.followup_id === first.id)).toHaveLength(1);
    expect(runWithAccount(ACC, () => listJobsFor('followup', first.id))).toHaveLength(1);
    // a DIFFERENT request (WhatsApp message instead of a call) is a new one
    const third = runWithAccount(ACC, () => createFollowup({ customerId, conversationId: null, contactMethod: 'whatsapp', appointmentTypeKey: null, requestedAt: null, asap: true, source: 'customer' }));
    expect(third.id).not.toBe(first.id);
  });

  it('a request for a selected future time is validated against the business hours and timezone, persisted, and staff are notified', async () => {
    const waId = await englishCustomer();
    vi.mocked(sendTextMessage).mockClear();
    await processInboundMessage(msg(waId, '1'), { knowledge: KB }); // request a callback
    await processInboundMessage(msg(waId, '2'), { knowledge: KB }); // choose a date and time
    await processInboundMessage(msg(waId, 'tomorrow 7am'), { knowledge: KB }); // before opening: rejected with the hours, still asked
    expect(lastSent()).toMatch(/outside|Opening hours/i);
    expect(customerOf(waId).menu_state).toBe(FOLLOWUP_STATES.TIME);
    await processInboundMessage(msg(waId, 'tomorrow 10am'), { knowledge: KB });
    expect(lastSent()).toMatch(/Your request is saved/);
    const row = runWithAccount(ACC, () => activeFollowupsForCustomer(customerOf(waId).id))[0]!;
    expect(row.status).toBe('scheduled');
    expect(row.requested_at).toBe(riyadh('2026-10-08T10:00:00').toUTC().toISO());
    expect(listStaffNotifications({ accountIds: [ACC], adminUserId: 1, status: 'open' }).find((n) => n.followup_id === row.id)).toMatchObject({ kind: 'followup_new' });
  });

  it('a brand-new business inherits the same after-hours defaults (enabled, 30-minute window) and its own empty hours mean no closed notice is ever guessed', async () => {
    const fresh = createAccount({ name: 'Fresh Bakery' }).id;
    const settings = runWithAccount(fresh, () => getBusinessSettings(fresh));
    expect(settings.afterHoursEnabled).toBe(true);
    expect(settings.callbackWindowMinutes).toBe(30);
    expect(settings.hoursConfigured).toBe(false);
    expect(settings.openRouterFallbackModels).toEqual([]);
    expect(runWithAccount(fresh, () => activeFollowupsForCustomer(1, undefined, fresh))).toEqual([]); // nothing of another business is visible
  });
});
