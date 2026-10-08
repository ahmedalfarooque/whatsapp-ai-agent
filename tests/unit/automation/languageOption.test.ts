import { describe, it, expect, beforeAll } from 'vitest';
import { getDb } from '../../../src/memory/db';
import { createAccount } from '../../../src/accounts/accountRepo';
import { runWithAccount } from '../../../src/accounts/accountContext';
import { getOrCreateCustomer, type Customer } from '../../../src/memory/customerRepo';
import { routeMenu } from '../../../src/automation/menuRouter';
import { resolveTemplate } from '../../../src/templates/templateRepo';
import { getMenuConfig, saveMenuConfig } from '../../../src/automation/menuConfig';
import { withLanguageOption, LANGUAGE_OPTION_EN, LANGUAGE_OPTION_AR } from '../../../src/templates/languageOption';

const count = (text: string, needle: string) => text.split(needle).length - 1;

describe('withLanguageOption — a permanent, never duplicated "Change language" line', () => {
  it('adds the line in the customer language, before a trailing "reply with the option number" instruction', () => {
    const en = withLanguageOption('Welcome\n\n1️⃣ A\n2️⃣ B\n\nPlease reply with the option number.', 'en');
    expect(en).toContain(LANGUAGE_OPTION_EN);
    expect(en.indexOf(LANGUAGE_OPTION_EN)).toBeLessThan(en.indexOf('Please reply with the option number.'));
    const ar = withLanguageOption('أهلاً\n\n1️⃣ أ\n\nأرسل رقم الخيار.', 'ar');
    expect(ar).toContain(LANGUAGE_OPTION_AR);
    expect(ar).not.toContain(LANGUAGE_OPTION_EN);
    expect(ar.endsWith('أرسل رقم الخيار.')).toBe(true);
  });

  it('appends it when the menu has no instruction line, and never twice', () => {
    const once = withLanguageOption('Welcome\n\n1️⃣ A', 'en');
    expect(once.endsWith(LANGUAGE_OPTION_EN)).toBe(true);
    expect(withLanguageOption(once, 'en')).toBe(once);
    expect(count(withLanguageOption(withLanguageOption(once, 'en'), 'en'), 'Change language')).toBe(1);
  });

  it('leaves a menu alone that already offers a language change in its own words', () => {
    const own = 'Menu\n\n1️⃣ A\n0️⃣ 🌐 Change language\n\nPlease reply with the option number.';
    expect(withLanguageOption(own, 'en')).toBe(own);
  });
});

describe('the Change language option on every account, existing and future', () => {
  let jotun: number;
  let future: number;

  beforeAll(() => {
    getDb();
    jotun = createAccount({ name: 'JOTUN Test' }).id;
    future = createAccount({ name: 'Future Business Added Later' }).id;
  });

  const customer = (accountId: number, language: 'en' | 'ar' | null, state: string | null, phone: string): Customer =>
    runWithAccount(accountId, () => ({ ...getOrCreateCustomer(phone, undefined), language, menu_state: state }) as Customer);

  it.each([
    ['the original business', () => 1],
    ['a second business', () => jotun],
    ['a business created later', () => future],
  ])('%s: the main menu shows the option in English and in Arabic, exactly once', (_name, id) => {
    runWithAccount(id(), () => {
      const en = resolveTemplate('main_menu', 'en');
      const ar = resolveTemplate('main_menu', 'ar');
      expect(count(en, 'Change language')).toBe(1);
      expect(en).toContain('0️⃣');
      expect(count(ar, 'تغيير اللغة')).toBe(1);
      expect(en).not.toContain('تغيير اللغة');
      expect(ar).not.toContain('Change language');
    });
  });

  it.each([
    ['the original business', () => 1],
    ['a second business', () => jotun],
    ['a business created later', () => future],
  ])('%s: sending 0 on the main menu opens the language choice, keeping everything else', (_name, id) => {
    runWithAccount(id(), () => {
      const c = customer(id(), 'en', 'MAIN_MENU', `96650${id()}00001`);
      const route = routeMenu({ text: '0', customer: c });
      expect(route).toMatchObject({ send: ['language_switch_prompt'], state: 'AWAITING_LANGUAGE_SWITCH' });
      expect(route?.language).toBeUndefined(); // the language itself only changes once the customer picks one
    });
  });

  it('choosing a language afterwards switches it in both directions and shows the menu in the new language', () => {
    runWithAccount(future, () => {
      const toAr = routeMenu({ text: '1', customer: customer(future, 'en', 'AWAITING_LANGUAGE_SWITCH', '966502000001') });
      expect(toAr).toMatchObject({ language: 'ar', state: 'MAIN_MENU' });
      expect(toAr?.send).toEqual(['language_changed', 'main_menu']);
      const toEn = routeMenu({ text: '2', customer: customer(future, 'ar', 'AWAITING_LANGUAGE_SWITCH', '966502000002') });
      expect(toEn).toMatchObject({ language: 'en', state: 'MAIN_MENU' });
      expect(routeMenu({ text: 'english', customer: customer(future, 'ar', 'AWAITING_LANGUAGE_SWITCH', '966502000003') })).toMatchObject({ language: 'en' });
    });
  });

  it('0 still means "back to the main menu" inside a sub-menu and during a flow, and is not a language option there', () => {
    runWithAccount(1, () => {
      expect(routeMenu({ text: '0', customer: customer(1, 'en', 'SUBMENU_AUDIO', '966503000001') })).toMatchObject({ send: ['main_menu'], state: 'MAIN_MENU' });
      expect(routeMenu({ text: '0', customer: customer(1, 'en', 'APPOINTMENT_STEP_2', '966503000002') })).toMatchObject({ send: ['main_menu'] });
    });
  });

  it('the typed words still work from anywhere ("language", "تغيير اللغة")', () => {
    runWithAccount(jotun, () => {
      for (const word of ['language', 'change language', 'تغيير اللغة']) {
        expect(routeMenu({ text: word, customer: customer(jotun, 'ar', 'SUBMENU_X', '966504000001') })).toMatchObject({ send: ['language_switch_prompt'] });
      }
    });
  });

  it('regenerating or editing the business menu never duplicates the option', () => {
    runWithAccount(future, () => {
      const stored = getMenuConfig(future);
      saveMenuConfig(future, stored.config, 'manual');
      saveMenuConfig(future, stored.config, 'manual');
      expect(count(resolveTemplate('main_menu', 'en'), 'Change language')).toBe(1);
      expect(count(resolveTemplate('main_menu', 'ar'), 'تغيير اللغة')).toBe(1);
    });
  });
});
