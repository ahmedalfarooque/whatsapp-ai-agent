import { describe, expect, it } from 'vitest';
import { redactSensitiveText } from '../../../src/realestate/leadFields';

describe('redactSensitiveText: what must never be kept or sent to the AI provider', () => {
  it('removes an IBAN, a payment card number and a national ID, and keeps the rest of the sentence', () => {
    const r = redactSensitiveText('My ID is 1234567890, IBAN SA03 8000 0000 6080 1016 7519 and card 4111 1111 1111 1111, thanks.');
    expect(r.redacted).toBe(true);
    expect(r.text).toBe('My ID is [ID number removed], IBAN [bank number removed] and card [card number removed], thanks.');
  });

  it('recognises Arabic-Indic digits and keeps the surrounding Arabic text', () => {
    const r = redactSensitiveText('رقم هويتي ١٢٣٤٥٦٧٨٩٠ وأريد بيع فيلا');
    expect(r.redacted).toBe(true);
    expect(r.text).toBe('رقم هويتي [ID number removed] وأريد بيع فيلا');
  });

  it('leaves phone numbers, budgets, areas and years alone', () => {
    for (const text of [
      'Call me on 0533339052', 'My number is +966 53 333 9052', 'Budget is 1,200,000 SAR', 'around 1500000 riyals', 'the villa is 450 sqm, built in 2019',
      'I can pay 2,500,000.50 in cash', 'ميزانيتي 1200000 ريال', 'my phone 966533339052',
    ]) {
      expect(redactSensitiveText(text), text).toEqual({ text, redacted: false });
    }
  });

  it('only treats a long digit run as a card when it passes the card checksum', () => {
    expect(redactSensitiveText('ref 1234 5678 9012 3456').redacted).toBe(false); // fails the checksum: a reference, not a card
    expect(redactSensitiveText('card 5555-5555-5555-4444 please').text).toBe('card [card number removed] please');
  });

  it('returns the same text object content when there is nothing to remove', () => {
    expect(redactSensitiveText('I want to buy an apartment in Jeddah')).toEqual({ text: 'I want to buy an apartment in Jeddah', redacted: false });
  });
});
