import { describe, expect, it } from 'vitest';
import { MoneyError, formatMoney, formatQuantity, lineTotalMinor, parseCurrency, parseMoney, parseQuantityMilli, parseTaxRateBp, taxMinor } from '../../../src/quotations/money';
import { QUOTATION_ONLY_STATUSES, canTransition, nextStatuses, statusAllowedForKind } from '../../../src/requests/quotationLifecycle';

describe('money is integer minor units, never floating point', () => {
  it('parses decimals, thousands separators and Arabic digits exactly', () => {
    expect(parseMoney('150')).toBe(15000);
    expect(parseMoney('150.5')).toBe(15050);
    expect(parseMoney('1,250.75')).toBe(125075);
    expect(parseMoney('١٢٥٠٫٧٥')).toBe(125075);
    expect(parseMoney('0.30')).toBe(30);
    expect(parseMoney(19.99)).toBe(1999);
    expect(parseMoney('')).toBeNull();
    expect(parseMoney(null)).toBeNull();
  });

  it('refuses what it cannot store exactly instead of rounding or guessing', () => {
    for (const bad of ['-5', '12.345', 'abc', '1e3', '12,5', '99999999999999']) expect(() => parseMoney(bad), bad).toThrow(MoneyError);
    expect(() => parseMoney(Number.NaN)).toThrow(MoneyError);
  });

  it('computes line totals, tax and totals with exact integer arithmetic (half up)', () => {
    expect(lineTotalMinor(parseQuantityMilli('2')!, parseMoney('150.50')!)).toBe(30100);
    expect(lineTotalMinor(parseQuantityMilli('1.5')!, parseMoney('0.99')!)).toBe(149); // 1.485 → 1.49
    expect(lineTotalMinor(parseQuantityMilli('3')!, parseMoney('0.10')!)).toBe(30); // no 0.30000000000000004
    expect(taxMinor(40000, parseTaxRateBp('15')!)).toBe(6000);
    expect(taxMinor(1999, parseTaxRateBp('5.5')!)).toBe(110); // 109.945 → 110
    expect(parseTaxRateBp('15%')).toBe(1500);
    expect(() => parseTaxRateBp('150')).toThrow(MoneyError);
  });

  it('quantities: positive, up to 3 decimals', () => {
    expect(parseQuantityMilli('٢')).toBe(2000);
    expect(parseQuantityMilli('2.125')).toBe(2125);
    for (const bad of ['0', '-1', '1.2345', 'two']) expect(() => parseQuantityMilli(bad), bad).toThrow(MoneyError);
    expect(formatQuantity(1500)).toBe('1.5');
    expect(formatQuantity(2000)).toBe('2');
  });

  it('formats for display and validates currency codes', () => {
    expect(formatMoney(125075, 'SAR')).toBe('1,250.75 SAR');
    expect(formatMoney(5)).toBe('0.05');
    expect(parseCurrency(' sar ')).toBe('SAR');
    expect(parseCurrency('')).toBeNull();
    expect(() => parseCurrency('SA')).toThrow(MoneyError);
  });
});

describe('quotation status rules', () => {
  it('approval is not delivery: approved → sent is the only road to sent, and nothing jumps straight there', () => {
    expect(canTransition('quotation', 'pending', 'sent')).toBe(false);
    expect(canTransition('quotation', 'preparing', 'sent')).toBe(false);
    expect(canTransition('quotation', 'approved', 'sent')).toBe(true);
    expect(canTransition('quotation', 'sent', 'approved')).toBe(false);
  });

  it('finished quotations stay finished; a sent one can be revised or closed out', () => {
    for (const end of ['rejected', 'cancelled', 'closed']) for (const next of ['pending', 'approved', 'sent', 'preparing']) expect(canTransition('quotation', end as never, next as never), `${end}→${next}`).toBe(false);
    expect(canTransition('quotation', 'sent', 'preparing')).toBe(true);
    expect(canTransition('quotation', 'sent', 'completed')).toBe(true);
    expect(canTransition('quotation', 'sent', 'expired')).toBe(true);
  });

  it('quotations from before the lifecycle (confirmed) can still move on', () => {
    expect(canTransition('quotation', 'confirmed', 'sent')).toBe(true);
    expect(canTransition('quotation', 'confirmed', 'completed')).toBe(true);
  });

  it('appointments keep their old freedom but never get quotation-only statuses', () => {
    expect(canTransition('appointment', 'rejected', 'pending')).toBe(true);
    for (const s of QUOTATION_ONLY_STATUSES) {
      expect(statusAllowedForKind('appointment', s)).toBe(false);
      expect(canTransition('appointment', 'pending', s)).toBe(false);
    }
  });

  it('what the dashboard offers never includes Sent (it is a delivery outcome)', () => {
    expect(nextStatuses('quotation', 'approved')).not.toContain('sent');
    expect(nextStatuses('quotation', 'pending')).toContain('approved');
  });
});
