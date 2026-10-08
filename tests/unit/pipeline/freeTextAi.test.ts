import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

vi.mock('../../../src/whatsapp/client', () => ({
  sendTextMessage: vi.fn().mockResolvedValue({ messaging_product: 'whatsapp', contacts: [], messages: [{ id: 'w1' }] }),
  sendInteractiveMessage: vi.fn().mockResolvedValue({ messaging_product: 'whatsapp', contacts: [], messages: [{ id: 'w2' }] }),
  sendDocumentMessage: vi.fn(),
}));
vi.mock('../../../src/llm/openRouterClient', () => ({ chatCompletion: vi.fn() }));

import { sendTextMessage } from '../../../src/whatsapp/client';
import { chatCompletion } from '../../../src/llm/openRouterClient';
import { processInboundMessage, resetCredentialFallbackThrottle } from '../../../src/pipeline/processInboundMessage';
import { AiCredentialError } from '../../../src/llm/aiCredentialError';
import { listReplyActivity } from '../../../src/automation/settingsRepo';
import { getDb } from '../../../src/memory/db';
import { createAccount } from '../../../src/accounts/accountRepo';
import { runWithAccount } from '../../../src/accounts/accountContext';
import { getCustomerByWaId } from '../../../src/memory/customerRepo';
import { updateBusinessSettings } from '../../../src/config/businessSettings';
import { resolveTemplate } from '../../../src/templates/templateRepo';
import { updateAutomationSettings } from '../../../src/automation/settingsRepo';
import { setWebSearchProvider, resetWebSearchRateLimit } from '../../../src/tools/webSearch';
import { setLinkFetcher } from '../../../src/setup/linkFetcher';
import { env } from '../../../src/config/env';
import type { InboundMessage } from '../../../src/webhook/parseInboundPayload';

const text = (content: string) => ({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }] });
const toolCall = (name: string, args: Record<string, unknown>) => ({
  choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
});

let PAINT: number;
let GARAGE: number;
const knowledgeOf = (asPromptText: string) => ({ sections: [], asPromptText });
const PAINT_KB = knowledgeOf('PAINT-KB: We sell interior and exterior wall paint, primers and tinting.');
const GARAGE_KB = knowledgeOf('GARAGE-KB: We fit tyres, change oil and balance wheels.');

let counter = 0;
const msg = (accountId: number, waId: string, content: string): InboundMessage => ({ waId, messageId: `wamid.${accountId}.${++counter}`, timestamp: Date.now(), type: 'text', text: content, accountId });
const sent = () => vi.mocked(sendTextMessage).mock.calls.map((c) => String(c[1]));
/** The system prompt and tool names the model was given on its first call. */
const firstCall = () => {
  const call = vi.mocked(chatCompletion).mock.calls[0]![0];
  return { system: String(call.messages[0]!.content), tools: ((call.tools ?? []) as Array<{ function: { name: string } }>).map((t) => t.function.name) };
};

beforeAll(() => {
  getDb();
  PAINT = createAccount({ name: 'Alpha Paints' }).id;
  GARAGE = createAccount({ name: 'Beta Garage' }).id;
  runWithAccount(PAINT, () => updateBusinessSettings({ businessName: 'Alpha Paints', descriptionEn: 'Paint shop in Jeddah', addressEn: 'Paint Street 1' }, PAINT));
  runWithAccount(GARAGE, () => updateBusinessSettings({ businessName: 'Beta Garage', descriptionEn: 'Garage in Riyadh', addressEn: 'Garage Road 9' }, GARAGE));
});

beforeEach(() => {
  vi.clearAllMocks();
  resetWebSearchRateLimit();
  vi.mocked(chatCompletion).mockResolvedValue(text('AI answer') as never);
});
afterEach(() => {
  setWebSearchProvider(null);
  setLinkFetcher(null);
  (env as { WEB_SEARCH_ENABLED: boolean }).WEB_SEARCH_ENABLED = true;
});

describe('ordinary text goes to the AI, with the right business context', () => {
  it('a first message that is a real question is ANSWERED (in the language written) instead of stopped at the language prompt', async () => {
    const waId = '966511000101';
    await processInboundMessage(msg(PAINT, waId, 'Do you have exterior wall paint?'), { knowledge: PAINT_KB });
    expect(chatCompletion).toHaveBeenCalledTimes(1);
    expect(sent()).toEqual(['AI answer']);
    expect(sent().join(' ')).not.toContain(runWithAccount(PAINT, () => resolveTemplate('language_selection', 'en')));
    expect(runWithAccount(PAINT, () => getCustomerByWaId(waId, undefined, PAINT))?.language).toBe('en');
    expect(firstCall().system).toContain('Always reply in English');
  });

  it('the same in Arabic: the customer is set to Arabic and the AI is told to answer in Arabic', async () => {
    const waId = '966511000102';
    await processInboundMessage(msg(PAINT, waId, 'هل عندكم دهان خارجي للجدران؟'), { knowledge: PAINT_KB });
    expect(chatCompletion).toHaveBeenCalledTimes(1);
    expect(runWithAccount(PAINT, () => getCustomerByWaId(waId, undefined, PAINT))?.language).toBe('ar');
    expect(firstCall().system).toContain('Always reply in Arabic');
  });

  it('a bare greeting, or a short fragment, still gets the welcome and language choice — not the AI', async () => {
    await processInboundMessage(msg(PAINT, '966511000103', 'hello'), { knowledge: PAINT_KB });
    await processInboundMessage(msg(PAINT, '966511000104', 'random text'), { knowledge: PAINT_KB });
    expect(chatCompletion).not.toHaveBeenCalled();
    expect(sent()).toEqual([runWithAccount(PAINT, () => resolveTemplate('language_selection', 'en')), runWithAccount(PAINT, () => resolveTemplate('language_selection', 'en'))]);
  });

  it('with the AI switched off the first message still gets the language prompt (nothing is sent to the model)', async () => {
    runWithAccount(PAINT, () => updateAutomationSettings({ aiRepliesEnabled: false }, undefined, PAINT));
    try {
      await processInboundMessage(msg(PAINT, '966511000105', 'Do you have exterior wall paint?'), { knowledge: PAINT_KB });
      expect(chatCompletion).not.toHaveBeenCalled();
    } finally {
      runWithAccount(PAINT, () => updateAutomationSettings({ aiRepliesEnabled: true }, undefined, PAINT));
    }
  });

  it.each([
    ['I need paint for my bedroom.'],
    ['I need a quotation for painting.'],
    ['Where are you located?'],
    ['What colours do you have?'],
    ['paint'],
  ])('after the language is chosen, "%s" is understood by the AI — never answered with the menu', async (question) => {
    const waId = `96651100${200 + counter}`;
    await processInboundMessage(msg(PAINT, waId, 'hi'), { knowledge: PAINT_KB });
    await processInboundMessage(msg(PAINT, waId, '2'), { knowledge: PAINT_KB });
    vi.clearAllMocks();
    vi.mocked(chatCompletion).mockResolvedValue(text('AI answer') as never);
    await processInboundMessage(msg(PAINT, waId, question), { knowledge: PAINT_KB });
    expect(chatCompletion).toHaveBeenCalledTimes(1);
    expect(sent()).toEqual(['AI answer']);
  });

  it('a number that is not an option still gets the invalid-option reply and menu (it is not free text)', async () => {
    const waId = '966511000301';
    await processInboundMessage(msg(PAINT, waId, 'hi'), { knowledge: PAINT_KB });
    await processInboundMessage(msg(PAINT, waId, '2'), { knowledge: PAINT_KB });
    vi.clearAllMocks();
    await processInboundMessage(msg(PAINT, waId, '57'), { knowledge: PAINT_KB });
    expect(chatCompletion).not.toHaveBeenCalled();
    expect(sent()[0]).toBe(runWithAccount(PAINT, () => resolveTemplate('invalid_option', 'en')));
  });
});

describe('what the model is given: the business\'s own context, rules for understanding intent, and the menu map', () => {
  it('contains the intent rules, the source order, the web rules and the business\'s own menu', async () => {
    await processInboundMessage(msg(PAINT, '966511000401', 'Do you have exterior wall paint?'), { knowledge: PAINT_KB });
    const { system, tools } = firstCall();
    expect(system).toContain('UNDERSTANDING WHAT THE CUSTOMER WANTS');
    expect(system).toMatch(/ONE short clarifying question/);
    expect(system).toMatch(/Do NOT answer a specific question with the menu/);
    expect(system).toContain('WEB SEARCH');
    expect(system).toMatch(/BUSINESS PROFILE and verified business data.*BUSINESS KNOWLEDGE.*catalogues.*web_search.*general knowledge/s);
    expect(system).toMatch(/Never use it for this business's own prices, stock, availability, opening hours, phone, address or\s+offers/);
    expect(system).toContain('WHATSAPP MENU');
    expect(system).toContain('Change language');
    expect(tools).toContain('web_search');
  });

  it('never mixes businesses: each prompt has only its own profile, knowledge and menu', async () => {
    await processInboundMessage(msg(PAINT, '966511000402', 'Do you have exterior wall paint?'), { knowledge: PAINT_KB });
    const paint = firstCall().system;
    vi.clearAllMocks();
    vi.mocked(chatCompletion).mockResolvedValue(text('AI answer') as never);
    await processInboundMessage(msg(GARAGE, '966511000403', 'Do you change oil on Sundays?'), { knowledge: GARAGE_KB });
    const garage = firstCall().system;

    expect(paint).toContain('assistant for Alpha Paints');
    expect(paint).toContain('PAINT-KB');
    expect(paint).toContain('Paint Street 1');
    for (const other of ['Beta Garage', 'GARAGE-KB', 'Garage Road 9', 'Riyadh']) expect(paint).not.toContain(other);

    expect(garage).toContain('assistant for Beta Garage');
    expect(garage).toContain('GARAGE-KB');
    for (const other of ['Alpha Paints', 'PAINT-KB', 'Paint Street 1', 'Jeddah']) expect(garage).not.toContain(other);
    // Neither carries the original business's car-care menu.
    expect(paint).not.toContain('Car Audio');
    expect(garage).not.toContain('Car Audio');
  });

  it('the original business keeps its own menu and calendar tools in the prompt, and gets web search too', async () => {
    await processInboundMessage(msg(1, '966511000404', 'Do you have Pioneer speakers and can I book tomorrow?'), { knowledge: knowledgeOf('CARS-KB: car audio') });
    const { system, tools } = firstCall();
    expect(system).toContain('Rowad Alfa Auto Care');
    expect(system).toContain('Car Audio');
    expect(tools).toEqual(['check_availability', 'book_appointment', 'web_search']);
    expect(system).not.toContain('Alpha Paints');
  });

  it('with web search switched off, the model is neither given the tool nor told about it', async () => {
    (env as { WEB_SEARCH_ENABLED: boolean }).WEB_SEARCH_ENABLED = false;
    await processInboundMessage(msg(PAINT, '966511000405', 'Do you have exterior wall paint?'), { knowledge: PAINT_KB });
    const { system, tools } = firstCall();
    expect(tools).not.toContain('web_search');
    expect(system).not.toContain('WEB SEARCH (the web_search tool)');
  });
});

describe('web search inside a real conversation', () => {
  it('the model can search, is handed public results with a "not this business" warning, and the customer gets the final answer', async () => {
    setWebSearchProvider(async () => [{ title: 'Jotun Saudi', url: 'https://www.jotun.com/sa-en/decorative', snippet: 'Decorative paints' }]);
    setLinkFetcher(async () => ({ ok: true, httpStatus: 200, title: 'P', text: 'Fenomastic Hygiene Emulsion is a washable interior paint.', error: null, sha256: 'x' }));
    vi.mocked(chatCompletion)
      .mockResolvedValueOnce(toolCall('web_search', { query: 'Fenomastic Hygiene Emulsion' }) as never)
      .mockResolvedValueOnce(text('It is a washable interior paint (jotun.com).') as never);
    await processInboundMessage(msg(PAINT, '966511000501', 'What is Fenomastic Hygiene Emulsion exactly?'), { knowledge: PAINT_KB });
    expect(chatCompletion).toHaveBeenCalledTimes(2);
    const second = vi.mocked(chatCompletion).mock.calls[1]![0];
    const toolMessage = second.messages.find((m) => m.role === 'tool')!;
    expect(JSON.parse(toolMessage.content as string)).toMatchObject({ results: [{ url: 'https://www.jotun.com/sa-en/decorative', excerpt: expect.stringContaining('washable') }], note: expect.stringContaining('NOT this business') });
    expect(sent()).toEqual(['It is a washable interior paint (jotun.com).']);
  });

  it('a failing web search never breaks the reply', async () => {
    setWebSearchProvider(async () => { throw new Error('offline'); });
    vi.mocked(chatCompletion)
      .mockResolvedValueOnce(toolCall('web_search', { query: 'anything' }) as never)
      .mockResolvedValueOnce(text('I could not check that right now — would you like our team to help?') as never);
    await processInboundMessage(msg(GARAGE, '966511000502', 'What is the newest tyre technology?'), { knowledge: GARAGE_KB });
    expect(sent()).toEqual(['I could not check that right now — would you like our team to help?']);
  });
});

describe('when the AI key is unusable, customers are not spammed with apologies', () => {
  const fallback = () => runWithAccount(PAINT, () => resolveTemplate('fallback_error', 'en'));
  beforeEach(() => resetCredentialFallbackThrottle());

  it('each customer gets the generic apology once per window; further messages are recorded but not answered; other customers still get theirs', async () => {
    vi.mocked(chatCompletion).mockRejectedValue(new AiCredentialError('OpenRouter refused the API key (HTTP 401).', 'rejected', 401));
    const a = '966511000601';
    const b = '966511000602';
    await processInboundMessage(msg(PAINT, a, 'Do you have exterior wall paint?'), { knowledge: PAINT_KB });
    expect(sent()).toEqual([fallback()]);
    await processInboundMessage(msg(PAINT, a, 'Hello? Anyone there please'), { knowledge: PAINT_KB });
    await processInboundMessage(msg(PAINT, a, 'I need paint for my bedroom'), { knowledge: PAINT_KB });
    expect(sent()).toEqual([fallback()]); // still just the one
    await processInboundMessage(msg(PAINT, b, 'Do you have exterior wall paint?'), { knowledge: PAINT_KB });
    expect(sent()).toEqual([fallback(), fallback()]);

    const activity = listReplyActivity({ limit: 50, accountId: PAINT }).map((r) => `${r.kind}:${r.detail ?? ''}`);
    expect(activity.some((x) => x.startsWith('error:AI credential problem (rejected): fallback sent'))).toBe(true);
    expect(activity.some((x) => x.startsWith('suppressed:AI credential problem (rejected) — apology already sent recently'))).toBe(true);
  });

  it('the apology is available again after the window (and is not sent for a generic AI failure throttle)', async () => {
    vi.mocked(chatCompletion).mockRejectedValue(new AiCredentialError('missing', 'missing'));
    const waId = '966511000603';
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2030-01-01T10:00:00Z'));
      await processInboundMessage(msg(PAINT, waId, 'Do you have exterior wall paint?'), { knowledge: PAINT_KB });
      vi.setSystemTime(new Date('2030-01-01T10:05:00Z'));
      await processInboundMessage(msg(PAINT, waId, 'Still waiting for an answer please'), { knowledge: PAINT_KB });
      expect(sent()).toHaveLength(1);
      vi.setSystemTime(new Date('2030-01-01T10:11:00Z'));
      await processInboundMessage(msg(PAINT, waId, 'Any update on my question now'), { knowledge: PAINT_KB });
      expect(sent()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a different kind of AI failure (not a credential problem) is NOT throttled: each message still gets its apology', async () => {
    vi.mocked(chatCompletion).mockRejectedValue(new Error('upstream exploded'));
    const waId = '966511000604';
    await processInboundMessage(msg(PAINT, waId, 'Do you have exterior wall paint?'), { knowledge: PAINT_KB });
    await processInboundMessage(msg(PAINT, waId, 'Is anyone there to answer me'), { knowledge: PAINT_KB });
    expect(sent()).toEqual([fallback(), fallback()]);
  });
});
