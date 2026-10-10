import fs from 'node:fs';
import os from 'node:os';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/whatsapp/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/whatsapp/client')>();
  return {
    ...real,
    sendTextMessage: vi.fn(),
    sendInteractiveMessage: vi.fn(),
    sendImageMessage: vi.fn(),
    sendDocumentMessage: vi.fn(),
  };
});
vi.mock('../../../src/llm/agentLoop', () => ({ runAgentLoop: vi.fn().mockResolvedValue({ finalText: 'AI reply', generatedMessages: [] }) }));

import { sendTextMessage, sendImageMessage, sendDocumentMessage, ImageDeliveryUnsupportedError } from '../../../src/whatsapp/client';
import { logger } from '../../../src/logger';
import { processInboundMessage } from '../../../src/pipeline/processInboundMessage';
import { getDb } from '../../../src/memory/db';
import { createAccount } from '../../../src/accounts/accountRepo';
import { runWithAccount } from '../../../src/accounts/accountContext';
import { documentPath, getDocument, saveDocument, updateDocument } from '../../../src/documents/documentStore';
import { createOffer, deleteOffer, getOffer, setOfferStatus, updateOffer, OfferValidationError } from '../../../src/offers/offerRepo';
import { customerOfferMedia, MAX_OFFER_MEDIA_FILES } from '../../../src/offers/offerMedia';
import { inspectOfferFile } from '../../../src/offers/offerFiles';
import { getMenuConfig } from '../../../src/automation/menuConfig';
import { getCustomerByWaId } from '../../../src/memory/customerRepo';
import { listReplyActivity } from '../../../src/automation/settingsRepo';
import { makePdf } from '../../fixtures/makePdf';

const LEGACY = 1;
let SECOND: number;
let FUTURE: number;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (label: string) => Buffer.concat([PNG_SIGNATURE, Buffer.from(`image-bytes-of-${label}`)]);
const KNOWLEDGE = { sections: [], asPromptText: '' };

let counter = 0;
const events: string[] = [];
const sentTexts = () => vi.mocked(sendTextMessage).mock.calls.map((c) => String(c[1]));
const imageCalls = () => vi.mocked(sendImageMessage).mock.calls.map((c) => c[1]);
const documentCalls = () => vi.mocked(sendDocumentMessage).mock.calls.map((c) => c[1]);

async function say(accountId: number, waId: string, text: string): Promise<void> {
  await processInboundMessage({ waId, messageId: `wamid.offers.${accountId}.${++counter}`, timestamp: Date.now(), type: 'text', text, accountId }, { knowledge: KNOWLEDGE });
}

/** The customer chooses the language, then the Offers option the way that business's own menu offers it. */
async function openOffers(accountId: number, language: 'en' | 'ar' = 'en'): Promise<string> {
  const waId = `9665${String(accountId).padStart(2, '0')}${String(++counter).padStart(6, '0')}`;
  await say(accountId, waId, 'hi');
  await say(accountId, waId, language === 'ar' ? '1' : '2');
  if (accountId === LEGACY) {
    await say(accountId, waId, '5'); // Prices & Offers
    await say(accountId, waId, '3'); // Current Offers
  } else {
    const position = getMenuConfig(accountId).config.items.findIndex((i) => i.kind === 'offers') + 1;
    await say(accountId, waId, String(position));
  }
  return waId;
}

function doc(accountId: number, name: string, bytes: Buffer, extra: { visibility?: 'customer' | 'internal' | 'ai_knowledge'; mime?: string } = {}) {
  const mime = extra.mime ?? (name.endsWith('.pdf') ? 'application/pdf' : name.endsWith('.png') ? 'image/png' : 'application/octet-stream');
  return saveDocument({ originalName: name, mimeType: mime, bytes, visibility: extra.visibility ?? 'customer', title: name, uploadedBy: 'test', accountId });
}

function offer(accountId: number, over: Record<string, unknown> = {}, publish = true) {
  const created = createOffer({ titleAr: 'عرض الصيف', titleEn: 'Summer deal', descriptionEn: 'Details here', descriptionAr: 'تفاصيل', ...over }, 'test', undefined, accountId);
  if (publish) setOfferStatus(created.id, 'published', 'test', undefined, accountId);
  return created;
}

beforeAll(() => {
  getDb();
  SECOND = createAccount({ name: 'Alpha Paints' }).id;
  FUTURE = createAccount({ name: 'Future Shop Added Later' }).id;
});

beforeEach(() => {
  vi.clearAllMocks();
  events.length = 0;
  getDb().prepare('DELETE FROM offers').run();
  vi.mocked(sendTextMessage).mockImplementation(async (_to, body) => { events.push(`text:${String(body).split('\n')[0]}`); return { messaging_product: 'whatsapp', contacts: [], messages: [{ id: 't' }] }; });
  vi.mocked(sendImageMessage).mockImplementation(async (_to, image) => { events.push(`image:${image.caption}`); return { messaging_product: 'whatsapp', contacts: [], messages: [{ id: 'i' }] }; });
  vi.mocked(sendDocumentMessage).mockImplementation(async (_to, file) => { events.push(`document:${file.fileName}`); return { messaging_product: 'whatsapp', contacts: [], messages: [{ id: 'd' }] }; });
});
afterEach(() => vi.restoreAllMocks());

describe('A. an offer with an image reaches the customer as a real WhatsApp image', () => {
  it('Account 1: the offers text, then the picture — actual image media with the right bytes, MIME type and caption', async () => {
    const bytes = png('account-1-summer');
    const image = doc(LEGACY, 'summer.png', bytes);
    offer(LEGACY, { imageDocumentId: image.id });
    const waId = await openOffers(LEGACY);

    expect(sentTexts().some((t) => t.includes('Summer deal') && t.includes('Details here'))).toBe(true);
    expect(imageCalls()).toHaveLength(1);
    const sent = imageCalls()[0]!;
    expect(sent.mimeType).toBe('image/png');
    expect(sent.caption).toBe('Summer deal');
    expect(Buffer.isBuffer(sent.bytes)).toBe(true);
    expect(sent.bytes.equals(bytes)).toBe(true);
    expect(vi.mocked(sendImageMessage).mock.calls[0]![0]).toBe(waId);
    // Order: the offer text first, the picture after it.
    expect(events.findIndex((e) => e.startsWith('text:🎁'))).toBeGreaterThanOrEqual(0);
    expect(events.findIndex((e) => e === 'image:Summer deal')).toBeGreaterThan(events.findIndex((e) => e.startsWith('text:🎁')));
    // It is NOT just a link in the text: no path, URL or storage name was put into any message.
    for (const t of sentTexts()) expect(t).not.toMatch(/uploads|\.png|https?:\/\/.*\/api\/dashboard|stored/i);
  });
});

describe('B. an offer with a PDF (or other file) reaches the customer as a real WhatsApp document', () => {
  it('Account 1: a document with the right MIME type, a readable file name and the exact bytes', async () => {
    const pdf = makePdf(['Summer deal terms']);
    const file = doc(LEGACY, 'terms.pdf', pdf);
    offer(LEGACY, { documentId: file.id });
    await openOffers(LEGACY);

    expect(imageCalls()).toHaveLength(0);
    expect(documentCalls()).toHaveLength(1);
    const sent = documentCalls()[0]!;
    expect(sent.mimeType).toBe('application/pdf');
    expect(sent.fileName).toBe('Summer deal.pdf');
    expect(sent.caption).toBe('Summer deal');
    expect(sent.bytes.equals(pdf)).toBe(true);
    expect(sent.bytes.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('an offer with both: text first, then the image, then the document', async () => {
    const image = doc(LEGACY, 'both.png', png('both'));
    const file = doc(LEGACY, 'both.pdf', makePdf(['both']));
    offer(LEGACY, { imageDocumentId: image.id, documentId: file.id });
    await openOffers(LEGACY);
    const media = events.filter((e) => e.startsWith('image:') || e.startsWith('document:'));
    expect(media).toEqual(['image:Summer deal', 'document:Summer deal.pdf']);
    expect(events.findIndex((e) => e.startsWith('text:🎁'))).toBeLessThan(events.indexOf('image:Summer deal'));
  });

  it('other supported file types keep their own MIME type', async () => {
    const docx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('word-file-bytes')]);
    const file = doc(LEGACY, 'details.docx', docx, { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    offer(LEGACY, { documentId: file.id });
    await openOffers(LEGACY);
    expect(documentCalls()[0]).toMatchObject({ mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', fileName: 'Summer deal.docx' });
  });
});

describe('C. an offer with text only behaves exactly as before', () => {
  it('sends the offers text and no media', async () => {
    offer(LEGACY, { titleEn: 'Plain deal' });
    await openOffers(LEGACY);
    expect(sentTexts().some((t) => t.includes('Plain deal'))).toBe(true);
    expect(imageCalls()).toHaveLength(0);
    expect(documentCalls()).toHaveLength(0);
  });

  it('with no visible offers the customer still gets the "no current offers" reply', async () => {
    await openOffers(LEGACY);
    expect(sentTexts().length).toBeGreaterThan(0);
    expect(imageCalls().length + documentCalls().length).toBe(0);
  });
});

describe('D / F. every business — the second one and one created later — gets the same pipeline with its own files', () => {
  it.each([['a second business', () => SECOND], ['a business created later', () => FUTURE]])('%s receives its own image and PDF and nothing of Account 1', async (_name, id) => {
    const accountId = id();
    // Account 1 has its own offer and files too.
    offer(LEGACY, { titleEn: 'ACCOUNT-ONE-ONLY', imageDocumentId: doc(LEGACY, 'one.png', png('one-secret')).id, documentId: doc(LEGACY, 'one.pdf', makePdf(['ACCOUNT-ONE-PDF'])).id });
    const ownPng = png(`own-${accountId}`);
    const ownPdf = makePdf([`own-${accountId}`]);
    offer(accountId, { titleEn: `OWN-${accountId}`, imageDocumentId: doc(accountId, 'own.png', ownPng).id, documentId: doc(accountId, 'own.pdf', ownPdf).id });

    await openOffers(accountId);

    expect(imageCalls()).toHaveLength(1);
    expect(documentCalls()).toHaveLength(1);
    expect(imageCalls()[0]!.bytes.equals(ownPng)).toBe(true);
    expect(documentCalls()[0]!.bytes.equals(ownPdf)).toBe(true);
    expect(imageCalls()[0]!.caption).toBe(`OWN-${accountId}`);
    const everything = JSON.stringify([sentTexts(), imageCalls().map((i) => [i.caption, i.fileName]), documentCalls().map((d) => [d.caption, d.fileName])]);
    expect(everything).not.toContain('ACCOUNT-ONE');
    expect(imageCalls()[0]!.bytes.includes(Buffer.from('one-secret'))).toBe(false);
  });

  it('and Account 1 never gets theirs', async () => {
    offer(SECOND, { titleEn: 'SECOND-ONLY', imageDocumentId: doc(SECOND, 's.png', png('second-secret')).id });
    offer(FUTURE, { titleEn: 'FUTURE-ONLY', documentId: doc(FUTURE, 'f.pdf', makePdf(['FUTURE'])).id });
    const own = png('legacy-own');
    offer(LEGACY, { titleEn: 'LEGACY-OWN', imageDocumentId: doc(LEGACY, 'l.png', own).id });
    await openOffers(LEGACY);
    expect(imageCalls()).toHaveLength(1);
    expect(imageCalls()[0]!.bytes.equals(own)).toBe(true);
    expect(documentCalls()).toHaveLength(0);
    expect(JSON.stringify(sentTexts())).not.toMatch(/SECOND-ONLY|FUTURE-ONLY/);
  });
});

describe('E. one business can never reach another business\'s offer or file', () => {
  it('lookups by id are scoped: Account 1 cannot read Account 2\'s offer or document and vice versa', () => {
    const theirs = doc(SECOND, 'theirs.png', png('theirs'));
    const theirOffer = offer(SECOND, { imageDocumentId: theirs.id });
    const mine = doc(LEGACY, 'mine.png', png('mine'));
    const myOffer = offer(LEGACY, { imageDocumentId: mine.id });
    expect(getOffer(theirOffer.id, undefined, LEGACY)).toBeUndefined();
    expect(getOffer(myOffer.id, undefined, SECOND)).toBeUndefined();
    expect(getDocument(theirs.id, undefined, LEGACY)).toBeUndefined();
    expect(getDocument(mine.id, undefined, SECOND)).toBeUndefined();
    expect(runWithAccount(LEGACY, () => customerOfferMedia('en')).items.map((i) => i.offerId)).toEqual([myOffer.id]);
    expect(runWithAccount(SECOND, () => customerOfferMedia('en')).items.map((i) => i.offerId)).toEqual([theirOffer.id]);
  });

  it('an offer cannot be created or edited to carry another business\'s file', () => {
    const theirs = doc(SECOND, 'theirs.png', png('theirs'));
    expect(() => offer(LEGACY, { imageDocumentId: theirs.id }, false)).toThrow(OfferValidationError);
    const own = offer(LEGACY, {}, false);
    try {
      updateOffer(own.id, { titleAr: 'x', titleEn: 'x', documentId: theirs.id }, 'test', undefined, LEGACY);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(OfferValidationError);
      expect((error as OfferValidationError).fields.documentId).toMatch(/not found among this business/i);
    }
    expect(getOffer(own.id, undefined, LEGACY)!.document_id).toBeNull();
  });

  it('even a database row that points at another business\'s file (bad old data) delivers nothing and leaks nothing', async () => {
    const theirs = doc(SECOND, 'theirs.png', png('THEIRS-SECRET'));
    const mine = offer(LEGACY, { titleEn: 'Tampered' });
    getDb().prepare('UPDATE offers SET image_document_id = ? WHERE id = ?').run(theirs.id, mine.id);
    const warn = vi.spyOn(logger, 'warn');
    await openOffers(LEGACY);
    expect(imageCalls()).toHaveLength(0);
    expect(documentCalls()).toHaveLength(0);
    expect(sentTexts().some((t) => t.includes('Tampered'))).toBe(true); // the offer text is still delivered
    expect(JSON.stringify(warn.mock.calls)).toContain('not_found');
    expect(JSON.stringify([sentTexts(), warn.mock.calls])).not.toContain('THEIRS-SECRET');
  });

  it('the file check itself is scoped: a document id from another business is "not found", whichever slot it is offered for', () => {
    const theirs = doc(SECOND, 'theirs.pdf', makePdf(['theirs']));
    expect(inspectOfferFile(theirs.id, 'document', LEGACY)).toEqual({ ok: false, problem: 'not_found' });
    expect(inspectOfferFile(theirs.id, 'image', LEGACY)).toEqual({ ok: false, problem: 'not_found' });
    expect(inspectOfferFile(theirs.id, 'document', SECOND).ok).toBe(true);
  });
});

describe('G. a missing, empty or broken attachment never crashes anything and never leaks a path', () => {
  const tmp = os.tmpdir();

  it('the stored file has disappeared: the offer text is still sent, nothing else, one safe diagnostic', async () => {
    const image = doc(LEGACY, 'gone.png', png('gone'));
    offer(LEGACY, { titleEn: 'Gone image', imageDocumentId: image.id });
    fs.rmSync(documentPath(getDocument(image.id, undefined, LEGACY)!));
    const warn = vi.spyOn(logger, 'warn');
    const waId = await openOffers(LEGACY);

    expect(sentTexts().some((t) => t.includes('Gone image'))).toBe(true);
    expect(imageCalls()).toHaveLength(0);
    expect(JSON.stringify(warn.mock.calls)).toContain('file_missing');
    const everything = JSON.stringify([sentTexts(), warn.mock.calls]);
    expect(everything).not.toContain(tmp);
    expect(everything).not.toMatch(/uploads/i);
    expect(everything).not.toContain(getDocument(image.id, undefined, LEGACY)!.stored_name);
    expect(listReplyActivity({ limit: 20, accountId: LEGACY }).some((r) => r.kind === 'error' && /attachment/i.test(r.detail ?? ''))).toBe(true);
    expect(getCustomerByWaId(waId, undefined, LEGACY)?.language).toBe('en'); // the conversation carried on normally
  });

  it('an empty file and a file whose bytes do not match its type are never sent', async () => {
    const empty = doc(LEGACY, 'empty.png', png('x'));
    fs.writeFileSync(documentPath(getDocument(empty.id, undefined, LEGACY)!), Buffer.alloc(0));
    const corrupt = doc(LEGACY, 'corrupt.pdf', makePdf(['x']));
    fs.writeFileSync(documentPath(getDocument(corrupt.id, undefined, LEGACY)!), Buffer.from('this is not a pdf at all'));
    offer(LEGACY, { imageDocumentId: empty.id, documentId: corrupt.id });
    const result = runWithAccount(LEGACY, () => customerOfferMedia('en'));
    expect(result.items).toHaveLength(0);
    expect(result.skipped.map((s) => s.reason).sort()).toEqual(['file_corrupt', 'file_empty']);
    await openOffers(LEGACY);
    expect(imageCalls().length + documentCalls().length).toBe(0);
  });

  it('one bad file does not stop the good one after it', async () => {
    const bad = doc(LEGACY, 'bad.png', png('bad'));
    fs.rmSync(documentPath(getDocument(bad.id, undefined, LEGACY)!));
    const good = png('good');
    offer(LEGACY, { titleEn: 'First', imageDocumentId: bad.id, priority: 5 });
    offer(LEGACY, { titleEn: 'Second', imageDocumentId: doc(LEGACY, 'good.png', good).id, priority: 1 });
    await openOffers(LEGACY);
    expect(imageCalls()).toHaveLength(1);
    expect(imageCalls()[0]!.caption).toBe('Second');
    expect(imageCalls()[0]!.bytes.equals(good)).toBe(true);
  });

  it('a path-traversal storage name in the database cannot read files outside the uploads folder', () => {
    const image = doc(LEGACY, 'x.png', png('x'));
    offer(LEGACY, { imageDocumentId: image.id });
    getDb().prepare('UPDATE business_documents SET stored_name = ? WHERE id = ?').run('..\\..\\..\\..\\Windows\\win.ini', image.id);
    getDb().prepare('UPDATE business_documents SET stored_name = ? WHERE id = ?').run('../../../../etc/passwd', image.id);
    const result = runWithAccount(LEGACY, () => customerOfferMedia('en'));
    expect(result.items).toHaveLength(0);
    expect(result.skipped[0]!.reason).toMatch(/file_missing|invalid_path/);
  });

  it('a send failure is logged and recorded, the next file is still attempted, and nothing is thrown', async () => {
    offer(LEGACY, { titleEn: 'One', imageDocumentId: doc(LEGACY, '1.png', png('1')).id, priority: 2 });
    offer(LEGACY, { titleEn: 'Two', imageDocumentId: doc(LEGACY, '2.png', png('2')).id, priority: 1 });
    vi.mocked(sendImageMessage).mockRejectedValueOnce(new Error('socket closed'));
    await openOffers(LEGACY);
    expect(vi.mocked(sendImageMessage)).toHaveBeenCalledTimes(2);
    expect(events.filter((e) => e.startsWith('image:'))).toEqual(['image:Two']);
  });

  it('a connection that cannot carry media (Meta Cloud API) still delivers the text and stops after one note', async () => {
    offer(LEGACY, { titleEn: 'Meta', imageDocumentId: doc(LEGACY, 'm.png', png('m')).id, documentId: doc(LEGACY, 'm.pdf', makePdf(['m'])).id });
    vi.mocked(sendImageMessage).mockRejectedValue(new ImageDeliveryUnsupportedError());
    await openOffers(LEGACY);
    expect(sentTexts().some((t) => t.includes('Meta'))).toBe(true);
    expect(vi.mocked(sendImageMessage)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendDocumentMessage)).not.toHaveBeenCalled();
  });
});

describe('H. offers that must not be shown are not shown — and neither are their files', () => {
  const attach = () => ({ imageDocumentId: doc(LEGACY, `h-${++counter}.png`, png(`h${counter}`)).id });

  it.each([
    ['a draft', (id: number) => setOfferStatus(id, 'draft', 't')],
    ['a finished offer', (id: number) => setOfferStatus(id, 'finished', 't')],
    ['an archived offer', (id: number) => setOfferStatus(id, 'archived', 't')],
    ['a deleted offer', (id: number) => deleteOffer(id, 't')],
  ])('%s sends no media', async (_label, hide) => {
    const o = offer(LEGACY, attach());
    hide(o.id);
    await openOffers(LEGACY);
    expect(imageCalls()).toHaveLength(0);
  });

  it('an expired, a not-yet-started and an internal-only offer send no media', async () => {
    offer(LEGACY, { ...attach(), endsAt: '2020-01-01T00:00:00Z' });
    offer(LEGACY, { ...attach(), startsAt: '2099-01-01T00:00:00Z' });
    offer(LEGACY, { ...attach(), visibility: 'internal' });
    await openOffers(LEGACY);
    expect(imageCalls()).toHaveLength(0);
  });

  it('a customer-visible offer is shown, while its internal sibling is not', async () => {
    const visible = png('visible');
    offer(LEGACY, { titleEn: 'Visible', imageDocumentId: doc(LEGACY, 'v.png', visible).id });
    offer(LEGACY, { titleEn: 'Hidden', visibility: 'internal', ...attach() });
    await openOffers(LEGACY);
    expect(imageCalls().map((i) => i.caption)).toEqual(['Visible']);
    expect(JSON.stringify(sentTexts())).not.toContain('Hidden');
  });

  it('a file marked internal or AI-only is never sent to customers, and cannot be attached when saving', async () => {
    const internal = doc(LEGACY, 'internal.png', png('internal'), { visibility: 'internal' });
    const aiOnly = doc(LEGACY, 'ai.pdf', makePdf(['ai']), { visibility: 'ai_knowledge' });
    expect(() => offer(LEGACY, { imageDocumentId: internal.id }, false)).toThrow(/validation/i);
    expect(() => offer(LEGACY, { documentId: aiOnly.id }, false)).toThrow(OfferValidationError);
    // bad data already in the table (or a file switched to internal afterwards) is still not delivered
    const published = offer(LEGACY, { imageDocumentId: doc(LEGACY, 'later.png', png('later')).id });
    updateDocument(published.image_document_id!, { visibility: 'internal' });
    await openOffers(LEGACY);
    expect(imageCalls()).toHaveLength(0);
  });

  it('archived files and non-pictures in the image slot are refused when saving', () => {
    const archived = doc(LEGACY, 'old.png', png('old'));
    updateDocument(archived.id, { status: 'archived' });
    expect(() => offer(LEGACY, { imageDocumentId: archived.id }, false)).toThrow(OfferValidationError);
    const pdf = doc(LEGACY, 'notpic.pdf', makePdf(['p']));
    try {
      offer(LEGACY, { imageDocumentId: pdf.id }, false);
      expect.unreachable();
    } catch (error) {
      expect((error as OfferValidationError).fields.imageDocumentId).toMatch(/picture/i);
    }
  });

  it('an attachment that did not change is not re-validated, so an older offer stays editable', () => {
    const image = doc(LEGACY, 'keep.png', png('keep'));
    const o = offer(LEGACY, { imageDocumentId: image.id });
    updateDocument(image.id, { status: 'archived' });
    const updated = updateOffer(o.id, { titleAr: 'جديد', titleEn: 'Renamed', imageDocumentId: image.id }, 'test', undefined, LEGACY);
    expect(updated!.title_en).toBe('Renamed');
    expect(updated!.image_document_id).toBe(image.id);
  });
});

describe('J. Arabic and English, without changing which business is served', () => {
  it('the caption and offer text follow the customer\'s language, and the customer\'s language is kept', async () => {
    offer(SECOND, { titleEn: 'English title', titleAr: 'عنوان عربي', imageDocumentId: doc(SECOND, 'l.png', png('lang')).id, documentId: doc(SECOND, 'l.pdf', makePdf(['lang'])).id });
    const arabicCustomer = await openOffers(SECOND, 'ar');
    expect(imageCalls()[0]!.caption).toBe('عنوان عربي');
    expect(documentCalls()[0]!.caption).toBe('عنوان عربي');
    expect(documentCalls()[0]!.fileName).toBe('عنوان عربي.pdf');
    expect(sentTexts().some((t) => t.includes('عنوان عربي'))).toBe(true);
    expect(getCustomerByWaId(arabicCustomer, undefined, SECOND)?.language).toBe('ar');

    vi.clearAllMocks();
    vi.mocked(sendImageMessage).mockResolvedValue({ messaging_product: 'whatsapp', contacts: [], messages: [{ id: 'i' }] });
    vi.mocked(sendDocumentMessage).mockResolvedValue({ messaging_product: 'whatsapp', contacts: [], messages: [{ id: 'd' }] });
    vi.mocked(sendTextMessage).mockResolvedValue({ messaging_product: 'whatsapp', contacts: [], messages: [{ id: 't' }] });
    const englishCustomer = await openOffers(SECOND, 'en');
    expect(imageCalls()[0]!.caption).toBe('English title');
    expect(documentCalls()[0]!.fileName).toBe('English title.pdf');
    expect(getCustomerByWaId(englishCustomer, undefined, SECOND)?.language).toBe('en');
  });

  it('asking for the offers again, after switching language, sends the media again in the new language', async () => {
    offer(LEGACY, { titleEn: 'Switch EN', titleAr: 'تبديل', imageDocumentId: doc(LEGACY, 'sw.png', png('sw')).id });
    const waId = await openOffers(LEGACY, 'en');
    expect(imageCalls().map((i) => i.caption)).toEqual(['Switch EN']);
    await say(LEGACY, waId, '0'); // main menu... then language
    await say(LEGACY, waId, 'language');
    await say(LEGACY, waId, '1'); // Arabic
    await say(LEGACY, waId, '5');
    await say(LEGACY, waId, '3');
    expect(imageCalls().map((i) => i.caption)).toEqual(['Switch EN', 'تبديل']);
    expect(getCustomerByWaId(waId, undefined, LEGACY)?.language).toBe('ar');
  });
});

describe('the conversation record and limits', () => {
  it('each delivered file is recorded in the conversation and activity log so staff can see what the customer received', async () => {
    offer(LEGACY, { titleEn: 'Logged', imageDocumentId: doc(LEGACY, 'log.png', png('log')).id, documentId: doc(LEGACY, 'log.pdf', makePdf(['log'])).id });
    await openOffers(LEGACY);
    const activity = listReplyActivity({ limit: 30, accountId: LEGACY }).map((r) => r.detail ?? '');
    expect(activity).toEqual(expect.arrayContaining(['Offer image sent: Logged', 'Offer document sent: Logged']));
  });

  it('a long list is capped per request, and the files left out are reported rather than dropped silently', () => {
    for (let i = 0; i < MAX_OFFER_MEDIA_FILES + 3; i += 1) offer(LEGACY, { titleEn: `Offer ${i}`, imageDocumentId: doc(LEGACY, `cap-${i}.png`, png(`cap${i}`)).id });
    const result = runWithAccount(LEGACY, () => customerOfferMedia('en'));
    expect(result.items).toHaveLength(MAX_OFFER_MEDIA_FILES);
    expect(result.skipped.filter((s) => s.reason === 'over_limit')).toHaveLength(3);
  });

  it('the same file shared by two offers is sent once', () => {
    const shared = doc(LEGACY, 'shared.png', png('shared'));
    offer(LEGACY, { titleEn: 'A', imageDocumentId: shared.id });
    offer(LEGACY, { titleEn: 'B', imageDocumentId: shared.id });
    expect(runWithAccount(LEGACY, () => customerOfferMedia('en')).items).toHaveLength(1);
  });
});
