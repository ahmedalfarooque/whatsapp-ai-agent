import { withLanguageOption } from '../../../src/templates/languageOption';
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../../src/memory/db';
import {
  listTemplates,
  getTemplate,
  saveTemplateDraft,
  publishTemplate,
  discardTemplateDraft,
  resetTemplateToDefault,
  resolveTemplate,
  renderTemplateText,
  ensureTemplateDefaults,
  PREVIEW_VARS,
  templateSourceType,
  TemplateValidationError,
} from '../../../src/templates/templateRepo';
import { TEMPLATE_DEFAULTS, GOOGLE_MAPS_LINK } from '../../../src/templates/defaults';

let db: Database.Database;
beforeEach(() => {
  db = createTestDb();
});

describe('reply templates — default / draft / live separation', () => {
  it('seeds every shipped template as published with live == default', () => {
    const all = listTemplates(db);
    expect(all.map((t) => t.key)).toEqual(TEMPLATE_DEFAULTS.map((t) => t.key));
    for (const t of all) {
      expect(t.status).toBe('published');
      expect(t.liveAr).toBe(t.defaultAr);
      expect(t.liveEn).toBe(t.defaultEn);
      expect(t.hasDraft).toBe(false);
      expect(t.isModified).toBe(false);
    }
  });

  it('a saved draft is never returned by the live resolver', () => {
    saveTemplateDraft('main_menu', { ar: 'مسودة', en: 'DRAFT ONLY' }, 'tester', db);
    const t = getTemplate('main_menu', db)!;
    expect(t.status).toBe('draft');
    expect(t.hasDraft).toBe(true);
    expect(t.draftEn).toBe('DRAFT ONLY');
    expect(resolveTemplate('main_menu', 'en', {}, db)).toBe(withLanguageOption(t.defaultEn, 'en'));
    expect(resolveTemplate('main_menu', 'ar', {}, db)).toBe(withLanguageOption(t.defaultAr, 'ar'));
  });

  it('publishing promotes the draft to live, clears the draft, and keeps the default intact', () => {
    saveTemplateDraft('main_menu', { ar: 'القائمة الجديدة', en: 'New menu' }, 'tester', db);
    const published = publishTemplate('main_menu', undefined, 'tester', db);
    expect(published.status).toBe('published');
    expect(published.liveEn).toBe('New menu');
    expect(published.draftEn).toBeNull();
    expect(published.defaultEn).toBe(TEMPLATE_DEFAULTS.find((t) => t.key === 'main_menu')!.en);
    expect(published.isModified).toBe(true);
    expect(resolveTemplate('main_menu', 'en', {}, db)).toBe(withLanguageOption('New menu', 'en'));
    expect(resolveTemplate('main_menu', 'ar', {}, db)).toBe(withLanguageOption('القائمة الجديدة', 'ar'));
  });

  it('discarding a draft leaves live content untouched', () => {
    publishTemplate('car_care', { ar: 'مباشر', en: 'LIVE' }, 'tester', db);
    saveTemplateDraft('car_care', { ar: 'مسودة', en: 'DRAFT' }, 'tester', db);
    const t = discardTemplateDraft('car_care', db);
    expect(t.hasDraft).toBe(false);
    expect(t.liveEn).toBe('LIVE');
  });

  it('reset restores the shipped default as live and drops any draft', () => {
    publishTemplate('about', { ar: 'x', en: 'y' }, 'tester', db);
    saveTemplateDraft('about', { ar: 'd', en: 'd' }, 'tester', db);
    const t = resetTemplateToDefault('about', 'tester', db);
    expect(t.liveEn).toBe(t.defaultEn);
    expect(t.liveAr).toBe(t.defaultAr);
    expect(t.hasDraft).toBe(false);
    expect(t.isModified).toBe(false);
  });

  it('rejects empty content for drafts and publishes', () => {
    expect(() => saveTemplateDraft('welcome', { ar: '   ', en: 'ok' }, 'tester', db)).toThrow(TemplateValidationError);
    expect(() => publishTemplate('welcome', { ar: 'ok', en: '' }, 'tester', db)).toThrow(TemplateValidationError);
    expect(() => saveTemplateDraft('nope', { ar: 'a', en: 'b' }, 'tester', db)).toThrow(TemplateValidationError);
  });

  it('renders placeholders and tidies an empty customer name', () => {
    expect(renderTemplateText('Hello {name}, welcome to {business}! {maps}', { name: 'Ahmed', business: 'Rowad Alfa Auto Care' }))
      .toBe(`Hello Ahmed, welcome to Rowad Alfa Auto Care! ${GOOGLE_MAPS_LINK}`);
    expect(renderTemplateText('Hello {name}, welcome to {business}!', { name: '', business: 'Rowad' })).toBe('Hello, welcome to Rowad!');
    expect(renderTemplateText('أهلاً {name} في {business}', { name: null, business: 'رواد' })).toBe('أهلاً في رواد');
  });

  it('upgrading shipped defaults moves live text only when it was never customised, and retires unmodified legacy rows', () => {
    // Simulate an older install: stale default text still live, plus a customised row and a retired key.
    ensureTemplateDefaults(db);
    db.prepare(`UPDATE reply_templates SET default_en = 'OLD DEFAULT', live_en = 'OLD DEFAULT' WHERE key = 'main_menu'`).run();
    db.prepare(`UPDATE reply_templates SET default_en = 'OLD DEFAULT', live_en = 'MY CUSTOM MENU' WHERE key = 'car_audio'`).run();
    db.prepare(
      `INSERT INTO reply_templates (key, category, title_ar, title_en, default_ar, default_en, live_ar, live_en, status, sort_order)
       VALUES ('welcome', 'Greeting', 'ترحيب', 'Welcome', 'a', 'w', 'a', 'w', 'published', 99)`,
    ).run();
    db.prepare(
      `INSERT INTO reply_templates (key, category, title_ar, title_en, default_ar, default_en, live_ar, live_en, status, sort_order)
       VALUES ('unknown_custom', 'Legacy', 'x', 'x', 'a', 'w', 'a', 'EDITED', 'published', 99)`,
    ).run();

    ensureTemplateDefaults(db);

    const menu = getTemplate('main_menu', db)!;
    expect(menu.defaultEn).toBe(TEMPLATE_DEFAULTS.find((t) => t.key === 'main_menu')!.en);
    expect(menu.liveEn).toBe(menu.defaultEn); // unmodified → follows the new default
    const audio = getTemplate('car_audio', db)!;
    expect(audio.defaultEn).toBe(TEMPLATE_DEFAULTS.find((t) => t.key === 'car_audio')!.en);
    expect(audio.liveEn).toBe('MY CUSTOM MENU'); // customised → preserved
    expect(audio.isModified).toBe(true);
    expect(getTemplate('welcome', db)).toBeUndefined(); // retired + unmodified → removed
    expect(getTemplate('unknown_custom', db)?.liveEn).toBe('EDITED'); // unknown but edited → kept
  });

  it('dashboard preview renderer produces byte-identical output to the runtime resolver for every template', () => {
    for (const t of listTemplates(db)) {
      expect(renderTemplateText(t.liveEn, { ...PREVIEW_VARS, language: 'en', templateKey: t.key })).toBe(resolveTemplate(t.key, 'en', PREVIEW_VARS, db));
      expect(renderTemplateText(t.liveAr, { ...PREVIEW_VARS, language: 'ar', templateKey: t.key })).toBe(resolveTemplate(t.key, 'ar', PREVIEW_VARS, db));
    }
  });

  it('data-driven placeholders come from the published business settings and the offers resolver', async () => {
    const { updateBusinessSettings } = await import('../../../src/config/businessSettings');
    const { createOffer, setOfferStatus } = await import('../../../src/offers/offerRepo');
    // default confirmed Google Maps link
    expect(renderTemplateText('{maps}')).toBe('https://maps.app.goo.gl/8sxNK9wMNsTucvCh7');
    expect(templateSourceType('{maps}')).toBe('data-driven');
    expect(templateSourceType('Hello {name}')).toBe('static');
    updateBusinessSettings({ googleMapsUrl: 'https://maps.app.goo.gl/test123', addressEn: 'Bahrah, Jeddah', addressAr: 'بحرة، جدة', businessNameAr: 'رواد ألفا', businessDays: '6,7,1,2,3,4,5', businessHoursStart: '09:00', businessHoursEnd: '22:00', fridayHoursStart: '16:00', fridayHoursEnd: '22:00' });
    expect(renderTemplateText('{maps}')).toBe('https://maps.app.goo.gl/test123');
    expect(renderTemplateText('{address}', { language: 'en' })).toBe('Bahrah, Jeddah');
    expect(renderTemplateText('{address}', { language: 'ar' })).toBe('بحرة، جدة');
    expect(renderTemplateText('{business}', { language: 'ar' })).toBe('رواد ألفا');
    const hoursEn = renderTemplateText('{hours}', { language: 'en' });
    expect(hoursEn).toContain('Saturday to Thursday: 9:00 AM - 10:00 PM');
    expect(hoursEn).toContain('Friday: 4:00 PM - 10:00 PM');
    expect(renderTemplateText('{hours}', { language: 'ar' })).toContain('يوم الجمعة');
    // the live location template is fully rendered — no raw placeholders reach the customer
    const loc = resolveTemplate('location_hours', 'en', {}, db);
    expect(loc).not.toMatch(/\{(maps|hours|address|business)\}/);
    expect(loc).toContain('https://maps.app.goo.gl/test123');
    // offers: empty until something is published and customer-visible
    expect(renderTemplateText('{offers}', { language: 'en' })).toBe('');
    const o = createOffer({ titleAr: 'عرض', titleEn: 'Summer tint offer' }, 'test');
    setOfferStatus(o.id, 'published', 'test');
    expect(renderTemplateText('{offers}', { language: 'en' })).toContain('🌟 Summer tint offer');
    expect(resolveTemplate('prices_offers_list', 'en', {}, db)).toContain('Summer tint offer');
  });

  it('drops only lines whose sole content was an empty placeholder; real "…:" lines survive', () => {
    const out = renderTemplateText('Please select a service:\nLocation: {address}\n🅿️ {notes}\nMaps: {maps}\nHi {name}, bye', { language: 'en', address: '', notes: '', name: '', maps: 'https://maps.app.goo.gl/x' });
    expect(out).toBe('Please select a service:\nMaps: https://maps.app.goo.gl/x\nHi, bye');
  });

  it('shipped defaults contain no fabricated prices', () => {
    for (const t of TEMPLATE_DEFAULTS) {
      expect(`${t.ar} ${t.en}`).not.toMatch(/\b(SAR|ريال)\s*\d|\d+\s*(SAR|ريال)/);
    }
  });
});
