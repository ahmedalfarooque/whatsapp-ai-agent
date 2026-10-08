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
import { getOrCreateActiveConversation, getRecentMessages } from '../../../src/memory/conversationRepo';
import { listCustomerRequests } from '../../../src/memory/customerRequestRepo';
import { MENU_IDS } from '../../../src/automation/menu';
import { resolveTemplate } from '../../../src/templates/templateRepo';
import { LANGUAGE_OPTION_EN, LANGUAGE_OPTION_AR } from '../../../src/templates/languageOption';
import type { InboundMessage } from '../../../src/webhook/parseInboundPayload';

const KNOWLEDGE = { sections: [], asPromptText: '' };

function textMsg(waId: string, text: string, overrides: Partial<InboundMessage> = {}): InboundMessage {
  return { waId, messageId: `wamid.${Math.random()}`, timestamp: Date.now(), type: 'text', text, ...overrides };
}

function interactiveMsg(waId: string, interactiveId: string): InboundMessage {
  return { waId, messageId: `wamid.${Math.random()}`, timestamp: Date.now(), type: 'interactive', interactiveId };
}

/** Texts sent since the last clearAllMocks, in order. */
const sent = () => vi.mocked(sendTextMessage).mock.calls.map((c) => String(c[1]));
const live = (key: string, lang: 'en' | 'ar' = 'en', vars = {}) => resolveTemplate(key, lang, vars);

async function selectEnglish(waId: string) {
  await processInboundMessage(textMsg(waId, 'hi'), { knowledge: KNOWLEDGE });
  await processInboundMessage(textMsg(waId, '2'), { knowledge: KNOWLEDGE });
  vi.clearAllMocks();
}

describe('processInboundMessage — language-first guided menu (templates are the only text source)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { recordQrSessionConnected } = await import('../../../src/memory/qrSessionRepo');
    recordQrSessionConnected({ phoneNumber: '+966558190545', jid: '966558190545:2@s.whatsapp.net', displayName: 'Rowad' });
  });

  it('A: first contact sends exactly the live language_selection template and nothing else', async () => {
    await processInboundMessage(textMsg('15550000001', 'hi'), { knowledge: KNOWLEDGE });
    expect(sent()).toEqual([live('language_selection')]);
    expect(sendInteractiveMessage).not.toHaveBeenCalled();
    expect(runAgentLoop).not.toHaveBeenCalled();
  });

  it('B: re-prompts with the shorter language_reprompt until a language is chosen', async () => {
    await processInboundMessage(textMsg('15550000002', 'random text'), { knowledge: KNOWLEDGE });
    await processInboundMessage(textMsg('15550000002', 'still nothing'), { knowledge: KNOWLEDGE });
    expect(sent()).toEqual([live('language_selection'), live('language_reprompt')]);
    expect(runAgentLoop).not.toHaveBeenCalled();
  });

  it('C: replying 2 selects English and sends the English main menu verbatim (one bubble)', async () => {
    const waId = '15550000003';
    await processInboundMessage(textMsg(waId, 'hi'), { knowledge: KNOWLEDGE });
    vi.clearAllMocks();
    await processInboundMessage(textMsg(waId, '2'), { knowledge: KNOWLEDGE });
    expect(getCustomerByWaId(waId)?.language).toBe('en');
    expect(getCustomerByWaId(waId)?.menu_state).toBe('MAIN_MENU');
    expect(sent()).toEqual([live('main_menu', 'en')]);
  });

  it('D: replying ١ (Arabic-Indic one) selects Arabic', async () => {
    const waId = '15550000004';
    await processInboundMessage(textMsg(waId, '١'), { knowledge: KNOWLEDGE });
    expect(getCustomerByWaId(waId)?.language).toBe('ar');
    expect(sent()).toEqual([live('main_menu', 'ar')]);
  });

  it('E: typing "English" also selects the language', async () => {
    const waId = '15550000005';
    await processInboundMessage(textMsg(waId, 'English'), { knowledge: KNOWLEDGE });
    expect(getCustomerByWaId(waId)?.language).toBe('en');
  });

  it('F: main menu 1 sends the Car Audio submenu template; a submenu number sends the detail text', async () => {
    const waId = '15550000006';
    await selectEnglish(waId);
    await processInboundMessage(textMsg(waId, '1'), { knowledge: KNOWLEDGE });
    expect(sent()).toEqual([live('car_audio')]);
    expect(getCustomerByWaId(waId)?.menu_state).toBe('SUBMENU_AUDIO');
    vi.clearAllMocks();
    await processInboundMessage(textMsg(waId, '2'), { knowledge: KNOWLEDGE });
    expect(sent()).toEqual([live('car_audio_2')]);
    expect(runAgentLoop).not.toHaveBeenCalled();
  });

  it('G: 0 / "menu" from a submenu resends the main menu once', async () => {
    const waId = '15550000007';
    await selectEnglish(waId);
    await processInboundMessage(textMsg(waId, '3'), { knowledge: KNOWLEDGE });
    vi.clearAllMocks();
    await processInboundMessage(textMsg(waId, '0'), { knowledge: KNOWLEDGE });
    expect(sent()).toEqual([live('main_menu')]);
    expect(getCustomerByWaId(waId)?.menu_state).toBe('MAIN_MENU');
  });

  it('H: "language" asks for the language; choosing 1 confirms and shows the Arabic menu', async () => {
    const waId = '15550000008';
    await selectEnglish(waId);
    await processInboundMessage(textMsg(waId, 'language'), { knowledge: KNOWLEDGE });
    expect(sent()).toEqual([live('language_switch_prompt')]);
    vi.clearAllMocks();
    await processInboundMessage(textMsg(waId, '1'), { knowledge: KNOWLEDGE });
    expect(getCustomerByWaId(waId)?.language).toBe('ar');
    expect(sent()).toEqual([live('language_changed', 'ar'), live('main_menu', 'ar')]);
  });

  it('H2: the main menu itself offers "0 — Change language"; sending 0 there opens the choice, and switching works both ways', async () => {
    const waId = '15550000040';
    await processInboundMessage(textMsg(waId, 'hi'), { knowledge: KNOWLEDGE });
    await processInboundMessage(textMsg(waId, '2'), { knowledge: KNOWLEDGE });
    expect(sent()[1]).toContain(LANGUAGE_OPTION_EN);
    vi.clearAllMocks();
    await processInboundMessage(textMsg(waId, '0'), { knowledge: KNOWLEDGE });
    expect(sent()).toEqual([live('language_switch_prompt')]);
    expect(getCustomerByWaId(waId)?.menu_state).toBe('AWAITING_LANGUAGE_SWITCH');
    vi.clearAllMocks();
    await processInboundMessage(textMsg(waId, '1'), { knowledge: KNOWLEDGE });
    expect(getCustomerByWaId(waId)?.language).toBe('ar');
    expect(sent()).toEqual([live('language_changed', 'ar'), live('main_menu', 'ar')]);
    expect(sent()[1]).toContain(LANGUAGE_OPTION_AR);
    expect(sent()[1]).not.toContain(LANGUAGE_OPTION_EN);
    // The option is still there afterwards, in Arabic, and switches back to English.
    vi.clearAllMocks();
    await processInboundMessage(textMsg(waId, '0'), { knowledge: KNOWLEDGE });
    await processInboundMessage(textMsg(waId, '2'), { knowledge: KNOWLEDGE });
    expect(getCustomerByWaId(waId)?.language).toBe('en');
    expect(sent()[sent().length - 1]).toContain(LANGUAGE_OPTION_EN);
    expect(runAgentLoop).not.toHaveBeenCalled();
  });

  it('H3: switching language keeps the conversation: earlier messages are still stored and nothing is reset', async () => {
    const waId = '15550000041';
    await selectEnglish(waId);
    await processInboundMessage(textMsg(waId, 'Do you have Pioneer speakers?'), { knowledge: KNOWLEDGE });
    const before = getRecentMessages(getOrCreateActiveConversation(getCustomerByWaId(waId)!.id).id, 50).length;
    await processInboundMessage(textMsg(waId, 'language'), { knowledge: KNOWLEDGE });
    await processInboundMessage(textMsg(waId, '1'), { knowledge: KNOWLEDGE });
    const conversation = getOrCreateActiveConversation(getCustomerByWaId(waId)!.id);
    expect(getRecentMessages(conversation.id, 100).length).toBeGreaterThan(before);
    expect(getRecentMessages(conversation.id, 100).map((m) => m.content)).toContain('Do you have Pioneer speakers?');
    expect(getCustomerByWaId(waId)?.language).toBe('ar');
  });

  it('I: a greeting after language is set reopens the menu without the AI', async () => {
    const waId = '15550000009';
    await selectEnglish(waId);
    await processInboundMessage(textMsg(waId, 'مرحبا'), { knowledge: KNOWLEDGE });
    expect(sent()).toEqual([live('main_menu')]);
    expect(runAgentLoop).not.toHaveBeenCalled();
  });

  it('J: free text that is not a menu command reaches the AI agent loop', async () => {
    const waId = '15550000010';
    await selectEnglish(waId);
    await processInboundMessage(textMsg(waId, 'Do you have Pioneer speakers?'), { knowledge: KNOWLEDGE });
    expect(runAgentLoop).toHaveBeenCalledOnce();
    expect(sendTextMessage).toHaveBeenCalledWith(waId, 'AI reply');
  });

  it('K: "restart" and "00" clear language + menu state and show the welcome again', async () => {
    const waId = '15550000011';
    await selectEnglish(waId);
    await processInboundMessage(textMsg(waId, 'restart'), { knowledge: KNOWLEDGE });
    expect(getCustomerByWaId(waId)?.language).toBeNull();
    expect(sent()).toEqual([live('restart_confirmation'), live('language_selection')]);
    vi.clearAllMocks();
    await processInboundMessage(textMsg(waId, '2'), { knowledge: KNOWLEDGE });
    await processInboundMessage(textMsg(waId, '00'), { knowledge: KNOWLEDGE });
    expect(getCustomerByWaId(waId)?.language).toBeNull();
    expect(getCustomerByWaId(waId)?.menu_state).toBe('AWAITING_LANGUAGE');
  });

  it('L: an out-of-range number sends invalid_option then the main menu — never two menus', async () => {
    const waId = '15550000012';
    await selectEnglish(waId);
    await processInboundMessage(textMsg(waId, '12'), { knowledge: KNOWLEDGE });
    expect(sent()).toEqual([live('invalid_option'), live('main_menu')]);
  });

  it('M: the prices submenu never contains a numeric price', async () => {
    const waId = '15550000013';
    await selectEnglish(waId);
    await processInboundMessage(textMsg(waId, '5'), { knowledge: KNOWLEDGE });
    await processInboundMessage(textMsg(waId, '2'), { knowledge: KNOWLEDGE });
    for (const text of sent()) expect(text).not.toMatch(/\b(SAR|ريال)\s*\d|\d+\s*(SAR|ريال)|\$\d/);
  });

  it('M2: prices → 3 sends the "no offers" template until an offer is published, then the live offers list', async () => {
    const { createOffer, setOfferStatus, deleteOffer } = await import('../../../src/offers/offerRepo');
    const waId = '15550000018';
    await selectEnglish(waId);
    await processInboundMessage(textMsg(waId, '5'), { knowledge: KNOWLEDGE });
    vi.clearAllMocks();
    await processInboundMessage(textMsg(waId, '3'), { knowledge: KNOWLEDGE });
    expect(sent()).toEqual([live('prices_offers')]);
    const offer = createOffer({ titleAr: 'عرض الصيف', titleEn: 'Summer PPF offer', descriptionEn: 'Front-end PPF' }, 'test');
    setOfferStatus(offer.id, 'published', 'test');
    vi.clearAllMocks();
    await processInboundMessage(textMsg(waId, '3'), { knowledge: KNOWLEDGE });
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toContain('🌟 Summer PPF offer');
    expect(sent()[0]).toContain('Price on request');
    expect(sent()[0]).not.toContain('{offers}');
    deleteOffer(offer.id, 'test');
  });

  describe('N: media and files are never answered automatically', () => {
    const MEDIA = ['voice', 'audio', 'image', 'video', 'document', 'sticker', 'location', 'contact', 'reaction', 'poll', 'other', 'unsupported'];
    const media = (waId: string, type: string, text?: string): InboundMessage => ({ waId, messageId: `wamid.${Math.random()}`, timestamp: Date.now(), type, ...(text ? { text } : {}) });
    const silent = () => {
      expect(sendTextMessage).not.toHaveBeenCalled();
      expect(sendInteractiveMessage).not.toHaveBeenCalled();
      expect(runAgentLoop).not.toHaveBeenCalled();
    };

    it.each(MEDIA)('a %s message from a brand-new customer produces ZERO outbound messages', async (type) => {
      await processInboundMessage(media(`1555100${MEDIA.indexOf(type) + 10}`, type), { knowledge: KNOWLEDGE });
      silent();
    });

    it.each(MEDIA)('a %s message from a customer already in the menu produces ZERO outbound messages and keeps the menu state', async (type) => {
      const waId = `1555200${MEDIA.indexOf(type) + 10}`;
      await selectEnglish(waId);
      await processInboundMessage(textMsg(waId, '1'), { knowledge: KNOWLEDGE });
      vi.clearAllMocks();
      await processInboundMessage(media(waId, type), { knowledge: KNOWLEDGE });
      silent();
      expect(getCustomerByWaId(waId)?.menu_state).toBe('SUBMENU_AUDIO');
      expect(getCustomerByWaId(waId)?.language).toBe('en');
    });

    it('the old "I can currently only read text messages" reply is never sent', async () => {
      const waId = '15550000014';
      await processInboundMessage(media(waId, 'voice'), { knowledge: KNOWLEDGE });
      expect(sent().join(' ')).not.toMatch(/only read text|قراءة الرسائل النصية/);
      silent();
    });

    it('a caption under a photo is shown to staff but is NOT answered as customer text', async () => {
      const waId = '15550000031';
      await selectEnglish(waId);
      await processInboundMessage(media(waId, 'image', 'How much for this one?'), { knowledge: KNOWLEDGE });
      silent();
      const conversation = getOrCreateActiveConversation(getCustomerByWaId(waId)!.id);
      expect(getRecentMessages(conversation.id, 5).map((m) => m.content)).toContain('[image] How much for this one?');
    });

    it('media is stored for staff, and a voice note is recorded as a voice note', async () => {
      const waId = '15550000032';
      await selectEnglish(waId);
      await processInboundMessage(media(waId, 'voice'), { knowledge: KNOWLEDGE });
      await processInboundMessage(media(waId, 'document'), { knowledge: KNOWLEDGE });
      await processInboundMessage(media(waId, 'reaction'), { knowledge: KNOWLEDGE });
      const conversation = getOrCreateActiveConversation(getCustomerByWaId(waId)!.id);
      const stored = getRecentMessages(conversation.id, 10).map((m) => m.content);
      expect(stored).toEqual(expect.arrayContaining(['[voice]', '[document]']));
      expect(stored).not.toContain('[reaction]');
      silent();
    });

    it('media does not break the very next text message: it is answered normally', async () => {
      const waId = '15550000033';
      await selectEnglish(waId);
      await processInboundMessage(media(waId, 'voice'), { knowledge: KNOWLEDGE });
      await processInboundMessage(textMsg(waId, 'Do you have Pioneer speakers?'), { knowledge: KNOWLEDGE });
      expect(runAgentLoop).toHaveBeenCalledOnce();
      expect(sendTextMessage).toHaveBeenCalledTimes(1);
    });

    it('media while a human has taken over, or while automatic replies are off, is still silent', async () => {
      const { updateAutomationSettings } = await import('../../../src/automation/settingsRepo');
      const waId = '15550000034';
      await selectEnglish(waId);
      await processInboundMessage(textMsg(waId, 'human'), { knowledge: KNOWLEDGE });
      vi.clearAllMocks();
      await processInboundMessage(media(waId, 'voice'), { knowledge: KNOWLEDGE });
      silent();
      updateAutomationSettings({ autoRepliesEnabled: false });
      await processInboundMessage(media('15550000035', 'image'), { knowledge: KNOWLEDGE });
      silent();
      updateAutomationSettings({ autoRepliesEnabled: true });
    });
  });

  it('S: the appointment flow (main menu 7) collects answers and records a pending request with a reference', async () => {
    const waId = '15550000015';
    await selectEnglish(waId);
    await processInboundMessage(textMsg(waId, '7'), { knowledge: KNOWLEDGE });
    expect(sent()).toEqual([live('appointment_intro')]);
    for (const answer of ['Ali', 'Toyota', 'Camry', '2024', 'PPF', 'Tuesday 23 Sep', '10 AM']) {
      await processInboundMessage(textMsg(waId, answer), { knowledge: KNOWLEDGE });
    }
    vi.clearAllMocks();
    await processInboundMessage(textMsg(waId, 'No'), { knowledge: KNOWLEDGE });
    const requests = listCustomerRequests({ kind: 'appointment' }).filter((r) => r.wa_id === waId);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.status).toBe('pending');
    expect(requests[0]!.payload).toMatchObject({ name: 'Ali', make: 'Toyota', model: 'Camry', year: '2024', notes: 'No' });
    expect(sent()).toEqual([live('appointment_confirm', 'en', { reference: requests[0]!.reference })]);
    const { listOutbox } = await import('../../../src/notifications/outbox');
    const alerts = listOutbox({ requestId: requests[0]!.id });
    expect(alerts.map((a) => a.kind)).toEqual(['business_new_request']);
    expect(alerts[0]!.target_jid).toBe('966558190545@s.whatsapp.net');
    expect(alerts[0]!.body).toContain(requests[0]!.reference);
    expect(alerts[0]!.body).toContain('Vehicle make: Toyota');
    expect(sent()[0]).toContain(requests[0]!.reference);
    expect(getCustomerByWaId(waId)?.menu_state).toBe('MAIN_MENU');
    expect(runAgentLoop).not.toHaveBeenCalled();
  });

  it('T: every inbound and outbound bubble is stored in the conversation the dashboard shows', async () => {
    const waId = '15550000016';
    await processInboundMessage(textMsg(waId, 'hi'), { knowledge: KNOWLEDGE });
    await processInboundMessage(textMsg(waId, '2'), { knowledge: KNOWLEDGE });
    await processInboundMessage(textMsg(waId, '1'), { knowledge: KNOWLEDGE });
    const conversation = getOrCreateActiveConversation(getCustomerByWaId(waId)!.id);
    const history = getRecentMessages(conversation.id, 50);
    expect(history.map((m) => `${m.role}:${m.content.slice(0, 12)}`)).toEqual([
      'user:hi', `assistant:${live('language_selection').slice(0, 12)}`,
      'user:2', `assistant:${live('main_menu').slice(0, 12)}`,
      'user:1', `assistant:${live('car_audio').slice(0, 12)}`,
    ]);
  });

  it('U: legacy Cloud API button IDs still work (lang_en, category, main menu)', async () => {
    const waId = '15550000017';
    await processInboundMessage(interactiveMsg(waId, MENU_IDS.LANG_EN), { knowledge: KNOWLEDGE });
    expect(getCustomerByWaId(waId)?.language).toBe('en');
    expect(sent()).toEqual([live('main_menu')]);
    vi.clearAllMocks();
    await processInboundMessage(interactiveMsg(waId, MENU_IDS.CATEGORY_CARE), { knowledge: KNOWLEDGE });
    expect(sent()).toEqual([live('car_care')]);
    vi.clearAllMocks();
    await processInboundMessage(interactiveMsg(waId, 'some_unknown_id'), { knowledge: KNOWLEDGE });
    expect(sent()).toEqual([live('main_menu')]);
  });
});

describe('processInboundMessage — automation controls & human handoff', () => {
  beforeEach(() => vi.clearAllMocks());

  it('O: a human-support keyword (or main menu 8) pauses the customer, sends the handover template, and silences later messages until "menu"', async () => {
    const waId = '15550000020';
    await selectEnglish(waId);
    await processInboundMessage(textMsg(waId, 'agent'), { knowledge: KNOWLEDGE });
    expect(sent()).toEqual([live('human_support')]);
    expect(getCustomerByWaId(waId)?.automation_paused).toBe(1);
    vi.clearAllMocks();
    await processInboundMessage(textMsg(waId, 'my car makes a noise'), { knowledge: KNOWLEDGE });
    expect(sendTextMessage).not.toHaveBeenCalled();
    expect(runAgentLoop).not.toHaveBeenCalled();
    await processInboundMessage(textMsg(waId, 'menu'), { knowledge: KNOWLEDGE });
    expect(sent()).toEqual([live('main_menu')]);
    expect(getCustomerByWaId(waId)?.automation_paused).toBe(0);

    const waId2 = '15550000021';
    await selectEnglish(waId2);
    await processInboundMessage(textMsg(waId2, '8'), { knowledge: KNOWLEDGE });
    expect(sent()).toEqual([live('human_support')]);
    expect(getCustomerByWaId(waId2)?.automation_paused).toBe(1);
  });

  it('P: disabling AI replies answers free text with the ai_disabled template instead of the model', async () => {
    const { updateAutomationSettings } = await import('../../../src/automation/settingsRepo');
    const waId = '15550000022';
    await selectEnglish(waId);
    updateAutomationSettings({ aiRepliesEnabled: false });
    try {
      await processInboundMessage(textMsg(waId, 'Do you sell dash cams?'), { knowledge: KNOWLEDGE });
      expect(runAgentLoop).not.toHaveBeenCalled();
      expect(sent()).toEqual([live('ai_disabled')]);
    } finally {
      updateAutomationSettings({ aiRepliesEnabled: true });
    }
  });

  it('Q: disabling automatic replies stores the message and sends nothing', async () => {
    const { updateAutomationSettings } = await import('../../../src/automation/settingsRepo');
    const waId = '15550000023';
    updateAutomationSettings({ autoRepliesEnabled: false });
    try {
      await processInboundMessage(textMsg(waId, 'hello?'), { knowledge: KNOWLEDGE });
      expect(sendTextMessage).not.toHaveBeenCalled();
      const conversation = getOrCreateActiveConversation(getCustomerByWaId(waId)!.id);
      expect(getRecentMessages(conversation.id, 5).map((m) => m.content)).toEqual(['hello?']);
    } finally {
      updateAutomationSettings({ autoRepliesEnabled: true });
    }
  });

  it('R: a published template edit changes the live menu; a draft does not', async () => {
    const { saveTemplateDraft, publishTemplate, resetTemplateToDefault } = await import('../../../src/templates/templateRepo');
    const waId1 = '15550000024';
    saveTemplateDraft('main_menu', { ar: 'مسودة', en: 'DRAFT MENU' }, 'test');
    await processInboundMessage(textMsg(waId1, '2'), { knowledge: KNOWLEDGE });
    expect(sent()[0]).not.toContain('DRAFT MENU');
    vi.clearAllMocks();
    publishTemplate('main_menu', undefined, 'test');
    const waId2 = '15550000025';
    await processInboundMessage(textMsg(waId2, '2'), { knowledge: KNOWLEDGE });
    // The staff-edited text is shown as written; the permanent "Change language" line is the only addition.
    expect(sent()[0]).toBe(`DRAFT MENU

${LANGUAGE_OPTION_EN}`);
    resetTemplateToDefault('main_menu', 'test');
  });
});
