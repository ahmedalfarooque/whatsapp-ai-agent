import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/whatsapp/client', () => ({
  sendTextMessage: vi.fn().mockResolvedValue({ messaging_product: 'whatsapp', contacts: [], messages: [{ id: 'w1' }] }),
  sendInteractiveMessage: vi.fn().mockResolvedValue({ messaging_product: 'whatsapp', contacts: [], messages: [{ id: 'w2' }] }),
}));

vi.mock('../../../src/llm/agentLoop', () => ({
  runAgentLoop: vi.fn().mockResolvedValue({ finalText: 'AI reply', generatedMessages: [] }),
}));

import { sendTextMessage, sendInteractiveMessage } from '../../../src/whatsapp/client';
import { runAgentLoop } from '../../../src/llm/agentLoop';
import { processInboundMessage } from '../../../src/pipeline/processInboundMessage';
import { getCustomerByWaId } from '../../../src/memory/customerRepo';
import { MENU_IDS } from '../../../src/automation/menu';
import type { InboundMessage } from '../../../src/webhook/parseInboundPayload';

const KNOWLEDGE = { sections: [], asPromptText: '' };

function textMsg(waId: string, text: string, overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    waId,
    messageId: `wamid.${Math.random()}`,
    timestamp: Date.now(),
    type: 'text',
    text,
    ...overrides,
  };
}

function interactiveMsg(waId: string, interactiveId: string): InboundMessage {
  return {
    waId,
    messageId: `wamid.${Math.random()}`,
    timestamp: Date.now(),
    type: 'interactive',
    interactiveId,
  };
}

describe('processInboundMessage — bilingual menu automation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('A: sends the language selection buttons on first contact, before anything else', async () => {
    await processInboundMessage(textMsg('15550000001', 'hi'), { knowledge: KNOWLEDGE });

    expect(sendInteractiveMessage).toHaveBeenCalledTimes(1);
    const [, message] = vi.mocked(sendInteractiveMessage).mock.calls[0];
    expect(message.kind).toBe('buttons');
    expect(runAgentLoop).not.toHaveBeenCalled();
  });

  it('B: re-asks for language on every message until one is chosen', async () => {
    await processInboundMessage(textMsg('15550000002', 'random text'), { knowledge: KNOWLEDGE });
    await processInboundMessage(textMsg('15550000002', 'still nothing'), { knowledge: KNOWLEDGE });

    expect(sendInteractiveMessage).toHaveBeenCalledTimes(2);
    expect(runAgentLoop).not.toHaveBeenCalled();
  });

  it('C: tapping the English language button sets language and sends welcome + main menu', async () => {
    const waId = '15550000003';
    await processInboundMessage(interactiveMsg(waId, MENU_IDS.LANG_EN), { knowledge: KNOWLEDGE });

    expect(getCustomerByWaId(waId)?.language).toBe('en');
    expect(sendTextMessage).toHaveBeenCalledOnce();
    expect(sendInteractiveMessage).toHaveBeenCalledOnce();
    const [, mainMenu] = vi.mocked(sendInteractiveMessage).mock.calls[0];
    expect(mainMenu.kind).toBe('list');
  });

  it('D: tapping the Arabic language button sets language to ar', async () => {
    const waId = '15550000004';
    await processInboundMessage(interactiveMsg(waId, MENU_IDS.LANG_AR), { knowledge: KNOWLEDGE });

    expect(getCustomerByWaId(waId)?.language).toBe('ar');
  });

  it('E: typing "English" as free text also selects the language (fallback for non-button replies)', async () => {
    const waId = '15550000005';
    await processInboundMessage(textMsg(waId, 'English'), { knowledge: KNOWLEDGE });

    expect(getCustomerByWaId(waId)?.language).toBe('en');
  });

  it('F: selecting a category from the main menu shows the category prompt, not the AI', async () => {
    const waId = '15550000006';
    await processInboundMessage(interactiveMsg(waId, MENU_IDS.LANG_EN), { knowledge: KNOWLEDGE });
    vi.clearAllMocks();

    await processInboundMessage(interactiveMsg(waId, MENU_IDS.CATEGORY_AUDIO), { knowledge: KNOWLEDGE });

    expect(sendInteractiveMessage).toHaveBeenCalledOnce();
    expect(runAgentLoop).not.toHaveBeenCalled();
  });

  it('G: "Main Menu" navigation button resends the main menu list', async () => {
    const waId = '15550000007';
    await processInboundMessage(interactiveMsg(waId, MENU_IDS.LANG_EN), { knowledge: KNOWLEDGE });
    vi.clearAllMocks();

    await processInboundMessage(interactiveMsg(waId, MENU_IDS.MAIN_MENU), { knowledge: KNOWLEDGE });

    const [, message] = vi.mocked(sendInteractiveMessage).mock.calls[0];
    expect(message.kind).toBe('list');
  });

  it('H: "Change language" clears the stored language and re-shows language selection', async () => {
    const waId = '15550000008';
    await processInboundMessage(interactiveMsg(waId, MENU_IDS.LANG_EN), { knowledge: KNOWLEDGE });
    vi.clearAllMocks();

    await processInboundMessage(interactiveMsg(waId, MENU_IDS.CHANGE_LANGUAGE), { knowledge: KNOWLEDGE });

    expect(getCustomerByWaId(waId)?.language).toBeNull();
    const [, message] = vi.mocked(sendInteractiveMessage).mock.calls[0];
    expect(message.kind).toBe('buttons');
  });

  it('I: typing the "menu" keyword (after language is set) resends the main menu without hitting the AI', async () => {
    const waId = '15550000009';
    await processInboundMessage(interactiveMsg(waId, MENU_IDS.LANG_EN), { knowledge: KNOWLEDGE });
    vi.clearAllMocks();

    await processInboundMessage(textMsg(waId, 'menu'), { knowledge: KNOWLEDGE });

    expect(sendInteractiveMessage).toHaveBeenCalledOnce();
    expect(runAgentLoop).not.toHaveBeenCalled();
  });

  it('J: free text that is not a menu keyword bypasses the menu and reaches the AI agent loop', async () => {
    const waId = '15550000010';
    await processInboundMessage(interactiveMsg(waId, MENU_IDS.LANG_EN), { knowledge: KNOWLEDGE });
    vi.clearAllMocks();

    await processInboundMessage(textMsg(waId, 'Do you have Pioneer speakers?'), { knowledge: KNOWLEDGE });

    expect(runAgentLoop).toHaveBeenCalledOnce();
    expect(sendTextMessage).toHaveBeenCalledWith(waId, 'AI reply');
  });

  it('K: restarting the conversation clears the stored language and re-shows language selection', async () => {
    const waId = '15550000011';
    await processInboundMessage(interactiveMsg(waId, MENU_IDS.LANG_EN), { knowledge: KNOWLEDGE });
    vi.clearAllMocks();

    await processInboundMessage(textMsg(waId, 'restart'), { knowledge: KNOWLEDGE });

    expect(getCustomerByWaId(waId)?.language).toBeNull();
    expect(sendInteractiveMessage).toHaveBeenCalledOnce();
    const [, message] = vi.mocked(sendInteractiveMessage).mock.calls[0];
    expect(message.kind).toBe('buttons');
  });

  it('L: an unrecognized interactive ID falls back to the main menu instead of erroring', async () => {
    const waId = '15550000012';
    await processInboundMessage(interactiveMsg(waId, MENU_IDS.LANG_EN), { knowledge: KNOWLEDGE });
    vi.clearAllMocks();

    await processInboundMessage(interactiveMsg(waId, 'some_unknown_id'), { knowledge: KNOWLEDGE });

    const [, message] = vi.mocked(sendInteractiveMessage).mock.calls[0];
    expect(message.kind).toBe('list');
  });

  it('M: selecting "Prices & Enquiries" shows a prompt rather than inventing a price', async () => {
    const waId = '15550000013';
    await processInboundMessage(interactiveMsg(waId, MENU_IDS.LANG_EN), { knowledge: KNOWLEDGE });
    vi.clearAllMocks();

    await processInboundMessage(interactiveMsg(waId, MENU_IDS.PRICES), { knowledge: KNOWLEDGE });

    const [, message] = vi.mocked(sendInteractiveMessage).mock.calls[0];
    expect(message.kind).toBe('buttons');
    if (message.kind === 'buttons') {
      expect(message.body.toLowerCase()).not.toMatch(/\$\d/);
    }
  });

  it('N: an unsupported message type (e.g. image) gets a plain-text fallback, not the menu', async () => {
    const waId = '15550000014';
    await processInboundMessage(
      { waId, messageId: 'wamid.img', timestamp: Date.now(), type: 'image' },
      { knowledge: KNOWLEDGE },
    );

    expect(sendTextMessage).toHaveBeenCalledOnce();
    expect(sendInteractiveMessage).not.toHaveBeenCalled();
  });
});
