import { describe, expect, it } from 'vitest';
import { decideReplyLanguage, detectMessageLanguage, languageName } from '../../../src/llm/language';

// The shared reply-language policy (llm/language.ts): pure, so every business — existing or created later — gets exactly this behaviour.
describe('detectMessageLanguage', () => {
  it('names the script a message is written in, for the languages customers actually use', () => {
    const cases: Array<[string, string]> = [
      ['ഈ കാറിന് ആക്സസറികൾ ഉണ്ടോ?', 'ml'],
      ['هل عندكم تظليل للسيارات؟', 'ar'],
      ['你们有汽车贴膜吗？', 'zh'],
      ['Combien coûte la teinture des vitres ?', 'fr'],
      ['Do you have window tinting?', 'en'],
      ['क्या आपके पास विंडो टिंटिंग है?', 'hi'],
      ['Magkano po ang tint?', 'tl'],
      ['¿Cuánto cuesta el polarizado?', 'es'],
      ['Haben Sie eine Scheibentönung?', 'de'],
      ['Вы делаете тонировку?', 'ru'],
      ['உங்களிடம் டின்டிங் உள்ளதா?', 'ta'],
    ];
    for (const [text, code] of cases) expect(detectMessageLanguage(text)?.code, text).toBe(code);
  });

  it('a mixed message follows its main script: a Malayalam question that names Toyota Camry is Malayalam; an Arabic message with a Latin brand is Arabic', () => {
    expect(detectMessageLanguage('Toyota Camry 2019 ന് ഏതൊക്കെ ആക്സസറികൾ ഉണ്ട്?')?.code).toBe('ml');
    expect(detectMessageLanguage('أريد دهان Jotun Lady للصالة')?.code).toBe('ar');
    expect(detectMessageLanguage('Camry')?.code).toBe('en');
  });

  it('numbers, codes, emoji and empty text show no language (the conversation keeps its language)', () => {
    for (const text of ['', '  ', '2', '👍', '+966 55 123 4567', '12:30']) expect(detectMessageLanguage(text), text).toBeNull();
    // a reference code has Latin letters but is not a sentence: too little to decide, so the conversation keeps its language
    expect(detectMessageLanguage('INQ-2026-8534')?.confidence).toBe('low');
    expect(decideReplyLanguage({ latestText: 'INQ-2026-8534', menuLanguage: 'ar' }).source).toBe('menu_choice');
  });

  it('names codes for the model and never translates identifiers', () => {
    expect(languageName('ml')).toBe('Malayalam');
    expect(languageName('ar')).toBe('Arabic');
    expect(languageName('xx')).toBe('xx');
  });
});

describe('decideReplyLanguage (the shared policy)', () => {
  it('follows the latest message even when the menu language is English (the defect: Malayalam customers got English)', () => {
    const d = decideReplyLanguage({ latestText: 'ഈ കാറിന് ആക്സസറികൾ ഉണ്ടോ?', menuLanguage: 'en' });
    expect(d).toMatchObject({ code: 'ml', name: 'Malayalam', source: 'latest_message' });
    expect(d.instruction).toContain('REPLY LANGUAGE: Malayalam');
    expect(d.instruction).toContain('if they switch language, switch with them');
    expect(d.instruction).not.toContain('regardless');
  });

  it('switches with the customer inside one conversation', () => {
    expect(decideReplyLanguage({ latestText: 'Hello, do you open on Friday?', menuLanguage: 'ar' }).code).toBe('en');
    expect(decideReplyLanguage({ latestText: 'وكم السعر؟', menuLanguage: 'ar' }).code).toBe('ar');
    expect(decideReplyLanguage({ latestText: '价格是多少？', menuLanguage: 'ar' }).code).toBe('zh');
  });

  it('a message with no language of its own uses the menu choice; with no menu choice the model follows the latest message', () => {
    expect(decideReplyLanguage({ latestText: '2', menuLanguage: 'ar' })).toMatchObject({ code: 'ar', source: 'menu_choice' });
    expect(decideReplyLanguage({ latestText: '👍' })).toMatchObject({ code: null, source: 'unknown' });
    expect(decideReplyLanguage({ latestText: 'ok', menuLanguage: 'ar' })).toMatchObject({ code: 'ar', source: 'menu_choice' }); // too short to be sure it is English
  });

  it('an explicit business override is the only thing that fixes the reply language, and it is named as a business setting', () => {
    const d = decideReplyLanguage({ latestText: 'ഈ കാറിന് ആക്സസറികൾ ഉണ്ടോ?', menuLanguage: 'en', accountOverride: 'ar' });
    expect(d).toMatchObject({ code: 'ar', name: 'Arabic', source: 'account_override' });
    expect(d.instruction).toContain('always replies in Arabic');
    expect(decideReplyLanguage({ latestText: 'hello there friend', accountOverride: '  ' }).source).toBe('latest_message');
  });

  it('every decision keeps identifiers intact', () => {
    for (const d of [decideReplyLanguage({ latestText: 'Bonjour, quel prix ?' }), decideReplyLanguage({ accountOverride: 'en' }), decideReplyLanguage({})]) {
      expect(d.instruction).toMatch(/product codes, part numbers, phone numbers and addresses exactly as written|codes or numbers exactly as written/);
    }
  });
});
