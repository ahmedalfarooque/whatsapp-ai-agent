import type Database from 'better-sqlite3';
import { getDb } from '../memory/db';
import { currentAccountId } from '../accounts/accountContext';

/**
 * Offers & discounts — one resolver for the dashboard, the WhatsApp runtime,
 * the Manual Reply Editor preview and the AI context. Customers (and the AI)
 * only ever see offers returned by listCustomerVisibleOffers().
 * Every offer belongs to one WhatsApp account (business); lookups by id are
 * scoped too, so one business can never read or edit another's offers.
 */

export type OfferStatus = 'draft' | 'published' | 'finished' | 'archived';
export type OfferPriceStatus = 'verified' | 'on_request' | 'contact';
export type OfferVisibility = 'customer' | 'internal';
/** Effective status: stored status refined by the validity window. */
export type OfferEffectiveStatus = OfferStatus | 'scheduled' | 'expired';

export interface Offer {
  id: number;
  title_ar: string;
  title_en: string;
  description_ar: string;
  description_en: string;
  category: string | null;
  related_item: string | null;
  price_status: OfferPriceStatus;
  original_price: number | null;
  promotional_price: number | null;
  discount_percent: number | null;
  currency: string;
  starts_at: string | null;
  ends_at: string | null;
  image_document_id: number | null;
  document_id: number | null;
  terms_ar: string | null;
  terms_en: string | null;
  visibility: OfferVisibility;
  status: OfferStatus;
  priority: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface OfferView extends Offer {
  effectiveStatus: OfferEffectiveStatus;
  customerVisibleNow: boolean;
}

export class OfferValidationError extends Error {
  status = 400;
  fields: Record<string, string>;
  constructor(fields: Record<string, string>) {
    super('Offer validation failed');
    this.fields = fields;
  }
}

const STATUSES: OfferStatus[] = ['draft', 'published', 'finished', 'archived'];
const PRICE_STATUSES: OfferPriceStatus[] = ['verified', 'on_request', 'contact'];

function str(v: unknown, max: number): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') return null;
  const t = v.replace(/\r\n/g, '\n').trim();
  return t ? t.slice(0, max) : null;
}
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
}
function isoDate(v: unknown): string | null | 'invalid' {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) return 'invalid';
  return new Date(v).toISOString();
}

export interface OfferInput {
  titleAr: string;
  titleEn: string;
  descriptionAr?: string | null;
  descriptionEn?: string | null;
  category?: string | null;
  relatedItem?: string | null;
  priceStatus?: OfferPriceStatus;
  originalPrice?: number | null;
  promotionalPrice?: number | null;
  discountPercent?: number | null;
  currency?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  imageDocumentId?: number | null;
  documentId?: number | null;
  termsAr?: string | null;
  termsEn?: string | null;
  visibility?: OfferVisibility;
  priority?: number | null;
}

/** Validates and normalises; numeric prices are only kept when priceStatus is 'verified' (zero-fabricated-pricing). */
export function validateOfferInput(raw: unknown): Required<Omit<OfferInput, 'priceStatus' | 'visibility'>> & { priceStatus: OfferPriceStatus; visibility: OfferVisibility } {
  const input = (raw ?? {}) as Record<string, unknown>;
  const fields: Record<string, string> = {};
  const titleAr = str(input.titleAr, 200);
  const titleEn = str(input.titleEn, 200);
  if (!titleAr) fields.titleAr = 'Arabic title is required';
  if (!titleEn) fields.titleEn = 'English title is required';
  const priceStatus = PRICE_STATUSES.includes(input.priceStatus as OfferPriceStatus) ? (input.priceStatus as OfferPriceStatus) : 'on_request';
  const visibility: OfferVisibility = input.visibility === 'internal' ? 'internal' : 'customer';
  let originalPrice = num(input.originalPrice);
  let promotionalPrice = num(input.promotionalPrice);
  let discountPercent = num(input.discountPercent);
  for (const [k, v] of Object.entries({ originalPrice, promotionalPrice, discountPercent })) if (Number.isNaN(v)) fields[k] = 'must be a number';
  if (priceStatus !== 'verified') {
    // Unverified pricing is never stored as a number.
    originalPrice = null; promotionalPrice = null; discountPercent = null;
  } else {
    if (originalPrice !== null && originalPrice! < 0) fields.originalPrice = 'must be ≥ 0';
    if (promotionalPrice !== null && promotionalPrice! < 0) fields.promotionalPrice = 'must be ≥ 0';
    if (discountPercent !== null && (discountPercent! < 0 || discountPercent! > 100)) fields.discountPercent = 'must be 0–100';
    if (originalPrice === null && promotionalPrice === null && discountPercent === null) fields.priceStatus = 'verified pricing needs at least one price value';
  }
  const startsAt = isoDate(input.startsAt);
  const endsAt = isoDate(input.endsAt);
  if (startsAt === 'invalid') fields.startsAt = 'invalid date';
  if (endsAt === 'invalid') fields.endsAt = 'invalid date';
  if (startsAt && endsAt && startsAt !== 'invalid' && endsAt !== 'invalid' && startsAt > endsAt) fields.endsAt = 'end must be after start';
  const priority = num(input.priority);
  if (Number.isNaN(priority)) fields.priority = 'must be a number';
  const imageDocumentId = num(input.imageDocumentId);
  const documentId = num(input.documentId);
  if (Object.keys(fields).length) throw new OfferValidationError(fields);
  return {
    titleAr: titleAr!,
    titleEn: titleEn!,
    descriptionAr: str(input.descriptionAr, 3000) ?? '',
    descriptionEn: str(input.descriptionEn, 3000) ?? '',
    category: str(input.category, 100),
    relatedItem: str(input.relatedItem, 200),
    priceStatus,
    originalPrice,
    promotionalPrice,
    discountPercent,
    currency: str(input.currency, 8) ?? 'SAR',
    startsAt: startsAt as string | null,
    endsAt: endsAt as string | null,
    imageDocumentId: imageDocumentId && imageDocumentId > 0 ? imageDocumentId : null,
    documentId: documentId && documentId > 0 ? documentId : null,
    termsAr: str(input.termsAr, 2000),
    termsEn: str(input.termsEn, 2000),
    visibility,
    priority: priority ?? 0,
  };
}

export function effectiveStatus(offer: Offer, now: Date = new Date()): OfferEffectiveStatus {
  if (offer.status !== 'published') return offer.status;
  const t = now.toISOString();
  if (offer.starts_at && offer.starts_at > t) return 'scheduled';
  if (offer.ends_at && offer.ends_at < t) return 'expired';
  return 'published';
}

export function toView(offer: Offer, now: Date = new Date()): OfferView {
  const eff = effectiveStatus(offer, now);
  return { ...offer, effectiveStatus: eff, customerVisibleNow: eff === 'published' && offer.visibility === 'customer' && !offer.deleted_at };
}

export function createOffer(raw: unknown, actor: string, db: Database.Database = getDb(), accountId: number = currentAccountId()): OfferView {
  const v = validateOfferInput(raw);
  const result = db
    .prepare(
      `INSERT INTO offers (title_ar, title_en, description_ar, description_en, category, related_item, price_status, original_price, promotional_price,
         discount_percent, currency, starts_at, ends_at, image_document_id, document_id, terms_ar, terms_en, visibility, status, priority, created_by, updated_by, whatsapp_account_id)
       VALUES (@titleAr, @titleEn, @descriptionAr, @descriptionEn, @category, @relatedItem, @priceStatus, @originalPrice, @promotionalPrice,
         @discountPercent, @currency, @startsAt, @endsAt, @imageDocumentId, @documentId, @termsAr, @termsEn, @visibility, 'draft', @priority, @actor, @actor, @accountId)`,
    )
    .run({ ...v, actor, accountId });
  return getOffer(Number(result.lastInsertRowid), db, accountId)!;
}

export function updateOffer(id: number, raw: unknown, actor: string, db: Database.Database = getDb(), accountId: number = currentAccountId()): OfferView | undefined {
  if (!getOffer(id, db, accountId)) return undefined;
  const v = validateOfferInput(raw);
  db.prepare(
    `UPDATE offers SET title_ar=@titleAr, title_en=@titleEn, description_ar=@descriptionAr, description_en=@descriptionEn, category=@category,
       related_item=@relatedItem, price_status=@priceStatus, original_price=@originalPrice, promotional_price=@promotionalPrice, discount_percent=@discountPercent,
       currency=@currency, starts_at=@startsAt, ends_at=@endsAt, image_document_id=@imageDocumentId, document_id=@documentId, terms_ar=@termsAr, terms_en=@termsEn,
       visibility=@visibility, priority=@priority, updated_by=@actor, updated_at=datetime('now') WHERE id=@id AND whatsapp_account_id=@accountId AND deleted_at IS NULL`,
  ).run({ ...v, actor, id, accountId });
  return getOffer(id, db, accountId);
}

export function setOfferStatus(id: number, status: OfferStatus, actor: string, db: Database.Database = getDb(), accountId: number = currentAccountId()): OfferView | undefined {
  if (!STATUSES.includes(status)) throw new OfferValidationError({ status: 'invalid status' });
  if (!getOffer(id, db, accountId)) return undefined;
  db.prepare(`UPDATE offers SET status = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ? AND whatsapp_account_id = ? AND deleted_at IS NULL`).run(status, actor, id, accountId);
  return getOffer(id, db, accountId);
}

export function duplicateOffer(id: number, actor: string, db: Database.Database = getDb(), accountId: number = currentAccountId()): OfferView | undefined {
  const o = getOffer(id, db, accountId);
  if (!o) return undefined;
  return createOffer(
    {
      titleAr: `${o.title_ar} (نسخة)`, titleEn: `${o.title_en} (copy)`, descriptionAr: o.description_ar, descriptionEn: o.description_en,
      category: o.category, relatedItem: o.related_item, priceStatus: o.price_status, originalPrice: o.original_price, promotionalPrice: o.promotional_price,
      discountPercent: o.discount_percent, currency: o.currency, startsAt: o.starts_at, endsAt: o.ends_at, imageDocumentId: o.image_document_id,
      documentId: o.document_id, termsAr: o.terms_ar, termsEn: o.terms_en, visibility: o.visibility, priority: o.priority,
    },
    actor,
    db,
    accountId,
  );
}

/** Soft delete — the record and its history stay in the table. */
export function deleteOffer(id: number, actor: string, db: Database.Database = getDb(), accountId: number = currentAccountId()): boolean {
  const r = db.prepare(`UPDATE offers SET deleted_at = datetime('now'), updated_by = ?, updated_at = datetime('now') WHERE id = ? AND whatsapp_account_id = ? AND deleted_at IS NULL`).run(actor, id, accountId);
  return r.changes > 0;
}

export function getOffer(id: number, db: Database.Database = getDb(), accountId: number = currentAccountId()): OfferView | undefined {
  const row = db.prepare('SELECT * FROM offers WHERE id = ? AND whatsapp_account_id = ? AND deleted_at IS NULL').get(id, accountId) as Offer | undefined;
  return row ? toView(row) : undefined;
}

export function listOffers(params: { includeDeleted?: boolean; accountId?: number } = {}, db: Database.Database = getDb()): OfferView[] {
  const rows = db
    .prepare(`SELECT * FROM offers WHERE whatsapp_account_id = ? ${params.includeDeleted ? '' : 'AND deleted_at IS NULL'} ORDER BY priority DESC, updated_at DESC, id DESC`)
    .all(params.accountId ?? currentAccountId()) as Offer[];
  const now = new Date();
  return rows.map((r) => toView(r, now));
}

/** THE customer-facing filter: published, inside the validity window, customer-visible, not finished/archived/deleted. */
export function listCustomerVisibleOffers(now: Date = new Date(), db: Database.Database = getDb(), accountId: number = currentAccountId()): OfferView[] {
  return listOffers({ accountId }, db).map((o) => toView(o, now)).filter((o) => o.customerVisibleNow);
}

export function offerKpis(db: Database.Database = getDb(), accountId: number = currentAccountId()): Record<OfferEffectiveStatus, number> {
  const kpis: Record<OfferEffectiveStatus, number> = { draft: 0, published: 0, scheduled: 0, expired: 0, finished: 0, archived: 0 };
  for (const o of listOffers({ accountId }, db)) kpis[o.effectiveStatus] += 1;
  return kpis;
}

function money(v: number | null, currency: string, lang: 'ar' | 'en'): string {
  if (v === null) return '';
  const n = Number.isInteger(v) ? String(v) : v.toFixed(2);
  return lang === 'ar' ? `${n} ${currency === 'SAR' ? 'ريال' : currency}` : `${currency} ${n}`;
}

function formatDay(iso: string | null, lang: 'ar' | 'en'): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(lang === 'ar' ? 'ar-SA' : 'en-GB', { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Renders one offer as the customer sees it (used by WhatsApp, preview and the AI prompt). */
export function renderOfferLine(o: OfferView, lang: 'ar' | 'en'): string {
  const title = lang === 'ar' ? o.title_ar : o.title_en;
  const desc = lang === 'ar' ? o.description_ar : o.description_en;
  const lines = [`🌟 ${title}`];
  if (desc) lines.push(desc);
  if (o.price_status === 'verified') {
    const promo = money(o.promotional_price, o.currency, lang);
    const orig = money(o.original_price, o.currency, lang);
    if (promo && orig) lines.push(lang === 'ar' ? `💰 السعر المخفض: ${promo} (السعر الأصلي: ${orig})` : `💰 Special rate: ${promo} (original: ${orig})`);
    else if (promo) lines.push(lang === 'ar' ? `💰 السعر: ${promo}` : `💰 Price: ${promo}`);
    else if (o.discount_percent !== null) lines.push(lang === 'ar' ? `💰 خصم ${o.discount_percent}%` : `💰 ${o.discount_percent}% off`);
  } else if (o.price_status === 'contact') {
    lines.push(lang === 'ar' ? '💰 تواصل معنا لمعرفة التفاصيل' : '💰 Contact us for details');
  } else {
    lines.push(lang === 'ar' ? '💰 السعر عند الطلب' : '💰 Price on request');
  }
  if (o.ends_at) lines.push(lang === 'ar' ? `📅 ساري حتى: ${formatDay(o.ends_at, lang)}` : `📅 Valid until: ${formatDay(o.ends_at, lang)}`);
  const terms = lang === 'ar' ? o.terms_ar : o.terms_en;
  if (terms) lines.push(lang === 'ar' ? `ℹ️ الشروط: ${terms}` : `ℹ️ Terms: ${terms}`);
  return lines.join('\n');
}

/** Text for the {offers} placeholder: all currently customer-visible offers, or '' when none. */
export function renderCustomerOffers(lang: 'ar' | 'en', now: Date = new Date(), db: Database.Database = getDb(), accountId: number = currentAccountId()): string {
  return listCustomerVisibleOffers(now, db, accountId).map((o) => renderOfferLine(o, lang)).join('\n\n');
}
