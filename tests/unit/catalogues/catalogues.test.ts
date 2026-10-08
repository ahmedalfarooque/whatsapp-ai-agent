import path from 'node:path';
import fs from 'node:fs';
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb } from '../../../src/memory/db';
import { createAccount } from '../../../src/accounts/accountRepo';
import { runWithAccount } from '../../../src/accounts/accountContext';
import { accountHasFeature, setAccountFeature, FEATURES } from '../../../src/accounts/accountFeatures';
import {
  CatalogueError, MAX_CATALOGUE_BYTES, customerCatalogues, deleteCatalogue, getCatalogue, getDeliverableCatalogue, listCatalogues, moveCatalogue,
  registerExistingDocument, renameCatalogue, renderCustomerCatalogues, reorderCatalogues, replaceCatalogueFile, setCatalogueEnabled, uploadCatalogue,
} from '../../../src/catalogues/catalogueRepo';
import { searchSources } from '../../../src/catalogues/catalogueSearch';
import { isCatalogueRequest } from '../../../src/catalogues/catalogueIntent';
import { documentPath, documentsForAiContext, getDocument, listDocuments, saveDocument } from '../../../src/documents/documentStore';
import { createLink, recordFetchResult } from '../../../src/setup/linksRepo';
import { buildSystemPrompt } from '../../../src/llm/buildSystemPrompt';
import { toolSchemasForAccount } from '../../../src/tools';
import { searchCataloguesHandler } from '../../../src/tools/searchCatalogues';
import { makePdf } from '../../fixtures/makePdf';

const KNOWLEDGE = { sections: [], asPromptText: '' };
const JOTUN = 2; // has the catalogue library
const OTHER = 3; // a second business WITHOUT it
const PAINT2 = 4; // a second business WITH it (cross-business checks)

const soulful = makePdf(['Jotun Soulful Spaces', '1625 Soul is a warm neutral', 'Hazelnut Beige 12300 suits a bedroom', 'Colours shown are approximations; check an applied sample']);
const nuances = makePdf(['Jotun Nuances 2025', 'Wonderwall Lux gives a rich matt finish', 'Lady Design Touch of Suede']);
const brochure = makePdf(['Jotun Brochure', 'Smooth Silk finish for living rooms']);
const up = (bytes: Buffer, name: string, title?: string) => ({ originalName: name, mimeType: 'application/pdf', bytes, title: title ?? null, uploadedBy: 'test' });

beforeAll(() => {
  getDb();
  expect(createAccount({ name: 'JOTUN Test' }).id).toBe(JOTUN);
  expect(createAccount({ name: 'Other Business' }).id).toBe(OTHER);
  expect(createAccount({ name: 'Second Paint Shop' }).id).toBe(PAINT2);
  setAccountFeature(JOTUN, FEATURES.CATALOGUES, true);
  setAccountFeature(PAINT2, FEATURES.CATALOGUES, true);
});

describe('feature flag', () => {
  it('is on only where it was switched on, and can never be switched on for the original business', () => {
    expect(accountHasFeature(JOTUN, FEATURES.CATALOGUES)).toBe(true);
    expect(accountHasFeature(OTHER, FEATURES.CATALOGUES)).toBe(false);
    expect(() => setAccountFeature(1, FEATURES.CATALOGUES, true)).toThrow();
    // even a row forced into the table for account 1 changes nothing
    getDb().prepare("INSERT INTO account_features (whatsapp_account_id, feature, enabled) VALUES (1, 'catalogues', 1)").run();
    expect(accountHasFeature(1, FEATURES.CATALOGUES)).toBe(false);
    getDb().prepare('DELETE FROM account_features WHERE whatsapp_account_id = 1').run();
  });
});

describe('uploading catalogues (PDF only, safe)', () => {
  it('stores a valid PDF in the business folder with its metadata, a default title and readable text', async () => {
    const c = await uploadCatalogue(up(soulful, 'Jotun_Interiour Colors 1.pdf'), JOTUN);
    expect(c).toMatchObject({ accountId: JOTUN, title: 'Jotun Interiour Colors 1', originalName: 'Jotun_Interiour Colors 1.pdf', pageCount: 1, enabled: true, hasText: true });
    expect(c.sizeBytes).toBe(soulful.length);
    const doc = getDocument(c.documentId, undefined, JOTUN)!;
    expect(doc).toMatchObject({ extension: 'pdf', visibility: 'ai_knowledge', purpose: 'product_catalogue', processing: 'text_extracted', whatsapp_account_id: JOTUN });
    expect(documentPath(doc)).toContain(`accounts${path.sep}${JOTUN}${path.sep}uploads`);
    expect(fs.readFileSync(documentPath(doc)).equals(soulful)).toBe(true); // byte-for-byte what was uploaded
    renameCatalogue(c.id, 'Jotun Soulful Spaces', JOTUN);
  });

  it('rejects anything that is not a real PDF: wrong extension, wrong MIME type, empty, fake content, damaged, too large', async () => {
    const bad = (input: Parameters<typeof up>, message: RegExp) => expect(uploadCatalogue({ ...up(...input) }, JOTUN)).rejects.toThrow(message);
    await bad([soulful, 'notes.txt'], /\.pdf/);
    await expect(uploadCatalogue({ ...up(soulful, 'x.pdf'), mimeType: 'image/png' }, JOTUN)).rejects.toThrow(/application\/pdf/);
    await expect(uploadCatalogue({ ...up(soulful, 'x.pdf'), mimeType: '' }, JOTUN)).rejects.toThrow(/application\/pdf/);
    await bad([Buffer.alloc(0), 'x.pdf'], /empty/);
    await bad([Buffer.from('<html>not a pdf</html>'), 'x.pdf'], /not a PDF/);
    await bad([Buffer.from('%PDF-1.4\nthis is garbage, not a document'), 'x.pdf'], /could not be read/);
    const huge = Buffer.alloc(MAX_CATALOGUE_BYTES + 1, 0x20);
    huge.write('%PDF-', 0);
    await expect(uploadCatalogue(up(huge, 'huge.pdf'), JOTUN)).rejects.toMatchObject({ status: 413 });
    expect(listCatalogues(JOTUN)).toHaveLength(1); // nothing partial was left behind
    expect(listDocuments({ accountId: JOTUN })).toHaveLength(1);
  });

  it('rejects the exact same file twice', async () => {
    await expect(uploadCatalogue(up(soulful, 'copy.pdf'), JOTUN)).rejects.toMatchObject({ status: 409 });
  });

  it('shows several catalogues in the owner’s order, and a newly uploaded one appears in the customer list by itself', async () => {
    expect(renderCustomerCatalogues('en', JOTUN)).toBe('1️⃣ Jotun Soulful Spaces');
    await uploadCatalogue(up(nuances, 'nuances.pdf', 'Jotun Nuances 2025'), JOTUN);
    await uploadCatalogue(up(brochure, 'brochure.pdf', 'Jotun Brochure'), JOTUN);
    expect(customerCatalogues(JOTUN).map((c) => c.title)).toEqual(['Jotun Soulful Spaces', 'Jotun Nuances 2025', 'Jotun Brochure']);
    expect(renderCustomerCatalogues('ar', JOTUN)).toBe('1️⃣ Jotun Soulful Spaces\n2️⃣ Jotun Nuances 2025\n3️⃣ Jotun Brochure');
  });
});

describe('managing catalogues', () => {
  it('disabling hides a catalogue from customers, delivery and the assistant; enabling brings it back', () => {
    const [first, second] = listCatalogues(JOTUN);
    setCatalogueEnabled(second!.id, false, JOTUN);
    expect(customerCatalogues(JOTUN).map((c) => c.title)).toEqual(['Jotun Soulful Spaces', 'Jotun Brochure']);
    expect(getDeliverableCatalogue(second!.id, JOTUN)).toBeUndefined();
    expect(getDeliverableCatalogue(first!.id, JOTUN)).toBeDefined();
    expect(runWithAccount(JOTUN, () => searchSources('Wonderwall Lux'))).toEqual([]); // its text is not searchable while disabled
    expect(getDocument(second!.documentId, undefined, JOTUN)!.visibility).toBe('internal');
    setCatalogueEnabled(second!.id, true, JOTUN);
    expect(customerCatalogues(JOTUN)).toHaveLength(3);
    expect(runWithAccount(JOTUN, () => searchSources('Wonderwall Lux')).length).toBeGreaterThan(0);
  });

  it('reorders (move up/down and full order) and renames, with validation', () => {
    const ids = listCatalogues(JOTUN).map((c) => c.id);
    moveCatalogue(ids[2]!, 'up', JOTUN);
    expect(listCatalogues(JOTUN).map((c) => c.id)).toEqual([ids[0], ids[2], ids[1]]);
    moveCatalogue(ids[0]!, 'up', JOTUN); // already first: no change
    expect(listCatalogues(JOTUN)[0]!.id).toBe(ids[0]);
    reorderCatalogues([ids[1]!, ids[0]!, ids[2]!], JOTUN);
    expect(customerCatalogues(JOTUN).map((c) => c.id)).toEqual([ids[1], ids[0], ids[2]]);
    expect(() => reorderCatalogues([ids[0]!], JOTUN)).toThrow(CatalogueError);
    expect(() => reorderCatalogues([ids[0]!, ids[0]!, ids[1]!], JOTUN)).toThrow(CatalogueError);
    expect(() => renameCatalogue(ids[0]!, '   ', JOTUN)).toThrow(/title/);
    expect(() => renameCatalogue(ids[0]!, 'x'.repeat(121), JOTUN)).toThrow(/too long/);
    reorderCatalogues(ids, JOTUN);
  });

  it('replacing the file keeps the catalogue (id, title, position) and refreshes pages and text', async () => {
    const target = listCatalogues(JOTUN)[2]!; // Jotun Brochure
    const newer = makePdf(['Jotun Brochure 2026', 'Fenomastic My Home Rich Matt']);
    const updated = await replaceCatalogueFile(target.id, { originalName: 'brochure-2026.pdf', mimeType: 'application/pdf', bytes: newer }, JOTUN);
    expect(updated).toMatchObject({ id: target.id, title: 'Jotun Brochure', sortOrder: target.sortOrder, originalName: 'brochure-2026.pdf' });
    expect(fs.readFileSync(documentPath(getDocument(updated.documentId, undefined, JOTUN)!)).equals(newer)).toBe(true);
    expect(runWithAccount(JOTUN, () => searchSources('My Home Rich Matt')).length).toBeGreaterThan(0);
    await expect(replaceCatalogueFile(target.id, { originalName: 'x.pdf', mimeType: 'application/pdf', bytes: soulful }, JOTUN)).rejects.toMatchObject({ status: 409 }); // already another catalogue
  });

  it('deleting removes the catalogue, its document and its file, and customers stop seeing it at once', () => {
    const victim = listCatalogues(JOTUN)[2]!;
    const file = documentPath(getDocument(victim.documentId, undefined, JOTUN)!);
    expect(fs.existsSync(file)).toBe(true);
    deleteCatalogue(victim.id, JOTUN);
    expect(fs.existsSync(file)).toBe(false);
    expect(getCatalogue(victim.id, JOTUN)).toBeUndefined();
    expect(getDocument(victim.documentId, undefined, JOTUN)).toBeUndefined();
    expect(customerCatalogues(JOTUN).map((c) => c.title)).not.toContain('Jotun Brochure');
    expect(() => deleteCatalogue(victim.id, JOTUN)).toThrow(/not found/);
  });

  it('registers an already-stored PDF document (no copy, no duplicate)', async () => {
    const stored = saveDocument({ originalName: 'earlier.pdf', mimeType: 'application/pdf', bytes: makePdf(['Earlier upload']), visibility: 'internal', accountId: JOTUN });
    const c = await registerExistingDocument(JOTUN, stored.id, 'Earlier Catalogue');
    expect(c).toMatchObject({ documentId: stored.id, title: 'Earlier Catalogue', pageCount: 1 });
    expect((await registerExistingDocument(JOTUN, stored.id, 'Again')).id).toBe(c.id);
    deleteCatalogue(c.id, JOTUN);
  });
});

describe('isolation between businesses', () => {
  it('a business without the library sees and can do nothing; the original business too', async () => {
    for (const account of [1, OTHER]) {
      expect(listCatalogues(account)).toEqual([]);
      expect(customerCatalogues(account)).toEqual([]);
      expect(renderCustomerCatalogues('en', account)).toBe('');
      await expect(uploadCatalogue(up(soulful, 'x.pdf'), account)).rejects.toMatchObject({ status: 404 });
    }
  });

  it('another business WITH the library cannot read, change, delete or send a catalogue of this one', async () => {
    const mine = listCatalogues(JOTUN)[0]!;
    expect(getCatalogue(mine.id, PAINT2)).toBeUndefined();
    expect(getDeliverableCatalogue(mine.id, PAINT2)).toBeUndefined();
    expect(() => renameCatalogue(mine.id, 'hijacked', PAINT2)).toThrow(/not found/);
    expect(() => setCatalogueEnabled(mine.id, false, PAINT2)).toThrow(/not found/);
    expect(() => deleteCatalogue(mine.id, PAINT2)).toThrow(/not found/);
    expect(getCatalogue(mine.id, JOTUN)).toMatchObject({ title: mine.title, enabled: true });
    // …and the same file can be added by the other business without being treated as a duplicate of this one
    const theirs = await uploadCatalogue(up(soulful, 'theirs.pdf', 'Their copy'), PAINT2);
    expect(theirs.accountId).toBe(PAINT2);
    expect(listCatalogues(JOTUN).map((c) => c.title)).not.toContain('Their copy');
    expect(runWithAccount(PAINT2, () => searchSources('Hazelnut Beige')).every((h) => h.title === 'Their copy')).toBe(true);
    deleteCatalogue(theirs.id, PAINT2);
  });

  it('files are served only from the owning business (the delivery lookup is account-scoped)', () => {
    const mine = listCatalogues(JOTUN)[0]!;
    const deliverable = getDeliverableCatalogue(mine.id, JOTUN)!;
    expect(deliverable).toMatchObject({ title: mine.title, fileName: `${mine.title}.pdf`, mimeType: 'application/pdf' });
    expect(deliverable.fileName).not.toMatch(/[\\/:*?"<>|]/);
    expect(deliverable.path).toContain(`${path.sep}${JOTUN}${path.sep}`);
  });
});

describe('what the assistant can use', () => {
  it('prompt-stuffing skips catalogue files (they are searched, not pasted)', () => {
    expect(documentsForAiContext(undefined, JOTUN).map((d) => d.title)).toEqual([]);
  });

  it('searches the enabled catalogues of this business only, with colour codes weighing most', () => {
    const hits = runWithAccount(JOTUN, () => searchSources('Hazelnut Beige 12300 bedroom'));
    expect(hits[0]).toMatchObject({ source: 'catalogue', title: 'Jotun Soulful Spaces' });
    expect(hits[0]!.excerpt).toContain('Hazelnut Beige 12300');
    expect(runWithAccount(OTHER, () => searchSources('Hazelnut Beige'))).toEqual([]);
    expect(searchSources('Hazelnut Beige', 4, 1)).toEqual([]); // the original business
    expect(runWithAccount(JOTUN, () => searchSources('zzzxqj nothing like this'))).toEqual([]);
  });

  it('prefers the official website page over a catalogue when both say the same thing', () => {
    const link = createLink({ url: 'https://www.jotun.com/sa-en/decorative/products/interior', kind: 'website', label: 'Jotun interior products' }, JOTUN);
    recordFetchResult(link.id, { ok: true, httpStatus: 200, error: null, title: 'Interior paint guide', text: 'Fenomastic Wonderwall Lux is an interior matt paint with a rich finish.', sha256: 'x' }, JOTUN);
    const hits = runWithAccount(JOTUN, () => searchSources('Wonderwall Lux matt finish'));
    expect(hits[0]).toMatchObject({ source: 'website', title: 'Jotun interior products' });
    expect(hits.some((h) => h.source === 'catalogue')).toBe(true);
  });

  it('the search tool and the prompt rules exist only for businesses with the library', async () => {
    const names = (id: number) => toolSchemasForAccount(id).map((t) => (t.function as { name: string }).name);
    expect(names(JOTUN)).toEqual(['search_catalogues']);
    expect(names(OTHER)).toEqual([]);
    expect(names(1)).toEqual(['check_availability', 'book_appointment']); // the original business: unchanged
    expect(runWithAccount(JOTUN, () => buildSystemPrompt(KNOWLEDGE, 'en'))).toContain('search_catalogues');
    expect(runWithAccount(JOTUN, () => buildSystemPrompt(KNOWLEDGE, 'en'))).toContain('Never invent products');
    expect(runWithAccount(OTHER, () => buildSystemPrompt(KNOWLEDGE, 'en'))).not.toContain('search_catalogues');
    expect(buildSystemPrompt(KNOWLEDGE, 'en')).not.toMatch(/search_catalogues|CATALOGUES AND OFFICIAL SOURCES/);
    const found = (await runWithAccount(JOTUN, () => searchCataloguesHandler({ query: 'Soul 1625' }))) as { results: unknown[] };
    expect(found.results.length).toBeGreaterThan(0);
    const none = (await runWithAccount(OTHER, () => searchCataloguesHandler({ query: 'Soul 1625' }))) as { results: unknown[]; note: string };
    expect(none.results).toEqual([]);
    expect(await searchCataloguesHandler({})).toEqual({ error: 'query is required' });
  });
});

describe('catalogue request detection (English and Arabic)', () => {
  it.each([
    'catalogue', 'Catalog', 'send me the catalogue', 'I want the colour catalogue', 'Send me the Jotun brochure', 'I want to download the catalogue',
    'color chart please', 'كتالوج', 'أرسل لي كتالوج جوتن', 'أريد كتالوج الألوان', 'أريد البروشور', 'كتالوجات جوتن', 'كاتالوج', 'دليل الألوان',
  ])('treats "%s" as a catalogue request', (text) => expect(isCatalogueRequest(text)).toBe(true));

  it.each([
    '', 'hello', 'I need a colour for my bedroom', 'ما هي دهانات جوتن الداخلية؟', 'where is your shop',
    'does the catalogue you sent last week include the new warm neutral colours for large living rooms and bedrooms',
  ])('does not take over "%s"', (text) => expect(isCatalogueRequest(text)).toBe(false));
});
