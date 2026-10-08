import { describe, it, expect } from 'vitest';
import { detectLanguageFromScript, isSubstantiveFreeText } from '../../../src/automation/menu';

describe('detectLanguageFromScript', () => {
  it('reads the language from the script', () => {
    expect(detectLanguageFromScript('Do you have exterior paint?')).toBe('en');
    expect(detectLanguageFromScript('هل عندكم دهان خارجي؟')).toBe('ar');
    expect(detectLanguageFromScript('أريد Jotun Lady')).toBe('ar');
    expect(detectLanguageFromScript('Do you have Jotun Lady Pure Color in Arabic دهان please and thanks')).toBe('en');
  });
  it('is unknown when there is no letter to judge by', () => {
    expect(detectLanguageFromScript('12345')).toBeUndefined();
    expect(detectLanguageFromScript('👍')).toBeUndefined();
    expect(detectLanguageFromScript('')).toBeUndefined();
    expect(detectLanguageFromScript(undefined)).toBeUndefined();
  });
});

describe('isSubstantiveFreeText — a real question on a first message deserves an answer', () => {
  it.each([
    'Do you have exterior wall paint?',
    'I need paint for my bedroom',
    'I need a quotation for painting.',
    'Where are you located?',
    'What colours do you have?',
    'هل عندكم دهان خارجي؟',
    'أحتاج دهان لغرفة النوم',
    'كم السعر؟',
  ])('"%s" is a real message', (text) => {
    expect(isSubstantiveFreeText(text)).toBe(true);
  });

  it.each([
    'hi', 'hello', 'Hello!', 'مرحبا', 'السلام عليكم', 'menu', '0', '1', '12', '٢', '2.', 'english', 'العربية', 'language',
    'human', 'agent', 'random text', 'still nothing', 'ok', '', '   ',
  ])('"%s" is not: it keeps the welcome or its own meaning', (text) => {
    expect(isSubstantiveFreeText(text)).toBe(false);
  });

  it('never treats a request for a person or a restart as a question to the AI', () => {
    expect(isSubstantiveFreeText('talk to human')).toBe(false);
    expect(isSubstantiveFreeText('customer service')).toBe(false);
    expect(isSubstantiveFreeText(undefined)).toBe(false);
  });
});
