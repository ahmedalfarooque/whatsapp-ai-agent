import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/whatsapp/client', () => ({
  sendTextMessage: vi.fn().mockResolvedValue({ messaging_product: 'whatsapp', contacts: [], messages: [{ id: 'w1' }] }),
  sendInteractiveMessage: vi.fn().mockResolvedValue({ messaging_product: 'whatsapp', contacts: [], messages: [{ id: 'w2' }] }),
  sendDocumentMessage: vi.fn(),
  sendImageMessage: vi.fn(),
}));
vi.mock('../../src/llm/openRouterClient', () => ({ chatCompletion: vi.fn() }));

import { sendTextMessage } from '../../src/whatsapp/client';
import { chatCompletion } from '../../src/llm/openRouterClient';
import { processInboundMessage } from '../../src/pipeline/processInboundMessage';
import { getDb } from '../../src/memory/db';
import { createAccount } from '../../src/accounts/accountRepo';
import { LEGACY_ACCOUNT_ID, runWithAccount } from '../../src/accounts/accountContext';
import { getCustomerByWaId } from '../../src/memory/customerRepo';
import { getBusinessSettings, updateBusinessSettings } from '../../src/config/businessSettings';
import type { InboundMessage } from '../../src/webhook/parseInboundPayload';

/**
 * The same-language rule is SHARED: the original business (Rowad Alfa Auto Care, account 1), a business created later (JOTUN-like) and a
 * blueprint-style business (QMULATE-like) all give the model the same reply-language instruction, derived from the customer's latest
 * message — even after the customer chose English from the menu, and when they switch language mid-conversation. The model's prose is
 * mocked; what is asserted is the instruction the model receives, which is the shared policy in llm/language.ts.
 */
const reply = (content: string) => ({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }] });
let counter = 0;
const msg = (accountId: number, waId: string, text: string): InboundMessage => ({ waId, messageId: `wamid.lang.${accountId}.${++counter}`, timestamp: Date.now(), type: 'text', text, accountId });
const KB = { sections: [], asPromptText: 'We tint windows and fit accessories.' };
const lastSystem = () => { const calls = vi.mocked(chatCompletion).mock.calls; return String(calls[calls.length - 1]![0].messages[0]!.content); };
const replyLanguageLine = () => /REPLY LANGUAGE: [^\n]*/.exec(lastSystem())![0];

let JOTUN: number;
let QMULATE: number;
const accounts = (): Array<[string, number]> => [['Rowad Alfa Auto Care (account 1)', LEGACY_ACCOUNT_ID], ['JOTUN Rowad Alfa', JOTUN], ['QMULATE', QMULATE]];

/** A customer who chose ENGLISH from the menu (the state in which Auto Care and JOTUN answered Malayalam in English). */
async function englishMenuCustomer(accountId: number): Promise<string> {
  const waId = `96650${String(++counter).padStart(8, '0')}`;
  await processInboundMessage(msg(accountId, waId, 'hi'), { knowledge: KB });
  await processInboundMessage(msg(accountId, waId, '2'), { knowledge: KB });
  expect(runWithAccount(accountId, () => getCustomerByWaId(waId, undefined, accountId))?.language).toBe('en');
  vi.mocked(chatCompletion).mockClear();
  vi.mocked(sendTextMessage).mockClear();
  return waId;
}

beforeAll(() => {
  getDb();
  JOTUN = createAccount({ name: 'JOTUN Rowad Alfa' }).id;
  QMULATE = createAccount({ name: 'QMULATE' }).id;
  runWithAccount(QMULATE, () => updateBusinessSettings({ supportedLanguages: 'ar,en' }, QMULATE));
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(chatCompletion).mockResolvedValue(reply('ok') as never);
});
afterEach(() => {
  for (const [, id] of accounts()) runWithAccount(id, () => updateBusinessSettings({ aiReplyLanguage: null }, id));
});

describe('a Malayalam question gets a Malayalam reply instruction on every business', () => {
  it.each([['Rowad Alfa Auto Care (account 1)', () => LEGACY_ACCOUNT_ID], ['JOTUN Rowad Alfa', () => JOTUN], ['QMULATE', () => QMULATE]])('%s: even after choosing English from the menu', async (_name, idOf) => {
    const id = idOf();
    const waId = await englishMenuCustomer(id);
    await processInboundMessage(msg(id, waId, 'ഈ കാറിന് വിൻഡോ ടിന്റിംഗ് ഉണ്ടോ? വില എത്രയാണ്?'), { knowledge: KB });
    expect(chatCompletion).toHaveBeenCalledTimes(1);
    expect(replyLanguageLine()).toContain('REPLY LANGUAGE: Malayalam');
    expect(lastSystem()).not.toContain('regardless of the language');
    expect(lastSystem()).toContain('if they switch language, switch with them');
    expect(vi.mocked(sendTextMessage)).toHaveBeenCalledTimes(1);
    // the menu language is untouched: it still selects English menu texts
    expect(runWithAccount(id, () => getCustomerByWaId(waId, undefined, id))?.language).toBe('en');
  });
});

describe('Arabic, English, Chinese and French each get their own instruction', () => {
  it.each([
    ['Arabic', 'هل عندكم تظليل للسيارات؟ وكم السعر؟'],
    ['English', 'Do you have window tinting and how much is it?'],
    ['Chinese', '你们有汽车贴膜吗？价格是多少？'],
    ['French', 'Avez-vous la teinture des vitres et quel est le prix ?'],
  ])('%s', async (name, text) => {
    const waId = await englishMenuCustomer(JOTUN);
    await processInboundMessage(msg(JOTUN, waId, text), { knowledge: KB });
    expect(replyLanguageLine()).toContain(`REPLY LANGUAGE: ${name}`);
  });
});

describe('a conversation that switches languages is followed each time', () => {
  it('Malayalam → English → Arabic → Chinese → Malayalam, on one customer of the original business', async () => {
    const waId = await englishMenuCustomer(LEGACY_ACCOUNT_ID);
    const turns: Array<[string, string]> = [
      ['ഈ കാറിന് ആക്സസറികൾ ഉണ്ടോ?', 'Malayalam'],
      ['And how much for ceramic tinting?', 'English'],
      ['وهل يوجد ضمان؟', 'Arabic'],
      ['保修多久？', 'Chinese'],
      ['ശരി, നാളെ വരാം', 'Malayalam'],
    ];
    for (const [text, name] of turns) {
      await processInboundMessage(msg(LEGACY_ACCOUNT_ID, waId, text), { knowledge: KB });
      expect(replyLanguageLine(), text).toContain(`REPLY LANGUAGE: ${name}`);
    }
    // a bare number carries no language: the menu choice (English) fills in, nothing is locked
    await processInboundMessage(msg(LEGACY_ACCOUNT_ID, waId, '12345'), { knowledge: KB });
    expect(replyLanguageLine()).toContain('REPLY LANGUAGE: English for this message');
  });
});

describe('account-level override and inheritance', () => {
  it('only an explicit business setting fixes the language, and it affects that business alone', async () => {
    runWithAccount(JOTUN, () => updateBusinessSettings({ aiReplyLanguage: 'ar' }, JOTUN));
    const jotun = await englishMenuCustomer(JOTUN);
    await processInboundMessage(msg(JOTUN, jotun, 'ഈ കാറിന് ആക്സസറികൾ ഉണ്ടോ?'), { knowledge: KB });
    expect(replyLanguageLine()).toContain('REPLY LANGUAGE: Arabic');
    expect(lastSystem()).toContain('always replies in Arabic (a deliberate business setting)');
    const qmulate = await englishMenuCustomer(QMULATE);
    await processInboundMessage(msg(QMULATE, qmulate, 'ഈ കാറിന് ആക്സസറികൾ ഉണ്ടോ?'), { knowledge: KB });
    expect(replyLanguageLine()).toContain('REPLY LANGUAGE: Malayalam');
    expect(() => runWithAccount(JOTUN, () => updateBusinessSettings({ aiReplyLanguage: 'not a code' }, JOTUN))).toThrow();
  });

  it('a business created tomorrow inherits the shared policy and vision defaults with nothing configured', async () => {
    const fresh = createAccount({ name: 'Tomorrow Trading' }).id;
    const settings = runWithAccount(fresh, () => getBusinessSettings(fresh));
    expect(settings.aiReplyLanguage).toBeNull();
    expect(settings.openRouterVisionModel).toBeTruthy();
    const waId = await englishMenuCustomer(fresh);
    await processInboundMessage(msg(fresh, waId, 'Magkano po ang tint ng bintana?'), { knowledge: KB });
    expect(replyLanguageLine()).toContain('REPLY LANGUAGE: Filipino');
    expect(lastSystem()).toContain('PICTURES THE CUSTOMER SENDS');
  });
});
