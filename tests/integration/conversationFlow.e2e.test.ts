import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/whatsapp/client', () => ({
  sendTextMessage: vi.fn().mockResolvedValue({ messages: [{ id: 'wamid.OUT' }] }),
  sendInteractiveMessage: vi.fn().mockResolvedValue({ messages: [{ id: 'wamid.OUT' }] }),
  markMessageAsRead: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/llm/openRouterClient', () => ({
  chatCompletion: vi.fn(),
}));
vi.mock('../../src/calendar/availability', () => ({
  findFreeSlots: vi.fn(),
}));
vi.mock('../../src/calendar/booking', () => ({
  createEvent: vi.fn(),
}));

import { sendTextMessage } from '../../src/whatsapp/client';
import { chatCompletion } from '../../src/llm/openRouterClient';
import { findFreeSlots } from '../../src/calendar/availability';
import { createEvent } from '../../src/calendar/booking';
import { processInboundMessage } from '../../src/pipeline/processInboundMessage';
import { AiResponseError } from '../../src/llm/aiResponseError';
import { resetPromptScalesForTests } from '../../src/llm/promptCap';
import { getDb } from '../../src/memory/db';
import { getRecentMessages, getOrCreateActiveConversation } from '../../src/memory/conversationRepo';
import { getOrCreateCustomer, setCustomerLanguage } from '../../src/memory/customerRepo';
import { loadKnowledgeBase } from '../../src/knowledge/loader';
import path from 'node:path';
import { DateTime } from 'luxon';

const knowledge = loadKnowledgeBase(path.join(__dirname, '..', 'fixtures', 'knowledge'));

function textResponse(content: string) {
  return { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }] };
}

function toolCallResponse(name: string, args: Record<string, unknown>) {
  return {
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }],
        },
      },
    ],
  };
}

function inbound(waId: string, messageId: string, text: string) {
  return { waId, messageId, timestamp: Date.now(), type: 'text', text, contactName: 'Alice' };
}

/** These tests exercise the AI agent loop directly, so pre-select a language to skip the menu gate. */
function preselectLanguage(waId: string) {
  const customer = getOrCreateCustomer(waId, 'Alice');
  setCustomerLanguage(customer.id, 'en');
}

describe('end-to-end conversation flow (mocked external services)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPromptScalesForTests();
  });

  it('greets, answers a knowledge question, then completes a booking', async () => {
    const waId = '15552220001';
    preselectLanguage(waId);

    vi.mocked(chatCompletion).mockResolvedValueOnce(textResponse('Hi! How can I help you today?') as never);
    await processInboundMessage(inbound(waId, 'wamid.g1', 'Tell me about your consultations'), { knowledge });
    expect(sendTextMessage).toHaveBeenLastCalledWith(waId, 'Hi! How can I help you today?');

    vi.mocked(chatCompletion).mockResolvedValueOnce(
      textResponse('We offer a Test Consultation for $50, 30 minutes.') as never,
    );
    await processInboundMessage(inbound(waId, 'wamid.g2', 'What services do you offer?'), { knowledge });
    expect(sendTextMessage).toHaveBeenLastCalledWith(waId, 'We offer a Test Consultation for $50, 30 minutes.');

    const slot = DateTime.fromISO('2999-06-10T10:00:00', { zone: 'UTC' });
    vi.mocked(findFreeSlots).mockResolvedValue([slot]);
    vi.mocked(chatCompletion).mockResolvedValueOnce(
      toolCallResponse('check_availability', { date: '2999-06-10', durationMinutes: 30 }) as never,
    );
    vi.mocked(chatCompletion).mockResolvedValueOnce(
      textResponse('We have 10:00 AM free on 2999-06-10 — shall I book it?') as never,
    );
    await processInboundMessage(inbound(waId, 'wamid.g3', 'Can I book a consultation on 2999-06-10?'), { knowledge });
    expect(findFreeSlots).toHaveBeenCalled();

    vi.mocked(createEvent).mockResolvedValue({ success: true, eventId: 'evt_abc', htmlLink: null });
    vi.mocked(chatCompletion).mockResolvedValueOnce(
      toolCallResponse('book_appointment', {
        startISO: '2999-06-10T10:00:00',
        durationMinutes: 30,
        serviceType: 'Test Consultation',
        customerName: 'Alice',
      }) as never,
    );
    vi.mocked(chatCompletion).mockResolvedValueOnce(
      textResponse("You're all booked for 10:00 AM on 2999-06-10!") as never,
    );
    await processInboundMessage(inbound(waId, 'wamid.g4', 'Yes please, book it'), { knowledge });

    expect(createEvent).toHaveBeenCalled();
    expect(sendTextMessage).toHaveBeenLastCalledWith(waId, "You're all booked for 10:00 AM on 2999-06-10!");

    const customer = getOrCreateCustomer(waId, undefined);
    const conversation = getOrCreateActiveConversation(customer.id);
    const history = getRecentMessages(conversation.id, 50);
    expect(history.length).toBeGreaterThan(4);
  });

  it('never confirms a booking when the calendar reports a conflict', async () => {
    const waId = '15552220002';
    preselectLanguage(waId);

    vi.mocked(createEvent).mockResolvedValue({ success: false, conflict: true });
    vi.mocked(chatCompletion).mockResolvedValueOnce(
      toolCallResponse('book_appointment', {
        startISO: '2999-06-10T10:00:00',
        durationMinutes: 30,
        serviceType: 'Test Consultation',
        customerName: 'Bob',
      }) as never,
    );
    vi.mocked(chatCompletion).mockResolvedValueOnce(
      textResponse('Sorry, that slot was just taken — would another time work?') as never,
    );

    await processInboundMessage(inbound(waId, 'wamid.c1', 'Book me for 10am'), { knowledge });

    expect(sendTextMessage).toHaveBeenLastCalledWith(
      waId,
      'Sorry, that slot was just taken — would another time work?',
    );
  });

  it('restarts the conversation on the "restart" keyword, clearing memory but not history', async () => {
    const waId = '15552220003';
    preselectLanguage(waId);

    vi.mocked(chatCompletion).mockResolvedValueOnce(textResponse('Sure, I can help with that.') as never);
    await processInboundMessage(inbound(waId, 'wamid.r1', 'Tell me about your policies'), { knowledge });

    await processInboundMessage(inbound(waId, 'wamid.r2', 'restart'), { knowledge });
    expect(vi.mocked(sendTextMessage).mock.calls.map((c) => String(c[1])).some((t) => t.includes("I've started a fresh conversation"))).toBe(true);

    const customer = getOrCreateCustomer(waId, undefined);
    const activeConversation = getOrCreateActiveConversation(customer.id);
    const activeHistory = getRecentMessages(activeConversation.id, 50);
    // Fresh conversation must not carry over the prior turn as active context.
    expect(activeHistory.some((m) => m.content === 'Tell me about your policies')).toBe(false);
  });

  it('serializes rapid concurrent messages from the same customer without corrupting state', async () => {
    const waId = '15552220004';
    preselectLanguage(waId);
    vi.mocked(chatCompletion).mockResolvedValue(textResponse('ok') as never);

    await Promise.all([
      processInboundMessage(inbound(waId, 'wamid.race1', 'first'), { knowledge }),
      processInboundMessage(inbound(waId, 'wamid.race2', 'second'), { knowledge }),
      processInboundMessage(inbound(waId, 'wamid.race3', 'third'), { knowledge }),
    ]);

    const customer = getOrCreateCustomer(waId, undefined);
    const conversation = getOrCreateActiveConversation(customer.id);
    const history = getRecentMessages(conversation.id, 50);
    const userMessages = history.filter((m) => m.role === 'user').map((m) => m.content);
    expect(userMessages.sort()).toEqual(['first', 'second', 'third']);
  });

  it('gracefully handles an agent loop failure with a generic, non-technical reply', async () => {
    const waId = '15552220005';
    preselectLanguage(waId);
    vi.mocked(chatCompletion).mockRejectedValue(new Error('OpenRouter is down'));

    await processInboundMessage(inbound(waId, 'wamid.e1', 'Is my car ready for pickup?'), { knowledge });

    const lastCall = vi.mocked(sendTextMessage).mock.calls.at(-1);
    expect(lastCall?.[1]).not.toMatch(/OpenRouter is down/);
    expect(lastCall?.[1]).toMatch(/went wrong/i);
  });
  describe('an AI answer that gives the customer nothing usable is a FAILED answer', () => {
    const activityFor = (waId: string) => getDb().prepare('SELECT kind, detail FROM reply_activity WHERE wa_id = ? ORDER BY id').all(waId) as Array<{ kind: string; detail: string | null }>;

    it('HTTP 200 with an empty message sends the neutral fallback, stores no empty reply, and is NOT counted as an AI success', async () => {
      const waId = '15552220006';
      preselectLanguage(waId);
      vi.mocked(chatCompletion).mockResolvedValue(textResponse('   ') as never);

      await processInboundMessage(inbound(waId, 'wamid.empty1', 'How much is a 4 litre bucket of paint?'), { knowledge });

      expect(vi.mocked(sendTextMessage).mock.calls.at(-1)?.[1]).toMatch(/went wrong/i);
      const rows = activityFor(waId);
      expect(rows.some((r) => r.kind === 'ai')).toBe(false);
      expect(rows.at(-1)).toMatchObject({ kind: 'error' });
      expect(rows.at(-1)!.detail).toMatch(/^AI failed; fallback sent \(empty response/);
      const conversation = getOrCreateActiveConversation(getOrCreateCustomer(waId, undefined).id);
      const assistant = getRecentMessages(conversation.id, 50).filter((m) => m.role === 'assistant').map((m) => m.content);
      expect(assistant.every((c) => c.trim().length > 0)).toBe(true);
      expect(chatCompletion).toHaveBeenCalledTimes(1); // the pipeline itself never re-asks: one provider round per customer message
    });

    it('a refused model is logged with its category, HTTP status and model name — and none of that reaches the customer', async () => {
      const waId = '15552220007';
      preselectLanguage(waId);
      vi.mocked(chatCompletion).mockRejectedValue(new AiResponseError('model_unavailable', 404, 'openrouter/free', '0 endpoints available matching your guardrail restrictions'));

      await processInboundMessage(inbound(waId, 'wamid.refused1', 'Do you have Jotun paint?'), { knowledge });

      const reply = String(vi.mocked(sendTextMessage).mock.calls.at(-1)?.[1]);
      expect(reply).toMatch(/went wrong/i);
      expect(reply).not.toMatch(/openrouter|guardrail|404|model/i);
      expect(activityFor(waId).at(-1)).toMatchObject({ kind: 'error', detail: 'AI failed; fallback sent (model unavailable, HTTP 404, model openrouter/free)' });
    });

    it('PRODUCTION 2026-10-13: an exhausted OpenRouter credit (HTTP 402) is named for staff, the customer hears the apology ONCE per window, and later messages are not spammed with it', async () => {
      const waId = '15552220017';
      preselectLanguage(waId);
      vi.mocked(chatCompletion).mockRejectedValue(new AiResponseError('payment_required', 402, 'openai/gpt-4.1-mini', 'Prompt tokens limit exceeded: 14140 > 10822. To increase, visit https://openrouter.ai/settings/credits'));
      await processInboundMessage(inbound(waId, 'wamid.credit1', 'I want to sell my building'), { knowledge });
      const reply = String(vi.mocked(sendTextMessage).mock.calls.at(-1)?.[1]);
      expect(reply).toMatch(/went wrong/i);
      expect(reply).not.toMatch(/402|credit|openrouter|token/i);
      expect(activityFor(waId).at(-1)).toMatchObject({ kind: 'error' });
      expect(activityFor(waId).at(-1)!.detail).toMatch(/^AI failed; fallback sent \(OpenRouter credits exhausted or too low for this prompt, HTTP 402, model openai\/gpt-4\.1-mini — Prompt tokens limit exceeded/);
      expect(activityFor(waId).at(-1)!.detail).toContain('openrouter.ai/settings/credits');
      const sentBefore = vi.mocked(sendTextMessage).mock.calls.length;
      await processInboundMessage(inbound(waId, 'wamid.credit2', 'what services do you offer?'), { knowledge });
      expect(vi.mocked(sendTextMessage).mock.calls.length).toBe(sentBefore); // no second apology within the window
      expect(activityFor(waId).at(-1)).toMatchObject({ kind: 'suppressed' });
      expect(activityFor(waId).at(-1)!.detail).toMatch(/credits exhausted \(HTTP 402\)/);
    });

    it('a 402 that names the provider token cap is answered by ONE retry with a smaller prompt, and the next message starts small', async () => {
      resetPromptScalesForTests();
      const waId = '15552220018';
      preselectLanguage(waId);
      vi.mocked(chatCompletion)
        .mockRejectedValueOnce(new AiResponseError('payment_required', 402, 'openai/gpt-4.1-mini', 'Prompt tokens limit exceeded: 6666 > 6196. To increase, visit https://openrouter.ai/settings/credits'))
        .mockResolvedValue(textResponse('Happy to help with your building.') as never);
      await processInboundMessage(inbound(waId, 'wamid.cap1', 'I want to sell my building'), { knowledge });
      expect(chatCompletion).toHaveBeenCalledTimes(2);
      expect(String(vi.mocked(sendTextMessage).mock.calls.at(-1)?.[1])).toContain('Happy to help');
      const lengthOf = (call: number) => JSON.stringify(vi.mocked(chatCompletion).mock.calls[call]![0]).length;
      expect(lengthOf(1)).toBeLessThanOrEqual(lengthOf(0));
      await processInboundMessage(inbound(waId, 'wamid.cap2', 'and the price?'), { knowledge });
      expect(chatCompletion).toHaveBeenCalledTimes(3); // no failed first attempt this time
      resetPromptScalesForTests();
    });

    it('a token-cap 402 AFTER a tool round is never retried (the loop would re-run tools): one failed answer, the safe fallback, no success recorded', async () => {
      const waId = '15552220019';
      preselectLanguage(waId);
      vi.mocked(chatCompletion)
        .mockResolvedValueOnce(toolCallResponse('no_such_tool', {}) as never)
        .mockRejectedValue(new AiResponseError('payment_required', 402, 'openai/gpt-4.1-mini', 'Prompt tokens limit exceeded: 6666 > 6196. To increase, visit https://openrouter.ai/settings/credits'));
      await processInboundMessage(inbound(waId, 'wamid.cap3', 'check something'), { knowledge });
      expect(chatCompletion).toHaveBeenCalledTimes(2); // round 1 (tool) + round 2 (402); no second loop
      expect(String(vi.mocked(sendTextMessage).mock.calls.at(-1)?.[1])).toMatch(/went wrong/i);
      expect(activityFor(waId).at(-1)).toMatchObject({ kind: 'error' });
      expect(activityFor(waId).some((r) => r.kind === 'ai')).toBe(false);
    });

    it('a model that never stops calling tools is cut off at the round cap and answered with the fallback, not a fake success', async () => {
      const waId = '15552220008';
      preselectLanguage(waId);
      vi.mocked(chatCompletion).mockResolvedValue(toolCallResponse('no_such_tool', {}) as never);

      await processInboundMessage(inbound(waId, 'wamid.loop1', 'Please check something'), { knowledge });

      expect(chatCompletion).toHaveBeenCalledTimes(4); // MAX_TOOL_ROUNDS in the test environment: bounded provider cost
      expect(activityFor(waId).at(-1)!.detail).toMatch(/tool rounds exhausted/);
      expect(activityFor(waId).some((r) => r.kind === 'ai')).toBe(false);
    });
  });
});