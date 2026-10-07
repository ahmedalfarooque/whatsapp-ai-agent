import { MAX_MENU_ITEMS, renderMainMenuText, renderSubmenuText, type MenuConfig, type MenuItem } from '../automation/menuConfig';
import type { DraftContent, DraftItem, DraftTemplate } from './types';
import { normalizeForMatch } from './extractor';

/**
 * Builds the default WhatsApp menu of a business from its category and from
 * what was actually found about it. Nothing here is a fixed menu: the same
 * input facts always give the same menu, and different categories/content give
 * different ones (an auto-care centre gets Services/Products/Book/Quote; a
 * paint store gets Products/Brands/Colours/Price inquiry/Quote; a salon gets
 * Services/Prices/Book — and an item whose content is missing is left out).
 */

export type BusinessProfile = 'salon' | 'clinic' | 'restaurant' | 'paint' | 'auto' | 'retail' | 'generic';

const PROFILE_KEYWORDS: Record<Exclude<BusinessProfile, 'generic'>, RegExp> = {
  salon: /\b(salon|barber|beauty|spa|hair|nails?|makeup|make-up|grooming|lashes|cosmetic)\b|صالون|حلاق|تجميل|سبا|شعر|أظافر|مكياج|عناية\s+بالبشرة/i,
  clinic: /\b(clinic|dental|dentist|medical|doctor|hospital|physio|therapy|pharmacy|health\s*care|optical)\b|عيادة|اسنان|أسنان|طبي|طبيب|مستشفى|صيدلية|علاج/i,
  restaurant: /\b(restaurant|cafe|café|coffee|bakery|catering|kitchen|diner|food|grill|pizza|burger|sweets|juice)\b|مطعم|كافيه|مقهى|قهوة|مخبز|حلويات|مأكولات|وجبات|عصائر/i,
  paint: /\b(paints?|coatings?|jotun|dulux|nippon|sherwin|hardware|decor|wallpaper|primers?|tiles?)\b|دهانات|دهان|جوتن|طلاء|ألوان\s+الجدران|ديكور/i,
  auto: /\b(car|cars|auto|automotive|vehicle|garage|tint(?:ing)?|detailing|tyres?|tires?|ppf|ceramic|workshop|spare\s+parts|car\s+audio|accessories)\b|سيار|مركبات|تظليل|إطارات|كفرات|تلميع|ورشة|صوتيات/i,
  retail: /\b(store|shop|boutique|retail|supermarket|mall|market|trading|electronics|fashion|furniture|toys|gifts|perfume|jewell?ery)\b|متجر|محل|بوتيك|تجارة|إلكترونيات|أزياء|أثاث|هدايا|عطور|مجوهرات/i,
};

const TIE_ORDER: Exclude<BusinessProfile, 'generic'>[] = ['salon', 'clinic', 'restaurant', 'paint', 'auto', 'retail'];

/** The category text (and name) decide the profile; ties go to the more specific profile. */
export function classifyBusiness(category: string | null, nameEn: string | null, nameAr: string | null): BusinessProfile {
  const haystack = [category, nameEn, nameAr].filter(Boolean).join(' ');
  if (!haystack.trim()) return 'generic';
  let best: BusinessProfile = 'generic';
  let bestScore = 0;
  for (const profile of TIE_ORDER) {
    const matches = haystack.match(new RegExp(PROFILE_KEYWORDS[profile].source, 'gi'));
    const score = matches ? matches.length + (category && PROFILE_KEYWORDS[profile].test(category) ? 1 : 0) : 0;
    if (score > bestScore) {
      best = profile;
      bestScore = score;
    }
  }
  return best;
}

export interface MenuFacts {
  profile: BusinessProfile;
  hasServices: boolean;
  hasProducts: boolean;
  hasCategories: boolean;
  hasBrandsOrColours: boolean;
  hasPrices: boolean;
  hasOffers: boolean;
  hasLocation: boolean;
  hasContact: boolean;
  hasFaqs: boolean;
  mentionsAppointments: boolean;
}

const BRAND_WORD = /\b(brand|brands|make|manufacturer)\b|ماركة|ماركات|علامة|علامات/i;
const COLOUR_WORD = /\b(colou?rs?|shades?|tints?)\b|لون|ألوان|درجات/i;
const APPOINTMENT_WORD = /\b(appointments?|booking|book\s+(?:a|an|your)|reservations?|reserve|walk-?in)\b|موعد|حجز|مواعيد/i;

function namesOf(items: DraftItem[]): string {
  return items.map((i) => `${i.nameEn ?? ''} ${i.nameAr ?? ''}`).join(' ');
}

export function menuFactsFrom(content: DraftContent, extra: { profile: BusinessProfile; mentionsAppointments: boolean; existingOffers: boolean }): MenuFacts {
  const included = <T extends { include: boolean }>(list: T[]): T[] => list.filter((i) => i.include);
  const services = included(content.services);
  const products = included(content.products);
  const categories = included(content.categories);
  const categoryText = namesOf(categories);
  return {
    profile: extra.profile,
    hasServices: services.length > 0,
    hasProducts: products.length > 0,
    hasCategories: categories.length > 0,
    hasBrandsOrColours: categories.length > 0 && (BRAND_WORD.test(categoryText) || COLOUR_WORD.test(categoryText)),
    hasPrices: [...services, ...products].some((i) => Boolean(i.price)),
    hasOffers: included(content.offers).length > 0 || extra.existingOffers,
    hasLocation: Boolean(content.location.addressEn || content.location.addressAr || content.location.mapsUrl),
    hasContact: Boolean(content.contact.phone || content.contact.email || content.contact.website),
    hasFaqs: included(content.faqs).length >= 3,
    mentionsAppointments: extra.mentionsAppointments,
  };
}

export function mentionsAppointments(texts: string[]): boolean {
  return texts.some((t) => APPOINTMENT_WORD.test(t));
}

// ---------------------------------------------------------------- the menu

type Wanted = { item: MenuItem; when: (f: MenuFacts) => boolean };

const info = (id: string, labelEn: string, labelAr: string): MenuItem => ({ id, kind: 'info', labelEn, labelAr });

function wantedFor(profile: BusinessProfile): Wanted[] {
  const services: Wanted = { item: info('services', 'Services', 'الخدمات'), when: (f) => f.hasServices || ['auto', 'salon', 'clinic', 'generic'].includes(profile) };
  const products: Wanted = { item: info('products', 'Products', 'المنتجات'), when: (f) => f.hasProducts || (['paint', 'retail'].includes(profile) && !f.hasServices) || (profile === 'auto' && f.hasProducts) };
  const offers: Wanted = { item: { id: 'offers', kind: 'offers', labelEn: 'Offers', labelAr: 'العروض' }, when: (f) => f.hasOffers || ['auto', 'paint', 'salon', 'retail', 'restaurant'].includes(profile) };
  const book = (en: string, ar: string): Wanted => ({ item: { id: 'book', kind: 'appointment', labelEn: en, labelAr: ar }, when: (f) => ['auto', 'salon', 'clinic', 'restaurant'].includes(profile) || f.mentionsAppointments });
  const quote: Wanted = { item: { id: 'quote', kind: 'quotation', labelEn: 'Request a quotation', labelAr: 'طلب عرض سعر' }, when: () => ['auto', 'paint', 'retail', 'generic'].includes(profile) };
  const location: Wanted = { item: { id: 'location', kind: 'location', labelEn: 'Location & opening hours', labelAr: 'الموقع وساعات العمل' }, when: (f) => f.hasLocation };
  const contact: Wanted = { item: info('contact', 'Contact us', 'تواصل معنا'), when: (f) => f.hasContact };
  const staff: Wanted = { item: { id: 'staff', kind: 'handoff', labelEn: 'Talk to our team', labelAr: 'التحدث مع موظف' }, when: () => true };
  const faq: Wanted = { item: info('faq', 'FAQs', 'الأسئلة الشائعة'), when: (f) => f.hasFaqs };
  const about: Wanted = { item: info('about', 'About us', 'من نحن'), when: () => profile === 'generic' };

  switch (profile) {
    case 'auto':
      return [services, products, offers, book('Book an appointment', 'حجز موعد'), quote, location, contact, faq, staff];
    case 'paint':
      return [
        products,
        { item: info('brands', 'Brands', 'العلامات التجارية'), when: (f) => f.hasBrandsOrColours },
        { item: info('colours', 'Colours', 'الألوان'), when: (f) => f.hasBrandsOrColours },
        offers,
        { item: info('priceinquiry', 'Price inquiry', 'الاستفسار عن الأسعار'), when: (f) => f.hasPrices },
        quote, location, contact, faq, staff,
      ];
    case 'salon':
      return [services, { item: info('prices', 'Prices', 'الأسعار'), when: (f) => f.hasPrices }, offers, book('Book an appointment', 'حجز موعد'), location, contact, faq, staff];
    case 'restaurant':
      return [{ item: info('menu', 'Menu', 'قائمة الطعام'), when: (f) => f.hasProducts || f.hasServices }, offers, book('Reserve a table', 'حجز طاولة'), location, contact, faq, staff];
    case 'clinic':
      return [services, book('Book an appointment', 'حجز موعد'), location, contact, faq, staff];
    case 'retail':
      return [products, { item: info('categories', 'Categories', 'الأقسام'), when: (f) => f.hasCategories }, offers, { item: info('priceinquiry', 'Price inquiry', 'الاستفسار عن الأسعار'), when: (f) => f.hasPrices }, quote, location, contact, faq, staff];
    default:
      return [about, services, products, offers, book('Book an appointment', 'حجز موعد'), quote, location, contact, faq, staff];
  }
}

/** The menu for this business: only the entries its category suggests AND whose content exists, max 9, hand-off always last. */
export function buildMenu(facts: MenuFacts): MenuConfig {
  const chosen = wantedFor(facts.profile).filter((w) => w.when(facts)).map((w) => ({ ...w.item }));
  // Never exceed the 9 numbered options; the hand-off to a person is the last thing to be cut.
  while (chosen.length > MAX_MENU_ITEMS) {
    const removable = chosen.map((c, i) => ({ c, i })).reverse().find(({ c }) => !['handoff', 'location'].includes(c.kind));
    if (!removable) break;
    chosen.splice(removable.i, 1);
  }
  if (!chosen.some((c) => c.kind === 'handoff')) chosen.push({ id: 'staff', kind: 'handoff', labelEn: 'Talk to our team', labelAr: 'التحدث مع موظف' });
  return { version: 1, items: chosen.slice(0, MAX_MENU_ITEMS) };
}

// ---------------------------------------------------------------- page text

const FOOTER_EN = '\n\n0️⃣ Main Menu';
const FOOTER_AR = '\n\n0️⃣ القائمة الرئيسية';

function fmtItem(item: DraftItem, language: 'ar' | 'en'): string | null {
  const name = language === 'ar' ? item.nameAr ?? item.nameEn : item.nameEn ?? item.nameAr;
  if (!name) return null;
  const description = language === 'ar' ? item.descriptionAr ?? item.descriptionEn : item.descriptionEn ?? item.descriptionAr;
  const price = item.price ? ` — ${item.price}` : '';
  return `• ${name}${price}${description ? `\n   ${description}` : ''}`;
}

/** A list page, or null when there is nothing real to list (the neutral default page stays in place then). */
function listPage(title: string, items: DraftItem[], language: 'ar' | 'en'): string | null {
  const all = items.filter((i) => i.include).map((i) => fmtItem(i, language)).filter((l): l is string => Boolean(l));
  if (!all.length) return null;
  // A WhatsApp message holds about 4000 characters; a longer list is cut with a pointer to ask for the rest.
  const lines: string[] = [];
  let size = title.length;
  for (const line of all) {
    if (size + line.length > 3300) {
      lines.push(language === 'ar' ? '… اكتب اسم ما تبحث عنه للمزيد من التفاصيل.' : '… ask us about anything not listed here.');
      break;
    }
    lines.push(line);
    size += line.length + 1;
  }
  const footer = language === 'ar' ? FOOTER_AR : FOOTER_EN;
  return `${title}\n\n${lines.join('\n')}${footer}`;
}

/** Plain-language text of one menu page, built only from the (included) draft content. */
export function pageText(id: string, content: DraftContent, item: MenuItem, language: 'ar' | 'en'): string | null {
  const footer = language === 'ar' ? FOOTER_AR : FOOTER_EN;
  const title = language === 'ar' ? item.labelAr : item.labelEn;
  switch (id) {
    case 'services':
      return listPage(title, content.services, language);
    case 'products':
    case 'menu':
      return listPage(title, [...content.products, ...(id === 'menu' ? content.services : [])], language);
    case 'categories':
    case 'brands':
    case 'colours':
      return listPage(title, content.categories, language);
    case 'prices':
    case 'priceinquiry': {
      const priced = [...content.services, ...content.products].filter((i) => i.include && i.price);
      return listPage(title, priced, language);
    }
    case 'about': {
      const text = language === 'ar' ? content.profile.detailedAr ?? content.profile.introAr ?? content.profile.shortAr : content.profile.detailedEn ?? content.profile.introEn ?? content.profile.shortEn;
      return text ? `ℹ️ {business}\n\n${text}${footer}` : null;
    }
    case 'faq': {
      const faqs = content.faqs.filter((f) => f.include);
      const lines = faqs.map((f) => {
        const q = language === 'ar' ? f.questionAr ?? f.questionEn : f.questionEn ?? f.questionAr;
        const a = language === 'ar' ? f.answerAr ?? f.answerEn : f.answerEn ?? f.answerAr;
        return q && a ? `❓ ${q}\n${a}` : null;
      }).filter((l): l is string => Boolean(l));
      return lines.length ? `${title}\n\n${lines.join('\n\n')}${footer}` : null;
    }
    default:
      return null;
  }
}

/** Template drafts that make the generated menu real: the menu itself and each of its pages. */
export function buildMenuTemplates(content: DraftContent): DraftTemplate[] {
  const out: DraftTemplate[] = [];
  const config = content.menu;
  out.push({ key: 'main_menu', titleEn: 'Main Menu', titleAr: 'القائمة الرئيسية', en: renderMainMenuText(config, 'en'), ar: renderMainMenuText(config, 'ar'), include: true });
  for (const item of config.items) {
    if (item.kind === 'submenu') {
      out.push({ key: `menu_${item.id}`, titleEn: item.labelEn, titleAr: item.labelAr, en: renderSubmenuText(item, 'en'), ar: renderSubmenuText(item, 'ar'), include: true });
      continue;
    }
    if (item.kind !== 'info') continue;
    const en = pageText(item.id, content, item, 'en');
    const ar = pageText(item.id, content, item, 'ar');
    // About/contact keep the live placeholders when nothing better is known; a page with no content is not overwritten.
    if (en && ar) out.push({ key: `menu_${item.id}`, titleEn: item.labelEn, titleAr: item.labelAr, en, ar, include: true });
  }
  return out;
}

/** Normalised names for the duplicate checks used when applying. */
export const nameKey = (en: string | null, ar: string | null): string => normalizeForMatch(en ?? ar ?? '');

/**
 * After a person edits a draft (renames a service, drops an item, changes the menu), the reply texts that are
 * DERIVED from that content must follow it. Replies the person rewrote by hand (flagged `edited`, or whose text
 * differs from what was stored before) are never regenerated.
 */
export function refreshDerivedReplies(next: DraftContent, prev?: DraftContent): DraftContent {
  const derived = new Map<string, DraftTemplate>();
  for (const t of buildMenuTemplates(next)) derived.set(t.key, t);
  if (next.outOfHours.en && next.outOfHours.ar) {
    derived.set('out_of_hours', { key: 'out_of_hours', titleEn: 'Out-of-hours Reply', titleAr: 'الرد خارج ساعات العمل', en: next.outOfHours.en, ar: next.outOfHours.ar, include: true });
  }
  const byHand = new Map<string, DraftTemplate>();
  for (const t of next.autoReplies) {
    const old = prev?.autoReplies.find((o) => o.key === t.key);
    if (t.edited === true || (old !== undefined && (old.en !== t.en || old.ar !== t.ar))) byHand.set(t.key, { ...t, edited: true });
  }
  const include = new Map(next.autoReplies.map((t) => [t.key, t.include]));
  const autoReplies: DraftTemplate[] = [];
  for (const [key, t] of derived) autoReplies.push(byHand.get(key) ?? { ...t, include: include.get(key) ?? true });
  for (const [key, t] of byHand) if (!derived.has(key)) autoReplies.push(t);
  return { ...next, autoReplies };
}
