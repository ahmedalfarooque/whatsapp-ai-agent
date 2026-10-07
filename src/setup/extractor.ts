import { normalizeNumerals } from '../whatsapp/jid';
import type { TextSource } from './sources';

/**
 * Offline extraction of business facts from source text, plus the grounding
 * checks that every extracted fact (this extractor's or the AI's) must pass.
 *
 * The extractor only ever returns text that is literally present in a source
 * (each item keeps the line it came from as `evidence`), so it cannot
 * fabricate. It understands the structure people actually write in a price
 * list or catalogue: section headings (Services, Products, Offers, FAQ,
 * Policies, Opening hours…) followed by bullet / table / "name – price" lines.
 */

export interface RawItem {
  nameEn: string | null;
  nameAr: string | null;
  descriptionEn: string | null;
  descriptionAr: string | null;
  price: string | null;
  source: string;
  evidence: string;
}

export interface RawFaq {
  questionEn: string | null;
  questionAr: string | null;
  answerEn: string | null;
  answerAr: string | null;
  source: string;
  evidence: string;
}

export interface RawKnowledge {
  title: string;
  text: string;
  source: string;
}

export interface RawHours {
  text: string;
  source: string;
}

export interface Extracted {
  services: RawItem[];
  products: RawItem[];
  categories: RawItem[];
  offers: RawItem[];
  faqs: RawFaq[];
  knowledge: RawKnowledge[];
  hours: RawHours | null;
  phones: { value: string; source: string; evidence: string }[];
  emails: { value: string; source: string; evidence: string }[];
}

export function emptyExtracted(): Extracted {
  return { services: [], products: [], categories: [], offers: [], faqs: [], knowledge: [], hours: null, phones: [], emails: [] };
}

// ---------------------------------------------------------------- matching / grounding

const DIACRITICS = /[ً-ٰٟـ]/g;

/** Lower-cases, folds Arabic-Indic digits and diacritics, and collapses punctuation/whitespace — for substring checks only. */
export function normalizeForMatch(value: string): string {
  return normalizeNumerals(value)
    .toLowerCase()
    .replace(DIACRITICS, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** True when the quoted evidence really occurs in the source text. Evidence too short to mean anything never counts. */
export function isGrounded(evidence: string | null | undefined, sourceText: string): boolean {
  if (!evidence) return false;
  const e = normalizeForMatch(evidence);
  if (e.length < 5) return false;
  return normalizeForMatch(sourceText).includes(e);
}

/** A price may only be kept when its digits occur in the source (so "50 SAR" cannot become "55 SAR"). */
export function priceGrounded(price: string | null | undefined, sourceText: string): boolean {
  if (!price) return false;
  const digits = normalizeNumerals(price).match(/\d[\d,.]*/g);
  if (!digits || digits.length === 0) return false;
  const haystack = normalizeNumerals(sourceText).replace(/,/g, '');
  return digits.every((d) => haystack.includes(d.replace(/,/g, '')));
}

// ---------------------------------------------------------------- line helpers

const ARABIC = /[؀-ۿ]/;
const CURRENCY = '(?:SAR|SR|AED|USD|EUR|GBP|KWD|QAR|BHD|OMR|EGP|ريال|ر\\.\\s?س\\.?|درهم|دينار|دولار|جنيه|\\$|﷼)';
const NUM = '\\d[\\d,]*(?:\\.\\d+)?';
const PRICE_RE = new RegExp(`(?:${CURRENCY}\\s*${NUM}|${NUM}\\s*${CURRENCY})`, 'i');
const BULLET_RE = /^\s*(?:[-•*·–—▪●◦]|\d{1,3}[.)]|[٠-٩]{1,3}[.)-])\s+/;

function isArabic(text: string): boolean {
  return ARABIC.test(text);
}

function stripMarkup(line: string): string {
  return line.replace(/^#{1,6}\s*/, '').replace(/\*\*|__|`/g, '').trim();
}

type Section = 'services' | 'products' | 'categories' | 'offers' | 'faq' | 'policies' | 'hours' | 'contact' | 'prices' | 'about';

const SECTION_WORDS: [Section, RegExp][] = [
  ['services', /^(?:our\s+)?services?(?:\s+(?:list|offered|we\s+offer))?$|^خدماتنا$|^الخدمات(?:\s+المقدمة)?$|^خدمات$/i],
  ['products', /^(?:our\s+)?products?(?:\s+list)?$|^(?:our\s+)?items?$|^menu$|^منتجاتنا$|^المنتجات$|^منتجات$|^القائمة$|^قائمة\s+الطعام$/i],
  ['categories', /^(?:product\s+|service\s+)?categories$|^brands?$|^our\s+brands$|^colou?rs?$|^الأقسام$|^الفئات$|^التصنيفات$|^العلامات\s+التجارية$|^الماركات$|^الألوان$/i],
  ['offers', /^(?:current\s+|special\s+)?(?:offers?|promotions?|deals?|discounts?)$|^العروض(?:\s+الحالية)?$|^عروضنا$|^الخصومات$/i],
  ['faq', /^(?:faqs?|frequently\s+asked\s+questions)$|^الأسئلة\s+الشائعة$|^أسئلة\s+شائعة$/i],
  ['policies', /^(?:policies|policy|terms(?:\s+(?:and|&)\s+conditions)?|warranty|guarantee|cancellation(?:\s+policy)?|refund(?:\s+policy)?)$|^السياسات$|^الشروط(?:\s+والأحكام)?$|^الضمان$|^سياسة\s+\S+(?:\s+\S+)?$/i],
  ['hours', /^(?:opening\s+hours|working\s+hours|business\s+hours|hours|hours\s+of\s+operation)$|^ساعات\s+العمل$|^أوقات\s+الدوام$|^أوقات\s+العمل$|^الدوام$/i],
  ['contact', /^(?:contact(?:\s+us)?|contact\s+details|get\s+in\s+touch)$|^تواصل\s+معنا$|^اتصل\s+بنا$|^معلومات\s+التواصل$/i],
  ['prices', /^(?:price\s+list|prices|pricing|rates)$|^الأسعار$|^قائمة\s+الأسعار$|^التسعير$/i],
  ['about', /^(?:about(?:\s+us)?|who\s+we\s+are)$|^من\s+نحن$|^نبذة(?:\s+عنا)?$/i],
];

function sectionOf(line: string): Section | null {
  const cleaned = stripMarkup(line).replace(/[:：\-–—_=]+$/g, '').replace(/^[-–—_=\s]+/, '').trim();
  if (!cleaned || cleaned.length > 45) return null;
  for (const [section, re] of SECTION_WORDS) if (re.test(cleaned)) return section;
  return null;
}

function splitNameDescription(body: string): { name: string; description: string | null } {
  for (const sep of [' | ', ' — ', ' – ', ' - ', ': ', ' : ']) {
    const i = body.indexOf(sep);
    if (i > 1 && i < 90) return { name: body.slice(0, i).trim(), description: body.slice(i + sep.length).trim() || null };
  }
  return { name: body.trim(), description: null };
}

function makeItem(line: string, source: string): RawItem | null {
  const body = line.replace(BULLET_RE, '').replace(/\*\*|__|`/g, '').trim();
  if (body.length < 3 || body.length > 400) return null;
  const price = normalizeNumerals(body).match(PRICE_RE)?.[0] ?? null;
  const originalPrice = price ? (body.match(new RegExp(PRICE_RE.source, 'i'))?.[0] ?? price) : null;
  const withoutPrice = originalPrice ? body.replace(originalPrice, ' ').replace(/\s*[-–—:|]\s*$/g, '').replace(/\s{2,}/g, ' ').trim() : body;
  const { name, description } = splitNameDescription(withoutPrice || body);
  if (!name || name.length > 120) return null;
  const arabic = isArabic(name);
  return {
    nameEn: arabic ? null : name,
    nameAr: arabic ? name : null,
    descriptionEn: description && !isArabic(description) ? description : null,
    descriptionAr: description && isArabic(description) ? description : null,
    price: originalPrice,
    source,
    evidence: body,
  };
}

function itemKey(item: RawItem): string {
  return normalizeForMatch(item.nameEn ?? item.nameAr ?? '');
}

// ---------------------------------------------------------------- the extractor

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_LINE_RE = /(?:phone|tel|telephone|call|mobile|whatsapp|هاتف|جوال|واتساب|اتصل|للتواصل|رقم)/i;
const PHONE_RE = /\+?\d[\d\s().-]{7,18}\d/;
const TIME_RE = /\d{1,2}(?::\d{2})?\s*(?:am|pm|AM|PM|ص|م)?\s*(?:-|–|—|to|إلى|الى|حتى)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm|AM|PM|ص|م)?/;
const HOURS_LINE_RE = /(?:open|opening|hours|daily|every\s+day|mon|tue|wed|thu|fri|sat|sun|ساعات|الدوام|يومياً|يوميا|السبت|الأحد|الاثنين|الثلاثاء|الأربعاء|الخميس|الجمعة)/i;

function pushUnique<T>(list: T[], item: T, key: (i: T) => string, seen: Set<string>): void {
  const k = key(item);
  if (!k || seen.has(k)) return;
  seen.add(k);
  list.push(item);
}

export function extractFromText(source: TextSource): Extracted {
  const out = emptyExtracted();
  const seenServices = new Set<string>();
  const seenProducts = new Set<string>();
  const seenCategories = new Set<string>();
  const seenOffers = new Set<string>();
  const seenKnowledge = new Set<string>();
  const hoursLines: string[] = [];

  const lines = normalizeNumerals(source.text.replace(/\r/g, '')).split('\n');
  // Keep the original (non-normalised) lines for display and evidence.
  const originalLines = source.text.replace(/\r/g, '').split('\n');
  let section: Section | null = null;
  let pendingQuestion: { text: string; line: string } | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const original = (originalLines[index] ?? '').trim();
    const line = (lines[index] ?? '').trim();
    if (!line) {
      pendingQuestion = null;
      continue;
    }

    const heading = sectionOf(line);
    if (heading) {
      section = heading;
      pendingQuestion = null;
      continue;
    }

    // Contact details are recognised anywhere.
    const email = EMAIL_RE.exec(original)?.[0];
    if (email) out.emails.push({ value: email, source: source.ref, evidence: original.slice(0, 300) });
    if (PHONE_LINE_RE.test(original)) {
      const phone = PHONE_RE.exec(original)?.[0]?.trim();
      if (phone && phone.replace(/\D/g, '').length >= 8) out.phones.push({ value: phone, source: source.ref, evidence: original.slice(0, 300) });
    }

    // FAQ pairs: "Q: … A: …" on one line, or Q: / A: on consecutive lines, or (inside FAQ) a question line + answer line.
    const qa = /^(?:q(?:uestion)?|السؤال|س)\s*[:：.)-]\s*(.+?)\s+(?:a(?:nswer)?|الجواب|الإجابة|ج)\s*[:：.)-]\s*(.+)$/i.exec(original);
    if (qa) {
      out.faqs.push(faqFrom(qa[1]!, qa[2]!, source.ref, original));
      pendingQuestion = null;
      continue;
    }
    const q = /^(?:q(?:uestion)?|السؤال|س)\s*[:：.)-]\s*(.+)$/i.exec(original);
    if (q) {
      pendingQuestion = { text: q[1]!.trim(), line: original };
      continue;
    }
    const a = /^(?:a(?:nswer)?|الجواب|الإجابة|ج)\s*[:：.)-]\s*(.+)$/i.exec(original);
    if (a && pendingQuestion) {
      out.faqs.push(faqFrom(pendingQuestion.text, a[1]!, source.ref, `${pendingQuestion.line} ${original}`));
      pendingQuestion = null;
      continue;
    }
    if (section === 'faq') {
      const stripped = original.replace(BULLET_RE, '').replace(/\*\*|__/g, '').trim();
      if (/[?؟]$/.test(stripped) && stripped.length >= 8) {
        pendingQuestion = { text: stripped, line: original };
        continue;
      }
      if (pendingQuestion && stripped.length >= 3) {
        out.faqs.push(faqFrom(pendingQuestion.text, stripped, source.ref, `${pendingQuestion.line} ${original}`));
        pendingQuestion = null;
        continue;
      }
    }

    if (section === 'hours' || (HOURS_LINE_RE.test(original) && TIME_RE.test(original) && original.length < 160)) {
      if (original.length < 160 && hoursLines.length < 8) hoursLines.push(original.replace(BULLET_RE, '').trim());
      if (section === 'hours') continue;
    }

    const isBullet = BULLET_RE.test(original) || original.includes(' | ');
    const looksLikePriceLine = PRICE_RE.test(line) && original.length < 200;
    if (!section && !looksLikePriceLine) continue;

    if (section === 'policies' || section === 'about') {
      const text = original.replace(BULLET_RE, '').replace(/\*\*|__/g, '').trim();
      if (text.length >= 12 && text.length <= 600) {
        pushUnique(out.knowledge, { title: text.split(/\s+/).slice(0, 7).join(' '), text, source: source.ref }, (k) => normalizeForMatch(k.text), seenKnowledge);
      }
      continue;
    }
    if (section === 'contact') continue;

    if (!(isBullet || looksLikePriceLine)) continue;
    const item = makeItem(original, source.ref);
    if (!item) continue;
    if (section === 'offers') pushUnique(out.offers, item, itemKey, seenOffers);
    else if (section === 'categories') pushUnique(out.categories, item, itemKey, seenCategories);
    else if (section === 'services') pushUnique(out.services, item, itemKey, seenServices);
    else if (section === 'products' || section === 'prices' || section === null) {
      // A price list with no explicit heading is classified by the document's own purpose when it says so.
      const asService = /service/i.test(source.type ?? '');
      pushUnique(asService ? out.services : out.products, item, itemKey, asService ? seenServices : seenProducts);
    }
  }

  if (hoursLines.length) out.hours = { text: hoursLines.join('\n'), source: source.ref };
  return out;
}

function faqFrom(question: string, answer: string, source: string, evidence: string): RawFaq {
  const q = question.trim();
  const a = answer.trim();
  return {
    questionEn: isArabic(q) ? null : q,
    questionAr: isArabic(q) ? q : null,
    answerEn: isArabic(a) ? null : a,
    answerAr: isArabic(a) ? a : null,
    source,
    evidence: evidence.slice(0, 400),
  };
}

/** Merges per-source extractions, de-duplicating by normalised name / question. */
export function mergeExtracted(parts: Extracted[]): Extracted {
  const out = emptyExtracted();
  const seen = { services: new Set<string>(), products: new Set<string>(), categories: new Set<string>(), offers: new Set<string>(), faqs: new Set<string>(), knowledge: new Set<string>(), phones: new Set<string>(), emails: new Set<string>() };
  for (const part of parts) {
    for (const i of part.services) pushUnique(out.services, i, itemKey, seen.services);
    for (const i of part.products) pushUnique(out.products, i, itemKey, seen.products);
    for (const i of part.categories) pushUnique(out.categories, i, itemKey, seen.categories);
    for (const i of part.offers) pushUnique(out.offers, i, itemKey, seen.offers);
    for (const f of part.faqs) pushUnique(out.faqs, f, (x) => normalizeForMatch(x.questionEn ?? x.questionAr ?? ''), seen.faqs);
    for (const k of part.knowledge) pushUnique(out.knowledge, k, (x) => normalizeForMatch(x.text), seen.knowledge);
    for (const p of part.phones) pushUnique(out.phones, p, (x) => x.value.replace(/\D/g, ''), seen.phones);
    for (const e of part.emails) pushUnique(out.emails, e, (x) => x.value.toLowerCase(), seen.emails);
    if (part.hours && !out.hours) out.hours = part.hours;
  }
  return out;
}
