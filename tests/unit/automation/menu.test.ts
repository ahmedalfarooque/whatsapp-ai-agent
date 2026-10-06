import { describe, it, expect } from 'vitest';
import {
  MENU_IDS,
  detectLanguageFromText,
  isMenuKeyword,
  isChangeLanguageKeyword,
  isGreeting,
  isHardRestart,
  isHumanSupportRequest,
  GOOGLE_MAPS_LINK,
} from '../../../src/automation/menu';
import { MENU_STATES, routeMenu, MAIN_MENU_OPTIONS, SUBMENUS, FOLLOW_UP_TEMPLATES, DATA_DRIVEN_FALLBACKS } from '../../../src/automation/menuRouter';
import { TEMPLATE_DEFAULTS } from '../../../src/templates/defaults';
import type { Customer } from '../../../src/memory/customerRepo';

function customer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: 1, wa_id: '966500000001', display_name: 'Ali', language: 'en', automation_paused: 0, paused_at: null,
    pause_reason: null, last_menu_options: null, menu_state: MENU_STATES.MAIN_MENU, flow_data: null, reply_jid: null,
    created_at: '', updated_at: '', ...overrides,
  };
}

describe('keyword helpers', () => {
  it('detects a language typed as free text, in either script', () => {
    expect(detectLanguageFromText('english')).toBe('en');
    expect(detectLanguageFromText('English')).toBe('en');
    expect(detectLanguageFromText('العربية')).toBe('ar');
    expect(detectLanguageFromText('عربي')).toBe('ar');
    expect(detectLanguageFromText('hello there')).toBeUndefined();
    expect(detectLanguageFromText(undefined)).toBeUndefined();
  });

  it('menu keywords are universal (both languages, "0", "back") and never fire mid-sentence', () => {
    expect(isMenuKeyword('menu')).toBe(true);
    expect(isMenuKeyword('Menu')).toBe(true);
    expect(isMenuKeyword('القائمة')).toBe(true);
    expect(isMenuKeyword('0')).toBe(true);
    expect(isMenuKeyword('٠')).toBe(true);
    expect(isMenuKeyword('back')).toBe(true);
    expect(isMenuKeyword('رجوع')).toBe(true);
    expect(isMenuKeyword('can you show me the menu please')).toBe(false);
  });

  it('recognises change-language, greeting, hard-restart and human keywords', () => {
    expect(isChangeLanguageKeyword('language')).toBe(true);
    expect(isChangeLanguageKeyword('change language')).toBe(true);
    expect(isChangeLanguageKeyword('اللغة')).toBe(true);
    expect(isGreeting('Hi')).toBe(true);
    expect(isGreeting('مرحبا')).toBe(true);
    expect(isGreeting('السلام عليكم')).toBe(true);
    expect(isGreeting('how much is PPF')).toBe(false);
    expect(isHardRestart('00')).toBe(true);
    expect(isHardRestart('0')).toBe(false);
    expect(isHumanSupportRequest('agent')).toBe(true);
    expect(isHumanSupportRequest('موظف')).toBe(true);
    expect(isHumanSupportRequest('my agent said hi')).toBe(false);
  });

  it('keeps the legacy Cloud API button IDs and the confirmed Google Maps link', () => {
    expect(MENU_IDS.LANG_EN).toBe('lang_en');
    expect(GOOGLE_MAPS_LINK).toBe('https://maps.app.goo.gl/8sxNK9wMNsTucvCh7');
  });
});

describe('menu router — language gate', () => {
  it('first contact shows the bilingual welcome/language selection and waits', () => {
    const r = routeMenu({ text: 'Hello', customer: customer({ language: null, menu_state: null }) });
    expect(r).toMatchObject({ send: ['language_selection'], state: MENU_STATES.AWAITING_LANGUAGE });
    expect(r?.language).toBeUndefined();
  });

  it('re-prompts (shorter text) while the language is still pending', () => {
    const r = routeMenu({ text: 'anything', customer: customer({ language: null, menu_state: MENU_STATES.AWAITING_LANGUAGE }) });
    expect(r?.send).toEqual(['language_reprompt']);
  });

  it('1 / ١ / "arabic" selects Arabic; 2 / "english" selects English — then the main menu, nothing else', () => {
    expect(routeMenu({ text: '1', customer: customer({ language: null }) })).toMatchObject({ language: 'ar', send: ['main_menu'], state: MENU_STATES.MAIN_MENU });
    expect(routeMenu({ text: '١', customer: customer({ language: null }) })).toMatchObject({ language: 'ar' });
    expect(routeMenu({ text: 'arabic', customer: customer({ language: null }) })).toMatchObject({ language: 'ar' });
    expect(routeMenu({ text: '٢', customer: customer({ language: null }) })).toMatchObject({ language: 'en', send: ['main_menu'] });
    expect(routeMenu({ text: 'English', customer: customer({ language: null }) })).toMatchObject({ language: 'en' });
  });
});

describe('menu router — main menu', () => {
  it('maps every option number exactly like the original Antigravity router', () => {
    const at = (t: string) => routeMenu({ text: t, customer: customer() });
    expect(at('1')).toMatchObject({ send: ['car_audio'], state: MENU_STATES.SUBMENU_AUDIO });
    expect(at('2')).toMatchObject({ send: ['car_accessories'], state: MENU_STATES.SUBMENU_ACCESSORIES });
    expect(at('3')).toMatchObject({ send: ['car_care'], state: MENU_STATES.SUBMENU_CARE });
    expect(at('4')).toMatchObject({ send: ['tinting_protection'], state: MENU_STATES.SUBMENU_TINT });
    expect(at('5')).toMatchObject({ send: ['prices_enquiries'], state: MENU_STATES.SUBMENU_PRICES });
    expect(at('6')).toMatchObject({ send: ['location_hours'], state: MENU_STATES.MAIN_MENU });
    expect(at('7')).toMatchObject({ send: ['appointment_intro'], state: 'APPOINTMENT_STEP_1', flowData: {} });
    expect(at('8')).toMatchObject({ kind: 'human_handoff', send: ['human_support'] });
    expect(at('9')).toMatchObject({ send: ['about'], state: MENU_STATES.MAIN_MENU });
    expect(at('٣')).toMatchObject({ send: ['car_care'] });
  });

  it('an unknown number sends ONE invalid-choice bubble followed by the main menu, not two menus', () => {
    const r = routeMenu({ text: '12', customer: customer() });
    expect(r?.send).toEqual(['invalid_option', 'main_menu']);
    expect(FOLLOW_UP_TEMPLATES.invalid_option).toBe('main_menu');
  });

  it('free text is not a menu interaction (goes to the AI), but greetings and "menu"/"0" reopen the menu', () => {
    expect(routeMenu({ text: 'Do you have Pioneer speakers?', customer: customer() })).toBeNull();
    expect(routeMenu({ text: 'مرحبا', customer: customer({ language: 'ar' }) })).toMatchObject({ send: ['main_menu'] });
    expect(routeMenu({ text: '0', customer: customer({ menu_state: MENU_STATES.SUBMENU_CARE }) })).toMatchObject({ send: ['main_menu'], state: MENU_STATES.MAIN_MENU });
    expect(routeMenu({ text: 'menu', customer: customer({ menu_state: 'APPOINTMENT_STEP_3' }) })).toMatchObject({ send: ['main_menu'], flowData: null });
  });

  it('every option template referenced by the tree ships as a default template', () => {
    const keys = new Set(TEMPLATE_DEFAULTS.map((t) => t.key));
    for (const o of Object.values(MAIN_MENU_OPTIONS)) if (o.template) expect(keys.has(o.template)).toBe(true);
    for (const sub of Object.values(SUBMENUS)) {
      expect(keys.has(sub.menuTemplate)).toBe(true);
      for (const o of Object.values(sub.options)) if (o.template) expect(keys.has(o.template)).toBe(true);
    }
  });
});

describe('menu router — submenus, flows, universal commands', () => {
  it('a submenu number sends that detail text and stays in the submenu; 0 returns; out-of-range is invalid', () => {
    const inAudio = customer({ menu_state: MENU_STATES.SUBMENU_AUDIO });
    expect(routeMenu({ text: '3', customer: inAudio })).toMatchObject({ send: ['car_audio_3'], state: MENU_STATES.SUBMENU_AUDIO });
    expect(routeMenu({ text: '7', customer: inAudio })).toMatchObject({ send: ['car_audio_7'] });
    expect(routeMenu({ text: '9', customer: inAudio })?.send).toEqual(['invalid_option', 'main_menu']);
    expect(routeMenu({ text: 'which subwoofer is best?', customer: inAudio })).toBeNull();
    expect(routeMenu({ text: '5', customer: customer({ menu_state: MENU_STATES.SUBMENU_TINT }) })).toMatchObject({ send: ['tinting_protection_5'] });
  });

  it('prices submenu: 1-3 & 5 are info templates, 4 starts the quotation flow', () => {
    const inPrices = customer({ menu_state: MENU_STATES.SUBMENU_PRICES });
    expect(routeMenu({ text: '1', customer: inPrices })).toMatchObject({ send: ['prices_products'] });
    expect(routeMenu({ text: '3', customer: inPrices })).toMatchObject({ send: ['prices_offers_list'] });
    expect(DATA_DRIVEN_FALLBACKS.prices_offers_list).toEqual({ placeholder: 'offers', fallback: 'prices_offers' });
    expect(routeMenu({ text: '4', customer: inPrices })).toMatchObject({ send: ['quotation_intro'], state: 'QUOTATION_STEP_1', flowData: {} });
    expect(routeMenu({ text: '5', customer: inPrices })).toMatchObject({ send: ['prices_inquiry_cart'] });
  });

  it('the appointment flow collects eight answers in order and completes with a request', () => {
    let c = customer({ menu_state: 'APPOINTMENT_STEP_1', flow_data: '{}' });
    const answers = ['Ali', 'Toyota', 'Camry', '2024', 'PPF', 'Tuesday', '10 AM', 'no'];
    for (let step = 1; step <= 7; step += 1) {
      const r = routeMenu({ text: answers[step - 1]!, customer: c })!;
      expect(r.send).toEqual([`appointment_step_${step + 1}`]);
      expect(r.state).toBe(`APPOINTMENT_STEP_${step + 1}`);
      c = customer({ menu_state: r.state as string, flow_data: JSON.stringify(r.flowData) });
    }
    const done = routeMenu({ text: answers[7]!, customer: c })!;
    expect(done.send).toEqual(['appointment_confirm']);
    expect(done.state).toBe(MENU_STATES.MAIN_MENU);
    expect(done.request).toEqual({ kind: 'appointment', payload: { name: 'Ali', make: 'Toyota', model: 'Camry', year: '2024', service: 'PPF', date: 'Tuesday', time: '10 AM', notes: 'no' } });
  });

  it('the quotation flow completes after four answers', () => {
    let c = customer({ menu_state: 'QUOTATION_STEP_1', flow_data: '{}' });
    for (const [i, a] of ['Sara', 'Lexus LX 2023', 'Window tint', 'none'].entries()) {
      const r = routeMenu({ text: a, customer: c })!;
      if (i < 3) { expect(r.send).toEqual([`quotation_step_${i + 2}`]); c = customer({ menu_state: r.state as string, flow_data: JSON.stringify(r.flowData) }); }
      else expect(r).toMatchObject({ send: ['quotation_confirm'], request: { kind: 'quotation', payload: { name: 'Sara', vehicle: 'Lexus LX 2023', service: 'Window tint', notes: 'none' } } });
    }
  });

  it('"language" asks which language, then 1/2 confirms and shows the main menu in the new language', () => {
    const r1 = routeMenu({ text: 'language', customer: customer() })!;
    expect(r1).toMatchObject({ send: ['language_switch_prompt'], state: MENU_STATES.AWAITING_LANGUAGE_SWITCH });
    const r2 = routeMenu({ text: '1', customer: customer({ menu_state: MENU_STATES.AWAITING_LANGUAGE_SWITCH }) })!;
    expect(r2).toMatchObject({ language: 'ar', send: ['language_changed', 'main_menu'], state: MENU_STATES.MAIN_MENU });
    expect(routeMenu({ text: 'blah', customer: customer({ menu_state: MENU_STATES.AWAITING_LANGUAGE_SWITCH }) })?.send).toEqual(['language_switch_prompt']);
  });

  it('human keywords hand off from any state', () => {
    expect(routeMenu({ text: 'موظف', customer: customer({ menu_state: MENU_STATES.SUBMENU_CARE }) })).toMatchObject({ kind: 'human_handoff', send: ['human_support'] });
  });

  it('legacy Cloud API button IDs still route', () => {
    expect(routeMenu({ interactiveId: MENU_IDS.LANG_EN, customer: customer({ language: null }) })).toMatchObject({ language: 'en', send: ['main_menu'] });
    expect(routeMenu({ interactiveId: MENU_IDS.CATEGORY_AUDIO, customer: customer({ menu_state: MENU_STATES.SUBMENU_PRICES }) })).toMatchObject({ send: ['car_audio'] });
    expect(routeMenu({ interactiveId: MENU_IDS.MAIN_MENU, customer: customer() })).toMatchObject({ send: ['main_menu'] });
    expect(routeMenu({ interactiveId: 'some_unknown_id', customer: customer() })).toMatchObject({ send: ['main_menu'] });
  });
});
