import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../../src/memory/db';
import {
  createOffer, updateOffer, setOfferStatus, duplicateOffer, deleteOffer, listOffers, listCustomerVisibleOffers,
  offerKpis, renderCustomerOffers, renderOfferLine, OfferValidationError, validateOfferInput,
} from '../../../src/offers/offerRepo';

let db: Database.Database;
beforeEach(() => {
  db = createTestDb();
});

const base = { titleAr: 'عرض التظليل', titleEn: 'Tinting offer', descriptionEn: 'Nano ceramic tint', descriptionAr: 'عازل نانو سيراميك', category: 'Tinting' };
const future = new Date(Date.now() + 86_400_000).toISOString();
const past = new Date(Date.now() - 86_400_000).toISOString();

describe('offers — lifecycle', () => {
  it('creates as draft, publishes, finishes (record preserved), archives, restores; soft delete keeps history', () => {
    const o = createOffer(base, 'admin#1', db);
    expect(o.status).toBe('draft');
    expect(o.effectiveStatus).toBe('draft');
    expect(setOfferStatus(o.id, 'published', 'admin#1', db)?.effectiveStatus).toBe('published');
    expect(listCustomerVisibleOffers(new Date(), db).map((x) => x.id)).toEqual([o.id]);
    expect(setOfferStatus(o.id, 'finished', 'admin#1', db)?.effectiveStatus).toBe('finished');
    expect(listCustomerVisibleOffers(new Date(), db)).toHaveLength(0);
    expect(listOffers({}, db)).toHaveLength(1); // finished record kept
    expect(setOfferStatus(o.id, 'archived', 'admin#1', db)?.status).toBe('archived');
    expect(setOfferStatus(o.id, 'draft', 'admin#1', db)?.status).toBe('draft');
    expect(deleteOffer(o.id, 'admin#1', db)).toBe(true);
    expect(listOffers({}, db)).toHaveLength(0);
    expect(listOffers({ includeDeleted: true }, db)).toHaveLength(1);
    expect(deleteOffer(o.id, 'admin#1', db)).toBe(false);
  });

  it('derives scheduled / expired from the validity window and hides both from customers', () => {
    const scheduled = setOfferStatus(createOffer({ ...base, startsAt: future }, 'a', db).id, 'published', 'a', db)!;
    const expired = setOfferStatus(createOffer({ ...base, endsAt: past }, 'a', db).id, 'published', 'a', db)!;
    const live = setOfferStatus(createOffer({ ...base, startsAt: past, endsAt: future }, 'a', db).id, 'published', 'a', db)!;
    expect(scheduled.effectiveStatus).toBe('scheduled');
    expect(expired.effectiveStatus).toBe('expired');
    expect(live.effectiveStatus).toBe('published');
    expect(listCustomerVisibleOffers(new Date(), db).map((o) => o.id)).toEqual([live.id]);
    const k = offerKpis(db);
    expect(k).toMatchObject({ published: 1, scheduled: 1, expired: 1, draft: 0 });
  });

  it('internal-only offers never reach customers even when published', () => {
    const o = setOfferStatus(createOffer({ ...base, visibility: 'internal' }, 'a', db).id, 'published', 'a', db)!;
    expect(o.customerVisibleNow).toBe(false);
    expect(renderCustomerOffers('en', new Date(), db)).toBe('');
  });

  it('duplicate copies every field as a new draft', () => {
    const o = setOfferStatus(createOffer({ ...base, priceStatus: 'verified', promotionalPrice: 500, termsEn: 'Sedans only' }, 'a', db).id, 'published', 'a', db)!;
    const copy = duplicateOffer(o.id, 'a', db)!;
    expect(copy.id).not.toBe(o.id);
    expect(copy.status).toBe('draft');
    expect(copy.title_en).toBe('Tinting offer (copy)');
    expect(copy.promotional_price).toBe(500);
    expect(copy.terms_en).toBe('Sedans only');
  });
});

describe('offers — zero-fabricated-pricing and rendering', () => {
  it('drops numeric prices unless the price status is verified', () => {
    const v = validateOfferInput({ ...base, priceStatus: 'on_request', originalPrice: 1000, promotionalPrice: 800, discountPercent: 20 });
    expect(v.originalPrice).toBeNull();
    expect(v.promotionalPrice).toBeNull();
    expect(v.discountPercent).toBeNull();
    const o = createOffer({ ...base, priceStatus: 'on_request', promotionalPrice: 800 }, 'a', db);
    expect(renderOfferLine(o, 'en')).toContain('Price on request');
    expect(renderOfferLine(o, 'en')).not.toMatch(/\d{3}/);
    expect(renderOfferLine(o, 'ar')).toContain('السعر عند الطلب');
  });

  it('verified pricing renders promo + original in both languages; validity date included', () => {
    const o = setOfferStatus(createOffer({ ...base, priceStatus: 'verified', originalPrice: 1000, promotionalPrice: 800, endsAt: future }, 'a', db).id, 'published', 'a', db)!;
    const en = renderOfferLine(o, 'en');
    expect(en).toContain('🌟 Tinting offer');
    expect(en).toContain('SAR 800');
    expect(en).toContain('original: SAR 1000');
    expect(en).toContain('Valid until');
    expect(renderOfferLine(o, 'ar')).toContain('800 ريال');
    expect(renderCustomerOffers('en', new Date(), db)).toBe(en);
  });

  it('rejects missing titles, bad dates, reversed windows, and verified pricing without any number', () => {
    expect(() => createOffer({ titleEn: 'x' }, 'a', db)).toThrow(OfferValidationError);
    expect(() => createOffer({ ...base, startsAt: 'not-a-date' }, 'a', db)).toThrow(OfferValidationError);
    expect(() => createOffer({ ...base, startsAt: future, endsAt: past }, 'a', db)).toThrow(OfferValidationError);
    expect(() => createOffer({ ...base, priceStatus: 'verified' }, 'a', db)).toThrow(OfferValidationError);
    try { createOffer({ titleAr: 'x' }, 'a', db); } catch (e) { expect((e as OfferValidationError).fields).toHaveProperty('titleEn'); }
  });

  it('update replaces fields and keeps the id; unknown ids return undefined', () => {
    const o = createOffer(base, 'a', db);
    expect(updateOffer(o.id, { ...base, titleEn: 'Renamed' }, 'b', db)?.title_en).toBe('Renamed');
    expect(updateOffer(9999, base, 'b', db)).toBeUndefined();
    expect(() => setOfferStatus(o.id, 'bogus' as never, 'a', db)).toThrow(OfferValidationError);
  });
});
