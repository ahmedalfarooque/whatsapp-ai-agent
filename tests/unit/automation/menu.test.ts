import { describe, it, expect } from 'vitest';
import {
  MENU_IDS,
  detectLanguageFromText,
  isMenuKeyword,
  isChangeLanguageKeyword,
  buildLanguageSelectionMessage,
  buildWelcomeText,
  buildMainMenuMessage,
  buildCategoryMessage,
  buildLocationMessage,
  GOOGLE_MAPS_LINK,
} from '../../../src/automation/menu';

describe('detectLanguageFromText', () => {
  it('detects English by keyword', () => {
    expect(detectLanguageFromText('english')).toBe('en');
    expect(detectLanguageFromText('English')).toBe('en');
  });

  it('detects Arabic by keyword', () => {
    expect(detectLanguageFromText('العربية')).toBe('ar');
    expect(detectLanguageFromText('عربي')).toBe('ar');
  });

  it('returns undefined for unrelated text', () => {
    expect(detectLanguageFromText('hello there')).toBeUndefined();
    expect(detectLanguageFromText(undefined)).toBeUndefined();
  });
});

describe('isMenuKeyword / isChangeLanguageKeyword', () => {
  it('matches menu keywords per language, case-insensitively', () => {
    expect(isMenuKeyword('menu', 'en')).toBe(true);
    expect(isMenuKeyword('Menu', 'en')).toBe(true);
    expect(isMenuKeyword('القائمة', 'ar')).toBe(true);
    expect(isMenuKeyword('menu', 'ar')).toBe(false);
  });

  it('does not fire on a keyword used naturally mid-sentence', () => {
    expect(isMenuKeyword('can you show me the menu please', 'en')).toBe(false);
  });

  it('matches change-language keywords per language', () => {
    expect(isChangeLanguageKeyword('language', 'en')).toBe(true);
    expect(isChangeLanguageKeyword('change language', 'en')).toBe(true);
    expect(isChangeLanguageKeyword('اللغة', 'ar')).toBe(true);
  });
});

describe('buildLanguageSelectionMessage', () => {
  it('offers both English and Arabic buttons with stable IDs', () => {
    const message = buildLanguageSelectionMessage();
    expect(message.kind).toBe('buttons');
    if (message.kind === 'buttons') {
      expect(message.buttons).toEqual([
        { id: MENU_IDS.LANG_EN, title: 'English' },
        { id: MENU_IDS.LANG_AR, title: 'العربية' },
      ]);
    }
  });
});

describe('buildWelcomeText', () => {
  it('includes the customer name and the exact Google Maps link when a name is known', () => {
    const text = buildWelcomeText('en', 'Alice');
    expect(text).toContain('Alice');
    expect(text).toContain(GOOGLE_MAPS_LINK);
  });

  it('falls back to a generic greeting without a name', () => {
    const text = buildWelcomeText('en', undefined);
    expect(text).toContain('Hello');
    expect(text).toContain(GOOGLE_MAPS_LINK);
  });

  it('renders Arabic welcome text for the Arabic language', () => {
    const text = buildWelcomeText('ar', 'سارة');
    expect(text).toContain('سارة');
    expect(text).toContain(GOOGLE_MAPS_LINK);
  });
});

describe('buildMainMenuMessage', () => {
  it('lists all five categories with stable IDs in English', () => {
    const message = buildMainMenuMessage('en');
    expect(message.kind).toBe('list');
    if (message.kind === 'list') {
      const ids = message.sections[0].rows.map((r) => r.id);
      expect(ids).toEqual([
        MENU_IDS.CATEGORY_AUDIO,
        MENU_IDS.CATEGORY_ACCESSORIES,
        MENU_IDS.CATEGORY_CARE,
        MENU_IDS.PRICES,
        MENU_IDS.LOCATION,
      ]);
    }
  });

  it('uses the same stable IDs in Arabic (only titles change)', () => {
    const en = buildMainMenuMessage('en');
    const ar = buildMainMenuMessage('ar');
    if (en.kind === 'list' && ar.kind === 'list') {
      expect(ar.sections[0].rows.map((r) => r.id)).toEqual(en.sections[0].rows.map((r) => r.id));
    }
  });
});

describe('buildCategoryMessage / buildLocationMessage', () => {
  it('always includes main-menu and change-language navigation buttons', () => {
    for (const msg of [
      buildCategoryMessage('en', 'audio'),
      buildCategoryMessage('en', 'accessories'),
      buildCategoryMessage('en', 'care'),
      buildCategoryMessage('en', 'prices'),
      buildLocationMessage('en'),
    ]) {
      expect(msg.kind).toBe('buttons');
      if (msg.kind === 'buttons') {
        const ids = msg.buttons.map((b) => b.id);
        expect(ids).toContain(MENU_IDS.MAIN_MENU);
        expect(ids).toContain(MENU_IDS.CHANGE_LANGUAGE);
      }
    }
  });

  it('location message includes the exact Google Maps link', () => {
    const msg = buildLocationMessage('en');
    if (msg.kind === 'buttons') {
      expect(msg.body).toContain(GOOGLE_MAPS_LINK);
    }
  });
});
