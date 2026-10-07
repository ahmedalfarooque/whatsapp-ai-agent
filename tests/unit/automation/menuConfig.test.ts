import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../../../src/memory/db';
import { createAccount } from '../../../src/accounts/accountRepo';
import { runWithAccount } from '../../../src/accounts/accountContext';
import {
  DEFAULT_GENERIC_MENU, MenuValidationError, compileMenu, getMenuConfig, getMenuTables, renderMainMenuText, renderSubmenuText, resetMenuConfig, saveMenuConfig, templateKeyFor, validateMenuConfig,
  type MenuConfig,
} from '../../../src/automation/menuConfig';
import { routeMenu, MAIN_MENU_OPTIONS, FLOWS } from '../../../src/automation/menuRouter';
import { getTemplate, listTemplates, resolveTemplate } from '../../../src/templates/templateRepo';
import { getOrCreateCustomer, type Customer } from '../../../src/memory/customerRepo';

let shop: number;
let spa: number;

const BRANDS_MENU: MenuConfig = {
  version: 1,
  items: [
    { id: 'products', kind: 'submenu', labelEn: 'Products', labelAr: 'المنتجات', children: [
      { id: 'paint', kind: 'info', labelEn: 'Interior paint', labelAr: 'دهان داخلي' },
      { id: 'tools', kind: 'info', labelEn: 'Brushes & tools', labelAr: 'أدوات' },
      { id: 'quote', kind: 'quotation', labelEn: 'Ask for a price', labelAr: 'اسأل عن السعر' },
    ] },
    { id: 'offers', kind: 'offers', labelEn: 'Offers', labelAr: 'العروض' },
    { id: 'visit', kind: 'location', labelEn: 'Find us', labelAr: 'موقعنا' },
    { id: 'staff', kind: 'handoff', labelEn: 'Talk to us', labelAr: 'تحدث معنا' },
  ],
};

beforeAll(() => {
  getDb();
  shop = createAccount({ name: 'Colour House', businessCategory: 'Paint store' }).id;
  spa = createAccount({ name: 'Noor Spa', businessCategory: 'Beauty salon' }).id;
});

function customer(accountId: number, state: string | null): Customer {
  const c = runWithAccount(accountId, () => getOrCreateCustomer(`9665${accountId}0000${state ? state.length : 0}`, 'Test'));
  return { ...c, language: 'en', menu_state: state };
}
const route = (accountId: number, text: string, state: string | null = 'MAIN_MENU') => runWithAccount(accountId, () => routeMenu({ text, customer: customer(accountId, state) }));

describe('menu configuration', () => {
  it('validates structure: ids, labels, counts, nesting', () => {
    expect(validateMenuConfig(BRANDS_MENU).items).toHaveLength(4);
    const bad = (items: unknown) => () => validateMenuConfig({ version: 1, items });
    expect(bad([])).toThrow(MenuValidationError);
    expect(bad('x')).toThrow(MenuValidationError);
    expect(bad([{ id: 'Bad Id', kind: 'info', labelEn: 'a', labelAr: 'ب' }])).toThrow(/letters\/digits/);
    expect(bad([{ id: 'a', kind: 'info', labelEn: 'a', labelAr: 'ب' }, { id: 'a', kind: 'info', labelEn: 'b', labelAr: 'ج' }])).toThrow(/used twice/);
    expect(bad([{ id: 'a', kind: 'weird', labelEn: 'a', labelAr: 'ب' }])).toThrow(/Unknown menu item kind/);
    expect(bad([{ id: 'a', kind: 'info', labelEn: '', labelAr: 'ب' }])).toThrow(/English label/);
    expect(bad([{ id: 'a', kind: 'submenu', labelEn: 'a', labelAr: 'ب', children: [] }])).toThrow(/at least one entry/);
    expect(bad([{ id: 'a', kind: 'submenu', labelEn: 'a', labelAr: 'ب', children: [{ id: 'b', kind: 'submenu', labelEn: 'b', labelAr: 'ج', children: [{ id: 'c', kind: 'info', labelEn: 'c', labelAr: 'د' }] }] }])).toThrow(/another sub-menu/);
    expect(bad([{ id: 'a', kind: 'info', labelEn: 'a', labelAr: 'ب', children: [{ id: 'b', kind: 'info', labelEn: 'b', labelAr: 'ج' }] }])).toThrow(/Only sub-menus/);
    expect(bad(Array.from({ length: 10 }, (_, i) => ({ id: `i${i}`, kind: 'info', labelEn: 'x', labelAr: 'ص' })))).toThrow(/at most 9/);
    expect(bad([{ id: 'a', kind: 'handoff', labelEn: 'a', labelAr: 'ب' }, { id: 'b', kind: 'handoff', labelEn: 'b', labelAr: 'ج' }])).toThrow(/only have one/);
  });

  it('compiles to the numbered tables the router uses', () => {
    const t = compileMenu(BRANDS_MENU);
    expect(t.builtIn).toBe(false);
    expect(t.main['1']).toEqual({ template: 'menu_products', state: 'SUBMENU_PRODUCTS' });
    expect(t.main['2']).toEqual({ template: 'prices_offers_list' });
    expect(t.main['3']).toEqual({ template: 'location_hours' });
    expect(t.main['4']).toEqual({ handoff: true });
    expect(t.submenus.SUBMENU_PRODUCTS).toEqual({
      menuTemplate: 'menu_products',
      options: { '1': { template: 'menu_products_paint' }, '2': { template: 'menu_products_tools' }, '3': { flow: 'quotation' } },
    });
    expect(templateKeyFor(BRANDS_MENU.items[0]!)).toBe('menu_products');
    expect(templateKeyFor(BRANDS_MENU.items[0]!.children![0]!, 'products')).toBe('menu_products_paint');
    expect(templateKeyFor(BRANDS_MENU.items[3]!)).toBeNull();
  });

  it('renders the numbered texts customers see', () => {
    expect(renderMainMenuText(BRANDS_MENU, 'en')).toBe('Welcome to {business}\n\nHow can we help you today?\n\n1️⃣ Products\n2️⃣ Offers\n3️⃣ Find us\n4️⃣ Talk to us\n\nPlease reply with the option number.');
    expect(renderMainMenuText(BRANDS_MENU, 'ar')).toContain('1️⃣ المنتجات');
    expect(renderSubmenuText(BRANDS_MENU.items[0]!, 'en')).toBe('Products\n\n1️⃣ Interior paint\n2️⃣ Brushes & tools\n3️⃣ Ask for a price\n\n0️⃣ Main Menu');
  });

  it('stores per business; the original business always keeps its built-in structure', () => {
    expect(getMenuConfig(shop)).toMatchObject({ source: 'default', config: DEFAULT_GENERIC_MENU });
    expect(() => saveMenuConfig(1, BRANDS_MENU, 'manual')).toThrow(/built-in/);
    saveMenuConfig(shop, BRANDS_MENU, 'manual');
    expect(getMenuConfig(shop)).toMatchObject({ source: 'manual' });
    expect(getMenuConfig(shop).config.items[0]!.id).toBe('products');
    expect(getMenuConfig(spa).source).toBe('default'); // the other business is unaffected
    expect(getMenuTables(1).builtIn).toBe(true);
    expect(getMenuTables(1).main).toBe(MAIN_MENU_OPTIONS);
    expect(getMenuTables(1).flows).toBe(FLOWS);
    expect(resetMenuConfig(spa).source).toBe('default');
  });

  it('a corrupt stored menu never takes the business down — it falls back to the default', () => {
    getDb().prepare("UPDATE account_menus SET config_json = '{not json' WHERE whatsapp_account_id = ?").run(shop);
    expect(getMenuConfig(shop)).toMatchObject({ source: 'default' });
    saveMenuConfig(shop, BRANDS_MENU, 'manual');
  });
});

describe('the router follows each business\'s own menu', () => {
  it('the original business keeps its car menu', () => {
    const r = runWithAccount(1, () => routeMenu({ text: '1', customer: customer(1, 'MAIN_MENU') }));
    expect(r?.send).toEqual(['car_audio']);
    expect(r?.state).toBe('SUBMENU_AUDIO');
  });

  it('another business routes by its own numbers, sub-menus and flows', () => {
    expect(route(shop, '1')).toMatchObject({ send: ['menu_products'], state: 'SUBMENU_PRODUCTS' });
    expect(route(shop, '2', 'SUBMENU_PRODUCTS')).toMatchObject({ send: ['menu_products_tools'] });
    const quote = route(shop, '3', 'SUBMENU_PRODUCTS');
    expect(quote).toMatchObject({ send: ['quotation_intro'], state: 'QUOTATION_STEP_1' });
    expect(route(shop, '2')).toMatchObject({ send: ['prices_offers_list'] });
    expect(route(shop, '3')).toMatchObject({ send: ['location_hours'] });
    expect(route(shop, '4')).toMatchObject({ kind: 'human_handoff', send: ['human_support'] });
    // an option that does not exist in THIS menu is invalid here even though it exists in the original business's
    expect(route(shop, '5')).toMatchObject({ send: ['invalid_option', 'main_menu'] });
    expect(route(shop, '9')).toMatchObject({ send: ['invalid_option', 'main_menu'] });
    // free text still goes to the AI
    expect(route(shop, 'do you have emulsion paint?')).toBeNull();
  });

  it('flows collect the generic fields (no car make/model/year) and finish into a request', () => {
    const step1 = route(shop, 'Layla', 'QUOTATION_STEP_1');
    expect(step1).toMatchObject({ send: ['quotation_step_2'], state: 'QUOTATION_STEP_2', flowData: { name: 'Layla' } });
    const c2 = { ...customer(shop, 'QUOTATION_STEP_2'), flow_data: JSON.stringify({ name: 'Layla' }) } as Customer;
    const step2 = runWithAccount(shop, () => routeMenu({ text: 'Interior paint 18L', customer: c2 }));
    expect(step2).toMatchObject({ send: ['quotation_step_3'], flowData: { name: 'Layla', service: 'Interior paint 18L' } });
    const c3 = { ...customer(shop, 'QUOTATION_STEP_3'), flow_data: JSON.stringify({ name: 'Layla', service: 'Interior paint 18L' }) } as Customer;
    const done = runWithAccount(shop, () => routeMenu({ text: 'Need it by Friday', customer: c3 }));
    expect(done).toMatchObject({ send: ['quotation_confirm'], state: 'MAIN_MENU', request: { kind: 'quotation', payload: { name: 'Layla', service: 'Interior paint 18L', details: 'Need it by Friday' } } });
    // the appointment flow has five generic steps
    const appt = route(spa, '7');
    expect(appt).toMatchObject({ send: ['appointment_intro'], state: 'APPOINTMENT_STEP_1' });
    const last = { ...customer(spa, 'APPOINTMENT_STEP_5'), flow_data: JSON.stringify({ name: 'A', service: 'B', date: 'C', time: 'D' }) } as Customer;
    expect(runWithAccount(spa, () => routeMenu({ text: 'none', customer: last }))).toMatchObject({ send: ['appointment_confirm'], request: { kind: 'appointment', payload: { name: 'A', service: 'B', date: 'C', time: 'D', notes: 'none' } } });
  });
});

describe('a new business starts from neutral wording — never another company\'s', () => {
  const FORBIDDEN = /Rowad|رواد|Jeddah|جدة|PPF|Car Audio|صوتيات|tint|nano|ceramic|8sxNK9wMNsTucvCh7/i;

  it('every template of a fresh business is free of the original business\'s name, city, services and map link', () => {
    for (const id of [shop, spa]) {
      const templates = runWithAccount(id, () => listTemplates());
      expect(templates.length).toBeGreaterThan(30);
      for (const t of templates) {
        expect(`${t.liveEn}\n${t.liveAr}\n${t.defaultEn}\n${t.defaultAr}`, `${id}:${t.key}`).not.toMatch(FORBIDDEN);
      }
    }
    // …while the original business keeps its own
    expect(runWithAccount(1, () => getTemplate('main_menu'))!.liveEn).toContain('Rowad Alfa');
  });

  it('the neutral set has every key the router and the request workflow need, and menu pages follow the menu', () => {
    const keys = runWithAccount(shop, () => listTemplates()).map((t) => t.key);
    for (const needed of ['language_selection', 'language_reprompt', 'main_menu', 'invalid_option', 'language_switch_prompt', 'language_changed', 'restart_confirmation', 'human_support',
      'location_hours', 'prices_offers_list', 'prices_offers', 'appointment_intro', 'appointment_step_5', 'appointment_confirm', 'quotation_intro', 'quotation_step_3', 'quotation_confirm',
      'request_confirmed', 'request_rejected', 'request_cancelled', 'request_status_update', 'staff_new_request', 'staff_status_changed', 'unsupported_message', 'fallback_error', 'ai_disabled',
      'menu_products', 'menu_products_paint', 'menu_products_tools']) expect(keys, needed).toContain(needed);
    expect(keys).not.toContain('car_audio');
    expect(keys).not.toContain('about'); // the original business's key, not part of a generated menu
  });

  it('resolves with the business\'s own name, falling back cleanly when details are missing', () => {
    const welcome = runWithAccount(shop, () => resolveTemplate('language_selection', 'en'));
    expect(welcome).toContain('Welcome to Colour House');
    const hours = runWithAccount(shop, () => resolveTemplate('location_hours', 'en'));
    expect(hours).toContain('Colour House');
    expect(hours).not.toMatch(/Google Maps:/); // no map link entered → the line is dropped, not filled with another business's
    expect(hours).not.toMatch(/Opening Hours/);
    const about = runWithAccount(spa, () => resolveTemplate('menu_about', 'en'));
    expect(about).toContain('Noor Spa');
  });

  it('a menu change adds/removes the matching pages and leaves edited pages alone', () => {
    const before = runWithAccount(shop, () => listTemplates()).map((t) => t.key);
    expect(before).toContain('menu_products_paint');
    saveMenuConfig(shop, { version: 1, items: [{ id: 'catalog', kind: 'info', labelEn: 'Catalogue', labelAr: 'الكتالوج' }, { id: 'staff', kind: 'handoff', labelEn: 'Talk to us', labelAr: 'تحدث معنا' }] }, 'manual');
    const after = runWithAccount(shop, () => listTemplates()).map((t) => t.key);
    expect(after).toContain('menu_catalog');
    expect(after).not.toContain('menu_products_paint'); // untouched page of a removed entry is cleaned up
    saveMenuConfig(shop, BRANDS_MENU, 'manual');
  });
});
