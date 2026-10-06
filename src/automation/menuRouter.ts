import type { Customer, CustomerLanguage } from '../memory/customerRepo';
import { getCustomerFlowData } from '../memory/customerRepo';
import type { TemplateVars } from '../templates/templateRepo';
import { normalizeNumerals } from '../whatsapp/jid';
import {
  MENU_IDS,
  detectLanguageFromText,
  isChangeLanguageKeyword,
  isGreeting,
  isHumanSupportRequest,
  isMenuKeyword,
} from './menu';

/**
 * Language-first guided menu — a port of the original Antigravity router's
 * state machine. This module decides WHICH templates to send and how the
 * customer's state changes; it never contains customer-facing text (that is
 * in the editable reply templates) and never sends anything itself.
 *
 * Returning null means "not a menu interaction": the pipeline hands the
 * message to the AI agent loop (free text) — that path is preserved.
 */

export const MENU_STATES = {
  AWAITING_LANGUAGE: 'AWAITING_LANGUAGE',
  AWAITING_LANGUAGE_SWITCH: 'AWAITING_LANGUAGE_SWITCH',
  MAIN_MENU: 'MAIN_MENU',
  SUBMENU_AUDIO: 'SUBMENU_AUDIO',
  SUBMENU_ACCESSORIES: 'SUBMENU_ACCESSORIES',
  SUBMENU_CARE: 'SUBMENU_CARE',
  SUBMENU_TINT: 'SUBMENU_TINT',
  SUBMENU_PRICES: 'SUBMENU_PRICES',
} as const;

export interface MenuOption {
  /** Template sent when this number is chosen (undefined for flows/handoff). */
  template?: string;
  /** State to move into (undefined = unchanged). */
  state?: string;
  /** Starts a multi-step flow instead of sending a single template. */
  flow?: 'appointment' | 'quotation';
  /** Pauses automation and hands the customer to staff. */
  handoff?: boolean;
}

/** Main menu: the option number → what happens. Text for the numbers lives in the main_menu template. */
export const MAIN_MENU_OPTIONS: Record<string, MenuOption> = {
  '1': { template: 'car_audio', state: MENU_STATES.SUBMENU_AUDIO },
  '2': { template: 'car_accessories', state: MENU_STATES.SUBMENU_ACCESSORIES },
  '3': { template: 'car_care', state: MENU_STATES.SUBMENU_CARE },
  '4': { template: 'tinting_protection', state: MENU_STATES.SUBMENU_TINT },
  '5': { template: 'prices_enquiries', state: MENU_STATES.SUBMENU_PRICES },
  '6': { template: 'location_hours' },
  '7': { flow: 'appointment' },
  '8': { handoff: true },
  '9': { template: 'about' },
};

/** Sub-menus: state → (menu template, option number → action). */
export const SUBMENUS: Record<string, { menuTemplate: string; options: Record<string, MenuOption> }> = {
  [MENU_STATES.SUBMENU_AUDIO]: {
    menuTemplate: 'car_audio',
    options: Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((n) => [String(n), { template: `car_audio_${n}` }])),
  },
  [MENU_STATES.SUBMENU_ACCESSORIES]: {
    menuTemplate: 'car_accessories',
    options: Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [String(n), { template: `car_accessories_${n}` }])),
  },
  [MENU_STATES.SUBMENU_CARE]: {
    menuTemplate: 'car_care',
    options: Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((n) => [String(n), { template: `car_care_${n}` }])),
  },
  [MENU_STATES.SUBMENU_TINT]: {
    menuTemplate: 'tinting_protection',
    options: Object.fromEntries([1, 2, 3, 4, 5].map((n) => [String(n), { template: `tinting_protection_${n}` }])),
  },
  [MENU_STATES.SUBMENU_PRICES]: {
    menuTemplate: 'prices_enquiries',
    options: {
      '1': { template: 'prices_products' },
      '2': { template: 'prices_services' },
      '3': { template: 'prices_offers_list' },
      '4': { flow: 'quotation' },
      '5': { template: 'prices_inquiry_cart' },
    },
  },
};

/** Multi-step flows: the answer stored at each step and the prompt for the next one. */
export const FLOWS = {
  appointment: {
    statePrefix: 'APPOINTMENT_STEP_',
    intro: 'appointment_intro',
    confirm: 'appointment_confirm',
    fields: ['name', 'make', 'model', 'year', 'service', 'date', 'time', 'notes'],
    stepTemplate: (step: number) => `appointment_step_${step}`,
  },
  quotation: {
    statePrefix: 'QUOTATION_STEP_',
    intro: 'quotation_intro',
    confirm: 'quotation_confirm',
    fields: ['name', 'vehicle', 'service', 'notes'],
    stepTemplate: (step: number) => `quotation_step_${step}`,
  },
} as const;

/**
 * Data-driven templates that need live records: when the resolver has nothing
 * to fill the placeholder with, the pipeline sends the fallback instead
 * (e.g. no customer-visible offers → the "no current offers" template).
 */
export const DATA_DRIVEN_FALLBACKS: Record<string, { placeholder: 'offers'; fallback: string }> = {
  prices_offers_list: { placeholder: 'offers', fallback: 'prices_offers' },
};

/** Templates the pipeline sends as a second bubble right after the first (mirrored by the dashboard preview). */
export const FOLLOW_UP_TEMPLATES: Record<string, string> = {
  invalid_option: 'main_menu',
  language_changed: 'main_menu',
  restart_confirmation: 'language_selection',
};

/** Legacy Meta Cloud API button/list IDs → the typed command they are equivalent to. */
const LEGACY_INTERACTIVE: Record<string, { text: string; fromMainMenu?: boolean }> = {
  [MENU_IDS.LANG_EN]: { text: 'english' },
  [MENU_IDS.LANG_AR]: { text: 'arabic' },
  [MENU_IDS.CATEGORY_AUDIO]: { text: '1', fromMainMenu: true },
  [MENU_IDS.CATEGORY_ACCESSORIES]: { text: '2', fromMainMenu: true },
  [MENU_IDS.CATEGORY_CARE]: { text: '3', fromMainMenu: true },
  [MENU_IDS.PRICES]: { text: '5', fromMainMenu: true },
  [MENU_IDS.LOCATION]: { text: '6', fromMainMenu: true },
  [MENU_IDS.MAIN_MENU]: { text: '0' },
  [MENU_IDS.CHANGE_LANGUAGE]: { text: 'language' },
};

export interface RouteInput {
  text?: string;
  interactiveId?: string;
  customer: Customer;
}

export interface RouteResult {
  kind: 'rule' | 'human_handoff';
  /** Template keys to send, in order — each becomes one WhatsApp bubble. */
  send: string[];
  vars?: TemplateVars;
  /** New language (null clears it). undefined = unchanged. */
  language?: CustomerLanguage | null;
  /** New menu state (null = none). undefined = unchanged. */
  state?: string | null;
  /** Replaces collected flow answers (null clears). undefined = unchanged. */
  flowData?: Record<string, string> | null;
  /** A completed multi-step flow to persist; the pipeline fills vars.reference from it. */
  request?: { kind: 'appointment' | 'quotation'; payload: Record<string, string> };
}

const DIGITS = /^\d{1,2}$/;

function withFollowUp(keys: string[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    out.push(key);
    const next = FOLLOW_UP_TEMPLATES[key];
    if (next && !keys.includes(next)) out.push(next);
  }
  return out;
}

function chooseLanguage(normalized: string, lower: string): CustomerLanguage | undefined {
  if (normalized === '1') return 'ar';
  if (normalized === '2') return 'en';
  return detectLanguageFromText(lower);
}

function applyOption(option: MenuOption, current: Customer): RouteResult {
  if (option.handoff) {
    return { kind: 'human_handoff', send: ['human_support'], state: MENU_STATES.MAIN_MENU, flowData: null };
  }
  if (option.flow) {
    const flow = FLOWS[option.flow];
    return { kind: 'rule', send: [flow.intro], state: `${flow.statePrefix}1`, flowData: {} };
  }
  return {
    kind: 'rule',
    send: [option.template as string],
    state: option.state ?? current.menu_state ?? MENU_STATES.MAIN_MENU,
  };
}

function invalidChoice(): RouteResult {
  return { kind: 'rule', send: withFollowUp(['invalid_option']), state: MENU_STATES.MAIN_MENU, flowData: null };
}

function continueFlow(kind: 'appointment' | 'quotation', step: number, answer: string, customer: Customer): RouteResult {
  const flow = FLOWS[kind];
  const data = { ...getCustomerFlowData(customer) };
  const field = flow.fields[step - 1];
  if (field) data[field] = answer;
  if (step >= flow.fields.length) {
    return {
      kind: 'rule',
      send: [flow.confirm],
      state: MENU_STATES.MAIN_MENU,
      flowData: null,
      request: { kind, payload: data },
    };
  }
  return { kind: 'rule', send: [flow.stepTemplate(step + 1)], state: `${flow.statePrefix}${step + 1}`, flowData: data };
}

/**
 * Routes one inbound message through the guided menu. Returns null when the
 * message is free text the AI should answer.
 */
export function routeMenu(input: RouteInput): RouteResult | null {
  const { customer } = input;
  let raw = (input.text ?? '').trim();
  let state = customer.menu_state ?? null;

  if (input.interactiveId) {
    const legacy = LEGACY_INTERACTIVE[input.interactiveId];
    raw = legacy?.text ?? '0';
    if (legacy?.fromMainMenu) state = MENU_STATES.MAIN_MENU;
  }
  if (!raw) return null;

  const normalized = normalizeNumerals(raw);
  const lower = normalized.toLowerCase().replace(/[.!؟?]+$/, '');

  // 1. No language yet: only a language choice moves forward; everything else (re)shows the welcome.
  if (!customer.language) {
    const chosen = chooseLanguage(normalized, lower);
    if (chosen) {
      return { kind: 'rule', send: ['main_menu'], language: chosen, state: MENU_STATES.MAIN_MENU, flowData: null };
    }
    const firstContact = state === null;
    return {
      kind: 'rule',
      send: [firstContact ? 'language_selection' : 'language_reprompt'],
      state: MENU_STATES.AWAITING_LANGUAGE,
    };
  }

  // 2. Language switch in progress.
  if (state === MENU_STATES.AWAITING_LANGUAGE_SWITCH) {
    const chosen = chooseLanguage(normalized, lower);
    if (chosen) {
      return { kind: 'rule', send: withFollowUp(['language_changed']), language: chosen, state: MENU_STATES.MAIN_MENU, flowData: null };
    }
    if (isMenuKeyword(raw)) return { kind: 'rule', send: ['main_menu'], state: MENU_STATES.MAIN_MENU, flowData: null };
    return { kind: 'rule', send: ['language_switch_prompt'] };
  }

  // 3. Universal commands (work in every state once a language is known).
  if (isChangeLanguageKeyword(raw)) {
    return { kind: 'rule', send: ['language_switch_prompt'], state: MENU_STATES.AWAITING_LANGUAGE_SWITCH, flowData: null };
  }
  if (isMenuKeyword(raw) || isGreeting(raw)) {
    return { kind: 'rule', send: ['main_menu'], state: MENU_STATES.MAIN_MENU, flowData: null };
  }
  if (isHumanSupportRequest(raw)) {
    return { kind: 'human_handoff', send: ['human_support'], state: MENU_STATES.MAIN_MENU, flowData: null };
  }

  // 4. Multi-step flows consume the whole message as the answer.
  for (const kind of ['appointment', 'quotation'] as const) {
    const prefix = FLOWS[kind].statePrefix;
    if (state?.startsWith(prefix)) {
      const step = Number(state.slice(prefix.length));
      if (Number.isFinite(step) && step >= 1) return continueFlow(kind, step, raw, customer);
    }
  }

  // 5. Sub-menus.
  const submenu = state ? SUBMENUS[state] : undefined;
  if (submenu) {
    if (!DIGITS.test(normalized)) return null; // free text → AI
    const option = submenu.options[String(Number(normalized))];
    return option ? applyOption(option, customer) : invalidChoice();
  }

  // 6. Main menu (also the default for unknown / stale states).
  if (!DIGITS.test(normalized)) return null; // free text → AI
  const option = MAIN_MENU_OPTIONS[String(Number(normalized))];
  return option ? applyOption(option, customer) : invalidChoice();
}
