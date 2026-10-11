/**
 * Money and quantities without floating point. Prices are whole MINOR units (halalas, cents, fils: two decimals), quantities are
 * MILLI-units (three decimals). An absent value is NULL — never zero — so a quotation can show exactly what staff supplied and a
 * total only when every price and quantity behind it is known. Anything with more precision than we store is refused, not rounded.
 */

export class MoneyError extends Error {
  status = 400;
}

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const MAX_MINOR = 10_000_000_000n; // 100 million units of currency in minor units: far above any quotation, far below 2^53

function normalizeNumber(input: string): string {
  return input
    .replace(/[٠-٩]/g, (d) => String(ARABIC_DIGITS.indexOf(d)))
    .replace(/٫/g, '.')
    .replace(/٬/g, ',')
    .trim();
}

/** "1,250.75" / "1250.5" / "١٢٥٠٫٧٥" → 125075 / 125050. Empty → null. Negative, non-numeric or more than 2 decimals → MoneyError. */
export function parseMoney(input: string | number | null | undefined, field = 'amount'): number | null {
  if (input === null || input === undefined) return null;
  const raw = typeof input === 'number' ? (Number.isFinite(input) ? String(input) : 'x') : normalizeNumber(input);
  if (raw === '') return null;
  const cleaned = raw.replace(/,(?=\d{3}(\D|$))/g, '');
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!m) throw new MoneyError(`${field} must be a positive number with at most 2 decimals`);
  const minor = BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0') || '0');
  if (minor > MAX_MINOR) throw new MoneyError(`${field} is too large`);
  return Number(minor);
}

/** "2" / "1.5" / "٢" → 2000 / 1500. Empty → null. Zero, negative or more than 3 decimals → MoneyError. */
export function parseQuantityMilli(input: string | number | null | undefined, field = 'quantity'): number | null {
  if (input === null || input === undefined) return null;
  const raw = typeof input === 'number' ? (Number.isFinite(input) ? String(input) : 'x') : normalizeNumber(input);
  if (raw === '') return null;
  const m = /^(\d{1,7})(?:\.(\d{1,3}))?$/.exec(raw);
  if (!m) throw new MoneyError(`${field} must be a positive number with at most 3 decimals`);
  const milli = Number(m[1]) * 1000 + Number((m[2] ?? '').padEnd(3, '0') || '0');
  if (milli <= 0) throw new MoneyError(`${field} must be greater than zero`);
  return milli;
}

/** quantity × unit price, rounded half up to the minor unit, in exact integer arithmetic. */
export function lineTotalMinor(quantityMilli: number, unitPriceMinor: number): number {
  const total = (BigInt(quantityMilli) * BigInt(unitPriceMinor) + 500n) / 1000n;
  if (total > MAX_MINOR * 100n) throw new MoneyError('line total is too large');
  return Number(total);
}

/** A tax rate in percent ("15", "5.5") → basis points (1500, 550). Empty → null. Above 100% or more than 2 decimals → MoneyError. */
export function parseTaxRateBp(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  const raw = typeof input === 'number' ? String(input) : normalizeNumber(input).replace(/%$/, '').trim();
  if (raw === '') return null;
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(raw);
  if (!m) throw new MoneyError('tax rate must be a percentage with at most 2 decimals');
  const bp = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
  if (bp > 10_000) throw new MoneyError('tax rate cannot exceed 100%');
  return bp;
}

export function taxMinor(subtotalMinor: number, rateBp: number): number {
  return Number((BigInt(subtotalMinor) * BigInt(rateBp) + 5000n) / 10_000n);
}

export const CURRENCY_RE = /^[A-Z]{3}$/;

export function parseCurrency(input: string | null | undefined): string | null {
  const v = (input ?? '').trim().toUpperCase();
  if (v === '') return null;
  if (!CURRENCY_RE.test(v)) throw new MoneyError('currency must be a 3-letter code such as SAR');
  return v;
}

/** 125075, "SAR" → "1,250.75 SAR". Without a currency only the number is shown (nothing is assumed). */
export function formatMoney(minor: number, currency?: string | null): string {
  const whole = Math.floor(minor / 100);
  const frac = String(minor % 100).padStart(2, '0');
  const text = `${whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}`;
  return currency ? `${text} ${currency}` : text;
}

/** 1500 → "1.5", 2000 → "2". */
export function formatQuantity(milli: number): string {
  const whole = Math.floor(milli / 1000);
  const frac = String(milli % 1000).padStart(3, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}
