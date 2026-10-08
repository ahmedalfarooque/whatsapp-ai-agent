import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

const ok = { messaging_product: 'whatsapp', contacts: [], messages: [{ id: 'w1' }] };
vi.mock('../../../src/whatsapp/client', () => ({
  sendTextMessage: vi.fn(async () => ok),
  sendInteractiveMessage: vi.fn(async () => ok),
  sendDocumentMessage: vi.fn(async () => ok),
}));
vi.mock('../../../src/llm/agentLoop', () => ({ runAgentLoop: vi.fn().mockResolvedValue({ finalText: 'AI reply', generatedMessages: [] }) }));

import { sendTextMessage, sendDocumentMessage } from '../../../src/whatsapp/client';
import { runAgentLoop } from '../../../src/llm/agentLoop';
import { getDb } from '../../../src/memory/db';
import { createAccount } from '../../../src/accounts/accountRepo';
import { runWithAccount } from '../../../src/accounts/accountContext';
import { setAccountFeature, FEATURES } from '../../../src/accounts/accountFeatures';
import { getOrCreateCustomer, setCustomerLanguage, setCustomerMenuState, getCustomerByWaId } from '../../../src/memory/customerRepo';
import { getOrCreateActiveConversation, getRecentMessages } from '../../../src/memory/conversationRepo';
import { processInboundMessage } from '../../../src/pipeline/processInboundMessage';
import { routeMenu, MAIN_MENU_OPTIONS } from '../../../src/automation/menuRouter';
import { DEFAULT_GENERIC_MENU, MenuValidationError, getMenuTables, saveMenuConfig, type MenuConfig } from '../../../src/automation/menuConfig';
import { listTemplates, resolveTemplate } from '../../../src/templates/templateRepo';
import { deleteCatalogue, listCatalogues, setCatalogueEnabled, uploadCatalogue } from '../../../src/catalogues/catalogueRepo';
import { documentPath, getDocument } from '../../../src/documents/documentStore';
import { makePdf } from '../../fixtures/makePdf';
import fs from 'node:fs';

const KNOWLEDGE = { sections: [], asPromptText: '' };
const JOTUN = 2;
const OTHER = 3;
const files = {
  soulful: makePdf(['Jotun Soulful Spaces', '1625 Soul']),
  nuances: makePdf(['Jotun Nuances 2025', 'Wonderwall Lux']),
  brochure: makePdf(['Jotun Brochure']),
};
const pdf = (bytes: Buffer, name: string, title: string) => ({ originalName: name, mimeType: 'application/pdf', bytes, title, uploadedBy: 'test' });

let counter = 0;
const phone = (): string => `96650000${String(1000 + ++counter)}`;

/** A customer of `accountId` who already chose a language and is at the main menu. */
function customer(accountId: number, language: 'en' | 'ar' = 'en'): string {
  const waId = phone();
  runWithAccount(accountId, () => {
    const c = getOrCreateCustomer(waId, 'Test Customer');
    setCustomerLanguage(c.id, language);
    setCustomerMenuState(c.id, 'MAIN_MENU', null);
  });
  return waId;
}

/** Sends one inbound message through the real pipeline; returns the texts and documents the customer received. */
async function say(accountId: number, waId: string, text: string): Promise<{ texts: string[]; documents: Array<Record<string, unknown>> }> {
  const t0 = vi.mocked(sendTextMessage).mock.calls.length;
  const d0 = vi.mocked(sendDocumentMessage).mock.calls.length;
  await processInboundMessage({ waId, messageId: `m-${++counter}`, timestamp: Date.now(), type: 'text', text, accountId, channel: 'qr' }, { knowledge: KNOWLEDGE });
  return {
    texts: vi.mocked(sendTextMessage).mock.calls.slice(t0).map((c) => String(c[1])),
    documents: vi.mocked(sendDocumentMessage).mock.calls.slice(d0).map((c) => ({ to: c[0], ...(c[1] as object) })),
  };
}

beforeAll(async () => {
  getDb();
  expect(createAccount({ name: 'JOTUN Rowad Alfa', nameAr: 'جوتن رواد الفا', businessCategory: 'Paint Store' }).id).toBe(JOTUN);
  expect(createAccount({ name: 'Other Business' }).id).toBe(OTHER);
  setAccountFeature(JOTUN, FEATURES.CATALOGUES, true);
  // The business's menu: catalogues as the 3rd entry, labelled exactly as customers should read it.
  const menu: MenuConfig = { version: 1, items: [...DEFAULT_GENERIC_MENU.items.slice(0, 2), { id: 'catalogues', kind: 'catalogues', labelEn: '📚 Jotun Catalogues', labelAr: '📚 كتالوجات جوتن' }, ...DEFAULT_GENERIC_MENU.items.slice(2)] };
  saveMenuConfig(JOTUN, menu, 'manual');
  await uploadCatalogue(pdf(files.soulful, 'Jotun_Interiour Colors 1.pdf', 'Jotun Soulful Spaces'), JOTUN);
  await uploadCatalogue(pdf(files.nuances, 'Jotun_Broucher 1.pdf', 'Jotun Nuances 2025'), JOTUN);
});

beforeEach(() => {
  vi.mocked(sendTextMessage).mockClear();
  vi.mocked(sendDocumentMessage).mockClear();
  vi.mocked(runAgentLoop).mockClear();
});

describe('the business menu', () => {
  it('shows the catalogue entry in both languages, and the numbering follows the saved menu', () => {
    const en = runWithAccount(JOTUN, () => resolveTemplate('main_menu', 'en'));
    const ar = runWithAccount(JOTUN, () => resolveTemplate('main_menu', 'ar'));
    expect(en).toContain('3️⃣ 📚 Jotun Catalogues');
    expect(ar).toContain('3️⃣ 📚 كتالوجات جوتن');
    expect(runWithAccount(JOTUN, () => getMenuTables().main['3'])).toMatchObject({ catalogues: true, template: 'catalogues_list' });
  });

  it('the list templates exist and are generated from the live database', () => {
    const keys = runWithAccount(JOTUN, () => listTemplates().map((t) => t.key));
    expect(keys).toEqual(expect.arrayContaining(['catalogues_list', 'catalogues_none', 'catalogue_delivery', 'catalogue_after', 'catalogue_unavailable']));
    const text = runWithAccount(JOTUN, () => resolveTemplate('catalogues_list', 'en'));
    expect(text).toContain('📚 Jotun Catalogues');
    expect(text).toContain('1️⃣ Jotun Soulful Spaces');
    expect(text).toContain('2️⃣ Jotun Nuances 2025');
  });
});

describe('customer asks for a catalogue (English)', () => {
  it.each(['catalogue', 'Send me the catalogue', 'I want the colour catalogue', 'Send me the Jotun brochure', 'I want to download the catalogue'])('"%s" → the numbered list', async (text) => {
    const wa = customer(JOTUN);
    const { texts, documents } = await say(JOTUN, wa, text);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('📚 Jotun Catalogues');
    expect(texts[0]).toContain('1️⃣ Jotun Soulful Spaces\n2️⃣ Jotun Nuances 2025');
    expect(documents).toEqual([]);
    expect(runAgentLoop).not.toHaveBeenCalled();
  });

  it('choosing the menu option (3) shows the same list; choosing a number sends that PDF with a caption', async () => {
    const wa = customer(JOTUN);
    expect((await say(JOTUN, wa, '3')).texts[0]).toContain('1️⃣ Jotun Soulful Spaces');
    const { texts, documents } = await say(JOTUN, wa, '2');
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({ to: wa, fileName: 'Jotun Nuances 2025.pdf', mimeType: 'application/pdf', caption: '📚 Jotun Nuances 2025\nHere is the catalogue you requested.' });
    expect((documents[0]!.bytes as Buffer).equals(files.nuances)).toBe(true); // the real file, not a link
    expect(texts).toEqual(['Would you like another catalogue? Reply with its number, or 0 for the main menu.']);
    // they can pick another straight away
    expect((await say(JOTUN, wa, '1')).documents[0]).toMatchObject({ fileName: 'Jotun Soulful Spaces.pdf' });
  });

  it('never exposes file system paths, ids or URLs to the customer', async () => {
    const wa = customer(JOTUN);
    const first = await say(JOTUN, wa, 'catalogue');
    const second = await say(JOTUN, wa, '1');
    // what the customer actually reads: message texts, the file name WhatsApp shows, and the caption
    const raw = [...first.texts, ...second.texts, ...second.documents.map((d) => `${String(d.fileName)}\n${String(d.caption)}`)].join('\n');
    expect(raw).not.toMatch(/uploads|accounts[\\/]|\b[A-Za-z]:\\|https?:\/\/|stored_name|document_id/);
    expect(Object.keys(second.documents[0] ?? {}).sort()).toEqual(['bytes', 'caption', 'fileName', 'mimeType', 'to']); // no path, no id field
  });

  it('records the delivery in the conversation without any path', async () => {
    const wa = customer(JOTUN);
    await say(JOTUN, wa, 'catalogue');
    await say(JOTUN, wa, '1');
    const history = runWithAccount(JOTUN, () => getRecentMessages(getOrCreateActiveConversation(getCustomerByWaId(wa)!.id).id, 20));
    const sent = history.find((m) => m.content.startsWith('[document]'));
    expect(sent?.content).toBe('[document] Jotun Soulful Spaces\n📚 Jotun Soulful Spaces\nHere is the catalogue you requested.');
  });

  it('an invalid number shows the invalid-option reply, not a file; free text still goes to the assistant', async () => {
    const wa = customer(JOTUN);
    await say(JOTUN, wa, 'catalogue');
    const bad = await say(JOTUN, wa, '9');
    expect(bad.documents).toEqual([]);
    expect(bad.texts[0]).toMatch(/invalid|not valid|choose/i);
    await say(JOTUN, wa, 'catalogue');
    await say(JOTUN, wa, 'which colour suits a bedroom?');
    expect(runAgentLoop).toHaveBeenCalledTimes(1);
  });
});

describe('customer asks for a catalogue (Arabic)', () => {
  it.each(['كتالوج', 'أريد كتالوج الألوان', 'أرسل لي كتالوج جوتن', 'أريد البروشور'])('"%s" → the Arabic list', async (text) => {
    const wa = customer(JOTUN, 'ar');
    const { texts } = await say(JOTUN, wa, text);
    expect(texts[0]).toContain('📚 كتالوجات جوتن');
    expect(texts[0]).toContain('يرجى اختيار الكتالوج');
    expect(texts[0]).toContain('1️⃣ Jotun Soulful Spaces');
  });

  it('Arabic-Indic digits select a catalogue and the caption is Arabic', async () => {
    const wa = customer(JOTUN, 'ar');
    await say(JOTUN, wa, 'كتالوج');
    const { documents, texts } = await say(JOTUN, wa, '١');
    expect(documents[0]).toMatchObject({ fileName: 'Jotun Soulful Spaces.pdf', caption: '📚 Jotun Soulful Spaces\nتفضل، هذا هو الكتالوج الذي طلبته.' });
    expect(texts[0]).toContain('هل تريد كتالوجاً آخر');
  });
});

describe('the list always follows the database', () => {
  it('a newly uploaded catalogue appears; a disabled or deleted one disappears at once', async () => {
    const wa = customer(JOTUN);
    const added = await uploadCatalogue(pdf(files.brochure, 'brochure.pdf', 'Jotun Brochure'), JOTUN);
    expect((await say(JOTUN, wa, 'catalogue')).texts[0]).toContain('3️⃣ Jotun Brochure');

    setCatalogueEnabled(added.id, false, JOTUN);
    const afterDisable = (await say(JOTUN, wa, 'catalogue')).texts[0]!;
    expect(afterDisable).not.toContain('Jotun Brochure');
    expect((await say(JOTUN, wa, '3')).documents).toEqual([]); // position 3 no longer exists

    setCatalogueEnabled(added.id, true, JOTUN);
    await say(JOTUN, wa, 'catalogue');
    deleteCatalogue(added.id, JOTUN);
    expect((await say(JOTUN, wa, 'catalogue')).texts[0]).not.toContain('Jotun Brochure');
    expect((await say(JOTUN, wa, '3')).documents).toEqual([]);
  });

  it('a catalogue disabled while the customer is looking at the list is not sent', async () => {
    const wa = customer(JOTUN);
    const first = listCatalogues(JOTUN)[0]!;
    await say(JOTUN, wa, 'catalogue');
    setCatalogueEnabled(first.id, false, JOTUN);
    const { documents } = await say(JOTUN, wa, '1'); // position 1 is now "Nuances"
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({ fileName: 'Jotun Nuances 2025.pdf' });
    setCatalogueEnabled(first.id, true, JOTUN);
  });

  it('with nothing enabled the customer is told so instead of seeing an empty list', async () => {
    const all = listCatalogues(JOTUN);
    all.forEach((c) => setCatalogueEnabled(c.id, false, JOTUN));
    const wa = customer(JOTUN);
    const { texts } = await say(JOTUN, wa, 'catalogue');
    expect(texts[0]).toContain('no catalogues available');
    all.forEach((c) => setCatalogueEnabled(c.id, true, JOTUN));
  });
});

describe('delivery problems never break the conversation', () => {
  it('if WhatsApp cannot deliver the file the customer gets a plain apology', async () => {
    vi.mocked(sendDocumentMessage).mockRejectedValueOnce(new Error('socket closed'));
    const wa = customer(JOTUN);
    await say(JOTUN, wa, 'catalogue');
    const { texts, documents } = await say(JOTUN, wa, '1');
    expect(documents).toHaveLength(1); // it was attempted
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('could not send that catalogue');
    expect(texts[0]).not.toMatch(/socket closed/);
  });

  it('if the stored file has vanished the customer gets the same apology and nothing is sent', async () => {
    const victim = await uploadCatalogue(pdf(makePdf(['Temporary']), 'temp.pdf', 'Temporary Catalogue'), JOTUN);
    fs.unlinkSync(documentPath(getDocument(victim.documentId, undefined, JOTUN)!));
    const wa = customer(JOTUN);
    const list = (await say(JOTUN, wa, 'catalogue')).texts[0]!;
    const position = list.split('\n').findIndex((l) => l.includes('Temporary Catalogue')) ; // a list line, counted from the header
    expect(position).toBeGreaterThan(0);
    const { documents, texts } = await say(JOTUN, wa, String(listCatalogues(JOTUN).findIndex((c) => c.id === victim.id) + 1));
    expect(documents).toEqual([]);
    expect(texts[0]).toContain('could not send that catalogue');
    deleteCatalogue(victim.id, JOTUN);
  });
});

describe('the original business is untouched', () => {
  it('"catalogue" is just free text for the assistant; no list, no document, no catalogue templates', async () => {
    const wa = customer(1);
    const { texts, documents } = await say(1, wa, 'catalogue');
    expect(documents).toEqual([]);
    expect(runAgentLoop).toHaveBeenCalledTimes(1);
    expect(texts).toEqual(['AI reply']);
    expect(listTemplates().map((t) => t.key).filter((k) => k.startsWith('catalogue'))).toEqual([]);
    expect(resolveTemplate('main_menu', 'en')).not.toMatch(/catalogue/i);
    expect(resolveTemplate('main_menu', 'ar')).not.toContain('كتالوج');
  });

  it('keeps its built-in menu structure and routing exactly', () => {
    expect(getMenuTables(1).main).toBe(MAIN_MENU_OPTIONS);
    expect(getMenuTables(1).builtIn).toBe(true);
    const customerRow = runWithAccount(1, () => getOrCreateCustomer(phone()));
    const asLanguage = { ...customerRow, language: 'en' as const, menu_state: 'MAIN_MENU' };
    const routed = (n: string) => routeMenu({ text: n, customer: asLanguage });
    expect(routed('1')).toMatchObject({ send: ['car_audio'], state: 'SUBMENU_AUDIO' });
    expect(routed('6')).toMatchObject({ send: ['location_hours'] });
    expect(routed('8')).toMatchObject({ kind: 'human_handoff' });
    expect(routeMenu({ text: 'catalogue', customer: asLanguage })).toBeNull();
  });

  it('cannot get a catalogue menu entry through any path', () => {
    expect(() => saveMenuConfig(1, { version: 1, items: [{ id: 'c', kind: 'catalogues', labelEn: 'x', labelAr: 'x' }] }, 'manual')).toThrow(MenuValidationError);
  });
});

describe('a different business without the library', () => {
  it('has no catalogue behaviour at all', async () => {
    expect(() => saveMenuConfig(OTHER, { version: 1, items: [{ id: 'c', kind: 'catalogues', labelEn: 'x', labelAr: 'x' }] }, 'manual')).toThrow(/not available/);
    const wa = customer(OTHER);
    const { texts, documents } = await say(OTHER, wa, 'catalogue');
    expect(documents).toEqual([]);
    expect(texts).toEqual(['AI reply']);
    expect(runWithAccount(OTHER, () => listTemplates().map((t) => t.key).filter((k) => k.startsWith('catalogue')))).toEqual([]);
  });
});
