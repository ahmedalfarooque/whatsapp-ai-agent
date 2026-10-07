import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, afterEach, describe, expect, it } from 'vitest';
import { getDb } from '../../../src/memory/db';
import { createAccount } from '../../../src/accounts/accountRepo';
import { runWithAccount } from '../../../src/accounts/accountContext';
import { getBusinessSettings, updateBusinessSettings } from '../../../src/config/businessSettings';
import { saveDocument } from '../../../src/documents/documentStore';
import { createLink, listLinks, recordFetchResult } from '../../../src/setup/linksRepo';
import { generateDraftContent, setAiExtractor, groundAiResult } from '../../../src/setup/generator';
import { createDraft, getDraft, latestDraft, updateDraftContent, discardDraft, DraftStateError } from '../../../src/setup/draftRepo';
import { applyDraft, ApplyError } from '../../../src/setup/applyDraft';
import { classifyBusiness, buildMenu, menuFactsFrom } from '../../../src/setup/menuGenerator';
import { emptyDraft, parseDraftContent, DraftValidationError, type DraftContent } from '../../../src/setup/types';
import { knowledgeDirForAccount } from '../../../src/knowledge/paths';
import { getTemplate, listTemplates, publishTemplate, resolveTemplate } from '../../../src/templates/templateRepo';
import { getMenuConfig, getMenuTables } from '../../../src/automation/menuConfig';
import { listOffers } from '../../../src/offers/offerRepo';
import { routeMenu } from '../../../src/automation/menuRouter';
import { getOrCreateCustomer } from '../../../src/memory/customerRepo';
import { buildSystemPrompt } from '../../../src/llm/buildSystemPrompt';
import type { SetupSources } from '../../../src/setup/sources';

const PRICE_LIST = `Services
- Haircut — 50 SAR
- Hair colouring: full colour with premium dye — SAR 250
- Manicure | classic nail care | 80 SAR
- قص شعر - 60 ريال

Offers
- Weekend special: 20% off haircuts

FAQ
Q: Do you take walk-ins? A: Yes, subject to availability.

Policies
- Cancellations are free up to 24 hours before the appointment.
`;

let salon: number;
let paint: number;
let auto: number;
let other: number;

function uploadText(accountId: number, name: string, text: string, purpose: string | null = 'price_list') {
  return saveDocument({ originalName: name, mimeType: 'text/plain', bytes: Buffer.from(text), visibility: 'ai_knowledge', purpose, accountId });
}

beforeAll(() => {
  getDb();
  salon = createAccount({ name: 'Noor Salon', nameAr: 'صالون نور', businessCategory: 'Beauty salon' }).id;
  paint = createAccount({ name: 'Colour House', businessCategory: 'Paint store' }).id;
  auto = createAccount({ name: 'Speedy Auto', businessCategory: 'Car care and tinting' }).id;
  other = createAccount({ name: 'Other Business', businessCategory: 'Restaurant' }).id;
  updateBusinessSettings({
    descriptionEn: 'A neighbourhood salon offering hair and nail care. We love our regulars.',
    addressEn: 'Tahlia Street, Jeddah', contactPhone: '+966 50 000 1111', googleMapsUrl: 'https://maps.app.goo.gl/noor123',
    businessHoursStart: '10:00', businessHoursEnd: '22:00', businessDays: '1,2,3,4,5,6,7',
  }, salon);
});

afterEach(() => setAiExtractor(null));

describe('classification and the generated menu', () => {
  it('derives a business profile from category / name', () => {
    expect(classifyBusiness('Beauty salon', 'Noor', null)).toBe('salon');
    expect(classifyBusiness('Paint store', 'Colour House', null)).toBe('paint');
    expect(classifyBusiness('JOTUN dealer — paints & coatings', 'JOTUN Rowad Alfa', null)).toBe('paint');
    expect(classifyBusiness('Car care and tinting', 'Speedy', null)).toBe('auto');
    expect(classifyBusiness('Restaurant', 'Grill', null)).toBe('restaurant');
    expect(classifyBusiness('Dental clinic', 'Smile', null)).toBe('clinic');
    expect(classifyBusiness(null, 'Acme Holdings', null)).toBe('generic');
    expect(classifyBusiness('عيادة أسنان', null, null)).toBe('clinic');
    expect(classifyBusiness(null, null, null)).toBe('generic');
  });

  it('gives different menus to different businesses, shaped by what was found', () => {
    const base = emptyDraft();
    const item = (name: string, price: string | null = null) => ({ id: name, nameEn: name, nameAr: null, descriptionEn: null, descriptionAr: null, price, source: 'doc:1', evidence: name, include: true });
    const salonDraft: DraftContent = { ...base, services: [item('Haircut', '50 SAR')], location: { ...base.location, addressEn: 'Jeddah' }, contact: { phone: '+966', email: null, website: null } };
    const paintDraft: DraftContent = { ...base, products: [item('Emulsion 4L', '120 SAR')], categories: [item('Brands: Jotun'), item('Colours: Sand')], location: { ...base.location, mapsUrl: 'https://maps.app.goo.gl/x' }, contact: { phone: '+966', email: null, website: null } };
    const autoDraft: DraftContent = { ...base, services: [item('Window tint', '300 SAR')], products: [item('Dash cam')], location: { ...base.location, addressEn: 'Jeddah' }, contact: { phone: '+966', email: null, website: null } };
    const facts = (draft: DraftContent, category: string) => menuFactsFrom(draft, { profile: classifyBusiness(category, null, null), mentionsAppointments: false, existingOffers: false });
    const ids = (draft: DraftContent, category: string) => buildMenu(facts(draft, category)).items.map((i) => i.id);

    expect(ids(salonDraft, 'Beauty salon')).toEqual(['services', 'prices', 'offers', 'book', 'location', 'contact', 'staff']);
    expect(ids(paintDraft, 'Paint store')).toEqual(['products', 'brands', 'colours', 'offers', 'priceinquiry', 'quote', 'location', 'contact', 'staff']);
    expect(ids(autoDraft, 'Car care')).toEqual(['services', 'products', 'offers', 'book', 'quote', 'location', 'contact', 'staff']);
    // Nothing found: only what the category implies and what needs no content remains — and a person is always reachable.
    const emptyIds = ids(base, 'Paint store');
    expect(emptyIds).not.toContain('brands');
    expect(emptyIds).not.toContain('location');
    expect(emptyIds).not.toContain('contact');
    expect(emptyIds.at(-1)).toBe('staff');
  });
});

describe('Analyze & Generate uses only the selected account', () => {
  it('builds the draft from this account\'s profile, links, PDFs/text and image notes — and nothing from another account', async () => {
    uploadText(salon, 'prices.txt', PRICE_LIST);
    saveDocument({ originalName: 'storefront.png', mimeType: 'image/png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]), purpose: 'storefront', caption: 'Our shop front on Tahlia Street', accountId: salon });
    const link = createLink({ url: 'https://noor.example', label: 'Website' }, salon);
    recordFetchResult(link.id, { ok: true, httpStatus: 200, error: null, title: 'Noor', text: 'Services\n- Pedicure — 90 SAR\nEmail: hello@noor.example', sha256: 'h' }, salon);
    const dead = createLink({ url: 'https://instagram.com/noor' }, salon);
    recordFetchResult(dead.id, { ok: false, httpStatus: 403, error: 'instagram.com did not return a public page (it usually requires a login).', title: null, text: '', sha256: null }, salon);
    // Another business's confidential material, in every kind of source
    uploadText(other, 'secret.txt', 'Services\n- SECRET-OTHER-SERVICE — 999 SAR\nPhone: +966 55 999 9999');
    runWithAccount(other, () => updateBusinessSettings({ descriptionEn: 'OTHER-BUSINESS-DESCRIPTION' }));
    createLink({ url: 'https://other-business.example' }, other);

    const result = await generateDraftContent(salon, { useAi: false });
    const c = result.content;
    expect(result.generator).toBe('rules');

    expect(c.services.map((s) => s.nameEn ?? s.nameAr).sort()).toEqual(['Haircut', 'Hair colouring', 'Manicure', 'Pedicure', 'قص شعر'].sort());
    expect(c.services.find((s) => s.nameEn === 'Haircut')).toMatchObject({ price: '50 SAR', include: true, source: expect.stringMatching(/^doc:/) });
    expect(c.services.find((s) => s.nameEn === 'Pedicure')).toMatchObject({ price: '90 SAR', source: `link:${link.id}` });
    expect(c.offers.map((o) => o.nameEn)).toEqual(['Weekend special']);
    expect(c.faqs[0]).toMatchObject({ questionEn: 'Do you take walk-ins?', answerEn: 'Yes, subject to availability.' });
    expect(c.aiKnowledge.map((k) => k.text).join(' ')).toContain('Cancellations are free');
    expect(c.profile.detailedEn).toContain('neighbourhood salon');
    expect(c.profile.shortEn).toBe('A neighbourhood salon offering hair and nail care.');
    expect(c.hours.en).toContain('10:00 AM');
    expect(c.location).toMatchObject({ addressEn: 'Tahlia Street, Jeddah', mapsUrl: 'https://maps.app.goo.gl/noor123' });
    expect(c.contact).toMatchObject({ phone: '+966 50 000 1111', email: 'hello@noor.example', website: 'https://noor.example/' });

    // The unreachable link is reported, not silently ignored or guessed at.
    expect(c.gaps.join('\n')).toMatch(/Source not used: .*instagram\.com.*requires a login/);
    expect(result.sources.images).toEqual([expect.objectContaining({ purpose: 'storefront', caption: 'Our shop front on Tahlia Street' })]);

    const everything = JSON.stringify(result);
    for (const leak of ['SECRET-OTHER', 'OTHER-BUSINESS-DESCRIPTION', 'other-business.example', '999 9999', 'Rowad']) expect(everything, leak).not.toContain(leak);
  });

  it('does not invent: no sources → no catalogue, and every missing piece is stated plainly', async () => {
    const result = await generateDraftContent(auto, { useAi: false });
    const c = result.content;
    expect(c.services).toEqual([]);
    expect(c.products).toEqual([]);
    expect(c.offers).toEqual([]);
    expect(c.faqs).toEqual([]);
    expect(c.hours).toEqual({ en: null, ar: null });
    expect(c.location.addressEn).toBeNull();
    expect(c.contact).toEqual({ phone: null, email: null, website: null });
    expect(c.profile.detailedEn).toBeNull();
    expect(c.gaps.join('\n')).toMatch(/Opening hours: Not provided/);
    expect(c.gaps.join('\n')).toMatch(/Prices: Not provided/);
    expect(c.gaps.join('\n')).toMatch(/Address: Not provided/);
    expect(result.warnings.join(' ')).toMatch(/No readable sources/);
    // prose without structure yields no facts either
    uploadText(auto, 'brochure.txt', 'We are a friendly company and we love cars. Come and visit us any time, we are always happy.', 'brochure');
    const again = (await generateDraftContent(auto, { useAi: false })).content;
    expect(again.services).toEqual([]);
    expect(again.products).toEqual([]);
  });

  it('the AI path keeps only facts whose quote is in the cited source and whose price appears there', async () => {
    const text = 'Our window tinting costs 300 SAR and lasts five years. Dash cams from 180 SAR.';
    const tintDoc = uploadText(auto, 'tint.txt', text, 'service_catalogue');
    const ref = `doc:${tintDoc.id}`;
    setAiExtractor(async (sources: SetupSources) => {
      const parsed = {
        services: [
          { nameEn: 'Window tinting', nameAr: 'تظليل النوافذ', descriptionEn: 'Lasts five years', descriptionAr: null, price: '300 SAR', source: ref, evidence: 'window tinting costs 300 SAR' },
          { nameEn: 'Gold plating', nameAr: null, descriptionEn: 'Luxury', descriptionAr: null, price: '5000 SAR', source: ref, evidence: 'gold plating costs 5000 SAR' }, // fabricated quote
          { nameEn: 'Underbody coating', nameAr: null, descriptionEn: null, descriptionAr: null, price: null, source: 'doc:99999', evidence: 'underbody coating' }, // unknown source
        ],
        products: [{ nameEn: 'Dash cam', nameAr: null, descriptionEn: null, descriptionAr: null, price: '150 SAR', source: ref, evidence: 'Dash cams from 180 SAR' }], // quote ok, price altered
        categories: [], offers: [],
        faqs: [{ questionEn: 'Is there a warranty?', questionAr: null, answerEn: 'Yes, 10 years', answerAr: null, source: ref, evidence: 'ten year warranty included' }], // fabricated
        knowledge: [], hours: { text: 'Open 24/7', source: ref, evidence: 'open all night every day' }, phone: { value: '+966 11 222 3333', source: ref, evidence: 'call us on +966 11 222 3333' }, email: null,
      };
      const { extracted, dropped } = groundAiResult(parsedSchema(parsed), sources);
      return { extracted, dropped, model: 'test/model' };
    });
    const result = await generateDraftContent(auto, { useAi: true });
    expect(result.generator).toBe('ai');
    expect(result.model).toBe('test/model');
    const names = result.content.services.map((s) => s.nameEn);
    expect(names).toContain('Window tinting');
    expect(names).not.toContain('Gold plating');
    expect(names).not.toContain('Underbody coating');
    expect(result.content.services.find((s) => s.nameEn === 'Window tinting')).toMatchObject({ price: '300 SAR', nameAr: 'تظليل النوافذ' });
    expect(result.content.products.find((p) => p.nameEn === 'Dash cam')?.price).toBeNull(); // 150 is not in the source
    expect(result.content.faqs).toEqual([]);
    expect(result.content.hours).toEqual({ en: null, ar: null });
    expect(result.content.contact.phone).toBeNull();
    expect(result.warnings.join(' ')).toMatch(/discarded because they could not be verified/);
  });

  it('falls back to rules with a visible warning when the AI is unavailable', async () => {
    setAiExtractor(async () => ({ error: 'OpenRouter is not configured — sources were analysed by rules only.' }));
    const result = await generateDraftContent(salon, { useAi: true });
    expect(result.generator).toBe('rules');
    expect(result.warnings).toContain('OpenRouter is not configured — sources were analysed by rules only.');
    expect(result.content.services.length).toBeGreaterThan(0);
  });
});

// The same lenient shape the model's JSON is parsed into.
import { z } from 'zod';
function parsedSchema(value: unknown): Parameters<typeof groundAiResult>[0] {
  const text = z.string().nullish().transform((v) => (typeof v === 'string' && v.trim() ? v.trim() : null));
  const item = z.object({ nameEn: text, nameAr: text, descriptionEn: text, descriptionAr: text, price: text, source: z.string(), evidence: z.string() });
  const faq = z.object({ questionEn: text, questionAr: text, answerEn: text, answerAr: text, source: z.string(), evidence: z.string() });
  const c = z.object({ value: z.string(), source: z.string(), evidence: z.string() });
  return z.object({
    services: z.array(item), products: z.array(item), categories: z.array(item), offers: z.array(item), faqs: z.array(faq),
    knowledge: z.array(z.object({ title: z.string(), text: z.string(), source: z.string(), evidence: z.string() })),
    hours: z.object({ text: z.string(), source: z.string(), evidence: z.string() }).nullish(), phone: c.nullish(), email: c.nullish(),
  }).parse(value) as Parameters<typeof groundAiResult>[0];
}

describe('generate → review → edit → apply', () => {
  async function freshDraft(accountId: number): Promise<number> {
    const result = await generateDraftContent(accountId, { useAi: false });
    return createDraft({ content: result.content, generator: result.generator, model: null, sources: {}, warnings: result.warnings, createdBy: 'test' }, accountId).id;
  }

  it('a draft is only a draft: generating changes nothing live', async () => {
    const before = { profile: getBusinessSettings(salon), templates: listTemplates(undefined, salon).map((t) => t.liveEn), offers: listOffers({ accountId: salon }).length, menu: getMenuConfig(salon).source };
    const id = await freshDraft(salon);
    expect(getDraft(id, salon)?.status).toBe('draft');
    expect(latestDraft(salon)?.id).toBe(id);
    expect(getDraft(id, paint)).toBeUndefined(); // another account cannot open it
    expect(getBusinessSettings(salon)).toEqual(before.profile);
    expect(listTemplates(undefined, salon).map((t) => t.liveEn)).toEqual(before.templates);
    expect(listOffers({ accountId: salon }).length).toBe(before.offers);
    expect(getMenuConfig(salon).source).toBe(before.menu);
    expect(fs.existsSync(path.join(knowledgeDirForAccount(salon), 'services.md'))).toBe(false);
  });

  it('a draft is editable; invalid edits are refused; applied/discarded drafts can no longer be edited', async () => {
    const id = await freshDraft(salon);
    const draft = getDraft(id, salon)!;
    const edited = structuredClone(draft.content);
    edited.services[0]!.nameEn = 'Premium haircut';
    edited.services[1]!.include = false;
    edited.profile.introEn = 'Edited by hand';
    const saved = updateDraftContent(id, edited, salon)!;
    expect(saved.content.services[0]!.nameEn).toBe('Premium haircut');
    expect(saved.content.services[1]!.include).toBe(false);
    expect(() => updateDraftContent(id, { ...edited, menu: { version: 1, items: [] } }, salon)).toThrow(DraftValidationError);
    expect(() => updateDraftContent(id, { nonsense: true }, salon)).toThrow(DraftValidationError);
    expect(updateDraftContent(id, edited, paint)).toBeUndefined();
    expect(discardDraft(id, salon)).toBe(true);
    expect(() => updateDraftContent(id, edited, salon)).toThrow(DraftStateError);
  });

  it('Save as draft stages templates/offers only — nothing customers or the AI can see changes', async () => {
    const id = await freshDraft(salon);
    const liveBefore = getTemplate('main_menu', undefined, salon)!.liveEn;
    const report = applyDraft(salon, id, { mode: 'save_draft', actor: 'tester' });
    expect(report.entries.find((e) => e.section === 'templates')?.action).toBe('staged');
    expect(report.entries.find((e) => e.section === 'offers')?.action).toBe('staged');
    expect(report.entries.find((e) => e.section === 'menu')?.action).toBe('skipped');
    expect(report.entries.find((e) => e.section === 'profile')?.action).toBe('skipped');
    expect(report.entries.find((e) => e.section === 'knowledge')?.action).toBe('skipped');
    const main = getTemplate('main_menu', undefined, salon)!;
    expect(main.liveEn).toBe(liveBefore);
    expect(main.hasDraft).toBe(true);
    expect(main.draftEn).toContain('Services');
    expect(listOffers({ accountId: salon }).every((o) => o.status === 'draft')).toBe(true);
    expect(getMenuConfig(salon).source).toBe('default');
    expect(fs.existsSync(path.join(knowledgeDirForAccount(salon), 'business.md'))).toBe(false);
    expect(getDraft(id, salon)?.status).toBe('draft'); // still open for the real apply
  });

  it('Merge fills what is empty, refreshes untouched generated text, and never overwrites hand-written content', async () => {
    // Hand-written content that must survive
    runWithAccount(salon, () => publishTemplate('menu_contact', { ar: 'تواصل (مكتوب يدوياً)', en: 'Call Noor directly — hand written' }, 'owner'));
    fs.mkdirSync(knowledgeDirForAccount(salon), { recursive: true });
    fs.writeFileSync(path.join(knowledgeDirForAccount(salon), 'faq.md'), '# FAQ\n\nHand-written: we do not do tattoos.\n');
    updateBusinessSettings({ addressEn: 'Hand-written address' }, salon);

    const id = await freshDraft(salon);
    const report = applyDraft(salon, id, { mode: 'merge', actor: 'tester' });

    // profile: only empty fields were filled
    expect(getBusinessSettings(salon).addressEn).toBe('Hand-written address');
    expect(report.entries.find((e) => e.section === 'profile' && e.action === 'kept')?.detail).toContain('addressEn');
    // menu: generated from the category + content and saved
    const stored = getMenuConfig(salon);
    expect(stored.source).toBe('generated');
    const ids = stored.config.items.map((i) => i.id);
    expect(ids.slice(0, 6)).toEqual(['services', 'prices', 'offers', 'book', 'location', 'contact']);
    expect(ids.at(-1)).toBe('staff');
    // templates: main menu + pages now match the saved menu, customised page kept (generated text only as a draft)
    const main = getTemplate('main_menu', undefined, salon)!;
    expect(main.liveEn).toContain('1️⃣ Services');
    expect(main.liveEn).toContain('{business}');
    expect(getTemplate('menu_services', undefined, salon)!.liveEn).toContain('Haircut — 50 SAR');
    const contact = getTemplate('menu_contact', undefined, salon)!;
    expect(contact.liveEn).toBe('Call Noor directly — hand written');
    // offers: created as drafts, never published automatically
    const offers = listOffers({ accountId: salon });
    expect(offers.map((o) => o.title_en)).toContain('Weekend special');
    expect(offers.every((o) => o.status === 'draft')).toBe(true);
    expect(offers.find((o) => o.title_en === 'Weekend special')?.price_status).toBe('on_request');
    // knowledge: generated blocks written; the hand-written file keeps its text
    const dir = knowledgeDirForAccount(salon);
    expect(fs.readFileSync(path.join(dir, 'services.md'), 'utf8')).toContain('- Haircut — price: 50 SAR');
    expect(fs.readFileSync(path.join(dir, 'services.md'), 'utf8')).toContain('<!-- setup:begin v1');
    const faq = fs.readFileSync(path.join(dir, 'faq.md'), 'utf8');
    expect(faq).toContain('Hand-written: we do not do tattoos.');
    expect(faq).toContain('Do you take walk-ins?');
    expect(getDraft(id, salon)?.status).toBe('applied');
    expect(() => applyDraft(salon, id, { mode: 'merge', actor: 'tester' })).toThrow(DraftStateError);

    // The router and the live reply now follow the generated menu
    const customer = runWithAccount(salon, () => getOrCreateCustomer('966500000555', 'Layla'));
    const withLanguage = { ...customer, language: 'en' as const, menu_state: 'MAIN_MENU' };
    const route = runWithAccount(salon, () => routeMenu({ text: '2', customer: withLanguage }));
    expect(route?.send).toEqual(['menu_prices']);
    expect(runWithAccount(salon, () => resolveTemplate('menu_prices', 'en'))).toContain('Manicure — 80 SAR');
    expect(runWithAccount(salon, () => getMenuTables(salon)).main['4']).toEqual({ flow: 'appointment' });
  });

  it('a second merge refreshes the generated block but keeps a block someone edited by hand', async () => {
    const dir = knowledgeDirForAccount(salon);
    const servicesFile = path.join(dir, 'services.md');
    const original = fs.readFileSync(servicesFile, 'utf8');
    fs.writeFileSync(servicesFile, original.replace('- Haircut — price: 50 SAR', '- Haircut — price: 55 SAR (updated by the owner)'));
    const id = await freshDraft(salon);
    // a page the owner customised after the first merge keeps its live text; the generated text waits as an unpublished draft
    runWithAccount(salon, () => publishTemplate('menu_services', { ar: 'خدماتنا (يدوي)', en: 'Our services — hand written' }, 'owner'));
    const report = applyDraft(salon, id, { mode: 'merge', actor: 'tester', sections: ['knowledge', 'templates'] });
    const services = getTemplate('menu_services', undefined, salon)!;
    expect(services.liveEn).toBe('Our services — hand written');
    expect(services.hasDraft).toBe(true);
    expect(services.draftEn).toContain('Haircut — 50 SAR');
    expect(report.entries.find((e) => e.section === 'templates' && e.action === 'kept')?.detail).toMatch(/customised/);
    expect(fs.readFileSync(servicesFile, 'utf8')).toContain('55 SAR (updated by the owner)');
    expect(report.entries.some((e) => e.section === 'knowledge' && e.action === 'kept' && e.detail.includes('services.md'))).toBe(true);
    // untouched block (business.md) is simply refreshed
    expect(report.entries.some((e) => e.section === 'knowledge' && e.action === 'applied' && e.detail.includes('business.md'))).toBe(true);
  });

  it('Replace needs the explicit word REPLACE, then overwrites (with a backup of the knowledge file)', async () => {
    const id = await freshDraft(salon);
    expect(() => applyDraft(salon, id, { mode: 'replace', actor: 'tester' })).toThrow(ApplyError);
    expect(() => applyDraft(salon, id, { mode: 'replace', confirm: 'replace', actor: 'tester' })).toThrow(/confirmation/);
    expect(getDraft(id, salon)?.status).toBe('draft');

    const dir = knowledgeDirForAccount(salon);
    fs.writeFileSync(path.join(dir, 'policies.md'), 'Old hand-written policy.\n');
    updateBusinessSettings({ descriptionEn: 'Old description to be replaced' }, salon);
    const report = applyDraft(salon, id, { mode: 'replace', confirm: 'REPLACE', actor: 'tester' });
    expect(getBusinessSettings(salon).descriptionEn).toContain('neighbourhood salon');
    expect(fs.readFileSync(path.join(dir, 'policies.md'), 'utf8')).not.toContain('Old hand-written policy');
    expect(report.backups.some((b) => b.startsWith('policies.md →'))).toBe(true);
    expect(fs.readdirSync(path.join(dir, '.backups')).some((f) => f.startsWith('policies.md.'))).toBe(true);
    expect(report.entries.find((e) => e.section === 'menu')?.action).toBe('applied');
  });

  it('applying to one account never touches another account', async () => {
    const paintBefore = { templates: listTemplates(undefined, paint).map((t) => `${t.key}:${t.liveEn}`), settings: getBusinessSettings(paint), offers: listOffers({ accountId: paint }).length, menu: getMenuConfig(paint).source };
    const original = { settings: getBusinessSettings(1), templates: listTemplates(undefined, 1).map((t) => `${t.key}:${t.liveEn}`), offers: listOffers({ accountId: 1 }).length };
    const id = await freshDraft(salon);
    applyDraft(salon, id, { mode: 'merge', actor: 'tester' });
    expect(listTemplates(undefined, paint).map((t) => `${t.key}:${t.liveEn}`)).toEqual(paintBefore.templates);
    expect(getBusinessSettings(paint)).toEqual(paintBefore.settings);
    expect(listOffers({ accountId: paint }).length).toBe(paintBefore.offers);
    expect(getMenuConfig(paint).source).toBe(paintBefore.menu);
    expect(getBusinessSettings(1)).toEqual(original.settings);
    expect(listTemplates(undefined, 1).map((t) => `${t.key}:${t.liveEn}`)).toEqual(original.templates);
    expect(listOffers({ accountId: 1 }).length).toBe(original.offers);
  });

  it('the original business can still be given profile/knowledge/offers, but keeps its built-in menu and wording', async () => {
    const id = await freshDraft(1);
    const draft = getDraft(id, 1)!;
    expect(draft.content.autoReplies).toEqual([]);
    const report = applyDraft(1, id, { mode: 'save_draft', actor: 'tester' });
    expect(report.entries.find((e) => e.section === 'templates')?.action).toBe('skipped');
    expect(report.entries.find((e) => e.section === 'menu')?.action).toBe('skipped');
    expect(getMenuConfig(1).source).toBe('default');
    expect(getMenuTables(1).builtIn).toBe(true);
  });
});

describe('what a business tells the AI', () => {
  it('names only its own facts: no other business\'s phone, hours, maps link or calendar rules', () => {
    const prompt = runWithAccount(auto, () => buildSystemPrompt({ sections: [], asPromptText: '' }, 'en'));
    expect(prompt).toContain('assistant for Speedy Auto');
    expect(prompt).not.toContain('Rowad');
    expect(prompt).not.toContain('maps.app.goo.gl/8sxNK9wMNsTucvCh7'); // the original business's confirmed map link
    expect(prompt).toMatch(/Opening hours: Not provided/);
    expect(prompt).toMatch(/Google Maps: Not provided/);
    expect(prompt).not.toContain('check_availability');
    expect(prompt).toMatch(/cannot check availability or book appointments/);
    const original = buildSystemPrompt({ sections: [], asPromptText: '' }, 'en');
    expect(original).toContain('check_availability');
    expect(original).toContain('maps.app.goo.gl/8sxNK9wMNsTucvCh7');
    const noor = runWithAccount(salon, () => buildSystemPrompt({ sections: [], asPromptText: '' }, 'en'));
    expect(noor).toContain('+966 50 000 1111');
    expect(noor).toContain('https://noor.example/');
    expect(noor).not.toContain('Speedy');
  });
});

describe('draft content validation', () => {
  it('round-trips through the schema and rejects malformed data', () => {
    const draft = emptyDraft();
    draft.menu = { version: 1, items: [{ id: 'about', kind: 'info', labelEn: 'About', labelAr: 'من نحن' }] };
    expect(parseDraftContent(JSON.parse(JSON.stringify(draft))).menu.items).toHaveLength(1);
    expect(() => parseDraftContent({ ...draft, version: 2 })).toThrow(DraftValidationError);
    expect(() => parseDraftContent({ ...draft, autoReplies: [{ key: 'Bad Key!', titleEn: 'x', titleAr: 'x', en: 'x', ar: 'x', include: true }] })).toThrow(DraftValidationError);
    expect(listLinks(salon).length).toBeGreaterThan(0);
  });
});
