import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/whatsapp/client', () => ({
  sendTextMessage: vi.fn().mockResolvedValue({ messages: [{ id: 'wamid.OUT' }] }),
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
import { getRecentMessages, getOrCreateActiveConversation } from '../../src/memory/conversationRepo';
import { getOrCreateCustomer } from '../../src/memory/customerRepo';
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

describe('end-to-end conversation flow (mocked external services)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('greets, answers a knowledge question, then completes a booking', async () => {
    const waId = '15552220001';

    vi.mocked(chatCompletion).mockResolvedValueOnce(textResponse('Hi! How can I help you today?') as never);
    await processInboundMessage(inbound(waId, 'wamid.g1', 'Hi'), { knowledge });
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

    vi.mocked(chatCompletion).mockResolvedValueOnce(textResponse('Sure, I can help with that.') as never);
    await processInboundMessage(inbound(waId, 'wamid.r1', 'Tell me about your policies'), { knowledge });

    await processInboundMessage(inbound(waId, 'wamid.r2', 'restart'), { knowledge });
    expect(sendTextMessage).toHaveBeenLastCalledWith(
      waId,
      "Done — I've started a fresh conversation. How can I help you?",
    );

    const customer = getOrCreateCustomer(waId, undefined);
    const activeConversation = getOrCreateActiveConversation(customer.id);
    const activeHistory = getRecentMessages(activeConversation.id, 50);
    // Fresh conversation must not carry over the prior turn as active context.
    expect(activeHistory.some((m) => m.content === 'Tell me about your policies')).toBe(false);
  });

  it('serializes rapid concurrent messages from the same customer without corrupting state', async () => {
    const waId = '15552220004';
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
    vi.mocked(chatCompletion).mockRejectedValue(new Error('OpenRouter is down'));

    await processInboundMessage(inbound(waId, 'wamid.e1', 'Hello?'), { knowledge });

    const lastCall = vi.mocked(sendTextMessage).mock.calls.at(-1);
    expect(lastCall?.[1]).not.toMatch(/OpenRouter is down/);
    expect(lastCall?.[1]).toMatch(/went wrong/i);
  });
});
