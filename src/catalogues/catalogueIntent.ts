/**
 * Does this short WhatsApp message ask for a catalogue / brochure / colour chart?
 * Deliberately conservative: only short messages (a request, not a long question that merely mentions
 * a catalogue) are taken over by the catalogue list; everything longer goes to the assistant.
 */
const EN = /\b(catalogs?|catalogues?|brochures?|colou?r\s*(?:charts?|cards?|books?|guides?|fan\s*decks?))\b/i;
// كتالوج / كاتالوج / كتلوج / كتالوجات / بروشور / بروشورات / كتيب / دليل الألوان / كروت الألوان
const AR = /(ك[اـ]?تا?ل[وؤ]ج|ك[اـ]?تلوج|بروشور|كتيب|كتيبات|دليل\s+الألوان|دليل\s+الالوان|كروت\s+الألوان|كروت\s+الالوان|كارت\s+الألوان|كارت\s+الالوان)/;
const MAX_WORDS = 8;
const MAX_CHARS = 80;

export function isCatalogueRequest(raw: string): boolean {
  const text = (raw ?? '').trim();
  if (!text || text.length > MAX_CHARS) return false;
  if (text.split(/\s+/).filter(Boolean).length > MAX_WORDS) return false;
  return EN.test(text) || AR.test(text);
}
