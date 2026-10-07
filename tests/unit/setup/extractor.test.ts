import { describe, expect, it } from 'vitest';
import { extractFromText, isGrounded, mergeExtracted, normalizeForMatch, priceGrounded } from '../../../src/setup/extractor';
import { extractPdfText } from '../../../src/setup/pdfText';
import { makePdf } from '../../fixtures/makePdf';
import type { TextSource } from '../../../src/setup/sources';

function source(text: string, type: string | null = null, ref = 'doc:1'): TextSource {
  return { ref, kind: 'document', label: 'catalogue', type, text };
}

const CATALOGUE = `
About us
We are a neighbourhood salon.

Services
- Haircut — 50 SAR
- Hair colouring: full colour with premium dye — SAR 250
- Manicure | classic nail care | 80 ريال
• قص شعر - ٦٠ ريال

Products
1. Argan oil shampoo - 35 SAR
2) Keratin mask

Offers
- Weekend special: 20% off haircuts

FAQ
What are your payment methods?
We accept cash and cards.
Q: Do you take walk-ins? A: Yes, subject to availability.

Opening hours
Sat - Thu: 10:00 AM - 10:00 PM
Fri: 4:00 PM - 10:00 PM

Policies
- Cancellations are free up to 24 hours before the appointment.

Contact us
Phone: +966 50 123 4567
Email: hello@noor.example
`;

describe('extractFromText — grounded extraction from structured text', () => {
  const result = extractFromText(source(CATALOGUE));

  it('reads services with names, descriptions and exact prices (including Arabic text and Arabic-Indic digits)', () => {
    const names = result.services.map((s) => s.nameEn ?? s.nameAr);
    expect(names).toEqual(['Haircut', 'Hair colouring', 'Manicure', 'قص شعر']);
    const haircut = result.services[0]!;
    expect(haircut.price).toBe('50 SAR');
    expect(haircut.source).toBe('doc:1');
    expect(haircut.evidence).toContain('Haircut');
    expect(result.services[1]!.price).toBe('SAR 250');
    expect(result.services[1]!.descriptionEn).toContain('premium dye');
    expect(result.services[2]!.price).toBe('80 ريال');
    expect(result.services[3]!.nameAr).toBe('قص شعر');
    expect(result.services[3]!.price).toMatch(/60/);
  });

  it('keeps items without a stated price as price = null (never guesses)', () => {
    expect(result.products.map((p) => [p.nameEn, p.price])).toEqual([['Argan oil shampoo', '35 SAR'], ['Keratin mask', null]]);
  });

  it('reads offers, FAQ pairs in both layouts, hours, policies and contact details', () => {
    expect(result.offers[0]!.nameEn).toBe('Weekend special');
    expect(result.faqs.map((f) => f.questionEn)).toEqual(['What are your payment methods?', 'Do you take walk-ins?']);
    expect(result.faqs.find((f) => f.questionEn === 'What are your payment methods?')?.answerEn).toBe('We accept cash and cards.');
    expect(result.hours?.text).toContain('Sat - Thu');
    expect(result.knowledge.map((k) => k.text).some((t) => t.includes('Cancellations are free'))).toBe(true);
    expect(result.phones[0]!.value).toContain('50 123 4567');
    expect(result.emails[0]!.value).toBe('hello@noor.example');
  });

  it('extracts nothing from prose with no structure — it cannot invent items', () => {
    const empty = extractFromText(source('We are a friendly company and we love what we do. Come and visit us any time.'));
    expect(empty.services).toHaveLength(0);
    expect(empty.products).toHaveLength(0);
    expect(empty.faqs).toHaveLength(0);
    expect(empty.hours).toBeNull();
  });

  it('classifies an unheaded price list by the document purpose', () => {
    const list = extractFromText(source('- Deep cleaning — 120 SAR\n- Polishing — 90 SAR', 'service_catalogue'));
    expect(list.services.map((s) => s.nameEn)).toEqual(['Deep cleaning', 'Polishing']);
    const products = extractFromText(source('- Wax — 20 SAR', 'price_list'));
    expect(products.products.map((s) => s.nameEn)).toEqual(['Wax']);
  });

  it('merges several sources without duplicates', () => {
    const merged = mergeExtracted([extractFromText(source('Services\n- Haircut — 50 SAR')), extractFromText(source('Services\n- haircut — 50 SAR\n- Facial — 70 SAR', null, 'link:2'))]);
    expect(merged.services.map((s) => s.nameEn)).toEqual(['Haircut', 'Facial']);
  });
});

describe('grounding checks', () => {
  const text = 'Our haircut costs 50 SAR. قص الشعر ٦٠ ريال. Open daily 9am-5pm.';
  it('accepts evidence that really is in the source, tolerant of case, punctuation and Arabic digits', () => {
    expect(isGrounded('Haircut costs 50 SAR', text)).toBe(true);
    expect(isGrounded('قص الشعر 60 ريال', text)).toBe(true);
  });
  it('rejects evidence that is missing, too short or altered', () => {
    expect(isGrounded('Haircut costs 55 SAR', text)).toBe(false);
    expect(isGrounded('', text)).toBe(false);
    expect(isGrounded('ok', text)).toBe(false);
    expect(isGrounded(null, text)).toBe(false);
  });
  it('only accepts a price whose digits occur in the source', () => {
    expect(priceGrounded('50 SAR', text)).toBe(true);
    expect(priceGrounded('٦٠ ريال', text)).toBe(true);
    expect(priceGrounded('55 SAR', text)).toBe(false);
    expect(priceGrounded('free', text)).toBe(false);
    expect(normalizeForMatch('  Héllo,   WORLD! ')).toBe('héllo world');
  });
});

describe('PDF text extraction', () => {
  it('reads the text layer of a real PDF (also when the upload is a small pooled Buffer)', async () => {
    const pdf = makePdf(['Services', '- Haircut - 50 SAR', '- Manicure - 80 SAR']);
    const result = await extractPdfText(pdf);
    expect(result.ok).toBe(true);
    expect(result.pages).toBe(1);
    expect(result.text).toContain('Haircut - 50 SAR');
    const extracted = extractFromText(source(result.text, 'service_catalogue', 'doc:9'));
    expect(extracted.services.map((s) => s.nameEn)).toEqual(['Haircut', 'Manicure']);
  });

  it('reports a clear reason for a damaged PDF instead of guessing', async () => {
    const result = await extractPdfText(Buffer.from('%PDF-1.4\nthis is not really a pdf'));
    expect(result.ok).toBe(false);
    expect(result.text).toBe('');
    expect(result.error).toMatch(/Could not read this PDF|No readable text/);
  });
});
